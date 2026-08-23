#![forbid(unsafe_code)]

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::Mutex;
use std::time::Duration;

use devhub_app_core::config::{
    default_config_path, AgentProfileKind as ConfigAgentProfileKind, ConfigDiagnostic, ConfigStore,
    LoadedConfig, ReloadOutcome,
};
use devhub_app_core::{runtime_view_for_config, SettingsRuntimeWire};
use devhub_app_core::{
    AgentProfile as DomainAgentProfile, AgentProfileId, AgentProfileKind, AppAppearanceWire,
    AppCoordinator, AppErrorWire, AppIntentWire, AppOutcomeWire, AppSnapshot, AppSnapshotWire,
    CoordinatorEvent, Effect, IdGenerator, IntentEnvelope, IntentId, JsonStateStore, OperationId,
    OperationToken, PortError, PortErrorCode, ProviderEvent, ProviderEventEnvelope,
    ProviderEventId, ReplayWire, SettingsErrorWire, SettingsRuntimeHealthWire,
    SettingsSaveRequestWire, SettingsSnapshotWire, SettingsSocketChangeRequestWire, UserIntent,
    SETTINGS_SEQUENCE_MAX,
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

mod workspace_resolver;
use workspace_resolver::MacWorkspacePathResolver;

pub const APP_SNAPSHOT_CHANGED_EVENT: &str = "app://snapshot-changed";
pub const APP_APPEARANCE_CHANGED_EVENT: &str = "app://appearance-changed";
pub const APP_SHELL_WINDOW_LABEL: &str = "app-shell";
pub const SETTINGS_CHANGED_EVENT: &str = "settings://changed";
pub const SETTINGS_WINDOW_LABEL: &str = "settings";
pub const OPEN_SETTINGS_MENU_ID: &str = "open-settings";

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
    home: PathBuf,
    persistence: Mutex<PersistenceState>,
    pending_native_error: Mutex<Option<AppErrorWire>>,
    id_generator: NativeIdGenerator,
    _workspace_resolver: MacWorkspacePathResolver,
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
        let persisted = store.mark_starting().map_err(persistence_error)?;
        let config_store = ConfigStore::new(default_config_path(home));
        let loaded_config = config_store.load().map_err(state_error)?;
        let profiles = load_config_profiles(loaded_config.config())?;
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
            home: home.to_path_buf(),
            persistence: Mutex::new(PersistenceState { persisted_revision }),
            pending_native_error: Mutex::new(None),
            id_generator: NativeIdGenerator,
            _workspace_resolver: MacWorkspacePathResolver::new(home),
        })
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
        let mut persistence = self.persistence.lock().map_err(state_error)?;
        if !force && snapshot.revision() <= persistence.persisted_revision {
            return Ok(());
        }
        let mut state = self.store.load_or_default().map_err(persistence_error)?;
        state.apply_snapshot(snapshot).map_err(persistence_error)?;
        self.store.save_state(&state).map_err(persistence_error)?;
        persistence.persisted_revision = persistence.persisted_revision.max(snapshot.revision());
        Ok(())
    }

    fn persist_clean_snapshot(&self, snapshot: &AppSnapshot) -> Result<(), AppErrorWire> {
        let mut persistence = self.persistence.lock().map_err(state_error)?;
        let mut state = self.store.load_or_default().map_err(persistence_error)?;
        state.apply_snapshot(snapshot).map_err(persistence_error)?;
        state.mark_clean_shutdown();
        self.store.save_state(&state).map_err(persistence_error)?;
        persistence.persisted_revision = persistence.persisted_revision.max(snapshot.revision());
        Ok(())
    }

    fn drain_persistence_effects(coordinator: &mut AppCoordinator) -> Vec<OperationToken> {
        coordinator
            .subscribe()
            .into_events()
            .into_iter()
            .filter_map(|event| match event.into_event() {
                CoordinatorEvent::Effect(Effect::PersistState { token }) => Some(token),
                _ => None,
            })
            .collect()
    }

    fn complete_persistence(
        &self,
        token: OperationToken,
        succeeded: bool,
    ) -> Result<(), AppErrorWire> {
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
            .map(|_| ())
            .map_err(|error| AppErrorWire::from_error(&error))
    }

    fn execute_persistence_effects(
        &self,
        snapshot: &AppSnapshot,
        effects: Vec<OperationToken>,
    ) -> Result<(), AppErrorWire> {
        let mut first_error = None;
        for token in effects {
            let persistence_result = self.persist_snapshot(snapshot, false);
            let completion_result = self.complete_persistence(token, persistence_result.is_ok());
            if first_error.is_none() {
                first_error = completion_result.err().or_else(|| persistence_result.err());
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn dispatch_lifecycle(
        &self,
        intent: UserIntent,
    ) -> Result<(AppSnapshot, Vec<OperationToken>), AppErrorWire> {
        let intent_id = self.id_generator.next_intent_id()?;
        let operation_id = self
            .id_generator
            .next_operation_id()
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let mut coordinator = self.coordinator.lock().map_err(state_error)?;
        let outcome = coordinator
            .dispatch_user(IntentEnvelope::with_operation_id(intent_id, operation_id, intent))
            .map_err(|error| AppErrorWire::from_error(&error))?;
        let effects = Self::drain_persistence_effects(&mut coordinator);
        Ok((outcome.snapshot().clone(), effects))
    }

    /// A window close detaches the native surface but deliberately leaves the
    /// process lifecycle marked unclean. macOS may keep the application alive
    /// after its last window closes, so this is not a clean quit.
    fn close_window(&self) -> Result<(), AppErrorWire> {
        let (snapshot, effects) = self.dispatch_lifecycle(UserIntent::WindowClosed)?;
        self.execute_persistence_effects(&snapshot, effects)?;
        self.persist_snapshot(&snapshot, true)
    }

    /// A process quit detaches the coordinator, persists its final projection,
    /// and only then marks the durable lifecycle as clean.
    fn quit(&self) -> Result<(), AppErrorWire> {
        let (snapshot, effects) = self.dispatch_lifecycle(UserIntent::Quit)?;
        self.execute_persistence_effects(&snapshot, effects)?;
        self.persist_clean_snapshot(&snapshot)
    }

    fn dispatch_intent(&self, intent: UserIntent) -> Result<(AppOutcomeWire, bool), AppErrorWire> {
        let intent_id = self.id_generator.next_intent_id()?;
        let operation_id = self
            .id_generator
            .next_operation_id()
            .map_err(|_| AppErrorWire::native_unavailable())?;
        let (outcome, changed, readiness, domain_snapshot, effects) = {
            let mut coordinator = self.coordinator.lock().map_err(state_error)?;
            let before = coordinator.snapshot().revision();
            let outcome = coordinator
                .dispatch_user(IntentEnvelope::with_operation_id(intent_id, operation_id, intent))
                .map_err(|error| AppErrorWire::from_error(&error))?;
            let changed = outcome.snapshot().revision() != before;
            let domain_snapshot = outcome.snapshot().clone();
            let effects = Self::drain_persistence_effects(&mut coordinator);
            (outcome, changed, coordinator.readiness(), domain_snapshot, effects)
        };
        let mut wire = AppOutcomeWire::from_outcome(&outcome, readiness).map_err(state_error)?;
        if changed && self.execute_persistence_effects(&domain_snapshot, effects).is_err() {
            let snapshot = wire.snapshot().clone();
            wire = AppOutcomeWire::PersistenceDegraded { snapshot };
        }
        Ok((wire, changed))
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
        let mut settings =
            self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        Self::advance_settings_sequence(&mut settings)?;
        settings.loaded = loaded;
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

    fn settings_snapshot(&self) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
        let persisted =
            self.store.load_or_default().map_err(|_| SettingsErrorWire::invalid_file())?;
        let settings = self.settings.lock().map_err(|_| SettingsErrorWire::native_unavailable())?;
        let view = runtime_view_for_config(
            settings.loaded.config(),
            &persisted.tmux.effective_socket_name,
        );
        let runtime = SettingsRuntimeWire::from_runtime_view(
            &view,
            &persisted.tmux,
            SettingsRuntimeHealthWire::unavailable(),
            false,
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
                    if state.apply_loaded_config(loaded).is_err() {
                        return;
                    }
                    settings_changed = true;
                    appearance_changed = true;
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

#[tauri::command]
fn get_app_appearance(
    state: State<'_, NativeAppState>,
) -> Result<AppAppearanceWire, SettingsErrorWire> {
    state.app_appearance()
}

#[tauri::command]
fn dispatch_app_intent(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: AppIntentWire,
) -> Result<AppOutcomeWire, AppErrorWire> {
    let intent = payload.into_user_intent().map_err(|_| AppErrorWire::invalid_intent())?;
    let (wire, changed) = state.dispatch_intent(intent)?;
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

#[tauri::command]
fn apply_socket_change(
    state: State<'_, NativeAppState>,
    payload: SettingsSocketChangeRequestWire,
) -> Result<SettingsSnapshotWire, SettingsErrorWire> {
    payload.validate()?;
    // TerminalRuntime owns inspection, confirmation and session recreation.
    // Keeping this command typed-but-unavailable avoids claiming success before
    // that provider adapter exists and keeps the operation isolated from agents.
    let _ = state;
    Err(SettingsErrorWire::runtime_unavailable())
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
            app.state::<NativeAppState>()
                .install_config_watcher(app.handle())
                .map_err(|_| std::io::Error::other("DevHub Settings watcher unavailable"))?;
            emit_app_appearance(app.handle(), &app.state::<NativeAppState>());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "app-shell" && matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.app_handle().state::<NativeAppState>();
                if let Err(error) = state.close_window() {
                    state.record_native_error(error);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_snapshot,
            get_app_appearance,
            dispatch_app_intent,
            replay_app_events,
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
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                let state = app_handle.state::<NativeAppState>();
                if let Err(error) = state.quit() {
                    state.record_native_error(error);
                }
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Barrier};

    static TEMP_HOME_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_home() -> std::path::PathBuf {
        let sequence = TEMP_HOME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join(format!("devhub-native-shell-{}-{sequence}", std::process::id()));
        std::fs::create_dir_all(&path).expect("create native shell test home");
        path
    }

    fn remove_temp_home(path: &Path) {
        std::fs::remove_dir_all(path).expect("remove native shell test home");
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
    fn settings_snapshot_uses_content_revision_and_honest_runtime_unavailable_state() {
        let home = temp_home();
        let state = NativeAppState::bootstrap(&home).expect("bootstrap native app");
        let snapshot = state.settings_snapshot().expect("settings snapshot");
        snapshot.validate().expect("native snapshot is contract-valid");
        assert_eq!(snapshot.schema_version, devhub_app_core::SETTINGS_SCHEMA_VERSION);
        assert_eq!(snapshot.sequence, 1);
        assert_eq!(snapshot.revision.len(), 64);
        assert!(!snapshot.runtime.health.inspection_available);
        assert!(!snapshot.runtime.socket_change.adapter_available);
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
                "allow-get-app-appearance",
                "allow-dispatch-app-intent",
                "allow-replay-app-events"
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
