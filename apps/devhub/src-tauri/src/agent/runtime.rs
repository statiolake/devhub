//! AgentRuntime implementation over the hidden Herdr session.

use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::task::{Context, Poll, Waker};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use devhub_app_core::ports::{
    AgentLaunchReceipt, AgentRuntime, CancellationToken, PortError, PortErrorCode, PortFuture,
};
use devhub_app_core::{
    AgentId, AgentObservation, AgentProfile, AgentReconciliation, OpaqueProviderMapping,
    WorkspaceId, WorkspaceRoot,
};

use crate::runtime::{ChildCleanup, ResolvedExecutable, RuntimeLaunchContext};

use super::api::{
    session_socket_path, HerdrTransport, Invalidation, ProviderTransport, SubscriptionHandle,
};
use super::contract::{expected_protocol, expected_version, HERDR_SESSION_NAME};
use super::error::{AgentRuntimeError, AgentRuntimeErrorCode};
use super::model::{
    cleanup_mapping_from_created, decode_provider_mapping, encode_provider_mapping,
    load_cleanup_journal, marker_label, pane_for, parse_created_mapping, parse_session_snapshot,
    provider_agent_name, recover_mapping, save_cleanup_journal, terminal_id_from_started,
    validate_profile, AgentRuntimeHealth, AgentRuntimeState, ProviderMapping, ProviderProfile,
    ProviderSnapshot, TombstoneReason, MAX_SURFACE_KEY_BYTES, MAX_TOMBSTONE_ATTEMPTS,
};

const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(8);
const BOOTSTRAP_POLL: Duration = Duration::from_millis(50);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const CLEANUP_POLL: Duration = Duration::from_millis(50);
const MAX_VERSION_OUTPUT_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct GateState {
    active: bool,
}

/// Serializes mutations and reconciliation. Subscription callbacks never
/// acquire this gate; they only set an invalidation hint.
struct OperationGate {
    state: Mutex<GateState>,
    wake: Condvar,
}

impl Default for OperationGate {
    fn default() -> Self {
        Self { state: Mutex::new(GateState::default()), wake: Condvar::new() }
    }
}

struct OperationPermit<'a> {
    gate: &'a OperationGate,
}

impl OperationGate {
    fn acquire(&self, cancel: &CancellationToken) -> Result<OperationPermit<'_>, PortError> {
        let mut state = self.state.lock().map_err(|_| failed_port())?;
        while state.active {
            if cancel.is_cancelled() {
                return Err(cancelled_port());
            }
            state = self.wake.wait_timeout(state, BOOTSTRAP_POLL).map_err(|_| failed_port())?.0;
        }
        if cancel.is_cancelled() {
            return Err(cancelled_port());
        }
        state.active = true;
        Ok(OperationPermit { gate: self })
    }
}

impl Drop for OperationPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.active = false;
            self.gate.wake.notify_all();
        }
    }
}

struct RuntimeInner {
    context: RuntimeLaunchContext,
    executable: Option<ResolvedExecutable>,
    transport: Arc<dyn ProviderTransport>,
    invalidation: Arc<Invalidation>,
    health: Mutex<AgentRuntimeHealth>,
    bootstrap_gate: Mutex<()>,
    operation_gate: OperationGate,
    state: Mutex<AgentRuntimeState>,
    subscription: Mutex<Option<SubscriptionHandle>>,
    journal_path: PathBuf,
    journal_loaded: Mutex<bool>,
    verify_executable: bool,
}

/// The sole native AgentRuntime implementation. All provider identity fields
/// are private to `RuntimeInner`; the public port returns only DevHub values.
#[derive(Clone)]
pub struct HerdrAgentRuntime {
    inner: Arc<RuntimeInner>,
}

impl HerdrAgentRuntime {
    /// Creates the adapter from the startup-frozen ambient environment. The
    /// returned runtime is inert until [`Self::bootstrap`] succeeds; no
    /// provider mutation occurs during construction.
    pub fn from_environment(
        home: impl Into<std::path::PathBuf>,
        configured_herdr: impl AsRef<str>,
    ) -> Result<Self, PortError> {
        let context = RuntimeLaunchContext::new(home, std::env::vars_os().collect())
            .map_err(|_| unavailable_port())?;
        Ok(Self::new(context, configured_herdr.as_ref()))
    }

    /// Startup may supply the application-owned runtime-state location. This
    /// keeps provider recovery state under the same owner as the rest of the
    /// application state instead of making the adapter guess a path.
    pub fn from_environment_with_journal(
        home: impl Into<std::path::PathBuf>,
        configured_herdr: impl AsRef<str>,
        journal_path: impl Into<std::path::PathBuf>,
    ) -> Result<Self, PortError> {
        let context = RuntimeLaunchContext::new(home, std::env::vars_os().collect())
            .map_err(|_| unavailable_port())?;
        Ok(Self::new_with_journal(context, configured_herdr.as_ref(), journal_path.into()))
    }

    pub(crate) fn new(context: RuntimeLaunchContext, configured_herdr: &str) -> Self {
        let journal_path = context
            .environment_value("DEVHUB_AGENT_RUNTIME_JOURNAL")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                context.home().join("Library/Application Support/DevHub/agent-runtime-journal.json")
            });
        Self::new_with_journal(context, configured_herdr, journal_path)
    }

    fn new_with_journal(
        context: RuntimeLaunchContext,
        configured_herdr: &str,
        journal_path: std::path::PathBuf,
    ) -> Self {
        let executable = context.resolve(configured_herdr).ok();
        let xdg = context
            .environment_value("XDG_CONFIG_HOME")
            .and_then(|value| value.to_str())
            .map(std::path::Path::new);
        let socket_path = session_socket_path(context.home(), xdg);
        let health = if executable.is_some() {
            AgentRuntimeHealth::starting()
        } else {
            AgentRuntimeHealth::unavailable(AgentRuntimeErrorCode::MissingExecutable)
        };
        Self {
            inner: Arc::new(RuntimeInner {
                context,
                executable,
                transport: Arc::new(HerdrTransport::new(socket_path)),
                invalidation: Arc::new(Invalidation::default()),
                health: Mutex::new(health),
                bootstrap_gate: Mutex::new(()),
                operation_gate: OperationGate::default(),
                state: Mutex::new(AgentRuntimeState::default()),
                subscription: Mutex::new(None),
                journal_path,
                journal_loaded: Mutex::new(false),
                verify_executable: true,
            }),
        }
    }

    /// Test and future embedded-host seam. The transport remains provider
    /// private while allowing isolated API fakes to exercise the lifecycle.
    #[cfg(test)]
    pub(crate) fn with_transport(
        context: RuntimeLaunchContext,
        transport: Arc<dyn ProviderTransport>,
    ) -> Self {
        let journal_path =
            context.home().join("Library/Application Support/DevHub/agent-runtime-journal.json");
        Self::with_transport_and_journal(context, transport, journal_path)
    }

    #[cfg(test)]
    pub(crate) fn with_transport_and_journal(
        context: RuntimeLaunchContext,
        transport: Arc<dyn ProviderTransport>,
        journal_path: std::path::PathBuf,
    ) -> Self {
        Self {
            inner: Arc::new(RuntimeInner {
                executable: None,
                context,
                transport,
                invalidation: Arc::new(Invalidation::default()),
                health: Mutex::new(AgentRuntimeHealth::starting()),
                bootstrap_gate: Mutex::new(()),
                operation_gate: OperationGate::default(),
                state: Mutex::new(AgentRuntimeState::default()),
                subscription: Mutex::new(None),
                journal_path,
                journal_loaded: Mutex::new(false),
                verify_executable: false,
            }),
        }
    }

    pub fn health(&self) -> AgentRuntimeHealth {
        self.inner
            .health
            .lock()
            .map(|health| *health)
            .unwrap_or_else(|_| AgentRuntimeHealth::failed(AgentRuntimeErrorCode::Internal))
    }

    pub fn bootstrap(&self, cancel: CancellationToken) -> PortFuture<AgentRuntimeHealth> {
        let runtime = self.clone();
        spawn_operation(cancel.clone(), "devhub-agent-bootstrap", move || {
            runtime.bootstrap_sync(&cancel)
        })
    }

    /// Associates a domain Agent with its Workspace before the coordinator
    /// emits a launch effect. The existing core AgentRuntime port carries only
    /// profile data on launch, so this narrow registration keeps the required
    /// root/workspace context in the native adapter without changing domain
    /// contracts.
    pub fn register_agent_workspace(
        &self,
        agent_id: AgentId,
        workspace_id: WorkspaceId,
        root: WorkspaceRoot,
    ) -> Result<(), PortError> {
        let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
        state.workspace_roots.insert(agent_id, (workspace_id, root));
        Ok(())
    }

    pub fn launch_for_workspace(
        &self,
        workspace_id: WorkspaceId,
        root: WorkspaceRoot,
        agent_id: AgentId,
        profile: AgentProfile,
        cancel: CancellationToken,
    ) -> PortFuture<AgentLaunchReceipt> {
        let runtime = self.clone();
        spawn_operation(cancel.clone(), "devhub-agent-launch", move || {
            runtime.launch_sync(&workspace_id, &root, agent_id, profile, &cancel)
        })
    }

    pub fn attach_surface(
        &self,
        agent_id: AgentId,
        surface_key: String,
        takeover: bool,
        cancel: CancellationToken,
    ) -> PortFuture<super::surface::AgentSurface> {
        let runtime = self.clone();
        spawn_operation(cancel.clone(), "devhub-agent-surface-attach", move || {
            runtime
                .attach_surface_sync(agent_id, surface_key, takeover, &cancel)
                .map(|(surface, _)| surface)
        })
    }

    /// Attaches a foreground Agent Surface and returns the provider-free
    /// observation produced by the same attach transaction. Native state must
    /// apply this observation instead of waiting for the next background
    /// reconciliation tick, otherwise an attach can briefly expose stale
    /// status or runtime health.
    pub fn attach_surface_with_observation(
        &self,
        agent_id: AgentId,
        surface_key: String,
        takeover: bool,
        cancel: CancellationToken,
    ) -> PortFuture<(super::surface::AgentSurface, AgentObservation)> {
        let runtime = self.clone();
        spawn_operation(cancel.clone(), "devhub-agent-surface-attach", move || {
            runtime.attach_surface_sync(agent_id, surface_key, takeover, &cancel)
        })
    }

    pub fn detach_surface(&self, surface: &super::surface::AgentSurface) {
        self.inner.detach_surface(surface);
    }

    fn bootstrap_sync(&self, cancel: &CancellationToken) -> Result<AgentRuntimeHealth, PortError> {
        let _bootstrap = self.inner.bootstrap_gate.lock().map_err(|_| failed_port())?;
        if cancel.is_cancelled() {
            return Err(cancelled_port());
        }
        self.load_journal()?;
        if self.health().is_ready() && !self.inner.invalidation.is_disconnected() {
            return Ok(self.health());
        }

        if self.inner.verify_executable {
            let executable = self.inner.executable.as_ref().ok_or_else(|| {
                self.set_health(AgentRuntimeHealth::unavailable(
                    AgentRuntimeErrorCode::MissingExecutable,
                ));
                unavailable_port()
            })?;
            verify_cli_version(&self.inner.context, executable, cancel).map_err(|error| {
                self.set_health(AgentRuntimeHealth::failed(error.code()));
                PortError::from(error)
            })?;
        }

        let result = self.ensure_server_and_probe(cancel);
        let ping = match result {
            Ok(ping) => ping,
            Err(error) => {
                self.set_health(AgentRuntimeHealth::unavailable(error.code()));
                return Err(error.into());
            }
        };
        verify_ping(&ping).map_err(|error| {
            self.set_health(AgentRuntimeHealth::failed(error.code()));
            PortError::from(error)
        })?;

        self.inner.transport.check_capabilities().map_err(|error| {
            self.set_health(AgentRuntimeHealth::failed(error.code()));
            PortError::from(error)
        })?;

        let subscription =
            self.inner.transport.subscribe(Arc::clone(&self.inner.invalidation)).map_err(
                |error| {
                    self.set_health(AgentRuntimeHealth::failed(error.code()));
                    PortError::from(error)
                },
            )?;
        if let Ok(mut current) = self.inner.subscription.lock() {
            if let Some(old) = current.take() {
                old.stop();
            }
            *current = Some(subscription);
        }
        self.set_health(AgentRuntimeHealth::healthy());
        Ok(self.health())
    }

    fn ensure_server_and_probe(
        &self,
        cancel: &CancellationToken,
    ) -> Result<Value, AgentRuntimeError> {
        let first = self.inner.transport.request("ping", json!({}));
        let ping = match first {
            Ok(value) => value,
            Err(error) if !self.inner.verify_executable => return Err(error),
            Err(error)
                if matches!(
                    error.code(),
                    AgentRuntimeErrorCode::Disconnected
                        | AgentRuntimeErrorCode::Unavailable
                        | AgentRuntimeErrorCode::Timeout
                ) =>
            {
                self.spawn_server()?;
                let deadline = Instant::now() + BOOTSTRAP_TIMEOUT;
                loop {
                    if cancel.is_cancelled() {
                        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Cancelled));
                    }
                    match self.inner.transport.request("ping", json!({})) {
                        Ok(value) => break value,
                        Err(_) if Instant::now() < deadline => thread::sleep(BOOTSTRAP_POLL),
                        Err(_) => {
                            return Err(AgentRuntimeError::new(
                                AgentRuntimeErrorCode::BootstrapFailed,
                            ));
                        }
                    }
                }
            }
            Err(error) => return Err(error),
        };
        Ok(ping)
    }

    fn spawn_server(&self) -> Result<(), AgentRuntimeError> {
        let executable = self
            .inner
            .executable
            .as_ref()
            .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::MissingExecutable))?;
        let mut command = self.inner.context.command(executable);
        command
            .arg("--session")
            .arg(HERDR_SESSION_NAME)
            .arg("server")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
            .spawn()
            .map(|_| ())
            .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::BootstrapFailed))
    }

    fn launch_sync(
        &self,
        workspace_id: &WorkspaceId,
        root: &WorkspaceRoot,
        agent_id: AgentId,
        profile: AgentProfile,
        cancel: &CancellationToken,
    ) -> Result<AgentLaunchReceipt, PortError> {
        let provider_profile = validate_profile(&profile).map_err(PortError::from)?;
        // Reject malformed or oversized profiles before health checks or any
        // provider request. This keeps validation a pure local seam and
        // guarantees workspace.create cannot be the first failure point.
        self.ensure_ready(cancel)?;
        let _operation = self.inner.operation_gate.acquire(cancel)?;
        let generation = {
            let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
            if state.mappings.contains_key(&agent_id) || state.tombstones.contains_key(&agent_id) {
                return Err(conflict_port());
            }
            state.next_generation()
        };
        let created = self.create_workspace(workspace_id, root, &agent_id, &provider_profile)?;
        let mut mapping = match parse_created_mapping(
            &created,
            root.as_path().to_path_buf(),
            Some(workspace_id.clone()),
            generation,
        ) {
            Ok(mapping) => mapping,
            Err(error) => {
                if let Err(cleanup) = self.compensate_mapping(
                    &agent_id,
                    &created,
                    root.as_path().to_path_buf(),
                    Some(workspace_id.clone()),
                    generation,
                ) {
                    self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(cleanup)));
                }
                return Err(error.into());
            }
        };
        let started = self.start_agent(&agent_id, &mapping, &provider_profile);
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                if let Err(cleanup) = self.compensate_provider_mapping(&agent_id, &mapping) {
                    self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(cleanup)));
                }
                return Err(error.into());
            }
        };
        mapping.terminal_id = terminal_id_from_started(&started).map_err(|error| {
            if let Err(cleanup) = self.compensate_provider_mapping(&agent_id, &mapping) {
                self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(cleanup)));
            }
            PortError::from(error)
        })?;
        let provider_mapping = encode_provider_mapping(&mapping).map_err(|error| {
            if let Err(cleanup) = self.compensate_provider_mapping(&agent_id, &mapping) {
                self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(cleanup)));
            }
            PortError::from(error)
        })?;
        let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
        state.confirmed_agents.remove(&agent_id);
        state.mappings.insert(agent_id.clone(), mapping);
        state.workspace_roots.insert(agent_id.clone(), (workspace_id.clone(), root.clone()));
        let pane_id = state
            .mappings
            .get(&agent_id)
            .map(|mapping| mapping.pane_id.clone())
            .ok_or_else(failed_port)?;
        drop(state);
        self.inner.transport.register_pane_for_status(&pane_id);
        self.refresh_subscription();
        Ok(AgentLaunchReceipt { agent_id, provider_mapping })
    }

    fn create_workspace(
        &self,
        workspace_id: &WorkspaceId,
        root: &WorkspaceRoot,
        agent_id: &AgentId,
        profile: &ProviderProfile,
    ) -> Result<Value, PortError> {
        let cwd = root.as_path().to_str().ok_or_else(failed_port)?;
        let value = self
            .inner
            .transport
            .request(
                "workspace.create",
                json!({
                    "cwd": cwd,
                    "focus": false,
                    "label": marker_label(agent_id),
                    "env": profile.env,
                }),
            )
            .map_err(PortError::from)?;
        let _ = workspace_id;
        Ok(value)
    }

    fn start_agent(
        &self,
        agent_id: &AgentId,
        mapping: &ProviderMapping,
        provider_profile: &ProviderProfile,
    ) -> Result<Value, AgentRuntimeError> {
        self.inner.transport.request(
            "agent.start",
            json!({
                "name": provider_agent_name(agent_id),
                "kind": provider_profile.kind,
                "pane_id": mapping.pane_id,
                "args": provider_profile.args,
            }),
        )
    }

    fn compensate_mapping(
        &self,
        agent_id: &AgentId,
        created: &Value,
        workspace_root: PathBuf,
        workspace_domain_id: Option<WorkspaceId>,
        generation: u64,
    ) -> Result<(), PortError> {
        let workspace = created
            .get("workspace")
            .and_then(|value| value.get("workspace_id"))
            .and_then(Value::as_str);
        let pane =
            created.get("root_pane").and_then(|value| value.get("pane_id")).and_then(Value::as_str);
        let mut first_error = None;
        if let Some(pane) = pane {
            if let Err(error) =
                self.inner.transport.request("pane.close", json!({ "pane_id": pane }))
            {
                if error.code() != AgentRuntimeErrorCode::ProviderNotFound {
                    first_error = Some(error);
                }
            }
        }
        if let Some(workspace) = workspace {
            if let Err(error) = self
                .inner
                .transport
                .request("workspace.close", json!({ "workspace_id": workspace }))
            {
                if error.code() != AgentRuntimeErrorCode::ProviderNotFound && first_error.is_none()
                {
                    first_error = Some(error);
                }
            }
        }
        if let Some(error) = first_error {
            let cleanup_error = PortError::from(error);
            if let Some(mapping) = cleanup_mapping_from_created(
                created,
                workspace_root,
                workspace_domain_id,
                generation,
            ) {
                if let Err(intent_error) = self.record_cleanup_intent(agent_id, mapping) {
                    // Keep the original provider cleanup failure observable
                    // through bounded health state while returning the more
                    // severe durable-intent failure to the caller.
                    self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(
                        cleanup_error,
                    )));
                    return Err(intent_error);
                }
            }
            Err(cleanup_error)
        } else {
            Ok(())
        }
    }

    fn compensate_provider_mapping(
        &self,
        agent_id: &AgentId,
        mapping: &ProviderMapping,
    ) -> Result<(), PortError> {
        let pane =
            self.inner.transport.request("pane.close", json!({ "pane_id": mapping.pane_id }));
        let workspace = self
            .inner
            .transport
            .request("workspace.close", json!({ "workspace_id": mapping.workspace_id }));
        let first_error = [pane, workspace].into_iter().find_map(|result| match result {
            Ok(_) => None,
            Err(error) if error.code() == AgentRuntimeErrorCode::ProviderNotFound => None,
            Err(error) => Some(error),
        });
        if let Some(error) = first_error {
            let cleanup_error = PortError::from(error);
            match self.record_cleanup_intent(agent_id, mapping.clone()) {
                Ok(()) => Err(cleanup_error),
                Err(intent_error) => {
                    // A failed journal write is more actionable than hiding
                    // the retry-intent failure behind the provider error.
                    // The original cleanup failure remains reflected by the
                    // degraded health state without exposing provider text.
                    self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(
                        cleanup_error,
                    )));
                    Err(intent_error)
                }
            }
        } else {
            Ok(())
        }
    }

    fn attach_sync(
        &self,
        agent_id: AgentId,
        persisted_mapping: Option<OpaqueProviderMapping>,
        cancel: &CancellationToken,
    ) -> Result<AgentObservation, PortError> {
        self.ensure_ready(cancel)?;
        let _operation = self.inner.operation_gate.acquire(cancel)?;
        {
            let state = self.inner.state.lock().map_err(|_| failed_port())?;
            if state.tombstones.contains_key(&agent_id) {
                return Err(unavailable_port());
            }
        }
        let snapshot = self.fetch_snapshot()?;
        let (root, workspace_id, generation) = self
            .inner
            .state
            .lock()
            .map_err(|_| failed_port())?
            .workspace_roots
            .get(&agent_id)
            .map(|(workspace, root)| (root.as_path().to_path_buf(), Some(workspace.clone()), 1_u64))
            .unwrap_or_else(|| (self.inner.context.home().to_path_buf(), None, 1));
        let persisted_mapping = persisted_mapping
            .as_ref()
            .map(decode_provider_mapping)
            .transpose()
            .map_err(PortError::from)?;
        let mapping = if let Some(mapping) = persisted_mapping {
            mapping
        } else if let Some(mapping) =
            self.inner.state.lock().map_err(|_| failed_port())?.mappings.get(&agent_id).cloned()
        {
            mapping
        } else {
            recover_mapping(&snapshot, &agent_id, root, workspace_id, generation)
                .ok_or_else(unavailable_port)?
        };
        let Some(pane) = pane_for(&snapshot, &mapping) else {
            // Keep a restored mapping in the provider-private state even when
            // its pane disappeared before the first attach completed. The
            // next continuous reconciliation must be able to turn that
            // authoritative absence into a natural-exit observation; dropping
            // the mapping here would leave the durable Agent row orphaned
            // forever because `reconcile_sync` only projects owned mappings.
            let pane_id = mapping.pane_id.clone();
            let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
            state.confirmed_agents.remove(&agent_id);
            state.mappings.insert(agent_id.clone(), mapping);
            drop(state);
            self.inner.transport.register_pane_for_status(&pane_id);
            self.refresh_subscription();
            return Err(unavailable_port());
        };
        let (status, runtime_health) = pane.status.project();
        let pane_confirms_active = pane.agent.is_some() && !pane.status.is_exited();
        let replaced_pane_id = {
            let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
            let replaced_pane_id = state
                .mappings
                .get(&agent_id)
                .filter(|current| *current != &mapping)
                .map(|current| current.pane_id.clone());
            if replaced_pane_id.is_some() {
                state.confirmed_agents.remove(&agent_id);
            }
            if pane_confirms_active {
                state.confirmed_agents.insert(agent_id.clone());
            }
            state.mappings.insert(agent_id.clone(), mapping);
            replaced_pane_id
        };
        if let Some(pane_id) = replaced_pane_id {
            self.inner.transport.unregister_pane_for_status(&pane_id);
        }
        if let Ok(state) = self.inner.state.lock() {
            if let Some(mapping) = state.mappings.get(&agent_id) {
                self.inner.transport.register_pane_for_status(&mapping.pane_id);
            }
        }
        self.refresh_subscription();
        Ok(AgentObservation::new(agent_id, status, runtime_health))
    }

    fn reconcile_sync(&self, cancel: &CancellationToken) -> Result<AgentReconciliation, PortError> {
        self.ensure_ready(cancel)?;
        let _operation = self.inner.operation_gate.acquire(cancel)?;
        self.wait_for_coalesced_invalidation(cancel)?;
        let generation = self.inner.invalidation.generation();
        let mut snapshot = self.fetch_snapshot()?;
        let snapshot_generation = self.inner.invalidation.generation();
        if snapshot_generation != generation {
            snapshot = self.fetch_snapshot()?;
        }
        self.recover_owned_mappings(&snapshot)?;
        let (observations, exited) = self.project_snapshot(&snapshot)?;
        self.retry_due_tombstones(cancel)?;
        if self.inner.invalidation.generation() == snapshot_generation {
            self.inner.invalidation.clear_pending();
        }
        Ok(AgentReconciliation::new(observations, exited))
    }

    /// Reconstructs adapter state from the authoritative hidden-workspace
    /// marker after a DevHub relaunch. This is the recovery path when the
    /// caller has not yet supplied an opaque persisted mapping; provider IDs
    /// remain inside `ProviderMapping` and are never returned to the core.
    fn recover_owned_mappings(&self, snapshot: &ProviderSnapshot) -> Result<(), PortError> {
        let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
        let registrations = state.workspace_roots.clone();
        let mut pane_ids = Vec::new();
        for workspace in &snapshot.workspaces {
            let Some(raw_agent_id) =
                workspace.label.as_deref().and_then(|label| label.strip_prefix("devhub-agent-"))
            else {
                continue;
            };
            let Ok(agent_id) = raw_agent_id.parse::<AgentId>() else {
                continue;
            };
            if state.mappings.contains_key(&agent_id) || state.tombstones.contains_key(&agent_id) {
                continue;
            }
            let (root, workspace_domain_id) = registrations
                .get(&agent_id)
                .map(|(workspace_id, root)| {
                    (root.as_path().to_path_buf(), Some(workspace_id.clone()))
                })
                .unwrap_or_else(|| (self.inner.context.home().to_path_buf(), None));
            let Some(mapping) = recover_mapping(
                snapshot,
                &agent_id,
                root,
                workspace_domain_id,
                state.next_generation(),
            ) else {
                continue;
            };
            pane_ids.push(mapping.pane_id.clone());
            state.confirmed_agents.remove(&agent_id);
            state.mappings.insert(agent_id, mapping);
        }
        drop(state);
        for pane_id in &pane_ids {
            self.inner.transport.register_pane_for_status(pane_id);
        }
        if !pane_ids.is_empty() {
            self.refresh_subscription();
        }
        Ok(())
    }

    fn project_snapshot(
        &self,
        snapshot: &ProviderSnapshot,
    ) -> Result<(Vec<AgentObservation>, Vec<AgentId>), PortError> {
        let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
        let mut observations = Vec::new();
        let mut exited = Vec::new();
        let mut journal_changed = false;
        let mappings = state.mappings.clone();
        for (agent_id, mapping) in mappings {
            let Some(pane) = pane_for(snapshot, &mapping) else {
                let pane_id = mapping.pane_id.clone();
                state
                    .add_tombstone(agent_id.clone(), mapping, TombstoneReason::NaturalExit)
                    .map_err(PortError::from)?;
                self.inner.transport.unregister_pane_for_status(&pane_id);
                journal_changed = true;
                exited.push(agent_id);
                continue;
            };
            // Herdr may temporarily have no detected agent label while a
            // managed launch settles. Treat that startup absence as still
            // observable, but once a pane has reported an agent, a later
            // missing identity is the provider's natural-exit signal. The
            // tracking is provider-private so the domain never has to learn
            // about Herdr's eventual-consistency behavior.
            let agent_was_confirmed = state.confirmed_agents.contains(&agent_id);
            if pane.agent.is_some() {
                state.confirmed_agents.insert(agent_id.clone());
            }
            if pane.status.is_exited() || (pane.agent.is_none() && agent_was_confirmed) {
                let pane_id = mapping.pane_id.clone();
                state
                    .add_tombstone(agent_id.clone(), mapping, TombstoneReason::NaturalExit)
                    .map_err(PortError::from)?;
                self.inner.transport.unregister_pane_for_status(&pane_id);
                journal_changed = true;
                exited.push(agent_id);
                continue;
            }
            let (status, runtime_health) = pane.status.project();
            observations.push(AgentObservation::new(agent_id, status, runtime_health));
        }
        drop(state);
        if journal_changed {
            if let Err(error) = self.persist_journal() {
                self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(error)));
                return Err(error);
            }
        }
        Ok((observations, exited))
    }

    fn retry_due_tombstones(&self, cancel: &CancellationToken) -> Result<(), PortError> {
        let due = self
            .inner
            .state
            .lock()
            .map_err(|_| failed_port())?
            .tombstones
            .iter()
            .filter(|(_, tombstone)| tombstone.next_retry <= Instant::now())
            .map(|(agent_id, tombstone)| (agent_id.clone(), tombstone.clone()))
            .collect::<Vec<_>>();
        for (agent_id, tombstone) in due {
            if cancel.is_cancelled() {
                return Err(cancelled_port());
            }
            if tombstone.attempts >= MAX_TOMBSTONE_ATTEMPTS {
                continue;
            }
            match self.cleanup_mapping(&tombstone.mapping, cancel) {
                Ok(()) => {
                    self.finish_cleanup_success(&agent_id, Some(tombstone.mapping.generation))?;
                }
                Err(error) => {
                    let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
                    state.record_cleanup_failure(&agent_id);
                    drop(state);
                    self.persist_journal()?;
                    self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(error)));
                }
            }
        }
        Ok(())
    }

    fn terminate_sync(
        &self,
        agent_id: AgentId,
        cancel: &CancellationToken,
    ) -> Result<(), PortError> {
        self.load_journal()?;
        let tracked = {
            let state = self.inner.state.lock().map_err(|_| failed_port())?;
            state.mappings.contains_key(&agent_id) || state.tombstones.contains_key(&agent_id)
        };
        if !tracked {
            return Ok(());
        }
        if let Err(error) = self.ensure_ready(cancel) {
            if matches!(error.code(), PortErrorCode::Unavailable | PortErrorCode::TimedOut) {
                let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
                if let Some(mapping) = state.mappings.get(&agent_id).cloned() {
                    let pane_id = mapping.pane_id.clone();
                    state
                        .add_tombstone(agent_id.clone(), mapping, TombstoneReason::ExplicitStop)
                        .map_err(PortError::from)?;
                    state.stopping.insert(agent_id.clone());
                    drop(state);
                    self.inner.transport.unregister_pane_for_status(&pane_id);
                    self.persist_journal()?;
                }
            }
            return Err(error);
        }
        let _operation = self.inner.operation_gate.acquire(cancel)?;
        let (tombstone, journal_changed) = {
            let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
            if let Some(tombstone) = state.tombstones.get_mut(&agent_id) {
                if tombstone.attempts >= MAX_TOMBSTONE_ATTEMPTS {
                    return Err(PortError::from(AgentRuntimeError::new(
                        AgentRuntimeErrorCode::CleanupPending,
                    )));
                }
                tombstone.reason = TombstoneReason::ExplicitStop;
                tombstone.next_retry = Instant::now();
                let tombstone = tombstone.clone();
                state.stopping.insert(agent_id.clone());
                (tombstone, true)
            } else if let Some(mapping) = state.mappings.get(&agent_id).cloned() {
                state.stopping.insert(agent_id.clone());
                state
                    .add_tombstone(agent_id.clone(), mapping, TombstoneReason::ExplicitStop)
                    .map_err(PortError::from)?;
                (state.tombstones.get(&agent_id).cloned().ok_or_else(failed_port)?, true)
            } else {
                return Ok(());
            }
        };
        if journal_changed {
            self.persist_journal()?;
        }
        self.inner.transport.unregister_pane_for_status(&tombstone.mapping.pane_id);
        match self.cleanup_mapping(&tombstone.mapping, cancel) {
            Ok(()) => {
                self.finish_cleanup_success(&agent_id, None)?;
                Ok(())
            }
            Err(error) => {
                let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
                state.record_cleanup_failure(&agent_id);
                drop(state);
                self.persist_journal()?;
                self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(error)));
                Err(error)
            }
        }
    }

    fn cleanup_mapping(
        &self,
        mapping: &ProviderMapping,
        cancel: &CancellationToken,
    ) -> Result<(), PortError> {
        let pane_result =
            self.inner.transport.request("pane.close", json!({ "pane_id": mapping.pane_id }));
        let pane_error = match pane_result {
            Ok(_) => None,
            Err(error) if error.code() == AgentRuntimeErrorCode::ProviderNotFound => None,
            Err(error) => Some(PortError::from(error)),
        };
        let mut first_error = pane_error;
        if first_error.is_none() {
            let deadline = Instant::now() + CLEANUP_TIMEOUT;
            loop {
                if cancel.is_cancelled() {
                    first_error = Some(cancelled_port());
                    break;
                }
                match self.fetch_snapshot() {
                    Ok(snapshot) if pane_for(&snapshot, mapping).is_none() => break,
                    Ok(_) if Instant::now() < deadline => thread::sleep(CLEANUP_POLL),
                    Ok(_) => {
                        first_error = Some(PortError::from(AgentRuntimeError::new(
                            AgentRuntimeErrorCode::Timeout,
                        )));
                        break;
                    }
                    Err(error) => {
                        first_error = Some(error);
                        break;
                    }
                }
            }
        }
        let workspace_error = match self
            .inner
            .transport
            .request("workspace.close", json!({ "workspace_id": mapping.workspace_id }))
        {
            Ok(_) => None,
            Err(error) if error.code() == AgentRuntimeErrorCode::ProviderNotFound => None,
            Err(error) => Some(PortError::from(error)),
        };
        if first_error.is_none() {
            first_error = workspace_error;
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn attach_surface_sync(
        &self,
        agent_id: AgentId,
        surface_key: String,
        takeover: bool,
        cancel: &CancellationToken,
    ) -> Result<(super::surface::AgentSurface, AgentObservation), PortError> {
        if surface_key.is_empty() || surface_key.len() > MAX_SURFACE_KEY_BYTES {
            return Err(PortError::from(AgentRuntimeError::new(
                AgentRuntimeErrorCode::InvalidProfile,
            )));
        }
        let observation = self.attach_sync(agent_id.clone(), None, cancel)?;
        let _operation = self.inner.operation_gate.acquire(cancel)?;
        let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
        if state.surfaces.iter().any(|(key, owner)| owner == &agent_id && key != &surface_key) {
            // A live DevHub surface owns the controller. Conditional takeover
            // is intentionally refused while it remains registered.
            return Err(conflict_port());
        }
        if let Some(owner) = state.surfaces.get(&surface_key) {
            let _ = owner;
            // A live handle owns this exact surface key. Reusing it would
            // create two controllers with indistinguishable lifecycle state.
            return Err(conflict_port());
        }
        let mapping = state.mappings.get(&agent_id).cloned().ok_or_else(unavailable_port)?;
        let control = self
            .inner
            .transport
            .open_control(&mapping.terminal_id, takeover)
            .map_err(PortError::from)?;
        state.surfaces.insert(surface_key.clone(), agent_id.clone());
        state.controls.insert(surface_key.clone(), Arc::clone(&control));
        Ok((super::surface::AgentSurface::new(self.clone(), agent_id, surface_key), observation))
    }

    fn wait_for_coalesced_invalidation(&self, cancel: &CancellationToken) -> Result<(), PortError> {
        while let Some(wait) = self.inner.invalidation.pending_wait() {
            if wait.is_zero() {
                return Ok(());
            }
            if cancel.is_cancelled() {
                return Err(cancelled_port());
            }
            thread::sleep(wait.min(BOOTSTRAP_POLL));
        }
        Ok(())
    }

    fn ensure_ready(&self, cancel: &CancellationToken) -> Result<(), PortError> {
        if self.health().is_ready() && !self.inner.invalidation.is_disconnected() {
            return Ok(());
        }
        self.bootstrap_sync(cancel).map(|_| ())
    }

    fn refresh_subscription(&self) {
        let Ok(subscription) = self.inner.transport.subscribe(Arc::clone(&self.inner.invalidation))
        else {
            self.set_health(AgentRuntimeHealth::degraded(AgentRuntimeErrorCode::Disconnected));
            return;
        };
        let old = self
            .inner
            .subscription
            .lock()
            .ok()
            .and_then(|mut current| current.replace(subscription));
        if let Some(old) = old {
            old.stop();
        }
    }

    fn load_journal(&self) -> Result<(), PortError> {
        let mut loaded = self.inner.journal_loaded.lock().map_err(|_| failed_port())?;
        if *loaded {
            return Ok(());
        }
        let persisted = load_cleanup_journal(&self.inner.journal_path).map_err(PortError::from)?;
        let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
        for (agent_id, tombstone) in persisted {
            state.tombstones.entry(agent_id).or_insert(tombstone);
        }
        *loaded = true;
        Ok(())
    }

    fn persist_journal(&self) -> Result<(), PortError> {
        let tombstones = self.inner.state.lock().map_err(|_| failed_port())?.tombstones.clone();
        save_cleanup_journal(&self.inner.journal_path, &tombstones).map_err(PortError::from)
    }

    fn record_cleanup_intent(
        &self,
        agent_id: &AgentId,
        mapping: ProviderMapping,
    ) -> Result<(), PortError> {
        let pane_id = mapping.pane_id.clone();
        let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
        state
            .add_tombstone(agent_id.clone(), mapping, TombstoneReason::ExplicitStop)
            .map_err(PortError::from)?;
        drop(state);
        self.inner.transport.unregister_pane_for_status(&pane_id);
        self.persist_journal()
    }

    /// Commit cleanup state only after the journal accepts the new tombstone
    /// set. If persistence fails, restore the in-memory intent so a retry is
    /// still possible and no live surface is silently orphaned.
    fn finish_cleanup_success(
        &self,
        agent_id: &AgentId,
        generation: Option<u64>,
    ) -> Result<(), PortError> {
        let (removed_mapping, removed_tombstone, was_stopping) = {
            let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
            state.confirmed_agents.remove(agent_id);
            let removed_mapping = if generation.is_none()
                || state
                    .mappings
                    .get(agent_id)
                    .is_some_and(|mapping| Some(mapping.generation) == generation)
            {
                state.mappings.remove(agent_id)
            } else {
                None
            };
            let removed_tombstone = state.tombstones.remove(agent_id);
            let was_stopping = state.stopping.remove(agent_id);
            (removed_mapping, removed_tombstone, was_stopping)
        };
        let removed_pane_id =
            removed_mapping.as_ref().map(|mapping| mapping.pane_id.clone()).or_else(|| {
                removed_tombstone.as_ref().map(|tombstone| tombstone.mapping.pane_id.clone())
            });

        if let Err(error) = self.persist_journal() {
            let mut state = self.inner.state.lock().map_err(|_| failed_port())?;
            if let Some(mapping) = removed_mapping {
                state.mappings.entry(agent_id.clone()).or_insert(mapping);
            }
            if let Some(tombstone) = removed_tombstone {
                state.tombstones.entry(agent_id.clone()).or_insert(tombstone);
            }
            if was_stopping {
                state.stopping.insert(agent_id.clone());
            }
            drop(state);
            self.set_health(AgentRuntimeHealth::degraded(cleanup_health_code(error)));
            return Err(error);
        }

        if let Some(pane_id) = removed_pane_id {
            self.inner.transport.unregister_pane_for_status(&pane_id);
        }

        let controls = self.inner.state.lock().map_err(|_| failed_port())?.take_surfaces(agent_id);
        for control in controls {
            control.detach();
        }
        Ok(())
    }

    fn set_health(&self, health: AgentRuntimeHealth) {
        if let Ok(mut current) = self.inner.health.lock() {
            *current = health;
        }
    }

    fn fetch_snapshot(&self) -> Result<ProviderSnapshot, PortError> {
        self.inner
            .transport
            .request("session.snapshot", json!({}))
            .map_err(|error| {
                self.set_health(AgentRuntimeHealth::degraded(error.code()));
                error.into()
            })
            .and_then(|value| parse_session_snapshot(&value).map_err(PortError::from))
    }

    pub(super) fn surface_send_text(
        &self,
        agent_id: &AgentId,
        surface_key: &str,
        text: &str,
    ) -> Result<(), PortError> {
        if text.len() > super::api::MAX_TERMINAL_READ_BYTES || text.contains('\0') {
            return Err(PortError::from(AgentRuntimeError::new(
                AgentRuntimeErrorCode::BoundedInput,
            )));
        }
        let control = {
            let state = self.inner.state.lock().map_err(|_| failed_port())?;
            if state.surfaces.get(surface_key).is_some_and(|owner| owner == agent_id) {
                state.controls.get(surface_key).cloned()
            } else {
                None
            }
        }
        .ok_or_else(unavailable_port)?;
        control.send_text(text).map_err(PortError::from)
    }

    pub(super) fn surface_read_recent(
        &self,
        agent_id: &AgentId,
        surface_key: &str,
    ) -> Result<Vec<u8>, PortError> {
        let control = {
            let state = self.inner.state.lock().map_err(|_| failed_port())?;
            if state.surfaces.get(surface_key).is_some_and(|owner| owner == agent_id) {
                state.controls.get(surface_key).cloned()
            } else {
                None
            }
        }
        .ok_or_else(unavailable_port)?;
        control.read_recent().map_err(PortError::from)
    }

    pub(super) fn surface_detach(&self, agent_id: &AgentId, surface_key: &str) {
        let control = self.inner.state.lock().ok().and_then(|mut state| {
            if state.surfaces.get(surface_key).is_some_and(|owner| owner == agent_id) {
                state.surfaces.remove(surface_key);
                state.controls.remove(surface_key)
            } else {
                None
            }
        });
        if let Some(control) = control {
            control.detach();
        }
    }
}

impl RuntimeInner {
    fn detach_surface(&self, surface: &super::surface::AgentSurface) {
        let control = self.state.lock().ok().and_then(|mut state| {
            if state
                .surfaces
                .get(surface.surface_key())
                .is_some_and(|owner| owner == surface.agent_id())
            {
                state.surfaces.remove(surface.surface_key());
                state.controls.remove(surface.surface_key())
            } else {
                None
            }
        });
        if let Some(control) = control {
            control.detach();
        }
    }
}

impl AgentRuntime for HerdrAgentRuntime {
    fn launch(
        &self,
        agent_id: AgentId,
        profile: AgentProfile,
        cancel: CancellationToken,
    ) -> PortFuture<AgentLaunchReceipt> {
        let registration = self
            .inner
            .state
            .lock()
            .ok()
            .and_then(|state| state.workspace_roots.get(&agent_id).cloned());
        let Some((workspace_id, root)) = registration else {
            return Box::pin(async { Err(unavailable_port()) });
        };
        self.launch_for_workspace(workspace_id, root, agent_id, profile, cancel)
    }

    fn terminate(&self, agent_id: AgentId, cancel: CancellationToken) -> PortFuture<()> {
        let runtime = self.clone();
        spawn_operation(cancel.clone(), "devhub-agent-terminate", move || {
            runtime.terminate_sync(agent_id, &cancel)
        })
    }

    fn attach(
        &self,
        agent_id: AgentId,
        provider_mapping: Option<OpaqueProviderMapping>,
        cancel: CancellationToken,
    ) -> PortFuture<devhub_app_core::ports::AgentAttachment> {
        let runtime = self.clone();
        spawn_operation(cancel.clone(), "devhub-agent-attach", move || {
            runtime.attach_sync(agent_id, provider_mapping, &cancel)
        })
    }

    fn reconcile(&self, cancel: CancellationToken) -> PortFuture<AgentReconciliation> {
        let runtime = self.clone();
        spawn_operation(cancel.clone(), "devhub-agent-reconcile", move || {
            runtime.reconcile_sync(&cancel)
        })
    }
}

fn verify_cli_version(
    context: &RuntimeLaunchContext,
    executable: &ResolvedExecutable,
    cancel: &CancellationToken,
) -> Result<(), AgentRuntimeError> {
    let mut child = context
        .command(executable)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::MissingExecutable))?;
    let mut cleanup = ChildCleanup::new(child.id());
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            cleanup.terminate(&mut child);
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Internal));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            cleanup.terminate(&mut child);
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Internal));
        }
    };
    let (reader_sender, reader_receiver) = mpsc::channel();
    let stdout_sender = reader_sender.clone();
    thread::spawn(move || {
        let _ = stdout_sender.send((true, read_version_stream(stdout)));
    });
    let stderr_sender = reader_sender;
    thread::spawn(move || {
        let _ = stderr_sender.send((false, read_version_stream(stderr)));
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if cancel.is_cancelled() {
            cleanup.terminate(&mut child);
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Cancelled));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                cleanup.terminate(&mut child);
                return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Timeout));
            }
            Err(_) => {
                cleanup.terminate(&mut child);
                return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable));
            }
        }
    };
    cleanup.mark_reaped();
    if !status.success() {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    let mut stdout = None;
    let mut stderr = None;
    for _ in 0..2 {
        let remaining =
            deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(250));
        let (is_stdout, output) = reader_receiver
            .recv_timeout(remaining)
            .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Timeout))?;
        if is_stdout {
            stdout = Some(output?);
        } else {
            stderr = Some(output?);
        }
    }
    let stdout = stdout.ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::Internal))?;
    let _stderr = stderr.ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::Internal))?;
    let text = String::from_utf8(stdout)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?;
    let mut words = text.split_whitespace();
    if words.next() == Some("herdr")
        && words.next() == Some(expected_version())
        && words.next().is_none()
    {
        Ok(())
    } else {
        Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))
    }
}

fn read_version_stream<R: Read>(reader: R) -> Result<Vec<u8>, AgentRuntimeError> {
    let mut output = Vec::new();
    reader
        .take((MAX_VERSION_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
    if output.len() > MAX_VERSION_OUTPUT_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    Ok(output)
}

fn verify_ping(value: &Value) -> Result<(), AgentRuntimeError> {
    if value.get("type").and_then(Value::as_str) != Some("pong") {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    if value.get("version").and_then(Value::as_str) != Some(expected_version()) {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    if value.get("protocol").and_then(Value::as_u64) != Some(u64::from(expected_protocol())) {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    if !value.get("capabilities").is_some_and(Value::is_object) {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch));
    }
    Ok(())
}

fn cleanup_health_code(error: PortError) -> AgentRuntimeErrorCode {
    match error.code() {
        PortErrorCode::Unavailable => AgentRuntimeErrorCode::Disconnected,
        PortErrorCode::Incompatible => AgentRuntimeErrorCode::CapabilityMismatch,
        PortErrorCode::TimedOut => AgentRuntimeErrorCode::Timeout,
        PortErrorCode::Cancelled => AgentRuntimeErrorCode::Cancelled,
        PortErrorCode::Conflict => AgentRuntimeErrorCode::Conflict,
        PortErrorCode::Failed => AgentRuntimeErrorCode::CleanupPending,
    }
}

fn failed_port() -> PortError {
    PortError::new(PortErrorCode::Failed)
}

fn unavailable_port() -> PortError {
    PortError::new(PortErrorCode::Unavailable)
}

fn conflict_port() -> PortError {
    PortError::new(PortErrorCode::Conflict)
}

fn cancelled_port() -> PortError {
    PortError::new(PortErrorCode::Cancelled)
}

struct OperationState<T> {
    result: Option<Result<T, PortError>>,
    waker: Option<Waker>,
}

struct OperationFuture<T> {
    state: Arc<Mutex<OperationState<T>>>,
    cancel: Option<CancellationToken>,
}

impl<T: Send + 'static> std::future::Future for OperationFuture<T> {
    type Output = Result<T, PortError>;

    fn poll(self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.as_ref().get_ref();
        let mut state = match this.state.lock() {
            Ok(state) => state,
            Err(_) => return Poll::Ready(Err(failed_port())),
        };
        match state.result.take() {
            Some(result) => Poll::Ready(result),
            None => {
                state.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl<T> Drop for OperationFuture<T> {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
    }
}

fn spawn_operation<T, F>(
    cancel: CancellationToken,
    name: &'static str,
    operation: F,
) -> PortFuture<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, PortError> + Send + 'static,
{
    let state = Arc::new(Mutex::new(OperationState { result: None, waker: None }));
    let worker_state = Arc::clone(&state);
    let worker_cancel = cancel.clone();
    let spawned = thread::Builder::new().name(name.to_owned()).spawn(move || {
        let result = if worker_cancel.is_cancelled() {
            Err(cancelled_port())
        } else {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
                .unwrap_or_else(|_| Err(failed_port()))
        };
        if let Ok(mut state) = worker_state.lock() {
            state.result = Some(result);
            if let Some(waker) = state.waker.take() {
                waker.wake();
            }
        }
    });
    if spawned.is_err() {
        return Box::pin(async { Err(unavailable_port()) });
    }
    Box::pin(OperationFuture { state, cancel: Some(cancel) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, VecDeque};

    use serde_json::json;

    use super::super::api::{Invalidation, ProviderTransport};
    use super::super::model::AgentRuntimeHealthState;

    struct FakeTransport {
        responses: Mutex<VecDeque<(String, Result<Value, AgentRuntimeError>)>>,
        subscriptions: std::sync::atomic::AtomicUsize,
    }

    impl FakeTransport {
        fn new(
            responses: impl IntoIterator<Item = (String, Result<Value, AgentRuntimeError>)>,
        ) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                subscriptions: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn remaining(&self) -> usize {
            self.responses.lock().expect("responses").len()
        }

        fn subscription_count(&self) -> usize {
            self.subscriptions.load(std::sync::atomic::Ordering::Acquire)
        }
    }

    impl ProviderTransport for FakeTransport {
        fn request(&self, method: &str, _params: Value) -> Result<Value, AgentRuntimeError> {
            let mut responses = self.responses.lock().expect("responses");
            let Some((expected, response)) = responses.pop_front() else {
                return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected));
            };
            assert_eq!(expected, method);
            response
        }

        fn subscribe(
            &self,
            _invalidation: Arc<Invalidation>,
        ) -> Result<SubscriptionHandle, AgentRuntimeError> {
            self.subscriptions.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let worker_stop = Arc::clone(&stop);
            let worker = thread::spawn(move || {
                while !worker_stop.load(std::sync::atomic::Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(1));
                }
            });
            Ok(SubscriptionHandle::new(stop, worker))
        }

        fn check_capabilities(&self) -> Result<(), AgentRuntimeError> {
            Ok(())
        }
    }

    fn context() -> RuntimeLaunchContext {
        let home = std::env::temp_dir();
        RuntimeLaunchContext::new(home, std::env::vars_os().collect()).expect("context")
    }

    #[test]
    fn ping_requires_exact_version_protocol_and_capability_object() {
        assert!(verify_ping(&json!({
            "type":"pong", "version":"0.8.1", "protocol":20,
            "capabilities":{"live_handoff":true}
        }))
        .is_ok());
        assert_eq!(
            verify_ping(&json!({
                "type":"pong", "version":"0.8.2", "protocol":20,
                "capabilities":{}
            }))
            .expect_err("version mismatch")
            .code(),
            AgentRuntimeErrorCode::ProtocolMismatch
        );
        assert_eq!(
            verify_ping(&json!({ "type":"pong", "version":"0.8.1", "protocol":20 }))
                .expect_err("capability mismatch")
                .code(),
            AgentRuntimeErrorCode::CapabilityMismatch
        );
    }

    #[test]
    fn invalidation_coalesces_for_fifty_milliseconds() {
        let invalidation = Invalidation::default();
        invalidation.mark();
        let wait = invalidation.pending_wait().expect("pending");
        assert!(wait <= Duration::from_millis(50));
        assert!(wait > Duration::ZERO);
        let generation = invalidation.generation();
        invalidation.mark();
        assert!(invalidation.generation() > generation);
    }

    #[test]
    fn fake_transport_bootstrap_does_not_mutate_before_health_check() {
        let snapshot = json!({ "snapshot": { "workspaces": [], "panes": [] } });
        let transport = Arc::new(FakeTransport::new([
            (
                "ping".to_owned(),
                Ok(json!({
                    "type":"pong", "version":"0.8.1", "protocol":20,
                    "capabilities":{"live_handoff":true}
                })),
            ),
            ("session.snapshot".to_owned(), Ok(snapshot)),
            ("workspace.list".to_owned(), Ok(json!({ "workspaces": [] }))),
            ("tab.list".to_owned(), Ok(json!({ "tabs": [] }))),
            ("pane.list".to_owned(), Ok(json!({ "panes": [] }))),
            ("agent.list".to_owned(), Ok(json!({ "agents": [] }))),
        ]));
        let runtime = HerdrAgentRuntime::with_transport(
            context(),
            Arc::clone(&transport) as Arc<dyn ProviderTransport>,
        );
        let token = CancellationToken::new(
            devhub_app_core::OperationId::from_uuid(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
            )
            .expect("operation"),
        );
        let health = drive(runtime.bootstrap(token)).expect("health");
        assert_eq!(health.state(), AgentRuntimeHealthState::Healthy);
        assert_eq!(transport.subscription_count(), 1, "bootstrap installs continuous invalidation");
    }

    #[test]
    fn oversized_profile_is_rejected_before_provider_request() {
        let transport = Arc::new(FakeTransport::new([("sentinel".to_owned(), Ok(json!({})))]));
        let runtime = HerdrAgentRuntime::with_transport(
            context(),
            Arc::clone(&transport) as Arc<dyn ProviderTransport>,
        );
        let agent_id = AgentId::from_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let workspace_id = WorkspaceId::from_uuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let root = WorkspaceRoot::new("/tmp/devhub-profile-budget").unwrap();
        runtime
            .register_agent_workspace(agent_id.clone(), workspace_id.clone(), root.clone())
            .unwrap();
        let profile = AgentProfile::new(
            devhub_app_core::AgentProfileId::from_slug("codex").unwrap(),
            "Codex",
            devhub_app_core::AgentProfileKind::Codex,
            vec!["x".repeat(14_500); 64],
            BTreeMap::new(),
        )
        .unwrap();
        let error = drive(
            runtime.launch_for_workspace(
                workspace_id,
                root,
                agent_id,
                profile,
                CancellationToken::new(
                    devhub_app_core::OperationId::from_uuid(
                        "cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_owned(),
                    )
                    .unwrap(),
                ),
            ),
        )
        .expect_err("oversized profile must fail locally");
        assert_eq!(error.code(), PortErrorCode::Failed);
        assert_eq!(transport.remaining(), 1, "provider must not receive validation failures");
    }

    #[test]
    fn missing_persisted_pane_remains_owned_until_reconcile_can_emit_natural_exit() {
        let transport = Arc::new(FakeTransport::new([
            (
                "ping".to_owned(),
                Ok(json!({
                    "type": "pong",
                    "version": "0.8.1",
                    "protocol": 20,
                    "capabilities": { "live_handoff": true }
                })),
            ),
            (
                "session.snapshot".to_owned(),
                Ok(json!({ "snapshot": { "workspaces": [], "panes": [] } })),
            ),
        ]));
        let journal = std::env::temp_dir()
            .join(format!("devhub-agent-runtime-missing-pane-{}.json", std::process::id()));
        let runtime = HerdrAgentRuntime::with_transport_and_journal(
            context(),
            Arc::clone(&transport) as Arc<dyn ProviderTransport>,
            journal.clone(),
        );
        let agent_id = AgentId::from_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let workspace_id = WorkspaceId::from_uuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let root = WorkspaceRoot::new("/tmp/devhub-restored-agent").unwrap();
        runtime
            .register_agent_workspace(agent_id.clone(), workspace_id.clone(), root.clone())
            .unwrap();
        let mapping = ProviderMapping {
            workspace_id: "provider-workspace".to_owned(),
            tab_id: "provider-tab".to_owned(),
            pane_id: "provider-pane".to_owned(),
            terminal_id: "provider-terminal".to_owned(),
            workspace_root: root.as_path().to_path_buf(),
            workspace_domain_id: Some(workspace_id),
            generation: 1,
        };
        let opaque = encode_provider_mapping(&mapping).expect("opaque mapping");
        let error = drive(
            runtime.attach(
                agent_id.clone(),
                Some(opaque),
                CancellationToken::new(
                    devhub_app_core::OperationId::from_uuid(
                        "cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_owned(),
                    )
                    .unwrap(),
                ),
            ),
        )
        .expect_err("a missing provider pane is not attachable");
        assert_eq!(error.code(), PortErrorCode::Unavailable);
        assert!(runtime
            .inner
            .state
            .lock()
            .expect("runtime state")
            .mappings
            .contains_key(&agent_id));
        let _ = std::fs::remove_file(journal);
    }

    #[test]
    fn unmounted_agent_natural_exit_is_projected_from_provider_reconciliation() {
        let journal = std::fs::canonicalize(std::env::temp_dir())
            .expect("canonical temp directory")
            .join(format!("devhub-agent-runtime-natural-exit-{}.json", std::process::id()));
        let runtime = HerdrAgentRuntime::with_transport_and_journal(
            context(),
            Arc::new(FakeTransport::new([])),
            journal.clone(),
        );
        let agent_id = AgentId::from_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let workspace_id = WorkspaceId::from_uuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let mapping = ProviderMapping {
            workspace_id: "provider-workspace".to_owned(),
            tab_id: "provider-tab".to_owned(),
            pane_id: "provider-pane".to_owned(),
            terminal_id: "provider-terminal".to_owned(),
            workspace_root: PathBuf::from("/tmp/devhub-natural-exit"),
            workspace_domain_id: Some(workspace_id),
            generation: 1,
        };
        runtime
            .inner
            .state
            .lock()
            .expect("runtime state")
            .mappings
            .insert(agent_id.clone(), mapping);

        let (observations, exited) = runtime
            .project_snapshot(&ProviderSnapshot::default())
            .expect("provider absence is a reconciliation result");
        assert!(observations.is_empty());
        assert_eq!(exited, vec![agent_id.clone()]);
        assert!(runtime
            .inner
            .state
            .lock()
            .expect("runtime state")
            .tombstones
            .contains_key(&agent_id));
        let _ = std::fs::remove_file(journal);
    }

    fn drive<T>(mut future: PortFuture<T>) -> Result<T, PortError> {
        let waker = std::task::Waker::noop();
        let mut context = Context::from_waker(waker);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(result) => return result,
                Poll::Pending => thread::sleep(Duration::from_millis(1)),
            }
        }
    }
}
