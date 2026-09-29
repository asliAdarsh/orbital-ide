//! Sidecar supervision: port reservation, process spawn, readiness handshake and teardown.
//!
//! The backend is a long-lived process whose stdout is the only readiness channel, so the host
//! keeps draining that stream for the whole lifetime of the process. A full pipe would block the
//! backend mid-request.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

use crate::error::AppError;

/// Name of the bundled executable, matching `bundle.externalBin` in `tauri.conf.json`.
const SIDECAR_NAME: &str = "orbital-backend";
/// Token the backend prints on stdout once uvicorn is serving traffic.
const READY_MARKER: &str = "ORBITAL_BACKEND_READY";
/// Prefix of the token field on that line. The sidecar mints the token and prints it, because this
/// host has no token to give it — see `orbital_backend.auth` for why the runtime refuses callers
/// that do not present it.
const TOKEN_FIELD: &str = "token=";
/// Emitted with the resolved [`BackendInfo`] when the backend reports readiness. The frontend must
/// re-read the base URL from this payload: a restart moves the backend to a different port.
pub const EVENT_READY: &str = "backend://ready";
/// Emitted when the supervised process leaves the process table.
pub const EVENT_EXITED: &str = "backend://exited";
/// Port used when the OS refuses to hand out an ephemeral one. Mirrors the backend default.
pub const FALLBACK_PORT: u16 = 8765;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// `Settings.env_prefix` + field name, read by the backend through pydantic-settings.
const ENV_PORT: &str = "ORBITAL_PORT";
/// List-valued setting: pydantic-settings parses complex fields as JSON, not as a bare path.
const ENV_ALLOWED_ROOTS: &str = "ORBITAL_ALLOWED_ROOTS";

/// Backend coordinates handed to the frontend.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub port: u16,
    pub base_url: String,
    pub managed: bool,
    pub pid: Option<u32>,
    pub status: String,
    /// The secret every request and socket has to present, exactly as the sidecar printed it.
    /// It never goes into a bundle: the webview reads it from here at startup, and a restart hands
    /// out the new one through the same command and the `backend://ready` event.
    pub token: Option<String>,
}

/// Payload of [`EVENT_EXITED`].
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub status: String,
}

/// Lifecycle of the supervised backend process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendStatus {
    Starting,
    Ready,
    Stopped,
    Failed,
}

impl BackendStatus {
    fn as_str(self) -> &'static str {
        match self {
            BackendStatus::Starting => "starting",
            BackendStatus::Ready => "ready",
            BackendStatus::Stopped => "stopped",
            BackendStatus::Failed => "failed",
        }
    }
}

/// Host-side view of the backend process, guarded by a mutex in Tauri managed state.
pub struct BackendState {
    port: u16,
    status: BackendStatus,
    /// Bumped on every spawn and every explicit stop. The stdout pump of a superseded process
    /// carries the generation it was started with and refuses to touch state that is no longer
    /// its own, so a restart cannot be clobbered by the dying process it replaced.
    generation: u64,
    /// OS process id of the supervised child, reported to the UI and used to kill its tree.
    child_id: Option<u32>,
    /// Resolved by the stdout pump once the readiness line arrives.
    ready_tx: Option<oneshot::Sender<u16>>,
    /// Handle kept so the process can be killed through the shell plugin rather than by pid.
    child: Option<CommandChild>,
    /// Resolved by the stdout pump from the same readiness line as the port. Cleared on stop, so
    /// nothing is handed out for a process that is not running.
    token: Option<String>,
}

impl BackendState {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            status: BackendStatus::Starting,
            generation: 0,
            child_id: None,
            ready_tx: None,
            child: None,
            token: None,
        }
    }

    pub fn info(&self) -> BackendInfo {
        BackendInfo {
            port: self.port,
            base_url: base_url(self.port),
            managed: self.child_id.is_some(),
            pid: self.child_id,
            status: self.status.as_str().to_string(),
            token: self.token.clone(),
        }
    }
}

/// Locks the backend state, recovering from poisoning: the process handle behind it must stay
/// killable even if some other thread panicked while holding the lock.
pub fn lock_state(state: &Mutex<BackendState>) -> MutexGuard<'_, BackendState> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Reserves a loopback port by binding and immediately releasing it.
pub fn pick_free_port() -> Result<u16, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Spawns the backend and drives it to readiness on the async runtime.
///
/// Returns immediately: the Tauri `setup` hook must not block the event loop for up to 30 seconds.
/// Progress reaches the UI through [`BackendState::info`] and the [`EVENT_READY`] /
/// [`EVENT_EXITED`] events, and through the returned error when called from `restart_backend`.
pub fn launch(app: AppHandle, state: Arc<Mutex<BackendState>>) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = start_process(&app, &state).await {
            log::error!("orbital backend did not start: {err}");
        }
    });
}

/// Kills the supervised process tree. Called on `RunEvent::Exit` and by `stop_backend`.
///
/// The generation bump retires the running pump, so an explicit stop is not reported back as an
/// unexpected `backend://exited`; the caller already knows the process is gone.
pub fn stop(state: &Mutex<BackendState>) {
    let (pid, child) = {
        let mut guard = lock_state(state);
        guard.generation += 1;
        guard.ready_tx = None;
        guard.status = BackendStatus::Stopped;
        guard.token = None;
        (guard.child_id.take(), guard.child.take())
    };
    if let Some(pid) = pid {
        kill_process_tree(pid);
    }
    if let Some(child) = child {
        let _ = child.kill();
    }
}

/// Kills the current process, moves to a fresh port and starts again.
pub async fn restart(app: &AppHandle, state: &Arc<Mutex<BackendState>>) -> Result<(), AppError> {
    stop(state);
    let port = pick_free_port()?;
    lock_state(state).port = port;
    start_process(app, state).await
}

/// Kills the sidecar held in managed state, if it was ever managed.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<Mutex<BackendState>>>() {
        stop(state.inner());
    }
}

async fn start_process(app: &AppHandle, state: &Arc<Mutex<BackendState>>) -> Result<(), AppError> {
    let port = lock_state(state).port;
    let (ready_tx, ready_rx) = oneshot::channel::<u16>();
    let generation = {
        let mut guard = lock_state(state);
        guard.generation += 1;
        guard.status = BackendStatus::Starting;
        guard.ready_tx = Some(ready_tx);
        guard.generation
    };

    let (events, child) = match spawn_command(app, port) {
        Ok(pair) => pair,
        Err(err) => {
            {
                let mut guard = lock_state(state);
                guard.status = BackendStatus::Failed;
                guard.ready_tx = None;
            }
            let _ = app.emit(
                EVENT_EXITED,
                BackendExit {
                    code: None,
                    signal: None,
                    status: BackendStatus::Failed.as_str().to_string(),
                },
            );
            return Err(err);
        }
    };
    {
        let mut guard = lock_state(state);
        guard.child_id = Some(child.pid());
        guard.child = Some(child);
    }

    let pump_app = app.clone();
    let pump_state = Arc::clone(state);
    tauri::async_runtime::spawn(async move { pump(pump_app, pump_state, generation, events).await });

    match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
        Ok(Ok(reported)) => {
            // Adopt the port the backend actually bound: it may differ if the requested one was
            // taken between the reservation and the listen call.
            let info = {
                let mut guard = lock_state(state);
                guard.port = reported;
                guard.status = BackendStatus::Ready;
                guard.ready_tx = None;
                guard.info()
            };
            log::info!("orbital backend ready at {}", info.base_url);
            let _ = app.emit(EVENT_READY, info);
            Ok(())
        }
        Ok(Err(_)) => Err(AppError::Backend(
            "the backend exited before reporting readiness".into(),
        )),
        Err(_) => {
            let child = lock_state(state).child.take();
            if let Some(child) = child {
                let _ = child.kill();
            }
            Err(AppError::BackendTimeout(READY_TIMEOUT.as_secs()))
        }
    }
}

fn spawn_command(
    app: &AppHandle,
    port: u16,
) -> Result<(Receiver<CommandEvent>, CommandChild), AppError> {
    let roots = allowed_roots_json(app_data_dir(app).as_deref());
    match dev_backend_dir() {
        Some(dir) => {
            let python = dev_python(&dir);
            log::info!(
                "spawning development backend: {} -m orbital_backend in {}",
                python.display(),
                dir.display()
            );
            app.shell()
                .command(python)
                .args(["-m", "orbital_backend"])
                .current_dir(&dir)
                .env(ENV_PORT, port.to_string())
                .env(ENV_ALLOWED_ROOTS, roots)
                .spawn()
                .map_err(|err| AppError::Backend(err.to_string()))
        }
        None => {
            log::info!("spawning bundled backend sidecar on port {port}");
            app.shell()
                .sidecar(SIDECAR_NAME)
                .map_err(|err| AppError::Backend(err.to_string()))?
                .env(ENV_PORT, port.to_string())
                .env(ENV_ALLOWED_ROOTS, roots)
                .spawn()
                .map_err(|err| AppError::Backend(err.to_string()))
        }
    }
}

/// Consumes the child's output stream until it terminates, resolving the readiness handshake.
///
/// `generation` identifies the process this pump was started for. Every mutation is conditional on
/// the state still belonging to that generation: after a restart the superseded pump must neither
/// clear the live child handle nor resolve the new generation's readiness channel.
async fn pump(
    app: AppHandle,
    state: Arc<Mutex<BackendState>>,
    generation: u64,
    mut events: Receiver<CommandEvent>,
) {
    let mut terminated = false;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                match parse_ready_port(&line) {
                    None => log::info!("[backend] {}", line.trim_end()),
                    Some(port) => {
                        // The readiness line carries the token, and this log reaches a terminal and
                        // whatever collects the host's stderr, so it is reported without it.
                        log::info!("{READY_MARKER} port={port} (token received)");
                        let token = parse_ready_token(&line);
                        let ready_tx = {
                            let mut guard = lock_state(&state);
                            if guard.generation == generation {
                                guard.token = token;
                                guard.ready_tx.take()
                            } else {
                                None
                            }
                        };
                        if let Some(ready_tx) = ready_tx {
                            let _ = ready_tx.send(port);
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                log::warn!("[backend] {}", String::from_utf8_lossy(&bytes).trim_end());
            }
            CommandEvent::Error(message) => log::error!("[backend] {message}"),
            CommandEvent::Terminated(payload) => {
                log::warn!(
                    "orbital backend exited (code {:?}, signal {:?})",
                    payload.code,
                    payload.signal
                );
                let reported = {
                    let mut guard = lock_state(&state);
                    if guard.generation == generation {
                        guard.child = None;
                        guard.child_id = None;
                        guard.status = BackendStatus::Stopped;
                        true
                    } else {
                        false
                    }
                };
                if reported {
                    let _ = app.emit(
                        EVENT_EXITED,
                        BackendExit {
                            code: payload.code,
                            signal: payload.signal,
                            status: BackendStatus::Stopped.as_str().to_string(),
                        },
                    );
                }
                terminated = true;
                break;
            }
            // `CommandEvent` is `#[non_exhaustive]`.
            _ => {}
        }
    }

    if !terminated {
        let mut guard = lock_state(&state);
        if guard.generation == generation {
            guard.child = None;
            guard.child_id = None;
            guard.status = BackendStatus::Stopped;
        }
    }
    // Dropping the sender fails any pending readiness wait instead of letting it ride out the
    // full timeout against a process that can no longer answer.
    let pending = {
        let mut guard = lock_state(&state);
        if guard.generation == generation {
            guard.ready_tx.take()
        } else {
            None
        }
    };
    drop(pending);
}

/// Extracts `<n>` from the backend's `ORBITAL_BACKEND_READY port=<n>` handshake line.
fn parse_ready_port(line: &str) -> Option<u16> {
    let rest = line.split_once(READY_MARKER)?.1;
    let digits: String = rest
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(|character| character.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Extracts `<token>` from the backend's `… token=<token>` handshake field.
///
/// The token is url-safe base64, so it never contains whitespace: the field ends at the first
/// space or line ending. An empty value is `None` — a backend that printed no token is not one to
/// hand a blank credential to.
fn parse_ready_token(line: &str) -> Option<String> {
    let rest = line.split_once(TOKEN_FIELD)?.1;
    let token: String = rest.chars().take_while(|character| !character.is_whitespace()).collect();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Locates the Python backend checkout for `tauri dev`. Tauri runs the dev binary from
/// `src-tauri/` while a bare `cargo run` runs from the repository root, so both are probed.
fn dev_backend_dir() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    [PathBuf::from("../backend"), PathBuf::from("backend")]
        .into_iter()
        .find(|candidate| candidate.join("orbital_backend").join("__main__.py").is_file())
}

/// Prefers the repository virtualenv, which holds the backend dependencies, over `python` on PATH.
fn dev_python(backend_dir: &Path) -> PathBuf {
    let root = backend_dir.parent().unwrap_or(backend_dir);
    let venv = if cfg!(windows) {
        root.join(".venv").join("Scripts").join("python.exe")
    } else {
        root.join(".venv").join("bin").join("python")
    };
    if venv.is_file() {
        venv
    } else {
        PathBuf::from("python")
    }
}

/// The application data directory is the only workspace root the bundled backend may serve.
fn app_data_dir(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => {
            if let Err(err) = std::fs::create_dir_all(&dir) {
                log::warn!("could not create {}: {err}", dir.display());
            }
            Some(dir)
        }
        Err(err) => {
            log::warn!("no application data directory available: {err}");
            None
        }
    }
}

fn allowed_roots_json(root: Option<&Path>) -> String {
    match root {
        Some(path) => serde_json::to_string(&[path.to_string_lossy().into_owned()])
            .unwrap_or_else(|_| "[]".to_string()),
        None => "[]".to_string(),
    }
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // A one-file PyInstaller sidecar is a bootloader plus a re-executed child, so killing the
    // parent pid alone would orphan the server.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let killed = Command::new("taskkill")
        .arg("/F")
        .arg("/T")
        .arg("/PID")
        .arg(pid.to_string())
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match killed {
        Ok(status) if status.success() => {}
        Ok(status) => log::warn!("taskkill returned {status} for pid {pid}"),
        Err(err) => log::warn!("taskkill failed for pid {pid}: {err}"),
    }
}

#[cfg(not(windows))]
fn kill_process_tree(pid: u32) {
    // SIGTERM lets the PyInstaller bootloader tear down its own child before the plugin's
    // SIGKILL lands on the parent.
    match std::process::Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
    {
        Ok(_) => {}
        Err(err) => log::warn!("kill failed for pid {pid}: {err}"),
    }
}
