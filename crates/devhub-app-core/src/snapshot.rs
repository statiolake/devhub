//! Rust-owned application projection and navigation transitions.
//!
//! `AppModel` is the mutable owner used by the future coordinator. Callers
//! receive only immutable `AppSnapshot` values, which contain semantic
//! DevHub identities and never provider/editor surface IDs.

use std::collections::BTreeMap;

use super::domain::{
    Activity, Agent, AgentControlState, AgentId, AgentProfile, AgentProfileId, AgentRestoreRecord,
    AgentStatus, CloseInspection, DiagnosticCode, DisabledReason, DomainError, DomainErrorCode,
    NavigationContext, Repository, RepositoryId, RuntimeHealth, SurfaceKey, SurfaceResolution,
    Workspace, WorkspaceId, WorkspaceRoot, WorkspaceState, APP_SNAPSHOT_SCHEMA_VERSION,
};

/// The selected context/activity pair. Context and Activity remain separate:
/// selecting an Activity never changes the Navigation Context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavigationSelection {
    context: NavigationContext,
    activity: Activity,
}

impl NavigationSelection {
    pub(crate) const fn new(context: NavigationContext, activity: Activity) -> Self {
        Self { context, activity }
    }

    pub const fn context(&self) -> &NavigationContext {
        &self.context
    }

    pub const fn activity(&self) -> Activity {
        self.activity
    }
}

/// A fixed Activity projection for the currently selected Navigation Context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivitySnapshot {
    activity: Activity,
    resolution: SurfaceResolution,
}

impl ActivitySnapshot {
    pub const fn activity(&self) -> Activity {
        self.activity
    }

    pub const fn resolution(&self) -> &SurfaceResolution {
        &self.resolution
    }

    pub const fn is_enabled(&self) -> bool {
        matches!(self.resolution, SurfaceResolution::Enabled(_))
    }
}

/// Immutable sidebar projection of one Agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSnapshot {
    id: AgentId,
    workspace_id: WorkspaceId,
    profile_id: AgentProfileId,
    display_name: String,
    ordinal: u32,
    status: AgentStatus,
    runtime_health: RuntimeHealth,
    control_state: AgentControlState,
}

impl AgentSnapshot {
    pub fn id(&self) -> &AgentId {
        &self.id
    }

    pub fn workspace_id(&self) -> &WorkspaceId {
        &self.workspace_id
    }

    pub fn profile_id(&self) -> &AgentProfileId {
        &self.profile_id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub const fn ordinal(&self) -> u32 {
        self.ordinal
    }

    pub const fn status(&self) -> AgentStatus {
        self.status
    }

    pub const fn runtime_health(&self) -> RuntimeHealth {
        self.runtime_health
    }

    pub const fn control_state(&self) -> AgentControlState {
        self.control_state
    }

    pub const fn is_interactive(&self) -> bool {
        self.control_state.is_interactive()
    }

    pub const fn can_retry_stop(&self) -> bool {
        self.control_state.can_retry_stop()
    }
}

/// Stable collapsed Workspace status order: error > waiting > working > idle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceAggregateStatus {
    Idle,
    Working,
    Waiting,
    Error,
}

/// Immutable sidebar projection of one Workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSnapshot {
    id: WorkspaceId,
    label: String,
    root: WorkspaceRoot,
    selected_path: super::domain::DisplayPath,
    repository_id: Option<super::domain::RepositoryId>,
    state: WorkspaceState,
    aggregate_status: WorkspaceAggregateStatus,
    agents: Vec<AgentSnapshot>,
}

impl WorkspaceSnapshot {
    pub fn id(&self) -> &WorkspaceId {
        &self.id
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    pub fn selected_path(&self) -> &super::domain::DisplayPath {
        &self.selected_path
    }

    pub fn repository_id(&self) -> Option<&super::domain::RepositoryId> {
        self.repository_id.as_ref()
    }

    pub const fn state(&self) -> WorkspaceState {
        self.state
    }

    pub fn agents(&self) -> &[AgentSnapshot] {
        &self.agents
    }

    pub const fn aggregate_status(&self) -> WorkspaceAggregateStatus {
        self.aggregate_status
    }

    pub const fn can_create_agent(&self) -> bool {
        self.state.is_available()
    }
}

/// The sole UI projection owned by Rust. It is intentionally not a wire type;
/// R1.3 freezes the IPC representation at the coordinator seam.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppSnapshot {
    schema_version: u16,
    revision: u64,
    selection: NavigationSelection,
    activities: [ActivitySnapshot; 3],
    workspaces: Vec<WorkspaceSnapshot>,
}

impl AppSnapshot {
    pub const fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub const fn selection(&self) -> &NavigationSelection {
        &self.selection
    }

    pub const fn selected_context(&self) -> &NavigationContext {
        self.selection.context()
    }

    pub const fn active_activity(&self) -> Activity {
        self.selection.activity()
    }

    pub const fn activities(&self) -> &[ActivitySnapshot; 3] {
        &self.activities
    }

    pub fn activity(&self, activity: Activity) -> &ActivitySnapshot {
        self.activities
            .iter()
            .find(|candidate| candidate.activity() == activity)
            .expect("Activity::ALL contains every fixed Activity")
    }

    pub fn workspaces(&self) -> &[WorkspaceSnapshot] {
        &self.workspaces
    }
}

/// Pure application model. Runtime adapters and persistence are deliberately
/// outside this module; they pass values and intents through this seam.
#[derive(Debug, Clone)]
pub struct AppModel {
    workspaces: Vec<Workspace>,
    repositories: BTreeMap<RepositoryId, Repository>,
    selection: NavigationSelection,
    next_agent_ordinals: BTreeMap<(WorkspaceId, AgentProfileId), u32>,
    revision: u64,
}

impl Default for AppModel {
    fn default() -> Self {
        Self::new()
    }
}

impl AppModel {
    pub fn new() -> Self {
        Self {
            workspaces: Vec::new(),
            repositories: BTreeMap::new(),
            selection: NavigationSelection::new(NavigationContext::Global, Activity::Terminal),
            next_agent_ordinals: BTreeMap::new(),
            revision: 0,
        }
    }

    pub fn snapshot(&self) -> AppSnapshot {
        let activities = Activity::ALL.map(|activity| ActivitySnapshot {
            activity,
            resolution: self.resolve_surface(&self.selection.context, activity),
        });
        AppSnapshot {
            schema_version: APP_SNAPSHOT_SCHEMA_VERSION,
            revision: self.revision,
            selection: self.selection.clone(),
            activities,
            workspaces: self.workspace_snapshots(),
        }
    }

    pub fn selection(&self) -> &NavigationSelection {
        &self.selection
    }

    pub fn workspaces(&self) -> &[Workspace] {
        &self.workspaces
    }

    /// Registers a Repository identity for this live app aggregate. This is
    /// transient association state, not a persistent registered-root DB.
    pub fn register_repository(&mut self, repository: Repository) -> Result<(), DomainError> {
        if let Some(existing) = self.repositories.get(repository.id()) {
            if existing == &repository {
                return Ok(());
            }
            return Err(DomainError::new(DomainErrorCode::RepositoryIdentityConflict));
        }
        if self.repositories.values().any(|existing| {
            repository.aliases().iter().any(|remote| existing.matches_remote(remote))
        }) {
            return Err(DomainError::new(DomainErrorCode::RepositoryRemoteConflict));
        }
        self.repositories.insert(repository.id().clone(), repository);
        Ok(())
    }

    pub fn repository(&self, id: &RepositoryId) -> Option<&Repository> {
        self.repositories.get(id)
    }

    pub fn repositories(&self) -> impl Iterator<Item = &Repository> {
        self.repositories.values()
    }

    pub fn workspace(&self, id: &WorkspaceId) -> Option<&Workspace> {
        self.workspaces.iter().find(|workspace| workspace.id() == id)
    }

    /// Returns the owning Workspace for an Agent without exposing provider
    /// identity or allowing callers to mutate the aggregate behind the
    /// coordinator seam.
    pub fn workspace_for_agent(&self, agent_id: &AgentId) -> Option<&Workspace> {
        self.workspaces.iter().find(|workspace| workspace.agent(agent_id).is_some())
    }

    pub(crate) fn workspace_mut(&mut self, id: &WorkspaceId) -> Option<&mut Workspace> {
        self.workspaces.iter_mut().find(|workspace| workspace.id() == id)
    }

    pub fn add_workspace(&mut self, workspace: Workspace) -> Result<(), DomainError> {
        if self.workspace(workspace.id()).is_some() {
            return Err(DomainError::new(DomainErrorCode::DuplicateWorkspace));
        }
        if self.workspaces.iter().any(|candidate| candidate.root() == workspace.root()) {
            return Err(DomainError::new(DomainErrorCode::DuplicateWorkspaceRoot));
        }
        if let Some(repository_id) = workspace.repository_id() {
            if !self.repositories.contains_key(repository_id) {
                return Err(DomainError::new(DomainErrorCode::UnknownRepository));
            }
        }
        self.workspaces.push(workspace);
        self.bump_revision();
        Ok(())
    }

    pub fn associate_repository(
        &mut self,
        workspace_id: &WorkspaceId,
        repository_id: Option<RepositoryId>,
    ) -> Result<(), DomainError> {
        if let Some(repository_id) = repository_id.as_ref() {
            if !self.repositories.contains_key(repository_id) {
                return Err(DomainError::new(DomainErrorCode::UnknownRepository));
            }
        }
        let changed = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?
            .set_repository_id(repository_id);
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    /// Creates and selects an Agent in one atomic pure transition. The caller
    /// supplies the opaque AgentId; ID generation remains outside the domain.
    pub fn add_agent(
        &mut self,
        workspace_id: &WorkspaceId,
        agent_id: AgentId,
        profile: AgentProfile,
    ) -> Result<(), DomainError> {
        if self.workspaces.iter().flat_map(Workspace::agents).any(|agent| agent.id() == &agent_id) {
            return Err(DomainError::new(DomainErrorCode::DuplicateAgent));
        }
        let ordinal_key = (workspace_id.clone(), profile.id().clone());
        let ordinal = self.next_agent_ordinals.get(&ordinal_key).copied().unwrap_or(1);
        if ordinal == u32::MAX {
            return Err(DomainError::new(DomainErrorCode::OrdinalExhausted));
        }
        let agent = Agent::new(agent_id, workspace_id.clone(), profile, ordinal)?;
        let created_id = {
            let workspace = self
                .workspace_mut(workspace_id)
                .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?;
            workspace.add_agent(agent)?;
            workspace.agents().last().expect("newly-added agent exists").id().clone()
        };
        self.next_agent_ordinals.insert(ordinal_key, ordinal + 1);
        self.selection =
            NavigationSelection::new(NavigationContext::Agent(created_id), Activity::Agent);
        self.bump_revision();
        Ok(())
    }

    /// Restores an already-running Agent with its persisted ordinal. This
    /// keeps ordinal gaps and prevents names from being reused after a natural
    /// exit or a process restart.
    pub fn restore_agent(&mut self, record: AgentRestoreRecord) -> Result<(), DomainError> {
        let workspace_id = record.workspace_id().clone();
        if self.workspace(&workspace_id).is_none() {
            return Err(DomainError::new(DomainErrorCode::UnknownWorkspace));
        }
        let agent_id = record.id().clone();
        if self.agent(&agent_id).is_some() {
            return Err(DomainError::new(DomainErrorCode::DuplicateAgent));
        }
        let agent = Agent::restore(record)?;
        if agent.workspace_id() != &workspace_id {
            return Err(DomainError::new(DomainErrorCode::AgentWorkspaceMismatch));
        }
        if agent.ordinal() == u32::MAX {
            return Err(DomainError::new(DomainErrorCode::OrdinalExhausted));
        }
        let key = (workspace_id.clone(), agent.profile().id().clone());
        let next = agent.ordinal() + 1;
        {
            let workspace = self
                .workspace_mut(&workspace_id)
                .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?;
            workspace.restore_agent(agent)?;
        }
        self.next_agent_ordinals
            .entry(key)
            .and_modify(|current| *current = (*current).max(next))
            .or_insert(next);
        self.bump_revision();
        Ok(())
    }

    pub fn rename_agent(
        &mut self,
        agent_id: &AgentId,
        display_name: impl Into<String>,
    ) -> Result<(), DomainError> {
        let changed = self
            .agent_mut(agent_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))?
            .rename(display_name)?;
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn reset_agent_name(&mut self, agent_id: &AgentId) -> Result<(), DomainError> {
        let changed = self
            .agent_mut(agent_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))?
            .reset_name();
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn set_agent_status(
        &mut self,
        agent_id: &AgentId,
        status: AgentStatus,
    ) -> Result<(), DomainError> {
        let changed = self
            .agent_mut(agent_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))?
            .set_status(status);
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn set_agent_runtime_health(
        &mut self,
        agent_id: &AgentId,
        health: RuntimeHealth,
    ) -> Result<(), DomainError> {
        let changed = self
            .agent_mut(agent_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))?
            .set_runtime_health(health);
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    /// Applies a complete provider reconciliation only after every referenced
    /// Agent identity has been validated. This keeps a malformed aggregate
    /// from partially mutating the sole application model owner.
    pub fn reconcile_agents(
        &mut self,
        reconciliation: &super::domain::AgentReconciliation,
    ) -> Result<(), DomainError> {
        for observation in reconciliation.observations() {
            if self.agent(observation.agent_id()).is_none() {
                return Err(DomainError::new(DomainErrorCode::UnknownAgent));
            }
        }
        let exited =
            reconciliation.exited().iter().cloned().collect::<std::collections::BTreeSet<_>>();
        for agent_id in &exited {
            if self.agent(agent_id).is_none() {
                return Err(DomainError::new(DomainErrorCode::UnknownAgent));
            }
        }

        for observation in reconciliation.observations() {
            if exited.contains(observation.agent_id()) {
                continue;
            }
            self.set_agent_status(observation.agent_id(), observation.status())?;
            self.set_agent_runtime_health(observation.agent_id(), observation.runtime_health())?;
        }
        for agent_id in exited {
            self.agent_exited(&agent_id)?;
        }
        Ok(())
    }

    pub fn request_agent_stop(&mut self, agent_id: &AgentId) -> Result<(), DomainError> {
        let changed = self
            .agent_mut(agent_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))?
            .request_stop();
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn retry_agent_stop(&mut self, agent_id: &AgentId) -> Result<(), DomainError> {
        let agent = self
            .agent_mut(agent_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))?;
        if matches!(agent.control_state(), AgentControlState::Stopping) {
            return Ok(());
        }
        if !agent.can_retry_stop() {
            return Err(DomainError::new(DomainErrorCode::InvalidAgentControlTransition));
        }
        if agent.request_stop() {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn mark_agent_stop_failed(
        &mut self,
        agent_id: &AgentId,
        diagnostic: DiagnosticCode,
    ) -> Result<(), DomainError> {
        let changed = self
            .agent_mut(agent_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))?
            .mark_stop_failed(diagnostic)?;
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn return_agent_to_running(&mut self, agent_id: &AgentId) -> Result<(), DomainError> {
        let changed = self
            .agent_mut(agent_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))?
            .return_to_running();
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    /// Selecting a context also selects its canonical initial Activity:
    /// Global/Scratch -> Terminal, Workspace -> Editor, Agent -> Agent.
    pub fn select_context(&mut self, context: NavigationContext) -> Result<(), DomainError> {
        self.ensure_context_exists(&context)?;
        let activity = match context {
            NavigationContext::Global => Activity::Terminal,
            NavigationContext::Workspace(_) => Activity::Editor,
            NavigationContext::Agent(_) => Activity::Agent,
        };
        let next = NavigationSelection::new(context, activity);
        if self.selection != next {
            self.selection = next;
            self.bump_revision();
        }
        Ok(())
    }

    pub fn select_activity(&mut self, activity: Activity) -> Result<(), DomainError> {
        if !matches!(
            self.resolve_surface(&self.selection.context, activity),
            SurfaceResolution::Enabled(_)
        ) {
            return Err(DomainError::new(DomainErrorCode::ActivityDisabled));
        }
        if self.selection.activity != activity {
            self.selection.activity = activity;
            self.bump_revision();
        }
        Ok(())
    }

    pub fn resolve_surface(
        &self,
        context: &NavigationContext,
        activity: Activity,
    ) -> SurfaceResolution {
        match context {
            NavigationContext::Global => match activity {
                Activity::Editor => SurfaceResolution::Enabled(SurfaceKey::GlobalEditor),
                Activity::Terminal => SurfaceResolution::Enabled(SurfaceKey::GlobalTerminal),
                Activity::Agent => {
                    SurfaceResolution::Disabled(DisabledReason::GlobalAgentNotApplicable)
                }
            },
            NavigationContext::Workspace(id) => {
                let Some(workspace) = self.workspace(id) else {
                    return SurfaceResolution::Disabled(DisabledReason::WorkspaceUnavailable);
                };
                match (workspace.state(), activity) {
                    (WorkspaceState::Available, Activity::Editor) => {
                        SurfaceResolution::Enabled(SurfaceKey::WorkspaceEditor(id.clone()))
                    }
                    (WorkspaceState::Available, Activity::Terminal) => {
                        SurfaceResolution::Enabled(SurfaceKey::WorkspaceTerminal(id.clone()))
                    }
                    (WorkspaceState::Available, Activity::Agent) => SurfaceResolution::Disabled(
                        DisabledReason::WorkspaceAgentRequiresAgentSelection,
                    ),
                    (WorkspaceState::Unavailable { .. }, Activity::Agent)
                    | (WorkspaceState::ClosingFailed { .. }, Activity::Agent) => {
                        SurfaceResolution::Disabled(
                            DisabledReason::WorkspaceAgentRequiresAgentSelection,
                        )
                    }
                    (WorkspaceState::Closing { .. }, Activity::Agent) => {
                        SurfaceResolution::Disabled(
                            DisabledReason::WorkspaceAgentRequiresAgentSelection,
                        )
                    }
                    (WorkspaceState::Unavailable { .. }, _) => {
                        SurfaceResolution::Disabled(DisabledReason::WorkspaceUnavailable)
                    }
                    (WorkspaceState::Closing { .. }, _) => {
                        SurfaceResolution::Disabled(DisabledReason::WorkspaceClosing)
                    }
                    (WorkspaceState::ClosingFailed { .. }, _) => {
                        SurfaceResolution::Disabled(DisabledReason::WorkspaceClosingFailed)
                    }
                }
            }
            NavigationContext::Agent(agent_id) => {
                let Some(agent) = self.agent(agent_id) else {
                    return SurfaceResolution::Disabled(DisabledReason::WorkspaceUnavailable);
                };
                let Some(workspace) = self.workspace(agent.workspace_id()) else {
                    return SurfaceResolution::Disabled(DisabledReason::WorkspaceUnavailable);
                };
                match (workspace.state(), activity) {
                    (_, Activity::Agent) => {
                        SurfaceResolution::Enabled(SurfaceKey::Agent(agent_id.clone()))
                    }
                    (WorkspaceState::Available, Activity::Editor) => SurfaceResolution::Enabled(
                        SurfaceKey::WorkspaceEditor(agent.workspace_id().clone()),
                    ),
                    (WorkspaceState::Available, Activity::Terminal) => SurfaceResolution::Enabled(
                        SurfaceKey::WorkspaceTerminal(agent.workspace_id().clone()),
                    ),
                    (WorkspaceState::Closing { .. }, _) => {
                        SurfaceResolution::Disabled(DisabledReason::WorkspaceClosing)
                    }
                    (WorkspaceState::Unavailable { .. }, _) => {
                        SurfaceResolution::Disabled(DisabledReason::WorkspaceUnavailable)
                    }
                    (WorkspaceState::ClosingFailed { .. }, _) => {
                        SurfaceResolution::Disabled(DisabledReason::WorkspaceClosingFailed)
                    }
                }
            }
        }
    }

    /// Removes a naturally exited Agent. If it was selected, select the next
    /// sibling without wrapping; if none exists, select its Workspace Editor.
    pub fn agent_exited(&mut self, agent_id: &AgentId) -> Result<(), DomainError> {
        let (workspace_index, agent_index) = self.find_agent_position(agent_id)?;
        let workspace_id = self.workspaces[workspace_index].id().clone();
        let next_agent = self.workspaces[workspace_index]
            .agents()
            .get(agent_index + 1)
            .map(|agent| agent.id().clone());
        self.workspaces[workspace_index].remove_agent(agent_id).expect("agent position was found");

        if self.selection.context == NavigationContext::Agent(agent_id.clone()) {
            self.selection = match next_agent {
                Some(next) => {
                    NavigationSelection::new(NavigationContext::Agent(next), Activity::Agent)
                }
                None => NavigationSelection::new(
                    NavigationContext::Workspace(workspace_id),
                    Activity::Editor,
                ),
            };
        }
        self.bump_revision();
        Ok(())
    }

    /// Closes a Workspace only after the caller supplies a clean consolidated
    /// inspection. Busy and unknown inspections leave the model untouched.
    pub fn close_workspace(
        &mut self,
        workspace_id: &WorkspaceId,
        inspection: CloseInspection,
    ) -> Result<(), DomainError> {
        if !inspection.is_clean() {
            return Err(DomainError::new(DomainErrorCode::WorkspaceNotClean));
        }
        let index = self
            .workspaces
            .iter()
            .position(|workspace| workspace.id() == workspace_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?;
        if !self.workspaces[index].agents().is_empty() {
            return Err(DomainError::new(DomainErrorCode::WorkspaceHasLiveAgents));
        }
        let next = self.workspaces.get(index + 1).map(|workspace| workspace.id().clone());
        let previous = index
            .checked_sub(1)
            .and_then(|position| self.workspaces.get(position))
            .map(|workspace| workspace.id().clone());
        let owns_selection = match &self.selection.context {
            NavigationContext::Workspace(id) => id == workspace_id,
            NavigationContext::Agent(agent_id) => self
                .agent(agent_id)
                .map(|agent| agent.workspace_id() == workspace_id)
                .unwrap_or(false),
            NavigationContext::Global => false,
        };
        self.workspaces.remove(index);
        if owns_selection {
            self.selection = match next.or(previous) {
                Some(next_workspace) => NavigationSelection::new(
                    NavigationContext::Workspace(next_workspace),
                    Activity::Editor,
                ),
                None => NavigationSelection::new(NavigationContext::Global, Activity::Terminal),
            };
        }
        self.bump_revision();
        Ok(())
    }

    /// Locate an unavailable Workspace without changing its identity. The
    /// duplicate-root check runs before mutation, so a rejected locate is
    /// atomic and preserves the old root and live Agents.
    pub fn relocate_workspace(
        &mut self,
        workspace_id: &WorkspaceId,
        root: WorkspaceRoot,
        selected_path: super::domain::DisplayPath,
    ) -> Result<(), DomainError> {
        let index = self
            .workspaces
            .iter()
            .position(|workspace| workspace.id() == workspace_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?;
        if !matches!(self.workspaces[index].state(), WorkspaceState::Unavailable { .. }) {
            return Err(DomainError::new(DomainErrorCode::WorkspaceNotUnavailable));
        }
        if self.workspaces.iter().enumerate().any(|(candidate_index, candidate)| {
            candidate_index != index && candidate.root() == &root
        }) {
            return Err(DomainError::new(DomainErrorCode::DuplicateWorkspaceRoot));
        }
        if self.workspaces[index].root() == &root
            && self.workspaces[index].selected_path() == &selected_path
        {
            if self.workspaces[index].mark_available() {
                self.bump_revision();
            }
            return Ok(());
        }
        self.workspaces[index].relocate(root, selected_path);
        self.bump_revision();
        Ok(())
    }

    pub fn mark_workspace_unavailable(
        &mut self,
        workspace_id: &WorkspaceId,
        reason: DiagnosticCode,
    ) -> Result<(), DomainError> {
        let changed = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?
            .mark_unavailable(reason);
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn mark_workspace_available(
        &mut self,
        workspace_id: &WorkspaceId,
    ) -> Result<(), DomainError> {
        let changed = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?
            .mark_available();
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn mark_workspace_closing_failed(
        &mut self,
        workspace_id: &WorkspaceId,
        diagnostic: DiagnosticCode,
        progress: super::domain::CleanupProgress,
    ) -> Result<(), DomainError> {
        let changed = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?
            .mark_closing_failed(diagnostic, progress);
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    /// Atomically enters the active Workspace close state before the
    /// coordinator emits its first destructive cleanup effect. Creation and
    /// other transitions are rejected while the state is `Closing`.
    pub fn mark_workspace_closing(
        &mut self,
        workspace_id: &WorkspaceId,
        progress: super::domain::CleanupProgress,
    ) -> Result<(), DomainError> {
        let changed = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?
            .mark_closing(progress)?;
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    pub fn update_workspace_closing_progress(
        &mut self,
        workspace_id: &WorkspaceId,
        progress: super::domain::CleanupProgress,
    ) -> Result<(), DomainError> {
        let changed = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace))?
            .update_closing_progress(progress)?;
        if changed {
            self.bump_revision();
        }
        Ok(())
    }

    fn ensure_context_exists(&self, context: &NavigationContext) -> Result<(), DomainError> {
        match context {
            NavigationContext::Global => Ok(()),
            NavigationContext::Workspace(id) => self
                .workspace(id)
                .map(|_| ())
                .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownWorkspace)),
            NavigationContext::Agent(id) => self
                .agent(id)
                .map(|_| ())
                .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent)),
        }
    }

    fn agent(&self, id: &AgentId) -> Option<&Agent> {
        self.workspaces.iter().find_map(|workspace| workspace.agent(id))
    }

    fn agent_mut(&mut self, id: &AgentId) -> Option<&mut Agent> {
        self.workspaces.iter_mut().find_map(|workspace| workspace.agent_mut(id))
    }

    fn find_agent_position(&self, id: &AgentId) -> Result<(usize, usize), DomainError> {
        self.workspaces
            .iter()
            .enumerate()
            .find_map(|(workspace_index, workspace)| {
                workspace
                    .agents()
                    .iter()
                    .position(|agent| agent.id() == id)
                    .map(|agent_index| (workspace_index, agent_index))
            })
            .ok_or_else(|| DomainError::new(DomainErrorCode::UnknownAgent))
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    fn workspace_snapshots(&self) -> Vec<WorkspaceSnapshot> {
        self.workspaces
            .iter()
            .map(|workspace| WorkspaceSnapshot {
                id: workspace.id().clone(),
                label: self.label_for(workspace),
                root: workspace.root().clone(),
                selected_path: workspace.selected_path().clone(),
                repository_id: workspace.repository_id().cloned(),
                state: workspace.state(),
                aggregate_status: aggregate_status(workspace),
                agents: workspace
                    .agents()
                    .iter()
                    .map(|agent| AgentSnapshot {
                        id: agent.id().clone(),
                        workspace_id: agent.workspace_id().clone(),
                        profile_id: agent.profile().id().clone(),
                        display_name: agent.display_name(),
                        ordinal: agent.ordinal(),
                        status: agent.status(),
                        runtime_health: agent.runtime_health(),
                        control_state: agent.control_state(),
                    })
                    .collect(),
            })
            .collect()
    }

    fn label_for(&self, workspace: &Workspace) -> String {
        let basename = workspace.root().basename();
        let collisions = self
            .workspaces
            .iter()
            .filter(|candidate| candidate.root().basename() == basename)
            .collect::<Vec<_>>();
        if collisions.len() == 1 {
            return basename;
        }

        let parents = workspace.root().parent_components();
        for depth in 1..=parents.len() {
            let suffix = parents[..depth].join("/");
            let matching = collisions
                .iter()
                .filter(|candidate| {
                    let candidate_parents = candidate.root().parent_components();
                    candidate_parents.get(..depth).map(|parts| parts.join("/"))
                        == Some(suffix.clone())
                })
                .count();
            let unique = matching == 1;
            if unique {
                let display_suffix =
                    parents[..depth].iter().rev().cloned().collect::<Vec<_>>().join("/");
                return format!("{basename} — {display_suffix}");
            }
        }
        format!("{basename} — {}", workspace.root().as_path().display())
    }
}

fn aggregate_status(workspace: &Workspace) -> WorkspaceAggregateStatus {
    if workspace.agents().iter().any(|agent| agent.status() == AgentStatus::Error) {
        WorkspaceAggregateStatus::Error
    } else if workspace.agents().iter().any(|agent| agent.status() == AgentStatus::Waiting) {
        WorkspaceAggregateStatus::Waiting
    } else if workspace.agents().iter().any(|agent| agent.status() == AgentStatus::Working) {
        WorkspaceAggregateStatus::Working
    } else {
        WorkspaceAggregateStatus::Idle
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::domain::{AgentProfileKind, DisplayPath, RemoteIdentity, WorkspaceRoot};

    fn workspace(id: &str, path: &str) -> Workspace {
        Workspace::new(
            WorkspaceId::for_test(id),
            WorkspaceRoot::new(path).unwrap(),
            DisplayPath::new(path).unwrap(),
            None,
        )
    }

    fn profile(id: &str, display: &str) -> AgentProfile {
        AgentProfile::new(
            AgentProfileId::for_test(id),
            display,
            AgentProfileKind::Codex,
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap()
    }

    fn repository(id: &str, remote: &str) -> Repository {
        Repository::new(RepositoryId::for_test(id), RemoteIdentity::normalize(remote).unwrap(), [])
    }

    fn model_with_workspace() -> (AppModel, WorkspaceId) {
        let mut model = AppModel::new();
        let id = WorkspaceId::for_test("workspace-a");
        model.add_workspace(workspace("workspace-a", "/dev/a")).unwrap();
        (model, id)
    }

    #[test]
    fn global_navigation_matrix_and_default_are_exact() {
        let model = AppModel::new();
        let snapshot = model.snapshot();
        assert_eq!(snapshot.selected_context(), &NavigationContext::Global);
        assert_eq!(snapshot.active_activity(), Activity::Terminal);
        assert_eq!(
            snapshot.activity(Activity::Editor).resolution(),
            &SurfaceResolution::Enabled(SurfaceKey::GlobalEditor)
        );
        assert_eq!(
            snapshot.activity(Activity::Terminal).resolution(),
            &SurfaceResolution::Enabled(SurfaceKey::GlobalTerminal)
        );
        assert_eq!(
            snapshot.activity(Activity::Agent).resolution(),
            &SurfaceResolution::Disabled(DisabledReason::GlobalAgentNotApplicable)
        );
    }

    #[test]
    fn selecting_workspace_resolves_editor_and_agent_resolves_agent() {
        let (mut model, workspace_id) = model_with_workspace();
        model.select_context(NavigationContext::Workspace(workspace_id.clone())).unwrap();
        assert_eq!(model.snapshot().active_activity(), Activity::Editor);
        assert_eq!(
            model.snapshot().activity(Activity::Editor).resolution(),
            &SurfaceResolution::Enabled(SurfaceKey::WorkspaceEditor(workspace_id.clone()))
        );
        assert_eq!(
            model.snapshot().activity(Activity::Agent).resolution(),
            &SurfaceResolution::Disabled(DisabledReason::WorkspaceAgentRequiresAgentSelection)
        );
        model
            .add_agent(&workspace_id, AgentId::for_test("agent-a"), profile("codex", "Codex"))
            .unwrap();
        assert_eq!(
            model.snapshot().selected_context(),
            &NavigationContext::Agent(AgentId::for_test("agent-a"))
        );
        assert_eq!(model.snapshot().active_activity(), Activity::Agent);
    }

    #[test]
    fn agent_context_shares_workspace_editor_and_terminal_surfaces() {
        let (mut model, workspace_id) = model_with_workspace();
        model
            .add_agent(&workspace_id, AgentId::for_test("agent-a"), profile("codex", "Codex"))
            .unwrap();
        let snapshot = model.snapshot();
        assert_eq!(
            snapshot.activity(Activity::Editor).resolution(),
            &SurfaceResolution::Enabled(SurfaceKey::WorkspaceEditor(workspace_id.clone()))
        );
        assert_eq!(
            snapshot.activity(Activity::Terminal).resolution(),
            &SurfaceResolution::Enabled(SurfaceKey::WorkspaceTerminal(workspace_id))
        );
        assert_eq!(
            snapshot.activity(Activity::Agent).resolution(),
            &SurfaceResolution::Enabled(SurfaceKey::Agent(AgentId::for_test("agent-a")))
        );
    }

    #[test]
    fn activity_change_preserves_context_and_rejects_disabled_activity() {
        let (mut model, workspace_id) = model_with_workspace();
        model.select_context(NavigationContext::Workspace(workspace_id.clone())).unwrap();
        model.select_activity(Activity::Terminal).unwrap();
        assert_eq!(model.selection().context(), &NavigationContext::Workspace(workspace_id));
        let error = model
            .select_activity(Activity::Agent)
            .expect_err("workspace Agent activity is disabled");
        assert_eq!(error.code(), DomainErrorCode::ActivityDisabled);
    }

    #[test]
    fn no_agent_workspace_has_no_fake_child_and_sidebar_order_is_stable() {
        let mut model = AppModel::new();
        model.add_workspace(workspace("first", "/one/project")).unwrap();
        model.add_workspace(workspace("second", "/two/project")).unwrap();
        let snapshot = model.snapshot();
        assert_eq!(snapshot.workspaces().len(), 2);
        assert_eq!(snapshot.workspaces()[0].label(), "project — one");
        assert_eq!(snapshot.workspaces()[1].label(), "project — two");
        assert!(snapshot.workspaces().iter().all(|workspace| workspace.agents().is_empty()));
    }

    #[test]
    fn colliding_parent_suffixes_use_shortest_natural_path_order() {
        let mut model = AppModel::new();
        model.add_workspace(workspace("first", "/a/common/project")).unwrap();
        model.add_workspace(workspace("second", "/b/common/project")).unwrap();
        let snapshot = model.snapshot();
        assert_eq!(snapshot.workspaces()[0].label(), "project — a/common");
        assert_eq!(snapshot.workspaces()[1].label(), "project — b/common");
    }

    #[test]
    fn agent_exit_selects_next_sibling_without_wrap_then_workspace_editor() {
        let (mut model, workspace_id) = model_with_workspace();
        model
            .add_agent(&workspace_id, AgentId::for_test("agent-a"), profile("codex", "Codex"))
            .unwrap();
        model
            .add_agent(&workspace_id, AgentId::for_test("agent-b"), profile("codex", "Codex"))
            .unwrap();
        model.agent_exited(&AgentId::for_test("agent-a")).unwrap();
        assert_eq!(
            model.selection().context(),
            &NavigationContext::Agent(AgentId::for_test("agent-b"))
        );
        model.agent_exited(&AgentId::for_test("agent-b")).unwrap();
        assert_eq!(
            model.selection(),
            &NavigationSelection::new(NavigationContext::Workspace(workspace_id), Activity::Editor)
        );
    }

    #[test]
    fn closing_workspace_uses_next_then_previous_then_global_without_wrap() {
        let mut model = AppModel::new();
        let first = WorkspaceId::for_test("first");
        let second = WorkspaceId::for_test("second");
        let third = WorkspaceId::for_test("third");
        model.add_workspace(workspace("first", "/dev/first")).unwrap();
        model.add_workspace(workspace("second", "/dev/second")).unwrap();
        model.add_workspace(workspace("third", "/dev/third")).unwrap();
        model.select_context(NavigationContext::Workspace(second.clone())).unwrap();
        model.close_workspace(&second, CloseInspection::Clean).unwrap();
        assert_eq!(model.selection().context(), &NavigationContext::Workspace(third.clone()));
        model.close_workspace(&third, CloseInspection::Clean).unwrap();
        assert_eq!(model.selection().context(), &NavigationContext::Workspace(first.clone()));
        model.close_workspace(&first, CloseInspection::Clean).unwrap();
        assert_eq!(
            model.selection(),
            &NavigationSelection::new(NavigationContext::Global, Activity::Terminal)
        );
    }

    #[test]
    fn mixed_close_inspection_is_not_allowed_and_preserves_agents() {
        let (mut model, workspace_id) = model_with_workspace();
        let agent_id = AgentId::for_test("agent-a");
        model.add_agent(&workspace_id, agent_id.clone(), profile("codex", "Codex")).unwrap();
        let inspection = CloseInspection::consolidate(crate::domain::CloseInspectionInputs::new(
            crate::domain::ResourceInspection::busy(1).unwrap(),
            crate::domain::ResourceInspection::clean(),
            crate::domain::ResourceInspection::clean(),
            crate::domain::ResourceInspection::clean(),
            crate::domain::ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
        ));
        assert!(!inspection.is_clean());
        assert_eq!(inspection.busy_reasons().expect("busy reasons").agents(), 1);
        assert_eq!(inspection.unknown_diagnostics(), &[DiagnosticCode::CloseTerminalUnknown]);
        assert_eq!(
            model.close_workspace(&workspace_id, inspection).unwrap_err().code(),
            DomainErrorCode::WorkspaceNotClean
        );
        let snapshot = model.snapshot();
        assert_eq!(snapshot.workspaces().len(), 1);
        assert_eq!(snapshot.workspaces()[0].agents()[0].id(), &agent_id);
    }

    #[test]
    fn clean_close_rejects_live_agents_without_mutation_until_reconciled() {
        let (mut model, workspace_id) = model_with_workspace();
        let agent_id = AgentId::for_test("agent-a");
        model.add_agent(&workspace_id, agent_id.clone(), profile("codex", "Codex")).unwrap();
        let before = model.snapshot();
        assert_eq!(
            model.close_workspace(&workspace_id, CloseInspection::Clean).unwrap_err().code(),
            DomainErrorCode::WorkspaceHasLiveAgents
        );
        let after_rejection = model.snapshot();
        assert_eq!(after_rejection.revision(), before.revision());
        assert_eq!(after_rejection.workspaces()[0].agents()[0].id(), &agent_id);

        model.agent_exited(&agent_id).unwrap();
        model.close_workspace(&workspace_id, CloseInspection::Clean).unwrap();
        assert!(model.snapshot().workspaces().is_empty());
    }

    #[test]
    fn unavailable_workspace_disables_owned_editor_and_terminal_but_keeps_agent_surface() {
        let (mut model, workspace_id) = model_with_workspace();
        let agent_id = AgentId::for_test("agent-a");
        model.add_agent(&workspace_id, agent_id.clone(), profile("codex", "Codex")).unwrap();
        model.mark_workspace_unavailable(&workspace_id, DiagnosticCode::RootMissing).unwrap();
        let snapshot = model.snapshot();
        assert_eq!(
            snapshot.activity(Activity::Editor).resolution(),
            &SurfaceResolution::Disabled(DisabledReason::WorkspaceUnavailable)
        );
        assert_eq!(
            snapshot.activity(Activity::Terminal).resolution(),
            &SurfaceResolution::Disabled(DisabledReason::WorkspaceUnavailable)
        );
        assert_eq!(
            snapshot.activity(Activity::Agent).resolution(),
            &SurfaceResolution::Enabled(SurfaceKey::Agent(agent_id))
        );
        assert_eq!(snapshot.workspaces()[0].agents().len(), 1);
        assert!(!snapshot.workspaces()[0].can_create_agent());
    }

    #[test]
    fn collapsed_workspace_status_uses_error_waiting_working_idle_priority() {
        let (mut model, workspace_id) = model_with_workspace();
        model
            .add_agent(&workspace_id, AgentId::for_test("agent-a"), profile("codex", "Codex"))
            .unwrap();
        model
            .add_agent(&workspace_id, AgentId::for_test("agent-b"), profile("codex", "Codex"))
            .unwrap();
        {
            let workspace = model.workspace_mut(&workspace_id).unwrap();
            workspace
                .agent_mut(&AgentId::for_test("agent-a"))
                .unwrap()
                .set_status(AgentStatus::Working);
            workspace
                .agent_mut(&AgentId::for_test("agent-b"))
                .unwrap()
                .set_status(AgentStatus::Waiting);
        }
        assert_eq!(
            model.snapshot().workspaces()[0].aggregate_status(),
            WorkspaceAggregateStatus::Waiting
        );
        model
            .workspace_mut(&workspace_id)
            .unwrap()
            .agent_mut(&AgentId::for_test("agent-b"))
            .unwrap()
            .set_status(AgentStatus::Error);
        assert_eq!(
            model.snapshot().workspaces()[0].aggregate_status(),
            WorkspaceAggregateStatus::Error
        );
    }

    #[test]
    fn snapshot_is_versioned_immutable_and_duplicate_roots_are_rejected() {
        let (mut model, _) = model_with_workspace();
        let first = model.snapshot();
        assert_eq!(first.schema_version(), APP_SNAPSHOT_SCHEMA_VERSION);
        model.add_workspace(workspace("second", "/dev/second")).unwrap();
        assert_eq!(first.workspaces().len(), 1);
        assert_eq!(model.snapshot().revision(), first.revision() + 1);
        let duplicate = model.add_workspace(workspace("third", "/dev/a")).unwrap_err();
        assert_eq!(duplicate.code(), DomainErrorCode::DuplicateWorkspaceRoot);
        let duplicate_id = model.add_workspace(workspace("workspace-a", "/dev/other")).unwrap_err();
        assert_eq!(duplicate_id.code(), DomainErrorCode::DuplicateWorkspace);
    }

    #[test]
    fn closing_failed_state_is_projected_and_agent_creation_is_disabled() {
        let (mut model, workspace_id) = model_with_workspace();
        model.select_context(NavigationContext::Workspace(workspace_id.clone())).unwrap();
        model
            .mark_workspace_closing_failed(
                &workspace_id,
                DiagnosticCode::CleanupFailed,
                crate::domain::CleanupProgress::new(1, false, false),
            )
            .unwrap();
        let snapshot = model.snapshot();
        assert!(matches!(snapshot.workspaces()[0].state(), WorkspaceState::ClosingFailed { .. }));
        assert!(!snapshot.workspaces()[0].can_create_agent());
        assert_eq!(
            snapshot.activity(Activity::Editor).resolution(),
            &SurfaceResolution::Disabled(DisabledReason::WorkspaceClosingFailed)
        );
    }

    #[test]
    fn closing_state_is_projected_before_cleanup_and_rejects_agent_creation() {
        let (mut model, workspace_id) = model_with_workspace();
        model.select_context(NavigationContext::Workspace(workspace_id.clone())).unwrap();
        let progress = crate::domain::CleanupProgress::new(0, false, false);
        model.mark_workspace_closing(&workspace_id, progress).unwrap();
        let snapshot = model.snapshot();
        assert!(matches!(snapshot.workspaces()[0].state(), WorkspaceState::Closing { .. }));
        assert!(!snapshot.workspaces()[0].can_create_agent());
        assert_eq!(
            snapshot.activity(Activity::Editor).resolution(),
            &SurfaceResolution::Disabled(DisabledReason::WorkspaceClosing)
        );
        let rejected = model
            .add_agent(&workspace_id, AgentId::for_test("late-agent"), profile("codex", "Codex"))
            .unwrap_err();
        assert_eq!(rejected.code(), DomainErrorCode::WorkspaceUnavailable);
        assert_eq!(model.snapshot().revision(), snapshot.revision());
    }

    #[test]
    fn locate_preserves_workspace_identity_and_agents_and_rejects_root_collisions_atomically() {
        let (mut model, workspace_id) = model_with_workspace();
        model
            .add_agent(&workspace_id, AgentId::for_test("agent-a"), profile("codex", "Codex"))
            .unwrap();
        model.mark_workspace_unavailable(&workspace_id, DiagnosticCode::RootMissing).unwrap();
        model.add_workspace(workspace("other", "/dev/other")).unwrap();
        let before = model.snapshot();
        let collision = model
            .relocate_workspace(
                &workspace_id,
                WorkspaceRoot::new("/dev/other").unwrap(),
                DisplayPath::new("/dev/other").unwrap(),
            )
            .unwrap_err();
        assert_eq!(collision.code(), DomainErrorCode::DuplicateWorkspaceRoot);
        assert_eq!(model.snapshot().workspaces()[0].root(), before.workspaces()[0].root());
        model
            .relocate_workspace(
                &workspace_id,
                WorkspaceRoot::new("/dev/recovered").unwrap(),
                DisplayPath::new("/dev/recovered").unwrap(),
            )
            .unwrap();
        let recovered = model.snapshot();
        assert_eq!(recovered.workspaces()[0].id(), &workspace_id);
        assert_eq!(recovered.workspaces()[0].agents().len(), 1);
        assert!(recovered.workspaces()[0].state().is_available());
    }

    #[test]
    fn restored_agent_ordinal_seeds_future_names_without_reuse() {
        let (mut model, workspace_id) = model_with_workspace();
        let restored = AgentRestoreRecord::new(
            AgentId::for_test("restored"),
            workspace_id.clone(),
            profile("codex", "Codex"),
            4,
            Some("Recovered Codex".to_owned()),
            AgentStatus::Waiting,
            RuntimeHealth::Healthy,
            AgentControlState::StopFailed { diagnostic: DiagnosticCode::CleanupFailed },
        )
        .unwrap();
        model.restore_agent(restored).unwrap();
        let restored_projection = model.snapshot();
        let restored_snapshot = &restored_projection.workspaces()[0].agents()[0];
        assert_eq!(restored_snapshot.display_name(), "Recovered Codex");
        assert_eq!(restored_snapshot.status(), AgentStatus::Waiting);
        assert_eq!(restored_snapshot.runtime_health(), RuntimeHealth::Healthy);
        assert_eq!(
            restored_snapshot.control_state(),
            AgentControlState::StopFailed { diagnostic: DiagnosticCode::CleanupFailed }
        );
        assert!(!restored_snapshot.is_interactive());
        assert!(restored_snapshot.can_retry_stop());
        model
            .add_agent(&workspace_id, AgentId::for_test("new"), profile("codex", "Codex"))
            .unwrap();
        assert_eq!(model.snapshot().workspaces()[0].agents()[1].display_name(), "Codex 5");
    }

    #[test]
    fn agent_restore_record_rejects_invalid_name_ordinal_and_unknown_workspace() {
        let (mut model, workspace_id) = model_with_workspace();
        let base_profile = profile("codex", "Codex");
        let invalid_name = AgentRestoreRecord::new(
            AgentId::for_test("invalid-name"),
            workspace_id.clone(),
            base_profile.clone(),
            1,
            Some("  ".to_owned()),
            AgentStatus::Idle,
            RuntimeHealth::Starting,
            AgentControlState::Running,
        )
        .unwrap_err();
        assert_eq!(invalid_name.code(), DomainErrorCode::InvalidDisplayName);
        let invalid_ordinal = AgentRestoreRecord::new(
            AgentId::for_test("invalid-ordinal"),
            workspace_id,
            base_profile,
            0,
            None,
            AgentStatus::Idle,
            RuntimeHealth::Starting,
            AgentControlState::Running,
        )
        .unwrap_err();
        assert_eq!(invalid_ordinal.code(), DomainErrorCode::InvalidOrdinal);
        let unknown_workspace = AgentRestoreRecord::new(
            AgentId::for_test("unknown-workspace"),
            WorkspaceId::for_test("missing-workspace"),
            profile("codex", "Codex"),
            1,
            None,
            AgentStatus::Idle,
            RuntimeHealth::Starting,
            AgentControlState::Running,
        )
        .unwrap();
        assert_eq!(
            model.restore_agent(unknown_workspace).unwrap_err().code(),
            DomainErrorCode::UnknownWorkspace
        );
    }

    #[test]
    fn agent_stop_control_is_separate_from_work_status_and_retryable() {
        let (mut model, workspace_id) = model_with_workspace();
        let agent_id = AgentId::for_test("agent-a");
        model.add_agent(&workspace_id, agent_id.clone(), profile("codex", "Codex")).unwrap();
        let initial_revision = model.snapshot().revision();
        model.request_agent_stop(&agent_id).unwrap();
        assert_eq!(model.snapshot().workspaces()[0].agents()[0].status(), AgentStatus::Idle);
        assert_eq!(
            model.snapshot().workspaces()[0].agents()[0].control_state(),
            AgentControlState::Stopping
        );
        assert!(!model.snapshot().workspaces()[0].agents()[0].is_interactive());
        model.request_agent_stop(&agent_id).unwrap();
        assert_eq!(model.snapshot().revision(), initial_revision + 1);
        model.mark_agent_stop_failed(&agent_id, DiagnosticCode::CleanupFailed).unwrap();
        let failed_projection = model.snapshot();
        let failed = &failed_projection.workspaces()[0].agents()[0];
        assert!(failed.can_retry_stop());
        model.retry_agent_stop(&agent_id).unwrap();
        assert_eq!(
            model.snapshot().workspaces()[0].agents()[0].control_state(),
            AgentControlState::Stopping
        );
        model.return_agent_to_running(&agent_id).unwrap();
        assert!(model.snapshot().workspaces()[0].agents()[0].is_interactive());
        assert_eq!(
            model
                .mark_agent_stop_failed(&agent_id, DiagnosticCode::CleanupFailed)
                .unwrap_err()
                .code(),
            DomainErrorCode::InvalidAgentControlTransition
        );
    }

    #[test]
    fn no_op_transitions_do_not_advance_snapshot_revision() {
        let (mut model, workspace_id) = model_with_workspace();
        let revision = model.snapshot().revision();
        model.select_context(NavigationContext::Global).unwrap();
        assert_eq!(model.snapshot().revision(), revision);
        model.mark_workspace_unavailable(&workspace_id, DiagnosticCode::RootMissing).unwrap();
        let unavailable_revision = model.snapshot().revision();
        model.mark_workspace_unavailable(&workspace_id, DiagnosticCode::RootMissing).unwrap();
        assert_eq!(model.snapshot().revision(), unavailable_revision);
        model
            .relocate_workspace(
                &workspace_id,
                WorkspaceRoot::new("/dev/a").unwrap(),
                DisplayPath::new("/dev/a").unwrap(),
            )
            .unwrap();
        let available_revision = model.snapshot().revision();
        model.mark_workspace_available(&workspace_id).unwrap();
        assert_eq!(model.snapshot().revision(), available_revision);
    }

    #[test]
    fn selecting_workspace_never_restores_a_previous_agent() {
        let (mut model, workspace_id) = model_with_workspace();
        model
            .add_agent(&workspace_id, AgentId::for_test("agent-a"), profile("codex", "Codex"))
            .unwrap();
        model.select_context(NavigationContext::Workspace(workspace_id.clone())).unwrap();
        assert_eq!(model.snapshot().active_activity(), Activity::Editor);
        assert_eq!(
            model.snapshot().selected_context(),
            &NavigationContext::Workspace(workspace_id)
        );
    }

    #[test]
    fn workspace_repository_identity_is_optional_and_separate_from_root() {
        let mut model = AppModel::new();
        let repository = repository("repo", "https://github.com/statiolake/devhub.git");
        let repository_id = repository.id().clone();
        model.register_repository(repository).unwrap();
        model
            .add_workspace(Workspace::new(
                WorkspaceId::for_test("worktree-a"),
                WorkspaceRoot::new("/repo/a").unwrap(),
                crate::domain::DisplayPath::new("/repo/a").unwrap(),
                Some(repository_id.clone()),
            ))
            .unwrap();
        model
            .add_workspace(Workspace::new(
                WorkspaceId::for_test("worktree-b"),
                WorkspaceRoot::new("/repo/b").unwrap(),
                crate::domain::DisplayPath::new("/repo/b").unwrap(),
                Some(repository_id.clone()),
            ))
            .unwrap();
        assert_eq!(model.snapshot().workspaces().len(), 2);
        assert_eq!(model.snapshot().workspaces()[0].repository_id(), Some(&repository_id));
        assert_eq!(model.snapshot().workspaces()[1].repository_id(), Some(&repository_id));
        assert_ne!(model.snapshot().workspaces()[0].id(), model.snapshot().workspaces()[1].id());
    }

    #[test]
    fn repository_registry_owns_identity_alias_and_association_invariants() {
        let mut model = AppModel::new();
        let primary = repository("repo-a", "https://github.com/Owner/Repo.git");
        let primary_id = primary.id().clone();
        let revision_before = model.snapshot().revision();
        model.register_repository(primary.clone()).unwrap();
        assert_eq!(model.snapshot().revision(), revision_before);
        model.register_repository(primary.clone()).unwrap();
        assert_eq!(model.snapshot().revision(), revision_before);

        let identity_collision = repository("repo-a", "https://github.com/Owner/Other.git");
        assert_eq!(
            model.register_repository(identity_collision).unwrap_err().code(),
            DomainErrorCode::RepositoryIdentityConflict
        );
        let remote_collision = repository("repo-b", "ssh://git@github.com/owner/repo");
        assert_eq!(
            model.register_repository(remote_collision).unwrap_err().code(),
            DomainErrorCode::RepositoryRemoteConflict
        );

        let other = repository("repo-c", "https://code.example/Team/Repo.git");
        let other_id = other.id().clone();
        model.register_repository(other).unwrap();
        let orphan = Workspace::new(
            WorkspaceId::for_test("orphan"),
            WorkspaceRoot::new("/repo/orphan").unwrap(),
            DisplayPath::new("/repo/orphan").unwrap(),
            Some(RepositoryId::for_test("unregistered")),
        );
        assert_eq!(
            model.add_workspace(orphan).unwrap_err().code(),
            DomainErrorCode::UnknownRepository
        );

        let workspace_id = WorkspaceId::for_test("associating");
        model.add_workspace(workspace("associating", "/repo/associating")).unwrap();
        let before_association = model.snapshot().revision();
        model.associate_repository(&workspace_id, Some(primary_id.clone())).unwrap();
        assert_eq!(model.snapshot().revision(), before_association + 1);
        model.associate_repository(&workspace_id, Some(primary_id.clone())).unwrap();
        assert_eq!(model.snapshot().revision(), before_association + 1);
        assert_eq!(model.workspace(&workspace_id).unwrap().repository_id(), Some(&primary_id));
        model.associate_repository(&workspace_id, None).unwrap();
        assert_eq!(model.snapshot().revision(), before_association + 2);
        assert_eq!(model.workspace(&workspace_id).unwrap().repository_id(), None);
        model.associate_repository(&workspace_id, None).unwrap();
        assert_eq!(model.snapshot().revision(), before_association + 2);
        assert_eq!(
            model
                .associate_repository(&workspace_id, Some(RepositoryId::for_test("missing")))
                .unwrap_err()
                .code(),
            DomainErrorCode::UnknownRepository
        );

        model.close_workspace(&workspace_id, CloseInspection::Clean).unwrap();
        assert!(model.repository(&primary_id).is_some());
        assert!(model.repository(&other_id).is_some());
    }
}
