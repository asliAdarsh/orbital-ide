mod commands;
mod error;
mod sidecar;

use std::sync::{Arc, Mutex};

/// Minimal stderr sink so the drained backend output and lifecycle messages are visible in
/// `tauri dev` instead of vanishing into an unconfigured `log` facade.
struct StderrLogger;

static LOGGER: StderrLogger = StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("{} {}: {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

fn init_logging() {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

    let port = sidecar::pick_free_port().unwrap_or_else(|err| {
        log::warn!(
            "could not reserve a loopback port ({err}); falling back to {}",
            sidecar::FALLBACK_PORT
        );
        sidecar::FALLBACK_PORT
    });
    let state = Arc::new(Mutex::new(sidecar::BackendState::new(port)));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![
            commands::backend_info,
            commands::restart_backend,
            commands::stop_backend,
            commands::open_project_dialog,
            commands::open_in_editor,
        ])
        .setup(move |app| {
            sidecar::launch(app.handle().clone(), Arc::clone(&state));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Orbital desktop application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::shutdown(app);
            }
        });
}
