use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::{
    AgentId, AgentProfile, AgentProfileId, AppModel, AppSnapshot, CleanupProgress, CloseInspection,
    CloseInspectionInputs, CloseInspectionProjection, DomainErrorCode, WorkspaceCloseRollback,
    WorkspaceId, WorkspaceRoot,
};

use super::error::AppError;
use super::intent::{
    AgentLaunchResult, AgentStopResult, CleanupStep, ConfirmationOutcomePurpose, IntentEnvelope,
    IntentOutcome, ProviderEvent, ProviderEventEnvelope, RequestedPath, UserIntent,
    WorkspaceCleanupResult,
};
use super::types::{ConfirmationId, IntentId, OperationId, OperationToken, ProviderEventId};

/// Why the application no longer accepts user work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetachReason {
    WindowClosed,
    Quit,
}

/// The trusted identity generator chooses a confirmation identity after the
/// coordinator has established why confirmation is required. The purpose is
/// domain data only; provider/UI identifiers never cross this seam.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfirmationPurpose {
    StopAgent { agent_id: AgentId },
    WorkspaceClose { workspace_id: WorkspaceId, progress: CleanupProgress },
}

/// Explicit effect seam. Provider and window adapters will grow this enum in
/// later waves; keeping it explicit now prevents adapter concerns leaking into
/// the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Noop,
    Detach(DetachReason),
    ResolveWorkspacePath {
        token: OperationToken,
        path: RequestedPath,
    },
    GenerateWorkspaceId {
        token: OperationToken,
        root: WorkspaceRoot,
        selected_path: crate::DisplayPath,
    },
    ResolveAgentProfile {
        token: OperationToken,
        workspace_id: WorkspaceId,
        profile_id: AgentProfileId,
    },
    GenerateConfirmationId {
        token: OperationToken,
        purpose: ConfirmationPurpose,
    },
    GenerateAgentId {
        token: OperationToken,
        workspace_id: WorkspaceId,
    },
    LaunchAgent {
        token: OperationToken,
        workspace_id: WorkspaceId,
        agent_id: AgentId,
        profile: AgentProfile,
    },
    InspectWorkspace {
        token: OperationToken,
        workspace_id: WorkspaceId,
    },
    StopAgent {
        token: OperationToken,
        agent_id: AgentId,
    },
    /// Compensates a provider launch when the domain commit rejects the
    /// returned identity. This keeps provider state and the sole AppModel
    /// owner from diverging after a late collision.
    TerminateAgent {
        token: OperationToken,
        agent_id: AgentId,
    },
    ReconcileAgents {
        token: OperationToken,
    },
    ReconcileAgent {
        token: OperationToken,
        agent_id: AgentId,
    },
    CleanupWorkspace {
        token: OperationToken,
        workspace_id: WorkspaceId,
        step: CleanupStep,
    },
    PersistState {
        token: OperationToken,
    },
}

pub type CoordinatorEffect = Effect;

pub const MAX_INTENT_LEDGER_ENTRIES: usize = 1_024;
pub const MAX_PROVIDER_LEDGER_ENTRIES: usize = 1_024;
pub const MAX_CONFIRMATION_ID_ENTRIES: usize = 1_024;
pub const MAX_COMPLETED_TOKEN_ENTRIES: usize = 1_024;
pub const MAX_RETAINED_EVENTS: usize = 4_096;

/// Events made available to a shell subscriber.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordinatorEvent {
    Snapshot(AppSnapshot),
    Effect(Effect),
    Noop,
    Error(AppError),
    OperationCompleted { token: OperationToken },
}

/// A cursor replay can be too old after bounded event eviction. The caller
/// must replace its projection with the immutable current snapshot before
/// applying subsequent events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorReplay {
    cursor: u64,
    events: Vec<SequencedCoordinatorEvent>,
    history_gap: bool,
    snapshot: AppSnapshot,
}

impl CoordinatorReplay {
    pub const fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn events(&self) -> &[SequencedCoordinatorEvent] {
        &self.events
    }

    pub const fn history_gap(&self) -> bool {
        self.history_gap
    }

    pub const fn snapshot(&self) -> &AppSnapshot {
        &self.snapshot
    }

    pub fn into_events(self) -> Vec<SequencedCoordinatorEvent> {
        self.events
    }
}

/// A coordinator event together with the process-local sequence at which it
/// was emitted.  The sequence is deliberately independent from the model
/// revision: effects, errors, and no-op acknowledgements are observable even
/// when they leave `AppSnapshot::revision()` unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SequencedCoordinatorEvent {
    sequence: u64,
    event: CoordinatorEvent,
}

impl SequencedCoordinatorEvent {
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub const fn event(&self) -> &CoordinatorEvent {
        &self.event
    }

    pub fn into_event(self) -> CoordinatorEvent {
        self.event
    }
}

/// A small, owned event batch. The coordinator keeps no references into a
/// subscriber, so a caller may freely retain or forward this value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorSubscription {
    cursor: u64,
    events: Vec<SequencedCoordinatorEvent>,
    history_gap: bool,
    snapshot: AppSnapshot,
}

impl CoordinatorSubscription {
    pub const fn cursor(&self) -> u64 {
        self.cursor
    }

    pub const fn history_gap(&self) -> bool {
        self.history_gap
    }

    pub const fn snapshot(&self) -> &AppSnapshot {
        &self.snapshot
    }

    pub fn events(&self) -> &[SequencedCoordinatorEvent] {
        &self.events
    }

    pub fn into_events(self) -> Vec<SequencedCoordinatorEvent> {
        self.events
    }
}

impl Default for CoordinatorSubscription {
    fn default() -> Self {
        Self {
            cursor: 0,
            events: Vec::new(),
            history_gap: false,
            snapshot: AppModel::new().snapshot(),
        }
    }
}

impl IntoIterator for CoordinatorSubscription {
    type Item = SequencedCoordinatorEvent;
    type IntoIter = std::vec::IntoIter<Self::Item>;

    fn into_iter(self) -> Self::IntoIter {
        self.events.into_iter()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationKind {
    ResolveWorkspacePath,
    GenerateWorkspaceId,
    ResolveAgentProfile,
    GenerateConfirmationId,
    GenerateAgentId,
    LaunchAgent,
    InspectWorkspace,
    StopAgent,
    ReconcileAgent,
    ReconcileAgents,
    TerminateAgent,
    Cleanup(CleanupStep),
    PersistState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OperationTarget {
    Path(RequestedPath),
    WorkspacePath { workspace_id: WorkspaceId },
    ResolvedPath { root: WorkspaceRoot, selected_path: crate::DisplayPath },
    Workspace(WorkspaceId),
    Agent(AgentId),
    AgentLaunch { workspace_id: WorkspaceId, agent_id: AgentId },
    Profile { workspace_id: WorkspaceId, profile_id: AgentProfileId },
    Application,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingOperation {
    token: OperationToken,
    kind: OperationKind,
    target: OperationTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DispatchFingerprint {
    Intent { operation_id: Option<OperationId>, intent: UserIntent },
    Provider(ProviderEvent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CachedDispatch {
    fingerprint: DispatchFingerprint,
    result: CachedResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CachedResult {
    Success(Box<IntentOutcome>),
    Failure(AppError),
}

impl CachedDispatch {
    fn from_intent(
        operation_id: Option<&OperationId>,
        intent: &UserIntent,
        result: &Result<IntentOutcome, AppError>,
    ) -> Self {
        Self {
            fingerprint: DispatchFingerprint::Intent {
                operation_id: operation_id.cloned(),
                intent: intent.clone(),
            },
            result: CachedResult::from_result(result),
        }
    }

    fn from_provider(event: &ProviderEvent, result: &Result<IntentOutcome, AppError>) -> Self {
        Self {
            fingerprint: DispatchFingerprint::Provider(event.clone()),
            result: CachedResult::from_result(result),
        }
    }

    fn matches_intent(&self, operation_id: Option<&OperationId>, intent: &UserIntent) -> bool {
        self.fingerprint
            == DispatchFingerprint::Intent {
                operation_id: operation_id.cloned(),
                intent: intent.clone(),
            }
    }

    fn matches_provider(&self, event: &ProviderEvent) -> bool {
        self.fingerprint == DispatchFingerprint::Provider(event.clone())
    }

    fn into_result(self) -> Result<IntentOutcome, AppError> {
        self.result.into_result()
    }
}

impl CachedResult {
    fn from_result(result: &Result<IntentOutcome, AppError>) -> Self {
        match result {
            Ok(outcome) => Self::Success(Box::new(outcome.clone())),
            Err(error) => Self::Failure(error.clone()),
        }
    }

    fn into_result(self) -> Result<IntentOutcome, AppError> {
        match self {
            Self::Success(outcome) => Ok(*outcome),
            Self::Failure(error) => Err(error),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CleanupState {
    operation_id: OperationId,
    workspace_id: WorkspaceId,
    progress: CleanupProgress,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PendingConfirmationState {
    Stop {
        confirmation_id: ConfirmationId,
        agent_id: AgentId,
    },
    WorkspaceClose {
        confirmation_id: ConfirmationId,
        workspace_id: WorkspaceId,
        progress: CleanupProgress,
        inspection: CloseInspectionProjection,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PendingConfirmationRequest {
    Stop {
        agent_id: AgentId,
    },
    WorkspaceClose {
        workspace_id: WorkspaceId,
        progress: CleanupProgress,
        inspection: CloseInspectionProjection,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CleanupPersistenceContinuation {
    StartNext { workspace_id: WorkspaceId, progress: CleanupProgress },
    FinalInspection { workspace_id: WorkspaceId, progress: CleanupProgress },
    FinalizeWorkspace { workspace_id: WorkspaceId, progress: CleanupProgress },
}

/// Exactly one provider reconciliation epoch may be active at a time. An
/// aggregate reconciliation and a per-Agent reconciliation share this same
/// ordering so an older completion can never apply after a newer one of the
/// other kind.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ActiveReconcile {
    Agents { token: OperationToken, epoch: u64 },
    Agent { token: OperationToken, agent_id: AgentId, epoch: u64 },
}

impl ActiveReconcile {
    fn token(&self) -> &OperationToken {
        match self {
            Self::Agents { token, .. } | Self::Agent { token, .. } => token,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InspectionContinuation {
    Begin,
    Confirm { progress: CleanupProgress },
    Retry { progress: CleanupProgress },
    Finalize { progress: CleanupProgress },
}

/// The sole owner of mutable application state at the application seam.
#[derive(Debug)]
pub struct AppCoordinator {
    model: AppModel,
    events: VecDeque<SequencedCoordinatorEvent>,
    next_sequence: u64,
    subscriber_cursor: u64,
    intent_cache: BTreeMap<IntentId, CachedDispatch>,
    provider_event_cache: BTreeMap<ProviderEventId, CachedDispatch>,
    confirmation_ids: BTreeSet<ConfirmationId>,
    pending: BTreeMap<OperationId, PendingOperation>,
    completed_tokens: BTreeMap<OperationId, OperationToken>,
    resolved_paths: BTreeMap<OperationId, (WorkspaceRoot, crate::DisplayPath)>,
    resolved_profiles: BTreeMap<OperationId, (WorkspaceId, AgentProfile)>,
    launch_profiles: BTreeMap<OperationId, (WorkspaceId, AgentId, AgentProfile)>,
    inspection_continuations: BTreeMap<OperationId, InspectionContinuation>,
    confirmation_requests: BTreeMap<OperationId, PendingConfirmationRequest>,
    confirmations: Vec<PendingConfirmationState>,
    cleanup: BTreeMap<WorkspaceId, CleanupState>,
    cleanup_persistence: BTreeMap<OperationId, CleanupPersistenceContinuation>,
    finalization_pending: BTreeSet<OperationId>,
    finalization_workspaces: BTreeMap<OperationId, WorkspaceId>,
    finalization_roots: BTreeMap<WorkspaceRoot, OperationId>,
    /// Model image retained while the final removal save is in flight. The
    /// durable journal still contains the Closing tombstone; restoring this
    /// image on a failed save makes the in-process retry state agree with the
    /// relaunch state without repeating provider destruction.
    finalization_backups: BTreeMap<OperationId, WorkspaceCloseRollback>,
    next_generation: u64,
    intent_order: VecDeque<IntentId>,
    provider_event_order: VecDeque<ProviderEventId>,
    confirmation_id_order: VecDeque<ConfirmationId>,
    completed_token_order: VecDeque<(OperationId, OperationToken)>,
    /// Stop completions that raced a provider-proven natural exit are
    /// idempotent acknowledgements. Keying by the full token keeps an old
    /// completion from being accepted for a reused operation ID/generation.
    natural_exit_stop_tokens: BTreeMap<OperationToken, AgentId>,
    natural_exit_stop_order: VecDeque<OperationToken>,
    active_reconcile: Option<ActiveReconcile>,
    reconcile_epoch: u64,
    readiness: super::types::AppReadiness,
    detached: Option<DetachReason>,
}

impl Default for AppCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl AppCoordinator {
    pub fn new() -> Self {
        Self::with_model(AppModel::new())
    }

    pub fn with_model(model: AppModel) -> Self {
        let snapshot = model.snapshot();
        let mut coordinator = Self {
            model,
            events: VecDeque::new(),
            next_sequence: 0,
            subscriber_cursor: 0,
            intent_cache: BTreeMap::new(),
            provider_event_cache: BTreeMap::new(),
            confirmation_ids: BTreeSet::new(),
            pending: BTreeMap::new(),
            completed_tokens: BTreeMap::new(),
            resolved_paths: BTreeMap::new(),
            resolved_profiles: BTreeMap::new(),
            launch_profiles: BTreeMap::new(),
            inspection_continuations: BTreeMap::new(),
            confirmation_requests: BTreeMap::new(),
            confirmations: Vec::new(),
            cleanup: BTreeMap::new(),
            cleanup_persistence: BTreeMap::new(),
            finalization_pending: BTreeSet::new(),
            finalization_workspaces: BTreeMap::new(),
            finalization_roots: BTreeMap::new(),
            finalization_backups: BTreeMap::new(),
            next_generation: 0,
            intent_order: VecDeque::new(),
            provider_event_order: VecDeque::new(),
            confirmation_id_order: VecDeque::new(),
            completed_token_order: VecDeque::new(),
            natural_exit_stop_tokens: BTreeMap::new(),
            natural_exit_stop_order: VecDeque::new(),
            active_reconcile: None,
            reconcile_epoch: 0,
            readiness: super::types::AppReadiness::Starting,
            detached: None,
        };
        coordinator.emit(CoordinatorEvent::Snapshot(snapshot));
        coordinator
    }

    pub fn snapshot(&self) -> AppSnapshot {
        self.model.snapshot()
    }

    pub const fn readiness(&self) -> super::types::AppReadiness {
        self.readiness
    }

    /// Marks native bootstrap complete without changing the domain snapshot
    /// revision. Readiness is coordinator lifecycle, not a UI-owned model.
    pub fn mark_ready(&mut self) {
        self.readiness = super::types::AppReadiness::Ready;
    }

    /// Starts a provider reconciliation for one domain Agent. The caller
    /// supplies the operation identity so the coordinator never fabricates a
    /// production identifier behind the port seam.
    pub fn request_agent_reconcile(
        &mut self,
        operation_id: OperationId,
        agent_id: AgentId,
    ) -> Result<IntentOutcome, AppError> {
        if self.pending.contains_key(&operation_id) {
            return Err(AppError::new(super::error::AppErrorCode::OperationInProgress)
                .with_operation(operation_id));
        }
        if self.model.workspace_for_agent(&agent_id).is_none() {
            return Err(AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::UnknownAgent));
        }
        let next_epoch = self.reconcile_epoch.checked_add(1).ok_or_else(|| {
            AppError::new(super::error::AppErrorCode::OperationGenerationExhausted)
                .with_operation(operation_id.clone())
        })?;
        self.invalidate_reconciliation();
        let (token, operation_id) = self.start_operation(
            OperationKind::ReconcileAgent,
            OperationTarget::Agent(agent_id.clone()),
            operation_id,
        )?;
        self.reconcile_epoch = next_epoch;
        self.active_reconcile = Some(ActiveReconcile::Agent {
            token: token.clone(),
            agent_id: agent_id.clone(),
            epoch: self.reconcile_epoch,
        });
        self.emit_effect(Effect::ReconcileAgent { token, agent_id });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    /// Starts one atomic reconciliation epoch for all provider Agents. The
    /// operation identity is supplied by the trusted shell/adapter boundary;
    /// the coordinator only correlates it and never invents a domain ID.
    pub fn request_agents_reconcile(
        &mut self,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        if self.pending.contains_key(&operation_id) {
            return Err(AppError::new(super::error::AppErrorCode::OperationInProgress)
                .with_operation(operation_id));
        }
        let next_epoch = self.reconcile_epoch.checked_add(1).ok_or_else(|| {
            AppError::new(super::error::AppErrorCode::OperationGenerationExhausted)
                .with_operation(operation_id.clone())
        })?;
        self.invalidate_reconciliation();
        let (token, operation_id) = self.start_operation(
            OperationKind::ReconcileAgents,
            OperationTarget::Application,
            operation_id,
        )?;
        self.reconcile_epoch = next_epoch;
        self.active_reconcile =
            Some(ActiveReconcile::Agents { token: token.clone(), epoch: self.reconcile_epoch });
        self.emit_effect(Effect::ReconcileAgents { token });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    /// Returns events emitted since this coordinator's last subscription.
    /// Events are retained for cursor-based replay; reading them does not
    /// destroy the source log.
    pub fn subscribe(&mut self) -> CoordinatorSubscription {
        let subscription = self.subscribe_from(self.subscriber_cursor);
        self.subscriber_cursor = self.next_sequence;
        subscription
    }

    /// Replays all retained events after `cursor`. A cursor is a process-local
    /// sequence, not an AppModel revision, so a no-op or effect is replayable.
    pub fn subscribe_from(&self, cursor: u64) -> CoordinatorSubscription {
        let events =
            self.events.iter().filter(|event| event.sequence() > cursor).cloned().collect();
        let history_gap =
            self.events.front().is_some_and(|event| cursor.saturating_add(1) < event.sequence());
        CoordinatorSubscription {
            cursor: self.next_sequence,
            events,
            history_gap,
            snapshot: self.snapshot(),
        }
    }

    /// Explicit replay result for consumers that need to branch on a history
    /// gap before applying events. A gap always carries the current immutable
    /// snapshot as the replacement projection.
    pub fn replay_from(&self, cursor: u64) -> CoordinatorReplay {
        let subscription = self.subscribe_from(cursor);
        CoordinatorReplay {
            cursor: subscription.cursor,
            events: subscription.events,
            history_gap: subscription.history_gap,
            snapshot: subscription.snapshot,
        }
    }

    pub fn dispatch_user(&mut self, envelope: IntentEnvelope) -> Result<IntentOutcome, AppError> {
        let (intent_id, trusted_operation_id, intent) = envelope.into_parts();
        if let Some(cached) = self.intent_cache.get(&intent_id).cloned() {
            if cached.matches_intent(trusted_operation_id.as_ref(), &intent) {
                // A duplicate is an acknowledgement of the original result.
                // It never re-runs a model transition or effect. The no-op
                // event is intentionally separate from the cached outcome.
                self.emit(CoordinatorEvent::Noop);
                return cached.into_result();
            }
            let error = AppError::new(super::error::AppErrorCode::DuplicateIntent)
                .with_intent(intent_id.clone());
            self.emit(CoordinatorEvent::Error(error.clone()));
            return Err(error);
        }

        if self.detached.is_some() {
            let result = Ok(IntentOutcome::Detached { snapshot: self.snapshot() });
            self.cache_intent(intent_id, trusted_operation_id.as_ref(), &intent, &result);
            self.emit(CoordinatorEvent::Noop);
            return result;
        }

        let Some(operation_id) = trusted_operation_id.clone() else {
            let error = AppError::new(super::error::AppErrorCode::InvalidIntent)
                .with_intent(intent_id.clone());
            let result = Err(error.clone());
            self.cache_intent(intent_id, trusted_operation_id.as_ref(), &intent, &result);
            self.emit(CoordinatorEvent::Error(error));
            return result;
        };
        let fingerprint = intent.clone();
        let result = self.dispatch_new_intent(intent, operation_id);
        if let Err(error) = &result {
            self.emit(CoordinatorEvent::Error(error.clone()));
        }
        // The command is cloned before dispatch so the exact request
        // fingerprint remains available for duplicate-ID collision checks.
        self.cache_intent(intent_id, trusted_operation_id.as_ref(), &fingerprint, &result);
        result
    }

    pub fn accept_provider_event(
        &mut self,
        envelope: ProviderEventEnvelope,
    ) -> Result<IntentOutcome, AppError> {
        let (event_id, event) = envelope.into_parts();
        if let Some(cached) = self.provider_event_cache.get(&event_id).cloned() {
            if cached.matches_provider(&event) {
                self.emit(CoordinatorEvent::Noop);
                return cached.into_result();
            }
            let error = AppError::new(super::error::AppErrorCode::DuplicateIntent)
                .with_provider_event(event_id.clone());
            self.emit(CoordinatorEvent::Error(error.clone()));
            return Err(error);
        }

        let result = self.apply_provider_event(&event);
        if let Err(error) = &result {
            self.emit(CoordinatorEvent::Error(error.clone()));
        }
        self.cache_provider_event(event_id, &event, &result);
        result
    }

    fn dispatch_new_intent(
        &mut self,
        intent: UserIntent,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let before_revision = self.model.snapshot().revision();
        match intent {
            UserIntent::SelectContext(context) => {
                self.model.select_context(context).map_err(AppError::from)?;
                Ok(self.transition_outcome(before_revision, operation_id.clone()))
            }
            UserIntent::SelectActivity(activity) => {
                self.model.select_activity(activity).map_err(AppError::from)?;
                Ok(self.transition_outcome(before_revision, operation_id.clone()))
            }
            UserIntent::ToggleWorkspaceDisclosure { workspace_id, expanded } => {
                self.model
                    .set_workspace_disclosure(&workspace_id, expanded)
                    .map_err(AppError::from)?;
                Ok(self.transition_outcome(before_revision, operation_id.clone()))
            }
            UserIntent::ResizeSidebar { width } => {
                self.model.set_sidebar_width(width).map_err(AppError::from)?;
                Ok(self.transition_outcome(before_revision, operation_id.clone()))
            }
            UserIntent::OpenFolder { path } => {
                self.begin_workspace_resolution(path, operation_id.clone())
            }
            UserIntent::NewWindow { path: Some(path) } => {
                self.begin_workspace_resolution(path, operation_id.clone())
            }
            UserIntent::RetryWorkspace { workspace_id } => {
                self.begin_workspace_retry(workspace_id, operation_id.clone())
            }
            UserIntent::LocateWorkspace { workspace_id, path } => {
                self.begin_workspace_relocation(workspace_id, path, operation_id.clone())
            }
            UserIntent::NewWindow { path: None } => {
                // `AppModel::select_context` intentionally resets the
                // canonical activity for a context. Avoid invoking it when
                // already focused on Global so NewWindow(None) can be a true
                // revision-preserving no-op.
                if self.model.selection().context() != &crate::NavigationContext::Global {
                    self.model
                        .select_context(crate::NavigationContext::Global)
                        .map_err(AppError::from)?;
                }
                self.model.select_activity(crate::Activity::Editor).map_err(AppError::from)?;
                Ok(self.transition_outcome(before_revision, operation_id.clone()))
            }
            UserIntent::CreateAgent { workspace_id, profile_id } => {
                self.begin_profile_resolution(workspace_id, profile_id, operation_id.clone())
            }
            UserIntent::RenameAgent { agent_id, display_name } => {
                self.model.rename_agent(&agent_id, display_name).map_err(AppError::from)?;
                Ok(self.transition_outcome(before_revision, operation_id.clone()))
            }
            UserIntent::StopAgent { agent_id } => {
                self.begin_stop_confirmation(agent_id, operation_id.clone())
            }
            UserIntent::ConfirmStopAgent { confirmation_id } => {
                self.confirm_stop(confirmation_id, operation_id.clone())
            }
            UserIntent::RetryStopAgent { agent_id } => {
                self.retry_stop(agent_id, operation_id.clone())
            }
            UserIntent::ReconcileAgent { agent_id } => {
                self.request_agent_reconcile(operation_id.clone(), agent_id)
            }
            UserIntent::RequestCloseWorkspace { workspace_id } => self.begin_workspace_inspection(
                workspace_id,
                operation_id.clone(),
                InspectionContinuation::Begin,
            ),
            UserIntent::ConfirmCloseWorkspace { confirmation_id } => {
                self.confirm_workspace_close(confirmation_id, operation_id.clone())
            }
            UserIntent::RetryCloseWorkspace { workspace_id } => {
                self.retry_workspace_close(workspace_id, operation_id.clone())
            }
            UserIntent::WindowClosed => Ok(self.detach(DetachReason::WindowClosed)),
            UserIntent::Quit => Ok(self.detach(DetachReason::Quit)),
        }
    }

    fn transition_outcome(
        &mut self,
        before_revision: u64,
        operation_id: OperationId,
    ) -> IntentOutcome {
        let snapshot = self.snapshot();
        if snapshot.revision() == before_revision {
            self.emit(CoordinatorEvent::Noop);
            IntentOutcome::Noop { snapshot }
        } else {
            self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
            self.queue_persist(operation_id);
            IntentOutcome::Updated { snapshot }
        }
    }

    fn begin_workspace_resolution(
        &mut self,
        path: RequestedPath,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let (token, operation_id) = self.start_operation(
            OperationKind::ResolveWorkspacePath,
            OperationTarget::Path(path.clone()),
            operation_id,
        )?;
        self.emit_effect(Effect::ResolveWorkspacePath { token, path });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn begin_workspace_retry(
        &mut self,
        workspace_id: WorkspaceId,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let workspace = self.model.workspace(&workspace_id).ok_or_else(|| {
            AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::UnknownWorkspace)
        })?;
        if !matches!(workspace.state(), crate::WorkspaceState::Unavailable { .. }) {
            return Err(AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::WorkspaceNotUnavailable));
        }
        let path = RequestedPath::new(workspace.selected_path().as_path().to_string_lossy())
            .map_err(AppError::from)?;
        self.begin_workspace_relocation(workspace_id, path, operation_id)
    }

    fn begin_workspace_relocation(
        &mut self,
        workspace_id: WorkspaceId,
        path: RequestedPath,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let workspace = self.model.workspace(&workspace_id).ok_or_else(|| {
            AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::UnknownWorkspace)
        })?;
        if !matches!(workspace.state(), crate::WorkspaceState::Unavailable { .. }) {
            return Err(AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::WorkspaceNotUnavailable));
        }
        let (token, operation_id) = self.start_operation(
            OperationKind::ResolveWorkspacePath,
            OperationTarget::WorkspacePath { workspace_id },
            operation_id,
        )?;
        self.emit_effect(Effect::ResolveWorkspacePath { token, path });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn begin_profile_resolution(
        &mut self,
        workspace_id: WorkspaceId,
        profile_id: AgentProfileId,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let workspace = self.model.workspace(&workspace_id).ok_or_else(|| {
            AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::UnknownWorkspace)
        })?;
        if !workspace.can_create_agent() {
            return Err(AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::WorkspaceUnavailable));
        }
        let (token, operation_id) = self.start_operation(
            OperationKind::ResolveAgentProfile,
            OperationTarget::Profile {
                workspace_id: workspace_id.clone(),
                profile_id: profile_id.clone(),
            },
            operation_id,
        )?;
        self.emit_effect(Effect::ResolveAgentProfile { token, workspace_id, profile_id });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn begin_stop_confirmation(
        &mut self,
        agent_id: AgentId,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        if self.model.workspace_for_agent(&agent_id).is_none() {
            return Err(AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::UnknownAgent));
        }
        let (token, operation_id) = self.start_operation(
            OperationKind::GenerateConfirmationId,
            OperationTarget::Agent(agent_id.clone()),
            operation_id,
        )?;
        self.confirmation_requests.insert(
            operation_id.clone(),
            PendingConfirmationRequest::Stop { agent_id: agent_id.clone() },
        );
        self.emit_effect(Effect::GenerateConfirmationId {
            token,
            purpose: ConfirmationPurpose::StopAgent { agent_id },
        });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn confirm_stop(
        &mut self,
        confirmation_id: ConfirmationId,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let Some(position) = self.confirmations.iter().position(|pending| {
            matches!(pending, PendingConfirmationState::Stop { confirmation_id: id, .. } if id == &confirmation_id)
        }) else {
            return Err(AppError::new(super::error::AppErrorCode::ConfirmationExpired));
        };
        let PendingConfirmationState::Stop { agent_id, .. } = self.confirmations.remove(position)
        else {
            unreachable!("position selected a Stop confirmation")
        };
        self.model.request_agent_stop(&agent_id).map_err(AppError::from)?;
        let (token, operation_id) = self.start_operation(
            OperationKind::StopAgent,
            OperationTarget::Agent(agent_id.clone()),
            operation_id,
        )?;
        self.emit_effect(Effect::StopAgent { token, agent_id });
        self.emit(CoordinatorEvent::Snapshot(self.snapshot()));
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn retry_stop(
        &mut self,
        agent_id: AgentId,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let can_retry = self
            .model
            .snapshot()
            .workspaces()
            .iter()
            .flat_map(|workspace| workspace.agents())
            .find(|agent| agent.id() == &agent_id)
            .map(|agent| agent.can_retry_stop())
            .ok_or_else(|| {
                AppError::new(super::error::AppErrorCode::Domain)
                    .with_domain(DomainErrorCode::UnknownAgent)
            })?;
        if !can_retry {
            return Err(AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::InvalidAgentControlTransition));
        }
        self.model.retry_agent_stop(&agent_id).map_err(AppError::from)?;
        let (token, operation_id) = self.start_operation(
            OperationKind::StopAgent,
            OperationTarget::Agent(agent_id.clone()),
            operation_id,
        )?;
        self.emit_effect(Effect::StopAgent { token, agent_id });
        self.emit(CoordinatorEvent::Snapshot(self.snapshot()));
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn begin_workspace_inspection(
        &mut self,
        workspace_id: WorkspaceId,
        operation_id: OperationId,
        continuation: InspectionContinuation,
    ) -> Result<IntentOutcome, AppError> {
        let workspace = self.model.workspace(&workspace_id).ok_or_else(|| {
            AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::UnknownWorkspace)
        })?;
        let continuing_cleanup =
            self.cleanup.get(&workspace_id).is_some_and(|state| state.operation_id == operation_id);
        match workspace.state() {
            crate::WorkspaceState::Closing { .. }
                if !matches!(continuation, InspectionContinuation::Finalize { .. })
                    && !(matches!(continuation, InspectionContinuation::Retry { .. })
                        && !continuing_cleanup) =>
            {
                return Err(AppError::new(super::error::AppErrorCode::Domain)
                    .with_domain(DomainErrorCode::WorkspaceClosing));
            }
            crate::WorkspaceState::ClosingFailed { .. }
                if matches!(continuation, InspectionContinuation::Begin) =>
            {
                return Err(AppError::new(super::error::AppErrorCode::Domain)
                    .with_domain(DomainErrorCode::WorkspaceClosingFailed));
            }
            _ => {}
        }
        let (token, operation_id) = self.start_operation(
            OperationKind::InspectWorkspace,
            OperationTarget::Workspace(workspace_id.clone()),
            operation_id,
        )?;
        self.inspection_continuations.insert(operation_id.clone(), continuation);
        self.emit_effect(Effect::InspectWorkspace { token, workspace_id });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn confirm_workspace_close(
        &mut self,
        confirmation_id: ConfirmationId,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let Some(position) = self.confirmations.iter().position(|pending| {
            matches!(pending, PendingConfirmationState::WorkspaceClose { confirmation_id: id, .. } if id == &confirmation_id)
        }) else {
            return Err(AppError::new(super::error::AppErrorCode::ConfirmationExpired));
        };
        let PendingConfirmationState::WorkspaceClose { workspace_id, progress, .. } =
            self.confirmations.remove(position)
        else {
            unreachable!("position selected a WorkspaceClose confirmation")
        };
        // A previous inspection is never trusted after confirmation. The
        // provider must inspect again before any destructive effect starts.
        self.begin_workspace_inspection(
            workspace_id,
            operation_id,
            InspectionContinuation::Confirm { progress },
        )
    }

    fn retry_workspace_close(
        &mut self,
        workspace_id: WorkspaceId,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let Some(cleanup) = self.cleanup.get(&workspace_id).cloned() else {
            return Err(AppError::new(super::error::AppErrorCode::UnknownOperation));
        };
        self.begin_workspace_inspection(
            workspace_id,
            operation_id,
            InspectionContinuation::Retry { progress: cleanup.progress },
        )
    }

    /// Re-enters provider inspection for a durable Closing record recovered
    /// after relaunch. The native adapter supplies a fresh operation identity;
    /// no in-memory cleanup token is assumed to survive the crash.
    pub fn resume_persisted_close(
        &mut self,
        workspace_id: WorkspaceId,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let progress = self
            .model
            .workspace(&workspace_id)
            .and_then(|workspace| workspace.state().cleanup_progress())
            .ok_or_else(|| {
                AppError::new(super::error::AppErrorCode::Domain)
                    .with_domain(DomainErrorCode::UnknownWorkspace)
            })?;
        self.begin_workspace_inspection(
            workspace_id,
            operation_id,
            InspectionContinuation::Retry { progress },
        )
    }

    fn apply_provider_event(&mut self, event: &ProviderEvent) -> Result<IntentOutcome, AppError> {
        match event {
            ProviderEvent::WorkspacePathResolved { token, root, selected_path } => {
                self.complete_workspace_path(token, root, selected_path)
            }
            ProviderEvent::WorkspaceIdGenerated { token, workspace_id } => {
                self.complete_workspace_id(token, workspace_id)
            }
            ProviderEvent::WorkspaceInspectionCompleted { token, workspace_id, inspection } => {
                self.complete_workspace_inspection(token, workspace_id, *inspection)
            }
            ProviderEvent::AgentStopCompleted { token, agent_id, result } => {
                self.complete_agent_stop(token, agent_id, *result)
            }
            ProviderEvent::AgentTerminationCompleted { token, agent_id, result } => {
                self.complete_agent_termination(token, agent_id, *result)
            }
            ProviderEvent::WorkspaceCleanupCompleted { token, workspace_id, result } => {
                self.complete_workspace_cleanup(token, workspace_id, *result)
            }
            ProviderEvent::ConfirmationIdGenerated { token, confirmation_id } => {
                self.complete_confirmation_id(token, confirmation_id)
            }
            ProviderEvent::ProfileResolved { token, workspace_id, profile } => {
                self.complete_profile_resolved(token, workspace_id, profile)
            }
            ProviderEvent::AgentIdGenerated { token, workspace_id, agent_id } => {
                self.complete_agent_id(token, workspace_id, agent_id)
            }
            ProviderEvent::AgentLaunchCompleted { token, workspace_id, agent_id, result } => {
                self.complete_agent_launch(token, workspace_id, agent_id, *result)
            }
            ProviderEvent::AgentsReconciled { token, reconciliation } => {
                self.complete_agents_reconcile(token, reconciliation)
            }
            ProviderEvent::AgentStatusChanged { token, agent_id, status, runtime_health } => {
                self.reconcile_agent(token, agent_id, *status, *runtime_health)
            }
            ProviderEvent::AgentExited { token, agent_id } => self.agent_exited(token, agent_id),
            ProviderEvent::StatePersisted { token } => self.complete_persist(token),
            ProviderEvent::StatePersistenceFailed { token } => self.complete_persist_failed(token),
            ProviderEvent::OperationFailed { token } => self.complete_operation_failed(token),
        }
    }

    fn complete_operation_failed(
        &mut self,
        token: &OperationToken,
    ) -> Result<IntentOutcome, AppError> {
        let Some(pending) = self.pending.get(token.operation_id()).cloned() else {
            let code = if self.completed_tokens.contains_key(token.operation_id()) {
                super::error::AppErrorCode::StaleCompletion
            } else {
                super::error::AppErrorCode::UnknownOperation
            };
            return Err(AppError::new(code).with_operation(token.operation_id().clone()));
        };
        if pending.token != *token {
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(token.operation_id().clone()));
        }
        self.pending.remove(token.operation_id());
        self.clear_operation_auxiliary_state(token);
        self.remember_completed(token.clone());
        Err(AppError::new(super::error::AppErrorCode::PortUnavailable)
            .with_operation(token.operation_id().clone()))
    }

    fn clear_operation_auxiliary_state(&mut self, token: &OperationToken) {
        let operation_id = token.operation_id();
        self.resolved_paths.remove(operation_id);
        self.resolved_profiles.remove(operation_id);
        self.launch_profiles.remove(operation_id);
        self.inspection_continuations.remove(operation_id);
        self.confirmation_requests.remove(operation_id);
        self.cleanup_persistence.remove(operation_id);
        self.finalization_pending.remove(operation_id);
        if let Some(workspace_id) = self.finalization_workspaces.remove(operation_id) {
            self.cleanup.remove(&workspace_id);
            self.finalization_backups.remove(operation_id);
            self.finalization_roots.retain(|_, owner| owner != operation_id);
        }
        if self.active_reconcile.as_ref().is_some_and(|active| active.token() == token) {
            self.active_reconcile = None;
        }
        self.cleanup.retain(|_, state| &state.operation_id != operation_id);
    }

    fn complete_workspace_path(
        &mut self,
        token: &OperationToken,
        root: &WorkspaceRoot,
        selected_path: &crate::DisplayPath,
    ) -> Result<IntentOutcome, AppError> {
        let pending = self.take_pending(token, OperationKind::ResolveWorkspacePath, |target| {
            matches!(target, OperationTarget::Path(_) | OperationTarget::WorkspacePath { .. })
        })?;
        let relocating_workspace = match &pending.target {
            OperationTarget::WorkspacePath { workspace_id } => Some(workspace_id.clone()),
            OperationTarget::Path(_) => None,
            _ => unreachable!("workspace path completion target was validated above"),
        };
        if let Some(workspace_id) = relocating_workspace {
            self.model
                .relocate_workspace(&workspace_id, root.clone(), selected_path.clone())
                .map_err(AppError::from)?;
            self.model
                .select_context(crate::NavigationContext::Workspace(workspace_id))
                .map_err(AppError::from)?;
            let snapshot = self.snapshot();
            self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
            self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
            self.queue_persist(token.operation_id().clone());
            return Ok(IntentOutcome::Updated { snapshot });
        }
        let previous_operation_id = pending.token.operation_id().clone();
        self.resolved_paths
            .insert(previous_operation_id.clone(), (root.clone(), selected_path.clone()));
        let (next_token, next_operation_id) = self.start_operation(
            OperationKind::GenerateWorkspaceId,
            OperationTarget::ResolvedPath {
                root: root.clone(),
                selected_path: selected_path.clone(),
            },
            previous_operation_id.clone(),
        )?;
        let resolved = self
            .resolved_paths
            .remove(&previous_operation_id)
            .expect("path completion was retained");
        self.resolved_paths.insert(next_token.operation_id().clone(), resolved);
        self.emit_effect(Effect::GenerateWorkspaceId {
            token: next_token,
            root: root.clone(),
            selected_path: selected_path.clone(),
        });
        Ok(IntentOutcome::Deferred { operation_id: next_operation_id, snapshot: self.snapshot() })
    }

    fn complete_workspace_id(
        &mut self,
        token: &OperationToken,
        workspace_id: &WorkspaceId,
    ) -> Result<IntentOutcome, AppError> {
        self.take_pending(token, OperationKind::GenerateWorkspaceId, |target| {
            matches!(target, OperationTarget::ResolvedPath { .. })
        })?;
        let (root, selected_path) =
            self.resolved_paths.remove(token.operation_id()).ok_or_else(|| {
                AppError::new(super::error::AppErrorCode::UnknownOperation)
                    .with_operation(token.operation_id().clone())
            })?;
        if self.finalization_roots.contains_key(&root) {
            return Err(AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::DuplicateWorkspaceRoot)
                .with_operation(token.operation_id().clone()));
        }
        // Canonical Workspace Root is the uniqueness key. Opening an already
        // open root is a focus operation, not a duplicate-resource failure.
        // Resolve the existing identity before attempting any model mutation
        // so the coordinator remains the sole owner of selection state.
        if let Some(existing_id) = self
            .model
            .workspaces()
            .iter()
            .find(|workspace| workspace.state().is_available() && workspace.root() == &root)
            .map(|workspace| workspace.id().clone())
        {
            let before_revision = self.model.snapshot().revision();
            self.model
                .select_context(crate::NavigationContext::Workspace(existing_id))
                .map_err(AppError::from)?;
            let snapshot = self.snapshot();
            if snapshot.revision() != before_revision {
                self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
                self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
                self.queue_persist(token.operation_id().clone());
                return Ok(IntentOutcome::Updated { snapshot });
            }
            self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
            self.emit(CoordinatorEvent::Noop);
            return Ok(IntentOutcome::Noop { snapshot });
        }
        self.model
            .add_workspace(crate::Workspace::new(workspace_id.clone(), root, selected_path, None))
            .map_err(AppError::from)?;
        let snapshot = self.snapshot();
        self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
        self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
        self.queue_persist(token.operation_id().clone());
        Ok(IntentOutcome::Updated { snapshot })
    }

    fn complete_profile_resolved(
        &mut self,
        token: &OperationToken,
        workspace_id: &WorkspaceId,
        profile: &AgentProfile,
    ) -> Result<IntentOutcome, AppError> {
        let pending = self.take_pending(token, OperationKind::ResolveAgentProfile, |target| {
            matches!(target, OperationTarget::Profile { workspace_id: id, profile_id } if id == workspace_id && profile.id() == profile_id)
        })?;
        let operation_id = pending.token.operation_id().clone();
        if !self.workspace_allows_agent_creation(workspace_id) {
            self.resolved_profiles.remove(&operation_id);
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(operation_id));
        }
        let profile_id = profile.id().clone();
        self.resolved_profiles
            .insert(operation_id.clone(), (workspace_id.clone(), profile.clone()));
        let (next_token, next_operation_id) = self.start_operation(
            OperationKind::GenerateAgentId,
            OperationTarget::Profile { workspace_id: workspace_id.clone(), profile_id },
            operation_id.clone(),
        )?;
        let resolved =
            self.resolved_profiles.remove(&operation_id).expect("profile completion was retained");
        self.resolved_profiles.insert(next_token.operation_id().clone(), resolved);
        self.emit_effect(Effect::GenerateAgentId {
            token: next_token,
            workspace_id: workspace_id.clone(),
        });
        Ok(IntentOutcome::Deferred { operation_id: next_operation_id, snapshot: self.snapshot() })
    }

    fn complete_agent_id(
        &mut self,
        token: &OperationToken,
        workspace_id: &WorkspaceId,
        agent_id: &AgentId,
    ) -> Result<IntentOutcome, AppError> {
        self.take_pending(
            token,
            OperationKind::GenerateAgentId,
            |target| matches!(target, OperationTarget::Profile { workspace_id: id, .. } if id == workspace_id),
        )?;
        if !self.workspace_allows_agent_creation(workspace_id) {
            self.resolved_profiles.remove(token.operation_id());
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(token.operation_id().clone()));
        }
        let (_, profile) =
            self.resolved_profiles.remove(token.operation_id()).ok_or_else(|| {
                AppError::new(super::error::AppErrorCode::UnknownOperation)
                    .with_operation(token.operation_id().clone())
            })?;
        self.launch_profiles.insert(
            token.operation_id().clone(),
            (workspace_id.clone(), agent_id.clone(), profile.clone()),
        );
        let (launch_token, operation_id) = self.start_operation(
            OperationKind::LaunchAgent,
            OperationTarget::AgentLaunch {
                workspace_id: workspace_id.clone(),
                agent_id: agent_id.clone(),
            },
            token.operation_id().clone(),
        )?;
        self.emit_effect(Effect::LaunchAgent {
            token: launch_token,
            workspace_id: workspace_id.clone(),
            agent_id: agent_id.clone(),
            profile,
        });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn complete_agent_launch(
        &mut self,
        token: &OperationToken,
        workspace_id: &WorkspaceId,
        agent_id: &AgentId,
        result: AgentLaunchResult,
    ) -> Result<IntentOutcome, AppError> {
        if !self.workspace_allows_agent_creation(workspace_id) {
            self.cancel_workspace_agent_operations(workspace_id);
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(token.operation_id().clone()));
        }
        let (expected_workspace, expected_agent) = self
            .launch_profiles
            .get(token.operation_id())
            .map(|(workspace_id, agent_id, _)| (workspace_id.clone(), agent_id.clone()))
            .ok_or_else(|| {
                let code = if self.pending.contains_key(token.operation_id())
                    || self.completed_tokens.contains_key(token.operation_id())
                {
                    super::error::AppErrorCode::StaleCompletion
                } else {
                    super::error::AppErrorCode::UnknownOperation
                };
                AppError::new(code).with_operation(token.operation_id().clone())
            })?;
        if &expected_workspace != workspace_id || &expected_agent != agent_id {
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(token.operation_id().clone()));
        }
        self.take_pending(
            token,
            OperationKind::LaunchAgent,
            |target| {
                matches!(target, OperationTarget::AgentLaunch { workspace_id: expected_workspace, agent_id: expected_agent } if expected_workspace == workspace_id && expected_agent == agent_id)
            },
        )?;
        let (_, _, profile) =
            self.launch_profiles.remove(token.operation_id()).ok_or_else(|| {
                AppError::new(super::error::AppErrorCode::UnknownOperation)
                    .with_operation(token.operation_id().clone())
            })?;
        match result {
            AgentLaunchResult::Started => {
                if let Err(domain_error) =
                    self.model.add_agent(workspace_id, agent_id.clone(), profile)
                {
                    let error = AppError::from(domain_error);
                    let (terminate_token, _) = self.start_operation(
                        OperationKind::TerminateAgent,
                        OperationTarget::Agent(agent_id.clone()),
                        token.operation_id().clone(),
                    )?;
                    self.emit_effect(Effect::TerminateAgent {
                        token: terminate_token,
                        agent_id: agent_id.clone(),
                    });
                    return Err(error);
                }
                // A successful launch is also a navigation event. The Agent
                // row is created and selected in the same Rust-owned
                // snapshot so the sidebar and Agent Activity surface cannot
                // briefly disagree about the newly launched runtime.
                self.model
                    .select_context(crate::NavigationContext::Agent(agent_id.clone()))
                    .map_err(AppError::from)?;
                let snapshot = self.snapshot();
                self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
                self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
                self.queue_persist(token.operation_id().clone());
                Ok(IntentOutcome::Updated { snapshot })
            }
            AgentLaunchResult::Failed { .. } => {
                Err(AppError::new(super::error::AppErrorCode::PortUnavailable)
                    .with_operation(token.operation_id().clone()))
            }
        }
    }

    fn complete_agent_termination(
        &mut self,
        token: &OperationToken,
        agent_id: &AgentId,
        result: AgentStopResult,
    ) -> Result<IntentOutcome, AppError> {
        self.take_pending(
            token,
            OperationKind::TerminateAgent,
            |target| matches!(target, OperationTarget::Agent(id) if id == agent_id),
        )?;
        let snapshot = self.snapshot();
        self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
        if matches!(result, AgentStopResult::Failed { .. }) {
            self.emit(CoordinatorEvent::Error(
                AppError::new(super::error::AppErrorCode::PortUnavailable)
                    .with_operation(token.operation_id().clone()),
            ));
            return Err(AppError::new(super::error::AppErrorCode::PortUnavailable)
                .with_operation(token.operation_id().clone()));
        }
        Ok(IntentOutcome::Noop { snapshot })
    }

    fn complete_agents_reconcile(
        &mut self,
        token: &OperationToken,
        reconciliation: &crate::AgentReconciliation,
    ) -> Result<IntentOutcome, AppError> {
        let current = self.active_reconcile.as_ref().is_some_and(|active| {
            matches!(active, ActiveReconcile::Agents { token: active_token, epoch }
                if active_token == token && *epoch == self.reconcile_epoch)
        });
        if !current {
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(token.operation_id().clone()));
        }
        self.take_pending(token, OperationKind::ReconcileAgents, |target| {
            matches!(target, OperationTarget::Application)
        })?;
        self.active_reconcile = None;
        // Validate every referenced identity before cancelling any local stop
        // state so a malformed aggregate cannot partially mutate
        // confirmations or operations. Once validated, each exit is cleaned
        // in this same coordinator turn as the provider reconciliation.
        for observation in reconciliation.observations() {
            if self.model.workspace_for_agent(observation.agent_id()).is_none() {
                return Err(AppError::new(super::error::AppErrorCode::Domain)
                    .with_domain(DomainErrorCode::UnknownAgent)
                    .with_operation(token.operation_id().clone()));
            }
        }
        for agent_id in reconciliation.exited() {
            if self.model.workspace_for_agent(agent_id).is_none() {
                return Err(AppError::new(super::error::AppErrorCode::Domain)
                    .with_domain(DomainErrorCode::UnknownAgent)
                    .with_operation(token.operation_id().clone()));
            }
        }
        let canceled_stop_tokens = reconciliation
            .exited()
            .iter()
            .flat_map(|agent_id| self.cancel_agent_stop_state_after_exit(agent_id))
            .collect::<Vec<_>>();
        let before_revision = self.model.snapshot().revision();
        self.model.reconcile_agents(reconciliation).map_err(AppError::from)?;
        let snapshot = self.snapshot();
        if snapshot.revision() == before_revision {
            for stop_token in canceled_stop_tokens {
                self.emit(CoordinatorEvent::OperationCompleted { token: stop_token });
            }
            self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
            self.emit(CoordinatorEvent::Noop);
            Ok(IntentOutcome::Noop { snapshot })
        } else {
            self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
            for stop_token in canceled_stop_tokens {
                self.emit(CoordinatorEvent::OperationCompleted { token: stop_token });
            }
            self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
            self.queue_persist(token.operation_id().clone());
            Ok(IntentOutcome::Updated { snapshot })
        }
    }

    fn complete_confirmation_id(
        &mut self,
        token: &OperationToken,
        confirmation_id: &ConfirmationId,
    ) -> Result<IntentOutcome, AppError> {
        if self.confirmation_ids.contains(confirmation_id)
            || self.confirmations.iter().any(|pending| match pending {
                PendingConfirmationState::Stop { confirmation_id: id, .. }
                | PendingConfirmationState::WorkspaceClose { confirmation_id: id, .. } => {
                    id == confirmation_id
                }
            })
        {
            return Err(AppError::new(super::error::AppErrorCode::DuplicateIntent)
                .with_operation(token.operation_id().clone()));
        }
        let request =
            self.confirmation_requests.get(token.operation_id()).cloned().ok_or_else(|| {
                let code = if self.pending.contains_key(token.operation_id())
                    || self.completed_tokens.contains_key(token.operation_id())
                {
                    super::error::AppErrorCode::StaleCompletion
                } else {
                    super::error::AppErrorCode::UnknownOperation
                };
                AppError::new(code).with_operation(token.operation_id().clone())
            })?;
        match &request {
            PendingConfirmationRequest::Stop { agent_id } => {
                self.take_pending(
                    token,
                    OperationKind::GenerateConfirmationId,
                    |target| matches!(target, OperationTarget::Agent(id) if id == agent_id),
                )?;
            }
            PendingConfirmationRequest::WorkspaceClose { workspace_id, .. } => {
                self.take_pending(
                    token,
                    OperationKind::GenerateConfirmationId,
                    |target| matches!(target, OperationTarget::Workspace(id) if id == workspace_id),
                )?;
            }
        }
        self.confirmation_requests.remove(token.operation_id());
        self.confirmation_ids.insert(confirmation_id.clone());
        self.confirmation_id_order.push_back(confirmation_id.clone());
        while self.confirmation_id_order.len() > MAX_CONFIRMATION_ID_ENTRIES {
            if let Some(evicted) = self.confirmation_id_order.pop_front() {
                self.confirmation_ids.remove(&evicted);
            }
        }
        let purpose = match &request {
            PendingConfirmationRequest::WorkspaceClose { inspection, .. } => {
                ConfirmationOutcomePurpose::WorkspaceClose { inspection: inspection.clone() }
            }
            PendingConfirmationRequest::Stop { .. } => ConfirmationOutcomePurpose::AgentStop,
        };
        match request {
            PendingConfirmationRequest::Stop { agent_id } => {
                self.confirmations.retain(|pending| {
                    !matches!(pending, PendingConfirmationState::Stop { agent_id: id, .. } if id == &agent_id)
                });
                self.confirmations.push(PendingConfirmationState::Stop {
                    confirmation_id: confirmation_id.clone(),
                    agent_id,
                });
            }
            PendingConfirmationRequest::WorkspaceClose { workspace_id, progress, inspection } => {
                self.confirmations.retain(|pending| {
                    !matches!(pending, PendingConfirmationState::WorkspaceClose { workspace_id: id, .. } if id == &workspace_id)
                });
                self.confirmations.push(PendingConfirmationState::WorkspaceClose {
                    confirmation_id: confirmation_id.clone(),
                    workspace_id,
                    progress,
                    inspection: inspection.clone(),
                });
            }
        }
        self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
        Ok(IntentOutcome::ConfirmationRequired {
            confirmation_id: confirmation_id.clone(),
            snapshot: self.snapshot(),
            purpose,
        })
    }

    fn complete_workspace_inspection(
        &mut self,
        token: &OperationToken,
        workspace_id: &WorkspaceId,
        inspection: CloseInspectionInputs,
    ) -> Result<IntentOutcome, AppError> {
        self.take_pending(
            token,
            OperationKind::InspectWorkspace,
            |target| matches!(target, OperationTarget::Workspace(id) if id == workspace_id),
        )?;
        let continuation = self
            .inspection_continuations
            .remove(token.operation_id())
            .unwrap_or(InspectionContinuation::Begin);
        let progress = match continuation {
            InspectionContinuation::Begin => CleanupProgress::new(0, false, false),
            InspectionContinuation::Confirm { progress }
            | InspectionContinuation::Retry { progress }
            | InspectionContinuation::Finalize { progress } => progress,
        };
        let consolidated = CloseInspection::consolidate(inspection);
        if !consolidated.is_clean() {
            if matches!(continuation, InspectionContinuation::Finalize { .. }) {
                self.model
                    .mark_workspace_closing_failed(
                        workspace_id,
                        crate::DiagnosticCode::CleanupFailed,
                        progress,
                    )
                    .map_err(AppError::from)?;
                let snapshot = self.snapshot();
                self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
                self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
                self.emit(CoordinatorEvent::Error(
                    AppError::new(super::error::AppErrorCode::PortUnavailable)
                        .with_operation(token.operation_id().clone()),
                ));
                self.queue_persist(token.operation_id().clone());
                return Ok(IntentOutcome::Updated { snapshot });
            }
            if !matches!(continuation, InspectionContinuation::Begin) {
                // Confirmation and retry are already authorized by the
                // caller. Reinspection verifies current provider state, but
                // must not manufacture a second confirmation loop.
                return self.start_cleanup(
                    workspace_id.clone(),
                    progress,
                    token.operation_id().clone(),
                );
            }
            let (confirmation_token, operation_id) = self.start_operation(
                OperationKind::GenerateConfirmationId,
                OperationTarget::Workspace(workspace_id.clone()),
                token.operation_id().clone(),
            )?;
            let workspace_label = self
                .snapshot()
                .workspaces()
                .iter()
                .find(|workspace| workspace.id() == workspace_id)
                .map(|workspace| workspace.label().to_owned())
                .unwrap_or_else(|| "Workspace".to_owned());
            let inspection = CloseInspectionProjection::from_inputs(
                workspace_id.clone(),
                workspace_label,
                inspection,
            );
            self.confirmation_requests.insert(
                operation_id.clone(),
                PendingConfirmationRequest::WorkspaceClose {
                    workspace_id: workspace_id.clone(),
                    progress,
                    inspection,
                },
            );
            self.emit_effect(Effect::GenerateConfirmationId {
                token: confirmation_token,
                purpose: ConfirmationPurpose::WorkspaceClose {
                    workspace_id: workspace_id.clone(),
                    progress,
                },
            });
            return Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() });
        }
        self.start_cleanup(workspace_id.clone(), progress, token.operation_id().clone())
    }

    fn start_cleanup(
        &mut self,
        workspace_id: WorkspaceId,
        progress: CleanupProgress,
        operation_id: OperationId,
    ) -> Result<IntentOutcome, AppError> {
        let workspace = self.model.workspace(&workspace_id).ok_or_else(|| {
            AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::UnknownWorkspace)
        })?;
        let initial_state = workspace.state();
        let continuing = self
            .cleanup
            .get(&workspace_id)
            .is_some_and(|state| state.operation_id == operation_id && state.progress == progress);
        let persisted_resume = workspace.state().cleanup_progress() == Some(progress)
            && !self.cleanup.contains_key(&workspace_id);
        if workspace.state().is_closing() && !continuing && !persisted_resume {
            return Err(AppError::new(super::error::AppErrorCode::Domain)
                .with_domain(DomainErrorCode::WorkspaceClosing));
        }
        if persisted_resume {
            self.cleanup.insert(
                workspace_id.clone(),
                CleanupState {
                    operation_id: operation_id.clone(),
                    workspace_id: workspace_id.clone(),
                    progress,
                },
            );
        }
        let step = next_cleanup_step(progress);

        // Closing is a durable tombstone, not merely an in-memory UI state.
        // Persist it before the first destructive provider effect, including
        // retries after a previous persistence failure. The continuation is
        // consumed by `complete_persist`, which then re-enters this method
        // and is allowed to emit the Agents cleanup effect.
        let needs_initial_persist = progress == CleanupProgress::new(0, false, false)
            && !persisted_resume
            && (!continuing
                || matches!(initial_state, crate::WorkspaceState::ClosingFailed { .. }));
        if needs_initial_persist {
            if !continuing || matches!(initial_state, crate::WorkspaceState::ClosingFailed { .. }) {
                self.model
                    .mark_workspace_closing(&workspace_id, progress)
                    .map_err(AppError::from)?;
                self.cancel_workspace_agent_operations(&workspace_id);
                self.invalidate_reconciliation();
                self.emit(CoordinatorEvent::Snapshot(self.snapshot()));
            }
            self.cleanup.insert(
                workspace_id.clone(),
                CleanupState {
                    operation_id: operation_id.clone(),
                    workspace_id: workspace_id.clone(),
                    progress,
                },
            );
            self.cleanup_persistence.insert(
                operation_id.clone(),
                CleanupPersistenceContinuation::StartNext { workspace_id, progress },
            );
            self.queue_persist(operation_id.clone());
            return Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() });
        }
        let (token, operation_id) = self.start_operation(
            OperationKind::Cleanup(step),
            OperationTarget::Workspace(workspace_id.clone()),
            operation_id,
        )?;

        // The lifecycle transition is part of the same coordinator turn as
        // operation registration. This prevents a completion that was
        // already in flight from observing an Available Workspace between
        // the first cleanup effect and the domain transition.
        if !continuing && !persisted_resume {
            if let Err(error) = self.model.mark_workspace_closing(&workspace_id, progress) {
                self.pending.remove(&operation_id);
                self.remember_completed(token);
                return Err(AppError::from(error));
            }
            self.cancel_workspace_agent_operations(&workspace_id);
            self.invalidate_reconciliation();
            self.emit(CoordinatorEvent::Snapshot(self.snapshot()));
        }
        self.cleanup.insert(
            workspace_id.clone(),
            CleanupState {
                operation_id: operation_id.clone(),
                workspace_id: workspace_id.clone(),
                progress,
            },
        );
        self.emit_effect(Effect::CleanupWorkspace { token, workspace_id, step });
        Ok(IntentOutcome::Deferred { operation_id, snapshot: self.snapshot() })
    }

    fn complete_agent_stop(
        &mut self,
        token: &OperationToken,
        agent_id: &AgentId,
        result: AgentStopResult,
    ) -> Result<IntentOutcome, AppError> {
        // Natural reconciliation may have removed the Agent and tombstoned
        // this exact StopAgent token before the provider returned. Treat a
        // later successful stop result as an idempotent acknowledgement, but
        // reject it if a new Agent has since reused the same domain ID.
        if let Some(expected_agent_id) = self.natural_exit_stop_tokens.get(token) {
            if expected_agent_id != agent_id {
                return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                    .with_operation(token.operation_id().clone()));
            }
            if self.model.workspace_for_agent(agent_id).is_some() {
                return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                    .with_operation(token.operation_id().clone()));
            }
            self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
            return Ok(IntentOutcome::Noop { snapshot: self.snapshot() });
        }
        self.take_pending(
            token,
            OperationKind::StopAgent,
            |target| matches!(target, OperationTarget::Agent(id) if id == agent_id),
        )?;
        match result {
            AgentStopResult::Stopped => {
                // The provider may have proved removal through another path
                // after this stop operation was issued. Once the domain row
                // is gone, acknowledge the completion without touching a
                // replacement Agent that reuses the same ID.
                if self.model.workspace_for_agent(agent_id).is_none() {
                    self.remember_natural_exit_stop(token.clone(), agent_id.clone());
                    self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
                    return Ok(IntentOutcome::Noop { snapshot: self.snapshot() });
                }
                self.model.agent_exited(agent_id).map_err(AppError::from)?;
                // Any reconciliation inventory already in flight predates
                // this removal. Invalidate it before a replacement Agent can
                // be observed under the same domain identity.
                self.invalidate_reconciliation_after_agent_removal(agent_id);
            }
            AgentStopResult::Failed { diagnostic } => {
                self.model.mark_agent_stop_failed(agent_id, diagnostic).map_err(AppError::from)?;
            }
        }
        let snapshot = self.snapshot();
        self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
        self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
        self.queue_persist(token.operation_id().clone());
        Ok(IntentOutcome::Updated { snapshot })
    }

    fn complete_workspace_cleanup(
        &mut self,
        token: &OperationToken,
        workspace_id: &WorkspaceId,
        result: WorkspaceCleanupResult,
    ) -> Result<IntentOutcome, AppError> {
        let pending = self.take_pending(
            token,
            cleanup_kind(result),
            |target| matches!(target, OperationTarget::Workspace(id) if id == workspace_id),
        )?;
        let operation_id = pending.token.operation_id().clone();
        let progress = self
            .cleanup
            .entry(workspace_id.clone())
            .or_insert_with(|| CleanupState {
                operation_id: operation_id.clone(),
                workspace_id: workspace_id.clone(),
                progress: CleanupProgress::new(0, false, false),
            })
            .progress;
        match result {
            WorkspaceCleanupResult::Failed { step: _, diagnostic } => {
                self.model
                    .mark_workspace_closing_failed(workspace_id, diagnostic, progress)
                    .map_err(AppError::from)?;
                let snapshot = self.snapshot();
                self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
                self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
                self.emit(CoordinatorEvent::Error(
                    AppError::new(super::error::AppErrorCode::PortUnavailable)
                        .with_operation(token.operation_id().clone()),
                ));
                self.queue_persist(token.operation_id().clone());
                Ok(IntentOutcome::Updated { snapshot })
            }
            WorkspaceCleanupResult::StepCompleted(step) => {
                let expected = next_cleanup_step(progress);
                if expected != step {
                    return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                        .with_operation(token.operation_id().clone()));
                }
                let next_progress = if step == CleanupStep::Agents {
                    let count = self
                        .model
                        .workspace(workspace_id)
                        .map(|workspace| workspace.agents().len() as u32)
                        .unwrap_or(0);
                    CleanupProgress::after_agents(
                        count,
                        progress.terminal_closed(),
                        progress.editor_closed(),
                    )
                } else {
                    progress_after_step(progress, step)
                };
                if let Some(state) = self.cleanup.get_mut(workspace_id) {
                    state.progress = next_progress;
                }
                match step {
                    CleanupStep::Agents => {
                        let ids = self
                            .model
                            .workspace(workspace_id)
                            .map(|workspace| {
                                workspace
                                    .agents()
                                    .iter()
                                    .map(|agent| agent.id().clone())
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        for agent_id in ids {
                            self.model.agent_exited(&agent_id).map_err(AppError::from)?;
                        }
                    }
                    CleanupStep::Terminal | CleanupStep::Editor => {}
                    CleanupStep::StateCommitted => {
                        let Some(workspace) = self.model.workspace(workspace_id) else {
                            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                                .with_operation(token.operation_id().clone()));
                        };
                        if !workspace.state().is_closing() {
                            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                                .with_operation(token.operation_id().clone()));
                        }
                        if !workspace.agents().is_empty() {
                            self.model
                                .mark_workspace_closing_failed(
                                    workspace_id,
                                    crate::DiagnosticCode::CleanupFailed,
                                    progress,
                                )
                                .map_err(AppError::from)?;
                            let snapshot = self.snapshot();
                            self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
                            self.emit(CoordinatorEvent::OperationCompleted {
                                token: token.clone(),
                            });
                            self.emit(CoordinatorEvent::Error(
                                AppError::new(super::error::AppErrorCode::PortUnavailable)
                                    .with_operation(token.operation_id().clone()),
                            ));
                            self.queue_persist(token.operation_id().clone());
                            return Ok(IntentOutcome::Updated { snapshot });
                        }
                    }
                }
                if !matches!(step, CleanupStep::StateCommitted) {
                    self.model
                        .update_workspace_closing_progress(workspace_id, next_progress)
                        .map_err(AppError::from)?;
                }
                let snapshot = self.snapshot();
                self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
                self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
                match step {
                    CleanupStep::Agents | CleanupStep::Terminal => {
                        self.cleanup_persistence.insert(
                            token.operation_id().clone(),
                            CleanupPersistenceContinuation::StartNext {
                                workspace_id: workspace_id.clone(),
                                progress: next_progress,
                            },
                        );
                        self.queue_persist(token.operation_id().clone());
                        Ok(IntentOutcome::Deferred {
                            operation_id: token.operation_id().clone(),
                            snapshot,
                        })
                    }
                    CleanupStep::Editor => {
                        self.cleanup_persistence.insert(
                            token.operation_id().clone(),
                            CleanupPersistenceContinuation::FinalInspection {
                                workspace_id: workspace_id.clone(),
                                progress: next_progress,
                            },
                        );
                        self.queue_persist(token.operation_id().clone());
                        Ok(IntentOutcome::Deferred {
                            operation_id: token.operation_id().clone(),
                            snapshot,
                        })
                    }
                    CleanupStep::StateCommitted => {
                        self.cleanup_persistence.insert(
                            token.operation_id().clone(),
                            CleanupPersistenceContinuation::FinalizeWorkspace {
                                workspace_id: workspace_id.clone(),
                                progress: next_progress,
                            },
                        );
                        self.queue_persist(token.operation_id().clone());
                        Ok(IntentOutcome::Deferred {
                            operation_id: token.operation_id().clone(),
                            snapshot,
                        })
                    }
                }
            }
        }
    }

    fn complete_persist(&mut self, token: &OperationToken) -> Result<IntentOutcome, AppError> {
        self.take_pending(token, OperationKind::PersistState, |target| {
            matches!(target, OperationTarget::Application)
        })?;
        self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
        if let Some(continuation) = self.cleanup_persistence.remove(token.operation_id()) {
            return match continuation {
                CleanupPersistenceContinuation::StartNext { workspace_id, progress } => {
                    self.start_cleanup(workspace_id, progress, token.operation_id().clone())
                }
                CleanupPersistenceContinuation::FinalInspection { workspace_id, progress } => self
                    .begin_workspace_inspection(
                        workspace_id,
                        token.operation_id().clone(),
                        InspectionContinuation::Finalize { progress },
                    ),
                CleanupPersistenceContinuation::FinalizeWorkspace { workspace_id, .. } => {
                    let workspace = self.model.workspace(&workspace_id).ok_or_else(|| {
                        AppError::new(super::error::AppErrorCode::StaleCompletion)
                            .with_operation(token.operation_id().clone())
                    })?;
                    if !workspace.state().is_closing() || !workspace.agents().is_empty() {
                        return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                            .with_operation(token.operation_id().clone()));
                    }
                    let backup = self
                        .model
                        .close_workspace_for_persistence(&workspace_id, CloseInspection::Clean)
                        .map_err(AppError::from)?;
                    self.finalization_roots
                        .insert(backup.root().clone(), token.operation_id().clone());
                    self.cleanup.remove(&workspace_id);
                    self.finalization_pending.insert(token.operation_id().clone());
                    self.finalization_workspaces.insert(token.operation_id().clone(), workspace_id);
                    self.finalization_backups.insert(token.operation_id().clone(), backup);
                    let snapshot = self.snapshot();
                    self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
                    self.queue_persist(token.operation_id().clone());
                    Ok(IntentOutcome::Deferred {
                        operation_id: token.operation_id().clone(),
                        snapshot,
                    })
                }
            };
        }
        if self.finalization_pending.remove(token.operation_id()) {
            self.finalization_workspaces.remove(token.operation_id());
            if let Some(backup) = self.finalization_backups.remove(token.operation_id()) {
                self.finalization_roots.remove(backup.root());
            }
        }
        Ok(IntentOutcome::Noop { snapshot: self.snapshot() })
    }

    fn complete_persist_failed(
        &mut self,
        token: &OperationToken,
    ) -> Result<IntentOutcome, AppError> {
        self.take_pending(token, OperationKind::PersistState, |target| {
            matches!(target, OperationTarget::Application)
        })?;
        if let Some(continuation) = self.cleanup_persistence.remove(token.operation_id()) {
            let continuation = match continuation {
                CleanupPersistenceContinuation::StartNext { workspace_id, progress }
                | CleanupPersistenceContinuation::FinalInspection { workspace_id, progress } => {
                    Some((workspace_id, progress))
                }
                CleanupPersistenceContinuation::FinalizeWorkspace { workspace_id, progress } => {
                    self.finalization_pending.remove(token.operation_id());
                    Some((workspace_id, progress))
                }
            };
            if let Some((workspace_id, progress)) = continuation {
                self.model
                    .mark_workspace_closing_failed(
                        &workspace_id,
                        crate::DiagnosticCode::CleanupFailed,
                        progress,
                    )
                    .map_err(AppError::from)?;
            }
        }
        // A failed final removal save leaves the durable Closing tombstone in
        // the previous journal generation; startup can safely finish that
        // tombstone without repeating provider destruction.
        if self.finalization_pending.remove(token.operation_id()) {
            let workspace_id = self.finalization_workspaces.remove(token.operation_id());
            if let Some(backup) = self.finalization_backups.remove(token.operation_id()) {
                let root = backup.root().clone();
                self.model.rollback_workspace_close(backup).map_err(AppError::from)?;
                self.finalization_roots.remove(&root);
                if let Some(workspace_id) = workspace_id {
                    let progress = match self
                        .model
                        .workspace(&workspace_id)
                        .map(|workspace| workspace.state())
                    {
                        Some(crate::WorkspaceState::Closing { progress }) => progress,
                        _ => CleanupProgress::new(0, false, false),
                    };
                    self.model
                        .mark_workspace_closing_failed(
                            &workspace_id,
                            crate::DiagnosticCode::CleanupFailed,
                            progress,
                        )
                        .map_err(AppError::from)?;
                    self.cleanup.insert(
                        workspace_id.clone(),
                        CleanupState {
                            operation_id: token.operation_id().clone(),
                            workspace_id: workspace_id.clone(),
                            progress,
                        },
                    );
                }
            }
        }
        let error = AppError::new(super::error::AppErrorCode::PersistenceDegraded)
            .with_operation(token.operation_id().clone());
        self.emit(CoordinatorEvent::Snapshot(self.snapshot()));
        self.emit(CoordinatorEvent::Error(error));
        self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
        Ok(IntentOutcome::PersistenceDegraded { snapshot: self.snapshot() })
    }

    fn reconcile_agent(
        &mut self,
        token: &OperationToken,
        agent_id: &AgentId,
        status: crate::AgentStatus,
        runtime_health: crate::RuntimeHealth,
    ) -> Result<IntentOutcome, AppError> {
        let current = self.active_reconcile.as_ref().is_some_and(|active| {
            matches!(active, ActiveReconcile::Agent { token: active_token, agent_id: active_agent_id, epoch }
                if active_token == token
                    && active_agent_id == agent_id
                    && *epoch == self.reconcile_epoch)
        });
        if !current {
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(token.operation_id().clone()));
        }
        self.take_pending(
            token,
            OperationKind::ReconcileAgent,
            |target| matches!(target, OperationTarget::Agent(id) if id == agent_id),
        )?;
        self.active_reconcile = None;
        let before_revision = self.model.snapshot().revision();
        self.model.set_agent_status(agent_id, status).map_err(AppError::from)?;
        self.model.set_agent_runtime_health(agent_id, runtime_health).map_err(AppError::from)?;
        let snapshot = self.snapshot();
        if snapshot.revision() == before_revision {
            self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
            self.emit(CoordinatorEvent::Noop);
            Ok(IntentOutcome::Noop { snapshot })
        } else {
            self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
            self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
            self.queue_persist(token.operation_id().clone());
            Ok(IntentOutcome::Updated { snapshot })
        }
    }

    fn agent_exited(
        &mut self,
        token: &OperationToken,
        agent_id: &AgentId,
    ) -> Result<IntentOutcome, AppError> {
        let current = self.active_reconcile.as_ref().is_some_and(|active| {
            matches!(active, ActiveReconcile::Agent { token: active_token, agent_id: active_agent_id, epoch }
                if active_token == token
                    && active_agent_id == agent_id
                    && *epoch == self.reconcile_epoch)
        });
        if !current {
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(token.operation_id().clone()));
        }
        self.take_pending(
            token,
            OperationKind::ReconcileAgent,
            |target| matches!(target, OperationTarget::Agent(id) if id == agent_id),
        )?;
        self.active_reconcile = None;
        let stop_tokens = self.cancel_agent_stop_state_after_exit(agent_id);
        // A stop completion can win the race just before this reconciliation
        // event. Removal is already proved in that case, so the natural-exit
        // event is an idempotent completion rather than an error. No model
        // mutation is attempted against a replacement Agent.
        let removed = self.model.workspace_for_agent(agent_id).is_some();
        if removed {
            self.model.agent_exited(agent_id).map_err(AppError::from)?;
        }
        let snapshot = self.snapshot();
        if removed {
            self.emit(CoordinatorEvent::Snapshot(snapshot.clone()));
        }
        for stop_token in stop_tokens {
            self.emit(CoordinatorEvent::OperationCompleted { token: stop_token });
        }
        self.emit(CoordinatorEvent::OperationCompleted { token: token.clone() });
        self.queue_persist(token.operation_id().clone());
        if removed {
            Ok(IntentOutcome::Updated { snapshot })
        } else {
            Ok(IntentOutcome::Noop { snapshot })
        }
    }

    /// Cancels all stop confirmation/operation state for an Agent after the
    /// provider has proved that it exited. The whole operation is performed
    /// in one coordinator turn, so no orphan confirmation can be projected
    /// between removal and cleanup.
    fn cancel_agent_stop_state_after_exit(&mut self, agent_id: &AgentId) -> Vec<OperationToken> {
        let operation_ids = self
            .pending
            .iter()
            .filter_map(|(operation_id, pending)| {
                let matches_agent =
                    matches!(&pending.target, OperationTarget::Agent(id) if id == agent_id);
                let matches_stop = matches!(
                    pending.kind,
                    OperationKind::StopAgent | OperationKind::GenerateConfirmationId
                );
                (matches_agent && matches_stop).then(|| operation_id.clone())
            })
            .collect::<Vec<_>>();
        let mut completed_stop_tokens = Vec::new();
        for operation_id in operation_ids {
            let Some(pending) = self.pending.remove(&operation_id) else { continue };
            let token = pending.token;
            self.remember_completed(token.clone());
            self.clear_operation_auxiliary_state(&token);
            if pending.kind == OperationKind::StopAgent {
                self.remember_natural_exit_stop(token.clone(), agent_id.clone());
                completed_stop_tokens.push(token);
            }
        }

        let confirmation_request_ids = self
            .confirmation_requests
            .iter()
            .filter(|(_, request)| {
                matches!(request, PendingConfirmationRequest::Stop { agent_id: id } if id == agent_id)
            })
            .map(|(operation_id, _)| operation_id.clone())
            .collect::<Vec<_>>();
        for operation_id in confirmation_request_ids {
            self.confirmation_requests.remove(&operation_id);
        }
        self.confirmations.retain(|pending| {
            !matches!(pending, PendingConfirmationState::Stop { agent_id: id, .. } if id == agent_id)
        });
        completed_stop_tokens
    }

    fn remember_natural_exit_stop(&mut self, token: OperationToken, agent_id: AgentId) {
        self.natural_exit_stop_tokens.insert(token.clone(), agent_id);
        self.natural_exit_stop_order.push_back(token);
        while self.natural_exit_stop_order.len() > MAX_COMPLETED_TOKEN_ENTRIES {
            let Some(evicted) = self.natural_exit_stop_order.pop_front() else { break };
            self.natural_exit_stop_tokens.remove(&evicted);
        }
    }

    fn invalidate_reconciliation_after_agent_removal(&mut self, agent_id: &AgentId) {
        let should_invalidate = self.active_reconcile.as_ref().is_some_and(|active| match active {
            ActiveReconcile::Agent { agent_id: active_agent, .. } => active_agent == agent_id,
            // An aggregate inventory was observed before this removal, so it
            // must not be allowed to remove or update a replacement row.
            ActiveReconcile::Agents { .. } => true,
        });
        if should_invalidate {
            self.invalidate_reconciliation();
        }
    }

    fn take_pending<F>(
        &mut self,
        token: &OperationToken,
        kind: OperationKind,
        target_matches: F,
    ) -> Result<PendingOperation, AppError>
    where
        F: FnOnce(&OperationTarget) -> bool,
    {
        let Some(pending) = self.pending.get(token.operation_id()).cloned() else {
            let code = if self.completed_tokens.contains_key(token.operation_id()) {
                super::error::AppErrorCode::StaleCompletion
            } else {
                super::error::AppErrorCode::UnknownOperation
            };
            return Err(AppError::new(code).with_operation(token.operation_id().clone()));
        };
        if pending.token != *token || pending.kind != kind || !target_matches(&pending.target) {
            return Err(AppError::new(super::error::AppErrorCode::StaleCompletion)
                .with_operation(token.operation_id().clone()));
        }
        self.pending.remove(token.operation_id());
        self.remember_completed(token.clone());
        Ok(pending)
    }

    fn start_operation(
        &mut self,
        kind: OperationKind,
        target: OperationTarget,
        operation_id: OperationId,
    ) -> Result<(OperationToken, OperationId), AppError> {
        if self.pending.contains_key(&operation_id) {
            return Err(AppError::new(super::error::AppErrorCode::OperationInProgress)
                .with_operation(operation_id));
        }
        self.next_generation = self.next_generation.checked_add(1).ok_or_else(|| {
            AppError::new(super::error::AppErrorCode::OperationGenerationExhausted)
                .with_operation(operation_id.clone())
        })?;
        let token = OperationToken::new(operation_id.clone(), self.next_generation);
        self.pending
            .insert(operation_id.clone(), PendingOperation { token: token.clone(), kind, target });
        Ok((token, operation_id))
    }

    fn invalidate_reconciliation(&mut self) {
        let Some(active) = self.active_reconcile.take() else {
            return;
        };
        let token = active.token().clone();
        if self.pending.remove(token.operation_id()).is_some() {
            self.remember_completed(token);
        }
    }

    fn workspace_allows_agent_creation(&self, workspace_id: &WorkspaceId) -> bool {
        self.model.workspace(workspace_id).is_some_and(crate::Workspace::can_create_agent)
    }

    /// Tombstone every in-flight profile/ID/launch operation for a Workspace
    /// before cleanup effects are emitted. The auxiliary resolved values are
    /// removed with their operation token so no later completion can advance
    /// the launch pipeline.
    fn cancel_workspace_agent_operations(&mut self, workspace_id: &WorkspaceId) {
        let operation_ids = self
            .pending
            .iter()
            .filter_map(|(operation_id, pending)| {
                let targets_workspace = match &pending.target {
                    OperationTarget::Profile { workspace_id: id, .. }
                    | OperationTarget::AgentLaunch { workspace_id: id, .. }
                    | OperationTarget::Workspace(id) => id == workspace_id,
                    _ => false,
                };
                let cancellable = matches!(
                    pending.kind,
                    OperationKind::ResolveAgentProfile
                        | OperationKind::GenerateAgentId
                        | OperationKind::LaunchAgent
                        | OperationKind::TerminateAgent
                        | OperationKind::GenerateConfirmationId
                );
                (targets_workspace && cancellable).then(|| operation_id.clone())
            })
            .collect::<Vec<_>>();

        for operation_id in operation_ids {
            if let Some(pending) = self.pending.remove(&operation_id) {
                self.remember_completed(pending.token);
            }
            self.resolved_profiles.remove(&operation_id);
            self.launch_profiles.remove(&operation_id);
            self.confirmation_requests.remove(&operation_id);
        }
        self.confirmations.retain(|pending| match pending {
            PendingConfirmationState::Stop { agent_id, .. } => self
                .model
                .workspace_for_agent(agent_id)
                .is_none_or(|workspace| workspace.id() != workspace_id),
            PendingConfirmationState::WorkspaceClose { workspace_id: id, .. } => id != workspace_id,
        });
    }

    fn remember_completed(&mut self, token: OperationToken) {
        let operation_id = token.operation_id().clone();
        self.completed_tokens.insert(operation_id.clone(), token.clone());
        self.completed_token_order.push_back((operation_id, token));
        while self.completed_token_order.len() > MAX_COMPLETED_TOKEN_ENTRIES {
            let Some((evicted_id, evicted_token)) = self.completed_token_order.pop_front() else {
                break;
            };
            // An operation ID may be intentionally reused after its previous
            // generation is complete. Never evict that newer tombstone while
            // removing the older FIFO entry.
            if self.completed_tokens.get(&evicted_id) == Some(&evicted_token) {
                self.completed_tokens.remove(&evicted_id);
            }
        }
    }

    fn queue_persist(&mut self, operation_id: OperationId) {
        let result = self.start_operation(
            OperationKind::PersistState,
            OperationTarget::Application,
            operation_id,
        );
        match result {
            Ok((token, _)) => self.emit_effect(Effect::PersistState { token }),
            Err(error) => self.emit(CoordinatorEvent::Error(error)),
        }
    }

    fn emit_effect(&mut self, effect: Effect) {
        self.emit(CoordinatorEvent::Effect(effect));
    }

    fn emit(&mut self, event: CoordinatorEvent) {
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.events.push_back(SequencedCoordinatorEvent { sequence: self.next_sequence, event });
        if self.events.len() > MAX_RETAINED_EVENTS {
            self.events.pop_front();
        }
    }

    fn cache_intent(
        &mut self,
        intent_id: IntentId,
        operation_id: Option<&OperationId>,
        intent: &UserIntent,
        result: &Result<IntentOutcome, AppError>,
    ) {
        if self
            .intent_cache
            .insert(intent_id.clone(), CachedDispatch::from_intent(operation_id, intent, result))
            .is_none()
        {
            self.intent_order.push_back(intent_id);
        }
        while self.intent_order.len() > MAX_INTENT_LEDGER_ENTRIES {
            if let Some(evicted) = self.intent_order.pop_front() {
                self.intent_cache.remove(&evicted);
            }
        }
    }

    fn cache_provider_event(
        &mut self,
        event_id: ProviderEventId,
        event: &ProviderEvent,
        result: &Result<IntentOutcome, AppError>,
    ) {
        if self
            .provider_event_cache
            .insert(event_id.clone(), CachedDispatch::from_provider(event, result))
            .is_none()
        {
            self.provider_event_order.push_back(event_id);
        }
        while self.provider_event_order.len() > MAX_PROVIDER_LEDGER_ENTRIES {
            if let Some(evicted) = self.provider_event_order.pop_front() {
                self.provider_event_cache.remove(&evicted);
            }
        }
    }

    fn detach(&mut self, reason: DetachReason) -> IntentOutcome {
        if self.detached.is_none() {
            self.detached = Some(reason);
            self.emit_effect(Effect::Detach(reason));
        } else {
            self.emit(CoordinatorEvent::Noop);
        }
        IntentOutcome::Detached { snapshot: self.snapshot() }
    }
}

fn next_cleanup_step(progress: CleanupProgress) -> CleanupStep {
    if !progress.agents_step_completed() {
        CleanupStep::Agents
    } else if !progress.terminal_closed() {
        CleanupStep::Terminal
    } else if !progress.editor_closed() {
        CleanupStep::Editor
    } else {
        CleanupStep::StateCommitted
    }
}

fn progress_after_step(progress: CleanupProgress, step: CleanupStep) -> CleanupProgress {
    match step {
        CleanupStep::Agents => CleanupProgress::after_agents(
            progress.agents_closed(),
            progress.terminal_closed(),
            progress.editor_closed(),
        ),
        CleanupStep::Terminal => progress.with_terminal_closed(true),
        CleanupStep::Editor => progress.with_editor_closed(true),
        CleanupStep::StateCommitted => progress,
    }
}

fn cleanup_kind(result: WorkspaceCleanupResult) -> OperationKind {
    match result {
        WorkspaceCleanupResult::StepCompleted(step)
        | WorkspaceCleanupResult::Failed { step, .. } => OperationKind::Cleanup(step),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{
        Activity, AgentObservation, AgentProfileKind, AgentReconciliation, AgentStatus,
        DiagnosticCode, DisplayPath, NavigationContext, ResourceInspection, RuntimeHealth,
        Workspace,
    };

    fn canonical_id(seed: &str) -> String {
        let mut hash = 0xcbf29ce484222325_u64;
        for byte in seed.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("00000000-0000-4000-8000-{:012x}", hash & 0x0000_ffff_ffff_ffff)
    }

    fn intent(seed: &str, value: UserIntent) -> IntentEnvelope {
        IntentEnvelope::with_operation_id(
            IntentId::from_uuid(canonical_id(seed)).expect("canonical test intent"),
            op(&format!("{seed}-operation")),
            value,
        )
    }

    fn op(seed: &str) -> OperationId {
        OperationId::from_uuid(canonical_id(seed)).expect("canonical test operation")
    }

    fn workspace(id: &str, path: &str) -> Workspace {
        Workspace::new(
            WorkspaceId::for_test(id),
            WorkspaceRoot::new(path).expect("absolute root"),
            crate::DisplayPath::new(path).expect("absolute selected path"),
            None,
        )
    }

    fn profile(id: &str) -> AgentProfile {
        AgentProfile::new(
            AgentProfileId::for_test(id),
            id,
            AgentProfileKind::Codex,
            Vec::new(),
            BTreeMap::new(),
        )
        .expect("valid profile")
    }

    fn operation_effect(events: &[SequencedCoordinatorEvent]) -> (OperationToken, Effect) {
        events
            .iter()
            .rev()
            .find_map(|event| match event.event() {
                CoordinatorEvent::Effect(effect) => match effect {
                    Effect::ResolveWorkspacePath { token, .. }
                    | Effect::GenerateWorkspaceId { token, .. }
                    | Effect::ResolveAgentProfile { token, .. }
                    | Effect::GenerateConfirmationId { token, .. }
                    | Effect::GenerateAgentId { token, .. }
                    | Effect::LaunchAgent { token, .. }
                    | Effect::InspectWorkspace { token, .. }
                    | Effect::StopAgent { token, .. }
                    | Effect::TerminateAgent { token, .. }
                    | Effect::ReconcileAgents { token }
                    | Effect::ReconcileAgent { token, .. }
                    | Effect::CleanupWorkspace { token, .. }
                    | Effect::PersistState { token } => Some((token.clone(), effect.clone())),
                    _ => None,
                },
                _ => None,
            })
            .expect("expected operation effect")
    }

    #[test]
    fn duplicate_intent_replays_exact_result_and_sequence_is_independent_of_revision() {
        let mut coordinator = AppCoordinator::new();
        let initial = coordinator.subscribe();
        assert_eq!(initial.events()[0].sequence(), 1);
        let envelope =
            intent("select-global", UserIntent::SelectContext(NavigationContext::Global));
        let first = coordinator.dispatch_user(envelope.clone()).expect("selection succeeds");
        assert!(matches!(first, IntentOutcome::Noop { .. }));
        let second = coordinator.dispatch_user(envelope).expect("duplicate replays");
        assert_eq!(first, second);
        let events = coordinator.subscribe().into_events();
        assert_eq!(events.len(), 2, "first no-op and duplicate acknowledgement");
        assert!(events.windows(2).all(|pair| pair[0].sequence() < pair[1].sequence()));
        assert_eq!(events[0].event(), &CoordinatorEvent::Noop);
        assert_eq!(events[1].event(), &CoordinatorEvent::Noop);
        assert_eq!(coordinator.snapshot().revision(), 0);
    }

    #[test]
    fn duplicate_failure_replays_error_without_reexecuting_or_leaking_content() {
        let mut coordinator = AppCoordinator::new();
        coordinator.subscribe();
        let envelope = intent(
            "bad-context",
            UserIntent::SelectContext(NavigationContext::Workspace(WorkspaceId::for_test(
                "missing",
            ))),
        );
        let first = coordinator.dispatch_user(envelope.clone()).expect_err("missing workspace");
        assert_eq!(first.code(), super::super::error::AppErrorCode::Domain);
        assert_eq!(first.domain_code(), Some(DomainErrorCode::UnknownWorkspace));
        let second = coordinator.dispatch_user(envelope).expect_err("cached failure");
        assert_eq!(first, second);
        let events = coordinator.subscribe().into_events();
        assert!(matches!(events[0].event(), CoordinatorEvent::Error(_)));
        assert_eq!(events[1].event(), &CoordinatorEvent::Noop);
        assert_eq!(coordinator.snapshot().revision(), 0);
    }

    #[test]
    fn duplicate_ids_reject_payload_collisions_for_intents_and_provider_events() {
        let mut coordinator = AppCoordinator::new();
        coordinator.subscribe();
        let intent_id = IntentId::for_test(canonical_id("intent-collision"));
        coordinator
            .dispatch_user(IntentEnvelope::with_operation_id(
                intent_id.clone(),
                op("intent-collision-operation"),
                UserIntent::SelectContext(NavigationContext::Global),
            ))
            .expect("first intent");
        let collision = coordinator
            .dispatch_user(IntentEnvelope::with_operation_id(
                intent_id,
                op("intent-collision-operation-2"),
                UserIntent::SelectActivity(Activity::Editor),
            ))
            .expect_err("same IntentId cannot carry a different command");
        assert_eq!(collision.code(), super::super::error::AppErrorCode::DuplicateIntent);

        let operation_collision_id = IntentId::for_test(canonical_id("intent-operation-collision"));
        coordinator
            .dispatch_user(IntentEnvelope::with_operation_id(
                operation_collision_id.clone(),
                op("intent-operation-collision-1"),
                UserIntent::SelectActivity(Activity::Editor),
            ))
            .expect("first operation fingerprint");
        let operation_collision = coordinator
            .dispatch_user(IntentEnvelope::with_operation_id(
                operation_collision_id,
                op("intent-operation-collision-2"),
                UserIntent::SelectActivity(Activity::Editor),
            ))
            .expect_err("operation identity is part of the exact intent payload");
        assert_eq!(operation_collision.code(), super::super::error::AppErrorCode::DuplicateIntent);

        let reconcile = coordinator.request_agents_reconcile(op("provider-collision-operation"));
        let (token, _) = operation_effect(&coordinator.subscribe().into_events());
        let event_id = op("provider-event-collision");
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                event_id.clone(),
                ProviderEvent::AgentsReconciled {
                    token: token.clone(),
                    reconciliation: AgentReconciliation::default(),
                },
            ))
            .expect("first provider event");
        assert!(reconcile.is_ok());
        let collision = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                event_id,
                ProviderEvent::AgentExited {
                    token,
                    agent_id: AgentId::for_test("different-event-payload"),
                },
            ))
            .expect_err("same ProviderEventId cannot carry a different event");
        assert_eq!(collision.code(), super::super::error::AppErrorCode::DuplicateIntent);
    }

    #[test]
    fn requested_path_resolution_and_split_identity_effects_are_explicit() {
        let mut coordinator = AppCoordinator::new();
        coordinator.subscribe();
        let deferred = coordinator
            .dispatch_user(intent(
                "open-folder",
                UserIntent::OpenFolder { path: RequestedPath::new("/tmp/devhub").unwrap() },
            ))
            .expect("resolver deferred");
        let (token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::ResolveWorkspacePath { .. }));
        assert!(matches!(deferred, IntentOutcome::Deferred { .. }));

        let root = WorkspaceRoot::new("/tmp/devhub").unwrap();
        let selected = DisplayPath::new("/tmp/devhub").unwrap();
        let path_event_id = op("resolved-path-event");
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                path_event_id.clone(),
                ProviderEvent::WorkspacePathResolved {
                    token: token.clone(),
                    root,
                    selected_path: selected,
                },
            ))
            .expect("trusted resolver completion");
        let (id_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::GenerateWorkspaceId { .. }));
        let resolved = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("resolved-id-event"),
                ProviderEvent::WorkspaceIdGenerated {
                    token: id_token.clone(),
                    workspace_id: WorkspaceId::for_test("workspace-generated"),
                },
            ))
            .expect("trusted identity completion");
        assert!(matches!(resolved, IntentOutcome::Updated { .. }));
        assert_eq!(coordinator.snapshot().workspaces().len(), 1);
        let replay = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("resolved-id-replay"),
                ProviderEvent::WorkspaceIdGenerated {
                    token: id_token,
                    workspace_id: WorkspaceId::for_test("workspace-generated"),
                },
            ))
            .expect_err("same token with a new event id is stale");
        assert_eq!(replay.code(), super::super::error::AppErrorCode::StaleCompletion);
        assert_eq!(coordinator.snapshot().workspaces().len(), 1);
    }

    #[test]
    fn opening_an_already_open_canonical_root_focuses_existing_workspace() {
        let mut model = AppModel::new();
        let existing_id = WorkspaceId::for_test("already-open-workspace");
        let root = WorkspaceRoot::new("/tmp/already-open").unwrap();
        model
            .add_workspace(crate::Workspace::new(
                existing_id.clone(),
                root.clone(),
                DisplayPath::new("/tmp/already-open").unwrap(),
                None,
            ))
            .unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();

        coordinator
            .dispatch_user(intent(
                "open-existing-root",
                UserIntent::OpenFolder { path: RequestedPath::new("/tmp/already-open").unwrap() },
            ))
            .unwrap();
        let (path_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("existing-path-resolved"),
                ProviderEvent::WorkspacePathResolved {
                    token: path_token,
                    root,
                    selected_path: DisplayPath::new("/tmp/already-open").unwrap(),
                },
            ))
            .unwrap();
        let (id_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let outcome = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("existing-id-generated"),
                ProviderEvent::WorkspaceIdGenerated {
                    token: id_token,
                    workspace_id: WorkspaceId::for_test("discarded-new-workspace"),
                },
            ))
            .unwrap();

        assert!(matches!(outcome, IntentOutcome::Updated { .. }));
        assert_eq!(coordinator.snapshot().workspaces().len(), 1);
        assert_eq!(
            coordinator.snapshot().selection().context(),
            &NavigationContext::Workspace(existing_id)
        );
        assert_eq!(coordinator.snapshot().selection().activity(), Activity::Editor);
    }

    #[test]
    fn stale_wrong_kind_completion_is_content_free_and_does_not_mutate() {
        let mut coordinator = AppCoordinator::new();
        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "open-folder-stale",
                UserIntent::OpenFolder { path: RequestedPath::new("/tmp/stale").unwrap() },
            ))
            .unwrap();
        let (token, _) = operation_effect(&coordinator.subscribe().into_events());
        let before = coordinator.snapshot();
        let error = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("wrong-kind"),
                ProviderEvent::AgentStopCompleted {
                    token,
                    agent_id: AgentId::for_test("wrong-agent"),
                    result: AgentStopResult::Stopped,
                },
            ))
            .expect_err("wrong completion kind rejected");
        assert_eq!(error.code(), super::super::error::AppErrorCode::StaleCompletion);
        assert_eq!(error.intent_id(), None);
        assert_eq!(error.operation_id().expect("operation id"), error.operation_id().unwrap());
        assert_eq!(coordinator.snapshot(), before);
    }

    #[test]
    fn persisted_close_resume_reinspects_and_does_not_reconfirm_busy_resources() {
        let workspace_id = WorkspaceId::for_test("resume-close");
        let mut model = AppModel::new();
        model.add_workspace(workspace(workspace_id.as_str(), "/tmp/resume-close")).unwrap();
        model.mark_workspace_closing(&workspace_id, CleanupProgress::new(0, false, false)).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        coordinator
            .resume_persisted_close(workspace_id.clone(), op("resume-close-operation"))
            .unwrap();
        let (inspection_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("resume-close-inspection"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: inspection_token,
                    workspace_id: workspace_id.clone(),
                    inspection: CloseInspectionInputs::new(
                        ResourceInspection::busy(1).unwrap(),
                        ResourceInspection::Clean,
                        ResourceInspection::Clean,
                        ResourceInspection::Clean,
                        ResourceInspection::Clean,
                    ),
                },
            ))
            .unwrap();
        let (_, cleanup_effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(cleanup_effect, Effect::CleanupWorkspace { .. }));
    }

    #[test]
    fn create_agent_uses_profile_id_then_profile_and_id_effects() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("agent-workspace");
        model.add_workspace(workspace("agent-workspace", "/tmp/agent")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "create-agent",
                UserIntent::CreateAgent {
                    workspace_id: workspace_id.clone(),
                    profile_id: AgentProfileId::for_test("codex"),
                },
            ))
            .unwrap();
        let (profile_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::ResolveAgentProfile { .. }));
        let agent_profile = profile("codex");
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("profile-event"),
                ProviderEvent::ProfileResolved {
                    token: profile_token,
                    workspace_id: workspace_id.clone(),
                    profile: agent_profile,
                },
            ))
            .unwrap();
        let (id_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::GenerateAgentId { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("agent-id-event"),
                ProviderEvent::AgentIdGenerated {
                    token: id_token,
                    workspace_id: workspace_id.clone(),
                    agent_id: AgentId::for_test("created-agent"),
                },
            ))
            .unwrap();
        let (launch_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::LaunchAgent { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("agent-launch-event"),
                ProviderEvent::AgentLaunchCompleted {
                    token: launch_token,
                    workspace_id: workspace_id.clone(),
                    agent_id: AgentId::for_test("created-agent"),
                    result: AgentLaunchResult::Started,
                },
            ))
            .unwrap();
        assert_eq!(coordinator.snapshot().workspaces()[0].agents().len(), 1);
        assert_eq!(
            coordinator.snapshot().selection().context(),
            &NavigationContext::Agent(AgentId::for_test("created-agent"))
        );
        assert_eq!(coordinator.snapshot().selection().activity(), Activity::Agent);
    }

    #[test]
    fn stop_confirmation_failure_and_retry_follow_domain_control_state() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("stop-workspace");
        let agent_id = AgentId::for_test("stop-agent");
        model.add_workspace(workspace("stop-workspace", "/tmp/stop")).unwrap();
        model.add_agent(&workspace_id, agent_id.clone(), profile("codex")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        let deferred_confirmation = coordinator
            .dispatch_user(intent("stop", UserIntent::StopAgent { agent_id: agent_id.clone() }))
            .unwrap();
        assert!(matches!(deferred_confirmation, IntentOutcome::Deferred { .. }));
        let (confirmation_token, confirmation_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(confirmation_effect, Effect::GenerateConfirmationId { .. }));
        let confirmation = match coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("stop-confirmation-id"),
                ProviderEvent::ConfirmationIdGenerated {
                    token: confirmation_token,
                    confirmation_id: ConfirmationId::for_test(canonical_id("stop-confirmation")),
                },
            ))
            .unwrap()
        {
            IntentOutcome::ConfirmationRequired { confirmation_id, .. } => confirmation_id,
            other => panic!("expected confirmation, got {other:?}"),
        };
        let deferred = coordinator
            .dispatch_user(intent(
                "confirm-stop",
                UserIntent::ConfirmStopAgent { confirmation_id: confirmation.clone() },
            ))
            .unwrap();
        assert!(matches!(deferred, IntentOutcome::Deferred { .. }));
        let (token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::StopAgent { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("stop-failure"),
                ProviderEvent::AgentStopCompleted {
                    token,
                    agent_id: agent_id.clone(),
                    result: AgentStopResult::Failed { diagnostic: DiagnosticCode::CleanupFailed },
                },
            ))
            .unwrap();
        assert!(coordinator.snapshot().workspaces()[0].agents()[0].can_retry_stop());
        coordinator
            .dispatch_user(intent(
                "retry-stop",
                UserIntent::RetryStopAgent { agent_id: agent_id.clone() },
            ))
            .unwrap();
        let (retry_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("stop-success"),
                ProviderEvent::AgentStopCompleted {
                    token: retry_token,
                    agent_id,
                    result: AgentStopResult::Stopped,
                },
            ))
            .unwrap();
        assert!(coordinator.snapshot().workspaces()[0].agents().is_empty());
    }

    #[test]
    fn natural_exit_atomically_clears_stop_confirmation_and_tombstones_stop_completion() {
        let workspace_id = WorkspaceId::for_test("natural-exit-workspace");
        let confirmation_agent = AgentId::for_test("natural-exit-confirmation-agent");
        let stopping_agent = AgentId::for_test("natural-exit-stopping-agent");
        let completion_first_agent = AgentId::for_test("natural-exit-completion-first-agent");
        let mut model = AppModel::new();
        model.add_workspace(workspace(&workspace_id.to_string(), "/tmp/natural-exit")).unwrap();
        model.add_agent(&workspace_id, confirmation_agent.clone(), profile("codex")).unwrap();
        model.add_agent(&workspace_id, stopping_agent.clone(), profile("claude")).unwrap();
        model.add_agent(&workspace_id, completion_first_agent.clone(), profile("codex")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();

        coordinator
            .dispatch_user(intent(
                "natural-exit-confirmation-request",
                UserIntent::StopAgent { agent_id: confirmation_agent.clone() },
            ))
            .unwrap();
        let (confirmation_generation, _) = operation_effect(&coordinator.subscribe().into_events());
        let confirmation_id = ConfirmationId::for_test(canonical_id("natural-exit-confirmation"));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-confirmation-generated"),
                ProviderEvent::ConfirmationIdGenerated {
                    token: confirmation_generation,
                    confirmation_id: confirmation_id.clone(),
                },
            ))
            .unwrap();
        coordinator.subscribe();
        coordinator.request_agents_reconcile(op("natural-exit-confirmation-reconcile")).unwrap();
        let (confirmation_reconcile_token, _) =
            operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-confirmation-exited"),
                ProviderEvent::AgentsReconciled {
                    token: confirmation_reconcile_token,
                    reconciliation: AgentReconciliation::new([], [confirmation_agent.clone()]),
                },
            ))
            .unwrap();
        assert!(coordinator.snapshot().workspaces()[0]
            .agents()
            .iter()
            .all(|agent| agent.id() != &confirmation_agent));
        let expired = coordinator
            .dispatch_user(intent(
                "natural-exit-confirmation-confirm",
                UserIntent::ConfirmStopAgent { confirmation_id },
            ))
            .expect_err("a naturally exited Agent cannot retain a confirmation");
        assert_eq!(expired.code(), super::super::error::AppErrorCode::ConfirmationExpired);

        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "natural-exit-stop-request",
                UserIntent::StopAgent { agent_id: stopping_agent.clone() },
            ))
            .unwrap();
        let (stop_confirmation_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let stop_confirmation_id = ConfirmationId::for_test(canonical_id("natural-exit-stop"));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-stop-confirmation-generated"),
                ProviderEvent::ConfirmationIdGenerated {
                    token: stop_confirmation_token,
                    confirmation_id: stop_confirmation_id.clone(),
                },
            ))
            .unwrap();
        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "natural-exit-stop-confirm",
                UserIntent::ConfirmStopAgent { confirmation_id: stop_confirmation_id },
            ))
            .unwrap();
        let (stop_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator.request_agents_reconcile(op("natural-exit-stop-reconcile")).unwrap();
        let (stop_reconcile_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-stop-exited"),
                ProviderEvent::AgentsReconciled {
                    token: stop_reconcile_token,
                    reconciliation: AgentReconciliation::new([], [stopping_agent.clone()]),
                },
            ))
            .unwrap();
        assert!(coordinator.snapshot().workspaces()[0]
            .agents()
            .iter()
            .all(|agent| agent.id() != &stopping_agent));
        let late = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-stop-late-completion"),
                ProviderEvent::AgentStopCompleted {
                    token: stop_token.clone(),
                    agent_id: stopping_agent.clone(),
                    result: AgentStopResult::Stopped,
                },
            ))
            .expect("natural removal makes stop completion idempotent");
        assert!(matches!(late, IntentOutcome::Noop { .. }));
        let duplicate_late = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-stop-late-duplicate"),
                ProviderEvent::AgentStopCompleted {
                    token: stop_token.clone(),
                    agent_id: stopping_agent.clone(),
                    result: AgentStopResult::Stopped,
                },
            ))
            .expect("duplicate stop completion remains idempotent");
        assert!(matches!(duplicate_late, IntentOutcome::Noop { .. }));

        coordinator
            .model
            .add_agent(&workspace_id, stopping_agent.clone(), profile("claude"))
            .unwrap();
        let stale = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-stop-late-reused-agent"),
                ProviderEvent::AgentStopCompleted {
                    token: stop_token,
                    agent_id: stopping_agent.clone(),
                    result: AgentStopResult::Stopped,
                },
            ))
            .expect_err("old completion must not mutate a replacement Agent");
        assert_eq!(stale.code(), super::super::error::AppErrorCode::StaleCompletion);
        assert!(coordinator.snapshot().workspaces()[0]
            .agents()
            .iter()
            .any(|agent| agent.id() == &stopping_agent));

        coordinator
            .dispatch_user(intent(
                "natural-exit-completion-first-request",
                UserIntent::StopAgent { agent_id: completion_first_agent.clone() },
            ))
            .unwrap();
        let (completion_first_confirmation_token, _) =
            operation_effect(&coordinator.subscribe().into_events());
        let completion_first_confirmation_id =
            ConfirmationId::for_test(canonical_id("natural-exit-completion-first-confirmation"));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-completion-first-confirmation-generated"),
                ProviderEvent::ConfirmationIdGenerated {
                    token: completion_first_confirmation_token,
                    confirmation_id: completion_first_confirmation_id.clone(),
                },
            ))
            .unwrap();
        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "natural-exit-completion-first-confirm",
                UserIntent::ConfirmStopAgent { confirmation_id: completion_first_confirmation_id },
            ))
            .unwrap();
        let (completion_first_stop_token, _) =
            operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .request_agent_reconcile(
                op("natural-exit-completion-first-reconcile"),
                completion_first_agent.clone(),
            )
            .unwrap();
        let (completion_first_reconcile_token, _) =
            operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-completion-first-stop-completed"),
                ProviderEvent::AgentStopCompleted {
                    token: completion_first_stop_token,
                    agent_id: completion_first_agent.clone(),
                    result: AgentStopResult::Stopped,
                },
            ))
            .unwrap();
        coordinator
            .model
            .add_agent(&workspace_id, completion_first_agent.clone(), profile("codex"))
            .unwrap();
        let stale_exit = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("natural-exit-completion-first-stale-exit"),
                ProviderEvent::AgentExited {
                    token: completion_first_reconcile_token,
                    agent_id: completion_first_agent.clone(),
                },
            ))
            .expect_err("a stop completion invalidates an older natural-exit observation");
        assert_eq!(stale_exit.code(), super::super::error::AppErrorCode::StaleCompletion);
        assert!(coordinator.snapshot().workspaces()[0]
            .agents()
            .iter()
            .any(|agent| agent.id() == &completion_first_agent));
    }

    #[test]
    fn workspace_close_is_reinspected_and_cleans_in_strict_order_with_retry() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("close-workspace");
        model.add_workspace(workspace("close-workspace", "/tmp/close")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "request-close",
                UserIntent::RequestCloseWorkspace { workspace_id: workspace_id.clone() },
            ))
            .unwrap();
        let (inspect_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let busy = CloseInspectionInputs::new(
            ResourceInspection::busy(1).unwrap(),
            ResourceInspection::clean(),
            ResourceInspection::clean(),
            ResourceInspection::clean(),
            ResourceInspection::clean(),
        );
        let deferred_confirmation = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("busy-inspection"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: inspect_token,
                    workspace_id: workspace_id.clone(),
                    inspection: busy,
                },
            ))
            .unwrap();
        assert!(matches!(deferred_confirmation, IntentOutcome::Deferred { .. }));
        let (confirmation_token, confirmation_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(confirmation_effect, Effect::GenerateConfirmationId { .. }));
        let confirmation = match coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-confirmation-id"),
                ProviderEvent::ConfirmationIdGenerated {
                    token: confirmation_token,
                    confirmation_id: ConfirmationId::for_test(canonical_id("close-confirmation")),
                },
            ))
            .unwrap()
        {
            IntentOutcome::ConfirmationRequired { confirmation_id, .. } => confirmation_id,
            other => panic!("expected close confirmation, got {other:?}"),
        };
        coordinator
            .dispatch_user(intent(
                "confirm-close",
                UserIntent::ConfirmCloseWorkspace { confirmation_id: confirmation.clone() },
            ))
            .unwrap();
        let (reinspect_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("clean-reinspection"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: reinspect_token,
                    workspace_id: workspace_id.clone(),
                    inspection: CloseInspectionInputs::clean(),
                },
            ))
            .unwrap();
        let (initial_persist_token, initial_persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(initial_persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("initial-close-persisted"),
                ProviderEvent::StatePersisted { token: initial_persist_token },
            ))
            .unwrap();
        let (agents_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::CleanupWorkspace { step: CleanupStep::Agents, .. }));
        assert!(matches!(
            coordinator.snapshot().workspaces()[0].state(),
            crate::WorkspaceState::Closing { .. }
        ));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("agents-complete"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: agents_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Agents),
                },
            ))
            .unwrap();
        assert!(matches!(
            coordinator.snapshot().workspaces()[0].state(),
            crate::WorkspaceState::Closing { .. }
        ));
        let (agents_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("agents-persisted"),
                ProviderEvent::StatePersisted { token: agents_persist_token },
            ))
            .unwrap();
        let (terminal_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::CleanupWorkspace { step: CleanupStep::Terminal, .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("terminal-failed"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: terminal_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::Failed {
                        step: CleanupStep::Terminal,
                        diagnostic: DiagnosticCode::CleanupFailed,
                    },
                },
            ))
            .unwrap();
        assert!(matches!(
            coordinator.snapshot().workspaces()[0].state(),
            crate::WorkspaceState::ClosingFailed { .. }
        ));
        coordinator
            .dispatch_user(intent(
                "retry-close",
                UserIntent::RetryCloseWorkspace { workspace_id: workspace_id.clone() },
            ))
            .unwrap();
        let (retry_inspect, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::InspectWorkspace { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("retry-inspection"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: retry_inspect,
                    workspace_id: workspace_id.clone(),
                    inspection: CloseInspectionInputs::clean(),
                },
            ))
            .unwrap();
        let (retry_terminal, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::CleanupWorkspace { step: CleanupStep::Terminal, .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("terminal-retry"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: retry_terminal,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Terminal),
                },
            ))
            .unwrap();
        let (retry_terminal_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("terminal-retry-persisted"),
                ProviderEvent::StatePersisted { token: retry_terminal_persist_token },
            ))
            .unwrap();
        let (editor_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::CleanupWorkspace { step: CleanupStep::Editor, .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("editor-complete"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: editor_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Editor),
                },
            ))
            .unwrap();
        let (editor_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("editor-persisted"),
                ProviderEvent::StatePersisted { token: editor_persist_token },
            ))
            .unwrap();
        let (final_inspect_token, effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::InspectWorkspace { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-inspection"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: final_inspect_token,
                    workspace_id: workspace_id.clone(),
                    inspection: CloseInspectionInputs::clean(),
                },
            ))
            .unwrap();
        let (state_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(
            effect,
            Effect::CleanupWorkspace { step: CleanupStep::StateCommitted, .. }
        ));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("state-committed"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: state_token,
                    workspace_id,
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::StateCommitted),
                },
            ))
            .unwrap();
        let (final_persist_token, final_persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(final_persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-state-persisted"),
                ProviderEvent::StatePersisted { token: final_persist_token },
            ))
            .unwrap();
        assert!(coordinator.snapshot().workspaces().is_empty());
    }

    #[test]
    fn final_non_clean_reinspection_enters_closing_failed_and_is_retryable() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("final-reinspect-workspace");
        model
            .add_workspace(workspace("final-reinspect-workspace", "/tmp/final-reinspect"))
            .unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "final-reinspect-request",
                UserIntent::RequestCloseWorkspace { workspace_id: workspace_id.clone() },
            ))
            .unwrap();
        let (inspect_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let busy = CloseInspectionInputs::new(
            ResourceInspection::busy(1).unwrap(),
            ResourceInspection::clean(),
            ResourceInspection::clean(),
            ResourceInspection::clean(),
            ResourceInspection::clean(),
        );
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-initial"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: inspect_token,
                    workspace_id: workspace_id.clone(),
                    inspection: busy,
                },
            ))
            .unwrap();
        let (confirmation_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let confirmation = match coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-confirmation"),
                ProviderEvent::ConfirmationIdGenerated {
                    token: confirmation_token,
                    confirmation_id: ConfirmationId::for_test(canonical_id(
                        "final-reinspect-confirm",
                    )),
                },
            ))
            .unwrap()
        {
            IntentOutcome::ConfirmationRequired { confirmation_id, .. } => confirmation_id,
            other => panic!("expected confirmation, got {other:?}"),
        };
        coordinator
            .dispatch_user(intent(
                "final-reinspect-confirm-intent",
                UserIntent::ConfirmCloseWorkspace { confirmation_id: confirmation },
            ))
            .unwrap();
        let (reinspect_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-clean"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: reinspect_token,
                    workspace_id: workspace_id.clone(),
                    inspection: CloseInspectionInputs::clean(),
                },
            ))
            .unwrap();
        let (initial_persist_token, initial_persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(initial_persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-initial-persisted"),
                ProviderEvent::StatePersisted { token: initial_persist_token },
            ))
            .unwrap();
        let (agents_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-agents"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: agents_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Agents),
                },
            ))
            .unwrap();
        let (agents_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-agents-persisted"),
                ProviderEvent::StatePersisted { token: agents_persist_token },
            ))
            .unwrap();
        let (terminal_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-terminal"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: terminal_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Terminal),
                },
            ))
            .unwrap();
        let (terminal_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-terminal-persisted"),
                ProviderEvent::StatePersisted { token: terminal_persist_token },
            ))
            .unwrap();
        let (editor_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-editor"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: editor_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Editor),
                },
            ))
            .unwrap();
        let (editor_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-editor-persisted"),
                ProviderEvent::StatePersisted { token: editor_persist_token },
            ))
            .unwrap();
        let (final_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let outcome = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("final-reinspect-busy"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: final_token,
                    workspace_id: workspace_id.clone(),
                    inspection: CloseInspectionInputs::new(
                        ResourceInspection::clean(),
                        ResourceInspection::busy(1).unwrap(),
                        ResourceInspection::clean(),
                        ResourceInspection::clean(),
                        ResourceInspection::clean(),
                    ),
                },
            ))
            .unwrap();
        assert!(matches!(outcome, IntentOutcome::Updated { .. }));
        assert!(matches!(
            coordinator.snapshot().workspaces()[0].state(),
            crate::WorkspaceState::ClosingFailed { .. }
        ));
    }

    #[test]
    fn closing_tombstones_late_launches_and_serializes_close_requests() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("close-race-workspace");
        model.add_workspace(workspace("close-race-workspace", "/tmp/close-race")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();

        coordinator
            .dispatch_user(intent(
                "close-race-create",
                UserIntent::CreateAgent {
                    workspace_id: workspace_id.clone(),
                    profile_id: AgentProfileId::for_test("codex"),
                },
            ))
            .unwrap();
        let (profile_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-profile"),
                ProviderEvent::ProfileResolved {
                    token: profile_token,
                    workspace_id: workspace_id.clone(),
                    profile: profile("codex"),
                },
            ))
            .unwrap();
        let (id_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let pending_agent_id = AgentId::for_test("close-race-agent");
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-id"),
                ProviderEvent::AgentIdGenerated {
                    token: id_token,
                    workspace_id: workspace_id.clone(),
                    agent_id: pending_agent_id.clone(),
                },
            ))
            .unwrap();
        let (launch_token, _) = operation_effect(&coordinator.subscribe().into_events());

        coordinator
            .dispatch_user(intent(
                "close-race-request",
                UserIntent::RequestCloseWorkspace { workspace_id: workspace_id.clone() },
            ))
            .unwrap();
        let (inspect_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-inspection"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: inspect_token,
                    workspace_id: workspace_id.clone(),
                    inspection: CloseInspectionInputs::clean(),
                },
            ))
            .unwrap();
        let (initial_persist_token, initial_persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(initial_persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-initial-persisted"),
                ProviderEvent::StatePersisted { token: initial_persist_token },
            ))
            .unwrap();
        let (agents_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::CleanupWorkspace { step: CleanupStep::Agents, .. }));
        assert!(matches!(
            coordinator.snapshot().workspaces()[0].state(),
            crate::WorkspaceState::Closing { .. }
        ));
        assert!(!coordinator.snapshot().workspaces()[0].can_create_agent());

        let create_error = coordinator
            .dispatch_user(intent(
                "close-race-create-during-closing",
                UserIntent::CreateAgent {
                    workspace_id: workspace_id.clone(),
                    profile_id: AgentProfileId::for_test("codex"),
                },
            ))
            .expect_err("creation is rejected while cleanup owns the Workspace");
        assert_eq!(create_error.domain_code(), Some(DomainErrorCode::WorkspaceUnavailable));
        let second_close_error = coordinator
            .dispatch_user(intent(
                "close-race-second-close",
                UserIntent::RequestCloseWorkspace { workspace_id: workspace_id.clone() },
            ))
            .expect_err("a second close cannot replace the active cleanup");
        assert_eq!(second_close_error.domain_code(), Some(DomainErrorCode::WorkspaceClosing));

        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-agents"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: agents_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Agents),
                },
            ))
            .unwrap();
        let (agents_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-agents-persisted"),
                ProviderEvent::StatePersisted { token: agents_persist_token },
            ))
            .unwrap();
        let (terminal_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::CleanupWorkspace { step: CleanupStep::Terminal, .. }));

        let late_launch = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-late-launch"),
                ProviderEvent::AgentLaunchCompleted {
                    token: launch_token,
                    workspace_id: workspace_id.clone(),
                    agent_id: pending_agent_id,
                    result: AgentLaunchResult::Started,
                },
            ))
            .expect_err("cleanup tombstones the launch completion");
        assert_eq!(late_launch.code(), super::super::error::AppErrorCode::StaleCompletion);
        assert!(coordinator.snapshot().workspaces()[0].agents().is_empty());

        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-terminal"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: terminal_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Terminal),
                },
            ))
            .unwrap();
        let (terminal_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-terminal-persisted"),
                ProviderEvent::StatePersisted { token: terminal_persist_token },
            ))
            .unwrap();
        let (editor_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::CleanupWorkspace { step: CleanupStep::Editor, .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-editor"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: editor_token,
                    workspace_id: workspace_id.clone(),
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::Editor),
                },
            ))
            .unwrap();
        let (editor_persist_token, persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-editor-persisted"),
                ProviderEvent::StatePersisted { token: editor_persist_token },
            ))
            .unwrap();
        let (final_inspect_token, effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::InspectWorkspace { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-final-inspection"),
                ProviderEvent::WorkspaceInspectionCompleted {
                    token: final_inspect_token,
                    workspace_id: workspace_id.clone(),
                    inspection: CloseInspectionInputs::clean(),
                },
            ))
            .unwrap();
        let (state_token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(
            effect,
            Effect::CleanupWorkspace { step: CleanupStep::StateCommitted, .. }
        ));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-state-committed"),
                ProviderEvent::WorkspaceCleanupCompleted {
                    token: state_token,
                    workspace_id,
                    result: WorkspaceCleanupResult::StepCompleted(CleanupStep::StateCommitted),
                },
            ))
            .unwrap();
        let (final_persist_token, final_persist_effect) =
            operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(final_persist_effect, Effect::PersistState { .. }));
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("close-race-final-state-persisted"),
                ProviderEvent::StatePersisted { token: final_persist_token },
            ))
            .unwrap();
        assert!(coordinator.snapshot().workspaces().is_empty());
    }

    #[test]
    fn new_window_without_path_focuses_global_editor_and_repeated_selection_is_noop() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("window-workspace");
        model.add_workspace(workspace("window-workspace", "/tmp/window")).unwrap();
        model.select_context(NavigationContext::Workspace(workspace_id)).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();

        let first = coordinator
            .dispatch_user(intent("new-window-global", UserIntent::NewWindow { path: None }))
            .unwrap();
        assert!(matches!(first, IntentOutcome::Updated { .. }));
        assert_eq!(coordinator.snapshot().selection().context(), &NavigationContext::Global);
        assert_eq!(coordinator.snapshot().selection().activity(), Activity::Editor);
        let revision = coordinator.snapshot().revision();

        let second = coordinator
            .dispatch_user(intent("new-window-global-repeat", UserIntent::NewWindow { path: None }))
            .unwrap();
        assert!(matches!(second, IntentOutcome::Noop { .. }));
        assert_eq!(coordinator.snapshot().revision(), revision);
    }

    #[test]
    fn operation_id_collision_rejects_without_invalidating_existing_operation() {
        let mut coordinator = AppCoordinator::new();
        coordinator.subscribe();
        let operation_id = op("aggregate-collision");
        let first = coordinator.request_agents_reconcile(operation_id.clone()).unwrap();
        let first_snapshot = coordinator.snapshot();
        let error = coordinator
            .request_agents_reconcile(operation_id.clone())
            .expect_err("an in-flight operation cannot be overwritten");
        assert_eq!(error.code(), super::super::error::AppErrorCode::OperationInProgress);
        assert_eq!(error.operation_id(), Some(&operation_id));
        assert_eq!(coordinator.snapshot(), first_snapshot);
        assert!(matches!(first, IntentOutcome::Deferred { .. }));
        let (token, effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(effect, Effect::ReconcileAgents { .. }));
        assert_eq!(token.operation_id(), &operation_id);
    }

    #[test]
    fn operation_generation_exhaustion_is_typed_and_does_not_register_work() {
        let mut coordinator = AppCoordinator::new();
        coordinator.next_generation = u64::MAX;
        let operation_id = op("generation-exhaustion");
        let error = coordinator
            .request_agents_reconcile(operation_id.clone())
            .expect_err("generation overflow must be rejected");
        assert_eq!(error.code(), super::super::error::AppErrorCode::OperationGenerationExhausted);
        assert_eq!(error.operation_id(), Some(&operation_id));
        assert!(coordinator.subscribe().into_events().iter().all(|event| {
            !matches!(event.event(), CoordinatorEvent::Effect(Effect::ReconcileAgents { .. }))
        }));
    }

    #[test]
    fn reused_operation_id_keeps_generation_tombstones_separate() {
        let mut coordinator = AppCoordinator::new();
        coordinator.subscribe();
        let operation_id = op("reused-operation");
        coordinator.request_agents_reconcile(operation_id.clone()).unwrap();
        let (first_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reused-operation-first-completion"),
                ProviderEvent::AgentsReconciled {
                    token: first_token.clone(),
                    reconciliation: AgentReconciliation::default(),
                },
            ))
            .unwrap();

        coordinator.request_agents_reconcile(operation_id.clone()).unwrap();
        let (second_token, _) = operation_effect(&coordinator.subscribe().into_events());
        assert!(second_token.generation() > first_token.generation());
        let stale = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reused-operation-late-first"),
                ProviderEvent::AgentsReconciled {
                    token: first_token,
                    reconciliation: AgentReconciliation::default(),
                },
            ))
            .expect_err("late generation must not complete the reused operation");
        assert_eq!(stale.code(), super::super::error::AppErrorCode::StaleCompletion);
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reused-operation-second-completion"),
                ProviderEvent::AgentsReconciled {
                    token: second_token,
                    reconciliation: AgentReconciliation::default(),
                },
            ))
            .unwrap();
    }

    #[test]
    fn launch_failure_and_wrong_completion_never_create_a_phantom_agent() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("launch-failure-workspace");
        model.add_workspace(workspace("launch-failure-workspace", "/tmp/launch-failure")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "launch-failure-create",
                UserIntent::CreateAgent {
                    workspace_id: workspace_id.clone(),
                    profile_id: AgentProfileId::for_test("codex"),
                },
            ))
            .unwrap();
        let (profile_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("launch-failure-profile"),
                ProviderEvent::ProfileResolved {
                    token: profile_token,
                    workspace_id: workspace_id.clone(),
                    profile: profile("codex"),
                },
            ))
            .unwrap();
        let (id_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let agent_id = AgentId::for_test("launch-failure-agent");
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("launch-failure-id"),
                ProviderEvent::AgentIdGenerated {
                    token: id_token,
                    workspace_id: workspace_id.clone(),
                    agent_id: agent_id.clone(),
                },
            ))
            .unwrap();
        let (launch_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let before = coordinator.snapshot();
        let wrong = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("launch-failure-wrong-target"),
                ProviderEvent::AgentLaunchCompleted {
                    token: launch_token.clone(),
                    workspace_id: workspace_id.clone(),
                    agent_id: AgentId::for_test("other-agent"),
                    result: AgentLaunchResult::Started,
                },
            ))
            .expect_err("completion target is bound to the launch effect");
        assert_eq!(wrong.code(), super::super::error::AppErrorCode::StaleCompletion);
        assert_eq!(coordinator.snapshot(), before);
        assert!(coordinator.snapshot().workspaces()[0].agents().is_empty());

        let failure_event = ProviderEventEnvelope::new(
            op("launch-failure-result"),
            ProviderEvent::AgentLaunchCompleted {
                token: launch_token.clone(),
                workspace_id,
                agent_id,
                result: AgentLaunchResult::Failed {
                    diagnostic: DiagnosticCode::RuntimeUnavailable,
                },
            },
        );
        let failure = coordinator
            .accept_provider_event(failure_event.clone())
            .expect_err("failed launch is surfaced as a port failure");
        assert_eq!(failure.code(), super::super::error::AppErrorCode::PortUnavailable);
        assert!(coordinator.snapshot().workspaces()[0].agents().is_empty());
        let replay = coordinator.accept_provider_event(failure_event).expect_err("cached failure");
        assert_eq!(replay, failure);
        let stale = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("launch-failure-late"),
                ProviderEvent::AgentLaunchCompleted {
                    token: launch_token,
                    workspace_id: WorkspaceId::for_test("launch-failure-workspace"),
                    agent_id: AgentId::for_test("launch-failure-agent"),
                    result: AgentLaunchResult::Started,
                },
            ))
            .expect_err("late completion is stale after terminal launch failure");
        assert_eq!(stale.code(), super::super::error::AppErrorCode::StaleCompletion);
    }

    #[test]
    fn launch_commit_collision_emits_compensating_termination_without_phantom_state() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("launch-commit-collision-workspace");
        let colliding_agent = AgentId::for_test("launch-commit-collision-agent");
        model
            .add_workspace(workspace(
                "launch-commit-collision-workspace",
                "/tmp/launch-commit-collision",
            ))
            .unwrap();
        model.add_agent(&workspace_id, colliding_agent.clone(), profile("codex")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        coordinator
            .dispatch_user(intent(
                "launch-commit-collision-create",
                UserIntent::CreateAgent {
                    workspace_id: workspace_id.clone(),
                    profile_id: AgentProfileId::for_test("codex"),
                },
            ))
            .unwrap();
        let (profile_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("launch-commit-collision-profile"),
                ProviderEvent::ProfileResolved {
                    token: profile_token,
                    workspace_id: workspace_id.clone(),
                    profile: profile("codex"),
                },
            ))
            .unwrap();
        let (id_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("launch-commit-collision-id"),
                ProviderEvent::AgentIdGenerated {
                    token: id_token,
                    workspace_id: workspace_id.clone(),
                    agent_id: colliding_agent.clone(),
                },
            ))
            .unwrap();
        let (launch_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let before = coordinator.snapshot();
        let error = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("launch-commit-collision-result"),
                ProviderEvent::AgentLaunchCompleted {
                    token: launch_token,
                    workspace_id: workspace_id.clone(),
                    agent_id: colliding_agent,
                    result: AgentLaunchResult::Started,
                },
            ))
            .expect_err("domain commit collision is surfaced");
        assert_eq!(error.domain_code(), Some(DomainErrorCode::DuplicateAgent));
        assert_eq!(coordinator.snapshot(), before);
        let events = coordinator.subscribe().into_events();
        assert!(events.iter().any(|event| {
            matches!(event.event(), CoordinatorEvent::Effect(Effect::TerminateAgent { .. }))
        }));
    }

    #[test]
    fn identical_reconciliation_is_a_noop_without_snapshot_or_persist() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("reconcile-noop-workspace");
        let agent_id = AgentId::for_test("reconcile-noop-agent");
        model.add_workspace(workspace("reconcile-noop-workspace", "/tmp/reconcile-noop")).unwrap();
        model.add_agent(&workspace_id, agent_id.clone(), profile("codex")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        coordinator.request_agents_reconcile(op("reconcile-noop-aggregate")).unwrap();
        let (token, _) = operation_effect(&coordinator.subscribe().into_events());
        let before = coordinator.snapshot();
        let outcome = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reconcile-noop-aggregate-completion"),
                ProviderEvent::AgentsReconciled {
                    token,
                    reconciliation: AgentReconciliation::new(
                        [AgentObservation::new(
                            agent_id.clone(),
                            AgentStatus::Idle,
                            RuntimeHealth::Starting,
                        )],
                        [],
                    ),
                },
            ))
            .unwrap();
        assert!(matches!(outcome, IntentOutcome::Noop { .. }));
        assert_eq!(coordinator.snapshot().revision(), before.revision());
        let events = coordinator.subscribe().into_events();
        assert!(events
            .iter()
            .any(|event| { matches!(event.event(), CoordinatorEvent::OperationCompleted { .. }) }));
        assert!(events.iter().any(|event| matches!(event.event(), CoordinatorEvent::Noop)));
        assert!(!events.iter().any(|event| {
            matches!(
                event.event(),
                CoordinatorEvent::Snapshot(_)
                    | CoordinatorEvent::Effect(Effect::PersistState { .. })
            )
        }));

        coordinator.request_agent_reconcile(op("reconcile-noop-single"), agent_id.clone()).unwrap();
        let (single_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let single_outcome = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reconcile-noop-single-completion"),
                ProviderEvent::AgentStatusChanged {
                    token: single_token,
                    agent_id,
                    status: AgentStatus::Idle,
                    runtime_health: RuntimeHealth::Starting,
                },
            ))
            .unwrap();
        assert!(matches!(single_outcome, IntentOutcome::Noop { .. }));
        assert_eq!(coordinator.snapshot().revision(), before.revision());
    }

    #[test]
    fn aggregate_and_single_reconciliation_share_one_epoch() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("reconcile-epoch-workspace");
        let agent_id = AgentId::for_test("reconcile-epoch-agent");
        model
            .add_workspace(workspace("reconcile-epoch-workspace", "/tmp/reconcile-epoch"))
            .unwrap();
        model.add_agent(&workspace_id, agent_id.clone(), profile("codex")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();

        coordinator
            .request_agent_reconcile(op("reconcile-epoch-single-old"), agent_id.clone())
            .unwrap();
        let (single_old, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator.request_agents_reconcile(op("reconcile-epoch-aggregate-new")).unwrap();
        let (aggregate_new, _) = operation_effect(&coordinator.subscribe().into_events());
        let stale_single = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reconcile-epoch-single-old-completion"),
                ProviderEvent::AgentStatusChanged {
                    token: single_old,
                    agent_id: agent_id.clone(),
                    status: AgentStatus::Error,
                    runtime_health: RuntimeHealth::Failed,
                },
            ))
            .expect_err("new aggregate invalidates the older single epoch");
        assert_eq!(stale_single.code(), super::super::error::AppErrorCode::StaleCompletion);
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reconcile-epoch-aggregate-new-completion"),
                ProviderEvent::AgentsReconciled {
                    token: aggregate_new,
                    reconciliation: AgentReconciliation::default(),
                },
            ))
            .unwrap();

        coordinator.request_agents_reconcile(op("reconcile-epoch-aggregate-old")).unwrap();
        let (aggregate_old, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator
            .request_agent_reconcile(op("reconcile-epoch-single-new"), agent_id.clone())
            .unwrap();
        let (single_new, _) = operation_effect(&coordinator.subscribe().into_events());
        let stale_aggregate = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reconcile-epoch-aggregate-old-completion"),
                ProviderEvent::AgentsReconciled {
                    token: aggregate_old,
                    reconciliation: AgentReconciliation::default(),
                },
            ))
            .expect_err("new single epoch invalidates the older aggregate");
        assert_eq!(stale_aggregate.code(), super::super::error::AppErrorCode::StaleCompletion);
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reconcile-epoch-single-new-completion"),
                ProviderEvent::AgentStatusChanged {
                    token: single_new,
                    agent_id,
                    status: AgentStatus::Idle,
                    runtime_health: RuntimeHealth::Starting,
                },
            ))
            .unwrap();
    }

    #[test]
    fn aggregate_reconciliation_is_token_bound_and_applies_atomically_after_restart() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("reconcile-workspace");
        let first_agent = AgentId::for_test("reconcile-first-agent");
        let second_agent = AgentId::for_test("reconcile-second-agent");
        model.add_workspace(workspace("reconcile-workspace", "/tmp/reconcile")).unwrap();
        model.add_agent(&workspace_id, first_agent.clone(), profile("codex")).unwrap();
        model.add_agent(&workspace_id, second_agent.clone(), profile("claude")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();

        coordinator.request_agents_reconcile(op("reconcile-old")).unwrap();
        let (old_token, old_effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(old_effect, Effect::ReconcileAgents { .. }));
        coordinator.request_agents_reconcile(op("reconcile-new")).unwrap();
        let (new_token, new_effect) = operation_effect(&coordinator.subscribe().into_events());
        assert!(matches!(new_effect, Effect::ReconcileAgents { .. }));

        let before_stale = coordinator.snapshot();
        let stale = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reconcile-old-completion"),
                ProviderEvent::AgentsReconciled {
                    token: old_token,
                    reconciliation: AgentReconciliation::default(),
                },
            ))
            .expect_err("provider restart completion from the old epoch is stale");
        assert_eq!(stale.code(), super::super::error::AppErrorCode::StaleCompletion);
        assert_eq!(coordinator.snapshot(), before_stale);

        let reconciliation = AgentReconciliation::new(
            [AgentObservation::new(
                first_agent.clone(),
                AgentStatus::Working,
                RuntimeHealth::Healthy,
            )],
            [second_agent.clone()],
        );
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("reconcile-new-completion"),
                ProviderEvent::AgentsReconciled { token: new_token, reconciliation },
            ))
            .unwrap();
        let snapshot = coordinator.snapshot();
        assert_eq!(snapshot.workspaces()[0].agents().len(), 1);
        assert_eq!(snapshot.workspaces()[0].agents()[0].id(), &first_agent);
        assert_eq!(snapshot.workspaces()[0].agents()[0].status(), AgentStatus::Working);
        assert_eq!(snapshot.workspaces()[0].agents()[0].runtime_health(), RuntimeHealth::Healthy);
    }

    #[test]
    fn stale_single_agent_status_and_exit_cannot_mutate_after_reconcile_restart() {
        let mut model = AppModel::new();
        let workspace_id = WorkspaceId::for_test("single-reconcile-workspace");
        let agent_id = AgentId::for_test("single-reconcile-agent");
        model
            .add_workspace(workspace("single-reconcile-workspace", "/tmp/single-reconcile"))
            .unwrap();
        model.add_agent(&workspace_id, agent_id.clone(), profile("codex")).unwrap();
        let mut coordinator = AppCoordinator::with_model(model);
        coordinator.subscribe();
        coordinator.request_agent_reconcile(op("single-reconcile-old"), agent_id.clone()).unwrap();
        let (old_token, _) = operation_effect(&coordinator.subscribe().into_events());
        coordinator.request_agent_reconcile(op("single-reconcile-new"), agent_id.clone()).unwrap();
        let (new_token, _) = operation_effect(&coordinator.subscribe().into_events());
        let before = coordinator.snapshot();
        let stale = coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("single-reconcile-old-status"),
                ProviderEvent::AgentStatusChanged {
                    token: old_token,
                    agent_id: agent_id.clone(),
                    status: AgentStatus::Error,
                    runtime_health: RuntimeHealth::Failed,
                },
            ))
            .expect_err("old status completion is stale");
        assert_eq!(stale.code(), super::super::error::AppErrorCode::StaleCompletion);
        assert_eq!(coordinator.snapshot(), before);
        coordinator
            .accept_provider_event(ProviderEventEnvelope::new(
                op("single-reconcile-new-exit"),
                ProviderEvent::AgentExited { token: new_token, agent_id },
            ))
            .unwrap();
        assert!(coordinator.snapshot().workspaces()[0].agents().is_empty());
    }

    #[test]
    fn detach_is_idempotent_across_distinct_intents() {
        let mut coordinator = AppCoordinator::new();
        coordinator.subscribe();
        coordinator.dispatch_user(intent("detach-window", UserIntent::WindowClosed)).unwrap();
        let first_events = coordinator.subscribe().into_events();
        assert!(first_events.iter().any(|event| {
            matches!(
                event.event(),
                CoordinatorEvent::Effect(Effect::Detach(DetachReason::WindowClosed))
            )
        }));
        coordinator.dispatch_user(intent("detach-quit", UserIntent::Quit)).unwrap();
        let second_events = coordinator.subscribe().into_events();
        assert!(second_events.iter().any(|event| matches!(event.event(), CoordinatorEvent::Noop)));
        assert!(!second_events
            .iter()
            .any(|event| { matches!(event.event(), CoordinatorEvent::Effect(Effect::Detach(_))) }));
    }

    #[test]
    fn bounded_event_replay_reports_history_gap_with_current_snapshot_reset() {
        let mut coordinator = AppCoordinator::new();
        coordinator.subscribe();
        for index in 0..(MAX_RETAINED_EVENTS + 8) {
            let seed = format!("history-{index}");
            coordinator
                .dispatch_user(intent(&seed, UserIntent::SelectContext(NavigationContext::Global)))
                .unwrap();
        }
        let replay = coordinator.replay_from(0);
        assert!(replay.history_gap());
        assert!(!replay.events().is_empty());
        assert!(replay.events()[0].sequence() > 1);
        assert_eq!(replay.snapshot(), &coordinator.snapshot());
        assert_eq!(replay.cursor(), coordinator.subscribe_from(u64::MAX).cursor());
    }
}
