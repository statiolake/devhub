fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_app_snapshot",
            "dispatch_app_intent",
            "replay_app_events",
        ]),
    ))
    .expect("failed to generate Tauri application ACL");
}
