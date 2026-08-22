fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["get_shell_snapshot", "mark_shell_ready"]),
    ))
    .expect("failed to generate Tauri application ACL");
}
