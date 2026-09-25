//! The IPC surface the React shell drives.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::error::AppError;
use crate::sidecar::{self, BackendInfo, BackendState};

/// Backend coordinates for the boot sequence: port, base URL, pid and lifecycle status.
#[tauri::command]
pub fn backend_info(state: State<'_, Arc<Mutex<BackendState>>>) -> BackendInfo {
    sidecar::lock_state(state.inner()).info()
}

/// Kills the sidecar process tree and starts a fresh one on a new port.
#[tauri::command]
pub async fn restart_backend(app: AppHandle) -> Result<BackendInfo, AppError> {
    let state = backend_state(&app);
    sidecar::restart(&app, &state).await?;
    Ok(sidecar::lock_state(&state).info())
}

/// Kills the sidecar without restarting it. Idempotent.
#[tauri::command]
pub async fn stop_backend(app: AppHandle) -> BackendInfo {
    let state = backend_state(&app);
    sidecar::stop(&state);
    sidecar::lock_state(&state).info()
}

/// Native folder picker; `None` when the user cancels.
#[tauri::command]
pub async fn open_project_dialog(app: AppHandle) -> Result<Option<String>, AppError> {
    match app.dialog().file().blocking_pick_folder() {
        Some(folder) => folder
            .into_path()
            .map(|path| Some(path.to_string_lossy().into_owned()))
            .map_err(|err| AppError::Dialog(err.to_string())),
        None => Ok(None),
    }
}

/// Hands a workspace path to the platform's default handler for it.
#[tauri::command]
pub async fn open_in_editor(app: AppHandle, path: String) -> Result<(), AppError> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|err| AppError::Opener(err.to_string()))
}

fn backend_state(app: &AppHandle) -> Arc<Mutex<BackendState>> {
    Arc::clone(app.state::<Arc<Mutex<BackendState>>>().inner())
}
