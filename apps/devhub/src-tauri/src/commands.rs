//! Every command the App Shell can invoke.
//!
//! A child module rather than a separate crate, because these reach straight
//! into the state they act on: the boundary that matters is the one between
//! the shell and the native side, and it is drawn by what is registered here,
//! not by what is visible to Rust.

use super::*;

#[tauri::command]
pub(crate) fn get_app_snapshot(
    state: State<'_, NativeAppState>,
) -> Result<AppSnapshotWire, AppErrorWire> {
    if let Some(error) = state.take_native_error() {
        return Err(error);
    }
    let token = state.capture_open_lifecycle_token()?;
    state.app_snapshot_with_lifecycle(token)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PerformanceMarkerRequest {
    marker: PerformanceMarker,
}

/// Records one of the closed, content-free readiness markers.  The
/// command is a no-op in ordinary launches; the native driver opts in with
/// `DEVHUB_PERFORMANCE_MARKERS=1` so production diagnostics stay unchanged.
#[tauri::command]
pub(crate) fn record_performance_marker(
    state: State<'_, NativeAppState>,
    payload: PerformanceMarkerRequest,
) -> Result<(), AppErrorWire> {
    state.record_performance_marker(payload.marker)
}

#[tauri::command]
pub(crate) fn get_agent_profiles(
    state: State<'_, NativeAppState>,
) -> Result<AgentProfilesWire, AppErrorWire> {
    let token = state.capture_open_lifecycle_token()?;
    state.agent_profiles_with_lifecycle(token)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PickerStartRequest {
    #[serde(default)]
    query: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PickerSelectionRequest {
    path: String,
}

#[tauri::command]
pub(crate) async fn choose_workspace_folder(
    app: AppHandle,
) -> Result<Option<String>, AppErrorWire> {
    let token = app.state::<NativeAppState>().capture_open_lifecycle_token()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let output = ProcessCommand::new("osascript")
            .args(["-e", FOLDER_CHOOSER_SCRIPT])
            .output()
            .map_err(|_| AppErrorWire::native_unavailable())?;
        if !folder_chooser_status(output.status, &output.stderr)? {
            return Ok(None);
        }
        let path = String::from_utf8(output.stdout)
            .map_err(|_| AppErrorWire::native_unavailable())?
            .trim()
            .to_owned();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    })
    .await
    .map_err(|_| AppErrorWire::native_unavailable())??;
    app.state::<NativeAppState>().require_app_lifecycle_token(token)?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn start_workspace_picker(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: PickerStartRequest,
) -> Result<String, AppErrorWire> {
    let (lifecycle, operation_id, cancel) = {
        let _transaction = state.coordinator_transaction.lock().map_err(state_error)?;
        let lifecycle = state.capture_open_lifecycle_token_locked()?;
        let operation_id = state
            .id_generator
            .next_operation_id()
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let cancel = CancellationToken::new(operation_id.clone());
        if let Ok(mut previous) = state.picker_cancel.lock() {
            if let Some(previous) = previous.replace(cancel.clone()) {
                previous.cancel();
            }
        }
        (lifecycle, operation_id, cancel)
    };
    let _ = app.emit_to(
        APP_SHELL_WINDOW_LABEL,
        APP_WORKSPACE_PICKER_EVENT,
        WorkspacePickerEventWire::Started { operation_id: operation_id.to_string(), sequence: 0 },
    );
    let engine = state._workspace_discovery.clone();
    let query = payload.query.chars().take(256).collect::<String>();
    let worker_app = app.clone();
    let operation_wire = operation_id.to_string();
    tauri::async_runtime::spawn(async move {
        let picker_sink = Arc::new(PickerSink {
            app: worker_app.clone(),
            query,
            last_sequence: AtomicU64::new(0),
            lifecycle,
        });
        let sink: Arc<dyn WorkspaceDiscoverySink> = picker_sink.clone();
        let summary = engine.discover(cancel.clone(), sink).await;
        if let Ok(summary) = summary {
            if picker_sink.is_current() {
                let _ = worker_app.emit_to(
                    APP_SHELL_WINDOW_LABEL,
                    APP_WORKSPACE_PICKER_EVENT,
                    WorkspacePickerEventWire::Completed {
                        operation_id: operation_id.to_string(),
                        sequence: picker_sink.next_sequence(),
                        source_id: None,
                        candidate_count: summary.candidate_count,
                        error_count: summary.error_count,
                        stderr_bytes: summary.stderr_bytes,
                        cancelled: summary.cancelled,
                        truncated: summary.truncated,
                    },
                );
            }
        }
        if let Some(state) = worker_app.try_state::<NativeAppState>() {
            if let Ok(mut active) = state.picker_cancel.lock() {
                if active.as_ref().is_some_and(|token| token.operation_id() == &operation_id) {
                    active.take();
                }
            }
        }
    });
    Ok(operation_wire)
}

#[tauri::command]
pub(crate) fn cancel_workspace_picker(
    state: State<'_, NativeAppState>,
) -> Result<(), AppErrorWire> {
    let _transaction = state.coordinator_transaction.lock().map_err(state_error)?;
    state.capture_open_lifecycle_token_locked()?;
    if let Ok(mut active) = state.picker_cancel.lock() {
        if let Some(token) = active.take() {
            token.cancel();
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn select_workspace_picker(
    app: AppHandle,
    payload: PickerSelectionRequest,
) -> Result<AppOutcomeWire, AppErrorWire> {
    let path = devhub_app_core::RequestedPath::new(payload.path)
        .map_err(|_| AppErrorWire::invalid_intent())?;
    let token = app.state::<NativeAppState>().capture_open_lifecycle_token()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<NativeAppState>();
        state.require_app_lifecycle_token(token)?;
        let result =
            state.dispatch_intent_with_lifecycle(UserIntent::OpenFolder { path }, token)?;
        state.require_app_lifecycle_token(token)?;
        Ok(result)
    })
    .await
    .map_err(|_| AppErrorWire::native_unavailable())??;
    Ok(result.0)
}

/// Start the Editor's server and hand back how to reach it.
///
/// The Workbench is part of the App Shell's own bundle now, so this replaces
/// mounting a child WebView: the shell opens the connection itself.
/// Hand a destination the Editor asked for to the user's browser.
///
/// The Workbench runs in a frame with no way out of it, which is the point:
/// a link it decides is external reaches the shell as a message, and only
/// this command turns one into an `open`. What arrives is untrusted text,
/// so it is narrowed to a plain web address before the OS sees it.
#[tauri::command]
pub(crate) async fn open_external_url(
    url: String,
    state: State<'_, NativeAppState>,
) -> Result<(), AppErrorWire> {
    state.capture_open_lifecycle_token()?;
    let destination = editor::external_url(&url).ok_or_else(|| {
        AppErrorWire::native_unavailable().with_summary("that link cannot be opened")
    })?;
    let status = ProcessCommand::new("open").arg(destination.as_str()).status();
    if status.as_ref().is_err() || !status.map(|status| status.success()).unwrap_or(false) {
        return Err(AppErrorWire::native_unavailable().with_summary("the link could not be opened"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn ensure_editor_remote(
    app: AppHandle,
    state: State<'_, NativeAppState>,
) -> Result<editor::EditorRemote, AppErrorWire> {
    let token = state.capture_open_lifecycle_token()?;
    // Starting a server is a blocking wait on readiness, and the shell awaits
    // this before it can draw the Editor at all.
    tauri::async_runtime::spawn_blocking(move || {
        let state =
            app.try_state::<NativeAppState>().ok_or_else(AppErrorWire::native_unavailable)?;
        state.validate_app_lifecycle_token(token)?;
        state.editor_host.ensure_remote().map_err(|error| editor_error(&error))
    })
    .await
    .map_err(|_| AppErrorWire::native_unavailable())?
}

#[tauri::command]
pub(crate) fn get_app_appearance(
    state: State<'_, NativeAppState>,
) -> Result<AppAppearanceWire, SettingsErrorWire> {
    let token = state
        .capture_open_lifecycle_token()
        .map_err(|_| SettingsErrorWire::native_unavailable())?;
    state.app_appearance_with_lifecycle(token)
}

#[tauri::command]
pub(crate) async fn dispatch_app_intent(
    app: AppHandle,
    payload: AppIntentWire,
) -> Result<AppOutcomeWire, AppErrorWire> {
    let intent = payload.into_user_intent().map_err(|_| AppErrorWire::invalid_intent())?;
    // Provider calls are deliberately kept off the Tauri command thread. The
    // coordinator transaction is still serialized by its mutex, while
    // Herdr/tmux/editor work and its tokened completions run on the bounded
    // blocking executor used by the native adapters.
    let token = app.state::<NativeAppState>().capture_open_lifecycle_token()?;
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<NativeAppState>();
        state.require_app_lifecycle_token(token)?;
        let (wire, changed) = state.dispatch_intent_with_lifecycle(intent, token)?;
        state.require_app_lifecycle_token(token)?;
        Ok::<_, AppErrorWire>((wire, changed))
    })
    .await
    .map_err(|_| AppErrorWire::native_unavailable())?;
    let (wire, changed) = result?;
    if changed {
        if let Err(error) =
            app.emit_to(APP_SHELL_WINDOW_LABEL, APP_SNAPSHOT_CHANGED_EVENT, wire.snapshot())
        {
            let _ = error;
            app.state::<NativeAppState>().record_native_error(AppErrorWire::native_unavailable());
        }
    }
    Ok(wire)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplayRequest {
    cursor: u64,
}

#[tauri::command]
pub(crate) fn replay_app_events(
    state: State<'_, NativeAppState>,
    payload: ReplayRequest,
) -> Result<ReplayWire, AppErrorWire> {
    let token = state.capture_open_lifecycle_token()?;
    state.replay_with_lifecycle(token, payload.cursor)
}

#[tauri::command]
pub(crate) fn get_settings_snapshot(
    state: State<'_, NativeAppState>,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    let token = state.capture_settings_lifecycle_token()?;
    state.settings_snapshot_with_lifecycle(token)
}

#[tauri::command]
pub(crate) fn save_settings(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: SettingsSaveRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    let token = state.capture_settings_lifecycle_token()?;
    let snapshot = state.save_settings(payload)?;
    state.validate_settings_lifecycle_token(token)?;
    emit_settings_snapshot(&app, snapshot.clone());
    emit_app_appearance(&app, &state);
    emit_agent_profiles(&app, &state);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn reload_settings(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: devhub_app_core::SettingsCommandRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    let token = state.capture_settings_lifecycle_token()?;
    payload.validate()?;
    let before = state.settings_sequence()?;
    match state.reload_settings() {
        Ok(snapshot) => {
            state.validate_settings_lifecycle_token(token)?;
            if snapshot.sequence > before {
                emit_settings_snapshot(&app, snapshot.clone());
                emit_app_appearance(&app, &state);
                emit_agent_profiles(&app, &state);
            }
            Ok(snapshot)
        }
        Err(error) => {
            state.validate_settings_lifecycle_token(token)?;
            if state.settings_sequence()? > before {
                if let Ok(snapshot) = state.settings_snapshot() {
                    emit_settings_snapshot(&app, snapshot);
                }
                emit_agent_profiles(&app, &state);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn recheck_settings(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: devhub_app_core::SettingsCommandRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    let token = state.capture_settings_lifecycle_token()?;
    payload.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeAppState>().recheck_runtime_health();
    })
    .await
    .map_err(|_| SettingsErrorWire::native_unavailable())?;
    state.validate_settings_lifecycle_token(token)?;
    state.settings_snapshot_with_lifecycle(token)
}

pub(crate) fn diagnostics_settings_error(error: diagnostics::ActionError) -> SettingsErrorWire {
    match error {
        diagnostics::ActionError::PermissionDenied => SettingsErrorWire::permission_denied(),
        diagnostics::ActionError::Unavailable => SettingsErrorWire::native_unavailable(),
        diagnostics::ActionError::Busy => SettingsErrorWire::native_busy(),
        diagnostics::ActionError::TimedOut => SettingsErrorWire::native_timed_out(),
    }
}

#[tauri::command]
pub(crate) async fn open_log_folder(
    state: State<'_, NativeAppState>,
    payload: devhub_app_core::SettingsCommandRequestWire,
) -> Result<(), SettingsErrorWire> {
    let token = state.capture_settings_lifecycle_token()?;
    payload.validate()?;
    let diagnostics = state.diagnostics.clone();
    tauri::async_runtime::spawn_blocking(move || {
        diagnostics.open_log_folder(Duration::from_secs(5))
    })
    .await
    .map_err(|_| SettingsErrorWire::native_unavailable())?
    .map_err(diagnostics_settings_error)?;
    state.validate_settings_lifecycle_token(token)
}

#[tauri::command]
pub(crate) async fn copy_diagnostics(
    state: State<'_, NativeAppState>,
    payload: devhub_app_core::SettingsCommandRequestWire,
) -> Result<(), SettingsErrorWire> {
    let token = state.capture_settings_lifecycle_token()?;
    payload.validate()?;
    let health = state.runtime_health_probe.lock().ok().and_then(|probe| *probe).map_or(
        DiagnosticHealth::Degraded,
        |probe| {
            if probe.all_available() {
                DiagnosticHealth::Healthy
            } else {
                DiagnosticHealth::Degraded
            }
        },
    );
    let previous_exit = state.diagnostics.previous_exit();
    let diagnostics = state.diagnostics.clone();
    tauri::async_runtime::spawn_blocking(move || {
        diagnostics.copy_summary(health, previous_exit, Duration::from_secs(5))
    })
    .await
    .map_err(|_| SettingsErrorWire::native_unavailable())?
    .map_err(diagnostics_settings_error)?;
    state.validate_settings_lifecycle_token(token)
}

async fn terminal_worker<T, F>(app: AppHandle, operation: F) -> Result<T, TerminalError>
where
    T: Send + 'static,
    F: FnOnce(&NativeAppState, NativeLifecycleToken) -> Result<T, TerminalError> + Send + 'static,
{
    let token = app
        .state::<NativeAppState>()
        .capture_open_lifecycle_token()
        .map_err(|_| TerminalError::new(TerminalErrorCode::SurfaceUnavailable))?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<NativeAppState>();
        state.validate_terminal_lifecycle_token(token)?;
        let value = operation(&state, token)?;
        state.validate_terminal_lifecycle_token(token)?;
        Ok(value)
    })
    .await
    .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?
}

#[tauri::command]
pub(crate) async fn terminal_attach(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: AttachRequest,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<AttachReceipt, TerminalError> {
    let state = app.state::<NativeAppState>();
    state.record_performance_probe(PerformanceMarker::TerminalAttachEntered);
    let webview_label = webview.label().to_owned();
    let surface_key = payload.surface_key.clone();
    let result = terminal_worker(app.clone(), move |state, token| {
        let receipt = state.terminal_attach(&webview_label, payload, channel, token)?;
        if state.validate_terminal_lifecycle_token(token).is_err() {
            let _ = state._terminal_runtime.detach_surface(
                &surface_key,
                &receipt.attachment_id,
                &webview_label,
                receipt.target_generation,
            );
            return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable));
        }
        Ok(receipt)
    })
    .await;
    match &result {
        Ok(_) => state.record_performance_probe(PerformanceMarker::TerminalAttachSucceeded),
        Err(error) => state.record_performance_probe(terminal_attach_failure_marker(error.code())),
    }
    result
}

#[tauri::command]
pub(crate) async fn terminal_input(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: InputRequest,
) -> Result<(), TerminalError> {
    let state = app.state::<NativeAppState>();
    state.record_performance_probe(PerformanceMarker::TerminalInputEntered);
    let webview_label = webview.label().to_owned();
    let result = terminal_worker(app.clone(), move |state, token| {
        state.terminal_input(&webview_label, payload, token)
    })
    .await;
    match &result {
        Ok(_) => state.record_performance_probe(PerformanceMarker::TerminalInputSucceeded),
        Err(error) => state.record_performance_probe(terminal_input_failure_marker(error.code())),
    }
    result
}

#[tauri::command]
pub(crate) async fn terminal_resize(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: ResizeRequest,
) -> Result<(), TerminalError> {
    let state = app.state::<NativeAppState>();
    state.record_performance_probe(PerformanceMarker::TerminalResizeEntered);
    let webview_label = webview.label().to_owned();
    let result = terminal_worker(app.clone(), move |state, token| {
        state.terminal_resize(&webview_label, payload, token)
    })
    .await;
    match &result {
        Ok(_) => state.record_performance_probe(PerformanceMarker::TerminalResizeSucceeded),
        Err(error) => state.record_performance_probe(terminal_resize_failure_marker(error.code())),
    }
    result
}

#[tauri::command]
pub(crate) async fn terminal_acknowledge(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: AckRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, token| {
        state.terminal_acknowledge(&webview_label, payload, token)
    })
    .await
}

#[tauri::command]
pub(crate) async fn terminal_detach(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: DetachRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, _token| state.terminal_detach(&webview_label, payload)).await
}

#[tauri::command]
pub(crate) async fn agent_surface_attach(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: AttachRequest,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<AttachReceipt, TerminalError> {
    let webview_label = webview.label().to_owned();
    let callback_app = app.clone();
    terminal_worker(app, move |state, token| {
        let receipt =
            state.agent_surface_attach(&callback_app, &webview_label, payload, channel, token)?;
        if state.validate_terminal_lifecycle_token(token).is_err() {
            let _ = state.agent_surfaces.detach_receipt(&webview_label, &receipt);
            return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable));
        }
        Ok(receipt)
    })
    .await
}

#[tauri::command]
pub(crate) async fn agent_surface_input(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: InputRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, token| {
        state.agent_surface_input(&webview_label, payload, token)
    })
    .await
}

#[tauri::command]
pub(crate) async fn agent_surface_resize(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: ResizeRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, token| {
        state.agent_surface_resize(&webview_label, payload, token)
    })
    .await
}

#[tauri::command]
pub(crate) async fn agent_surface_acknowledge(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: AckRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, _token| {
        state.agent_surface_acknowledge(&webview_label, payload)
    })
    .await
}

#[tauri::command]
pub(crate) async fn agent_surface_detach(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: DetachRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, _token| state.agent_surface_detach(&webview_label, payload))
        .await
}

#[tauri::command]
pub(crate) async fn apply_socket_change(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: SettingsSocketChangeRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    payload.validate()?;
    let token = state.capture_settings_lifecycle_token()?;
    let result = state.apply_socket_change_with_lifecycle(payload, token).await;
    if result.is_ok() {
        state.validate_settings_lifecycle_token(token)?;
    }
    if result.is_ok() {
        emit_agent_profiles(&app, &state);
    }
    result
}

pub(crate) fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        window
            .set_menu(build_settings_menu(app).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("Settings")
    .inner_size(780.0, 620.0)
    .min_inner_size(680.0, 480.0)
    .resizable(true)
    .decorations(true)
    .center()
    .menu(build_settings_menu(app).map_err(|error| error.to_string())?)
    .build()
    .map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

/// App Shell-only bridge to the native Settings singleton. The command never
/// grants Settings WebView IPC to the App Shell; it only asks the native host
/// to reuse or create the already-scoped Settings window and focus it.
#[tauri::command]
pub(crate) fn open_settings_window(app: AppHandle) -> Result<(), AppErrorWire> {
    show_settings_window(&app).map_err(|_| AppErrorWire::native_unavailable())
}
