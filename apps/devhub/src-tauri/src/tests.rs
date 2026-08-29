//! What the App Shell's native side is held to.
//!
//! Kept beside `lib.rs` rather than inside it: the behaviour under test is
//! most of a window's lifecycle, and reading either one should not mean
//! scrolling past the other.

use super::*;
use crate::runtime::{LoginEnvironmentStatus, RuntimeErrorCode};
use devhub_app_core::state::{OwnedSessionRecord, RecreationSessionRecord, RequiredTerminalSet};
use devhub_app_core::{CancellationToken, SettingsRuntimeHealthValueWire, WorkspaceRoot};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};

/// An editor failure must reach the shell as the thing that actually
/// happened. Flattening every provider fault to `native_unavailable` left
/// the user with one sentence and no next step. Assert on the serialized
/// form, because that is exactly what the shell receives.
#[test]
fn editor_failures_keep_their_actionable_shell_code() {
    use editor::{EditorError, EditorErrorCode};

    let cases = [
        (EditorErrorCode::PortConflict, "editor_port_unavailable"),
        (EditorErrorCode::OfficialVscodeUnavailable, "editor_provider_missing"),
        (EditorErrorCode::ExecutableUnavailable, "editor_provider_missing"),
        (EditorErrorCode::BridgeInstallFailed, "editor_unavailable"),
    ];
    for (editor_code, expected) in cases {
        let wire =
            serde_json::to_value(editor_error(&EditorError::new(editor_code))).expect("serialize");
        assert_eq!(wire["code"], expected, "{editor_code:?}");
        assert_eq!(wire["module"], "editor", "{editor_code:?}");
        // The summary is an alert's message text: short and declarative.
        // What to do about it belongs in the informative detail.
        let summary = wire["summary"].as_str().expect("summary").to_owned();
        assert!(summary.ends_with('.'), "{editor_code:?}: {summary}");
        assert!(summary.len() <= 60, "{editor_code:?}: {summary}");
        let actions = wire["actions"].as_array().expect("actions");
        assert!(actions.iter().any(|action| action == "retry"), "{editor_code:?}");
        // The concrete cause travels alongside, for the person who has to
        // fix it.
        assert!(wire["detail"].is_string(), "{editor_code:?}");
    }
}

/// The detail is the whole point: it must survive the hop from the
/// provider to the shell, including the values the user needs to act on.
#[test]
fn editor_error_detail_reaches_the_shell() {
    use editor::{EditorError, EditorErrorCode};

    let error = EditorError::new(EditorErrorCode::PortConflict)
        .with_detail("127.0.0.1:55971 is already in use by another process.");
    let wire = serde_json::to_value(editor_error(&error)).expect("serialize");
    let detail = wire["detail"].as_str().expect("detail");
    assert!(detail.contains("55971"), "{detail}");
    assert!(detail.contains("127.0.0.1"), "{detail}");
}

#[cfg(debug_assertions)]
static TEMP_DEBUG_RESOURCE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn the_shell_dims_its_selection_on_the_attribute_the_native_side_writes() {
    // The name is a contract between `report_window_activation` and the
    // stylesheet; nothing else links them.
    let shell_css = include_str!("../../src/styles/shell.css");
    assert!(shell_css.contains("[data-window-active=\"false\"]"));
    // Absent means active, so the shell is never dimmed by default.
    assert!(!shell_css.contains("[data-window-active=\"true\"]"));
}

#[test]
fn traffic_lights_sit_on_the_titlebar_centre_line() {
    for button_height in [12.0, 14.0, 16.0] {
        let (x, y) = devhub_macos_chrome::button_origin(
            APP_SHELL_TITLEBAR_HEIGHT,
            button_height,
            TRAFFIC_LIGHT_LEADING,
        );
        assert_eq!(x, TRAFFIC_LIGHT_LEADING);
        assert_eq!(y + button_height / 2.0, APP_SHELL_TITLEBAR_HEIGHT / 2.0);
    }
}

#[test]
fn the_window_config_leaves_the_traffic_lights_to_the_shell() {
    // Tao's own inset measures from a different origin, so a configured
    // position would silently compete with `centre_traffic_lights`.
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("config parses");
    assert!(config["app"]["windows"][0].get("trafficLightPosition").is_none());
}

#[cfg(debug_assertions)]
#[test]
fn debug_source_resource_dir_requires_the_built_bridge_package() {
    let root = std::env::temp_dir().join(format!(
        "devhub-debug-resources-{}-{}",
        std::process::id(),
        TEMP_DEBUG_RESOURCE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let package = root.join("extensions/devhub-bridge/build/devhub-bridge-0.1.0.vsix");
    std::fs::create_dir_all(package.parent().expect("package parent")).expect("directories");
    assert_eq!(debug_source_resource_dir_from(&root), None);
    std::fs::write(&package, b"fixture").expect("package");
    assert_eq!(debug_source_resource_dir_from(&root), Some(root.clone()));
    std::fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn diagnostics_action_errors_keep_distinct_settings_codes() {
    assert_eq!(
        commands::diagnostics_settings_error(diagnostics::ActionError::Unavailable).code,
        devhub_app_core::SettingsErrorCodeWire::NativeUnavailable
    );
    assert_eq!(
        commands::diagnostics_settings_error(diagnostics::ActionError::Busy).code,
        devhub_app_core::SettingsErrorCodeWire::NativeBusy
    );
    assert_eq!(
        commands::diagnostics_settings_error(diagnostics::ActionError::TimedOut).code,
        devhub_app_core::SettingsErrorCodeWire::NativeTimedOut
    );
    assert_eq!(
        commands::diagnostics_settings_error(diagnostics::ActionError::PermissionDenied).code,
        devhub_app_core::SettingsErrorCodeWire::PermissionDenied
    );
}

#[test]
fn folder_chooser_only_treats_explicit_apple_cancel_as_normal() {
    let success = ProcessCommand::new("true").status().expect("true status");
    assert!(folder_chooser_status(success, &[]).expect("success status"));
    let cancelled = ProcessCommand::new("false").status().expect("false status");
    assert!(!folder_chooser_status(cancelled, b"execution error: User canceled. (-128)")
        .expect("cancel status"));
    let failed = ProcessCommand::new("false").status().expect("false status");
    assert!(folder_chooser_status(failed, b"execution error: unavailable").is_err());
}

#[test]
fn every_exit_request_enters_quit_after_window_close_is_intercepted() {
    assert!(exit_request_is_quit(None));
    assert!(exit_request_is_quit(Some(0)));
    assert!(exit_request_is_quit(Some(1)));
}

#[test]
fn bridge_observation_tracks_clean_busy_and_disconnect_states() {
    let sink = NativeBridgeSink::default();
    let surface = editor::BridgeSurfaceId::from_uuid(
        devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000001")
            .expect("surface id"),
    );
    let workspace = devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000002")
        .expect("workspace id");
    let root = devhub_app_core::bridge::AbsolutePath::parse("/tmp/devhub").expect("absolute root");
    sink.on_event(BridgeEvent::Snapshot {
        surface_id: surface.clone(),
        generation: 1,
        readiness: devhub_app_core::bridge::Readiness::Ready,
        context: devhub_app_core::bridge::Context::Workspace {
            workspace_id: workspace,
            canonical_root: root,
        },
        dirty: false,
    });
    let workspace_id = WorkspaceId::from_uuid("00000000-0000-4000-8000-000000000002".to_owned())
        .expect("domain workspace id");
    let observation = sink.editor_observation(&workspace_id).expect("observation");
    assert!(observation.connected && !observation.dirty);
    assert!(sink
        .editor_surface_connected(&editor::EditorSurfaceKey::Workspace(workspace_id.to_string())));
    assert!(!sink.editor_surface_connected(&editor::EditorSurfaceKey::Global));
    sink.on_event(BridgeEvent::DirtyChanged {
        surface_id: surface.clone(),
        generation: 1,
        dirty: true,
    });
    assert!(sink.editor_observation(&workspace_id).expect("dirty observation").dirty);
    sink.on_event(BridgeEvent::Disconnected { surface_id: surface, generation: 1 });
    assert!(!sink.editor_observation(&workspace_id).expect("disconnected observation").connected);
}

#[test]
fn bridge_request_failures_are_handle_scoped_and_keep_newest_tombstones() {
    let sink = NativeBridgeSink::default();
    let surface = editor::BridgeSurfaceId::from_uuid(
        devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000011")
            .expect("surface id"),
    );
    let workspace = devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000012")
        .expect("workspace id");
    let root = devhub_app_core::bridge::AbsolutePath::parse("/tmp/devhub").expect("absolute root");
    sink.on_event(BridgeEvent::Snapshot {
        surface_id: surface.clone(),
        generation: 1,
        readiness: devhub_app_core::bridge::Readiness::Ready,
        context: devhub_app_core::bridge::Context::Workspace {
            workspace_id: workspace,
            canonical_root: root,
        },
        dirty: false,
    });
    for index in 0..257_u64 {
        let request_message_id =
            devhub_app_core::bridge::Uuid::parse(format!("00000000-0000-4000-8000-{index:012x}"))
                .expect("request id");
        sink.on_event(BridgeEvent::RequestFailed {
            handle: editor::BridgeRequestHandle::for_test(
                surface.clone(),
                devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000013")
                    .expect("connection id"),
                1,
                request_message_id,
            ),
            reason: devhub_app_core::bridge::RequestFailureReason::TimedOut,
        });
    }
    let failed = sink.failed_requests.lock().expect("failure ledger");
    assert_eq!(failed.len(), 256);
    assert!(failed.iter().any(|(_, _, request_id)| request_id.ends_with("000000000100")));
    assert!(!failed.iter().any(|(_, _, request_id)| request_id.ends_with("000000000000")));
    drop(failed);
    assert!(sink
        .observations
        .lock()
        .expect("observations")
        .get(surface.as_str())
        .is_some_and(|observation| observation.connected));
}

#[test]
fn oversized_wire_path_is_rejected_and_maps_to_typed_request_failure() {
    // AbsolutePath is intentionally more permissive than RequestedPath;
    // this is a valid Bridge payload that must fail in the route worker,
    // not remain pending until the Bridge deadline.
    let raw = format!("/{}", "x".repeat(32_768));
    let wire_path = devhub_app_core::bridge::AbsolutePath::parse(raw)
        .expect("wire path remains within the Bridge bound");
    assert!(devhub_app_core::RequestedPath::new(wire_path.as_str()).is_err());
    assert_eq!(
        bridge_request_failed_result(),
        BridgeRequestResult::Error {
            code: devhub_app_core::bridge::ErrorCode::RequestFailed,
            summary: devhub_app_core::bridge::ContentFreeSummary::Failed,
        }
    );
}

static TEMP_HOME_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn temp_home() -> std::path::PathBuf {
    let sequence = TEMP_HOME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("devhub-native-shell-{}-{sequence}", std::process::id()));
    std::fs::create_dir_all(&path).expect("create native shell test home");
    std::fs::canonicalize(path).expect("canonicalize native shell test home")
}

fn remove_temp_home(path: &Path) {
    assert!(Diagnostics::shutdown_for_test_home(path, Duration::from_secs(2)));
    std::fs::remove_dir_all(path).expect("remove native shell test home");
}

fn available_tmux_binary() -> Option<&'static Path> {
    [
        Path::new("/opt/homebrew/bin/tmux"),
        Path::new("/usr/local/bin/tmux"),
        Path::new("/usr/bin/tmux"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

#[test]
fn native_id_generator_uses_unique_canonical_intent_ids() {
    let generator = NativeIdGenerator;
    let first = generator.next_intent_id().expect("OS randomness is available");
    let second = generator.next_intent_id().expect("OS randomness is available");
    assert_ne!(first, second);
    assert_eq!(first.to_string().len(), 36);
    assert_eq!(second.to_string().len(), 36);
    assert!(IntentId::from_uuid(first.to_string()).is_ok());
}

#[test]
fn bootstrap_uses_canonical_home_and_restores_starting_metadata() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    assert_eq!(state.store.path(), home.join("Library/Application Support/DevHub/state.json"));
    let persisted = state.store.load_or_default().expect("load bootstrap state");
    assert!(!persisted.shutdown.clean);
    assert_eq!(persisted.shutdown.launch_generation, 1);
    remove_temp_home(&home);
}

#[test]
fn startup_reconstruction_failure_is_observable_without_waiting_for_timeout() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    assert_eq!(state.startup_reconstruction_state(), StartupReconstructionState::Pending);
    let started = Instant::now();
    state.set_startup_reconstruction_state(StartupReconstructionState::Failed);
    assert_eq!(state.startup_reconstruction_state(), StartupReconstructionState::Failed);
    assert!(started.elapsed() < Duration::from_secs(1));
    remove_temp_home(&home);
}

#[test]
fn process_file_limit_target_is_bounded_and_never_lowers_soft_limit() {
    assert_eq!(process_file_limit_target(256, 8_192, 8_192), Ok(Some(8_192)));
    assert_eq!(process_file_limit_target(16_384, 32_768, 8_192), Ok(None));
    assert_eq!(
        process_file_limit_target(256, 4_096, 8_192),
        Err(ProcessFileLimitError::HardLimitTooLow { hard: 4_096, minimum: 8_192 })
    );
}

#[test]
fn bootstrap_allows_missing_git_and_keeps_repository_resolver_unavailable() {
    let home = temp_home();
    let config_store = ConfigStore::new(default_config_path(&home));
    let loaded = config_store.load().expect("create default config");
    let mut config = loaded.config().clone();
    config.runtimes.git = home.join("missing-git").to_string_lossy().into_owned();
    config_store.save(loaded.revision(), config).expect("save missing git config");

    let state = NativeAppState::bootstrap(&home).expect("missing git must not block startup");
    assert!(!state._repository_resolver.is_available());
    let workspace = WorkspaceRoot::new(home.clone()).expect("test workspace root");
    let operation =
        OperationId::from_uuid("00000000-0000-4000-8000-000000000031").expect("test operation ID");
    let error = state
        ._repository_resolver
        .resolve_sync(&workspace, &CancellationToken::new(operation))
        .expect_err("unavailable git resolver");
    assert_eq!(error.code(), PortErrorCode::Unavailable);
    remove_temp_home(&home);
}

#[test]
fn bootstrap_allows_missing_login_shell_and_records_runtime_health_failure() {
    let home = temp_home();
    let config_store = ConfigStore::new(default_config_path(&home));
    let loaded = config_store.load().expect("create default config");
    let mut config = loaded.config().clone();
    config.runtimes.shell = home.join("missing-login-shell").to_string_lossy().into_owned();
    config_store.save(loaded.revision(), config).expect("save missing shell config");

    let state =
        NativeAppState::bootstrap(&home).expect("missing login shell must not block startup");
    assert_eq!(
        state._runtime_context.login_environment_status(),
        LoginEnvironmentStatus::Failed(RuntimeErrorCode::MissingExecutable)
    );
    remove_temp_home(&home);
}

#[test]
fn disabled_login_import_reports_shell_unavailable_until_inspected() {
    let home = temp_home();
    let config_store = ConfigStore::new(default_config_path(&home));
    let loaded = config_store.load().expect("create default config");
    let mut config = loaded.config().clone();
    config.general.import_login_environment = false;
    config_store.save(loaded.revision(), config).expect("save import setting");

    let state = NativeAppState::bootstrap(&home).expect("ambient startup");
    let snapshot = state.settings_snapshot().expect("settings snapshot");
    assert_eq!(snapshot.runtime.health.shell, SettingsRuntimeHealthValueWire::Unavailable);
    assert_eq!(
        snapshot.runtime.health.inspection_available,
        state._terminal_runtime.adapter_available()
    );
    assert!(state.diagnostics.flush(Duration::from_secs(2)));
    assert!(matches!(
        state.diagnostics.shutdown(Duration::from_secs(2)),
        ShutdownOutcome::Complete
    ));
    drop(state);
    remove_temp_home(&home);
}

#[test]
fn settings_snapshot_uses_content_revision_and_honest_runtime_unavailable_state() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let snapshot = state.settings_snapshot().expect("settings snapshot");
    snapshot.validate().expect("native snapshot is contract-valid");
    assert_eq!(snapshot.schema_version, devhub_app_core::SETTINGS_SCHEMA_VERSION);
    assert_eq!(snapshot.sequence, 1);
    assert_eq!(snapshot.revision.len(), 64);
    assert_eq!(
        snapshot.runtime.health.inspection_available,
        state._terminal_runtime.adapter_available()
    );
    assert_eq!(
        snapshot.runtime.socket_change.adapter_available,
        state._terminal_runtime.adapter_available()
    );
    remove_temp_home(&home);
}

#[test]
fn socket_apply_is_two_stage_read_only_between_phases_and_rebinds_live_runtime() {
    if std::env::var_os("CODEX_SANDBOX").is_some_and(|value| value == "seatbelt") {
        return;
    }
    let Some(tmux_binary) = available_tmux_binary() else {
        return;
    };
    let home = temp_home();
    let sequence = TEMP_HOME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let old_socket = format!("dh-native-old-{}-{}", std::process::id(), sequence);
    let new_socket = format!("dh-native-new-{}-{}", std::process::id(), sequence);
    let old_name = SocketName::new(old_socket.clone()).expect("old socket");
    let new_name = SocketName::new(new_socket.clone()).expect("new socket");

    let store = JsonStateStore::for_home(&home);
    let mut persisted = devhub_app_core::PersistedAppState::fresh();
    persisted.tmux.effective_socket_name = old_socket;
    store.save_state(&persisted).expect("seed effective socket");
    let config_store = ConfigStore::new(default_config_path(&home));
    let loaded = config_store.load().expect("default config");
    let mut config = loaded.config().clone();
    config.runtimes.tmux_socket_name = new_socket;
    config_store.save(loaded.revision(), config).expect("new configured socket");

    let state = NativeAppState::bootstrap(&home).expect("bootstrap native state");
    if !state._terminal_runtime.adapter_available() {
        remove_temp_home(&home);
        return;
    }
    let old_cancel = state.transition_cancel().expect("old cancellation");
    tauri::async_runtime::block_on(
        state._terminal_runtime.ensure(TerminalTarget::scratch(), old_cancel),
    )
    .expect("old Scratch");

    let before = state.settings_snapshot().expect("initial snapshot");
    assert_eq!(
        before.runtime.socket_change.state,
        devhub_app_core::SettingsSocketTransitionWire::Stable
    );
    let prepared = tauri::async_runtime::block_on(state.apply_socket_change(
        SettingsSocketChangeRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: before.revision.clone(),
            sequence: before.sequence,
            confirmed: false,
            retry: false,
        },
    ))
    .expect("read-only apply preflight");
    assert_eq!(
        prepared.runtime.socket_change.state,
        devhub_app_core::SettingsSocketTransitionWire::Pending
    );
    assert!(prepared.runtime.socket_change.confirmation_required);
    assert_eq!(prepared.runtime.socket_change.scratch_session_count, 1);
    assert!(prepared.sequence > before.sequence);

    let reread = state.settings_snapshot().expect("read-only projection");
    assert_eq!(reread, prepared);
    assert_eq!(
        reread.runtime.socket_change.state,
        devhub_app_core::SettingsSocketTransitionWire::Pending
    );

    // The confirmation cursor is not a permission to trust stale target
    // observations.  A marked target created after the sheet was shown
    // must be rejected before the old socket is touched.
    tauri::async_runtime::block_on(state._terminal_runtime.ensure_on_socket(
        new_name.clone(),
        TerminalTarget::scratch(),
        state.transition_cancel().expect("target mutation cancellation"),
    ))
    .expect("mutate target after preflight");
    let stale_target = tauri::async_runtime::block_on(state.apply_socket_change(
        SettingsSocketChangeRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: prepared.revision.clone(),
            sequence: prepared.sequence,
            confirmed: true,
            retry: false,
        },
    ))
    .expect_err("changed target must stale before cleanup");
    assert_eq!(stale_target.code, devhub_app_core::SettingsErrorCodeWire::StaleSocketChange);
    let stale_target_snapshot = state.settings_snapshot().expect("stale target snapshot");
    assert_eq!(
        stale_target_snapshot.runtime.socket_change.target_preflight,
        devhub_app_core::SettingsSocketPreflightWire::MarkedSessions
    );
    assert_eq!(stale_target_snapshot.runtime.socket_change.scratch_session_count, 0);
    let old_after_target_change =
        tauri::async_runtime::block_on(state._terminal_runtime.inspect_owned_sessions(
            old_name.clone(),
            state.transition_cancel().expect("old inspection cancellation"),
        ))
        .expect("old inventory after target stale");
    assert_eq!(old_after_target_change.sessions().len(), 1);

    // Clear the target conflict, then change the old exact inventory after
    // a fresh confirmation snapshot.  Revalidation must return Pending
    // with the refreshed zero-count inventory without killing anything.
    tauri::async_runtime::block_on(state._terminal_runtime.close_owned_session(
        new_name.clone(),
        devhub_app_core::state::OwnedSessionRecord::Scratch { session_name: "scratch".to_owned() },
        state.transition_cancel().expect("target cleanup cancellation"),
    ))
    .expect("clear target conflict");
    let prepared_again = tauri::async_runtime::block_on(state.apply_socket_change(
        SettingsSocketChangeRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: stale_target_snapshot.revision.clone(),
            sequence: stale_target_snapshot.sequence,
            confirmed: false,
            retry: false,
        },
    ))
    .expect("refresh target and old inventory");
    assert!(prepared_again.runtime.socket_change.confirmation_required);
    assert_eq!(prepared_again.runtime.socket_change.scratch_session_count, 1);
    tauri::async_runtime::block_on(state._terminal_runtime.close_owned_session(
        old_name.clone(),
        devhub_app_core::state::OwnedSessionRecord::Scratch { session_name: "scratch".to_owned() },
        state.transition_cancel().expect("old mutation cancellation"),
    ))
    .expect("mutate old inventory after confirmation");
    let stale_inventory = tauri::async_runtime::block_on(state.apply_socket_change(
        SettingsSocketChangeRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: prepared_again.revision.clone(),
            sequence: prepared_again.sequence,
            confirmed: true,
            retry: false,
        },
    ))
    .expect_err("changed old inventory must stale before cleanup");
    assert_eq!(stale_inventory.code, devhub_app_core::SettingsErrorCodeWire::StaleSocketChange);
    let refreshed = state.settings_snapshot().expect("refreshed old inventory snapshot");
    assert_eq!(
        refreshed.runtime.socket_change.state,
        devhub_app_core::SettingsSocketTransitionWire::Pending
    );
    assert_eq!(refreshed.runtime.socket_change.scratch_session_count, 0);
    assert!(refreshed.runtime.socket_change.confirmation_required);

    let completed = tauri::async_runtime::block_on(state.apply_socket_change(
        SettingsSocketChangeRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: refreshed.revision.clone(),
            sequence: refreshed.sequence,
            confirmed: true,
            retry: false,
        },
    ))
    .expect("confirmed transition after refreshed inventory");
    assert_eq!(
        completed.runtime.socket_change.state,
        devhub_app_core::SettingsSocketTransitionWire::Stable
    );
    assert_eq!(completed.runtime.socket_change.effective_socket_name, new_name.as_str());
    let old_inventory = tauri::async_runtime::block_on(
        state
            ._terminal_runtime
            .inspect_owned_sessions(old_name.clone(), state.transition_cancel().unwrap()),
    )
    .expect("old inventory after cleanup");
    assert!(old_inventory.sessions().is_empty());
    let new_inventory = tauri::async_runtime::block_on(
        state
            ._terminal_runtime
            .inspect_owned_sessions(new_name.clone(), state.transition_cancel().unwrap()),
    )
    .expect("new inventory after recreation");
    assert_eq!(new_inventory.sessions().len(), 1);
    assert!(state.diagnostics.flush(Duration::from_secs(2)));
    let initial_log = std::fs::read_to_string(state.diagnostics.directory().join("devhub.jsonl"))
        .expect("initial transition diagnostics");
    assert!(!initial_log.lines().any(|line| line.contains("\"event\":\"retry\"")));
    tauri::async_runtime::block_on(state._terminal_runtime.ensure(
        TerminalTarget::scratch(),
        state.transition_cancel().expect("rebind cancellation"),
    ))
    .expect("ordinary runtime uses the committed socket");

    for socket in [old_name, new_name] {
        let _ =
            ProcessCommand::new(tmux_binary).args(["-L", socket.as_str(), "kill-server"]).status();
    }
    remove_temp_home(&home);
}

#[test]
fn startup_pending_empty_inventory_commits_without_confirmation() {
    if std::env::var_os("CODEX_SANDBOX").is_some_and(|value| value == "seatbelt") {
        return;
    }
    let Some(tmux_binary) = available_tmux_binary() else {
        return;
    };
    let home = temp_home();
    let sequence = TEMP_HOME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let old_socket = SocketName::new(format!("dh-pending-old-{}-{sequence}", std::process::id()))
        .expect("old socket");
    let new_socket = SocketName::new(format!("dh-pending-new-{}-{sequence}", std::process::id()))
        .expect("new socket");
    let store = JsonStateStore::for_home(&home);
    let mut persisted = devhub_app_core::PersistedAppState::fresh();
    persisted.tmux.effective_socket_name = old_socket.as_str().to_owned();
    store.save_state(&persisted).expect("seed effective socket");
    let config_store = ConfigStore::new(default_config_path(&home));
    let loaded = config_store.load().expect("default config");
    let mut config = loaded.config().clone();
    config.runtimes.tmux_socket_name = new_socket.as_str().to_owned();
    config_store.save(loaded.revision(), config).expect("new configured socket");

    let state = NativeAppState::bootstrap(&home).expect("bootstrap native state");
    if !state._terminal_runtime.adapter_available() {
        remove_temp_home(&home);
        return;
    }
    let required = RequiredTerminalSet::new([OwnedSessionRecord::Scratch {
        session_name: "scratch".to_owned(),
    }])
    .expect("required Scratch");
    let mut pending = store.load_or_default().expect("load pending state");
    pending
        .tmux
        .request_socket_change(new_socket.as_str(), required)
        .expect("request socket change");
    pending
        .tmux
        .record_target_preflight(SocketTargetPreflightState::TargetAbsent)
        .expect("target preflight");
    pending.tmux.record_verified_old_sessions([]).expect("empty exact old inventory");
    store.save_state(&pending).expect("persist pending snapshot");
    drop(state);

    let relaunched = NativeAppState::bootstrap(&home).expect("relaunch native state");
    let resumed = tauri::async_runtime::block_on(relaunched.resume_startup_socket_transition())
        .expect("startup should resume empty pending inventory");
    assert!(matches!(resumed.tmux.transition, SocketTransitionState::Stable));
    assert_eq!(resumed.tmux.effective_socket_name, new_socket.as_str());
    let inventory =
        tauri::async_runtime::block_on(relaunched._terminal_runtime.inspect_owned_sessions(
            new_socket.clone(),
            relaunched.transition_cancel().expect("new inspection cancellation"),
        ))
        .expect("new inventory");
    assert_eq!(inventory.sessions().len(), 1);
    assert_eq!(inventory.sessions()[0].session_name(), "scratch");

    let _ =
        ProcessCommand::new(tmux_binary).args(["-L", new_socket.as_str(), "kill-server"]).status();
    remove_temp_home(&home);
}

#[test]
fn partial_cleanup_rechecks_valid_target_change_and_resumes_afterward() {
    if std::env::var_os("CODEX_SANDBOX").is_some_and(|value| value == "seatbelt") {
        return;
    }
    let Some(tmux_binary) = available_tmux_binary() else {
        return;
    };
    let home = temp_home();
    let sequence = TEMP_HOME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let old_socket = SocketName::new(format!("dh-partial-old-{}-{sequence}", std::process::id()))
        .expect("old socket");
    let new_socket = SocketName::new(format!("dh-partial-new-{}-{sequence}", std::process::id()))
        .expect("new socket");
    let orphan_root = home.join("orphan-workspace");
    std::fs::create_dir(&orphan_root).expect("orphan workspace directory");
    let workspace_id =
        devhub_app_core::WorkspaceId::from_uuid("00000000-0000-4000-8000-000000000071")
            .expect("orphan workspace id");
    let workspace_root = WorkspaceRoot::new(orphan_root).expect("orphan workspace root");
    let store = JsonStateStore::for_home(&home);
    let mut persisted = devhub_app_core::PersistedAppState::fresh();
    persisted.tmux.effective_socket_name = old_socket.as_str().to_owned();
    store.save_state(&persisted).expect("seed effective socket");
    let config_store = ConfigStore::new(default_config_path(&home));
    let loaded = config_store.load().expect("default config");
    let mut config = loaded.config().clone();
    config.runtimes.tmux_socket_name = new_socket.as_str().to_owned();
    config_store.save(loaded.revision(), config).expect("new configured socket");

    let state = NativeAppState::bootstrap(&home).expect("bootstrap native state");
    if !state._terminal_runtime.adapter_available() {
        remove_temp_home(&home);
        return;
    }
    tauri::async_runtime::block_on(state._terminal_runtime.ensure_on_socket(
        old_socket.clone(),
        TerminalTarget::scratch(),
        state.transition_cancel().expect("old Scratch cancellation"),
    ))
    .expect("old Scratch");
    tauri::async_runtime::block_on(state._terminal_runtime.ensure_on_socket(
        old_socket.clone(),
        TerminalTarget::workspace(workspace_id, workspace_root),
        state.transition_cancel().expect("old workspace cancellation"),
    ))
    .expect("old orphan workspace");
    let old_inventory =
        tauri::async_runtime::block_on(state._terminal_runtime.inspect_owned_sessions(
            old_socket.clone(),
            state.transition_cancel().expect("old inventory cancellation"),
        ))
        .expect("old exact inventory");
    assert_eq!(old_inventory.sessions().len(), 2);
    let orphan = old_inventory
        .sessions()
        .iter()
        .find(|session| matches!(session, OwnedSessionRecord::Workspace { .. }))
        .cloned()
        .expect("orphan workspace record");

    let mut active = store.load_or_default().expect("load state");
    let required = RequiredTerminalSet::new([OwnedSessionRecord::Scratch {
        session_name: "scratch".to_owned(),
    }])
    .expect("recreation only needs Scratch");
    active
        .tmux
        .request_socket_change(new_socket.as_str(), required)
        .expect("request socket change");
    active
        .tmux
        .record_target_preflight(SocketTargetPreflightState::TargetAbsent)
        .expect("target absent cursor");
    active
        .tmux
        .record_verified_old_sessions(old_inventory.sessions().to_owned())
        .expect("persist full cleanup inventory");
    active.tmux.start_cleaning_old().expect("start cleanup");
    active
        .tmux
        .mark_old_session("scratch", CleanupSessionStatus::Completed)
        .expect("persist partial completion");
    store.save_state(&active).expect("persist partial cleanup");

    // The target changed only between the two safe valid states. The
    // retry must persist DevhubEmpty and continue the remaining orphan,
    // rather than returning a permanent stale cursor.
    tauri::async_runtime::block_on(state._terminal_runtime.ensure_on_socket(
        new_socket.clone(),
        TerminalTarget::scratch(),
        state.transition_cancel().expect("target setup cancellation"),
    ))
    .expect("create valid marked target");
    tauri::async_runtime::block_on(state._terminal_runtime.close_owned_session(
        new_socket.clone(),
        OwnedSessionRecord::Scratch { session_name: "scratch".to_owned() },
        state.transition_cancel().expect("target emptying cancellation"),
    ))
    .expect("leave target marker with no marked sessions");
    let before = state.settings_snapshot().expect("partial snapshot");
    let completed = tauri::async_runtime::block_on(state.apply_socket_change(
        SettingsSocketChangeRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: before.revision,
            sequence: before.sequence,
            confirmed: true,
            retry: true,
        },
    ))
    .expect("partial retry after valid target change");
    assert_eq!(
        completed.runtime.socket_change.state,
        devhub_app_core::SettingsSocketTransitionWire::Stable
    );
    assert_eq!(completed.runtime.socket_change.effective_socket_name, new_socket.as_str());
    assert!(state.diagnostics.flush(Duration::from_secs(2)));
    let retry_log = std::fs::read_to_string(state.diagnostics.directory().join("devhub.jsonl"))
        .expect("retry transition diagnostics");
    assert!(retry_log.lines().any(|line| line.contains("\"event\":\"retry\"")));
    let old_after = tauri::async_runtime::block_on(state._terminal_runtime.inspect_owned_sessions(
        old_socket.clone(),
        state.transition_cancel().expect("old final inventory cancellation"),
    ))
    .expect("old final inventory");
    assert!(old_after.sessions().is_empty());
    let new_after = tauri::async_runtime::block_on(state._terminal_runtime.inspect_owned_sessions(
        new_socket.clone(),
        state.transition_cancel().expect("new final inventory cancellation"),
    ))
    .expect("new final inventory");
    assert_eq!(new_after.sessions().len(), 1);
    assert_eq!(new_after.sessions()[0].session_name(), "scratch");
    assert!(orphan.session_name().starts_with("ws-"));

    for socket in [old_socket, new_socket] {
        let _ =
            ProcessCommand::new(tmux_binary).args(["-L", socket.as_str(), "kill-server"]).status();
    }
    remove_temp_home(&home);
}

#[test]
fn startup_resume_retries_persisted_cleanup_and_recreation_failures() {
    if std::env::var_os("CODEX_SANDBOX").is_some_and(|value| value == "seatbelt") {
        return;
    }
    let Some(tmux_binary) = available_tmux_binary() else {
        return;
    };
    let home = temp_home();
    let sequence = TEMP_HOME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let old_socket = format!("dh-resume-old-{}-{sequence}", std::process::id());
    let new_socket = format!("dh-resume-new-{}-{sequence}", std::process::id());
    let old_name = SocketName::new(old_socket.clone()).expect("old socket");
    let new_name = SocketName::new(new_socket.clone()).expect("new socket");
    let store = JsonStateStore::for_home(&home);
    let mut seed = devhub_app_core::PersistedAppState::fresh();
    seed.tmux.effective_socket_name = old_socket;
    store.save_state(&seed).expect("seed old effective socket");
    let config_store = ConfigStore::new(default_config_path(&home));
    let loaded = config_store.load().expect("default config");
    let mut config = loaded.config().clone();
    config.runtimes.tmux_socket_name = new_socket;
    config_store.save(loaded.revision(), config).expect("new configured socket");

    let state = NativeAppState::bootstrap(&home).expect("bootstrap native state");
    if !state._terminal_runtime.adapter_available() {
        remove_temp_home(&home);
        return;
    }
    tauri::async_runtime::block_on(state._terminal_runtime.ensure(
        TerminalTarget::scratch(),
        state.transition_cancel().expect("old setup cancellation"),
    ))
    .expect("old Scratch");

    // Persist a confirmed cleanup with a prior failed attempt.  Relaunch
    // must retry this exact record, finish the old proof, commit the new
    // effective socket, and only then recreate Scratch.
    let mut persisted = store.load_or_default().expect("load startup state");
    let required = RequiredTerminalSet::new([OwnedSessionRecord::Scratch {
        session_name: "scratch".to_owned(),
    }])
    .expect("required Scratch");
    persisted
        .tmux
        .request_socket_change(new_name.as_str(), required)
        .expect("request socket change");
    persisted
        .tmux
        .record_target_preflight(SocketTargetPreflightState::TargetAbsent)
        .expect("target preflight");
    persisted
        .tmux
        .record_verified_old_sessions([OwnedSessionRecord::Scratch {
            session_name: "scratch".to_owned(),
        }])
        .expect("old inventory");
    persisted.tmux.start_cleaning_old().expect("start cleanup");
    persisted
        .tmux
        .mark_old_session("scratch", CleanupSessionStatus::Failed)
        .expect("persist failed cleanup attempt");
    store.save_state(&persisted).expect("persist cleanup retry point");
    drop(state);

    let relaunched = NativeAppState::bootstrap(&home).expect("relaunch cleanup retry");
    let resumed = tauri::async_runtime::block_on(relaunched.resume_startup_socket_transition())
        .expect("startup cleanup and recreation resume");
    assert!(matches!(resumed.tmux.transition, SocketTransitionState::Stable));
    assert_eq!(resumed.tmux.effective_socket_name, new_name.as_str());
    let old_inventory =
        tauri::async_runtime::block_on(relaunched._terminal_runtime.inspect_owned_sessions(
            old_name.clone(),
            relaunched.transition_cancel().expect("old verify cancellation"),
        ))
        .expect("old inventory after startup resume");
    assert!(old_inventory.sessions().is_empty());
    let new_inventory =
        tauri::async_runtime::block_on(relaunched._terminal_runtime.inspect_owned_sessions(
            new_name.clone(),
            relaunched.transition_cancel().expect("new verify cancellation"),
        ))
        .expect("new inventory after startup resume");
    assert_eq!(new_inventory.sessions().len(), 1);

    // A crash after the commit but during recreation is a different
    // durable phase.  Keep the committed effective socket and failed
    // recreation record, then verify relaunch resumes without rollback.
    let mut recreation = relaunched.store.load_or_default().expect("load stable state");
    let required = RequiredTerminalSet::new([OwnedSessionRecord::Scratch {
        session_name: "scratch".to_owned(),
    }])
    .expect("recreation required Scratch");
    recreation.tmux.transition = SocketTransitionState::RecreationPending {
        effective_socket_name: new_name.as_str().to_owned(),
        required,
        sessions: vec![RecreationSessionRecord {
            session: OwnedSessionRecord::Scratch { session_name: "scratch".to_owned() },
            status: RecreationSessionStatus::Failed,
        }],
    };
    recreation.tmux.effective_socket_name = new_name.as_str().to_owned();
    relaunched.store.save_state(&recreation).expect("persist recreation retry point");
    drop(relaunched);

    let resumed_again = NativeAppState::bootstrap(&home).expect("relaunch recreation retry");
    let recreation_result =
        tauri::async_runtime::block_on(resumed_again.resume_startup_socket_transition())
            .expect("startup recreation resume");
    assert!(matches!(recreation_result.tmux.transition, SocketTransitionState::Stable));
    assert_eq!(recreation_result.tmux.effective_socket_name, new_name.as_str());

    for socket in [old_name, new_name] {
        let _ =
            ProcessCommand::new(tmux_binary).args(["-L", socket.as_str(), "kill-server"]).status();
    }
    remove_temp_home(&home);
}

#[test]
fn app_snapshot_persistence_merges_while_socket_operation_gate_is_busy() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let mut persisted = state.store.load_or_default().expect("load state");
    let required = RequiredTerminalSet::new([OwnedSessionRecord::Scratch {
        session_name: "scratch".to_owned(),
    }])
    .expect("required Scratch");
    persisted
        .tmux
        .request_socket_change("devhub-concurrent-target", required)
        .expect("request transition");
    persisted
        .tmux
        .record_target_preflight(SocketTargetPreflightState::TargetAbsent)
        .expect("target preflight");
    persisted.tmux.record_verified_old_sessions([]).expect("empty old inventory");
    state.store.save_state(&persisted).expect("persist transition document");

    // This flag represents a provider operation waiting on tmux. Ordinary
    // application persistence must not use it as a document-write lock.
    state.socket_transition_busy.store(true, Ordering::Release);
    let (outcome, changed) = state
        .dispatch_intent(UserIntent::ResizeSidebar { width: 300 })
        .expect("app persistence is independent of transition I/O");
    state.socket_transition_busy.store(false, Ordering::Release);
    assert!(changed);
    assert!(matches!(outcome, AppOutcomeWire::Updated { .. }));

    let merged = state.store.load_or_default().expect("load merged state");
    assert_eq!(merged.sidebar.width, 300);
    assert!(matches!(
        merged.tmux.transition,
        SocketTransitionState::Pending {
            ref requested_socket_name,
            verified_old_sessions: Some(ref sessions),
            ..
        } if requested_socket_name == "devhub-concurrent-target" && sessions.is_empty()
    ));
    remove_temp_home(&home);
}

#[test]
fn configured_socket_save_is_rejected_during_confirmed_transition() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let mut persisted = state.store.load_or_default().expect("load state");
    let required = RequiredTerminalSet::new([OwnedSessionRecord::Scratch {
        session_name: "scratch".to_owned(),
    }])
    .expect("required Scratch");
    persisted
        .tmux
        .request_socket_change("devhub-active-target", required)
        .expect("request transition");
    persisted
        .tmux
        .record_target_preflight(SocketTargetPreflightState::TargetAbsent)
        .expect("target preflight");
    persisted.tmux.record_verified_old_sessions([]).expect("old inventory");
    persisted.tmux.start_cleaning_old().expect("confirmed cleanup phase");
    state.store.save_state(&persisted).expect("persist active transition");

    let before = state.settings_snapshot().expect("settings snapshot");
    let mut config = before.config.clone();
    config.runtimes.tmux_socket_name = "devhub-overwrite".to_owned();
    let error = state
        .save_settings(SettingsSaveRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: before.revision.clone(),
            config,
        })
        .expect_err("active transition owns configured socket");
    assert_eq!(error.code, devhub_app_core::SettingsErrorCodeWire::StaleSocketChange);
    let after = state.settings_snapshot().expect("settings after rejected save");
    assert_eq!(after.config.runtimes.tmux_socket_name, before.config.runtimes.tmux_socket_name);
    assert_eq!(
        after.runtime.socket_change.requested_socket_name,
        Some("devhub-active-target".to_owned())
    );
    remove_temp_home(&home);
}

#[test]
fn external_socket_edit_during_transition_is_deferred_and_reconciled_after_stable() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let mut persisted = state.store.load_or_default().expect("load state");
    let required = RequiredTerminalSet::new([OwnedSessionRecord::Scratch {
        session_name: "scratch".to_owned(),
    }])
    .expect("required Scratch");
    persisted
        .tmux
        .request_socket_change("devhub-confirmed-target", required)
        .expect("request transition");
    persisted
        .tmux
        .record_target_preflight(SocketTargetPreflightState::TargetAbsent)
        .expect("target preflight");
    persisted.tmux.record_verified_old_sessions([]).expect("old inventory");
    persisted.tmux.start_cleaning_old().expect("confirmed cleanup phase");
    state.store.save_state(&persisted).expect("persist active transition");

    let before = state.settings_snapshot().expect("last-good settings snapshot");
    let before_profiles = serde_json::to_value(state.agent_profiles().expect("profiles"))
        .expect("profile projection");
    let original_profile_name = before_profiles["profiles"][0]["displayName"]
        .as_str()
        .expect("default profile name")
        .to_owned();
    let mut external = before.config.clone().into_config().expect("config model");
    external.runtimes.tmux_socket_name = "devhub-external-target".to_owned();
    external.agent_profiles[0].display_name = "Deferred external profile".to_owned();
    std::fs::write(state.config_store.path(), external.to_toml().expect("external config TOML"))
        .expect("write external config");
    let error = state.reload_settings().expect_err("active transition defers edit");
    assert_eq!(error.code, devhub_app_core::SettingsErrorCodeWire::StaleSocketChange);
    let deferred = state.settings_snapshot().expect("deferred projection");
    assert_eq!(deferred.config.runtimes.tmux_socket_name, before.config.runtimes.tmux_socket_name);
    assert_eq!(
        deferred.diagnostic.as_ref().map(|diagnostic| diagnostic.code),
        Some(devhub_app_core::SettingsDiagnosticCodeWire::Conflict)
    );
    let degraded_profiles = serde_json::to_value(state.agent_profiles().expect("profiles"))
        .expect("degraded profile projection");
    assert_eq!(degraded_profiles["availability"], "degraded");
    assert_eq!(degraded_profiles["profiles"][0]["displayName"], original_profile_name);
    assert!(state.deferred_config.lock().unwrap().is_some());

    let mut stable = state.store.load_or_default().expect("load active state");
    stable.tmux.transition = SocketTransitionState::Stable;
    state.store.save_state(&stable).expect("persist stable transition");
    tauri::async_runtime::block_on(state.resume_socket_transition(true))
        .expect("reconcile deferred config at stable");
    let reconciled = state.settings_snapshot().expect("reconciled settings");
    assert_eq!(reconciled.config.runtimes.tmux_socket_name, "devhub-external-target");
    assert!(reconciled.diagnostic.is_none());
    assert!(
        reconciled.runtime.socket_change.configured_socket_name
            != reconciled.runtime.socket_change.effective_socket_name
    );
    let reconciled_profiles = serde_json::to_value(state.agent_profiles().expect("profiles"))
        .expect("reconciled profile projection");
    assert_eq!(reconciled_profiles["availability"], "available");
    assert_eq!(reconciled_profiles["profiles"][0]["displayName"], "Deferred external profile");
    remove_temp_home(&home);
}

#[test]
fn settings_save_rejects_stale_revision_without_overwriting_last_good_config() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let before = state.settings_snapshot().expect("settings snapshot");
    let mut config = before.config.clone();
    config.general.import_login_environment = !config.general.import_login_environment;
    let error = state
        .save_settings(devhub_app_core::SettingsSaveRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: "f".repeat(64),
            config,
        })
        .expect_err("stale revision must conflict");
    assert_eq!(error.code, devhub_app_core::SettingsErrorCodeWire::ExternalEditConflict);
    let after = state.settings_snapshot().expect("settings snapshot after conflict");
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.config, before.config);
    remove_temp_home(&home);
}

#[test]
fn accepted_settings_projection_changes_advance_independent_sequence() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let before = state.settings_snapshot().expect("settings snapshot");
    let mut config = before.config.clone();
    config.general.import_login_environment = !config.general.import_login_environment;
    let after = state
        .save_settings(devhub_app_core::SettingsSaveRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: before.revision.clone(),
            config,
        })
        .expect("save current revision");
    assert_eq!(after.sequence, before.sequence + 1);
    assert_ne!(after.revision, before.revision);
    remove_temp_home(&home);
}

#[test]
fn accepted_runtime_changes_do_not_mutate_startup_launch_context_until_relaunch() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let startup_context = state._runtime_context.clone();
    let startup_resolver = format!("{:?}", state._repository_resolver);
    let before = state.settings_snapshot().expect("settings snapshot");
    let effective_before = before.runtime.effective.clone();
    let mut config = before.config.clone();
    config.general.import_login_environment = !config.general.import_login_environment;
    config.runtimes.git = "/bin/false".to_owned();
    config.runtimes.shell = "/bin/sh".to_owned();
    config.runtimes.tmux = "/bin/false".to_owned();
    config.runtimes.herdr = "/bin/false".to_owned();
    config.runtimes.tmux_args = vec!["-u".to_owned()];

    let after = state
        .save_settings(devhub_app_core::SettingsSaveRequestWire {
            schema_version: devhub_app_core::SETTINGS_SCHEMA_VERSION,
            revision: before.revision,
            config,
        })
        .expect("save runtime setting");

    assert_eq!(after.config.runtimes.git, "/bin/false");
    assert!(after.runtime.restart_required);
    assert_eq!(after.runtime.effective, effective_before);
    assert_eq!(state._runtime_context, startup_context);
    assert_eq!(format!("{:?}", state._repository_resolver), startup_resolver);
    remove_temp_home(&home);
}

#[test]
fn reloaded_runtime_changes_keep_startup_effective_values_until_relaunch() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let before = state.settings_snapshot().expect("settings snapshot");
    let effective_before = before.runtime.effective.clone();
    let mut config = before.config.clone().into_config().expect("wire config");
    config.general.import_login_environment = !config.general.import_login_environment;
    config.runtimes.git = "/bin/false".to_owned();
    config.runtimes.shell = "/bin/sh".to_owned();
    config.runtimes.tmux = "/bin/false".to_owned();
    config.runtimes.herdr = "/bin/false".to_owned();
    config.runtimes.tmux_args = vec!["-2".to_owned()];
    std::fs::write(state.config_store.path(), config.to_toml().expect("runtime TOML"))
        .expect("write external runtime config");

    let after = state.reload_settings().expect("reload runtime config");
    assert!(after.runtime.restart_required);
    assert_eq!(after.runtime.effective, effective_before);
    assert_eq!(after.config.runtimes.git, "/bin/false");
    remove_temp_home(&home);
}

#[test]
fn invalid_external_settings_keep_last_good_projection_and_expose_redacted_diagnostic() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    std::fs::write(state.config_store.path(), "version = [not valid")
        .expect("write invalid config");
    let error = state.reload_settings().expect_err("invalid external config");
    assert_eq!(error.code, devhub_app_core::SettingsErrorCodeWire::InvalidConfig);
    let snapshot = state.settings_snapshot().expect("last-known-good snapshot");
    assert!(snapshot.diagnostic.is_some());
    assert_eq!(snapshot.config.version, 1);
    remove_temp_home(&home);
}

#[test]
fn invalid_then_restored_unchanged_config_clears_diagnostic_and_advances_sequence() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let path = state.config_store.path().to_path_buf();
    let original = std::fs::read(&path).expect("read valid config");
    let before = state.settings_snapshot().expect("initial snapshot");
    std::fs::write(&path, "version = [not valid").expect("write invalid config");
    state.reload_settings().expect_err("invalid external config");
    let invalid = state.settings_snapshot().expect("diagnostic snapshot");
    assert!(invalid.sequence > before.sequence);
    assert!(invalid.diagnostic.is_some());

    std::fs::write(&path, original).expect("restore valid config");
    let restored = state.reload_settings().expect("unchanged last-good config");
    assert!(restored.sequence > invalid.sequence);
    assert!(restored.diagnostic.is_none());
    remove_temp_home(&home);
}

#[test]
fn settings_capability_is_scoped_to_the_single_settings_webview() {
    let settings: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/settings.json"))
            .expect("valid Settings capability");
    assert_eq!(settings["webviews"], serde_json::json!(["settings"]));
    assert_eq!(
        settings["permissions"],
        serde_json::json!([
            "core:default",
            "allow-get-settings-snapshot",
            "allow-save-settings",
            "allow-reload-settings",
            "allow-recheck-settings",
            "allow-open-log-folder",
            "allow-copy-diagnostics",
            "allow-apply-socket-change"
        ])
    );
    assert!(settings.get("windows").is_none());
    assert!(!settings.to_string().contains("app-shell"));

    let app_shell: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/app-shell.json"))
            .expect("valid App Shell capability");
    assert_eq!(app_shell["webviews"], serde_json::json!(["app-shell"]));
    assert_eq!(
        app_shell["permissions"],
        serde_json::json!([
            "core:default",
            // `core:window:default` is read-only, so the titlebar's
            // `data-tauri-drag-region` cannot move the window without
            // this one extra command.
            "core:window:allow-start-dragging",
            "allow-get-app-snapshot",
            "allow-record-performance-marker",
            "allow-start-workspace-picker",
            "allow-cancel-workspace-picker",
            "allow-select-workspace-picker",
            "allow-choose-workspace-folder",
            "allow-get-app-appearance",
            "allow-get-agent-profiles",
            "allow-dispatch-app-intent",
            "allow-open-external-url",
            "allow-replay-app-events",
            "allow-terminal-attach",
            "allow-terminal-input",
            "allow-terminal-resize",
            "allow-terminal-acknowledge",
            "allow-terminal-detach",
            "allow-agent-surface-attach",
            "allow-agent-surface-input",
            "allow-agent-surface-resize",
            "allow-agent-surface-acknowledge",
            "allow-agent-surface-detach",
            "allow-open-settings-window",
            // The Editor's server is started on demand; without this the
            // command is refused at runtime with a message the App Shell
            // has no way to anticipate.
            "allow-ensure-editor-remote"
        ])
    );
    assert!(app_shell.get("windows").is_none());
    let app_manifest = include_str!("../build.rs");
    for command in [
        "\"record_performance_marker\"",
        "\"get_agent_profiles\"",
        "\"agent_surface_attach\"",
        "\"agent_surface_input\"",
        "\"agent_surface_resize\"",
        "\"agent_surface_acknowledge\"",
        "\"agent_surface_detach\"",
        "\"open_settings_window\"",
    ] {
        assert!(app_manifest.contains(command), "AppManifest command missing: {command}");
    }
}

#[test]
fn native_menu_keeps_settings_singleton_and_standard_mac_edit_window_actions() {
    // The menu is built in `lib.rs` and the window it opens in `commands.rs`;
    // both halves are the one behaviour under test.
    let source = concat!(include_str!("lib.rs"), include_str!("commands.rs"));
    for marker in [
        "OPEN_SETTINGS_MENU_ID",
        "PredefinedMenuItem::undo",
        "PredefinedMenuItem::redo",
        "PredefinedMenuItem::cut",
        "PredefinedMenuItem::copy",
        "PredefinedMenuItem::paste",
        "PredefinedMenuItem::select_all",
        "PredefinedMenuItem::hide_others",
        "PredefinedMenuItem::show_all",
        "PredefinedMenuItem::minimize",
        "CLOSE_WINDOW_MENU_ID",
        "build_settings_menu(app)",
        "Some(\"CmdOrCtrl+W\")",
    ] {
        assert!(source.contains(marker), "native menu marker missing: {marker}");
    }
    let forbidden_close = format!("{}{}", "PredefinedMenuItem::", "close_window");
    assert!(!source.contains(&forbidden_close));
    assert!(source.contains("index.html?window=settings"));
    assert!(source.contains("get_webview_window(SETTINGS_WINDOW_LABEL)"));
}

#[test]
fn open_settings_command_reuses_and_focuses_the_singleton_window() {
    let source = include_str!("commands.rs");
    for marker in [
        "fn open_settings_window(app: AppHandle)",
        "show_settings_window(&app)",
        "if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL)",
        "window.show()",
        "window.set_focus()",
        "WebviewWindowBuilder::new(",
    ] {
        assert!(source.contains(marker), "Settings singleton marker missing: {marker}");
    }
}

#[test]
fn provider_exit_and_retry_seams_emit_only_typed_content_free_facts() {
    let source = include_str!("lib.rs");
    for marker in [
        "self.diagnostics.emit(DiagnosticEvent::ProviderExit",
        "code: LogCode::ProviderExited",
        "self.diagnostics.emit(DiagnosticEvent::Retry",
        "code: LogCode::ProviderReconnect",
        "code: LogCode::RetryLimit",
        "module: diagnostics::Module::State",
        "module: diagnostics::Module::Settings",
        "module: diagnostics::Module::App",
    ] {
        assert!(source.contains(marker), "diagnostic seam marker missing: {marker}");
    }
}

#[test]
fn settings_snapshots_are_targeted_and_appearance_is_a_separate_safe_projection() {
    let source = include_str!("lib.rs");
    assert!(source.contains("app.emit_to(SETTINGS_WINDOW_LABEL, SETTINGS_CHANGED_EVENT, snapshot)"));
    let forbidden_broadcast = format!(".emit({}...", "SETTINGS_CHANGED_EVENT");
    assert!(!source.contains(&forbidden_broadcast));
    let forbidden_app_broadcast = format!(".emit({}...", "APP_SNAPSHOT_CHANGED_EVENT");
    assert!(!source.contains(&forbidden_app_broadcast));
    assert!(source.contains("app.emit_to(APP_SHELL_WINDOW_LABEL, APP_APPEARANCE_CHANGED_EVENT"));

    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let appearance = state.app_appearance().expect("appearance projection");
    let encoded = format!("{appearance:?}");
    assert!(encoded.contains("sidebar_density"));
    assert!(!encoded.contains("agentProfiles"));
    assert!(!encoded.contains("env"));
    remove_temp_home(&home);
}

#[test]
fn window_close_is_not_clean_but_quit_is_clean() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    state.close_window().expect("close window");
    assert!(!state.store.load_or_default().expect("load after close").shutdown.clean);
    state.quit().expect("quit app");
    assert!(state.store.load_or_default().expect("load after quit").shutdown.clean);
    remove_temp_home(&home);
}

#[test]
fn failed_close_restores_attached_coordinator_for_a_retry() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    state.store.fail_once(devhub_app_core::AtomicFailurePoint::BeforeTempWrite);
    assert!(state.close_window().is_err());
    assert_eq!(state.lifecycle.phase(), Phase::Open);
    // The failed transaction must restore the pre-close coordinator so a
    // second close genuinely executes instead of treating it as a no-op.
    state.close_window().expect("retry close");
    assert_eq!(state.lifecycle.phase(), Phase::Closed);
    remove_temp_home(&home);
}

#[test]
fn close_reopen_is_singleton_and_quit_after_close_stops_owned_lifecycle_only() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let before = state.current_snapshot().expect("initial snapshot");

    state.close_window().expect("close window");
    assert_eq!(state.lifecycle.phase(), Phase::Closed);
    assert_eq!(state.current_snapshot().expect("closed snapshot"), before);
    state.close_window().expect("duplicate close is harmless");
    assert!(state.reopen().expect("reopen claim should be accepted"));
    assert_eq!(state.lifecycle.phase(), Phase::Open);
    assert_eq!(state.current_snapshot().expect("restored snapshot"), before);
    assert!(!state.reopen().expect("duplicate reopen is harmless"));

    // A coordinator detached by WindowClosed emits no second Quit effect;
    // native quit still owns VS Code Server/app-local cleanup and persists a
    // clean final state without terminating Herdr or tmux providers.
    state.close_window().expect("close before quit");
    state.quit().expect("quit after close");
    assert_eq!(state.lifecycle.phase(), Phase::Quit);
    assert!(state.store.load_or_default().expect("clean final state").shutdown.clean);
    assert!(state.quit().is_ok(), "quit is idempotent after completion");
    remove_temp_home(&home);
}

#[test]
fn failed_reopen_returns_to_closed_for_a_later_dock_retry() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    state.close_window().expect("close window");
    assert!(state.lifecycle.begin_reopen());
    // Simulate a WRY/display reconstruction failure after the durable
    // coordinator claim. The gate must make the next Dock event retryable.
    state.lifecycle.abort_reopen();
    assert_eq!(state.lifecycle.phase(), Phase::Closed);
    assert!(state.reopen().expect("retry reopen"));
    assert_eq!(state.lifecycle.phase(), Phase::Open);
    remove_temp_home(&home);
}

#[test]
fn exit_requested_quit_claim_is_nonrecursive_and_single_flight() {
    let claimed = AtomicBool::new(false);
    assert!(claim_single_flight(&claimed));
    // A programmatic app.exit is allowed only after the owner has
    // completed cleanup; a second ExitRequested while that work is in
    // flight cannot enter a second quit path.
    assert!(!claim_single_flight(&claimed));

    let claims = Arc::new(AtomicBool::new(false));
    let workers = (0..16)
        .map(|_| {
            let claims = Arc::clone(&claims);
            std::thread::spawn(move || claim_single_flight(&claims))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        workers
            .into_iter()
            .filter_map(|worker| worker.join().ok())
            .filter(|claimed| *claimed)
            .count(),
        1
    );
}

#[test]
fn native_exit_waits_for_the_in_flight_quit_owner() {
    let completion = Arc::new(QuitCompletion::new());
    assert!(completion.begin());
    assert!(!completion.begin(), "duplicate ExitRequested is a follower");

    let owner_started = Arc::new(Barrier::new(2));
    let owner_release = Arc::new(Barrier::new(2));
    let worker = {
        let completion = Arc::clone(&completion);
        let owner_started = Arc::clone(&owner_started);
        let owner_release = Arc::clone(&owner_release);
        std::thread::spawn(move || {
            owner_started.wait();
            owner_release.wait();
            completion.complete(Ok(()));
        })
    };
    owner_started.wait();

    let waiter = {
        let completion = Arc::clone(&completion);
        std::thread::spawn(move || completion.wait_until(Instant::now() + Duration::from_secs(1)))
    };
    assert!(completion.wait_for_waiter(Instant::now() + Duration::from_secs(1)));
    assert!(!waiter.is_finished(), "native Exit must wait, not run a fallback quit");
    owner_release.wait();
    worker.join().expect("owner");
    assert_eq!(waiter.join().expect("waiter"), Some(Ok(())));
    assert!(!completion.begin(), "completion remains idempotent");
}

#[test]
fn stale_window_generation_cannot_match_reused_native_handle() {
    let old = NativeWindowIdentity { handle_key: 77, lifecycle_generation: 1 };
    let reopened = NativeWindowIdentity { handle_key: 77, lifecycle_generation: 2 };
    assert!(!native_identity_matches(Some(old), old, 2));
    assert!(!native_identity_matches(Some(reopened), old, 2));
    assert!(native_identity_matches(Some(reopened), reopened, 2));
}

#[test]
fn guarded_destroyed_uses_captured_identity_without_raw_handle() {
    let identity = NativeWindowIdentity { handle_key: 77, lifecycle_generation: 4 };
    let token = WindowCleanupToken {
        handle_key: identity.handle_key,
        lifecycle_generation: identity.lifecycle_generation,
    };
    assert_eq!(
        guarded_destroyed_identity(
            Phase::Closing,
            identity.lifecycle_generation,
            Some(identity),
            Some(identity),
            Some(identity),
            Some(token),
        ),
        Some(identity),
        "guarded Destroyed must resolve from stored identity after raw handle teardown"
    );
}

#[test]
fn guarded_destroyed_rejects_stale_identity_or_cleanup_reservation() {
    let identity = NativeWindowIdentity { handle_key: 77, lifecycle_generation: 4 };
    let replacement = NativeWindowIdentity { handle_key: 88, lifecycle_generation: 5 };
    let token = WindowCleanupToken {
        handle_key: identity.handle_key,
        lifecycle_generation: identity.lifecycle_generation,
    };
    let invalid = [
        (
            Phase::Open,
            identity.lifecycle_generation,
            Some(identity),
            Some(identity),
            Some(identity),
            Some(token),
        ),
        (
            Phase::Closing,
            replacement.lifecycle_generation,
            Some(identity),
            Some(identity),
            Some(identity),
            Some(token),
        ),
        (
            Phase::Closing,
            identity.lifecycle_generation,
            Some(replacement),
            Some(identity),
            Some(identity),
            Some(token),
        ),
        (
            Phase::Closing,
            identity.lifecycle_generation,
            Some(identity),
            Some(identity),
            Some(replacement),
            Some(token),
        ),
        (
            Phase::Closing,
            identity.lifecycle_generation,
            Some(identity),
            Some(identity),
            Some(identity),
            None,
        ),
    ];
    for (phase, generation, current, closing, allowance, cleanup) in invalid {
        assert_eq!(
            guarded_destroyed_identity(phase, generation, current, closing, allowance, cleanup),
            None,
            "stale Destroyed state must not clear a current Window"
        );
    }
}

#[test]
fn stale_frame_worker_cannot_clear_reopened_window_flags() {
    assert!(!frame_persist_owner_matches(2, 21, 1, 20));
    assert!(!frame_persist_owner_matches(2, 21, 2, 20));
    assert!(frame_persist_owner_matches(2, 21, 2, 21));
}

#[test]
fn frame_persistence_keeps_the_owned_token_through_close_and_quit() {
    assert!(frame_persist_phase_allowed(Phase::Open));
    assert!(frame_persist_phase_allowed(Phase::Closing));
    assert!(frame_persist_phase_allowed(Phase::Quitting));
    assert!(!frame_persist_phase_allowed(Phase::Closed));
    assert!(!frame_persist_phase_allowed(Phase::Quit));
}

#[test]
fn window_cleanup_token_blocks_reopen_until_the_owner_finishes() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let token =
        WindowCleanupToken { handle_key: 42, lifecycle_generation: state.lifecycle.generation() };
    assert!(state.begin_window_cleanup(token));
    assert!(!state.wait_for_window_cleanup(Instant::now() + Duration::from_millis(5)));
    state.finish_window_cleanup(WindowCleanupToken {
        handle_key: token.handle_key + 1,
        lifecycle_generation: token.lifecycle_generation,
    });
    assert!(!state.wait_for_window_cleanup(Instant::now() + Duration::from_millis(5)));
    state.finish_window_cleanup(token);
    assert!(state.wait_for_window_cleanup(Instant::now() + Duration::from_millis(50)));
    remove_temp_home(&home);
}

#[test]
fn stale_intent_cannot_mutate_reopened_coordinator_after_atomic_generation_swap() {
    let home = temp_home();
    let state = Arc::new(NativeAppState::bootstrap(&home).expect("bootstrap native app"));
    let old_token = state.capture_lifecycle_token();
    let before = state.current_snapshot().expect("initial snapshot");

    // Hold the transaction gate while a worker is in flight. The close,
    // reopen generation change, and coordinator replacement happen before
    // that worker can validate/mutate. An implementation that validated
    // outside this gate could still apply ResizeSidebar to the new
    // coordinator and only fail its post-dispatch check.
    let transaction = state.coordinator_transaction.lock().expect("transaction gate");
    let worker_state = Arc::clone(&state);
    let worker = std::thread::spawn(move || {
        worker_state
            .dispatch_intent_with_lifecycle(UserIntent::ResizeSidebar { width: 777 }, old_token)
    });
    std::thread::sleep(Duration::from_millis(10));

    assert!(state.lifecycle.begin_close());
    state.lifecycle.finish_close();
    assert!(state.lifecycle.begin_reopen());
    let (replacement, revision) = state.load_coordinator_from_store().expect("rehydrate");
    state.replace_coordinator_locked(replacement, revision).expect("install reopened coordinator");
    drop(transaction);

    let result = worker.join().expect("stale worker joins");
    assert!(result.is_err(), "old lifecycle worker must be rejected atomically");
    assert_eq!(
        state.current_snapshot().expect("reopened snapshot").sidebar().width(),
        before.sidebar().width(),
        "stale command must not mutate the newly reopened coordinator"
    );
    remove_temp_home(&home);
}

#[test]
fn quit_does_not_mark_clean_when_a_local_worker_misses_the_deadline() {
    let done = Arc::new(AtomicBool::new(false));
    let worker_done = Arc::clone(&done);
    let worker = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        worker_done.store(true, Ordering::Release);
    });
    let start = Instant::now();
    assert!(!join_managed_thread(
        ManagedThread { handle: worker, done },
        start + Duration::from_millis(10)
    ));
    assert!(start.elapsed() < Duration::from_millis(90));
}

#[test]
fn near_expired_quit_budget_does_not_claim_clean_state() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    let snapshot = state.current_snapshot().expect("current snapshot");
    let start = Instant::now();
    let result = state.persist_clean_snapshot(&snapshot, start + Duration::from_millis(1));
    assert!(result.is_err());
    assert!(start.elapsed() < Duration::from_millis(200));
    let persisted = state.store.load_or_default().expect("load unchanged state");
    assert!(!persisted.shutdown.clean);
    remove_temp_home(&home);
}

#[test]
fn lifecycle_rehydrates_eight_workspaces_and_sixteen_agents_without_duplicates() {
    let home = temp_home();
    let profile = DomainAgentProfile::new(
        AgentProfileId::from_slug("codex").expect("profile id"),
        "Codex",
        AgentProfileKind::Codex,
        Vec::new(),
        BTreeMap::new(),
    )
    .expect("profile");
    let mut model = devhub_app_core::AppModel::new();
    for workspace_index in 0..8_u32 {
        let root_path = home.join(format!("workspace-{workspace_index}"));
        std::fs::create_dir_all(&root_path).expect("workspace root");
        let root = WorkspaceRoot::new(root_path.clone()).expect("workspace root identity");
        let workspace_id =
            WorkspaceId::from_uuid(format!("00000000-0000-4000-8000-{:012x}", workspace_index + 1))
                .expect("workspace id");
        model
            .add_workspace(devhub_app_core::Workspace::new(
                workspace_id.clone(),
                root,
                devhub_app_core::DisplayPath::new(root_path).expect("selected path"),
                None,
            ))
            .expect("workspace");
        for agent_index in 0..2_u32 {
            let agent_number = workspace_index * 2 + agent_index + 1;
            let agent_id = devhub_app_core::AgentId::from_uuid(format!(
                "00000000-0000-4000-8000-{:012x}",
                100_u32 + agent_number
            ))
            .expect("agent id");
            model.add_agent(&workspace_id, agent_id, profile.clone()).expect("agent");
        }
    }
    let durable = devhub_app_core::PersistedAppState::from_snapshot(&model.snapshot())
        .expect("durable scale snapshot");
    JsonStateStore::for_home(&home).save_state(&durable).expect("save scale snapshot");

    let state = NativeAppState::bootstrap(&home).expect("bootstrap scale state");
    let before = state.current_snapshot().expect("scale snapshot");
    assert_eq!(before.workspaces().len(), 8);
    assert_eq!(
        before.workspaces().iter().map(|workspace| workspace.agents().len()).sum::<usize>(),
        16
    );
    state.close_window().expect("close scale state");
    assert!(state.reopen().expect("reopen scale state"));
    let after = state.current_snapshot().expect("restored scale snapshot");
    assert_eq!(after.workspaces().len(), 8);
    assert_eq!(
        after.workspaces().iter().map(|workspace| workspace.agents().len()).sum::<usize>(),
        16
    );
    state.quit().expect("quit scale state");
    remove_temp_home(&home);
}

#[test]
fn failed_snapshot_save_returns_persistence_degraded_outcome() {
    let home = temp_home();
    let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
    state.store.fail_once(devhub_app_core::AtomicFailurePoint::BeforeTempWrite);
    let (outcome, changed) = state
        .dispatch_intent(UserIntent::ResizeSidebar { width: 300 })
        .expect("dispatch should report degraded outcome");
    assert!(changed);
    assert!(matches!(outcome, AppOutcomeWire::PersistenceDegraded { .. }));
    let events = state.coordinator.lock().unwrap().replay_from(0).into_events();
    let persist_token = events.iter().find_map(|event| match event.event() {
        CoordinatorEvent::Effect(Effect::PersistState { token }) => Some(token),
        _ => None,
    });
    assert!(persist_token.is_some_and(|token| {
        events.iter().any(|event| {
            matches!(
                event.event(),
                CoordinatorEvent::OperationCompleted { token: completed }
                    if completed == token
            )
        })
    }));
    remove_temp_home(&home);
}

#[test]
fn concurrent_temp_home_persistence_keeps_latest_coordinator_snapshot() {
    let home = temp_home();
    let state = Arc::new(NativeAppState::bootstrap(&home).expect("bootstrap native app"));
    let widths = [204, 220, 236, 252, 268, 284, 300, 316, 332, 348, 364, 380, 396];
    let barrier = Arc::new(Barrier::new(widths.len() + 1));
    let handles = widths
        .into_iter()
        .map(|width| {
            let state = Arc::clone(&state);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                state
                    .dispatch_intent(UserIntent::ResizeSidebar { width })
                    .expect("concurrent resize persists");
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    for handle in handles {
        handle.join().expect("resize thread joins");
    }

    let expected = state.coordinator.lock().unwrap().snapshot().sidebar().width();
    let persisted = state.store.load_or_default().expect("load concurrent state");
    assert_eq!(persisted.sidebar.width, expected);

    let events = state.coordinator.lock().unwrap().replay_from(0).into_events();
    let persist_tokens = events.iter().filter_map(|event| match event.event() {
        CoordinatorEvent::Effect(Effect::PersistState { token }) => Some(token.clone()),
        _ => None,
    });
    for token in persist_tokens {
        assert!(events.iter().any(|event| {
            matches!(
                event.event(),
                CoordinatorEvent::OperationCompleted { token: completed }
                    if completed == &token
            )
        }));
    }
    remove_temp_home(&home);
}
