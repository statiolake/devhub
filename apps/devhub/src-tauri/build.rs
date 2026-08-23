fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_app_snapshot",
            "get_app_appearance",
            "dispatch_app_intent",
            "replay_app_events",
            "terminal_attach",
            "terminal_input",
            "terminal_resize",
            "terminal_acknowledge",
            "terminal_detach",
            "get_settings_snapshot",
            "save_settings",
            "reload_settings",
            "recheck_settings",
            "open_log_folder",
            "apply_socket_change",
        ]),
    ))
    .expect("failed to generate Tauri application ACL");
}
