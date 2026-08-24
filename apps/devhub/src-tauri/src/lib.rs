#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::Command as ProcessCommand;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use devhub_app_core::config::{
    default_config_path, AgentProfileKind as ConfigAgentProfileKind, ConfigDiagnostic, ConfigStore,
    LoadedConfig, ReloadOutcome, RuntimeConfig,
};
use devhub_app_core::ports::{
    AgentRuntime, EditorHost as EditorHostPort, SocketName, TerminalRuntime,
    WorkspaceDiscovery as WorkspaceDiscoveryPort, WorkspaceDiscoveryEvent,
    WorkspaceDiscoveryEventKind, WorkspaceDiscoverySink, WorkspacePathResolver,
    WorkspaceTerminalTarget,
};
use devhub_app_core::state::{
    CleanupSessionStatus, PersistedDiagnosticCode, RecreationSessionStatus,
    SocketTargetPreflightState, SocketTransitionState, WorkspaceLifecycleRecord,
};
use devhub_app_core::{classify_runtime, SettingsRuntimeWire};
use devhub_app_core::{
    Activity, AgentControlState, AgentLaunchResult, AgentObservation,
    AgentProfile as DomainAgentProfile, AgentProfileId, AgentProfileKind,
    AgentProfilesDiagnosticWire, AgentProfilesWire, AgentStopResult, AppAppearanceWire,
    AppCoordinator, AppErrorWire, AppIntentWire, AppOutcomeWire, AppReadiness, AppSnapshot,
    AppSnapshotWire, CancellationToken, CleanupStep, CloseInspectionInputs, ConfirmationId,
    CoordinatorEvent, DiagnosticCode, Effect, IdGenerator, IntentEnvelope, IntentId, IntentOutcome,
    JsonStateStore, OpaqueProviderMapping, OperationId, OperationToken, PortError, PortErrorCode,
    ProviderEvent, ProviderEventEnvelope, ProviderEventId, ReplayWire, ResourceInspection,
    RuntimeHealth, SettingsDiagnosticsWire, SettingsErrorWire, SettingsLogLevelWire,
    SettingsPreviousExitWire, SettingsRuntimeHealthValueWire, SettingsRuntimeHealthWire,
    SettingsSaveRequestWire, SettingsSnapshotWire, SettingsSocketChangeRequestWire, SurfaceKey,
    SurfaceResolution, TerminalTarget, UserIntent, WorkspaceCleanupResult, WorkspaceId,
    WorkspacePickerEventWire, SETTINGS_SEQUENCE_MAX,
};
use raw_window_handle::HasWindowHandle;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder};

pub mod agent;
mod diagnostics;
pub mod discovery;
pub mod editor;
mod integration;
mod keyboard;
mod repository;
mod runtime;
mod terminal;
mod workspace_resolver;
use agent::{AgentSurfaceManager, HerdrAgentRuntime};
use diagnostics::{
    Code as LogCode, DiagnosticEvent, Diagnostics, DiagnosticsOwner, Health as DiagnosticHealth,
    LifecyclePhase, Module as DiagnosticModule, PerformanceMarker,
    PreviousExit as DiagnosticPreviousExit, ShutdownOutcome,
};
use discovery::DiscoveryEngine;
use editor::{
    BridgeEvent, BridgeEventSink, BridgeRequest, BridgeRequestDisposition, BridgeRequestResult,
};
use editor::{EditorHost, EditorHostConfig};
use editor::{NativeFocusIdentity, NavigationRequest, NavigationRouter, WryWebViewHost};
use integration::lifecycle::{safe_restore_frame, DisplayWorkArea, LifecycleGate, Phase};
use keyboard::{HostCommand, KeyStroke, KeyboardController, RouteDecision, SurfaceFocus};
use repository::{GitRepositoryResolver, GitRepositoryResolverConfig};
use runtime::{LoginEnvironmentStatus, RuntimeLaunchContext};
use terminal::{
    validate_attach_request, validate_attachment_id, validate_input_sequence, validate_schema,
    validate_surface_key, AckRequest, AttachReceipt, AttachRequest, AttachmentIdentity,
    DetachRequest, InputRequest, ResizeRequest, TerminalError, TerminalErrorCode, TerminalPtySize,
    TmuxTerminalRuntime,
};
use workspace_resolver::MacWorkspacePathResolver;

pub const APP_SNAPSHOT_CHANGED_EVENT: &str = "app://snapshot-changed";
pub const APP_APPEARANCE_CHANGED_EVENT: &str = "app://appearance-changed";
pub const APP_AGENT_PROFILES_CHANGED_EVENT: &str = "app://agent-profiles-changed";
pub const APP_WORKSPACE_PICKER_EVENT: &str = "app://workspace-picker";
pub const APP_SHELL_WINDOW_LABEL: &str = "app-shell";
pub const SETTINGS_CHANGED_EVENT: &str = "settings://changed";
pub const SETTINGS_WINDOW_LABEL: &str = "settings";
pub const OPEN_SETTINGS_MENU_ID: &str = "open-settings";
pub const OPEN_SETTINGS_WINDOW_COMMAND: &str = "open_settings_window";
const CLOSE_WINDOW_MENU_ID: &str = "close-window";
const QUIT_MENU_ID: &str = "quit-devhub";
const MAX_EFFECT_STEPS: usize = 1_024;
const FOLDER_CHOOSER_SCRIPT: &str =
    "POSIX path of (choose folder with prompt \"Open Workspace Folder\")";

fn bridge_request_failed_result() -> BridgeRequestResult {
    BridgeRequestResult::Error {
        code: devhub_app_core::bridge::ErrorCode::RequestFailed,
        summary: devhub_app_core::bridge::ContentFreeSummary::Failed,
    }
}

fn folder_chooser_status(
    status: std::process::ExitStatus,
    stderr: &[u8],
) -> Result<bool, AppErrorWire> {
    if status.success() {
        return Ok(true);
    }
    // osascript reports AppleScript's user-cancelled error (-128) as a
    // process failure; only that explicit status is a normal cancellation.
    if stderr.windows(5).any(|window| window == b"-128)") {
        Ok(false)
    } else {
        Err(AppErrorWire::native_unavailable())
    }
}

struct NativeBridgeSink {
    router: Mutex<Option<BridgeRouter>>,
    observations: Mutex<BTreeMap<String, BridgeObservation>>,
    failed_requests: Mutex<VecDeque<(String, u64, String)>>,
    performance_diagnostics: Mutex<Option<Diagnostics>>,
    performance_ready_surfaces: Mutex<BTreeSet<String>>,
}

type BridgeRouter = Arc<dyn Fn(BridgeRequest) + Send + Sync>;

#[derive(Clone)]
struct BridgeObservation {
    generation: u64,
    connected: bool,
    readiness: devhub_app_core::bridge::Readiness,
    context: Option<devhub_app_core::bridge::Context>,
    dirty: bool,
}

impl Default for NativeBridgeSink {
    fn default() -> Self {
        Self {
            router: Mutex::new(None),
            observations: Mutex::new(BTreeMap::new()),
            failed_requests: Mutex::new(VecDeque::new()),
            performance_diagnostics: Mutex::new(None),
            performance_ready_surfaces: Mutex::new(BTreeSet::new()),
        }
    }
}

impl NativeBridgeSink {
    fn enable_performance_markers(&self, diagnostics: Diagnostics) {
        if let Ok(mut slot) = self.performance_diagnostics.lock() {
            *slot = Some(diagnostics);
        }
    }

    fn recheck_health(&self) -> bool {
        self.observations.lock().ok().is_some_and(|observations| {
            observations.values().any(|observation| observation.connected)
        })
    }

    fn editor_observation(&self, workspace_id: &WorkspaceId) -> Option<BridgeObservation> {
        let observations = self.observations.lock().ok()?;
        observations.values().find(|observation| {
            matches!(observation.context.as_ref(), Some(devhub_app_core::bridge::Context::Workspace { workspace_id: id, .. }) if id.as_str() == workspace_id.as_str())
        }).cloned()
    }

    fn request_is_live(&self, request: &BridgeRequest) -> bool {
        let Ok(observations) = self.observations.lock() else { return false };
        let live =
            observations.get(request.handle().surface_id().as_str()).is_some_and(|observation| {
                observation.connected
                    && observation.generation == request.handle().connection_generation()
            });
        drop(observations);
        let Ok(failed) = self.failed_requests.lock() else { return false };
        live && !failed.iter().any(|key| {
            key == &(
                request.handle().surface_id().as_str().to_owned(),
                request.handle().connection_generation(),
                request.handle().request_message_id().as_str().to_owned(),
            )
        })
    }
}

impl NativeBridgeSink {
    fn install_router<F>(&self, router: F)
    where
        F: Fn(BridgeRequest) + Send + Sync + 'static,
    {
        if let Ok(mut slot) = self.router.lock() {
            *slot = Some(Arc::new(router));
        }
    }

    /// Drops the only sender held by the bridge route closure. The route
    /// worker's receive loop then exits instead of surviving app quit with a
    /// detached listener thread.
    fn clear_router(&self) {
        if let Ok(mut slot) = self.router.lock() {
            slot.take();
        }
    }
}

impl BridgeEventSink for NativeBridgeSink {
    fn on_event(&self, event: BridgeEvent) {
        let ready_surface = match &event {
            BridgeEvent::Snapshot { surface_id, readiness, .. }
                if *readiness == devhub_app_core::bridge::Readiness::Ready =>
            {
                Some(surface_id.as_str().to_owned())
            }
            BridgeEvent::ReadinessChanged { surface_id, readiness, .. }
                if *readiness == devhub_app_core::bridge::Readiness::Ready =>
            {
                Some(surface_id.as_str().to_owned())
            }
            _ => None,
        };
        let (surface_id, generation) = match &event {
            BridgeEvent::Connected { surface_id, generation }
            | BridgeEvent::Disconnected { surface_id, generation }
            | BridgeEvent::Snapshot { surface_id, generation, .. }
            | BridgeEvent::ReadinessChanged { surface_id, generation, .. }
            | BridgeEvent::IdentityChanged { surface_id, generation, .. }
            | BridgeEvent::DirtyChanged { surface_id, generation, .. } => (surface_id, *generation),
            BridgeEvent::RequestFailed { handle, .. } => {
                if let Ok(mut failed) = self.failed_requests.lock() {
                    let key = (
                        handle.surface_id().as_str().to_owned(),
                        handle.connection_generation(),
                        handle.request_message_id().as_str().to_owned(),
                    );
                    if let Some(position) = failed.iter().position(|entry| entry == &key) {
                        failed.remove(position);
                    }
                    failed.push_back(key);
                    while failed.len() > 256 {
                        failed.pop_front();
                    }
                }
                return;
            }
        };
        let Ok(mut observations) = self.observations.lock() else { return };
        let entry = observations.entry(surface_id.as_str().to_owned()).or_insert_with(|| {
            BridgeObservation {
                generation,
                connected: false,
                readiness: devhub_app_core::bridge::Readiness::Unavailable,
                context: None,
                dirty: false,
            }
        });
        if generation < entry.generation {
            return;
        }
        entry.generation = generation;
        match event {
            BridgeEvent::Connected { .. } => entry.connected = true,
            BridgeEvent::Disconnected { .. } => entry.connected = false,
            BridgeEvent::Snapshot { readiness, context, dirty, .. } => {
                entry.connected = true;
                entry.readiness = readiness;
                entry.context = Some(context);
                entry.dirty = dirty;
            }
            BridgeEvent::ReadinessChanged { readiness, .. } => entry.readiness = readiness,
            BridgeEvent::IdentityChanged { context, .. } => entry.context = Some(context),
            BridgeEvent::DirtyChanged { dirty, .. } => entry.dirty = dirty,
            BridgeEvent::RequestFailed { .. } => {}
        }
        drop(observations);
        if let Some(surface_id) = ready_surface {
            let first_ready = self
                .performance_ready_surfaces
                .lock()
                .map(|mut surfaces| surfaces.insert(surface_id))
                .unwrap_or(false);
            if first_ready {
                if let Ok(diagnostics) = self.performance_diagnostics.lock() {
                    if let Some(diagnostics) = diagnostics.as_ref() {
                        let _ = diagnostics.emit(DiagnosticEvent::Performance {
                            marker: PerformanceMarker::EditorBridgeReady,
                        });
                    }
                }
            }
        }
    }

    fn on_request(&self, request: &BridgeRequest) -> BridgeRequestDisposition {
        match request.request() {
            devhub_app_core::bridge::ClientRequest::OpenWorkspace(_)
            | devhub_app_core::bridge::ClientRequest::NewWindow(_) => {
                if let Ok(router) = self.router.lock() {
                    if let Some(router) = router.as_ref() {
                        router(request.clone());
                        return BridgeRequestDisposition::Pending;
                    }
                }
                BridgeRequestDisposition::Immediate(BridgeRequestResult::Error {
                    code: devhub_app_core::bridge::ErrorCode::SurfaceUnavailable,
                    summary: devhub_app_core::bridge::ContentFreeSummary::Failed,
                })
            }
            devhub_app_core::bridge::ClientRequest::RequestStateSnapshot(_) => {
                BridgeRequestDisposition::Immediate(BridgeRequestResult::SnapshotWillFollow)
            }
            devhub_app_core::bridge::ClientRequest::Focus(_) => {
                BridgeRequestDisposition::Immediate(BridgeRequestResult::Focused)
            }
        }
    }
}

/// Navigation adapter for raw Editor child WebViews. It is deliberately
/// App-Shell-only: folder requests become Rust-owned intents and external
/// links are handed to the user's default browser without exposing Tauri IPC
/// to the child WebView.
#[derive(Clone)]
struct NativeNavigationRouter {
    app: AppHandle,
    window_identity: NativeWindowIdentity,
}

impl NativeNavigationRouter {
    fn is_current_open(&self, state: &NativeAppState) -> bool {
        state.lifecycle.phase() == Phase::Open
            && state.is_current_native_identity(self.window_identity)
    }
}

impl NavigationRouter for NativeNavigationRouter {
    fn route_workspace(
        &self,
        _surface: &str,
        request: &NavigationRequest,
    ) -> editor::EditorResult<()> {
        let NavigationRequest::Workspace { absolute_path } = request else {
            return Err(editor::EditorError::new(editor::EditorErrorCode::NavigationDenied));
        };
        let Some(state) = self.app.try_state::<NativeAppState>() else {
            return Err(editor::EditorError::new(editor::EditorErrorCode::LifecycleConflict));
        };
        let lifecycle = state
            .capture_open_lifecycle_token()
            .map_err(|_| editor::EditorError::new(editor::EditorErrorCode::LifecycleConflict))?;
        let path = devhub_app_core::RequestedPath::new(absolute_path.to_string_lossy().to_string())
            .map_err(|_| editor::EditorError::new(editor::EditorErrorCode::NavigationDenied))?;
        let app = self.app.clone();
        let window_identity = self.window_identity;
        // WRY invokes navigation handlers on the AppKit thread. Dispatch the
        // Rust intent away from that thread because an Editor surface switch
        // may synchronously create/hide another raw child WebView.
        tauri::async_runtime::spawn_blocking(move || {
            let Some(state) = app.try_state::<NativeAppState>() else { return };
            if !state.is_current_native_identity(window_identity)
                || state.lifecycle.phase() != Phase::Open
            {
                return;
            }
            match state.dispatch_intent_with_lifecycle(UserIntent::OpenFolder { path }, lifecycle) {
                Ok((outcome, changed)) if changed => {
                    let _ = app.emit_to(
                        APP_SHELL_WINDOW_LABEL,
                        APP_SNAPSHOT_CHANGED_EVENT,
                        outcome.snapshot(),
                    );
                }
                Ok(_) => {}
                Err(error) => state.record_native_error(error),
            }
        });
        Ok(())
    }

    fn open_external(&self, request: &NavigationRequest) -> editor::EditorResult<()> {
        let NavigationRequest::External { url } = request else {
            return Err(editor::EditorError::new(editor::EditorErrorCode::NavigationDenied));
        };
        let Some(state) = self.app.try_state::<NativeAppState>() else {
            return Err(editor::EditorError::new(editor::EditorErrorCode::LifecycleConflict));
        };
        if !self.is_current_open(&state) {
            return Err(editor::EditorError::new(editor::EditorErrorCode::LifecycleConflict));
        }
        let app = self.app.clone();
        let window_identity = self.window_identity;
        let url = url.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let Some(state) = app.try_state::<NativeAppState>() else { return };
            if !state.is_current_native_identity(window_identity)
                || state.lifecycle.phase() != Phase::Open
            {
                return;
            }
            let status = ProcessCommand::new("open").arg(url).status();
            if status.as_ref().is_err() || !status.map(|status| status.success()).unwrap_or(false) {
                state.record_native_error(AppErrorWire::native_unavailable());
            }
        });
        Ok(())
    }
}

struct PickerSink {
    app: AppHandle,
    query: String,
    last_sequence: AtomicU64,
    lifecycle: NativeLifecycleToken,
}

impl PickerSink {
    fn next_sequence(&self) -> u64 {
        self.last_sequence.fetch_add(1, Ordering::AcqRel).saturating_add(1)
    }

    fn observe_sequence(&self, sequence: u64) {
        let _ = self.last_sequence.fetch_max(sequence, Ordering::AcqRel);
    }

    fn is_current(&self) -> bool {
        self.app
            .try_state::<NativeAppState>()
            .is_some_and(|state| state.validate_app_lifecycle_token(self.lifecycle).is_ok())
    }
}

impl WorkspaceDiscoverySink for PickerSink {
    fn emit(&self, event: WorkspaceDiscoveryEvent) {
        // Discovery can finish after its App Shell has been detached. A
        // generation check prevents those provider callbacks from appearing
        // in a newly reconstructed picker with the same Window label.
        if !self.is_current() {
            return;
        }
        self.observe_sequence(event.sequence);
        match event.kind {
            WorkspaceDiscoveryEventKind::Candidate { candidate, projection, .. } => {
                let Some(matched) = discovery::fuzzy_match(&self.query, &projection) else {
                    return;
                };
                let Some(path) = candidate.selected_path.as_path().to_str() else { return };
                let payload = WorkspacePickerEventWire::Candidate {
                    operation_id: event.operation_id.to_string(),
                    sequence: event.sequence,
                    label: projection.label,
                    search_text: projection.search_text,
                    path: path.to_owned(),
                    score: matched.score,
                };
                let _ =
                    self.app.emit_to(APP_SHELL_WINDOW_LABEL, APP_WORKSPACE_PICKER_EVENT, payload);
            }
            WorkspaceDiscoveryEventKind::SourceError { source_id, code, count } => {
                let _ = self.app.emit_to(
                    APP_SHELL_WINDOW_LABEL,
                    APP_WORKSPACE_PICKER_EVENT,
                    WorkspacePickerEventWire::SourceError {
                        operation_id: event.operation_id.to_string(),
                        sequence: event.sequence,
                        source_id,
                        error_count: count,
                        truncated: matches!(code, devhub_app_core::ports::WorkspaceDiscoveryErrorCode::OutputLimit | devhub_app_core::ports::WorkspaceDiscoveryErrorCode::CandidateLimit),
                    },
                );
            }
            WorkspaceDiscoveryEventKind::SourceCompleted {
                source_id,
                candidate_count,
                error_count,
                stderr_bytes,
            } => {
                let _ = self.app.emit_to(
                    APP_SHELL_WINDOW_LABEL,
                    APP_WORKSPACE_PICKER_EVENT,
                    WorkspacePickerEventWire::SourceCompleted {
                        operation_id: event.operation_id.to_string(),
                        sequence: event.sequence,
                        source_id,
                        candidate_count,
                        error_count,
                        stderr_bytes,
                    },
                );
            }
            WorkspaceDiscoveryEventKind::Cancelled { source_id } => {
                let _ = self.app.emit_to(
                    APP_SHELL_WINDOW_LABEL,
                    APP_WORKSPACE_PICKER_EVENT,
                    WorkspacePickerEventWire::Cancelled {
                        operation_id: event.operation_id.to_string(),
                        sequence: event.sequence,
                        source_id,
                    },
                );
            }
        }
    }
}

struct NativeIdGenerator;

impl NativeIdGenerator {
    fn read_operation_id(&self) -> Result<OperationId, AppErrorWire> {
        let mut bytes = [0_u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .map_err(|_| AppErrorWire::native_unavailable())?;
        // UUID v4: version 4 and RFC 4122 variant bits.
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let raw = format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            u32::from_be_bytes(
                bytes[0..4].try_into().map_err(|_| AppErrorWire::native_unavailable())?
            ),
            u16::from_be_bytes(
                bytes[4..6].try_into().map_err(|_| AppErrorWire::native_unavailable())?
            ),
            u16::from_be_bytes(
                bytes[6..8].try_into().map_err(|_| AppErrorWire::native_unavailable())?
            ),
            u16::from_be_bytes(
                bytes[8..10].try_into().map_err(|_| AppErrorWire::native_unavailable())?
            ),
            u64::from_be_bytes([
                0, 0, bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
            ]),
        );
        OperationId::from_uuid(raw).map_err(|_| AppErrorWire::native_unavailable())
    }

    fn next_intent_id(&self) -> Result<IntentId, AppErrorWire> {
        <Self as IdGenerator>::next_intent_id(self).map_err(|_| AppErrorWire::native_unavailable())
    }
}

impl IdGenerator for NativeIdGenerator {
    fn next_operation_id(&self) -> Result<OperationId, PortError> {
        self.read_operation_id().map_err(|_| PortError::new(PortErrorCode::Unavailable))
    }
}

struct PersistenceState {
    persisted_revision: u64,
}

/// A native worker handle with an explicit completion bit. `JoinHandle::join`
/// has no timeout; the lifecycle lane polls this bit and drops a still-busy
/// handle at the quit deadline so an unresponsive provider reader cannot hang
/// process exit forever. The worker itself observes its stop flag and exits
/// without owning any provider resource.
struct ManagedThread {
    handle: std::thread::JoinHandle<()>,
    done: Arc<AtomicBool>,
}

fn join_managed_thread(thread: ManagedThread, deadline: Instant) -> bool {
    while !thread.done.load(Ordering::Acquire) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    if !thread.done.load(Ordering::Acquire) {
        // Dropping the handle detaches only this app-local worker. Its stop
        // flag was already set by the caller; no Herdr Agent or tmux session
        // is owned by this join path.
        drop(thread.handle);
        return false;
    }
    thread.handle.join().is_ok()
}

struct SettingsProjection {
    loaded: LoadedConfig,
    sequence: u64,
    diagnostic: Option<devhub_app_core::SettingsDiagnosticWire>,
}

#[derive(Clone, Copy, Debug)]
struct RuntimeHealthProbe {
    shell: SettingsRuntimeHealthValueWire,
    git: SettingsRuntimeHealthValueWire,
    tmux: SettingsRuntimeHealthValueWire,
    herdr: SettingsRuntimeHealthValueWire,
    editor: bool,
    bridge: bool,
    diagnostics: DiagnosticHealth,
}

impl RuntimeHealthProbe {
    fn all_available(self) -> bool {
        self.shell == SettingsRuntimeHealthValueWire::Healthy
            && self.git == SettingsRuntimeHealthValueWire::Healthy
            && self.tmux == SettingsRuntimeHealthValueWire::Healthy
            && self.herdr == SettingsRuntimeHealthValueWire::Healthy
            && self.editor
            && self.bridge
            && matches!(self.diagnostics, DiagnosticHealth::Healthy)
    }
}

struct NativeAppState {
    coordinator: Mutex<AppCoordinator>,
    /// Serializes lifecycle generation changes/coordinator replacement with
    /// every coordinator mutation. A lifecycle token is only meaningful while
    /// this gate is held; checking it before taking `coordinator` alone would
    /// let an old worker pass, then mutate a newly reopened coordinator.
    coordinator_transaction: Mutex<()>,
    /// The one process/window ownership gate. Closing a Window moves this to
    /// `Closed`; it never tears down provider runtimes. Reopen is the only
    /// transition that reconstructs the native host.
    lifecycle: LifecycleGate,
    store: JsonStateStore,
    config_store: ConfigStore,
    settings: Mutex<SettingsProjection>,
    runtime_health_probe: Mutex<Option<RuntimeHealthProbe>>,
    diagnostics: Diagnostics,
    _diagnostics_owner: DiagnosticsOwner,
    performance_markers_enabled: bool,
    config_watcher: Mutex<Option<devhub_app_core::config::ConfigWatcher>>,
    /// A valid external config edit observed during a confirmed transition.
    /// It is intentionally kept outside `settings.loaded` until the durable
    /// transition reaches Stable, so the Settings projection remains the
    /// last-good value and the ConfigStore revision can be reconciled later.
    deferred_config: Mutex<Option<LoadedConfig>>,
    startup_runtime_config: RuntimeConfig,
    startup_import_login_environment: bool,
    persistence: Mutex<PersistenceState>,
    state_commit: Mutex<()>,
    pending_native_error: Mutex<Option<AppErrorWire>>,
    socket_transition_busy: AtomicBool,
    id_generator: NativeIdGenerator,
    _runtime_context: RuntimeLaunchContext,
    _workspace_discovery: DiscoveryEngine,
    _repository_resolver: GitRepositoryResolver,
    _terminal_runtime: TmuxTerminalRuntime,
    _workspace_resolver: MacWorkspacePathResolver,
    agent_runtime: HerdrAgentRuntime,
    agent_surfaces: AgentSurfaceManager,
    editor_host: EditorHost,
    editor_bounds: Mutex<editor::EditorBounds>,
    profiles: Mutex<Vec<DomainAgentProfile>>,
    /// Opaque mappings are kept in native memory until the StateStore/core
    /// projection commits them. They never enter the App Shell wire DTO.
    agent_mappings: Mutex<BTreeMap<devhub_app_core::AgentId, OpaqueProviderMapping>>,
    agent_reconciler_running: AtomicBool,
    bridge_sink: Arc<NativeBridgeSink>,
    picker_cancel: Mutex<Option<CancellationToken>>,
    bridge_router_handle: Mutex<Option<ManagedThread>>,
    agent_reconciler_handle: Mutex<Option<ManagedThread>>,
    /// Suppresses geometry events generated by applying the persisted frame;
    /// otherwise the native default frame can race the restore and overwrite
    /// the durable position before reconstruction has finished.
    frame_restore_running: AtomicBool,
    /// Generation currently owning the coalesced frame writer. A late writer
    /// from the previous Window must not clear scheduling state for a newly
    /// reopened Window.
    frame_persist_generation: AtomicU64,
    frame_persist_ticket: AtomicU64,
    frame_persist_scheduled: AtomicBool,
    frame_persist_dirty: AtomicBool,
    frame_persist_workers: AtomicU64,
    frame_persist_error: Mutex<Option<AppErrorWire>>,
    /// The raw native handle identifies a concrete AppKit Window instance;
    /// labels are intentionally insufficient because a late Destroyed event
    /// from the prior instance can arrive after Dock created its replacement.
    native_window_identity: Mutex<Option<NativeWindowIdentity>>,
    /// Serializes startup/Dock host reconstruction even when macOS delivers
    /// duplicate reopen notifications before the first WRY mount finishes.
    reconstruction_running: AtomicBool,
    reconstruction_result: Mutex<Option<Result<(), AppErrorWire>>>,
    /// Covers the whole Dock activation, including stable-label Window
    /// creation. Reopen events can arrive concurrently before Tauri registers
    /// the newly built Window, so guarding only the raw host mount is too late.
    dock_reopen_running: AtomicBool,
    dock_reopen_result: Mutex<Option<Result<(), AppErrorWire>>>,
    /// ExitRequested is delivered again by `app.exit` on some Tauri/Wry
    /// versions. These flags make that allowance explicit and single-flight.
    quit_requested: AtomicBool,
    exit_allowed: AtomicBool,
    close_allowance: Mutex<Option<NativeWindowIdentity>>,
    closing_window: Mutex<Option<NativeWindowIdentity>>,
    /// Snapshot captured before a guarded WindowClosed transaction. The
    /// native close is still reversible until AppKit delivers Destroyed, so a
    /// failed persist/close can restore the coordinator without touching the
    /// provider-owned projections.
    close_rollback_snapshot: Mutex<Option<AppSnapshot>>,
    /// Owns cleanup for the concrete Window generation. Both a guarded close
    /// worker and an unguarded Destroyed path reserve this token; Dock reopen
    /// waits for it before mounting a replacement, so an old detach cannot
    /// remove the replacement's fresh terminal/Agent channels.
    window_cleanup: Mutex<Option<WindowCleanupToken>>,
    window_cleanup_wake: Condvar,
    keyboard: KeyboardController,
    /// Native identity of the App Shell WKWebView. Agent, Terminal, and
    /// Global Terminal activities share this responder; their semantic
    /// SurfaceKey remains distinct in `SurfaceFocus`.
    app_shell_focus: Mutex<Option<NativeFocusIdentity>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct NativeWindowIdentity {
    handle_key: u64,
    lifecycle_generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowCleanupToken {
    handle_key: u64,
    lifecycle_generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct NativeLifecycleToken {
    generation: u64,
    window_identity: Option<NativeWindowIdentity>,
}

struct BridgeRoute {
    request: BridgeRequest,
    lifecycle: NativeLifecycleToken,
}

struct EffectExecution {
    snapshot: AppSnapshot,
    outcome: Option<IntentOutcome>,
    error: Option<AppErrorWire>,
    persistence_degraded: bool,
}

struct SocketTransitionGate<'a> {
    busy: &'a AtomicBool,
}

impl Drop for SocketTransitionGate<'_> {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::Release);
    }
}

fn state_error(error: impl std::fmt::Display) -> AppErrorWire {
    let _ = error;
    AppErrorWire::native_unavailable()
}

fn persistence_error(error: impl std::fmt::Display) -> AppErrorWire {
    let _ = error;
    AppErrorWire::persistence_degraded()
}

/// Claims a process-level single-flight transition. The native event loop may
/// deliver duplicate ExitRequested notifications while the first shutdown is
/// still being persisted; only the owner that flips this bit may run quit.
fn claim_single_flight(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
}

/// Tauri emits `ExitRequested { code: None }` when the last native Window is
/// closed on macOS. That is a Window-surface transition, not an explicit app
/// quit: keep the process alive so Dock activation can reconstruct it. Only a
/// concrete exit code (menu/app exit or an OS quit request) may enter the
/// process-owned shutdown path.
fn is_explicit_exit_request(code: Option<i32>) -> bool {
    code.is_some()
}

fn settings_error(error: devhub_app_core::config::ConfigError) -> SettingsErrorWire {
    SettingsErrorWire::from_config(error)
}

/// Returns a process-local identity for one concrete native Window. Tauri's
/// public Window equality intentionally uses only the stable label, so it
/// cannot distinguish an old `app-shell` instance from a newly reopened one.
fn native_window_handle_key(window: &tauri::Window<tauri::Wry>) -> Option<u64> {
    let handle = window.window_handle().ok()?.as_raw();
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    handle.hash(&mut hasher);
    Some(hasher.finish())
}

fn frame_persist_owner_matches(
    current_generation: u64,
    current_ticket: u64,
    worker_generation: u64,
    worker_ticket: u64,
) -> bool {
    current_generation == worker_generation && current_ticket == worker_ticket
}

fn frame_persist_phase_allowed(phase: Phase) -> bool {
    matches!(phase, Phase::Open | Phase::Closing | Phase::Quitting)
}

fn native_identity_matches(
    current: Option<NativeWindowIdentity>,
    expected: NativeWindowIdentity,
    lifecycle_generation: u64,
) -> bool {
    lifecycle_generation == expected.lifecycle_generation && current == Some(expected)
}

/// Settings snapshots contain user profiles and environment values. They are
/// therefore routed only to the settings webview and never broadcast through
/// the application event bus.
fn emit_settings_snapshot(app: &AppHandle, snapshot: SettingsSnapshotWire) {
    if let Err(error) = app.emit_to(SETTINGS_WINDOW_LABEL, SETTINGS_CHANGED_EVENT, snapshot) {
        let _ = error;
        if let Some(state) = app.try_state::<NativeAppState>() {
            state.record_native_error(AppErrorWire::native_unavailable());
        }
    }
}

/// The Workbench receives only this small, secret-free appearance projection.
/// Agent env values, workspace sources, and Settings revisions never cross
/// this event boundary.
fn emit_app_appearance(app: &AppHandle, state: &NativeAppState) {
    match state.app_appearance() {
        Ok(appearance) => {
            if let Err(error) =
                app.emit_to(APP_SHELL_WINDOW_LABEL, APP_APPEARANCE_CHANGED_EVENT, appearance)
            {
                let _ = error;
                state.record_native_error(AppErrorWire::native_unavailable());
            }
        }
        Err(error) => {
            let _ = error;
            state.record_native_error(AppErrorWire::native_unavailable());
        }
    }
}

fn emit_agent_profiles(app: &AppHandle, state: &NativeAppState) {
    match state.agent_profiles() {
        Ok(profiles) => {
            if let Err(error) =
                app.emit_to(APP_SHELL_WINDOW_LABEL, APP_AGENT_PROFILES_CHANGED_EVENT, profiles)
            {
                let _ = error;
                state.record_native_error(AppErrorWire::native_unavailable());
            }
        }
        Err(error) => state.record_native_error(error),
    }
}

impl NativeAppState {
    fn record_performance_marker(&self, marker: PerformanceMarker) -> Result<(), AppErrorWire> {
        self.capture_open_lifecycle_token()?;
        if self.performance_markers_enabled
            && !self.diagnostics.emit(DiagnosticEvent::Performance { marker })
        {
            return Err(AppErrorWire::native_unavailable()
                .with_summary("performance marker could not be recorded"));
        }
        Ok(())
    }

    fn bind_native_window(&self, window: &tauri::Window<tauri::Wry>) {
        let identity = native_window_handle_key(window).map(|handle_key| NativeWindowIdentity {
            handle_key,
            lifecycle_generation: self.lifecycle.generation(),
        });
        if let Ok(mut current) = self.native_window_identity.lock() {
            *current = identity;
        }
        if let Ok(mut focus) = self.app_shell_focus.lock() {
            *focus = None;
        }
    }

    #[cfg(target_os = "macos")]
    fn capture_app_shell_focus(
        &self,
        app: &AppHandle,
        window: &tauri::WebviewWindow<tauri::Wry>,
        identity: NativeWindowIdentity,
    ) {
        let callback_app = app.clone();
        let _ = window.with_webview(move |webview| {
            let native_id = webview.inner() as usize;
            let native_window = webview.ns_window() as usize;
            let Some(state) = callback_app.try_state::<NativeAppState>() else { return };
            let current = state.native_window_identity.lock().ok().and_then(|value| *value);
            if current != Some(identity)
                || state.lifecycle.generation() != identity.lifecycle_generation
            {
                return;
            }
            if let Ok(mut focus) = state.app_shell_focus.lock() {
                *focus = Some(NativeFocusIdentity {
                    responder_root: native_id,
                    window: native_window,
                    // Tauri exposes the native NSWindow identity but not a
                    // safe windowNumber accessor. The AppKit monitor supplies
                    // the number on each event after this identity matches.
                    window_number: 0,
                });
            };
        });
    }

    fn native_window_identity(
        &self,
        window: &tauri::Window<tauri::Wry>,
    ) -> Option<NativeWindowIdentity> {
        let handle_key = native_window_handle_key(window)?;
        self.native_window_identity.lock().ok()?.as_ref().copied().filter(|identity| {
            identity.handle_key == handle_key
                && identity.lifecycle_generation == self.lifecycle.generation()
        })
    }

    fn is_current_native_window(&self, window: &tauri::Window<tauri::Wry>) -> bool {
        self.native_window_identity(window).is_some()
    }

    fn is_current_native_identity(&self, identity: NativeWindowIdentity) -> bool {
        native_identity_matches(
            self.native_window_identity.lock().ok().and_then(|current| *current),
            identity,
            self.lifecycle.generation(),
        )
    }

    fn capture_lifecycle_token(&self) -> NativeLifecycleToken {
        NativeLifecycleToken {
            generation: self.lifecycle.generation(),
            window_identity: self.native_window_identity.lock().ok().and_then(|current| *current),
        }
    }

    fn begin_close_transaction(&self) -> bool {
        self.coordinator_transaction.lock().ok().is_some_and(|_| self.lifecycle.begin_close())
    }

    fn finish_close_transaction(&self) {
        if let Ok(_transaction) = self.coordinator_transaction.lock() {
            self.lifecycle.finish_close();
        }
    }

    fn abort_close_transaction(&self) {
        if let Ok(_transaction) = self.coordinator_transaction.lock() {
            self.lifecycle.abort_close();
        }
    }

    fn abort_reopen_transaction(&self) {
        if let Ok(_transaction) = self.coordinator_transaction.lock() {
            self.lifecycle.abort_reopen();
        }
    }

    fn mark_unexpected_destroyed_transaction(&self) {
        if let Ok(_transaction) = self.coordinator_transaction.lock() {
            self.lifecycle.mark_unexpected_destroyed();
        }
    }

    fn begin_quit_transaction(&self) -> bool {
        self.coordinator_transaction.lock().ok().is_some_and(|_| self.lifecycle.begin_quit())
    }

    fn force_quit_after_close_timeout_transaction(&self) -> bool {
        self.coordinator_transaction
            .lock()
            .ok()
            .is_some_and(|_| self.lifecycle.force_quit_after_close_timeout())
    }

    fn finish_quit_transaction(&self) {
        if let Ok(_transaction) = self.coordinator_transaction.lock() {
            self.lifecycle.finish_quit();
        }
    }

    fn lifecycle_token_is_open(&self, token: NativeLifecycleToken) -> bool {
        self.lifecycle.phase() == Phase::Open
            && self.lifecycle.generation() == token.generation
            && token
                .window_identity
                .is_none_or(|identity| self.is_current_native_identity(identity))
    }

    fn require_lifecycle_token(&self, token: NativeLifecycleToken) -> Result<(), TerminalError> {
        if self.lifecycle_token_is_open(token) {
            Ok(())
        } else {
            Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable))
        }
    }

    fn require_app_lifecycle_token(&self, token: NativeLifecycleToken) -> Result<(), AppErrorWire> {
        if self.lifecycle_token_is_open(token) {
            Ok(())
        } else {
            Err(AppErrorWire::native_unavailable()
                .with_summary("stale App Shell lifecycle generation"))
        }
    }

    /// Captures an App Shell token at the same transaction boundary used by
    /// coordinator access. A caller must not read the phase/generation first
    /// and then acquire the coordinator gate: close/reopen could otherwise
    /// swap the projection between those two operations.
    fn capture_open_lifecycle_token(&self) -> Result<NativeLifecycleToken, AppErrorWire> {
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.capture_open_lifecycle_token_locked()
    }

    /// Same capture as [`Self::capture_open_lifecycle_token`] for callers
    /// that already own the coordinator transaction gate.
    fn capture_open_lifecycle_token_locked(&self) -> Result<NativeLifecycleToken, AppErrorWire> {
        let token = self.capture_lifecycle_token();
        self.require_app_lifecycle_token(token)?;
        Ok(token)
    }

    fn validate_app_lifecycle_token(
        &self,
        token: NativeLifecycleToken,
    ) -> Result<(), AppErrorWire> {
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_app_lifecycle_token(token)
    }

    fn validate_terminal_lifecycle_token(
        &self,
        token: NativeLifecycleToken,
    ) -> Result<(), TerminalError> {
        let _transaction = self
            .coordinator_transaction
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        self.require_lifecycle_token(token)
    }

    fn require_settings_lifecycle_token(
        &self,
        token: NativeLifecycleToken,
    ) -> Result<(), SettingsErrorWire> {
        if self.lifecycle_token_is_open(token) {
            Ok(())
        } else {
            Err(SettingsErrorWire::native_unavailable())
        }
    }

    fn capture_settings_lifecycle_token(&self) -> Result<NativeLifecycleToken, SettingsErrorWire> {
        self.capture_open_lifecycle_token().map_err(|_| SettingsErrorWire::native_unavailable())
    }

    fn validate_settings_lifecycle_token(
        &self,
        token: NativeLifecycleToken,
    ) -> Result<(), SettingsErrorWire> {
        let _transaction = self
            .coordinator_transaction
            .lock()
            .map_err(|_| SettingsErrorWire::native_unavailable())?;
        self.require_settings_lifecycle_token(token)
    }

    fn app_snapshot_with_lifecycle(
        &self,
        token: NativeLifecycleToken,
    ) -> Result<AppSnapshotWire, AppErrorWire> {
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_app_lifecycle_token(token)?;
        let coordinator = self.coordinator.lock().map_err(state_error)?;
        AppSnapshotWire::from_snapshot(&coordinator.snapshot(), coordinator.readiness())
            .map_err(state_error)
    }

    fn replay_with_lifecycle(
        &self,
        token: NativeLifecycleToken,
        cursor: u64,
    ) -> Result<ReplayWire, AppErrorWire> {
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_app_lifecycle_token(token)?;
        let coordinator = self.coordinator.lock().map_err(state_error)?;
        ReplayWire::from_replay(&coordinator.replay_from(cursor), coordinator.readiness())
            .map_err(state_error)
    }

    fn agent_profiles_with_lifecycle(
        &self,
        token: NativeLifecycleToken,
    ) -> Result<AgentProfilesWire, AppErrorWire> {
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_app_lifecycle_token(token)?;
        self.agent_profiles()
    }

    fn app_appearance_with_lifecycle(
        &self,
        token: NativeLifecycleToken,
    ) -> Result<AppAppearanceWire, SettingsErrorWire> {
        let _transaction = self
            .coordinator_transaction
            .lock()
            .map_err(|_| SettingsErrorWire::native_unavailable())?;
        self.require_settings_lifecycle_token(token)?;
        self.app_appearance()
    }

    fn settings_snapshot_with_lifecycle(
        &self,
        token: NativeLifecycleToken,
    ) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
        {
            let _transaction = self
                .coordinator_transaction
                .lock()
                .map_err(|_| SettingsErrorWire::native_unavailable())?;
            self.require_settings_lifecycle_token(token)?;
        }
        let snapshot = self.settings_snapshot()?;
        let _transaction = self
            .coordinator_transaction
            .lock()
            .map_err(|_| SettingsErrorWire::native_unavailable())?;
        self.require_settings_lifecycle_token(token)?;
        Ok(snapshot)
    }

    fn require_lifecycle_transaction_token(
        &self,
        token: Option<NativeLifecycleToken>,
    ) -> Result<(), AppErrorWire> {
        match token {
            Some(token) => self.require_app_lifecycle_token(token),
            None => Ok(()),
        }
    }

    fn require_provider_event_transaction_token(
        &self,
        token: Option<NativeLifecycleToken>,
    ) -> Result<(), AppErrorWire> {
        match token {
            Some(token) => self.require_app_lifecycle_token(token),
            None if self.lifecycle.phase() == Phase::Open => Ok(()),
            None => Err(AppErrorWire::native_unavailable()
                .with_summary("stale provider event after Window reconstruction")),
        }
    }

    fn clear_native_window_if_current(&self, window: &tauri::Window<tauri::Wry>) {
        let Some(identity) = self.native_window_identity(window) else { return };
        if let Ok(mut current) = self.native_window_identity.lock() {
            if current.as_ref().is_some_and(|current| *current == identity) {
                *current = None;
                if let Ok(mut focus) = self.app_shell_focus.lock() {
                    *focus = None;
                }
            }
        }
    }

    fn set_close_allowance(&self, identity: NativeWindowIdentity) {
        if let Ok(mut allowance) = self.close_allowance.lock() {
            *allowance = Some(identity);
        }
    }

    /// The allowance belongs to the concrete Window until its Destroyed
    /// event. A duplicate CloseRequested must observe the same one-shot
    /// native close permission without consuming it before Destroyed arrives.
    fn close_allowance_matches(&self, window: &tauri::Window<tauri::Wry>) -> bool {
        let Some(identity) = self.native_window_identity(window) else { return false };
        self.close_allowance.lock().ok().and_then(|allowance| *allowance) == Some(identity)
    }

    fn require_close_cleanup_token(
        &self,
        token: Option<WindowCleanupToken>,
    ) -> Result<(), AppErrorWire> {
        if self.lifecycle.phase() != Phase::Closing {
            return Err(
                AppErrorWire::native_unavailable().with_summary("stale Window close lifecycle")
            );
        }
        if let Some(token) = token {
            let current =
                self.native_window_identity.lock().map_err(state_error)?.as_ref().copied();
            if current
                != Some(NativeWindowIdentity {
                    handle_key: token.handle_key,
                    lifecycle_generation: token.lifecycle_generation,
                })
            {
                return Err(AppErrorWire::native_unavailable()
                    .with_summary("stale native Window close identity"));
            }
            if self.lifecycle.generation() != token.lifecycle_generation {
                return Err(AppErrorWire::native_unavailable()
                    .with_summary("stale native Window close generation"));
            }
        }
        Ok(())
    }

    fn capture_close_rollback_snapshot(&self) -> Result<(), AppErrorWire> {
        let snapshot = self.current_snapshot()?;
        *self.close_rollback_snapshot.lock().map_err(state_error)? = Some(snapshot);
        Ok(())
    }

    fn clear_close_rollback_snapshot(&self) {
        if let Ok(mut snapshot) = self.close_rollback_snapshot.lock() {
            snapshot.take();
        }
    }

    /// Restores only the Rust-owned projection after a reversible close
    /// failure. WindowClosed detachment is deliberately deferred until the
    /// concrete native Window has emitted Destroyed, so this path never needs
    /// to guess how to reattach a half-detached terminal/Agent channel.
    fn restore_failed_close(&self) -> Result<(), AppErrorWire> {
        let snapshot = self.close_rollback_snapshot.lock().map_err(state_error)?.take();
        if let Some(snapshot) = snapshot {
            self.persist_snapshot(&snapshot, true)?;
            self.rehydrate_coordinator_from_store()?;
        }
        Ok(())
    }

    fn begin_window_cleanup(&self, token: WindowCleanupToken) -> bool {
        let Ok(mut cleanup) = self.window_cleanup.lock() else { return false };
        if cleanup.is_some() {
            return false;
        }
        *cleanup = Some(token);
        true
    }

    fn finish_window_cleanup(&self, token: WindowCleanupToken) {
        if let Ok(mut cleanup) = self.window_cleanup.lock() {
            if cleanup.as_ref().is_some_and(|current| *current == token) {
                *cleanup = None;
                self.window_cleanup_wake.notify_all();
            }
        }
    }

    fn wait_for_window_cleanup(&self, deadline: Instant) -> bool {
        let Ok(mut cleanup) = self.window_cleanup.lock() else { return false };
        while cleanup.is_some() && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let Ok((next, _)) = self.window_cleanup_wake.wait_timeout(cleanup, remaining) else {
                return false;
            };
            cleanup = next;
        }
        cleanup.is_none()
    }

    fn window_cleanup_is_current(&self, token: WindowCleanupToken) -> bool {
        self.window_cleanup
            .lock()
            .ok()
            .and_then(|cleanup| *cleanup)
            .is_some_and(|current| current == token)
    }

    fn start_window_projection_cleanup(&self, app: &AppHandle, token: WindowCleanupToken) {
        let worker_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(state) = worker_app.try_state::<NativeAppState>() {
                let deadline = Instant::now() + Duration::from_secs(5);
                if state.window_cleanup_is_current(token) {
                    if let Err(error) = state.editor_host.detach_webview_host() {
                        state.record_native_error(state_error(error));
                    }
                    if !state._terminal_runtime.detach_all_surfaces_until(deadline) {
                        state.record_native_error(
                            AppErrorWire::native_unavailable()
                                .with_summary("terminal projection cleanup exceeded deadline"),
                        );
                    }
                    if !state.agent_surfaces.detach_all_until(deadline) {
                        state.record_native_error(
                            AppErrorWire::native_unavailable()
                                .with_summary("Agent projection cleanup exceeded deadline"),
                        );
                    }
                }
                state.finish_window_cleanup(token);
            }
        });
    }

    fn bootstrap(home: &Path) -> Result<Self, AppErrorWire> {
        let store = JsonStateStore::for_home(home);
        let previous_exit = store
            .load_or_default()
            .ok()
            .map(|state| {
                if state.shutdown.clean {
                    DiagnosticPreviousExit::Clean
                } else {
                    DiagnosticPreviousExit::Unclean
                }
            })
            .unwrap_or(DiagnosticPreviousExit::Unknown);
        let mut persisted = store.mark_starting().map_err(persistence_error)?;
        let diagnostics = Diagnostics::open(
            home,
            env!("CARGO_PKG_VERSION"),
            match previous_exit {
                DiagnosticPreviousExit::Clean => Some(true),
                DiagnosticPreviousExit::Unclean => Some(false),
                DiagnosticPreviousExit::Unknown => None,
            },
        );
        let performance_markers_enabled = std::env::var_os("DEVHUB_Q5_PERFORMANCE").is_some();
        // Schema-version facts are typed even when no migration is needed;
        // this makes startup provenance observable without exposing config or
        // state contents.
        diagnostics.emit(DiagnosticEvent::Migration {
            module: DiagnosticModule::Config,
            from: 1,
            to: 1,
        });
        diagnostics.emit(DiagnosticEvent::Migration {
            module: DiagnosticModule::State,
            from: 1,
            to: 1,
        });
        // Reconcile roots before hydrating the model. This makes a relaunch
        // deterministic: a previously available workspace whose root has
        // disappeared is immediately actionable as Unavailable, while an
        // in-flight close remains owned by its durable cleanup record.
        let mut startup_reconciled = false;
        for workspace in &mut persisted.workspaces {
            if matches!(workspace.lifecycle, WorkspaceLifecycleRecord::Available)
                && !Path::new(&workspace.canonical_path).is_dir()
            {
                workspace.lifecycle = WorkspaceLifecycleRecord::Unavailable {
                    reason: PersistedDiagnosticCode::RootMissing,
                };
                startup_reconciled = true;
            }
        }
        if startup_reconciled {
            store.save_state(&persisted).map_err(persistence_error)?;
        }
        let config_store = ConfigStore::new(default_config_path(home));
        let loaded_config = config_store.load().map_err(state_error)?;
        let runtime_context = RuntimeLaunchContext::from_startup(
            home,
            loaded_config.config().general.import_login_environment,
            &loaded_config.config().runtimes.shell,
        )
        .map_err(state_error)?;
        let startup_runtime_config = loaded_config.config().runtimes.clone();
        let startup_import_login_environment =
            loaded_config.config().general.import_login_environment;
        let repository_resolver =
            match runtime_context.resolve(&loaded_config.config().runtimes.git) {
                Ok(git_executable) => GitRepositoryResolver::new(GitRepositoryResolverConfig::new(
                    runtime_context.clone(),
                    git_executable,
                )),
                Err(_) => GitRepositoryResolver::new(GitRepositoryResolverConfig::unavailable(
                    runtime_context.clone(),
                )),
            };
        let workspace_discovery =
            DiscoveryEngine::with_runtime_context(loaded_config.config(), runtime_context.clone());
        let terminal_runtime = TmuxTerminalRuntime::new(
            runtime_context.clone(),
            runtime_context.resolve(&loaded_config.config().runtimes.tmux).ok(),
            runtime_context.resolve(&loaded_config.config().runtimes.shell).ok(),
            loaded_config.config().runtimes.tmux_args.clone(),
            persisted.tmux.effective_socket_name.clone(),
        );
        let profiles = load_config_profiles(loaded_config.config())?;
        let restored_agent_mappings = persisted
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.agents.iter())
            .filter_map(|agent| {
                let id = devhub_app_core::AgentId::from_uuid(agent.agent_id.clone()).ok()?;
                Some((id, agent.provider_mapping.clone()?))
            })
            .collect::<BTreeMap<_, _>>();
        let agent_journal =
            store.path().parent().unwrap_or(home).join("agent-runtime-journal.json");
        let agent_runtime = HerdrAgentRuntime::from_environment_with_journal(
            home,
            &startup_runtime_config.herdr,
            agent_journal,
        )
        .map_err(|_| AppErrorWire::native_unavailable())?;
        let bridge_sink = Arc::new(NativeBridgeSink::default());
        if performance_markers_enabled {
            bridge_sink.enable_performance_markers(diagnostics.clone());
        }
        let editor_host = EditorHost::new(
            EditorHostConfig::new(home, None).with_bridge_event_sink(bridge_sink.clone()),
        );
        let model = persisted.hydrate_model(&profiles).map_err(persistence_error)?;
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.mark_ready();
        let persisted_revision = coordinator.snapshot().revision();
        Ok(Self {
            coordinator: Mutex::new(coordinator),
            coordinator_transaction: Mutex::new(()),
            lifecycle: LifecycleGate::new(),
            store,
            config_store,
            settings: Mutex::new(SettingsProjection {
                loaded: loaded_config,
                sequence: 1,
                diagnostic: None,
            }),
            runtime_health_probe: Mutex::new(None),
            _diagnostics_owner: DiagnosticsOwner::new(diagnostics.clone()),
            diagnostics,
            performance_markers_enabled,
            config_watcher: Mutex::new(None),
            deferred_config: Mutex::new(None),
            startup_runtime_config,
            startup_import_login_environment,
            persistence: Mutex::new(PersistenceState { persisted_revision }),
            state_commit: Mutex::new(()),
            pending_native_error: Mutex::new(None),
            socket_transition_busy: AtomicBool::new(false),
            id_generator: NativeIdGenerator,
            _runtime_context: runtime_context,
            _workspace_discovery: workspace_discovery,
            _repository_resolver: repository_resolver,
            _terminal_runtime: terminal_runtime,
            _workspace_resolver: MacWorkspacePathResolver::new(home),
            agent_runtime,
            agent_surfaces: AgentSurfaceManager::new(),
            editor_host,
            editor_bounds: Mutex::new(editor::EditorBounds::new(0.0, 0.0, 900.0, 560.0)),
            profiles: Mutex::new(profiles),
            agent_mappings: Mutex::new(restored_agent_mappings),
            agent_reconciler_running: AtomicBool::new(true),
            bridge_sink,
            picker_cancel: Mutex::new(None),
            bridge_router_handle: Mutex::new(None),
            agent_reconciler_handle: Mutex::new(None),
            frame_restore_running: AtomicBool::new(false),
            frame_persist_generation: AtomicU64::new(0),
            frame_persist_ticket: AtomicU64::new(0),
            frame_persist_scheduled: AtomicBool::new(false),
            frame_persist_dirty: AtomicBool::new(false),
            frame_persist_workers: AtomicU64::new(0),
            frame_persist_error: Mutex::new(None),
            native_window_identity: Mutex::new(None),
            reconstruction_running: AtomicBool::new(false),
            reconstruction_result: Mutex::new(None),
            dock_reopen_running: AtomicBool::new(false),
            dock_reopen_result: Mutex::new(None),
            quit_requested: AtomicBool::new(false),
            exit_allowed: AtomicBool::new(false),
            close_allowance: Mutex::new(None),
            closing_window: Mutex::new(None),
            close_rollback_snapshot: Mutex::new(None),
            window_cleanup: Mutex::new(None),
            window_cleanup_wake: Condvar::new(),
            keyboard: KeyboardController::default(),
            app_shell_focus: Mutex::new(None),
        })
    }

    #[cfg(target_os = "macos")]
    fn install_keyboard_monitor(&self, app: &AppHandle) -> Result<(), &'static str> {
        let callback_app = app.clone();
        self.keyboard.install(move |event| {
            let Some(state) = callback_app.try_state::<NativeAppState>() else {
                return wry::NativeKeyEventResult::Pass;
            };
            state.route_native_key(&callback_app, event)
        })
    }

    #[cfg(target_os = "macos")]
    fn route_native_key(
        &self,
        app: &AppHandle,
        event: wry::NativeKeyEvent,
    ) -> wry::NativeKeyEventResult {
        // Hold the same transaction gate as close/reopen and coordinator
        // replacement through the routing decision. A lifecycle transition
        // cannot swap the active surface between the generation read and the
        // original native event being returned to AppKit.
        let Ok(_transaction) = self.coordinator_transaction.lock() else {
            return wry::NativeKeyEventResult::Pass;
        };
        if self.lifecycle.phase() != Phase::Open {
            return wry::NativeKeyEventResult::Pass;
        }
        let Some(main) = app.get_webview_window(APP_SHELL_WINDOW_LABEL) else {
            return wry::NativeKeyEventResult::Pass;
        };
        if !main.is_focused().unwrap_or(false) {
            // Settings retains its own native menu policy, including Cmd-W.
            return wry::NativeKeyEventResult::Pass;
        }
        let generation = self.lifecycle.generation();
        let focus = self.current_keyboard_focus(event.window_identity(), event.window_number());
        let decision = self.keyboard.route(
            focus,
            KeyStroke {
                key_code: event.key_code(),
                command: event.command(),
                shift: event.shift(),
                option: event.option(),
                control: event.control(),
                is_repeat: event.is_repeat(),
            },
            Instant::now(),
        );
        match decision {
            RouteDecision::PrefixArmed { .. } => wry::NativeKeyEventResult::Consume,
            RouteDecision::Consume => wry::NativeKeyEventResult::Consume,
            RouteDecision::ForwardNativeQ { target, focus } => {
                // The router's target is meaningful here: it is the semantic
                // destination captured with the first prefix. Forward only
                // when the same destination still owns the same AppKit
                // responder and lifecycle generation. Returning the original
                // NSEvent is safe only after all three identities match.
                let current =
                    self.current_keyboard_focus(event.window_identity(), event.window_number());
                if target == focus.semantic
                    && focus.generation == generation
                    && focus.matches_native(
                        event.responder_belongs_to(focus.native_id),
                        event.window_identity(),
                        event.window_number(),
                        generation,
                    )
                    && current.as_ref() == Some(&focus)
                {
                    wry::NativeKeyEventResult::Forward
                } else {
                    wry::NativeKeyEventResult::Consume
                }
            }
            RouteDecision::Route(HostCommand::OpenSettings) => {
                if show_settings_window(app).is_err() {
                    self.record_native_error(AppErrorWire::native_unavailable());
                }
                wry::NativeKeyEventResult::Consume
            }
            RouteDecision::Pass { .. } => wry::NativeKeyEventResult::Pass,
        }
    }

    fn current_keyboard_focus(
        &self,
        event_window_identity: usize,
        event_window_number: isize,
    ) -> Option<SurfaceFocus> {
        let snapshot = self.coordinator.lock().ok()?.snapshot().clone();
        let SurfaceResolution::Enabled(key) =
            snapshot.activity(snapshot.active_activity()).resolution()
        else {
            return None;
        };
        let generation = self.lifecycle.generation();
        let identity = match key {
            SurfaceKey::GlobalEditor | SurfaceKey::WorkspaceEditor(_) => {
                self.editor_host.active_native_focus_identity()?
            }
            SurfaceKey::GlobalTerminal
            | SurfaceKey::WorkspaceTerminal(_)
            | SurfaceKey::Agent(_) => {
                let binding = self.app_shell_focus.lock().ok()?.as_ref().copied()?;
                if binding.window == 0
                    || binding.window != event_window_identity
                    || event_window_number == 0
                {
                    return None;
                }
                NativeFocusIdentity { window_number: event_window_number, ..binding }
            }
        };
        Some(SurfaceFocus {
            semantic: key.clone(),
            native_id: identity.responder_root,
            window_identity: identity.window,
            window_number: identity.window_number,
            generation,
        })
    }

    /// Attach the raw child-WebView host to the current main Window and
    /// reconstruct every durable Editor surface. Provider terminal/Agent
    /// surfaces remain lazy and are attached only by their visible frontend
    /// viewport.
    fn reconstruct_window(&self, app: &AppHandle) -> Result<(), AppErrorWire> {
        let generation = self.lifecycle.generation();
        let mut result = if self.lifecycle.phase() == Phase::Open {
            self.reconstruct_window_inner(app)
        } else {
            Err(AppErrorWire::native_unavailable()
                .with_summary("window reconstruction raced process shutdown"))
        };
        if result.is_ok()
            && (self.lifecycle.phase() != Phase::Open || self.lifecycle.generation() != generation)
        {
            result = Err(AppErrorWire::native_unavailable()
                .with_summary("window reconstruction became stale"));
        }
        if result.is_err() {
            // A failed mount must leave the host detached. Otherwise a
            // partially mounted WRY host would make the next Dock activation
            // look like a successful reconstruction and suppress the retry.
            // Keep OpenVSCode running: only its child surfaces are rolled
            // back, and the next attempt can reuse its hot-exit state.
            if let Err(error) = self.editor_host.detach_webview_host() {
                self.record_native_error(state_error(error));
            }
        }
        if result.is_ok() {
            self.diagnostics.emit(DiagnosticEvent::Lifecycle { phase: LifecyclePhase::Ready });
            if self.performance_markers_enabled {
                let _ = self.diagnostics.emit(DiagnosticEvent::Performance {
                    marker: PerformanceMarker::WindowReconstructionReady,
                });
            }
        }
        result
    }

    fn wait_for_reconstruction(&self, deadline: Instant) -> bool {
        while self.reconstruction_running.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        !self.reconstruction_running.load(Ordering::Acquire)
    }

    fn wait_for_frame_persist(&self, deadline: Instant) -> bool {
        while self.frame_persist_workers.load(Ordering::Acquire) != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        self.frame_persist_workers.load(Ordering::Acquire) == 0
    }

    fn clear_frame_persist_error(&self) {
        if let Ok(mut error) = self.frame_persist_error.lock() {
            *error = None;
        }
    }

    fn take_frame_persist_error(&self) -> Option<AppErrorWire> {
        self.frame_persist_error.lock().ok().and_then(|mut error| error.take())
    }

    fn reconstruct_window_inner(&self, app: &AppHandle) -> Result<(), AppErrorWire> {
        let lifecycle = self.capture_open_lifecycle_token()?;
        let window = app
            .get_webview_window(APP_SHELL_WINDOW_LABEL)
            .ok_or_else(AppErrorWire::native_unavailable)?;
        let parent = window.as_ref().window();
        self.bind_native_window(&parent);
        let window_identity =
            self.native_window_identity(&parent).ok_or_else(AppErrorWire::native_unavailable)?;
        self.capture_app_shell_focus(app, &window, window_identity);
        self.restore_window_frame(&parent)?;
        // A failed Dock reconstruction is retryable, but a successful retry
        // must never stack a second raw WRY host or child-WebView registry on
        // top of the first one.
        self.editor_host.detach_webview_host().map_err(state_error)?;
        let router: Arc<dyn NavigationRouter> =
            Arc::new(NativeNavigationRouter { app: app.clone(), window_identity });
        self.editor_host
            .attach_webview_host(Arc::new(WryWebViewHost::new(parent.clone(), router)))
            .map_err(state_error)?;

        let size = parent.inner_size().map_err(|_| AppErrorWire::native_unavailable())?;
        let bounds = editor::EditorBounds::new(
            0.0,
            0.0,
            f64::from(size.width.max(1)),
            f64::from(size.height.max(1)),
        );
        *self.editor_bounds.lock().map_err(state_error)? = bounds;
        let snapshot = self.current_snapshot_with_lifecycle(lifecycle)?;
        // Global Editor is a fixed singleton. Available Workspace Editors are
        // keyed by persisted Workspace ID; an unavailable root remains a
        // durable sidebar row but has no child WebView to mount.
        let mut mount_error =
            self.editor_host.ensure_surface(editor::EditorSurfaceKey::Global, None, bounds).err();
        for workspace in snapshot.workspaces() {
            if workspace.state().is_available() {
                if let Err(error) = self.editor_host.ensure_surface(
                    editor::EditorSurfaceKey::Workspace(workspace.id().to_string()),
                    Some(workspace.root().as_path().to_path_buf()),
                    bounds,
                ) {
                    mount_error.get_or_insert(error);
                }
            }
        }
        if let Some(error) = mount_error {
            return Err(state_error(error));
        }

        // `ensure_surface` selects its argument for visibility. Mounting all
        // records above therefore ends with the last workspace visible; apply
        // the Rust-owned Activity/Context selection as the final visibility
        // decision.
        self.editor_host.hide_surfaces().map_err(state_error)?;
        if snapshot.active_activity() == Activity::Editor {
            let selected = match snapshot.selected_context() {
                devhub_app_core::NavigationContext::Global => {
                    Some(editor::EditorSurfaceKey::Global)
                }
                devhub_app_core::NavigationContext::Workspace(id) => snapshot
                    .workspaces()
                    .iter()
                    .find(|workspace| workspace.id() == id && workspace.state().is_available())
                    .map(|_| editor::EditorSurfaceKey::Workspace(id.to_string())),
                devhub_app_core::NavigationContext::Agent(agent_id) => {
                    snapshot.workspaces().iter().find_map(|workspace| {
                        (workspace.state().is_available()
                            && workspace.agents().iter().any(|agent| agent.id() == agent_id))
                        .then(|| editor::EditorSurfaceKey::Workspace(workspace.id().to_string()))
                    })
                }
            };
            if let Some(selected) = selected {
                let root = match &selected {
                    editor::EditorSurfaceKey::Global => None,
                    editor::EditorSurfaceKey::Workspace(id) => snapshot
                        .workspaces()
                        .iter()
                        .find(|workspace| workspace.id().to_string() == *id)
                        .filter(|workspace| workspace.state().is_available())
                        .map(|workspace| workspace.root().as_path().to_path_buf()),
                };
                if matches!(&selected, editor::EditorSurfaceKey::Global) || root.is_some() {
                    self.editor_host.ensure_surface(selected, root, bounds).map_err(state_error)?;
                }
            }
        }
        Ok(())
    }

    fn reconstruct_window_once(&self, app: &AppHandle) -> Result<(), AppErrorWire> {
        if self
            .reconstruction_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            // The first reconstruction owns the same Window generation. A
            // duplicate Dock event must wait for that owner before showing
            // or focusing the Window; returning early would expose a shell
            // whose raw children are only partially mounted.
            if !self.wait_for_reconstruction(Instant::now() + Duration::from_secs(5)) {
                return Err(AppErrorWire::native_unavailable()
                    .with_summary("window reconstruction did not finish before Dock activation"));
            }
            return self
                .reconstruction_result
                .lock()
                .ok()
                .and_then(|result| result.clone())
                .unwrap_or_else(|| {
                    Err(AppErrorWire::native_unavailable()
                        .with_summary("window reconstruction result was unavailable"))
                });
        }
        if let Ok(mut result) = self.reconstruction_result.lock() {
            *result = None;
        }
        let result = self.reconstruct_window(app);
        if let Ok(mut completed) = self.reconstruction_result.lock() {
            *completed = Some(result.clone());
        }
        self.reconstruction_running.store(false, Ordering::Release);
        result
    }

    /// Keeps raw Editor child visibility in lockstep with the Rust-owned
    /// Activity/Context selection. The App Shell still renders typed
    /// unavailable states underneath a missing OpenVSCode host; a provider
    /// failure never deletes the durable projection.
    fn sync_editor_surface_with_lifecycle(
        &self,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(), AppErrorWire> {
        let snapshot = self.current_snapshot_with_lifecycle(lifecycle)?;
        self.sync_editor_surface_for_snapshot(&snapshot);
        Ok(())
    }

    fn sync_editor_surface_for_snapshot(&self, snapshot: &AppSnapshot) {
        if snapshot.active_activity() != Activity::Editor {
            let _ = self.editor_host.hide_surfaces();
            return;
        }
        let selected = match snapshot.selected_context() {
            devhub_app_core::NavigationContext::Global => {
                Some((editor::EditorSurfaceKey::Global, None))
            }
            devhub_app_core::NavigationContext::Workspace(id) => snapshot
                .workspaces()
                .iter()
                .find(|workspace| workspace.id() == id && workspace.state().is_available())
                .map(|workspace| {
                    (
                        editor::EditorSurfaceKey::Workspace(id.to_string()),
                        Some(workspace.root().as_path().to_path_buf()),
                    )
                }),
            devhub_app_core::NavigationContext::Agent(agent_id) => snapshot
                .workspaces()
                .iter()
                .find(|workspace| {
                    workspace.state().is_available()
                        && workspace.agents().iter().any(|agent| agent.id() == agent_id)
                })
                .map(|workspace| {
                    (
                        editor::EditorSurfaceKey::Workspace(workspace.id().to_string()),
                        Some(workspace.root().as_path().to_path_buf()),
                    )
                }),
        };
        let Some((key, root)) = selected else {
            let _ = self.editor_host.hide_surfaces();
            return;
        };
        let bounds = self
            .editor_bounds
            .lock()
            .map(|bounds| *bounds)
            .unwrap_or_else(|_| editor::EditorBounds::new(0.0, 0.0, 900.0, 560.0));
        let _ = self.editor_host.ensure_surface(key, root, bounds);
    }

    /// The existing startup Window is already constructed by Tauri's config.
    /// Reuse it and run the same reconstruction path used by Dock activation.
    fn attach_startup_window(&self, app: &AppHandle) {
        match self.reconstruct_window_once(app) {
            Ok(()) => {
                if let Some(window) = app.get_webview_window(APP_SHELL_WINDOW_LABEL) {
                    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
                        self.record_native_error(state_error(error));
                    }
                }
            }
            Err(error) => {
                // Missing OpenVSCode resources are a typed degraded Activity,
                // not a reason to discard the durable shell snapshot or stop
                // Agents. Keep the startup shell hidden until a Dock retry
                // reconstructs its child surfaces successfully.
                self.record_native_error(error);
            }
        }
    }

    /// Installs the native AgentRuntime reconciliation loop once for the
    /// process. It owns startup reattachment and continues to consume the
    /// provider subscription/invalidation seam even when no Agent Surface is
    /// mounted, so Sidebar status and natural exits do not depend on view
    /// attachment.
    fn start_agent_reconciler(&self, app: &AppHandle) {
        if self
            .agent_reconciler_handle
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|_| ()))
            .is_some()
        {
            return;
        }
        let worker_app = app.clone();
        let done = Arc::new(AtomicBool::new(false));
        let worker_done = done.clone();
        let handle = std::thread::Builder::new().name("devhub-agent-reconciler".to_owned()).spawn(
            move || {
                let mut restored = false;
                while let Some(state) = worker_app.try_state::<NativeAppState>() {
                    if !state.agent_reconciler_running.load(Ordering::Acquire) {
                        break;
                    }
                    if !restored {
                        state.bootstrap_agent_runtime();
                        state.restore_agents_for_runtime(&worker_app);
                        restored = true;
                    }
                    state.reconcile_agents_background(&worker_app);
                    std::thread::sleep(Duration::from_millis(300));
                }
                worker_done.store(true, Ordering::Release);
            },
        );
        if let Ok(handle) = handle {
            if let Ok(mut slot) = self.agent_reconciler_handle.lock() {
                *slot = Some(ManagedThread { handle, done });
            }
        }
    }

    fn bootstrap_agent_runtime(&self) {
        let Ok(operation_id) = self.id_generator.next_operation_id() else { return };
        // Bootstrap on the native worker even when no Agent Surface is
        // mounted (or no Agent exists yet). This installs the provider
        // invalidation subscription once at startup and leaves the runtime's
        // typed health available for the first launch/reconciliation attempt;
        // a provider outage is degraded state, not an app-shell bootstrap
        // failure.
        let _ = tauri::async_runtime::block_on(
            self.agent_runtime.bootstrap(CancellationToken::new(operation_id)),
        );
    }

    fn restore_agents_for_runtime(&self, app: &AppHandle) {
        let Ok(lifecycle) = self.capture_open_lifecycle_token() else { return };
        let Ok(snapshot) = self.current_snapshot_with_lifecycle(lifecycle) else { return };
        for workspace in snapshot.workspaces() {
            for agent in workspace.agents() {
                let _ = self.agent_runtime.register_agent_workspace(
                    agent.id().clone(),
                    workspace.id().clone(),
                    workspace.root().clone(),
                );
            }
        }
        let mappings =
            self.agent_mappings.lock().ok().map(|mappings| mappings.clone()).unwrap_or_default();
        for (agent_id, mapping) in mappings {
            let attached_agent_id = agent_id.clone();
            let operation_id = match self.id_generator.next_operation_id() {
                Ok(operation_id) => operation_id,
                Err(_) => continue,
            };
            let result = tauri::async_runtime::block_on(self.agent_runtime.attach(
                agent_id,
                Some(mapping),
                CancellationToken::new(operation_id),
            ));
            match result {
                Ok(observation) => {
                    self.apply_agent_observation_if_current(app, observation, lifecycle)
                }
                Err(_) => self.mark_agent_runtime_failure_if_current(
                    app,
                    attached_agent_id,
                    match self.agent_runtime.health().runtime_health() {
                        RuntimeHealth::Healthy | RuntimeHealth::Starting => RuntimeHealth::Degraded,
                        health => health,
                    },
                    lifecycle,
                ),
            }
        }
    }

    fn reconcile_agents_background(&self, app: &AppHandle) {
        if self.lifecycle.phase() != Phase::Open {
            return;
        }
        let Ok(lifecycle) = self.capture_open_lifecycle_token() else { return };
        let lifecycle_generation = lifecycle.generation;
        let Ok(snapshot) = self.current_snapshot_with_lifecycle(lifecycle) else { return };
        if snapshot.workspaces().iter().all(|workspace| workspace.agents().is_empty()) {
            return;
        }
        let before_revision = snapshot.revision();
        let operation_id = match self.id_generator.next_operation_id() {
            Ok(operation_id) => operation_id,
            Err(_) => return,
        };
        let effects = {
            let Ok(_transaction) = self.coordinator_transaction.lock() else { return };
            if self.require_app_lifecycle_token(lifecycle).is_err() {
                return;
            }
            let Ok(mut coordinator) = self.coordinator.lock() else { return };
            match coordinator.request_agents_reconcile(operation_id) {
                Ok(_) => Self::drain_effects(&mut coordinator),
                Err(_) => return,
            }
        };
        // Provider reconciliation can block while a Window is detached. Do
        // not publish its completion into a newly reconstructed generation.
        if self.lifecycle.phase() != Phase::Open
            || self.lifecycle.generation() != lifecycle_generation
        {
            return;
        }
        let Ok(execution) = self.execute_effects_for_lifecycle(effects, lifecycle) else { return };
        if self.lifecycle.phase() != Phase::Open
            || self.lifecycle.generation() != lifecycle_generation
        {
            return;
        }
        if execution.error.is_some() {
            // A failed provider reconciliation must remain visible on each
            // existing row, but it must not be interpreted as natural exit.
            // Use the same typed degraded observation as a surface read
            // failure and let a later successful reconciliation recover it.
            let agent_ids = snapshot
                .workspaces()
                .iter()
                .flat_map(|workspace| workspace.agents().iter().map(|agent| agent.id().clone()))
                .collect::<Vec<_>>();
            let runtime_health = match self.agent_runtime.health().runtime_health() {
                RuntimeHealth::Healthy | RuntimeHealth::Starting => RuntimeHealth::Degraded,
                health => health,
            };
            for agent_id in agent_ids {
                self.mark_agent_runtime_failure_with_lifecycle(
                    app,
                    agent_id,
                    runtime_health,
                    lifecycle,
                );
            }
            return;
        }
        if execution.snapshot.revision() == before_revision {
            return;
        }
        let readiness = {
            let Ok(_transaction) = self.coordinator_transaction.lock() else { return };
            if self.require_app_lifecycle_token(lifecycle).is_err() {
                return;
            }
            self.coordinator
                .lock()
                .map(|coordinator| coordinator.readiness())
                .unwrap_or(AppReadiness::Unavailable)
        };
        let Ok(snapshot) = AppSnapshotWire::from_snapshot(&execution.snapshot, readiness) else {
            return;
        };
        let _ = app.emit_to(APP_SHELL_WINDOW_LABEL, APP_SNAPSHOT_CHANGED_EVENT, snapshot);
    }

    fn install_bridge_router(&self, app: &AppHandle) {
        if self
            .bridge_router_handle
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|_| ()))
            .is_some()
        {
            return;
        }
        let app = app.clone();
        let (sender, receiver): (SyncSender<BridgeRoute>, _) = sync_channel(64);
        let worker_app = app.clone();
        let done = Arc::new(AtomicBool::new(false));
        let worker_done = done.clone();
        let worker =
            std::thread::Builder::new().name("devhub-bridge-router".to_owned()).spawn(move || {
                while let Ok(route) = receiver.recv() {
                    let request = &route.request;
                    let Some(state) = worker_app.try_state::<NativeAppState>() else { break };
                    // A disconnect/timeout event invalidates the generation;
                    // do not run an old request's mutating coordinator intent.
                    if !state.lifecycle_token_is_open(route.lifecycle)
                        || !state.bridge_sink.request_is_live(request)
                    {
                        continue;
                    }
                    if let Err(error) = state.route_bridge_request(request, route.lifecycle) {
                        state.diagnostics.emit(DiagnosticEvent::ProviderExit {
                            component: diagnostics::Component::Bridge,
                            code: LogCode::BridgeDisconnected,
                        });
                        state.record_native_error(error);
                        if state.bridge_sink.request_is_live(request) {
                            let _ = state.editor_host.complete_bridge_request(
                                request.handle().clone(),
                                bridge_request_failed_result(),
                            );
                        }
                    }
                }
                worker_done.store(true, Ordering::Release);
            });
        if let Ok(worker) = worker {
            if let Ok(mut slot) = self.bridge_router_handle.lock() {
                *slot = Some(ManagedThread { handle: worker, done });
            }
        }
        self.bridge_sink.install_router(move |request| {
            let lifecycle = app
                .try_state::<NativeAppState>()
                .map(|state| state.capture_lifecycle_token())
                .unwrap_or(NativeLifecycleToken { generation: 0, window_identity: None });
            let Err(error) = sender.try_send(BridgeRoute { request, lifecycle }) else { return };
            let request = match error {
                TrySendError::Full(route) | TrySendError::Disconnected(route) => route.request,
            };
            if let Some(state) = app.try_state::<NativeAppState>() {
                let _ = state.editor_host.complete_bridge_request(
                    request.handle().clone(),
                    bridge_request_failed_result(),
                );
                state.record_native_error(AppErrorWire::native_unavailable());
            }
        });
    }

    fn record_native_error(&self, error: AppErrorWire) {
        if let Ok(mut pending) = self.pending_native_error.lock() {
            *pending = Some(error.clone());
        }
        self.diagnostics.emit(DiagnosticEvent::Error {
            module: DiagnosticModule::App,
            code: LogCode::NativeUnavailable,
        });
    }

    fn take_native_error(&self) -> Option<AppErrorWire> {
        self.pending_native_error.lock().ok().and_then(|mut pending| pending.take())
    }

    /// Serializes the complete load/apply/save transaction without holding the
    /// coordinator mutex. The revision guard makes an older in-flight command
    /// harmless after a newer snapshot has committed first.
    fn persist_snapshot(&self, snapshot: &AppSnapshot, force: bool) -> Result<(), AppErrorWire> {
        {
            let _commit = self.state_commit.lock().map_err(state_error)?;
            let persisted_revision =
                self.persistence.lock().map_err(state_error)?.persisted_revision;
            if !force && snapshot.revision() <= persisted_revision {
                return Ok(());
            }
            let mut state = self.store.load_or_default().map_err(persistence_error)?;
            state.apply_snapshot(snapshot).map_err(persistence_error)?;
            self.apply_agent_mappings(&mut state, snapshot).map_err(persistence_error)?;
            self.store.save_state(&state).map_err(persistence_error)?;
            let mut persistence = self.persistence.lock().map_err(state_error)?;
            persistence.persisted_revision =
                persistence.persisted_revision.max(snapshot.revision());
        }
        Ok(())
    }

    fn persist_clean_snapshot(
        &self,
        snapshot: &AppSnapshot,
        deadline: Instant,
    ) -> Result<(), AppErrorWire> {
        self.diagnostics.emit(DiagnosticEvent::Lifecycle { phase: LifecyclePhase::Quit });
        // The clean marker is part of the same commit boundary as the state
        // clean bit. If diagnostics cannot durably mark and stop, leave the
        // state unclean so the next launch reports crash recovery honestly.
        if !matches!(self.diagnostics.clean_shutdown_until(deadline), ShutdownOutcome::Complete) {
            return Err(AppErrorWire::native_unavailable()
                .with_summary("diagnostics clean marker was not durable"));
        }
        {
            let _commit = self.state_commit.lock().map_err(state_error)?;
            let mut state = self.store.load_or_default().map_err(persistence_error)?;
            state.apply_snapshot(snapshot).map_err(persistence_error)?;
            self.apply_agent_mappings(&mut state, snapshot).map_err(persistence_error)?;
            state.mark_clean_shutdown();
            self.store.save_state(&state).map_err(persistence_error)?;
        }
        let mut persistence = self.persistence.lock().map_err(state_error)?;
        persistence.persisted_revision = persistence.persisted_revision.max(snapshot.revision());
        Ok(())
    }

    fn apply_agent_mappings(
        &self,
        state: &mut devhub_app_core::PersistedAppState,
        snapshot: &AppSnapshot,
    ) -> Result<(), devhub_app_core::state::StateError> {
        let active = snapshot
            .workspaces()
            .iter()
            .flat_map(|workspace| workspace.agents().iter().map(|agent| agent.id().clone()))
            .collect::<std::collections::BTreeSet<_>>();
        let mut mappings = self.agent_mappings.lock().map_err(|_| {
            devhub_app_core::state::StateError::new(
                devhub_app_core::state::StateErrorCode::InvalidState,
            )
        })?;
        mappings.retain(|agent_id, _| active.contains(agent_id));
        for (agent_id, mapping) in mappings.iter() {
            state.set_agent_provider_mapping(agent_id, mapping.clone())?;
        }
        Ok(())
    }

    fn drain_effects(coordinator: &mut AppCoordinator) -> Vec<Effect> {
        coordinator
            .subscribe()
            .into_events()
            .into_iter()
            .filter_map(|event| match event.into_event() {
                CoordinatorEvent::Effect(effect) => Some(effect),
                _ => None,
            })
            .collect()
    }

    fn drain_effects_for_lifecycle(
        &self,
        lifecycle: Option<NativeLifecycleToken>,
    ) -> Result<Vec<Effect>, AppErrorWire> {
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_lifecycle_transaction_token(lifecycle)?;
        let mut coordinator = self.coordinator.lock().map_err(state_error)?;
        Ok(Self::drain_effects(&mut coordinator))
    }

    fn complete_persistence(
        &self,
        token: OperationToken,
        succeeded: bool,
        lifecycle: Option<NativeLifecycleToken>,
    ) -> Result<IntentOutcome, AppErrorWire> {
        let event = if succeeded {
            ProviderEvent::StatePersisted { token: token.clone() }
        } else {
            ProviderEvent::StatePersistenceFailed { token: token.clone() }
        };
        let event_id = self
            .id_generator
            .next_operation_id()
            .map(ProviderEventId::from)
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_provider_event_transaction_token(lifecycle)?;
        let mut coordinator = self.coordinator.lock().map_err(state_error)?;
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(event_id, event))
            .map_err(|error| AppErrorWire::from_error(&error))
    }

    fn complete_workspace_cleanup(
        &self,
        token: OperationToken,
        workspace_id: devhub_app_core::WorkspaceId,
        result: WorkspaceCleanupResult,
        lifecycle: Option<NativeLifecycleToken>,
    ) -> Result<IntentOutcome, AppErrorWire> {
        let event = ProviderEvent::WorkspaceCleanupCompleted { token, workspace_id, result };
        let event_id = self
            .id_generator
            .next_operation_id()
            .map(ProviderEventId::from)
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_provider_event_transaction_token(lifecycle)?;
        let mut coordinator = self.coordinator.lock().map_err(state_error)?;
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(event_id, event))
            .map_err(|error| AppErrorWire::from_error(&error))
    }

    fn accept_provider_event_with_lifecycle(
        &self,
        event: ProviderEvent,
        lifecycle: Option<NativeLifecycleToken>,
    ) -> Result<IntentOutcome, AppErrorWire> {
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_provider_event_transaction_token(lifecycle)?;
        let event_id = self
            .id_generator
            .next_operation_id()
            .map(ProviderEventId::from)
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let mut coordinator = self.coordinator.lock().map_err(state_error)?;
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(event_id, event))
            .map_err(|error| AppErrorWire::from_error(&error))
    }

    fn fail_provider_operation_with_lifecycle(
        &self,
        token: OperationToken,
        lifecycle: Option<NativeLifecycleToken>,
    ) -> Result<IntentOutcome, AppErrorWire> {
        self.accept_provider_event_with_lifecycle(
            ProviderEvent::OperationFailed { token },
            lifecycle,
        )
    }

    fn effect_cancel(token: &OperationToken) -> CancellationToken {
        CancellationToken::new(token.operation_id().clone())
    }

    fn provider_failure(error: PortError) -> AppErrorWire {
        let summary = match error.code() {
            PortErrorCode::Cancelled => "provider operation cancelled",
            PortErrorCode::Unavailable => "provider unavailable",
            PortErrorCode::Incompatible => "provider incompatible",
            PortErrorCode::TimedOut => "provider operation timed out",
            PortErrorCode::Conflict => "provider state conflict",
            PortErrorCode::Failed => "provider operation failed",
        };
        AppErrorWire::native_unavailable().with_summary(summary)
    }

    fn profile(&self, profile_id: &AgentProfileId) -> Result<DomainAgentProfile, AppErrorWire> {
        self.profiles
            .lock()
            .map_err(state_error)?
            .iter()
            .find(|profile| profile.id() == profile_id)
            .cloned()
            .ok_or_else(|| {
                AppErrorWire::native_unavailable().with_summary("agent profile unavailable")
            })
    }

    fn agent_profiles(&self) -> Result<AgentProfilesWire, AppErrorWire> {
        let (sequence, diagnostic) = {
            let settings = self.settings.lock().map_err(state_error)?;
            let diagnostic = settings.diagnostic.as_ref().map(|diagnostic| match diagnostic.code {
                devhub_app_core::SettingsDiagnosticCodeWire::Conflict => {
                    AgentProfilesDiagnosticWire::ConfigurationConflict
                }
                devhub_app_core::SettingsDiagnosticCodeWire::StateUnavailable => {
                    AgentProfilesDiagnosticWire::ProjectionUnavailable
                }
                _ => AgentProfilesDiagnosticWire::ConfigurationInvalid,
            });
            (settings.sequence, diagnostic)
        };
        let profiles = self.profiles.lock().map_err(state_error)?;
        let projection =
            AgentProfilesWire::from_profiles(&profiles, sequence).map_err(state_error)?;
        Ok(match diagnostic {
            Some(diagnostic) => projection.degraded(diagnostic),
            None => projection,
        })
    }

    fn current_snapshot(&self) -> Result<AppSnapshot, AppErrorWire> {
        self.coordinator
            .lock()
            .map(|coordinator| coordinator.snapshot().clone())
            .map_err(state_error)
    }

    fn current_snapshot_with_lifecycle(
        &self,
        lifecycle: NativeLifecycleToken,
    ) -> Result<AppSnapshot, AppErrorWire> {
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_app_lifecycle_token(lifecycle)?;
        self.coordinator
            .lock()
            .map(|coordinator| coordinator.snapshot().clone())
            .map_err(state_error)
    }

    fn snapshot_for_effect(
        &self,
        lifecycle: Option<NativeLifecycleToken>,
    ) -> Result<AppSnapshot, AppErrorWire> {
        match lifecycle {
            Some(lifecycle) => self.current_snapshot_with_lifecycle(lifecycle),
            None => self.current_snapshot(),
        }
    }

    /// Reconstructs provider cleanup from durable Closing records after a
    /// relaunch. Each workspace gets a fresh operation token and is
    /// re-inspected before any remaining destructive step is emitted.
    fn resume_persisted_closing(&self) -> Result<Option<AppSnapshot>, AppErrorWire> {
        let workspaces = self
            .current_snapshot()?
            .workspaces()
            .iter()
            .filter(|workspace| workspace.state().cleanup_progress().is_some())
            .map(|workspace| workspace.id().clone())
            .collect::<Vec<_>>();
        let had_workspaces = !workspaces.is_empty();
        for workspace_id in workspaces {
            self.diagnostics.emit(DiagnosticEvent::Retry {
                module: diagnostics::Module::State,
                code: LogCode::ProviderReconnect,
                attempt: 1,
            });
            let operation_id = self
                .id_generator
                .next_operation_id()
                .map_err(|_| AppErrorWire::native_unavailable())?;
            let effects = {
                let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
                let mut coordinator = self.coordinator.lock().map_err(state_error)?;
                coordinator
                    .resume_persisted_close(workspace_id, operation_id)
                    .map_err(|error| AppErrorWire::from_error(&error))?;
                Self::drain_effects(&mut coordinator)
            };
            if let Err(error) = self.execute_effects(effects) {
                self.diagnostics.emit(DiagnosticEvent::Retry {
                    module: diagnostics::Module::State,
                    code: LogCode::RetryLimit,
                    attempt: 1,
                });
                return Err(error);
            }
        }
        if !had_workspaces {
            Ok(None)
        } else {
            Ok(Some(self.current_snapshot()?))
        }
    }

    fn execute_effects(&self, effects: Vec<Effect>) -> Result<EffectExecution, AppErrorWire> {
        self.execute_effects_until_with_options(effects, None, None, false)
    }

    fn execute_effects_for_lifecycle(
        &self,
        effects: Vec<Effect>,
        lifecycle: NativeLifecycleToken,
    ) -> Result<EffectExecution, AppErrorWire> {
        self.execute_effects_until_with_options(effects, None, Some(lifecycle), false)
    }

    /// Runs the coordinator's WindowClosed transaction while keeping native
    /// child projections attached. The CloseRequested handler has prevented
    /// AppKit destruction; the actual terminal/Agent/WRY detach is committed
    /// by the guarded Destroyed event after the native close is irreversible.
    fn execute_effects_for_window_close(
        &self,
        effects: Vec<Effect>,
    ) -> Result<EffectExecution, AppErrorWire> {
        self.execute_effects_until_with_options(effects, None, None, true)
    }

    fn execute_effects_until(
        &self,
        effects: Vec<Effect>,
        deadline: Option<Instant>,
        lifecycle: Option<NativeLifecycleToken>,
    ) -> Result<EffectExecution, AppErrorWire> {
        self.execute_effects_until_with_options(effects, deadline, lifecycle, false)
    }

    fn execute_effects_until_with_options(
        &self,
        effects: Vec<Effect>,
        deadline: Option<Instant>,
        lifecycle: Option<NativeLifecycleToken>,
        defer_window_detach: bool,
    ) -> Result<EffectExecution, AppErrorWire> {
        let mut pending = VecDeque::from(effects);
        let mut first_error = None;
        let mut last_outcome = None;
        let mut persistence_degraded = false;
        let mut steps = 0_usize;
        while let Some(effect) = pending.pop_front() {
            steps = steps.saturating_add(1);
            if steps > MAX_EFFECT_STEPS {
                return Err(state_error("native effect worklist exceeded its bounded step limit"));
            }
            if let Some(lifecycle) = lifecycle {
                self.require_app_lifecycle_token(lifecycle)?;
            }
            match effect {
                Effect::Noop => {}
                Effect::Detach(reason) => match reason {
                    devhub_app_core::DetachReason::WindowClosed => {
                        if defer_window_detach {
                            continue;
                        }
                        self._terminal_runtime.detach_webview(APP_SHELL_WINDOW_LABEL);
                        self.agent_surfaces.detach_webview(APP_SHELL_WINDOW_LABEL);
                        // A child WebView belongs to the Window, not to the
                        // OpenVSCode process. Drop the native host as well so
                        // a later Dock reconstruction cannot retain a parent
                        // handle from the destroyed Window.
                        if let Err(error) = self.editor_host.detach_webview_host() {
                            if first_error.is_none() {
                                first_error = Some(state_error(error));
                            }
                        }
                    }
                    devhub_app_core::DetachReason::Quit => {
                        let terminal_stopped = if let Some(deadline) = deadline {
                            self._terminal_runtime.detach_all_surfaces_until(deadline)
                        } else {
                            self._terminal_runtime.detach_all_surfaces();
                            true
                        };
                        if !terminal_stopped && first_error.is_none() {
                            first_error = Some(
                                AppErrorWire::native_unavailable()
                                    .with_summary("terminal detach exceeded lifecycle deadline"),
                            );
                        }
                        let agents_stopped = if let Some(deadline) = deadline {
                            self.agent_surfaces.detach_all_until(deadline)
                        } else {
                            self.agent_surfaces.detach_all();
                            true
                        };
                        if !agents_stopped && first_error.is_none() {
                            first_error =
                                Some(AppErrorWire::native_unavailable().with_summary(
                                    "Agent Surface detach exceeded lifecycle deadline",
                                ));
                        }
                        // NativeAppState::quit_with_window explicitly owns
                        // the bounded OpenVSCode shutdown before dispatching
                        // this coordinator detach. Keep this effect limited
                        // to surface detachment so quit-after-Window-Close
                        // cannot rely on a detached coordinator and so the
                        // host is never stopped twice.
                    }
                },
                Effect::ResolveWorkspacePath { token, path } => {
                    let result = tauri::async_runtime::block_on(
                        self._workspace_resolver.resolve(path, Self::effect_cancel(&token)),
                    );
                    match result {
                        Ok(resolved) => {
                            let outcome = self.accept_provider_event_with_lifecycle(
                                ProviderEvent::WorkspacePathResolved {
                                    token,
                                    root: resolved.root,
                                    selected_path: resolved.selected_path,
                                },
                                lifecycle,
                            );
                            if let Ok(value) = &outcome {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = outcome.err();
                            }
                        }
                        Err(error) => {
                            let completion =
                                self.fail_provider_operation_with_lifecycle(token, lifecycle);
                            if first_error.is_none() {
                                first_error = completion
                                    .err()
                                    .or_else(|| Some(Self::provider_failure(error)));
                            }
                        }
                    }
                }
                Effect::GenerateWorkspaceId { token, .. } => {
                    let raw = self.id_generator.next_operation_id().map_err(|_| {
                        AppErrorWire::native_unavailable()
                            .with_summary("workspace identity unavailable")
                    });
                    match raw.and_then(|id| {
                        WorkspaceId::from_uuid(id.as_str().to_owned()).map_err(|_| {
                            AppErrorWire::native_unavailable()
                                .with_summary("workspace identity unavailable")
                        })
                    }) {
                        Ok(workspace_id) => {
                            let outcome = self.accept_provider_event_with_lifecycle(
                                ProviderEvent::WorkspaceIdGenerated { token, workspace_id },
                                lifecycle,
                            );
                            if let Ok(value) = &outcome {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = outcome.err();
                            }
                        }
                        Err(error) => {
                            let completion =
                                self.fail_provider_operation_with_lifecycle(token, lifecycle);
                            if first_error.is_none() {
                                first_error = completion.err().or(Some(error));
                            }
                        }
                    }
                }
                Effect::ResolveAgentProfile { token, workspace_id, profile_id } => {
                    match self.profile(&profile_id) {
                        Ok(profile) => {
                            let outcome = self.accept_provider_event_with_lifecycle(
                                ProviderEvent::ProfileResolved { token, workspace_id, profile },
                                lifecycle,
                            );
                            if let Ok(value) = &outcome {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = outcome.err();
                            }
                        }
                        Err(error) => {
                            let completion =
                                self.fail_provider_operation_with_lifecycle(token, lifecycle);
                            if first_error.is_none() {
                                first_error = completion.err().or(Some(error));
                            }
                        }
                    }
                }
                Effect::GenerateAgentId { token, workspace_id } => {
                    let raw = self.id_generator.next_operation_id().map_err(|_| {
                        AppErrorWire::native_unavailable()
                            .with_summary("agent identity unavailable")
                    });
                    match raw.and_then(|id| {
                        devhub_app_core::AgentId::from_uuid(id.as_str().to_owned()).map_err(|_| {
                            AppErrorWire::native_unavailable()
                                .with_summary("agent identity unavailable")
                        })
                    }) {
                        Ok(agent_id) => {
                            let outcome = self.accept_provider_event_with_lifecycle(
                                ProviderEvent::AgentIdGenerated { token, workspace_id, agent_id },
                                lifecycle,
                            );
                            if let Ok(value) = &outcome {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = outcome.err();
                            }
                        }
                        Err(error) => {
                            let completion =
                                self.fail_provider_operation_with_lifecycle(token, lifecycle);
                            if first_error.is_none() {
                                first_error = completion.err().or(Some(error));
                            }
                        }
                    }
                }
                Effect::LaunchAgent { token, workspace_id, agent_id, profile } => {
                    let root = self
                        .snapshot_for_effect(lifecycle)?
                        .workspaces()
                        .iter()
                        .find(|workspace| workspace.id() == &workspace_id)
                        .map(|workspace| workspace.root().clone());
                    let launch =
                        root.ok_or_else(AppErrorWire::native_unavailable).and_then(|root| {
                            self.agent_runtime
                                .register_agent_workspace(
                                    agent_id.clone(),
                                    workspace_id.clone(),
                                    root.clone(),
                                )
                                .map_err(Self::provider_failure)?;
                            tauri::async_runtime::block_on(self.agent_runtime.launch(
                                agent_id.clone(),
                                profile,
                                Self::effect_cancel(&token),
                            ))
                            .map_err(Self::provider_failure)
                        });
                    let result = launch.and_then(|receipt| {
                        self.agent_mappings
                            .lock()
                            .map_err(|_| AppErrorWire::native_unavailable())?
                            .insert(agent_id.clone(), receipt.provider_mapping);
                        Ok(AgentLaunchResult::Started)
                    });
                    let event = ProviderEvent::AgentLaunchCompleted {
                        token,
                        workspace_id,
                        agent_id,
                        result: result.clone().unwrap_or(AgentLaunchResult::Failed {
                            diagnostic: DiagnosticCode::RuntimeUnavailable,
                        }),
                    };
                    let completion = self.accept_provider_event_with_lifecycle(event, lifecycle);
                    if let Ok(value) = &completion {
                        last_outcome = Some(value.clone());
                    }
                    if first_error.is_none() {
                        first_error = result.err().or_else(|| completion.err());
                    }
                }
                Effect::StopAgent { token, agent_id } => {
                    let result = tauri::async_runtime::block_on(
                        self.agent_runtime.terminate(agent_id.clone(), Self::effect_cancel(&token)),
                    )
                    .map(|_| AgentStopResult::Stopped)
                    .unwrap_or(AgentStopResult::Failed {
                        diagnostic: DiagnosticCode::CleanupFailed,
                    });
                    let completion = self.accept_provider_event_with_lifecycle(
                        ProviderEvent::AgentStopCompleted { token, agent_id, result },
                        lifecycle,
                    );
                    if let Ok(value) = &completion {
                        last_outcome = Some(value.clone());
                    }
                    if first_error.is_none() {
                        first_error = completion.err();
                    }
                }
                Effect::TerminateAgent { token, agent_id } => {
                    let result = tauri::async_runtime::block_on(
                        self.agent_runtime.terminate(agent_id.clone(), Self::effect_cancel(&token)),
                    )
                    .map(|_| AgentStopResult::Stopped)
                    .unwrap_or(AgentStopResult::Failed {
                        diagnostic: DiagnosticCode::CleanupFailed,
                    });
                    let completion = self.accept_provider_event_with_lifecycle(
                        ProviderEvent::AgentTerminationCompleted { token, agent_id, result },
                        lifecycle,
                    );
                    if let Ok(value) = &completion {
                        last_outcome = Some(value.clone());
                    }
                    if first_error.is_none() {
                        first_error = completion.err();
                    }
                }
                Effect::GenerateConfirmationId { token, .. } => {
                    match ConfirmationId::from_uuid(token.operation_id().as_str().to_owned()) {
                        Ok(confirmation_id) => {
                            let completion = self.accept_provider_event_with_lifecycle(
                                ProviderEvent::ConfirmationIdGenerated { token, confirmation_id },
                                lifecycle,
                            );
                            if let Ok(value) = &completion {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = completion.err();
                            }
                        }
                        Err(_) if first_error.is_none() => {
                            first_error = self
                                .fail_provider_operation_with_lifecycle(token, lifecycle)
                                .err()
                                .or_else(|| Some(AppErrorWire::native_unavailable()));
                        }
                        Err(_) => {}
                    }
                }
                Effect::PersistState { token } => {
                    let snapshot = self.snapshot_for_effect(lifecycle)?;
                    let persistence_result = self.persist_snapshot(&snapshot, false);
                    persistence_degraded = persistence_result.is_err();
                    let completion_result =
                        self.complete_persistence(token, persistence_result.is_ok(), lifecycle);
                    if let Ok(outcome) = &completion_result {
                        // Successful persistence completes as a domain Noop;
                        // preserve the initiating Updated/Deferred outcome in
                        // that case.  A degraded completion is meaningful and
                        // must reach the command response with the latest
                        // coordinator snapshot.
                        if !matches!(outcome, IntentOutcome::Noop { .. }) {
                            last_outcome = Some(outcome.clone());
                        }
                    }
                    if first_error.is_none() {
                        first_error = completion_result.err().or_else(|| persistence_result.err());
                    }
                }
                Effect::InspectWorkspace { token, workspace_id } => {
                    let snapshot = self.snapshot_for_effect(lifecycle)?;
                    let workspace = snapshot
                        .workspaces()
                        .iter()
                        .find(|workspace| workspace.id() == &workspace_id);
                    let inspection = if let Some(workspace) = workspace {
                        let target = TerminalTarget::workspace(
                            workspace_id.clone(),
                            workspace.root().clone(),
                        );
                        let terminal = tauri::async_runtime::block_on(
                            self._terminal_runtime.inspect(target, Self::effect_cancel(&token)),
                        )
                        .unwrap_or_else(|_| {
                            devhub_app_core::ports::TerminalInspection::new(
                                ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
                                ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
                                ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
                            )
                        });
                        let owned_agent_ids = workspace
                            .agents()
                            .iter()
                            .map(|agent| agent.id().clone())
                            .collect::<std::collections::BTreeSet<_>>();
                        let agents = match tauri::async_runtime::block_on(
                            self.agent_runtime.reconcile(Self::effect_cancel(&token)),
                        ) {
                            Ok(reconciliation) => {
                                let count = reconciliation
                                    .observations()
                                    .iter()
                                    .filter(|observation| {
                                        owned_agent_ids.contains(observation.agent_id())
                                    })
                                    .count();
                                if count == 0 {
                                    ResourceInspection::clean()
                                } else {
                                    ResourceInspection::busy(
                                        u32::try_from(count).unwrap_or(u32::MAX),
                                    )
                                    .unwrap_or(
                                        ResourceInspection::unknown(
                                            DiagnosticCode::CloseAgentsUnknown,
                                        ),
                                    )
                                }
                            }
                            Err(_) => {
                                ResourceInspection::unknown(DiagnosticCode::CloseAgentsUnknown)
                            }
                        };
                        let editor = match self.editor_host.snapshot(
                            &editor::EditorSurfaceKey::Workspace(workspace_id.to_string()),
                        ) {
                            None => ResourceInspection::clean(),
                            Some(surface) if !surface.visible && !surface.mounted => {
                                ResourceInspection::clean()
                            }
                            Some(_) => match self.bridge_sink.editor_observation(&workspace_id) {
                                Some(observation)
                                    if observation.connected
                                        && observation.readiness
                                            == devhub_app_core::bridge::Readiness::Ready
                                        && observation.dirty =>
                                {
                                    ResourceInspection::busy(1).unwrap_or_else(|_| {
                                        ResourceInspection::unknown(
                                            DiagnosticCode::CloseEditorUnknown,
                                        )
                                    })
                                }
                                Some(observation)
                                    if observation.connected
                                        && observation.readiness
                                            == devhub_app_core::bridge::Readiness::Ready =>
                                {
                                    ResourceInspection::clean()
                                }
                                _ => {
                                    ResourceInspection::unknown(DiagnosticCode::CloseEditorUnknown)
                                }
                            },
                        };
                        CloseInspectionInputs::new(
                            agents,
                            terminal.process(),
                            terminal.extra_panes(),
                            terminal.extra_windows(),
                            editor,
                        )
                    } else {
                        CloseInspectionInputs::new(
                            ResourceInspection::unknown(DiagnosticCode::CloseAgentsUnknown),
                            ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
                            ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
                            ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
                            ResourceInspection::unknown(DiagnosticCode::CloseEditorUnknown),
                        )
                    };
                    let completion = self.accept_provider_event_with_lifecycle(
                        ProviderEvent::WorkspaceInspectionCompleted {
                            token,
                            workspace_id,
                            inspection,
                        },
                        lifecycle,
                    );
                    if let Ok(value) = &completion {
                        last_outcome = Some(value.clone());
                    }
                    if first_error.is_none() {
                        first_error = completion.err();
                    }
                }
                Effect::ReconcileAgents { token } => {
                    let result = tauri::async_runtime::block_on(
                        self.agent_runtime.reconcile(Self::effect_cancel(&token)),
                    );
                    if let Ok(reconciliation) = result {
                        let completion = self.accept_provider_event_with_lifecycle(
                            ProviderEvent::AgentsReconciled { token, reconciliation },
                            lifecycle,
                        );
                        if let Ok(value) = &completion {
                            last_outcome = Some(value.clone());
                        }
                        if first_error.is_none() {
                            first_error = completion.err();
                        }
                    } else if first_error.is_none() {
                        first_error = self
                            .fail_provider_operation_with_lifecycle(token, lifecycle)
                            .err()
                            .or_else(|| {
                                Some(
                                    AppErrorWire::native_unavailable()
                                        .with_summary("agent runtime unavailable"),
                                )
                            });
                    }
                }
                Effect::ReconcileAgent { token, agent_id } => {
                    let result = tauri::async_runtime::block_on(
                        self.agent_runtime.reconcile(Self::effect_cancel(&token)),
                    );
                    match result {
                        Ok(reconciliation) => {
                            let observation = reconciliation
                                .observations()
                                .iter()
                                .find(|observation| observation.agent_id() == &agent_id);
                            let event = match observation {
                                Some(observation) => ProviderEvent::AgentStatusChanged {
                                    token,
                                    agent_id,
                                    status: observation.status(),
                                    runtime_health: observation.runtime_health(),
                                },
                                None => {
                                    // A missing observation is a natural Agent
                                    // exit. Record the typed fact at the
                                    // runtime ownership seam before handing
                                    // the tokened event to the coordinator;
                                    // the Agent ID never crosses diagnostics.
                                    self.diagnostics.emit(DiagnosticEvent::ProviderExit {
                                        component: diagnostics::Component::Agent,
                                        code: LogCode::ProviderExited,
                                    });
                                    ProviderEvent::AgentExited { token, agent_id }
                                }
                            };
                            let completion =
                                self.accept_provider_event_with_lifecycle(event, lifecycle);
                            if let Ok(value) = &completion {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = completion.err();
                            }
                        }
                        Err(_) if first_error.is_none() => {
                            first_error = self
                                .fail_provider_operation_with_lifecycle(token, lifecycle)
                                .err()
                                .or_else(|| {
                                    Some(
                                        AppErrorWire::native_unavailable()
                                            .with_summary("agent runtime unavailable"),
                                    )
                                });
                        }
                        Err(_) => {}
                    }
                }
                Effect::CleanupWorkspace { token, workspace_id, step: CleanupStep::Agents } => {
                    let agent_ids = self
                        .snapshot_for_effect(lifecycle)?
                        .workspaces()
                        .iter()
                        .find(|workspace| workspace.id() == &workspace_id)
                        .map(|workspace| {
                            workspace
                                .agents()
                                .iter()
                                .map(|agent| agent.id().clone())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let mut result = WorkspaceCleanupResult::StepCompleted(CleanupStep::Agents);
                    for agent_id in agent_ids {
                        if tauri::async_runtime::block_on(
                            self.agent_runtime.terminate(agent_id, Self::effect_cancel(&token)),
                        )
                        .is_err()
                        {
                            result = WorkspaceCleanupResult::Failed {
                                step: CleanupStep::Agents,
                                diagnostic: DiagnosticCode::CleanupFailed,
                            };
                            break;
                        }
                    }
                    if matches!(&result, WorkspaceCleanupResult::Failed { .. }) {
                        self.diagnostics.emit(DiagnosticEvent::ProviderExit {
                            component: diagnostics::Component::Agent,
                            code: LogCode::ProviderExited,
                        });
                    }
                    let completion =
                        self.complete_workspace_cleanup(token, workspace_id, result, lifecycle);
                    if let Ok(value) = &completion {
                        last_outcome = Some(value.clone());
                    }
                    if first_error.is_none() {
                        first_error = completion.err();
                    }
                }
                Effect::CleanupWorkspace { token, workspace_id, step: CleanupStep::Editor } => {
                    let result = tauri::async_runtime::block_on(
                        self.editor_host
                            .close_workspace(workspace_id.clone(), Self::effect_cancel(&token)),
                    )
                    .map(|_| WorkspaceCleanupResult::StepCompleted(CleanupStep::Editor))
                    .unwrap_or(WorkspaceCleanupResult::Failed {
                        step: CleanupStep::Editor,
                        diagnostic: DiagnosticCode::CleanupFailed,
                    });
                    if matches!(&result, WorkspaceCleanupResult::Failed { .. }) {
                        self.diagnostics.emit(DiagnosticEvent::ProviderExit {
                            component: diagnostics::Component::Editor,
                            code: LogCode::EditorDisconnected,
                        });
                    }
                    let completion =
                        self.complete_workspace_cleanup(token, workspace_id, result, lifecycle);
                    if let Ok(value) = &completion {
                        last_outcome = Some(value.clone());
                    }
                    if first_error.is_none() {
                        first_error = completion.err();
                    }
                }
                Effect::CleanupWorkspace {
                    token,
                    workspace_id,
                    step: CleanupStep::StateCommitted,
                } => {
                    let completion = self.complete_workspace_cleanup(
                        token,
                        workspace_id,
                        WorkspaceCleanupResult::StepCompleted(CleanupStep::StateCommitted),
                        lifecycle,
                    );
                    if let Ok(value) = &completion {
                        last_outcome = Some(value.clone());
                    }
                    if first_error.is_none() {
                        first_error = completion.err();
                    }
                }
                Effect::CleanupWorkspace { token, workspace_id, step: CleanupStep::Terminal } => {
                    let snapshot = self.snapshot_for_effect(lifecycle)?;
                    let result = snapshot
                        .workspaces()
                        .iter()
                        .find(|workspace| workspace.id() == &workspace_id)
                        .map(|workspace| {
                            let workspace_target = WorkspaceTerminalTarget::new(
                                workspace_id.clone(),
                                workspace.root().clone(),
                            );
                            let target = TerminalTarget::workspace(
                                workspace_id.clone(),
                                workspace.root().clone(),
                            );
                            self._terminal_runtime.detach_target(&target);
                            let close_result = self
                                .terminal_operation_cancel()
                                .map_err(|_| ())
                                .and_then(|cancel| {
                                    self._terminal_runtime
                                        .close_workspace_target(&workspace_target, &cancel)
                                        .map_err(|_| ())
                                });
                            match close_result {
                                Ok(()) => {
                                    WorkspaceCleanupResult::StepCompleted(CleanupStep::Terminal)
                                }
                                Err(()) => WorkspaceCleanupResult::Failed {
                                    step: CleanupStep::Terminal,
                                    diagnostic: DiagnosticCode::CleanupFailed,
                                },
                            }
                        })
                        .unwrap_or(WorkspaceCleanupResult::Failed {
                            step: CleanupStep::Terminal,
                            diagnostic: DiagnosticCode::CloseTerminalUnknown,
                        });
                    if matches!(&result, WorkspaceCleanupResult::Failed { .. }) {
                        self.diagnostics.emit(DiagnosticEvent::ProviderExit {
                            component: diagnostics::Component::Terminal,
                            code: LogCode::TerminalDisconnected,
                        });
                    }
                    let completion_result =
                        self.complete_workspace_cleanup(token, workspace_id, result, lifecycle);
                    if let Ok(outcome) = &completion_result {
                        last_outcome = Some(outcome.clone());
                    }
                    if first_error.is_none() {
                        first_error = completion_result.err();
                    }
                }
            }
            // A cleanup completion can synchronously emit the next effect
            // (for example Editor after Terminal). Drain it into this same
            // bounded worklist so no coordinator effect is silently lost.
            pending.extend(self.drain_effects_for_lifecycle(lifecycle)?);
        }
        Ok(EffectExecution {
            snapshot: self.snapshot_for_effect(lifecycle)?,
            outcome: last_outcome,
            error: first_error,
            persistence_degraded,
        })
    }

    fn dispatch_lifecycle(
        &self,
        intent: UserIntent,
    ) -> Result<(AppSnapshot, Vec<Effect>), AppErrorWire> {
        self.dispatch_lifecycle_with_close_token(intent, None)
    }

    fn dispatch_lifecycle_with_close_token(
        &self,
        intent: UserIntent,
        cleanup_token: Option<WindowCleanupToken>,
    ) -> Result<(AppSnapshot, Vec<Effect>), AppErrorWire> {
        let intent_id = self.id_generator.next_intent_id()?;
        let operation_id = self
            .id_generator
            .next_operation_id()
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        if cleanup_token.is_some() {
            self.require_close_cleanup_token(cleanup_token)?;
        }
        let mut coordinator = self.coordinator.lock().map_err(state_error)?;
        let outcome = coordinator
            .dispatch_user(IntentEnvelope::with_operation_id(intent_id, operation_id, intent))
            .map_err(|error| AppErrorWire::from_error(&error))?;
        let effects = Self::drain_effects(&mut coordinator);
        Ok((outcome.snapshot().clone(), effects))
    }

    fn persist_window_frame_for_generation(
        &self,
        window: &tauri::Window<tauri::Wry>,
        expected_generation: Option<u64>,
        expected_window_handle: Option<u64>,
    ) -> Result<(), AppErrorWire> {
        let position = window.inner_position().map_err(|_| AppErrorWire::native_unavailable())?;
        let size = window.inner_size().map_err(|_| AppErrorWire::native_unavailable())?;
        let maximized = window.is_maximized().map_err(|_| AppErrorWire::native_unavailable())?;
        let frame = devhub_app_core::state::WindowFrame {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized,
        }
        .validate()
        .map_err(persistence_error)?;
        let _commit = self.state_commit.lock().map_err(state_error)?;
        if let Some(expected_generation) = expected_generation {
            if let Some(expected_window_handle) = expected_window_handle {
                if !self.frame_persist_token_is_current(
                    window,
                    expected_generation,
                    expected_window_handle,
                ) {
                    return Ok(());
                }
            }
        }
        if let Some(expected_window_handle) = expected_window_handle {
            if native_window_handle_key(window) != Some(expected_window_handle) {
                return Ok(());
            }
        }
        let mut state = self.store.load_or_default().map_err(persistence_error)?;
        state.window.frame = frame;
        self.store.save_state(&state).map_err(persistence_error)
    }

    /// A frame writer owns one concrete Window generation. It may finish
    /// after CloseRequested/ExitRequested has moved the lifecycle to Closing
    /// or Quitting, but never after that generation has been replaced.
    fn frame_persist_token_is_current(
        &self,
        window: &tauri::Window<tauri::Wry>,
        generation: u64,
        handle_key: u64,
    ) -> bool {
        if self.lifecycle.generation() != generation
            || !frame_persist_phase_allowed(self.lifecycle.phase())
            || native_window_handle_key(window) != Some(handle_key)
        {
            return false;
        }
        self.native_window_identity.lock().ok().and_then(|current| *current).is_some_and(
            |identity| {
                identity.handle_key == handle_key && identity.lifecycle_generation == generation
            },
        )
    }

    /// Coalesces native Moved/Resized notifications into one serialized
    /// state-store write. The final event wins, even if a display sends a
    /// burst while the previous atomic save is still in flight.
    fn schedule_window_frame_persist(&self, window: &tauri::Window<tauri::Wry>) {
        if self.frame_restore_running.load(Ordering::Acquire) {
            return;
        }
        let Some(window_handle) = native_window_handle_key(window) else { return };
        let generation = self.lifecycle.generation();
        self.frame_persist_dirty.store(true, Ordering::Release);
        let already_scheduled = self
            .frame_persist_scheduled
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err();
        if already_scheduled && self.frame_persist_generation.load(Ordering::Acquire) == generation
        {
            return;
        }
        // A different generation may still own the old scheduled bit while
        // it notices the close. Let this event start a writer for the new
        // Window; the stale worker will exit without clearing our bit.
        self.frame_persist_generation.store(generation, Ordering::Release);
        let ticket = self.frame_persist_ticket.fetch_add(1, Ordering::AcqRel).saturating_add(1);
        let app = window.app_handle().clone();
        let window = window.clone();
        self.frame_persist_workers.fetch_add(1, Ordering::AcqRel);
        tauri::async_runtime::spawn_blocking(move || {
            let mut ticket = ticket;
            while let Some(state) = app.try_state::<NativeAppState>() {
                if !frame_persist_owner_matches(
                    state.frame_persist_generation.load(Ordering::Acquire),
                    state.frame_persist_ticket.load(Ordering::Acquire),
                    generation,
                    ticket,
                ) {
                    break;
                }
                if !state.frame_persist_token_is_current(&window, generation, window_handle) {
                    // A stale worker must never clear flags now owned by a
                    // reopened Window. Only the exact generation/ticket that
                    // owns the flags may release them.
                    if frame_persist_owner_matches(
                        state.frame_persist_generation.load(Ordering::Acquire),
                        state.frame_persist_ticket.load(Ordering::Acquire),
                        generation,
                        ticket,
                    ) {
                        state.frame_persist_dirty.store(false, Ordering::Release);
                        state.frame_persist_scheduled.store(false, Ordering::Release);
                    }
                    break;
                }
                state.frame_persist_dirty.store(false, Ordering::Release);
                if let Err(error) = state.persist_window_frame_for_generation(
                    &window,
                    Some(generation),
                    Some(window_handle),
                ) {
                    if let Ok(mut frame_error) = state.frame_persist_error.lock() {
                        *frame_error = Some(error);
                    }
                }
                if !frame_persist_owner_matches(
                    state.frame_persist_generation.load(Ordering::Acquire),
                    state.frame_persist_ticket.load(Ordering::Acquire),
                    generation,
                    ticket,
                ) || !state.frame_persist_token_is_current(&window, generation, window_handle)
                {
                    break;
                }
                if state.frame_persist_dirty.swap(false, Ordering::AcqRel) {
                    continue;
                }
                if !frame_persist_owner_matches(
                    state.frame_persist_generation.load(Ordering::Acquire),
                    state.frame_persist_ticket.load(Ordering::Acquire),
                    generation,
                    ticket,
                ) {
                    break;
                }
                state.frame_persist_scheduled.store(false, Ordering::Release);
                // Close the small race between the last dirty check and
                // clearing the scheduled bit. A new event either sees the
                // bit and is consumed by this loop, or schedules its own
                // worker after the bit is cleared.
                if state.frame_persist_dirty.swap(false, Ordering::AcqRel)
                    && state
                        .frame_persist_scheduled
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                {
                    ticket =
                        state.frame_persist_ticket.fetch_add(1, Ordering::AcqRel).saturating_add(1);
                    continue;
                }
                break;
            }
            if let Some(state) = app.try_state::<NativeAppState>() {
                state.frame_persist_workers.fetch_sub(1, Ordering::AcqRel);
            }
        });
    }

    /// Applies the durable frame through the current display topology. A
    /// disconnected monitor cannot strand the main Window off-screen.
    fn restore_window_frame(&self, window: &tauri::Window<tauri::Wry>) -> Result<(), AppErrorWire> {
        self.frame_restore_running.store(true, Ordering::Release);
        let result = (|| {
            let mut state = self.store.load_or_default().map_err(persistence_error)?;
            let displays = window
                .available_monitors()
                .map_err(|_| AppErrorWire::native_unavailable())?
                .into_iter()
                .map(|monitor| {
                    let work_area = monitor.work_area();
                    DisplayWorkArea::new(
                        work_area.position.x,
                        work_area.position.y,
                        work_area.size.width,
                        work_area.size.height,
                    )
                })
                .collect::<Vec<_>>();
            let frame = safe_restore_frame(state.window.frame, &displays);
            let currently_maximized =
                window.is_maximized().map_err(|_| AppErrorWire::native_unavailable())?;
            // A previously maximized Window may ignore geometry updates until
            // it has been restored. Apply the unmaximize transition first,
            // then set the clamped physical frame, and finally re-maximize if
            // requested.
            if !frame.maximized && currently_maximized {
                window.unmaximize().map_err(|_| AppErrorWire::native_unavailable())?;
            }
            window
                .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                    frame.x, frame.y,
                )))
                .map_err(|_| AppErrorWire::native_unavailable())?;
            window
                .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                    frame.width,
                    frame.height,
                )))
                .map_err(|_| AppErrorWire::native_unavailable())?;
            if frame.maximized {
                window.maximize().map_err(|_| AppErrorWire::native_unavailable())?;
            }
            // Commit the validated/clamped frame after applying it. This
            // closes a startup race with a native default-frame event that
            // may have queued a persist before reconstruction acquired the
            // restore guard.
            let _commit = self.state_commit.lock().map_err(state_error)?;
            state.window.frame = frame;
            self.store.save_state(&state).map_err(persistence_error)?;
            Ok(())
        })();
        self.frame_restore_running.store(false, Ordering::Release);
        result
    }

    /// A window close commits an unclean detached coordinator. In the native
    /// path raw terminal/Agent/WRY projections are detached by Destroyed after
    /// the irreversible close; this test seam has no concrete Window.
    #[cfg(test)]
    fn close_window(&self) -> Result<(), AppErrorWire> {
        if !self.begin_close_transaction() {
            return Ok(());
        }
        let result = self.close_window_claimed(None, None);
        if result.is_ok() {
            self.finish_close_transaction();
            self.clear_close_rollback_snapshot();
        } else {
            let rollback = self.restore_failed_close();
            self.abort_close_transaction();
            rollback?;
        }
        result
    }

    fn close_window_claimed(
        &self,
        window: Option<&tauri::Window<tauri::Wry>>,
        cleanup_token: Option<WindowCleanupToken>,
    ) -> Result<(), AppErrorWire> {
        self.diagnostics.emit(DiagnosticEvent::Lifecycle { phase: LifecyclePhase::WindowClose });
        self.clear_frame_persist_error();
        self.capture_close_rollback_snapshot()?;
        if let Some(window) = window {
            // Capture on an app-local worker before touching child WebViews.
            // Close must not block the native event thread on state-store I/O.
            self.schedule_window_frame_persist(window);
        }
        if !self.wait_for_frame_persist(Instant::now() + Duration::from_secs(5)) {
            return Err(AppErrorWire::native_unavailable()
                .with_summary("window frame persistence did not stop before close"));
        }
        if let Some(error) = self.take_frame_persist_error() {
            return Err(error);
        }
        if !self.wait_for_reconstruction(Instant::now() + Duration::from_secs(5)) {
            return Err(AppErrorWire::native_unavailable()
                .with_summary("window reconstruction did not stop before close"));
        }
        if let Ok(mut picker) = self.picker_cancel.lock() {
            if let Some(token) = picker.take() {
                token.cancel();
            }
        }
        let (_, effects) =
            self.dispatch_lifecycle_with_close_token(UserIntent::WindowClosed, cleanup_token)?;
        let execution = self.execute_effects_for_window_close(effects)?;
        if let Some(error) = execution.error {
            return Err(error);
        }
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.require_close_cleanup_token(cleanup_token)?;
        self.persist_snapshot(&execution.snapshot, true)
    }

    fn load_coordinator_from_store(&self) -> Result<(AppCoordinator, u64), AppErrorWire> {
        let persisted = self.store.load_or_default().map_err(persistence_error)?;
        let profiles = self.profiles.lock().map_err(state_error)?.clone();
        let model = persisted.hydrate_model(&profiles).map_err(persistence_error)?;
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.mark_ready();
        let revision = coordinator.snapshot().revision();
        Ok((coordinator, revision))
    }

    /// Installs a pre-hydrated coordinator. The caller must hold
    /// `coordinator_transaction`; lifecycle generation changes and this
    /// replacement therefore form one transaction from the point of view of
    /// every command/provider completion.
    fn replace_coordinator_locked(
        &self,
        coordinator: AppCoordinator,
        revision: u64,
    ) -> Result<(), AppErrorWire> {
        *self.coordinator.lock().map_err(state_error)? = coordinator;
        self.persistence.lock().map_err(state_error)?.persisted_revision = revision;
        Ok(())
    }

    fn rehydrate_coordinator_from_store(&self) -> Result<(), AppErrorWire> {
        let (coordinator, revision) = self.load_coordinator_from_store()?;
        let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        self.replace_coordinator_locked(coordinator, revision)
    }

    /// Rehydrates the sole coordinator from the durable Rust-owned snapshot
    /// after Dock activation. Replacing the coordinator also discards all
    /// pending operation ledgers and old event cursors, so stale completions
    /// from the destroyed Window cannot mutate the reconstructed projection.
    fn reopen(&self) -> Result<bool, AppErrorWire> {
        // Hydrate before claiming Open so a concurrent explicit quit can win
        // while disk I/O is in progress. Once the gate is acquired, the
        // generation transition and coordinator replacement are inseparable.
        let (coordinator, revision) = self.load_coordinator_from_store()?;
        let transaction = self.coordinator_transaction.lock().map_err(state_error)?;
        if !self.lifecycle.begin_reopen() {
            return Ok(false);
        }
        let result = self.replace_coordinator_locked(coordinator, revision).map(|()| true);
        if result.is_err() {
            // Reopen remains a usable process state. Returning the gate to
            // Closed allows the next Dock activation to retry reconstruction.
            self.lifecycle.abort_reopen();
        }
        drop(transaction);
        result
    }

    fn reopen_from_dock(&self, app: &AppHandle) -> Result<(), AppErrorWire> {
        if !claim_single_flight(&self.dock_reopen_running) {
            // A second Dock notification can arrive before the first one has
            // mounted WRY children. Wait for that owner and return the same
            // result; showing/focusing a half-reconstructed Window here
            // would make the outcome depend on event timing.
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.dock_reopen_running.load(Ordering::Acquire) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            return self
                .dock_reopen_result
                .lock()
                .ok()
                .and_then(|result| result.clone())
                .unwrap_or_else(|| {
                    Err(AppErrorWire::native_unavailable()
                        .with_summary("Dock reconstruction did not produce a result"))
                });
        }
        if let Ok(mut result) = self.dock_reopen_result.lock() {
            *result = None;
        }
        let result = (|| {
            if !self.wait_for_window_cleanup(Instant::now() + Duration::from_secs(5)) {
                return Err(AppErrorWire::native_unavailable()
                    .with_summary("previous Window cleanup did not finish before reopen"));
            }
            let reopened = self.reopen()?;
            if !reopened
                && matches!(self.lifecycle.phase(), Phase::Closing | Phase::Quitting | Phase::Quit)
            {
                // A Dock activation racing the close/quit event belongs to
                // the old Window generation. Let that transition finish;
                // reopening is retried by the next genuine activation
                // instead of showing a Window whose raw children are still
                // being detached.
                return Ok(());
            }
            let window_was_missing = app.get_webview_window(APP_SHELL_WINDOW_LABEL).is_none();
            let claimed_reconstruction =
                reopened || window_was_missing || !self.editor_host.window_attached();
            let result = (|| {
                let window = ensure_app_shell_window(app, self)?;
                if claimed_reconstruction {
                    self.reconstruct_window_once(app)?;
                }
                window.show().map_err(|_| AppErrorWire::native_unavailable())?;
                window.set_focus().map_err(|_| AppErrorWire::native_unavailable())?;
                Ok::<(), AppErrorWire>(())
            })();
            if result.is_err() && claimed_reconstruction {
                // Keep the process alive and make the next Dock activation a
                // genuine retry rather than a duplicate-window attempt.
                self.diagnostics.emit(DiagnosticEvent::Retry {
                    module: diagnostics::Module::App,
                    code: LogCode::RetryLimit,
                    attempt: 1,
                });
                self.abort_reopen_transaction();
            }
            result
        })();
        if result.is_ok() {
            self.diagnostics
                .emit(DiagnosticEvent::Lifecycle { phase: LifecyclePhase::WindowReopen });
        }
        if let Ok(mut completed) = self.dock_reopen_result.lock() {
            *completed = Some(result.clone());
        }
        self.dock_reopen_running.store(false, Ordering::Release);
        result
    }

    /// A process quit detaches the coordinator, stops only DevHub-owned
    /// listeners and OpenVSCode, persists the exact final projection, and
    /// then marks the durable lifecycle clean. This method is idempotent so a
    /// native ExitRequested re-entry cannot recurse into shutdown.
    #[cfg(test)]
    fn quit(&self) -> Result<(), AppErrorWire> {
        self.quit_with_window(None)
    }

    fn quit_with_window(
        &self,
        window: Option<&tauri::Window<tauri::Wry>>,
    ) -> Result<(), AppErrorWire> {
        if !self.begin_quit_transaction() {
            if self.lifecycle.phase() == Phase::Closing
                && self.force_quit_after_close_timeout_transaction()
            {
                // Continue with explicit native cleanup below. The close
                // worker's captured generation is now stale and cannot issue
                // a second Window close.
            } else {
                return match self.lifecycle.phase() {
                    Phase::Quitting | Phase::Quit => Ok(()),
                    _ => Err(AppErrorWire::native_unavailable()
                        .with_summary("close did not finish before quit deadline")),
                };
            }
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut first_error = None;
        self.clear_frame_persist_error();
        if let Some(window) = window {
            // Native geometry capture/persistence is asynchronous. A slow
            // store cannot consume the quit deadline before owned process
            // termination is attempted.
            self.schedule_window_frame_persist(window);
        }
        if !self.wait_for_reconstruction(deadline) {
            first_error.get_or_insert_with(|| {
                AppErrorWire::native_unavailable()
                    .with_summary("window reconstruction did not stop before quit deadline")
            });
        }
        self.agent_reconciler_running.store(false, Ordering::Release);
        if let Ok(mut picker) = self.picker_cancel.lock() {
            if let Some(token) = picker.take() {
                token.cancel();
            }
        }
        if let Ok(mut watcher) = self.config_watcher.lock() {
            if let Some(watcher) = watcher.take() {
                if !watcher.stop_until(deadline) {
                    first_error = Some(
                        AppErrorWire::native_unavailable()
                            .with_summary("Settings watcher did not stop before quit deadline"),
                    );
                }
            }
        }
        self.bridge_sink.clear_router();
        if let Ok(mut handle) = self.bridge_router_handle.lock() {
            if let Some(handle) = handle.take() {
                if !join_managed_thread(handle, deadline) {
                    first_error.get_or_insert_with(|| {
                        AppErrorWire::native_unavailable()
                            .with_summary("Bridge router did not stop before quit deadline")
                    });
                }
            }
        }
        if let Ok(mut handle) = self.agent_reconciler_handle.lock() {
            if let Some(handle) = handle.take() {
                if !join_managed_thread(handle, deadline) {
                    first_error.get_or_insert_with(|| {
                        AppErrorWire::native_unavailable()
                            .with_summary("Agent reconciler did not stop before quit deadline")
                    });
                }
            }
        }
        if !self._terminal_runtime.detach_all_surfaces_until(deadline) {
            first_error.get_or_insert_with(|| {
                AppErrorWire::native_unavailable()
                    .with_summary("terminal reader/reaper did not stop before quit deadline")
            });
        }
        if !self.agent_surfaces.detach_all_until(deadline) {
            first_error.get_or_insert_with(|| {
                AppErrorWire::native_unavailable()
                    .with_summary("Agent Surface readers did not stop before quit deadline")
            });
        }
        // Releasing the provider subscription is local cleanup only. It does
        // not issue any Herdr terminate or tmux close operation.
        if !self.agent_runtime.shutdown_until(deadline) {
            first_error.get_or_insert_with(|| {
                AppErrorWire::native_unavailable()
                    .with_summary("Agent event reader did not stop before quit deadline")
            });
        }
        // Do this explicitly even when the coordinator previously received a
        // WindowClosed detach. A detached coordinator intentionally emits no
        // second Quit effect, but OpenVSCode is still DevHub-owned and must be
        // stopped exactly once on process quit.
        // Always enter EditorHost shutdown, even when earlier app-local joins
        // exhausted the deadline. Its process supervisor still sends the
        // termination request and hands an unreaped Child to the bounded
        // app-local reaper, so OpenVSCode cannot survive this quit path.
        if let Err(error) = self.editor_host.shutdown_until(deadline) {
            first_error.get_or_insert_with(|| state_error(error));
        }
        // Drain frame persistence only after owned shutdown has been
        // initiated. A blocked state-store writer therefore cannot postpone
        // OpenVSCode termination; it simply keeps clean shutdown false.
        if !self.wait_for_frame_persist(deadline) {
            first_error.get_or_insert_with(|| {
                AppErrorWire::native_unavailable()
                    .with_summary("window frame persistence did not stop before quit deadline")
            });
        }
        if let Some(error) = self.take_frame_persist_error() {
            first_error.get_or_insert(error);
        }
        let result = (|| {
            let (_, effects) = self.dispatch_lifecycle(UserIntent::Quit)?;
            let execution = self.execute_effects_until(effects, Some(deadline), None)?;
            if let Some(error) = execution.error {
                return Err(error);
            }
            if let Some(error) = first_error {
                return Err(error);
            }
            if Instant::now() >= deadline {
                return Err(AppErrorWire::native_unavailable()
                    .with_summary("quit deadline exceeded before durable clean shutdown"));
            }
            self.persist_clean_snapshot(&execution.snapshot, deadline)
        })();
        self.finish_quit_transaction();
        result
    }

    #[cfg(test)]
    fn dispatch_intent(&self, intent: UserIntent) -> Result<(AppOutcomeWire, bool), AppErrorWire> {
        let lifecycle = self.capture_lifecycle_token();
        self.dispatch_intent_with_lifecycle(intent, lifecycle)
    }

    fn dispatch_intent_with_lifecycle(
        &self,
        intent: UserIntent,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(AppOutcomeWire, bool), AppErrorWire> {
        let intent_id = self.id_generator.next_intent_id()?;
        let operation_id = self
            .id_generator
            .next_operation_id()
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let (outcome, before, readiness, effects) = {
            let _transaction = self.coordinator_transaction.lock().map_err(state_error)?;
            self.require_app_lifecycle_token(lifecycle)?;
            let mut coordinator = self.coordinator.lock().map_err(state_error)?;
            let before = coordinator.snapshot().revision();
            let outcome = coordinator
                .dispatch_user(IntentEnvelope::with_operation_id(intent_id, operation_id, intent))
                .map_err(|error| AppErrorWire::from_error(&error))?;
            let effects = Self::drain_effects(&mut coordinator);
            (outcome, before, coordinator.readiness(), effects)
        };
        let execution = self.execute_effects_for_lifecycle(effects, lifecycle)?;
        self.validate_app_lifecycle_token(lifecycle)?;
        self.sync_editor_surface_with_lifecycle(lifecycle)?;
        let changed = execution.snapshot.revision() != before;
        let final_outcome = execution.outcome.as_ref().unwrap_or(&outcome);
        let mut wire =
            AppOutcomeWire::from_outcome(final_outcome, readiness).map_err(state_error)?;
        if let Some(error) = execution.error {
            if !execution.persistence_degraded {
                return Err(error);
            }
            wire = AppOutcomeWire::PersistenceDegraded {
                snapshot: AppSnapshotWire::from_snapshot(&execution.snapshot, readiness)
                    .map_err(state_error)?,
            };
        }
        Ok((wire, changed))
    }

    fn route_bridge_request(
        &self,
        request: &BridgeRequest,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(), AppErrorWire> {
        self.validate_app_lifecycle_token(lifecycle)?;
        let intent = match request.request() {
            devhub_app_core::bridge::ClientRequest::OpenWorkspace(payload) => {
                UserIntent::OpenFolder {
                    path: devhub_app_core::RequestedPath::new(payload.absolute_path.as_str())
                        .map_err(|_| AppErrorWire::native_unavailable())?,
                }
            }
            devhub_app_core::bridge::ClientRequest::NewWindow(payload) => UserIntent::NewWindow {
                path: payload
                    .absolute_path
                    .as_ref()
                    .map(|path| devhub_app_core::RequestedPath::new(path.as_str()))
                    .transpose()
                    .map_err(|_| AppErrorWire::native_unavailable())?,
            },
            _ => return Ok(()),
        };
        let result = match self.dispatch_intent_with_lifecycle(intent, lifecycle) {
            Ok(_) => self.bridge_result_for_lifecycle(lifecycle),
            Err(_) => bridge_request_failed_result(),
        };
        self.validate_app_lifecycle_token(lifecycle)?;
        if !self.bridge_sink.request_is_live(request) {
            return Ok(());
        }
        self.editor_host
            .complete_bridge_request(request.handle().clone(), result)
            .map_err(state_error)?;
        Ok(())
    }

    fn bridge_result_for_lifecycle(&self, lifecycle: NativeLifecycleToken) -> BridgeRequestResult {
        let Ok(snapshot) = self.current_snapshot_with_lifecycle(lifecycle) else {
            return bridge_request_failed_result();
        };
        self.bridge_result_for_snapshot(&snapshot).unwrap_or(bridge_request_failed_result())
    }

    fn bridge_result_for_snapshot(
        &self,
        snapshot: &AppSnapshot,
    ) -> Result<BridgeRequestResult, AppErrorWire> {
        match snapshot.selected_context() {
            devhub_app_core::NavigationContext::Global => Ok(BridgeRequestResult::GlobalRouted {
                context: devhub_app_core::bridge::Context::Global,
            }),
            devhub_app_core::NavigationContext::Workspace(workspace_id) => {
                let workspace = snapshot
                    .workspaces()
                    .iter()
                    .find(|workspace| workspace.id() == workspace_id)
                    .ok_or_else(AppErrorWire::native_unavailable)?;
                let id = devhub_app_core::bridge::Uuid::parse(workspace.id().as_str().to_owned())
                    .map_err(|_| AppErrorWire::native_unavailable())?;
                let root = workspace
                    .root()
                    .as_path()
                    .to_str()
                    .ok_or_else(AppErrorWire::native_unavailable)
                    .and_then(|root| {
                        devhub_app_core::bridge::AbsolutePath::normalize(root)
                            .map_err(|_| AppErrorWire::native_unavailable())
                    })?;
                Ok(BridgeRequestResult::WorkspaceRouted {
                    context: devhub_app_core::bridge::Context::workspace(id, root),
                })
            }
            devhub_app_core::NavigationContext::Agent(_) => Ok(BridgeRequestResult::GlobalRouted {
                context: devhub_app_core::bridge::Context::Global,
            }),
        }
    }

    fn advance_settings_sequence(
        settings: &mut SettingsProjection,
    ) -> Result<(), SettingsErrorWire> {
        settings.sequence = settings
            .sequence
            .checked_add(1)
            .filter(|sequence| *sequence <= SETTINGS_SEQUENCE_MAX)
            .ok_or_else(SettingsErrorWire::native_unavailable)?;
        Ok(())
    }

    fn apply_loaded_config(&self, loaded: LoadedConfig) -> Result<(), SettingsErrorWire> {
        // Profile choices are a live, secret-free projection. Existing Agents
        // already own cloned launch-time profiles in AppModel and are not
        // changed by this replacement.
        let next_profiles = load_config_profiles(loaded.config())
            .map_err(|_| SettingsErrorWire::invalid_config())?;
        let active_transition = matches!(
            self.load_transition_state(&self.transition_store())?.tmux.transition,
            SocketTransitionState::CleaningOld { .. }
                | SocketTransitionState::OldCleaned { .. }
                | SocketTransitionState::RecreationPending { .. }
        );
        let settings = self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        if active_transition
            && loaded.config().runtimes.tmux_socket_name
                != settings.loaded.config().runtimes.tmux_socket_name
        {
            // A confirmed destructive phase owns its requested socket until
            // it reaches Stable. External edits cannot overwrite that
            // in-flight configured target projection; retain the candidate
            // for an explicit post-transition reconciliation instead.
            drop(settings);
            self.defer_external_config(loaded)?;
            return Err(SettingsErrorWire::stale_socket_change());
        }
        drop(settings);
        // A newer valid file revision supersedes any previously deferred
        // candidate (for example, an external edit that restores the
        // in-flight socket while changing only appearance). Keep the latest
        // ConfigStore revision authoritative for post-transition reconciliation.
        self.deferred_config.lock().map_err(|_| SettingsErrorWire::native_unavailable())?.take();
        let mut settings =
            self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        Self::advance_settings_sequence(&mut settings)?;
        settings.loaded = loaded;
        settings.diagnostic = None;
        drop(settings);
        *self.profiles.lock().map_err(|_| SettingsErrorWire::native_unavailable())? = next_profiles;
        Ok(())
    }

    fn defer_external_config(&self, loaded: LoadedConfig) -> Result<(), SettingsErrorWire> {
        *self.deferred_config.lock().map_err(|_| SettingsErrorWire::native_unavailable())? =
            Some(loaded);
        let mut settings =
            self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        let diagnostic = Some(devhub_app_core::SettingsDiagnosticWire {
            code: devhub_app_core::SettingsDiagnosticCodeWire::Conflict,
            path: Some("runtimes.tmux_socket_name".to_owned()),
            line: None,
            column: None,
        });
        if settings.diagnostic != diagnostic {
            Self::advance_settings_sequence(&mut settings)?;
            settings.diagnostic = diagnostic;
        }
        Ok(())
    }

    /// Applies a valid watcher candidate only after the transition commit
    /// point. If a transition is still active, the candidate remains queued.
    fn reconcile_deferred_config(&self) -> Result<(), SettingsErrorWire> {
        let is_stable = matches!(
            self.load_transition_state(&self.transition_store())?.tmux.transition,
            SocketTransitionState::Stable
        );
        if !is_stable {
            return Ok(());
        }
        let candidate = self
            .deferred_config
            .lock()
            .map_err(|_| SettingsErrorWire::native_unavailable())?
            .take();
        let Some(candidate) = candidate else { return Ok(()) };
        let next_profiles = match load_config_profiles(candidate.config()) {
            Ok(profiles) => profiles,
            Err(_) => {
                *self
                    .deferred_config
                    .lock()
                    .map_err(|_| SettingsErrorWire::native_unavailable())? = Some(candidate);
                return Err(SettingsErrorWire::invalid_config());
            }
        };
        let mut settings =
            self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        Self::advance_settings_sequence(&mut settings)?;
        settings.loaded = candidate;
        settings.diagnostic = None;
        drop(settings);
        *self.profiles.lock().map_err(|_| SettingsErrorWire::native_unavailable())? = next_profiles;
        Ok(())
    }

    fn apply_config_diagnostic(
        &self,
        diagnostic: ConfigDiagnostic,
    ) -> Result<bool, SettingsErrorWire> {
        let mut settings =
            self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        let next = Some((&diagnostic).into());
        if settings.diagnostic == next {
            return Ok(false);
        }
        Self::advance_settings_sequence(&mut settings)?;
        settings.diagnostic = next;
        Ok(true)
    }

    fn clear_config_diagnostic(&self) -> Result<bool, SettingsErrorWire> {
        if self
            .deferred_config
            .lock()
            .map_err(|_| SettingsErrorWire::native_unavailable())?
            .is_some()
        {
            // ConfigStore may report the deferred revision as Unchanged on
            // the next watcher tick. Keep the conflict visible until the
            // transition commit point reconciles that candidate.
            return Ok(false);
        }
        let mut settings =
            self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        if settings.diagnostic.is_none() {
            return Ok(false);
        }
        Self::advance_settings_sequence(&mut settings)?;
        settings.diagnostic = None;
        Ok(true)
    }

    fn settings_sequence(&self) -> Result<u64, SettingsErrorWire> {
        Ok(self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?.sequence)
    }

    fn app_appearance(&self) -> Result<AppAppearanceWire, SettingsErrorWire> {
        let settings = self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        Ok(AppAppearanceWire::from_config(&settings.loaded.config().appearance, settings.sequence))
    }

    fn transition_store(&self) -> JsonStateStore {
        JsonStateStore::new(self.store.path().to_path_buf())
    }

    fn load_transition_state(
        &self,
        store: &JsonStateStore,
    ) -> Result<devhub_app_core::PersistedAppState, SettingsErrorWire> {
        let _commit =
            self.state_commit.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        store.load_or_default().map_err(|_| SettingsErrorWire::invalid_file())
    }

    fn transition_cancel(&self) -> Result<CancellationToken, SettingsErrorWire> {
        let operation = self
            .id_generator
            .next_operation_id()
            .map_err(|_| SettingsErrorWire::native_unavailable())?;
        Ok(CancellationToken::new(operation))
    }

    /// Resolves the semantic terminal surface against the current immutable
    /// AppSnapshot. The webview supplies only the generated surface key; the
    /// canonical Workspace root and tmux target are recovered here.
    fn resolve_terminal_target(
        &self,
        surface_key: &str,
        lifecycle: NativeLifecycleToken,
    ) -> Result<TerminalTarget, TerminalError> {
        let _transaction = self
            .coordinator_transaction
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        self.require_lifecycle_token(lifecycle)?;
        validate_surface_key(surface_key)?;
        let coordinator =
            self.coordinator.lock().map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        let snapshot = coordinator.snapshot();
        if snapshot.active_activity() != Activity::Terminal {
            return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable));
        }
        let resolution = snapshot.activity(Activity::Terminal).resolution();
        let target = match resolution {
            SurfaceResolution::Enabled(SurfaceKey::GlobalTerminal)
                if surface_key == "global-terminal" =>
            {
                TerminalTarget::scratch()
            }
            SurfaceResolution::Enabled(SurfaceKey::WorkspaceTerminal(workspace_id)) => {
                let expected = format!("workspace-terminal:{workspace_id}");
                if surface_key != expected {
                    return Err(TerminalError::new(TerminalErrorCode::InvalidSurface));
                }
                let workspace = snapshot
                    .workspaces()
                    .iter()
                    .find(|workspace| workspace.id() == workspace_id)
                    .ok_or_else(|| TerminalError::new(TerminalErrorCode::SurfaceUnavailable))?;
                TerminalTarget::workspace(workspace_id.clone(), workspace.root().clone())
            }
            _ => return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable)),
        };
        Ok(target)
    }

    fn terminal_operation_cancel(&self) -> Result<CancellationToken, TerminalError> {
        let operation = self
            .id_generator
            .next_operation_id()
            .map_err(|_| TerminalError::new(TerminalErrorCode::RuntimeUnavailable))?;
        Ok(CancellationToken::new(operation))
    }

    fn terminal_attach(
        &self,
        webview_label: &str,
        request: AttachRequest,
        channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
        lifecycle: NativeLifecycleToken,
    ) -> Result<AttachReceipt, TerminalError> {
        validate_attach_request(&request)?;
        let size = TerminalPtySize {
            cols: request.cols,
            rows: request.rows,
            pixel_width: request.pixel_width,
            pixel_height: request.pixel_height,
        };
        let target = self.resolve_terminal_target(&request.surface_key, lifecycle)?;
        let cancel = self.terminal_operation_cancel()?;
        self._terminal_runtime.attach_surface(
            &target,
            request.surface_key,
            webview_label.to_owned(),
            size,
            channel,
            &cancel,
        )
    }

    fn terminal_input(
        &self,
        webview_label: &str,
        request: InputRequest,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        validate_input_sequence(request.input_sequence)?;
        let target = self.resolve_terminal_target(&request.surface_key, lifecycle)?;
        let identity = AttachmentIdentity {
            target: &target,
            surface_key: &request.surface_key,
            attachment_id: &request.attachment_id,
            webview_label,
            target_generation: request.target_generation,
        };
        self._terminal_runtime.terminal_input(identity, request.input_sequence, &request.bytes)
    }

    fn terminal_resize(
        &self,
        webview_label: &str,
        request: ResizeRequest,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        let target = self.resolve_terminal_target(&request.surface_key, lifecycle)?;
        let identity = AttachmentIdentity {
            target: &target,
            surface_key: &request.surface_key,
            attachment_id: &request.attachment_id,
            webview_label,
            target_generation: request.target_generation,
        };
        let cancel = self.terminal_operation_cancel()?;
        self._terminal_runtime.terminal_resize(
            identity,
            TerminalPtySize {
                cols: request.cols,
                rows: request.rows,
                pixel_width: request.pixel_width,
                pixel_height: request.pixel_height,
            },
            &cancel,
        )
    }

    fn terminal_acknowledge(
        &self,
        webview_label: &str,
        request: AckRequest,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        validate_input_sequence(request.sequence)?;
        let target = self.resolve_terminal_target(&request.surface_key, lifecycle)?;
        let identity = AttachmentIdentity {
            target: &target,
            surface_key: &request.surface_key,
            attachment_id: &request.attachment_id,
            webview_label,
            target_generation: request.target_generation,
        };
        self._terminal_runtime.terminal_acknowledge(identity, request.sequence)
    }

    fn terminal_detach(
        &self,
        webview_label: &str,
        request: DetachRequest,
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        if request.target_generation == 0 {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        // Detach deliberately does not resolve the current snapshot. A
        // stale surface must still be able to release its PTY client after a
        // context switch; the manager verifies the exact opaque handle and
        // webview owner before killing only that client.
        self._terminal_runtime.detach_surface(
            &request.surface_key,
            &request.attachment_id,
            webview_label,
            request.target_generation,
        )
    }

    fn agent_surface_attach(
        &self,
        app: &AppHandle,
        webview_label: &str,
        request: AttachRequest,
        channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
        lifecycle: NativeLifecycleToken,
    ) -> Result<AttachReceipt, TerminalError> {
        self.resolve_agent_surface(&request.surface_key, lifecycle)?;
        // The reader callback can outlive the child WebView that created it.
        // Carry the command's original native generation through every
        // callback; recapturing the current generation here would let an old
        // attach completion mutate a newly reopened coordinator.
        let callback_app = app.clone();
        let on_failure: Arc<dyn Fn(devhub_app_core::AgentId) + Send + Sync> =
            Arc::new(move |agent_id| {
                let app = callback_app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        if let Some(state) = app.try_state::<NativeAppState>() {
                            state.mark_agent_runtime_failure_if_current(
                                &app,
                                agent_id,
                                RuntimeHealth::Degraded,
                                lifecycle,
                            );
                        }
                    })
                    .await;
                });
            });
        let (receipt, observation) = self.agent_surfaces.attach(
            &self.agent_runtime,
            webview_label,
            request,
            channel,
            on_failure,
        )?;
        self.apply_agent_observation_with_lifecycle(app, observation, lifecycle);
        Ok(receipt)
    }

    fn apply_agent_observation_with_lifecycle(
        &self,
        app: &AppHandle,
        observation: AgentObservation,
        lifecycle: NativeLifecycleToken,
    ) {
        let operation_id = match self.id_generator.next_operation_id() {
            Ok(operation_id) => operation_id,
            Err(_) => return,
        };
        let mut effects = {
            let Ok(_transaction) = self.coordinator_transaction.lock() else { return };
            if self.require_app_lifecycle_token(lifecycle).is_err() {
                return;
            }
            let Ok(mut coordinator) = self.coordinator.lock() else {
                return;
            };
            match coordinator.request_agent_reconcile(operation_id, observation.agent_id().clone())
            {
                Ok(_) => Self::drain_effects(&mut coordinator),
                Err(_) => return,
            }
        };
        let token = effects.iter().find_map(|effect| match effect {
            Effect::ReconcileAgent { token, .. } => Some(token.clone()),
            _ => None,
        });
        let Some(token) = token else { return };
        effects.retain(|effect| !matches!(effect, Effect::ReconcileAgent { .. }));
        let event_id = match self.id_generator.next_operation_id().map(ProviderEventId::from) {
            Ok(event_id) => event_id,
            Err(_) => return,
        };
        let completed = {
            let Ok(_transaction) = self.coordinator_transaction.lock() else { return };
            if self.require_app_lifecycle_token(lifecycle).is_err() {
                return;
            }
            let Ok(mut coordinator) = self.coordinator.lock() else {
                return;
            };
            if coordinator
                .accept_provider_event(ProviderEventEnvelope::new(
                    event_id,
                    ProviderEvent::AgentStatusChanged {
                        token,
                        agent_id: observation.agent_id().clone(),
                        status: observation.status(),
                        runtime_health: observation.runtime_health(),
                    },
                ))
                .is_err()
            {
                return;
            }
            Self::drain_effects(&mut coordinator)
        };
        effects.extend(completed);
        let Ok(execution) = self.execute_effects_for_lifecycle(effects, lifecycle) else {
            return;
        };
        if self.validate_app_lifecycle_token(lifecycle).is_err() {
            return;
        }
        let readiness = self
            .coordinator
            .lock()
            .map(|coordinator| coordinator.readiness())
            .unwrap_or(AppReadiness::Unavailable);
        let Ok(snapshot) = AppSnapshotWire::from_snapshot(&execution.snapshot, readiness) else {
            return;
        };
        // The callback is intentionally content-free: only the reconciled
        // Rust-owned snapshot crosses back to the Workbench webview.
        let _ = app.emit_to(APP_SHELL_WINDOW_LABEL, APP_SNAPSHOT_CHANGED_EVENT, snapshot);
    }

    fn apply_agent_observation_if_current(
        &self,
        app: &AppHandle,
        observation: AgentObservation,
        lifecycle: NativeLifecycleToken,
    ) {
        if self.validate_app_lifecycle_token(lifecycle).is_err() {
            return;
        }
        self.apply_agent_observation_with_lifecycle(app, observation, lifecycle);
    }

    fn mark_agent_runtime_failure_with_lifecycle(
        &self,
        app: &AppHandle,
        agent_id: devhub_app_core::AgentId,
        runtime_health: RuntimeHealth,
        lifecycle: NativeLifecycleToken,
    ) {
        if self.validate_app_lifecycle_token(lifecycle).is_err() {
            return;
        }
        self.apply_agent_observation_with_lifecycle(
            app,
            AgentObservation::new(agent_id, devhub_app_core::AgentStatus::Error, runtime_health),
            lifecycle,
        );
    }

    fn mark_agent_runtime_failure_if_current(
        &self,
        app: &AppHandle,
        agent_id: devhub_app_core::AgentId,
        runtime_health: RuntimeHealth,
        lifecycle: NativeLifecycleToken,
    ) {
        self.mark_agent_runtime_failure_with_lifecycle(app, agent_id, runtime_health, lifecycle);
    }

    fn resolve_agent_surface(
        &self,
        surface_key: &str,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(), TerminalError> {
        let _transaction = self
            .coordinator_transaction
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        self.require_lifecycle_token(lifecycle)?;
        let Some(agent_id) = surface_key.strip_prefix("agent:") else {
            return Err(TerminalError::new(TerminalErrorCode::InvalidSurface));
        };
        let agent_id = devhub_app_core::AgentId::from_uuid(agent_id.to_owned())
            .map_err(|_| TerminalError::new(TerminalErrorCode::InvalidSurface))?;
        let coordinator =
            self.coordinator.lock().map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        if coordinator.snapshot().active_activity() != Activity::Agent {
            return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable));
        }
        let agent_is_interactive = coordinator
            .snapshot()
            .workspaces()
            .iter()
            .flat_map(|workspace| workspace.agents().iter())
            .find(|agent| agent.id() == &agent_id)
            .is_some_and(|agent| agent.control_state() == AgentControlState::Running);
        if !agent_is_interactive {
            // The provider control stream becomes read-only as soon as the
            // Rust-owned stop lifecycle enters Stopping/StopFailed. A stale
            // webview cannot keep writing merely because it retained an old
            // opaque attachment receipt.
            return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable));
        }
        match coordinator.snapshot().activity(Activity::Agent).resolution() {
            SurfaceResolution::Enabled(SurfaceKey::Agent(expected)) if expected == &agent_id => {
                Ok(())
            }
            SurfaceResolution::Enabled(_) => {
                Err(TerminalError::new(TerminalErrorCode::StaleTarget))
            }
            SurfaceResolution::Disabled(_) => {
                Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable))
            }
        }
    }

    fn agent_surface_input(
        &self,
        webview_label: &str,
        request: InputRequest,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(), TerminalError> {
        self.resolve_agent_surface(&request.surface_key, lifecycle)?;
        self.agent_surfaces.input(webview_label, request)
    }

    fn agent_surface_resize(
        &self,
        webview_label: &str,
        request: ResizeRequest,
        lifecycle: NativeLifecycleToken,
    ) -> Result<(), TerminalError> {
        self.resolve_agent_surface(&request.surface_key, lifecycle)?;
        self.agent_surfaces.resize(webview_label, request)
    }

    fn agent_surface_acknowledge(
        &self,
        webview_label: &str,
        request: AckRequest,
    ) -> Result<(), TerminalError> {
        self.agent_surfaces.acknowledge(webview_label, request)
    }

    fn agent_surface_detach(
        &self,
        webview_label: &str,
        request: DetachRequest,
    ) -> Result<(), TerminalError> {
        self.agent_surfaces.detach(webview_label, request)
    }

    /// Reconciles only the non-destructive part of a configured socket
    /// change. It creates/refreshes the persisted Pending projection, probes
    /// the requested target, and snapshots the exact marked old-session set
    /// before Settings can ask for confirmation. Provider I/O happens with no
    /// state/settings lock held; each result is committed only after an exact
    /// transition comparison against the latest durable document.
    async fn prepare_socket_transition(
        &self,
    ) -> Result<devhub_app_core::PersistedAppState, SettingsErrorWire> {
        let configured_socket = {
            self.settings
                .lock()
                .map_err(|_| SettingsErrorWire::native_unavailable())?
                .loaded
                .config()
                .runtimes
                .tmux_socket_name
                .clone()
        };
        let store = self.transition_store();
        let mut state = self.load_transition_state(&store)?;
        let required = self
            ._terminal_runtime
            .required_terminal_set(&state)
            .map_err(|_| SettingsErrorWire::runtime_unavailable())?;

        match state.tmux.transition {
            SocketTransitionState::Stable | SocketTransitionState::Pending { .. } => {
                let before = state.tmux.transition.clone();
                state
                    .tmux
                    .request_socket_change(configured_socket, required)
                    .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                if state.tmux.transition != before {
                    self.save_transition_state(&store, &before, &state)?;
                }
            }
            SocketTransitionState::CleaningOld { .. }
            | SocketTransitionState::OldCleaned { .. }
            | SocketTransitionState::RecreationPending { .. } => {}
        }

        // At most one probe and one inventory pass are needed for this
        // snapshot. A changed transition is left for the next call rather
        // than allowing a stale provider result to overwrite it.
        state = self.load_transition_state(&store)?;
        let requested = match &state.tmux.transition {
            SocketTransitionState::Pending { requested_socket_name, .. } => {
                requested_socket_name.clone()
            }
            _ => return Ok(state),
        };
        if self._terminal_runtime.adapter_available() {
            let socket =
                SocketName::new(requested).map_err(|_| SettingsErrorWire::runtime_unavailable())?;
            let cancel = self.transition_cancel()?;
            let result = self
                ._terminal_runtime
                .preflight(socket, cancel)
                .await
                .map_err(Self::socket_port_error)?;
            let latest = self.load_transition_state(&store)?;
            if latest.tmux.transition == state.tmux.transition {
                let mut next = latest;
                next.tmux
                    .record_target_preflight(result.state())
                    .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                if next.tmux.transition != state.tmux.transition {
                    self.save_transition_state(&store, &state.tmux.transition, &next)?;
                }
            }
        }

        state = self.load_transition_state(&store)?;
        let (old_socket, target_state, already_verified) = match &state.tmux.transition {
            SocketTransitionState::Pending { preflight, verified_old_sessions, .. } => (
                state.tmux.effective_socket_name.clone(),
                *preflight,
                verified_old_sessions.is_some(),
            ),
            _ => return Ok(state),
        };
        if !already_verified
            && matches!(
                target_state,
                SocketTargetPreflightState::TargetAbsent
                    | SocketTargetPreflightState::TargetDevhubEmpty
            )
            && self._terminal_runtime.adapter_available()
        {
            let old_socket = SocketName::new(old_socket)
                .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
            let cancel = self.transition_cancel()?;
            let inventory = self
                ._terminal_runtime
                .inspect_owned_sessions(old_socket, cancel)
                .await
                .map_err(Self::socket_port_error)?;
            let latest = self.load_transition_state(&store)?;
            if latest.tmux.transition == state.tmux.transition {
                let mut next = latest;
                next.tmux
                    .record_verified_old_sessions(inventory.sessions().to_owned())
                    .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                if next.tmux.transition != state.tmux.transition {
                    self.save_transition_state(&store, &state.tmux.transition, &next)?;
                } else {
                    // Preserve the exact loaded state when the inspection is
                    // an idempotent no-op; no cursor bump is needed.
                }
                state = next;
            } else {
                state = latest;
            }
        }
        Ok(state)
    }

    fn bump_settings_sequence(&self) -> Result<(), SettingsErrorWire> {
        let mut settings =
            self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        Self::advance_settings_sequence(&mut settings)
    }

    fn socket_request_is_current(
        &self,
        request: &SettingsSocketChangeRequestWire,
    ) -> Result<(), SettingsErrorWire> {
        let settings = self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        if settings.sequence != request.sequence
            || settings.loaded.revision().to_string() != request.revision
        {
            return Err(SettingsErrorWire::stale_socket_change());
        }
        Ok(())
    }

    fn save_transition_state(
        &self,
        store: &JsonStateStore,
        expected: &SocketTransitionState,
        state: &devhub_app_core::PersistedAppState,
    ) -> Result<(), SettingsErrorWire> {
        {
            let _commit =
                self.state_commit.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
            let mut latest =
                store.load_or_default().map_err(|_| SettingsErrorWire::invalid_file())?;
            if latest.tmux.transition != *expected {
                return Err(SettingsErrorWire::stale_socket_change());
            }
            latest.tmux = state.tmux.clone();
            store.save_state(&latest).map_err(|_| SettingsErrorWire::invalid_file())?;
        }
        self.bump_settings_sequence()
    }

    fn target_for_session(
        state: &devhub_app_core::PersistedAppState,
        session: &devhub_app_core::state::OwnedSessionRecord,
    ) -> Result<TerminalTarget, SettingsErrorWire> {
        match session {
            devhub_app_core::state::OwnedSessionRecord::Scratch { .. } => {
                Ok(TerminalTarget::scratch())
            }
            devhub_app_core::state::OwnedSessionRecord::Workspace { workspace_id, .. } => {
                let workspace = state
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.workspace_id == *workspace_id)
                    .ok_or_else(SettingsErrorWire::runtime_unavailable)?;
                let id = devhub_app_core::WorkspaceId::from_uuid(workspace.workspace_id.clone())
                    .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                let root = devhub_app_core::WorkspaceRoot::new(workspace.canonical_path.clone())
                    .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                Ok(TerminalTarget::workspace(id, root))
            }
        }
    }

    fn socket_port_error(error: devhub_app_core::PortError) -> SettingsErrorWire {
        match error.code() {
            PortErrorCode::Cancelled => SettingsErrorWire::native_unavailable(),
            PortErrorCode::Conflict
            | PortErrorCode::Unavailable
            | PortErrorCode::Incompatible
            | PortErrorCode::TimedOut
            | PortErrorCode::Failed => SettingsErrorWire::runtime_unavailable(),
        }
    }

    /// Rechecks the target and the complete exact old inventory immediately
    /// before the first destructive cleanup command.  A changed cursor is
    /// written back as Pending and reported as stale; the caller therefore
    /// never kills anything based on an obsolete confirmation sheet.
    async fn revalidate_before_first_cleanup(
        &self,
        store: &JsonStateStore,
        snapshot: &devhub_app_core::PersistedAppState,
    ) -> Result<(), SettingsErrorWire> {
        let (
            old_socket_name,
            requested_socket_name,
            expected_preflight,
            expected_sessions,
            all_pending,
        ) = match &snapshot.tmux.transition {
            SocketTransitionState::CleaningOld {
                old_socket_name,
                requested_socket_name,
                target_preflight,
                sessions,
                ..
            } => {
                let all_pending =
                    sessions.iter().all(|record| record.status == CleanupSessionStatus::Pending);
                (
                    old_socket_name.clone(),
                    requested_socket_name.clone(),
                    *target_preflight,
                    if all_pending {
                        sessions.iter().map(|record| record.session.clone()).collect()
                    } else {
                        Vec::new()
                    },
                    all_pending,
                )
            }
            _ => return Ok(()),
        };
        let requested = SocketName::new(requested_socket_name)
            .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
        let preflight_cancel = self.transition_cancel()?;
        let fresh_preflight = self
            ._terminal_runtime
            .transition_preflight(requested, preflight_cancel)
            .await
            .map_err(Self::socket_port_error)?
            .state();

        let same_transition =
            |store: &JsonStateStore,
             expected: &devhub_app_core::PersistedAppState|
             -> Result<devhub_app_core::PersistedAppState, SettingsErrorWire> {
                let latest = self.load_transition_state(store)?;
                if latest.tmux.transition != expected.tmux.transition {
                    return Err(SettingsErrorWire::stale_socket_change());
                }
                Ok(latest)
            };

        if fresh_preflight != expected_preflight {
            if !all_pending {
                let mut latest = same_transition(store, snapshot)?;
                latest
                    .tmux
                    .update_cleaning_target_preflight(fresh_preflight)
                    .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                self.save_transition_state(store, &snapshot.tmux.transition, &latest)?;
                if matches!(
                    fresh_preflight,
                    SocketTargetPreflightState::TargetAbsent
                        | SocketTargetPreflightState::TargetDevhubEmpty
                ) {
                    // A partial cleanup may continue across the two safe
                    // valid target states; no destructive target is adopted.
                    return Ok(());
                }
                // Persist the conflict cursor so Settings can show a typed
                // pause. A later valid probe changes this cursor again and
                // resumes instead of remaining permanently stale.
                return Err(SettingsErrorWire::stale_socket_change());
            }
            let mut latest = same_transition(store, snapshot)?;
            latest
                .tmux
                .return_cleaning_to_pending(fresh_preflight, None)
                .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
            self.save_transition_state(store, &snapshot.tmux.transition, &latest)?;
            return Err(SettingsErrorWire::stale_socket_change());
        }
        if !matches!(
            fresh_preflight,
            SocketTargetPreflightState::TargetAbsent
                | SocketTargetPreflightState::TargetDevhubEmpty
        ) {
            if !all_pending {
                return Err(SettingsErrorWire::stale_socket_change());
            }
            let mut latest = same_transition(store, snapshot)?;
            latest
                .tmux
                .return_cleaning_to_pending(fresh_preflight, None)
                .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
            self.save_transition_state(store, &snapshot.tmux.transition, &latest)?;
            return Err(SettingsErrorWire::stale_socket_change());
        }

        if !all_pending {
            return Ok(());
        }
        let old_socket = SocketName::new(old_socket_name)
            .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
        let inventory_cancel = self.transition_cancel()?;
        let fresh_sessions = match self
            ._terminal_runtime
            .transition_inspect_owned_sessions(old_socket, inventory_cancel)
            .await
        {
            Ok(inventory) => inventory.sessions().to_owned(),
            Err(error) if error.code() == PortErrorCode::Conflict => {
                let mut latest = same_transition(store, snapshot)?;
                latest
                    .tmux
                    .return_cleaning_to_pending(fresh_preflight, None)
                    .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                self.save_transition_state(store, &snapshot.tmux.transition, &latest)?;
                return Err(SettingsErrorWire::stale_socket_change());
            }
            Err(error) => return Err(Self::socket_port_error(error)),
        };
        let expected_set = expected_sessions.into_iter().collect::<std::collections::BTreeSet<_>>();
        let fresh_set = fresh_sessions.iter().cloned().collect::<std::collections::BTreeSet<_>>();
        if expected_set != fresh_set {
            let mut latest = same_transition(store, snapshot)?;
            latest
                .tmux
                .return_cleaning_to_pending(fresh_preflight, Some(fresh_sessions))
                .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
            self.save_transition_state(store, &snapshot.tmux.transition, &latest)?;
            return Err(SettingsErrorWire::stale_socket_change());
        }
        Ok(())
    }

    /// Resumes every persisted post-confirmation phase. Each provider call is
    /// outside durable-state access; after it completes the latest state is
    /// reloaded and the exact transition/status is compared before commit.
    async fn resume_socket_transition(
        &self,
        confirmed: bool,
    ) -> Result<devhub_app_core::PersistedAppState, SettingsErrorWire> {
        let store = self.transition_store();
        // Hold a logical runtime-level write lease across the complete
        // confirmed transition. The gate's mutex is only held while the
        // permit is acquired/released; provider and store I/O remain
        // outside every mutex.
        let transition_cancel = self.transition_cancel()?;
        let _runtime_lease = self
            ._terminal_runtime
            .begin_transition(&transition_cancel)
            .map_err(Self::socket_port_error)?;
        // A confirmed or startup-resumed socket transition may close or
        // recreate tmux sessions. Reap every PTY client before touching that
        // ownership state; the tmux sessions themselves remain managed by the
        // transition provider.
        self._terminal_runtime.detach_all_surfaces();
        loop {
            let mut state = self.load_transition_state(&store)?;
            match &state.tmux.transition {
                SocketTransitionState::Stable => {
                    self.reconcile_deferred_config()?;
                    return self.load_transition_state(&store);
                }
                SocketTransitionState::Pending {
                    preflight,
                    verified_old_sessions: Some(_),
                    ..
                } if confirmed
                    && matches!(
                        preflight,
                        SocketTargetPreflightState::TargetAbsent
                            | SocketTargetPreflightState::TargetDevhubEmpty
                    ) =>
                {
                    let before = state.tmux.transition.clone();
                    state
                        .tmux
                        .start_cleaning_old()
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                    let latest = self.load_transition_state(&store)?;
                    if latest.tmux.transition != before {
                        return Err(SettingsErrorWire::stale_socket_change());
                    }
                    self.save_transition_state(&store, &before, &state)?;
                }
                SocketTransitionState::Pending { .. } => {
                    return Err(SettingsErrorWire::runtime_unavailable())
                }
                SocketTransitionState::CleaningOld { .. } => {
                    let initial_state = state.clone();
                    self.revalidate_before_first_cleanup(&store, &initial_state).await?;
                    state = self.load_transition_state(&store)?;
                    let (old_socket_name, sessions) = match &state.tmux.transition {
                        SocketTransitionState::CleaningOld {
                            old_socket_name, sessions, ..
                        } => (old_socket_name.clone(), sessions.clone()),
                        _ => return Err(SettingsErrorWire::stale_socket_change()),
                    };
                    let old_socket = SocketName::new(old_socket_name.clone())
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                    for record in sessions {
                        if matches!(
                            record.status,
                            CleanupSessionStatus::Completed | CleanupSessionStatus::Conflict
                        ) {
                            continue;
                        }
                        let result = self
                            ._terminal_runtime
                            .transition_close_owned_session(
                                old_socket.clone(),
                                record.session.clone(),
                                self.transition_cancel()?,
                            )
                            .await;
                        if let Err(error) = &result {
                            if error.code() == PortErrorCode::Cancelled {
                                return Err(Self::socket_port_error(*error));
                            }
                        }
                        let latest = self.load_transition_state(&store)?;
                        if !matches!(
                            latest.tmux.transition,
                            SocketTransitionState::CleaningOld { .. }
                        ) {
                            return Err(SettingsErrorWire::stale_socket_change());
                        }
                        let mut next = latest;
                        let expected_transition = next.tmux.transition.clone();
                        next.tmux
                            .mark_old_session(
                                record.session.session_name(),
                                if result.is_ok() {
                                    CleanupSessionStatus::Completed
                                } else {
                                    CleanupSessionStatus::Failed
                                },
                            )
                            .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                        self.save_transition_state(&store, &expected_transition, &next)?;
                    }
                    let mut latest = self.load_transition_state(&store)?;
                    let inventory_cancel = self.transition_cancel()?;
                    let fresh_inventory = self
                        ._terminal_runtime
                        .transition_inspect_owned_sessions(old_socket, inventory_cancel)
                        .await
                        .map_err(Self::socket_port_error)?;
                    if !matches!(latest.tmux.transition, SocketTransitionState::CleaningOld { .. })
                    {
                        return Err(SettingsErrorWire::stale_socket_change());
                    }
                    let expected_transition = latest.tmux.transition.clone();
                    let changed = latest
                        .tmux
                        .reconcile_old_sessions(fresh_inventory.sessions().to_owned())
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                    if changed {
                        self.save_transition_state(&store, &expected_transition, &latest)?;
                    }
                    let failed = matches!(
                        latest.tmux.transition,
                        SocketTransitionState::CleaningOld { ref sessions, .. }
                            if sessions.iter().any(|record| record.status == CleanupSessionStatus::Failed)
                    );
                    if failed {
                        return Ok(latest);
                    }
                    let conflict = matches!(
                        latest.tmux.transition,
                        SocketTransitionState::CleaningOld { ref sessions, .. }
                            if sessions.iter().any(|record| record.status == CleanupSessionStatus::Conflict)
                    );
                    if conflict {
                        return Ok(latest);
                    }
                    let complete = matches!(
                        latest.tmux.transition,
                        SocketTransitionState::CleaningOld { ref sessions, .. }
                            if sessions.iter().all(|record| record.status == CleanupSessionStatus::Completed)
                    );
                    if !complete {
                        continue;
                    }
                    let expected_transition = latest.tmux.transition.clone();
                    latest
                        .tmux
                        .finish_old_cleanup()
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                    self.save_transition_state(&store, &expected_transition, &latest)?;
                }
                SocketTransitionState::OldCleaned { .. } => {
                    let new_socket_name = match &state.tmux.transition {
                        SocketTransitionState::OldCleaned { new_socket_name, .. } => {
                            new_socket_name.clone()
                        }
                        _ => unreachable!("transition matched OldCleaned"),
                    };
                    let target = SocketName::new(new_socket_name.clone())
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                    let preflight = self
                        ._terminal_runtime
                        .transition_preflight(target, self.transition_cancel()?)
                        .await
                        .map_err(Self::socket_port_error)?
                        .state();
                    if !matches!(
                        preflight,
                        SocketTargetPreflightState::TargetAbsent
                            | SocketTargetPreflightState::TargetDevhubEmpty
                    ) {
                        // The old socket is already proven clean, so keep the
                        // durable OldCleaned cursor and wait for the target
                        // conflict to be resolved. Never adopt or mutate a
                        // marked/wrong-marker target here.
                        return Err(SettingsErrorWire::stale_socket_change());
                    }
                    let latest = self.load_transition_state(&store)?;
                    if latest.tmux.transition != state.tmux.transition {
                        return Err(SettingsErrorWire::stale_socket_change());
                    }
                    let expected_transition = state.tmux.transition.clone();
                    state
                        .tmux
                        .commit_new_socket()
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                    self.save_transition_state(&store, &expected_transition, &state)?;
                    self._terminal_runtime
                        .set_effective_socket(
                            SocketName::new(new_socket_name)
                                .map_err(|_| SettingsErrorWire::runtime_unavailable())?,
                        )
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                }
                SocketTransitionState::RecreationPending {
                    effective_socket_name,
                    sessions,
                    ..
                } => {
                    let socket = SocketName::new(effective_socket_name.clone())
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                    let sessions = sessions.clone();
                    for record in sessions {
                        if record.status == RecreationSessionStatus::Completed {
                            continue;
                        }
                        let target = Self::target_for_session(&state, &record.session)?;
                        let result = self
                            ._terminal_runtime
                            .transition_ensure_on_socket(
                                socket.clone(),
                                target,
                                self.transition_cancel()?,
                            )
                            .await;
                        if let Err(error) = &result {
                            if error.code() == PortErrorCode::Cancelled {
                                return Err(Self::socket_port_error(*error));
                            }
                        }
                        let latest = self.load_transition_state(&store)?;
                        if !matches!(
                            latest.tmux.transition,
                            SocketTransitionState::RecreationPending { .. }
                        ) {
                            return Err(SettingsErrorWire::stale_socket_change());
                        }
                        let mut next = latest;
                        let expected_transition = next.tmux.transition.clone();
                        next.tmux
                            .mark_recreated(
                                record.session.session_name(),
                                if result.is_ok() {
                                    RecreationSessionStatus::Completed
                                } else {
                                    RecreationSessionStatus::Failed
                                },
                            )
                            .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                        self.save_transition_state(&store, &expected_transition, &next)?;
                    }
                    let mut latest = self.load_transition_state(&store)?;
                    let complete = matches!(
                        latest.tmux.transition,
                        SocketTransitionState::RecreationPending { ref sessions, .. }
                            if sessions.iter().all(|record| record.status == RecreationSessionStatus::Completed)
                    );
                    if !complete {
                        return Ok(latest);
                    }
                    let expected_transition = latest.tmux.transition.clone();
                    latest
                        .tmux
                        .finish_recreation()
                        .map_err(|_| SettingsErrorWire::runtime_unavailable())?;
                    self.save_transition_state(&store, &expected_transition, &latest)?;
                }
            }
        }
    }

    /// Startup recovery is deliberately conservative for Pending: it may
    /// refresh a read-only preflight/inventory cursor, but only a confirmed
    /// Settings operation may cross into cleanup. Every already-confirmed
    /// phase resumes automatically after the native runtime is registered.
    async fn resume_startup_socket_transition(
        &self,
    ) -> Result<devhub_app_core::PersistedAppState, SettingsErrorWire> {
        if self
            .socket_transition_busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(SettingsErrorWire::runtime_unavailable());
        }
        let _busy = SocketTransitionGate { busy: &self.socket_transition_busy };
        let prepared = self.prepare_socket_transition().await?;
        if matches!(
            prepared.tmux.transition,
            SocketTransitionState::CleaningOld { .. }
                | SocketTransitionState::OldCleaned { .. }
                | SocketTransitionState::RecreationPending { .. }
        ) || matches!(
            prepared.tmux.transition,
            SocketTransitionState::Pending {
                preflight: SocketTargetPreflightState::TargetAbsent
                    | SocketTargetPreflightState::TargetDevhubEmpty,
                verified_old_sessions: Some(ref sessions),
                ..
            } if sessions.is_empty()
        ) {
            // A startup probe that has already verified a valid target and an
            // exact empty old inventory is non-destructive. It may cross the
            // persisted commit point without asking the user to reconfirm.
            self.diagnostics.emit(DiagnosticEvent::Retry {
                module: diagnostics::Module::Settings,
                code: LogCode::ProviderReconnect,
                attempt: 1,
            });
            self.resume_socket_transition(true).await
        } else {
            Ok(prepared)
        }
    }

    #[cfg(test)]
    async fn apply_socket_change(
        &self,
        request: SettingsSocketChangeRequestWire,
    ) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
        let lifecycle = self.capture_settings_lifecycle_token()?;
        self.apply_socket_change_with_lifecycle(request, lifecycle).await
    }

    async fn apply_socket_change_with_lifecycle(
        &self,
        request: SettingsSocketChangeRequestWire,
        lifecycle: NativeLifecycleToken,
    ) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
        self.validate_settings_lifecycle_token(lifecycle)?;
        if self
            .socket_transition_busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(SettingsErrorWire::runtime_unavailable());
        }
        let _busy = SocketTransitionGate { busy: &self.socket_transition_busy };

        self.socket_request_is_current(&request)?;
        let prepared = self.prepare_socket_transition().await?;
        self.validate_settings_lifecycle_token(lifecycle)?;
        if !request.confirmed {
            return self.settings_snapshot();
        }
        // prepare_socket_transition can perform a provider read and persist a
        // newer cursor.  Recheck the caller's confirmed cursor after that
        // read, immediately before entering the destructive phase.
        self.socket_request_is_current(&request)?;
        if matches!(prepared.tmux.transition, SocketTransitionState::Stable) {
            return Err(SettingsErrorWire::stale_socket_change());
        }
        if request.retry {
            // `retry` is explicit user intent from Settings. The initial
            // confirmation remains a separate event so diagnostics never
            // over-count a first destructive transition as a retry.
            self.diagnostics.emit(DiagnosticEvent::Retry {
                module: diagnostics::Module::Settings,
                code: LogCode::ProviderReconnect,
                attempt: 1,
            });
        }
        let state = self.resume_socket_transition(true).await?;
        self.validate_settings_lifecycle_token(lifecycle)?;
        let _ = state;
        self.settings_snapshot()
    }

    /// Runs fresh adapter probes without holding Settings, persistence, or
    /// coordinator locks. The resulting facts are atomically published as one
    /// projection and are reused by Settings and Copy Diagnostics.
    fn recheck_runtime_health(&self) -> RuntimeHealthProbe {
        let config = self.startup_runtime_config.clone();
        let shell = if self._runtime_context.recheck_login_shell(&config.shell) {
            SettingsRuntimeHealthValueWire::Healthy
        } else {
            SettingsRuntimeHealthValueWire::Failed
        };
        let git = if self._runtime_context.recheck_command(&config.git, "--version") {
            SettingsRuntimeHealthValueWire::Healthy
        } else {
            SettingsRuntimeHealthValueWire::Unavailable
        };
        let tmux = if self._terminal_runtime.recheck_health() {
            SettingsRuntimeHealthValueWire::Healthy
        } else {
            SettingsRuntimeHealthValueWire::Unavailable
        };
        let herdr = match self.agent_runtime.recheck_health().runtime_health() {
            RuntimeHealth::Healthy => SettingsRuntimeHealthValueWire::Healthy,
            RuntimeHealth::Starting => SettingsRuntimeHealthValueWire::Starting,
            RuntimeHealth::Degraded => SettingsRuntimeHealthValueWire::Degraded,
            RuntimeHealth::Unavailable => SettingsRuntimeHealthValueWire::Unavailable,
            RuntimeHealth::Failed => SettingsRuntimeHealthValueWire::Failed,
        };
        let editor = self.editor_host.recheck_health();
        let bridge = self.bridge_sink.recheck_health();
        let diagnostics = if self.diagnostics.flush(Duration::from_secs(2)) {
            self.diagnostics.health()
        } else {
            DiagnosticHealth::Degraded
        };
        let probe = RuntimeHealthProbe { shell, git, tmux, herdr, editor, bridge, diagnostics };
        if !probe.all_available() {
            self.diagnostics.emit(DiagnosticEvent::Health {
                component: diagnostics::Component::Settings,
                health: DiagnosticHealth::Degraded,
                code: Some(LogCode::RuntimeUnavailable),
            });
        } else {
            self.diagnostics.emit(DiagnosticEvent::Health {
                component: diagnostics::Component::Settings,
                health: DiagnosticHealth::Healthy,
                code: None,
            });
        }
        if !probe.all_available() {
            self.diagnostics.emit(DiagnosticEvent::Retry {
                module: DiagnosticModule::Settings,
                code: LogCode::RuntimeUnavailable,
                attempt: 1,
            });
        }
        if probe.herdr != SettingsRuntimeHealthValueWire::Healthy {
            self.diagnostics.emit(DiagnosticEvent::ProviderExit {
                component: diagnostics::Component::Agent,
                code: LogCode::ProviderExited,
            });
        }
        if probe.tmux != SettingsRuntimeHealthValueWire::Healthy {
            self.diagnostics.emit(DiagnosticEvent::ProviderExit {
                component: diagnostics::Component::Terminal,
                code: LogCode::TerminalDisconnected,
            });
        }
        if !probe.editor {
            self.diagnostics.emit(DiagnosticEvent::ProviderExit {
                component: diagnostics::Component::Editor,
                code: LogCode::EditorDisconnected,
            });
        }
        if !probe.bridge {
            self.diagnostics.emit(DiagnosticEvent::ProviderExit {
                component: diagnostics::Component::Bridge,
                code: LogCode::BridgeDisconnected,
            });
        }
        if let Ok(mut current) = self.runtime_health_probe.lock() {
            *current = Some(probe);
        }
        probe
    }

    fn settings_snapshot(&self) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
        // Snapshot projection is read-only.  Provider inspection and Pending
        // cursor mutation belong exclusively to the serialized Apply command;
        // watcher/recheck calls must not race that operation or silently move
        // a transition forward.
        let persisted = self.load_transition_state(&self.transition_store())?;
        let settings = self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        let mut effective_runtime = self.startup_runtime_config.clone();
        effective_runtime.tmux_socket_name = persisted.tmux.effective_socket_name.clone();
        let view = settings.loaded.config().runtime_view(
            classify_runtime(&self.startup_runtime_config),
            effective_runtime,
            self.startup_import_login_environment,
        );
        let mut health = SettingsRuntimeHealthWire::unavailable();
        health.shell = match self._runtime_context.login_environment_status() {
            LoginEnvironmentStatus::Ambient => {
                devhub_app_core::SettingsRuntimeHealthValueWire::Unavailable
            }
            LoginEnvironmentStatus::Imported => {
                devhub_app_core::SettingsRuntimeHealthValueWire::Healthy
            }
            LoginEnvironmentStatus::Failed(_) => {
                devhub_app_core::SettingsRuntimeHealthValueWire::Failed
            }
        };
        health.git = if self._runtime_context.resolve(&self.startup_runtime_config.git).is_ok() {
            devhub_app_core::SettingsRuntimeHealthValueWire::Healthy
        } else {
            devhub_app_core::SettingsRuntimeHealthValueWire::Unavailable
        };
        health.tmux = if self._terminal_runtime.adapter_available() {
            devhub_app_core::SettingsRuntimeHealthValueWire::Healthy
        } else {
            devhub_app_core::SettingsRuntimeHealthValueWire::Unavailable
        };
        health.herdr = match self.agent_runtime.health().runtime_health() {
            RuntimeHealth::Healthy => devhub_app_core::SettingsRuntimeHealthValueWire::Healthy,
            RuntimeHealth::Starting => devhub_app_core::SettingsRuntimeHealthValueWire::Starting,
            RuntimeHealth::Degraded => devhub_app_core::SettingsRuntimeHealthValueWire::Degraded,
            RuntimeHealth::Unavailable => {
                devhub_app_core::SettingsRuntimeHealthValueWire::Unavailable
            }
            RuntimeHealth::Failed => devhub_app_core::SettingsRuntimeHealthValueWire::Failed,
        };
        health.inspection_available = self._terminal_runtime.adapter_available();
        let probe = self.runtime_health_probe.lock().ok().and_then(|current| *current);
        if let Some(probe) = probe {
            health.shell = probe.shell;
            health.git = probe.git;
            health.tmux = probe.tmux;
            health.herdr = probe.herdr;
            health.inspection_available = probe.tmux == SettingsRuntimeHealthValueWire::Healthy;
        }
        let diagnostic_health = probe.map_or_else(
            || {
                if health.tmux == SettingsRuntimeHealthValueWire::Healthy {
                    self.diagnostics.health()
                } else {
                    DiagnosticHealth::Degraded
                }
            },
            |probe| {
                if probe.all_available() {
                    probe.diagnostics
                } else {
                    DiagnosticHealth::Degraded
                }
            },
        );
        let runtime = SettingsRuntimeWire::from_runtime_view(
            &view,
            &persisted.tmux,
            health,
            self._terminal_runtime.adapter_available(),
        );
        let diagnostic_view =
            self.diagnostics.view(diagnostic_health, self.diagnostics.previous_exit());
        Ok(SettingsSnapshotWire::from_loaded(
            &settings.loaded,
            settings.sequence,
            runtime,
            settings.diagnostic.clone(),
            SettingsDiagnosticsWire {
                session_id: diagnostic_view.session_id,
                log_directory: diagnostic_view.log_directory,
                log_level: match diagnostic_view.log_level {
                    diagnostics::LogLevel::Info => SettingsLogLevelWire::Info,
                    diagnostics::LogLevel::Debug => SettingsLogLevelWire::Debug,
                },
                previous_exit: match diagnostic_view.previous_exit {
                    DiagnosticPreviousExit::Clean => SettingsPreviousExitWire::Clean,
                    DiagnosticPreviousExit::Unclean => SettingsPreviousExitWire::Unclean,
                    DiagnosticPreviousExit::Unknown => SettingsPreviousExitWire::Unknown,
                },
                health: match diagnostic_view.health {
                    DiagnosticHealth::Starting => SettingsRuntimeHealthValueWire::Starting,
                    DiagnosticHealth::Healthy => SettingsRuntimeHealthValueWire::Healthy,
                    DiagnosticHealth::Degraded => SettingsRuntimeHealthValueWire::Degraded,
                    DiagnosticHealth::Unavailable => SettingsRuntimeHealthValueWire::Unavailable,
                    DiagnosticHealth::Failed => SettingsRuntimeHealthValueWire::Failed,
                },
                recent_codes: diagnostic_view.recent_codes,
            },
        ))
    }

    fn save_settings(
        &self,
        request: SettingsSaveRequestWire,
    ) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
        request.validate()?;
        let expected_revision = devhub_app_core::parse_revision(&request.revision)
            .ok_or_else(SettingsErrorWire::invalid_config)?;
        let config = request.config.into_config()?;
        let active_transition = matches!(
            self.load_transition_state(&self.transition_store())?.tmux.transition,
            SocketTransitionState::CleaningOld { .. }
                | SocketTransitionState::OldCleaned { .. }
                | SocketTransitionState::RecreationPending { .. }
        );
        if active_transition {
            let configured_socket = self
                .settings
                .lock()
                .map_err(|_| SettingsErrorWire::native_unavailable())?
                .loaded
                .config()
                .runtimes
                .tmux_socket_name
                .clone();
            if config.runtimes.tmux_socket_name != configured_socket {
                return Err(SettingsErrorWire::stale_socket_change());
            }
        }
        let loaded = self.config_store.save(expected_revision, config).map_err(settings_error)?;
        self.apply_loaded_config(loaded)?;
        self.diagnostics.emit(DiagnosticEvent::Health {
            component: diagnostics::Component::Settings,
            health: DiagnosticHealth::Healthy,
            code: Some(LogCode::ConfigReloaded),
        });
        self.settings_snapshot()
    }

    fn reload_settings(&self) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
        match self.config_store.reload() {
            Ok(ReloadOutcome::Unchanged { .. }) => {
                self.clear_config_diagnostic()?;
            }
            Ok(ReloadOutcome::Applied(loaded)) => self.apply_loaded_config(loaded)?,
            Err(error) => {
                self.apply_config_diagnostic(error.diagnostic())?;
                self.diagnostics.emit(DiagnosticEvent::Error {
                    module: DiagnosticModule::Config,
                    code: LogCode::ConfigInvalid,
                });
                return Err(settings_error(error));
            }
        }
        self.diagnostics.emit(DiagnosticEvent::Health {
            component: diagnostics::Component::Config,
            health: DiagnosticHealth::Healthy,
            code: Some(LogCode::ConfigReloaded),
        });
        self.settings_snapshot()
    }

    fn install_config_watcher(&self, app: &AppHandle) -> Result<(), SettingsErrorWire> {
        let handle = app.clone();
        let watcher = self.config_store.watch(Duration::from_millis(150), move |outcome| {
            let Some(state) = handle.try_state::<NativeAppState>() else {
                return;
            };
            if matches!(state.lifecycle.phase(), Phase::Closing | Phase::Quitting | Phase::Quit) {
                return;
            }
            let settings_changed;
            let appearance_changed;
            match outcome {
                Ok(ReloadOutcome::Applied(loaded)) => {
                    match state.apply_loaded_config(loaded) {
                        Ok(()) => {
                            settings_changed = true;
                            appearance_changed = true;
                            emit_agent_profiles(&handle, &state);
                        }
                        Err(_) => {
                            // A valid external edit that races a confirmed
                            // socket transition is retained as a deferred
                            // candidate by apply_loaded_config. Emit the
                            // last-good projection plus its typed conflict
                            // diagnostic instead of silently dropping it.
                            settings_changed = true;
                            appearance_changed = false;
                            emit_agent_profiles(&handle, &state);
                        }
                    }
                }
                Ok(ReloadOutcome::Unchanged { .. }) => {
                    settings_changed = state.clear_config_diagnostic().unwrap_or(false);
                    appearance_changed = false;
                    if settings_changed {
                        emit_agent_profiles(&handle, &state);
                    }
                }
                Err(diagnostic) => {
                    settings_changed = state.apply_config_diagnostic(diagnostic).unwrap_or(false);
                    appearance_changed = false;
                    if settings_changed {
                        emit_agent_profiles(&handle, &state);
                    }
                }
            }
            if settings_changed {
                if let Ok(snapshot) = state.settings_snapshot() {
                    emit_settings_snapshot(&handle, snapshot);
                }
            }
            if appearance_changed {
                emit_app_appearance(&handle, &state);
            }
        });
        let mut slot =
            self.config_watcher.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        *slot = Some(watcher);
        Ok(())
    }
}

fn load_config_profiles(
    config: &devhub_app_core::config::Config,
) -> Result<Vec<DomainAgentProfile>, AppErrorWire> {
    config
        .agent_profiles
        .iter()
        .map(|profile| {
            let id = AgentProfileId::from_slug(profile.id.clone()).map_err(state_error)?;
            let kind = match profile.kind {
                ConfigAgentProfileKind::Codex => AgentProfileKind::Codex,
                ConfigAgentProfileKind::Claude => AgentProfileKind::Claude,
            };
            DomainAgentProfile::new(
                id,
                profile.display_name.clone(),
                kind,
                profile.args.clone(),
                profile.env.clone(),
            )
            .map_err(state_error)
        })
        .collect()
}

#[tauri::command]
fn get_app_snapshot(state: State<'_, NativeAppState>) -> Result<AppSnapshotWire, AppErrorWire> {
    if let Some(error) = state.take_native_error() {
        return Err(error);
    }
    let token = state.capture_open_lifecycle_token()?;
    state.app_snapshot_with_lifecycle(token)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PerformanceMarkerRequest {
    marker: PerformanceMarker,
}

/// Records one of the closed, content-free Q5.2 readiness markers.  The
/// command is a no-op in ordinary launches; the native driver opts in with
/// `DEVHUB_Q5_PERFORMANCE=1` so production diagnostics stay unchanged.
#[tauri::command]
fn record_performance_marker(
    state: State<'_, NativeAppState>,
    payload: PerformanceMarkerRequest,
) -> Result<(), AppErrorWire> {
    state.record_performance_marker(payload.marker)
}

#[tauri::command]
fn get_agent_profiles(state: State<'_, NativeAppState>) -> Result<AgentProfilesWire, AppErrorWire> {
    let token = state.capture_open_lifecycle_token()?;
    state.agent_profiles_with_lifecycle(token)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PickerStartRequest {
    #[serde(default)]
    query: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PickerSelectionRequest {
    path: String,
}

#[tauri::command]
async fn choose_workspace_folder(app: AppHandle) -> Result<Option<String>, AppErrorWire> {
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
fn start_workspace_picker(
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
fn cancel_workspace_picker(state: State<'_, NativeAppState>) -> Result<(), AppErrorWire> {
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
async fn select_workspace_picker(
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

#[tauri::command]
fn get_app_appearance(
    state: State<'_, NativeAppState>,
) -> Result<AppAppearanceWire, SettingsErrorWire> {
    let token = state
        .capture_open_lifecycle_token()
        .map_err(|_| SettingsErrorWire::native_unavailable())?;
    state.app_appearance_with_lifecycle(token)
}

#[tauri::command]
async fn dispatch_app_intent(
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
struct ReplayRequest {
    cursor: u64,
}

#[tauri::command]
fn replay_app_events(
    state: State<'_, NativeAppState>,
    payload: ReplayRequest,
) -> Result<ReplayWire, AppErrorWire> {
    let token = state.capture_open_lifecycle_token()?;
    state.replay_with_lifecycle(token, payload.cursor)
}

#[tauri::command]
fn get_settings_snapshot(
    state: State<'_, NativeAppState>,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    let token = state.capture_settings_lifecycle_token()?;
    state.settings_snapshot_with_lifecycle(token)
}

#[tauri::command]
fn save_settings(
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
fn reload_settings(
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
async fn recheck_settings(
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

fn diagnostics_settings_error(error: diagnostics::ActionError) -> SettingsErrorWire {
    match error {
        diagnostics::ActionError::PermissionDenied => SettingsErrorWire::permission_denied(),
        diagnostics::ActionError::Unavailable => SettingsErrorWire::native_unavailable(),
        diagnostics::ActionError::Busy => SettingsErrorWire::native_busy(),
        diagnostics::ActionError::TimedOut => SettingsErrorWire::native_timed_out(),
    }
}

#[tauri::command]
async fn open_log_folder(
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
async fn copy_diagnostics(
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
async fn terminal_attach(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: AttachRequest,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<AttachReceipt, TerminalError> {
    let webview_label = webview.label().to_owned();
    let surface_key = payload.surface_key.clone();
    terminal_worker(app, move |state, token| {
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
    .await
}

#[tauri::command]
async fn terminal_input(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: InputRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, token| state.terminal_input(&webview_label, payload, token))
        .await
}

#[tauri::command]
async fn terminal_resize(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: ResizeRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, token| state.terminal_resize(&webview_label, payload, token))
        .await
}

#[tauri::command]
async fn terminal_acknowledge(
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
async fn terminal_detach(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: DetachRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, _token| state.terminal_detach(&webview_label, payload)).await
}

#[tauri::command]
async fn agent_surface_attach(
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
async fn agent_surface_input(
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
async fn agent_surface_resize(
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
async fn agent_surface_acknowledge(
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
async fn agent_surface_detach(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: DetachRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state, _token| state.agent_surface_detach(&webview_label, payload))
        .await
}

#[tauri::command]
async fn apply_socket_change(
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
fn open_settings_window(app: AppHandle) -> Result<(), AppErrorWire> {
    show_settings_window(&app).map_err(|_| AppErrorWire::native_unavailable())
}

/// Returns the one main Window, creating it only after the prior instance has
/// been destroyed. The label is stable, so Tauri itself rejects any attempted
/// duplicate and the lifecycle gate prevents reaching that race in normal
/// operation.
fn ensure_app_shell_window(
    app: &AppHandle,
    state: &NativeAppState,
) -> Result<tauri::WebviewWindow<tauri::Wry>, AppErrorWire> {
    if let Some(window) = app.get_webview_window(APP_SHELL_WINDOW_LABEL) {
        return Ok(window);
    }
    let persisted = state.store.load_or_default().map_err(persistence_error)?;
    let frame = safe_restore_frame(persisted.window.frame, &[]);
    WebviewWindowBuilder::new(app, APP_SHELL_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("DevHub")
        .inner_size(f64::from(frame.width), f64::from(frame.height))
        .min_inner_size(900.0, 560.0)
        .position(f64::from(frame.x), f64::from(frame.y))
        .resizable(true)
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 16.0))
        .visible(false)
        .maximized(frame.maximized)
        .build()
        .map_err(|_| AppErrorWire::native_unavailable())
}

fn build_window_menu(
    app: &AppHandle,
    close_accelerator: Option<&str>,
) -> tauri::Result<Menu<tauri::Wry>> {
    let about = PredefinedMenuItem::about(app, Some("About DevHub"), None)?;
    let open_settings =
        MenuItem::with_id(app, OPEN_SETTINGS_MENU_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let hide = PredefinedMenuItem::hide(app, Some("Hide DevHub"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some("Hide Others"))?;
    let show_all = PredefinedMenuItem::show_all(app, Some("Show All"))?;
    // Deliberately click-only. Cmd-Q is owned by the lifecycle event path and
    // must not recursively synthesize another predefined Quit action.
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit DevHub", true, None::<&str>)?;
    let app_menu = Submenu::with_items(
        app,
        "DevHub",
        true,
        &[&about, &open_settings, &hide, &hide_others, &show_all, &quit],
    )?;

    let undo = PredefinedMenuItem::undo(app, Some("Undo"))?;
    let redo = PredefinedMenuItem::redo(app, Some("Redo"))?;
    let cut = PredefinedMenuItem::cut(app, Some("Cut"))?;
    let copy = PredefinedMenuItem::copy(app, Some("Copy"))?;
    let paste = PredefinedMenuItem::paste(app, Some("Paste"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("Select All"))?;
    let edit_menu =
        Submenu::with_items(app, "Edit", true, &[&undo, &redo, &cut, &copy, &paste, &select_all])?;

    let minimize = PredefinedMenuItem::minimize(app, Some("Minimize"))?;
    // The main Window passes no accelerator, leaving Cmd-W for the future
    // command router. The Settings-only window menu passes Cmd-W explicitly.
    let close_window =
        MenuItem::with_id(app, CLOSE_WINDOW_MENU_ID, "Close Window", true, close_accelerator)?;
    let window_menu = Submenu::with_items(app, "Window", true, &[&minimize, &close_window])?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    build_window_menu(app, None)
}

fn build_settings_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    build_window_menu(app, Some("CmdOrCtrl+W"))
}

pub fn run() {
    tauri::Builder::default()
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                OPEN_SETTINGS_MENU_ID => {
                    if let Err(error) = show_settings_window(app) {
                        let _ = error;
                        app.state::<NativeAppState>()
                            .record_native_error(AppErrorWire::native_unavailable());
                    }
                }
                CLOSE_WINDOW_MENU_ID => {
                    let settings = app.get_webview_window(SETTINGS_WINDOW_LABEL);
                    let target = if settings
                        .as_ref()
                        .is_some_and(|window| window.is_focused().unwrap_or(false))
                    {
                        settings.map(|window| window.as_ref().window().clone())
                    } else {
                        app.get_webview_window(APP_SHELL_WINDOW_LABEL)
                            .map(|window| window.as_ref().window().clone())
                    };
                    if let Some(window) = target {
                        if let Err(error) = window.close() {
                            let _ = error;
                            app.state::<NativeAppState>()
                                .record_native_error(AppErrorWire::native_unavailable());
                        }
                    }
                }
                QUIT_MENU_ID => {
                    // ExitRequested performs the single-flight native quit;
                    // this call only asks Tauri to enter that path.
                    app.exit(0);
                }
                _ => {}
            }
        })
        .setup(|app| {
            let home =
                app.path().home_dir().map_err(|error| std::io::Error::other(error.to_string()))?;
            let state = NativeAppState::bootstrap(&home)
                .map_err(|_| std::io::Error::other("DevHub native bootstrap failed"))?;
            app.manage(state);
            #[cfg(target_os = "macos")]
            if let Err(error) = app.state::<NativeAppState>().install_keyboard_monitor(app.handle())
            {
                let _ = error;
                app.state::<NativeAppState>()
                    .record_native_error(AppErrorWire::native_unavailable());
            }
            app.state::<NativeAppState>().install_bridge_router(app.handle());
            app.state::<NativeAppState>()
                .install_config_watcher(app.handle())
                .map_err(|_| std::io::Error::other("DevHub Settings watcher unavailable"))?;
            app.state::<NativeAppState>().start_agent_reconciler(app.handle());
            let startup_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                startup_handle.state::<NativeAppState>().attach_startup_window(&startup_handle);
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<NativeAppState>();
                match state.resume_startup_socket_transition().await {
                    Ok(_) => {
                        if let Ok(snapshot) = state.settings_snapshot() {
                            emit_settings_snapshot(&handle, snapshot);
                        }
                        emit_agent_profiles(&handle, &state);
                    }
                    Err(error) => {
                        let _ = error;
                        state.record_native_error(AppErrorWire::native_unavailable());
                    }
                }
                let resume_handle = handle.clone();
                let resume_result = tauri::async_runtime::spawn_blocking(move || {
                    resume_handle.state::<NativeAppState>().resume_persisted_closing()
                })
                .await;
                match resume_result {
                    Ok(Ok(Some(snapshot))) => {
                        match AppSnapshotWire::from_snapshot(&snapshot, AppReadiness::Ready) {
                            Ok(snapshot) => {
                                if let Err(error) = handle.emit_to(
                                    APP_SHELL_WINDOW_LABEL,
                                    APP_SNAPSHOT_CHANGED_EVENT,
                                    snapshot,
                                ) {
                                    let _ = error;
                                    handle
                                        .state::<NativeAppState>()
                                        .record_native_error(AppErrorWire::native_unavailable());
                                }
                            }
                            Err(error) => handle
                                .state::<NativeAppState>()
                                .record_native_error(state_error(error)),
                        }
                    }
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => handle.state::<NativeAppState>().record_native_error(error),
                    Err(_) => handle
                        .state::<NativeAppState>()
                        .record_native_error(AppErrorWire::native_unavailable()),
                }
            });
            emit_app_appearance(app.handle(), &app.state::<NativeAppState>());
            emit_agent_profiles(app.handle(), &app.state::<NativeAppState>());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != APP_SHELL_WINDOW_LABEL {
                return;
            }
            let app = window.app_handle().clone();
            let state = app.state::<NativeAppState>();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // A stable label is shared by every reconstruction, so
                    // reject events from an older native Window before they
                    // can consume the current close lifecycle.
                    if !state.is_current_native_window(window) {
                        return;
                    }
                    // The only unguarded close is the explicit close issued
                    // after the worker has captured/persisted the frame and
                    // coordinator snapshot. Raw child projections remain
                    // owned until the irreversible Destroyed event.
                    if state.close_allowance_matches(window)
                        || matches!(state.lifecycle.phase(), Phase::Quitting | Phase::Quit)
                    {
                        return;
                    }
                    api.prevent_close();
                    if !state.begin_close_transaction() {
                        return;
                    }
                    let close_generation = state.lifecycle.generation();
                    let Some(close_identity) = state.native_window_identity(window) else {
                        state.abort_close_transaction();
                        return;
                    };
                    let cleanup_token = WindowCleanupToken {
                        handle_key: close_identity.handle_key,
                        lifecycle_generation: close_generation,
                    };
                    if let Ok(mut closing) = state.closing_window.lock() {
                        *closing = Some(close_identity);
                    }
                    if !state.begin_window_cleanup(cleanup_token) {
                        if let Ok(mut closing) = state.closing_window.lock() {
                            *closing = None;
                        }
                        state.abort_close_transaction();
                        state.record_native_error(
                            AppErrorWire::native_unavailable()
                                .with_summary("Window cleanup is already owned"),
                        );
                        return;
                    }
                    let worker_app = app.clone();
                    let worker_window = window.clone();
                    let close_window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = tauri::async_runtime::spawn_blocking(move || {
                            worker_app
                                .state::<NativeAppState>()
                                .close_window_claimed(Some(&worker_window), Some(cleanup_token))
                        })
                        .await;
                        let state = close_window.app_handle().state::<NativeAppState>();
                        if state.lifecycle.generation() != close_generation
                            || state.lifecycle.phase() != Phase::Closing
                            || state.native_window_identity(&close_window) != Some(close_identity)
                        {
                            // Destroyed may have finalized this generation
                            // while the bounded close worker was still in
                            // provider/WebView cleanup. Dock reopen waits for
                            // this token before mounting the replacement.
                            return;
                        }
                        match result {
                            Ok(Ok(())) => {
                                state.set_close_allowance(close_identity);
                                if let Err(error) = close_window.close() {
                                    if let Ok(mut allowance) = state.close_allowance.lock() {
                                        *allowance = None;
                                    }
                                    if let Ok(mut closing) = state.closing_window.lock() {
                                        *closing = None;
                                    }
                                    state.finish_window_cleanup(cleanup_token);
                                    let rollback = state.restore_failed_close();
                                    state.abort_close_transaction();
                                    state.record_native_error(state_error(error));
                                    if let Err(rollback_error) = rollback {
                                        state.record_native_error(rollback_error);
                                    }
                                }
                                // `Destroyed`, not this worker, commits the
                                // Closing -> Closed transition. This guards a
                                // late event from an old Window generation.
                            }
                            Ok(Err(error)) => {
                                if let Ok(mut closing) = state.closing_window.lock() {
                                    *closing = None;
                                }
                                state.finish_window_cleanup(cleanup_token);
                                let rollback = state.restore_failed_close();
                                state.abort_close_transaction();
                                state.record_native_error(error);
                                if let Err(rollback_error) = rollback {
                                    state.record_native_error(rollback_error);
                                }
                            }
                            Err(_) => {
                                if let Ok(mut closing) = state.closing_window.lock() {
                                    *closing = None;
                                }
                                state.finish_window_cleanup(cleanup_token);
                                let rollback = state.restore_failed_close();
                                state.abort_close_transaction();
                                state.record_native_error(AppErrorWire::native_unavailable());
                                if let Err(rollback_error) = rollback {
                                    state.record_native_error(rollback_error);
                                }
                            }
                        }
                    });
                }
                tauri::WindowEvent::Destroyed => {
                    let Some(identity) = state.native_window_identity(window) else {
                        return;
                    };
                    let closing_matches = state
                        .closing_window
                        .lock()
                        .ok()
                        .and_then(|closing| *closing)
                        .is_some_and(|closing| closing == identity);
                    if state.lifecycle.phase() == Phase::Closing && closing_matches {
                        let cleanup_token = WindowCleanupToken {
                            handle_key: identity.handle_key,
                            lifecycle_generation: identity.lifecycle_generation,
                        };
                        let close_was_guarded = state.close_allowance_matches(window);
                        if let Ok(mut allowance) = state.close_allowance.lock() {
                            *allowance = None;
                        }
                        if let Ok(mut closing) = state.closing_window.lock() {
                            *closing = None;
                        }
                        state.clear_native_window_if_current(window);
                        state.finish_close_transaction();
                        state.clear_close_rollback_snapshot();
                        if close_was_guarded || state.window_cleanup_is_current(cleanup_token) {
                            state.start_window_projection_cleanup(&app, cleanup_token);
                        }
                    } else if state.lifecycle.phase() == Phase::Open {
                        // AppKit can destroy a Window without first delivering
                        // CloseRequested (crash-equivalent teardown). The
                        // identity match above proves this is the current
                        // concrete Window; visibility is not a generation
                        // discriminator and is intentionally not consulted.
                        state.clear_native_window_if_current(window);
                        state.mark_unexpected_destroyed_transaction();
                        let cleanup_token = WindowCleanupToken {
                            handle_key: identity.handle_key,
                            lifecycle_generation: identity.lifecycle_generation,
                        };
                        if state.begin_window_cleanup(cleanup_token) {
                            state.start_window_projection_cleanup(&app, cleanup_token);
                        }
                    }
                }
                tauri::WindowEvent::Moved(_) => {
                    if state.lifecycle.phase() == Phase::Open
                        && state.is_current_native_window(window)
                    {
                        state.schedule_window_frame_persist(window);
                    }
                }
                tauri::WindowEvent::Resized(size) if state.lifecycle.phase() == Phase::Open => {
                    if !state.is_current_native_window(window) {
                        return;
                    }
                    let bounds = editor::EditorBounds::new(
                        0.0,
                        0.0,
                        f64::from(size.width.max(1)),
                        f64::from(size.height.max(1)),
                    );
                    if let Ok(mut current) = state.editor_bounds.lock() {
                        *current = bounds;
                    }
                    // WRY marshals child-WebView operations onto the AppKit
                    // thread. Window events already arrive there, so perform
                    // the synchronous host call on a blocking worker to avoid
                    // recursively waiting for the same main-thread queue.
                    let layout_generation = state.lifecycle.generation();
                    let layout_identity = state.native_window_identity(window);
                    let layout_app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Some(state) = layout_app.try_state::<NativeAppState>() {
                            if state.lifecycle.phase() == Phase::Open
                                && state.lifecycle.generation() == layout_generation
                                && layout_identity.is_some_and(|identity| {
                                    state.is_current_native_identity(identity)
                                })
                            {
                                let _ = state.editor_host.set_layout(bounds);
                            }
                        }
                    });
                    state.schedule_window_frame_persist(window);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_snapshot,
            record_performance_marker,
            start_workspace_picker,
            cancel_workspace_picker,
            select_workspace_picker,
            choose_workspace_folder,
            get_app_appearance,
            get_agent_profiles,
            dispatch_app_intent,
            replay_app_events,
            terminal_attach,
            terminal_input,
            terminal_resize,
            terminal_acknowledge,
            terminal_detach,
            agent_surface_attach,
            agent_surface_input,
            agent_surface_resize,
            agent_surface_acknowledge,
            agent_surface_detach,
            get_settings_snapshot,
            save_settings,
            reload_settings,
            recheck_settings,
            open_log_folder,
            copy_diagnostics,
            apply_socket_change,
            open_settings_window
        ])
        .build(tauri::generate_context!())
        .expect("error while building DevHub")
        .run(|app_handle: &AppHandle, event| {
            match event {
                tauri::RunEvent::Reopen { .. } => {
                    let app = app_handle.clone();
                    let worker_app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = tauri::async_runtime::spawn_blocking(move || {
                            worker_app.state::<NativeAppState>().reopen_from_dock(&worker_app)
                        })
                        .await;
                        match result {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                app.state::<NativeAppState>().record_native_error(error)
                            }
                            Err(_) => app
                                .state::<NativeAppState>()
                                .record_native_error(AppErrorWire::native_unavailable()),
                        }
                    });
                }
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    let state = app_handle.state::<NativeAppState>();
                    // The second ExitRequested generated by app.exit is an
                    // explicit allowance, not a recursive shutdown request.
                    if state.exit_allowed.load(Ordering::Acquire) {
                        return;
                    }
                    if !is_explicit_exit_request(code) {
                        api.prevent_exit();
                        return;
                    }
                    api.prevent_exit();
                    if !claim_single_flight(&state.quit_requested) {
                        return;
                    }
                    let app = app_handle.clone();
                    let worker_app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = tauri::async_runtime::spawn_blocking(move || {
                            let window = worker_app
                                .get_webview_window(APP_SHELL_WINDOW_LABEL)
                                .map(|window| window.as_ref().window().clone());
                            worker_app.state::<NativeAppState>().quit_with_window(window.as_ref())
                        })
                        .await;
                        let state = app.state::<NativeAppState>();
                        state.exit_allowed.store(true, Ordering::Release);
                        match result {
                            Ok(Ok(())) => app.exit(0),
                            Ok(Err(error)) => {
                                state.record_native_error(error);
                                app.exit(1);
                            }
                            Err(_) => {
                                state.record_native_error(AppErrorWire::native_unavailable());
                                app.exit(1);
                            }
                        }
                    });
                }
                _ => {}
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{LoginEnvironmentStatus, RuntimeErrorCode};
    use devhub_app_core::state::{
        OwnedSessionRecord, RecreationSessionRecord, RequiredTerminalSet,
    };
    use devhub_app_core::{CancellationToken, SettingsRuntimeHealthValueWire, WorkspaceRoot};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Barrier};

    #[test]
    fn diagnostics_action_errors_keep_distinct_settings_codes() {
        assert_eq!(
            diagnostics_settings_error(diagnostics::ActionError::Unavailable).code,
            devhub_app_core::SettingsErrorCodeWire::NativeUnavailable
        );
        assert_eq!(
            diagnostics_settings_error(diagnostics::ActionError::Busy).code,
            devhub_app_core::SettingsErrorCodeWire::NativeBusy
        );
        assert_eq!(
            diagnostics_settings_error(diagnostics::ActionError::TimedOut).code,
            devhub_app_core::SettingsErrorCodeWire::NativeTimedOut
        );
        assert_eq!(
            diagnostics_settings_error(diagnostics::ActionError::PermissionDenied).code,
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
    fn implicit_last_window_exit_request_keeps_process_dock_reopenable() {
        assert!(!is_explicit_exit_request(None));
        assert!(is_explicit_exit_request(Some(0)));
        assert!(is_explicit_exit_request(Some(1)));
    }

    #[test]
    fn bridge_observation_tracks_clean_busy_and_disconnect_states() {
        let sink = NativeBridgeSink::default();
        let surface = editor::BridgeSurfaceId::from_uuid(
            devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000001")
                .expect("surface id"),
        );
        let workspace =
            devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000002")
                .expect("workspace id");
        let root =
            devhub_app_core::bridge::AbsolutePath::parse("/tmp/devhub").expect("absolute root");
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
        let workspace_id =
            WorkspaceId::from_uuid("00000000-0000-4000-8000-000000000002".to_owned())
                .expect("domain workspace id");
        let observation = sink.editor_observation(&workspace_id).expect("observation");
        assert!(observation.connected && !observation.dirty);
        sink.on_event(BridgeEvent::DirtyChanged {
            surface_id: surface.clone(),
            generation: 1,
            dirty: true,
        });
        assert!(sink.editor_observation(&workspace_id).expect("dirty observation").dirty);
        sink.on_event(BridgeEvent::Disconnected { surface_id: surface, generation: 1 });
        assert!(
            !sink.editor_observation(&workspace_id).expect("disconnected observation").connected
        );
    }

    #[test]
    fn bridge_request_failures_are_handle_scoped_and_keep_newest_tombstones() {
        let sink = NativeBridgeSink::default();
        let surface = editor::BridgeSurfaceId::from_uuid(
            devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000011")
                .expect("surface id"),
        );
        let workspace =
            devhub_app_core::bridge::Uuid::parse("00000000-0000-4000-8000-000000000012")
                .expect("workspace id");
        let root =
            devhub_app_core::bridge::AbsolutePath::parse("/tmp/devhub").expect("absolute root");
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
            let request_message_id = devhub_app_core::bridge::Uuid::parse(format!(
                "00000000-0000-4000-8000-{index:012x}"
            ))
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
        let path = std::env::temp_dir()
            .join(format!("devhub-native-shell-{}-{sequence}", std::process::id()));
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
        let operation = OperationId::from_uuid("00000000-0000-4000-8000-000000000031")
            .expect("test operation ID");
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
            devhub_app_core::state::OwnedSessionRecord::Scratch {
                session_name: "scratch".to_owned(),
            },
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
            devhub_app_core::state::OwnedSessionRecord::Scratch {
                session_name: "scratch".to_owned(),
            },
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
        let initial_log =
            std::fs::read_to_string(state.diagnostics.directory().join("devhub.jsonl"))
                .expect("initial transition diagnostics");
        assert!(!initial_log.lines().any(|line| line.contains("\"event\":\"retry\"")));
        tauri::async_runtime::block_on(state._terminal_runtime.ensure(
            TerminalTarget::scratch(),
            state.transition_cancel().expect("rebind cancellation"),
        ))
        .expect("ordinary runtime uses the committed socket");

        for socket in [old_name, new_name] {
            let _ = ProcessCommand::new(tmux_binary)
                .args(["-L", socket.as_str(), "kill-server"])
                .status();
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
        let old_socket =
            SocketName::new(format!("dh-pending-old-{}-{sequence}", std::process::id()))
                .expect("old socket");
        let new_socket =
            SocketName::new(format!("dh-pending-new-{}-{sequence}", std::process::id()))
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

        let _ = ProcessCommand::new(tmux_binary)
            .args(["-L", new_socket.as_str(), "kill-server"])
            .status();
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
        let old_socket =
            SocketName::new(format!("dh-partial-old-{}-{sequence}", std::process::id()))
                .expect("old socket");
        let new_socket =
            SocketName::new(format!("dh-partial-new-{}-{sequence}", std::process::id()))
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
        let old_after =
            tauri::async_runtime::block_on(state._terminal_runtime.inspect_owned_sessions(
                old_socket.clone(),
                state.transition_cancel().expect("old final inventory cancellation"),
            ))
            .expect("old final inventory");
        assert!(old_after.sessions().is_empty());
        let new_after =
            tauri::async_runtime::block_on(state._terminal_runtime.inspect_owned_sessions(
                new_socket.clone(),
                state.transition_cancel().expect("new final inventory cancellation"),
            ))
            .expect("new final inventory");
        assert_eq!(new_after.sessions().len(), 1);
        assert_eq!(new_after.sessions()[0].session_name(), "scratch");
        assert!(orphan.session_name().starts_with("ws-"));

        for socket in [old_socket, new_socket] {
            let _ = ProcessCommand::new(tmux_binary)
                .args(["-L", socket.as_str(), "kill-server"])
                .status();
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
            let _ = ProcessCommand::new(tmux_binary)
                .args(["-L", socket.as_str(), "kill-server"])
                .status();
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
        std::fs::write(
            state.config_store.path(),
            external.to_toml().expect("external config TOML"),
        )
        .expect("write external config");
        let error = state.reload_settings().expect_err("active transition defers edit");
        assert_eq!(error.code, devhub_app_core::SettingsErrorCodeWire::StaleSocketChange);
        let deferred = state.settings_snapshot().expect("deferred projection");
        assert_eq!(
            deferred.config.runtimes.tmux_socket_name,
            before.config.runtimes.tmux_socket_name
        );
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
                "allow-get-app-snapshot",
                "allow-record-performance-marker",
                "allow-start-workspace-picker",
                "allow-cancel-workspace-picker",
                "allow-select-workspace-picker",
                "allow-choose-workspace-folder",
                "allow-get-app-appearance",
                "allow-get-agent-profiles",
                "allow-dispatch-app-intent",
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
                "allow-open-settings-window"
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
        let source = include_str!("lib.rs");
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
        let source = include_str!("lib.rs");
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
        assert!(
            source.contains("app.emit_to(SETTINGS_WINDOW_LABEL, SETTINGS_CHANGED_EVENT, snapshot)")
        );
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
        // native quit still owns OpenVSCode/app-local cleanup and persists a
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
    fn stale_window_generation_cannot_match_reused_native_handle() {
        let old = NativeWindowIdentity { handle_key: 77, lifecycle_generation: 1 };
        let reopened = NativeWindowIdentity { handle_key: 77, lifecycle_generation: 2 };
        assert!(!native_identity_matches(Some(old), old, 2));
        assert!(!native_identity_matches(Some(reopened), old, 2));
        assert!(native_identity_matches(Some(reopened), reopened, 2));
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
        let token = WindowCleanupToken {
            handle_key: 42,
            lifecycle_generation: state.lifecycle.generation(),
        };
        assert!(state.begin_window_cleanup(token));
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
        state
            .replace_coordinator_locked(replacement, revision)
            .expect("install reopened coordinator");
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
            let workspace_id = WorkspaceId::from_uuid(format!(
                "00000000-0000-4000-8000-{:012x}",
                workspace_index + 1
            ))
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
}
