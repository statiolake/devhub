#![forbid(unsafe_code)]

use std::collections::{BTreeMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    Activity, AgentLaunchResult, AgentProfile as DomainAgentProfile, AgentProfileId,
    AgentProfileKind, AgentStopResult, AppAppearanceWire, AppCoordinator, AppErrorWire,
    AppIntentWire, AppOutcomeWire, AppReadiness, AppSnapshot, AppSnapshotWire, CancellationToken,
    CleanupStep, CloseInspectionInputs, ConfirmationId, CoordinatorEvent, DiagnosticCode, Effect,
    IdGenerator, IntentEnvelope, IntentId, IntentOutcome, JsonStateStore, OperationId,
    OperationToken, PortError, PortErrorCode, ProviderEvent, ProviderEventEnvelope,
    ProviderEventId, ReplayWire, ResourceInspection, SettingsErrorWire, SettingsRuntimeHealthWire,
    SettingsSaveRequestWire, SettingsSnapshotWire, SettingsSocketChangeRequestWire, SurfaceKey,
    SurfaceResolution, TerminalTarget, UserIntent, WorkspaceCleanupResult, WorkspaceId,
    WorkspacePickerEventWire, SETTINGS_SEQUENCE_MAX,
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder};

pub mod agent;
pub mod discovery;
pub mod editor;
mod repository;
mod runtime;
mod terminal;
mod workspace_resolver;
use agent::HerdrAgentRuntime;
use discovery::DiscoveryEngine;
use editor::{
    BridgeEvent, BridgeEventSink, BridgeRequest, BridgeRequestDisposition, BridgeRequestResult,
};
use editor::{EditorHost, EditorHostConfig};
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
pub const APP_WORKSPACE_PICKER_EVENT: &str = "app://workspace-picker";
pub const APP_SHELL_WINDOW_LABEL: &str = "app-shell";
pub const SETTINGS_CHANGED_EVENT: &str = "settings://changed";
pub const SETTINGS_WINDOW_LABEL: &str = "settings";
pub const OPEN_SETTINGS_MENU_ID: &str = "open-settings";
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
        }
    }
}

impl NativeBridgeSink {
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
}

impl BridgeEventSink for NativeBridgeSink {
    fn on_event(&self, event: BridgeEvent) {
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

struct PickerSink {
    app: AppHandle,
    query: String,
    last_sequence: AtomicU64,
}

impl PickerSink {
    fn next_sequence(&self) -> u64 {
        self.last_sequence.fetch_add(1, Ordering::AcqRel).saturating_add(1)
    }

    fn observe_sequence(&self, sequence: u64) {
        let _ = self.last_sequence.fetch_max(sequence, Ordering::AcqRel);
    }
}

impl WorkspaceDiscoverySink for PickerSink {
    fn emit(&self, event: WorkspaceDiscoveryEvent) {
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

struct SettingsProjection {
    loaded: LoadedConfig,
    sequence: u64,
    diagnostic: Option<devhub_app_core::SettingsDiagnosticWire>,
}

struct NativeAppState {
    coordinator: Mutex<AppCoordinator>,
    store: JsonStateStore,
    config_store: ConfigStore,
    settings: Mutex<SettingsProjection>,
    config_watcher: Mutex<Option<devhub_app_core::config::ConfigWatcher>>,
    /// A valid external config edit observed during a confirmed transition.
    /// It is intentionally kept outside `settings.loaded` until the durable
    /// transition reaches Stable, so the Settings projection remains the
    /// last-good value and the ConfigStore revision can be reconciled later.
    deferred_config: Mutex<Option<LoadedConfig>>,
    home: PathBuf,
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
    editor_host: EditorHost,
    profiles: Vec<DomainAgentProfile>,
    bridge_sink: Arc<NativeBridgeSink>,
    picker_cancel: Mutex<Option<CancellationToken>>,
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
    AppErrorWire::native_unavailable().with_summary(error.to_string())
}

fn persistence_error(error: impl std::fmt::Display) -> AppErrorWire {
    AppErrorWire::persistence_degraded().with_summary(error.to_string())
}

fn settings_error(error: devhub_app_core::config::ConfigError) -> SettingsErrorWire {
    SettingsErrorWire::from_config(error)
}

/// Settings snapshots contain user profiles and environment values. They are
/// therefore routed only to the settings webview and never broadcast through
/// the application event bus.
fn emit_settings_snapshot(app: &AppHandle, snapshot: SettingsSnapshotWire) {
    if let Err(error) = app.emit_to(SETTINGS_WINDOW_LABEL, SETTINGS_CHANGED_EVENT, snapshot) {
        eprintln!("DevHub Settings notification unavailable: {error}");
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
                eprintln!("DevHub appearance notification unavailable: {error}");
            }
        }
        Err(error) => eprintln!("DevHub appearance projection unavailable: {error:?}"),
    }
}

impl NativeAppState {
    fn bootstrap(home: &Path) -> Result<Self, AppErrorWire> {
        let store = JsonStateStore::for_home(home);
        let mut persisted = store.mark_starting().map_err(persistence_error)?;
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
        let agent_journal =
            store.path().parent().unwrap_or(home).join("agent-runtime-journal.json");
        let agent_runtime = HerdrAgentRuntime::from_environment_with_journal(
            home,
            &startup_runtime_config.herdr,
            agent_journal,
        )
        .map_err(|_| AppErrorWire::native_unavailable())?;
        let bridge_sink = Arc::new(NativeBridgeSink::default());
        let editor_host = EditorHost::new(
            EditorHostConfig::new(home, None).with_bridge_event_sink(bridge_sink.clone()),
        );
        let model = persisted.hydrate_model(&profiles).map_err(persistence_error)?;
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.mark_ready();
        let persisted_revision = coordinator.snapshot().revision();
        Ok(Self {
            coordinator: Mutex::new(coordinator),
            store,
            config_store,
            settings: Mutex::new(SettingsProjection {
                loaded: loaded_config,
                sequence: 1,
                diagnostic: None,
            }),
            config_watcher: Mutex::new(None),
            deferred_config: Mutex::new(None),
            home: home.to_path_buf(),
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
            editor_host,
            profiles,
            bridge_sink,
            picker_cancel: Mutex::new(None),
        })
    }

    fn install_bridge_router(&self, app: &AppHandle) {
        let app = app.clone();
        let (sender, receiver): (SyncSender<BridgeRequest>, _) = sync_channel(64);
        let worker_app = app.clone();
        std::thread::Builder::new()
            .name("devhub-bridge-router".to_owned())
            .spawn(move || {
                while let Ok(request) = receiver.recv() {
                    let Some(state) = worker_app.try_state::<NativeAppState>() else { break };
                    // A disconnect/timeout event invalidates the generation;
                    // do not run an old request's mutating coordinator intent.
                    if !state.bridge_sink.request_is_live(&request) {
                        continue;
                    }
                    if let Err(error) = state.route_bridge_request(&request) {
                        state.record_native_error(error);
                        if state.bridge_sink.request_is_live(&request) {
                            let _ = state.editor_host.complete_bridge_request(
                                request.handle().clone(),
                                bridge_request_failed_result(),
                            );
                        }
                    }
                }
            })
            .ok();
        self.bridge_sink.install_router(move |request| {
            let Err(error) = sender.try_send(request) else { return };
            let request = match error {
                TrySendError::Full(request) | TrySendError::Disconnected(request) => request,
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
        eprintln!("DevHub native lifecycle error: {error:?}");
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
            self.store.save_state(&state).map_err(persistence_error)?;
            let mut persistence = self.persistence.lock().map_err(state_error)?;
            persistence.persisted_revision =
                persistence.persisted_revision.max(snapshot.revision());
        }
        Ok(())
    }

    fn persist_clean_snapshot(&self, snapshot: &AppSnapshot) -> Result<(), AppErrorWire> {
        let _commit = self.state_commit.lock().map_err(state_error)?;
        let mut state = self.store.load_or_default().map_err(persistence_error)?;
        state.apply_snapshot(snapshot).map_err(persistence_error)?;
        state.mark_clean_shutdown();
        self.store.save_state(&state).map_err(persistence_error)?;
        let mut persistence = self.persistence.lock().map_err(state_error)?;
        persistence.persisted_revision = persistence.persisted_revision.max(snapshot.revision());
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

    fn complete_persistence(
        &self,
        token: OperationToken,
        succeeded: bool,
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
    ) -> Result<IntentOutcome, AppErrorWire> {
        let event = ProviderEvent::WorkspaceCleanupCompleted { token, workspace_id, result };
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

    fn accept_provider_event(&self, event: ProviderEvent) -> Result<IntentOutcome, AppErrorWire> {
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

    fn fail_provider_operation(
        &self,
        token: OperationToken,
    ) -> Result<IntentOutcome, AppErrorWire> {
        self.accept_provider_event(ProviderEvent::OperationFailed { token })
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
        self.profiles.iter().find(|profile| profile.id() == profile_id).cloned().ok_or_else(|| {
            AppErrorWire::native_unavailable().with_summary("agent profile unavailable")
        })
    }

    fn current_snapshot(&self) -> Result<AppSnapshot, AppErrorWire> {
        self.coordinator
            .lock()
            .map(|coordinator| coordinator.snapshot().clone())
            .map_err(state_error)
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
            let operation_id = self
                .id_generator
                .next_operation_id()
                .map_err(|_| AppErrorWire::native_unavailable())?;
            let effects = {
                let mut coordinator = self.coordinator.lock().map_err(state_error)?;
                coordinator
                    .resume_persisted_close(workspace_id, operation_id)
                    .map_err(|error| AppErrorWire::from_error(&error))?;
                Self::drain_effects(&mut coordinator)
            };
            let _ = self.execute_effects(effects)?;
        }
        if !had_workspaces {
            Ok(None)
        } else {
            Ok(Some(self.current_snapshot()?))
        }
    }

    fn execute_effects(&self, effects: Vec<Effect>) -> Result<EffectExecution, AppErrorWire> {
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
            match effect {
                Effect::Noop => {}
                Effect::Detach(reason) => match reason {
                    devhub_app_core::DetachReason::WindowClosed => {
                        self._terminal_runtime.detach_webview(APP_SHELL_WINDOW_LABEL)
                    }
                    devhub_app_core::DetachReason::Quit => {
                        self._terminal_runtime.detach_all_surfaces()
                    }
                },
                Effect::ResolveWorkspacePath { token, path } => {
                    let result = tauri::async_runtime::block_on(
                        self._workspace_resolver.resolve(path, Self::effect_cancel(&token)),
                    );
                    match result {
                        Ok(resolved) => {
                            let outcome =
                                self.accept_provider_event(ProviderEvent::WorkspacePathResolved {
                                    token,
                                    root: resolved.root,
                                    selected_path: resolved.selected_path,
                                });
                            if let Ok(value) = &outcome {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = outcome.err();
                            }
                        }
                        Err(error) => {
                            let completion = self.fail_provider_operation(token);
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
                            let outcome =
                                self.accept_provider_event(ProviderEvent::WorkspaceIdGenerated {
                                    token,
                                    workspace_id,
                                });
                            if let Ok(value) = &outcome {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = outcome.err();
                            }
                        }
                        Err(error) => {
                            let completion = self.fail_provider_operation(token);
                            if first_error.is_none() {
                                first_error = completion.err().or(Some(error));
                            }
                        }
                    }
                }
                Effect::ResolveAgentProfile { token, workspace_id, profile_id } => {
                    match self.profile(&profile_id) {
                        Ok(profile) => {
                            let outcome =
                                self.accept_provider_event(ProviderEvent::ProfileResolved {
                                    token,
                                    workspace_id,
                                    profile,
                                });
                            if let Ok(value) = &outcome {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = outcome.err();
                            }
                        }
                        Err(error) => {
                            let completion = self.fail_provider_operation(token);
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
                            let outcome =
                                self.accept_provider_event(ProviderEvent::AgentIdGenerated {
                                    token,
                                    workspace_id,
                                    agent_id,
                                });
                            if let Ok(value) = &outcome {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = outcome.err();
                            }
                        }
                        Err(error) => {
                            let completion = self.fail_provider_operation(token);
                            if first_error.is_none() {
                                first_error = completion.err().or(Some(error));
                            }
                        }
                    }
                }
                Effect::LaunchAgent { token, workspace_id, agent_id, profile } => {
                    let root = self
                        .current_snapshot()?
                        .workspaces()
                        .iter()
                        .find(|workspace| workspace.id() == &workspace_id)
                        .map(|workspace| workspace.root().clone());
                    let result =
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
                            .map(|_| AgentLaunchResult::Started)
                            .map_err(Self::provider_failure)
                        });
                    let event = ProviderEvent::AgentLaunchCompleted {
                        token,
                        workspace_id,
                        agent_id,
                        result: result.clone().unwrap_or(AgentLaunchResult::Failed {
                            diagnostic: DiagnosticCode::RuntimeUnavailable,
                        }),
                    };
                    let completion = self.accept_provider_event(event);
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
                    let completion =
                        self.accept_provider_event(ProviderEvent::AgentStopCompleted {
                            token,
                            agent_id,
                            result,
                        });
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
                    let completion =
                        self.accept_provider_event(ProviderEvent::AgentTerminationCompleted {
                            token,
                            agent_id,
                            result,
                        });
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
                            let completion = self.accept_provider_event(
                                ProviderEvent::ConfirmationIdGenerated { token, confirmation_id },
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
                                .fail_provider_operation(token)
                                .err()
                                .or_else(|| Some(AppErrorWire::native_unavailable()));
                        }
                        Err(_) => {}
                    }
                }
                Effect::PersistState { token } => {
                    let snapshot = self.current_snapshot()?;
                    let persistence_result = self.persist_snapshot(&snapshot, false);
                    persistence_degraded = persistence_result.is_err();
                    let completion_result =
                        self.complete_persistence(token, persistence_result.is_ok());
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
                    let snapshot = self.current_snapshot()?;
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
                    let completion =
                        self.accept_provider_event(ProviderEvent::WorkspaceInspectionCompleted {
                            token,
                            workspace_id,
                            inspection,
                        });
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
                        let completion =
                            self.accept_provider_event(ProviderEvent::AgentsReconciled {
                                token,
                                reconciliation,
                            });
                        if let Ok(value) = &completion {
                            last_outcome = Some(value.clone());
                        }
                        if first_error.is_none() {
                            first_error = completion.err();
                        }
                    } else if first_error.is_none() {
                        first_error = self.fail_provider_operation(token).err().or_else(|| {
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
                                None => ProviderEvent::AgentExited { token, agent_id },
                            };
                            let completion = self.accept_provider_event(event);
                            if let Ok(value) = &completion {
                                last_outcome = Some(value.clone());
                            }
                            if first_error.is_none() {
                                first_error = completion.err();
                            }
                        }
                        Err(_) if first_error.is_none() => {
                            first_error = self.fail_provider_operation(token).err().or_else(|| {
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
                        .current_snapshot()?
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
                    let completion = self.complete_workspace_cleanup(token, workspace_id, result);
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
                    let completion = self.complete_workspace_cleanup(token, workspace_id, result);
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
                    );
                    if let Ok(value) = &completion {
                        last_outcome = Some(value.clone());
                    }
                    if first_error.is_none() {
                        first_error = completion.err();
                    }
                }
                Effect::CleanupWorkspace { token, workspace_id, step: CleanupStep::Terminal } => {
                    let snapshot = self.current_snapshot()?;
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
                    let completion_result =
                        self.complete_workspace_cleanup(token, workspace_id, result);
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
            if let Ok(mut coordinator) = self.coordinator.lock() {
                pending.extend(Self::drain_effects(&mut coordinator));
            }
        }
        Ok(EffectExecution {
            snapshot: self.current_snapshot()?,
            outcome: last_outcome,
            error: first_error,
            persistence_degraded,
        })
    }

    fn dispatch_lifecycle(
        &self,
        intent: UserIntent,
    ) -> Result<(AppSnapshot, Vec<Effect>), AppErrorWire> {
        let intent_id = self.id_generator.next_intent_id()?;
        let operation_id = self
            .id_generator
            .next_operation_id()
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let mut coordinator = self.coordinator.lock().map_err(state_error)?;
        let outcome = coordinator
            .dispatch_user(IntentEnvelope::with_operation_id(intent_id, operation_id, intent))
            .map_err(|error| AppErrorWire::from_error(&error))?;
        let effects = Self::drain_effects(&mut coordinator);
        Ok((outcome.snapshot().clone(), effects))
    }

    /// A window close detaches the native surface but deliberately leaves the
    /// process lifecycle marked unclean. macOS may keep the application alive
    /// after its last window closes, so this is not a clean quit.
    fn close_window(&self) -> Result<(), AppErrorWire> {
        self._terminal_runtime.detach_webview(APP_SHELL_WINDOW_LABEL);
        let (_, effects) = self.dispatch_lifecycle(UserIntent::WindowClosed)?;
        let execution = self.execute_effects(effects)?;
        if let Some(error) = execution.error {
            return Err(error);
        }
        self.persist_snapshot(&execution.snapshot, true)
    }

    /// A process quit detaches the coordinator, persists its final projection,
    /// and only then marks the durable lifecycle as clean.
    fn quit(&self) -> Result<(), AppErrorWire> {
        self._terminal_runtime.detach_all_surfaces();
        let (_, effects) = self.dispatch_lifecycle(UserIntent::Quit)?;
        let execution = self.execute_effects(effects)?;
        if let Some(error) = execution.error {
            return Err(error);
        }
        self.persist_clean_snapshot(&execution.snapshot)
    }

    fn dispatch_intent(&self, intent: UserIntent) -> Result<(AppOutcomeWire, bool), AppErrorWire> {
        let intent_id = self.id_generator.next_intent_id()?;
        let operation_id = self
            .id_generator
            .next_operation_id()
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let (outcome, before, readiness, effects) = {
            let mut coordinator = self.coordinator.lock().map_err(state_error)?;
            let before = coordinator.snapshot().revision();
            let outcome = coordinator
                .dispatch_user(IntentEnvelope::with_operation_id(intent_id, operation_id, intent))
                .map_err(|error| AppErrorWire::from_error(&error))?;
            let effects = Self::drain_effects(&mut coordinator);
            (outcome, before, coordinator.readiness(), effects)
        };
        let execution = self.execute_effects(effects)?;
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

    fn route_bridge_request(&self, request: &BridgeRequest) -> Result<(), AppErrorWire> {
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
        let result = match self.dispatch_intent(intent) {
            Ok(_) => self
                .bridge_result_for_snapshot(&self.current_snapshot()?)
                .unwrap_or(bridge_request_failed_result()),
            Err(_) => bridge_request_failed_result(),
        };
        if !self.bridge_sink.request_is_live(request) {
            return Ok(());
        }
        self.editor_host
            .complete_bridge_request(request.handle().clone(), result)
            .map_err(state_error)?;
        Ok(())
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
        let mut settings =
            self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        Self::advance_settings_sequence(&mut settings)?;
        settings.loaded = candidate;
        settings.diagnostic = None;
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
    fn resolve_terminal_target(&self, surface_key: &str) -> Result<TerminalTarget, TerminalError> {
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
    ) -> Result<AttachReceipt, TerminalError> {
        validate_attach_request(&request)?;
        let size = TerminalPtySize {
            cols: request.cols,
            rows: request.rows,
            pixel_width: request.pixel_width,
            pixel_height: request.pixel_height,
        };
        let target = self.resolve_terminal_target(&request.surface_key)?;
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
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        validate_input_sequence(request.input_sequence)?;
        let target = self.resolve_terminal_target(&request.surface_key)?;
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
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        let target = self.resolve_terminal_target(&request.surface_key)?;
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
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        validate_input_sequence(request.sequence)?;
        let target = self.resolve_terminal_target(&request.surface_key)?;
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
            self.resume_socket_transition(true).await
        } else {
            Ok(prepared)
        }
    }

    async fn apply_socket_change(
        &self,
        request: SettingsSocketChangeRequestWire,
    ) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
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
        let state = self.resume_socket_transition(true).await?;
        let _ = state;
        self.settings_snapshot()
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
        health.tmux = if self._terminal_runtime.adapter_available() {
            devhub_app_core::SettingsRuntimeHealthValueWire::Healthy
        } else {
            devhub_app_core::SettingsRuntimeHealthValueWire::Unavailable
        };
        health.inspection_available = self._terminal_runtime.adapter_available();
        let runtime = SettingsRuntimeWire::from_runtime_view(
            &view,
            &persisted.tmux,
            health,
            self._terminal_runtime.adapter_available(),
        );
        Ok(SettingsSnapshotWire::from_loaded(
            &settings.loaded,
            settings.sequence,
            runtime,
            settings.diagnostic.clone(),
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
                return Err(settings_error(error));
            }
        }
        self.settings_snapshot()
    }

    fn install_config_watcher(&self, app: &AppHandle) -> Result<(), SettingsErrorWire> {
        let handle = app.clone();
        let watcher = self.config_store.watch(Duration::from_millis(150), move |outcome| {
            let Some(state) = handle.try_state::<NativeAppState>() else {
                return;
            };
            let settings_changed;
            let appearance_changed;
            match outcome {
                Ok(ReloadOutcome::Applied(loaded)) => {
                    match state.apply_loaded_config(loaded) {
                        Ok(()) => {
                            settings_changed = true;
                            appearance_changed = true;
                        }
                        Err(_) => {
                            // A valid external edit that races a confirmed
                            // socket transition is retained as a deferred
                            // candidate by apply_loaded_config. Emit the
                            // last-good projection plus its typed conflict
                            // diagnostic instead of silently dropping it.
                            settings_changed = true;
                            appearance_changed = false;
                        }
                    }
                }
                Ok(ReloadOutcome::Unchanged { .. }) => {
                    settings_changed = state.clear_config_diagnostic().unwrap_or(false);
                    appearance_changed = false;
                }
                Err(diagnostic) => {
                    settings_changed = state.apply_config_diagnostic(diagnostic).unwrap_or(false);
                    appearance_changed = false;
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

    fn open_log_folder(&self) -> Result<(), SettingsErrorWire> {
        let logs = self.home.join("Library").join("Logs").join("DevHub");
        std::fs::create_dir_all(&logs).map_err(|_| SettingsErrorWire::permission_denied())?;
        ProcessCommand::new("open")
            .arg(&logs)
            .status()
            .map_err(|_| SettingsErrorWire::native_unavailable())?
            .success()
            .then_some(())
            .ok_or_else(SettingsErrorWire::native_unavailable)
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
    let coordinator = state.coordinator.lock().map_err(state_error)?;
    AppSnapshotWire::from_snapshot(&coordinator.snapshot(), coordinator.readiness())
        .map_err(state_error)
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
async fn choose_workspace_folder() -> Result<Option<String>, AppErrorWire> {
    tauri::async_runtime::spawn_blocking(|| {
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
    .map_err(|_| AppErrorWire::native_unavailable())?
}

#[tauri::command]
fn start_workspace_picker(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: PickerStartRequest,
) -> Result<String, AppErrorWire> {
    let operation_id =
        state.id_generator.next_operation_id().map_err(|_| AppErrorWire::native_unavailable())?;
    let cancel = CancellationToken::new(operation_id.clone());
    if let Ok(mut previous) = state.picker_cancel.lock() {
        if let Some(previous) = previous.replace(cancel.clone()) {
            previous.cancel();
        }
    }
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
        });
        let sink: Arc<dyn WorkspaceDiscoverySink> = picker_sink.clone();
        let summary = engine.discover(cancel.clone(), sink).await;
        if let Ok(summary) = summary {
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<NativeAppState>();
        state.dispatch_intent(UserIntent::OpenFolder { path })
    })
    .await
    .map_err(|_| AppErrorWire::native_unavailable())??;
    Ok(result.0)
}

#[tauri::command]
fn get_app_appearance(
    state: State<'_, NativeAppState>,
) -> Result<AppAppearanceWire, SettingsErrorWire> {
    state.app_appearance()
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
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<NativeAppState>();
        let (wire, changed) = state.dispatch_intent(intent)?;
        Ok::<_, AppErrorWire>((wire, changed))
    })
    .await
    .map_err(|_| AppErrorWire::native_unavailable())?;
    let (wire, changed) = result?;
    if changed {
        if let Err(error) =
            app.emit_to(APP_SHELL_WINDOW_LABEL, APP_SNAPSHOT_CHANGED_EVENT, wire.snapshot())
        {
            eprintln!("DevHub snapshot notification unavailable: {error}");
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
    let coordinator = state.coordinator.lock().map_err(state_error)?;
    ReplayWire::from_replay(&coordinator.replay_from(payload.cursor), coordinator.readiness())
        .map_err(state_error)
}

#[tauri::command]
fn get_settings_snapshot(
    state: State<'_, NativeAppState>,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    state.settings_snapshot()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: SettingsSaveRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    let snapshot = state.save_settings(payload)?;
    emit_settings_snapshot(&app, snapshot.clone());
    emit_app_appearance(&app, &state);
    Ok(snapshot)
}

#[tauri::command]
fn reload_settings(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: devhub_app_core::SettingsCommandRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    payload.validate()?;
    let before = state.settings_sequence()?;
    match state.reload_settings() {
        Ok(snapshot) => {
            if snapshot.sequence > before {
                emit_settings_snapshot(&app, snapshot.clone());
                emit_app_appearance(&app, &state);
            }
            Ok(snapshot)
        }
        Err(error) => {
            if state.settings_sequence()? > before {
                if let Ok(snapshot) = state.settings_snapshot() {
                    emit_settings_snapshot(&app, snapshot);
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn recheck_settings(
    state: State<'_, NativeAppState>,
    payload: devhub_app_core::SettingsCommandRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    payload.validate()?;
    state.settings_snapshot()
}

#[tauri::command]
fn open_log_folder(
    state: State<'_, NativeAppState>,
    payload: devhub_app_core::SettingsCommandRequestWire,
) -> Result<(), SettingsErrorWire> {
    payload.validate()?;
    state.open_log_folder()
}

async fn terminal_worker<T, F>(app: AppHandle, operation: F) -> Result<T, TerminalError>
where
    T: Send + 'static,
    F: FnOnce(&NativeAppState) -> Result<T, TerminalError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || operation(&app.state::<NativeAppState>()))
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
    terminal_worker(app, move |state| state.terminal_attach(&webview_label, payload, channel)).await
}

#[tauri::command]
async fn terminal_input(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: InputRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state| state.terminal_input(&webview_label, payload)).await
}

#[tauri::command]
async fn terminal_resize(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: ResizeRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state| state.terminal_resize(&webview_label, payload)).await
}

#[tauri::command]
async fn terminal_acknowledge(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: AckRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state| state.terminal_acknowledge(&webview_label, payload)).await
}

#[tauri::command]
async fn terminal_detach(
    app: AppHandle,
    webview: Webview<tauri::Wry>,
    payload: DetachRequest,
) -> Result<(), TerminalError> {
    let webview_label = webview.label().to_owned();
    terminal_worker(app, move |state| state.terminal_detach(&webview_label, payload)).await
}

#[tauri::command]
async fn apply_socket_change(
    state: State<'_, NativeAppState>,
    payload: SettingsSocketChangeRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    payload.validate()?;
    state.apply_socket_change(payload).await
}

fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
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
    .build()
    .map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about = PredefinedMenuItem::about(app, Some("About DevHub"), None)?;
    let open_settings =
        MenuItem::with_id(app, OPEN_SETTINGS_MENU_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let hide = PredefinedMenuItem::hide(app, Some("Hide DevHub"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some("Hide Others"))?;
    let show_all = PredefinedMenuItem::show_all(app, Some("Show All"))?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit DevHub"))?;
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
    let close_window = PredefinedMenuItem::close_window(app, Some("Close Window"))?;
    let window_menu = Submenu::with_items(app, "Window", true, &[&minimize, &close_window])?;
    // The focus-scoped Close Window item closes Settings when it is key while
    // preserving the existing app-shell close lifecycle when the workbench is key.
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

pub fn run() {
    tauri::Builder::default()
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == OPEN_SETTINGS_MENU_ID {
                if let Err(error) = show_settings_window(app) {
                    eprintln!("DevHub Settings window unavailable: {error}");
                }
            }
        })
        .setup(|app| {
            let home =
                app.path().home_dir().map_err(|error| std::io::Error::other(error.to_string()))?;
            let state = NativeAppState::bootstrap(&home)
                .map_err(|_| std::io::Error::other("DevHub native bootstrap failed"))?;
            app.manage(state);
            app.state::<NativeAppState>().install_bridge_router(app.handle());
            app.state::<NativeAppState>()
                .install_config_watcher(app.handle())
                .map_err(|_| std::io::Error::other("DevHub Settings watcher unavailable"))?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<NativeAppState>();
                match state.resume_startup_socket_transition().await {
                    Ok(_) => {
                        if let Ok(snapshot) = state.settings_snapshot() {
                            emit_settings_snapshot(&handle, snapshot);
                        }
                    }
                    Err(error) => {
                        eprintln!("DevHub socket transition resume unavailable: {error:?}");
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
                                    eprintln!(
                                        "DevHub startup snapshot notification unavailable: {error}"
                                    );
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
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "app-shell" && matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle().clone();
                let worker_app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        worker_app.state::<NativeAppState>().close_window()
                    })
                    .await;
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => app.state::<NativeAppState>().record_native_error(error),
                        Err(_) => app
                            .state::<NativeAppState>()
                            .record_native_error(AppErrorWire::native_unavailable()),
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_snapshot,
            start_workspace_picker,
            cancel_workspace_picker,
            select_workspace_picker,
            choose_workspace_folder,
            get_app_appearance,
            dispatch_app_intent,
            replay_app_events,
            terminal_attach,
            terminal_input,
            terminal_resize,
            terminal_acknowledge,
            terminal_detach,
            get_settings_snapshot,
            save_settings,
            reload_settings,
            recheck_settings,
            open_log_folder,
            apply_socket_change
        ])
        .build(tauri::generate_context!())
        .expect("error while building DevHub")
        .run(|app_handle: &AppHandle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
                let app = app_handle.clone();
                let worker_app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        worker_app.state::<NativeAppState>().quit()
                    })
                    .await;
                    match result {
                        Ok(Ok(())) => app.exit(0),
                        Ok(Err(error)) => {
                            app.state::<NativeAppState>().record_native_error(error);
                            app.exit(1);
                        }
                        Err(_) => {
                            app.state::<NativeAppState>()
                                .record_native_error(AppErrorWire::native_unavailable());
                            app.exit(1);
                        }
                    }
                });
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
            },
        ))
        .expect("partial retry after valid target change");
        assert_eq!(
            completed.runtime.socket_change.state,
            devhub_app_core::SettingsSocketTransitionWire::Stable
        );
        assert_eq!(completed.runtime.socket_change.effective_socket_name, new_socket.as_str());
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
        let mut external = before.config.clone().into_config().expect("config model");
        external.runtimes.tmux_socket_name = "devhub-external-target".to_owned();
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
                "allow-start-workspace-picker",
                "allow-cancel-workspace-picker",
                "allow-select-workspace-picker",
                "allow-choose-workspace-folder",
                "allow-get-app-appearance",
                "allow-dispatch-app-intent",
                "allow-replay-app-events",
                "allow-terminal-attach",
                "allow-terminal-input",
                "allow-terminal-resize",
                "allow-terminal-acknowledge",
                "allow-terminal-detach"
            ])
        );
        assert!(app_shell.get("windows").is_none());
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
            "PredefinedMenuItem::close_window",
        ] {
            assert!(source.contains(marker), "native menu marker missing: {marker}");
        }
        assert!(source.contains("index.html?window=settings"));
        assert!(source.contains("get_webview_window(SETTINGS_WINDOW_LABEL)"));
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
