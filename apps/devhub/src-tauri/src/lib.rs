#![forbid(unsafe_code)]

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use devhub_app_core::config::{
    default_config_path, AgentProfileKind as ConfigAgentProfileKind, ConfigStore,
};
use devhub_app_core::{
    AgentProfile as DomainAgentProfile, AgentProfileId, AgentProfileKind, AppCoordinator,
    AppErrorWire, AppIntentWire, AppOutcomeWire, AppSnapshot, AppSnapshotWire, CoordinatorEvent,
    Effect, IdGenerator, IntentEnvelope, IntentId, JsonStateStore, OperationId, OperationToken,
    PortError, PortErrorCode, ProviderEvent, ProviderEventEnvelope, ProviderEventId, ReplayWire,
    UserIntent,
};
use tauri::{AppHandle, Emitter, Manager, State};

mod workspace_resolver;
use workspace_resolver::MacWorkspacePathResolver;

pub const APP_SNAPSHOT_CHANGED_EVENT: &str = "app://snapshot-changed";

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

struct NativeAppState {
    coordinator: Mutex<AppCoordinator>,
    store: JsonStateStore,
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

impl NativeAppState {
    fn bootstrap(home: &Path) -> Result<Self, AppErrorWire> {
        let store = JsonStateStore::for_home(home);
        let persisted = store.mark_starting().map_err(persistence_error)?;
        let profiles = load_config_profiles(home)?;
        let model = persisted.hydrate_model(&profiles).map_err(persistence_error)?;
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.mark_ready();
        let persisted_revision = coordinator.snapshot().revision();
        Ok(Self {
            coordinator: Mutex::new(coordinator),
            store,
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
}

fn load_config_profiles(home: &Path) -> Result<Vec<DomainAgentProfile>, AppErrorWire> {
    let loaded = ConfigStore::new(default_config_path(home)).load().map_err(state_error)?;
    loaded
        .config()
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
fn dispatch_app_intent(
    app: AppHandle,
    state: State<'_, NativeAppState>,
    payload: AppIntentWire,
) -> Result<AppOutcomeWire, AppErrorWire> {
    let intent = payload.into_user_intent().map_err(|_| AppErrorWire::invalid_intent())?;
    let (wire, changed) = state.dispatch_intent(intent)?;
    if changed {
        if let Err(error) = app.emit(APP_SNAPSHOT_CHANGED_EVENT, wire.snapshot()) {
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let home =
                app.path().home_dir().map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(
                NativeAppState::bootstrap(&home)
                    .map_err(|_| std::io::Error::other("DevHub native bootstrap failed"))?,
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.app_handle().state::<NativeAppState>();
                if let Err(error) = state.close_window() {
                    state.record_native_error(error);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_snapshot,
            dispatch_app_intent,
            replay_app_events
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
