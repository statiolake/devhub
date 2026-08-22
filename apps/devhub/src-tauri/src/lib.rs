#![forbid(unsafe_code)]

use std::sync::Mutex;

use devhub_app_core::{
    ShellSnapshot, ShellStore, ShellStoreError, DEVHUB_PLATFORM, DEVHUB_PRODUCT_NAME,
    DEVHUB_WINDOW_LABEL,
};
use tauri::{AppHandle, Emitter, State};

/// Event sent after a shell update.  The event payload is the same immutable
/// snapshot returned by the command, so missed events can be recovered by a
/// query.
pub const SHELL_SNAPSHOT_CHANGED_EVENT: &str = "shell://snapshot-changed";

#[tauri::command]
fn get_shell_snapshot(
    state: State<'_, Mutex<ShellStore>>,
) -> Result<ShellSnapshot, ShellStoreError> {
    state.lock().map(|store| store.snapshot()).map_err(|_| ShellStoreError::StateUnavailable)
}

#[tauri::command]
fn mark_shell_ready(
    app: AppHandle,
    state: State<'_, Mutex<ShellStore>>,
) -> Result<ShellSnapshot, ShellStoreError> {
    let snapshot = state.lock().map_err(|_| ShellStoreError::StateUnavailable)?.mark_ready();

    // A notification is best effort.  The Rust-owned state and command result
    // remain authoritative if an event subscriber has gone away.
    if let Err(error) = app.emit(SHELL_SNAPSHOT_CHANGED_EVENT, &snapshot) {
        eprintln!("DevHub shell snapshot notification unavailable: {error}");
    }

    Ok(snapshot)
}

/// Builds and runs the native DevHub application shell.
pub fn run() {
    let shell = ShellStore::new(DEVHUB_PRODUCT_NAME, DEVHUB_PLATFORM, DEVHUB_WINDOW_LABEL)
        .expect("DevHub shell identity is valid");

    tauri::Builder::default()
        .manage(Mutex::new(shell))
        .invoke_handler(tauri::generate_handler![get_shell_snapshot, mark_shell_ready])
        .run(tauri::generate_context!())
        .expect("error while running DevHub");
}
