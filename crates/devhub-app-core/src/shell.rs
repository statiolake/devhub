//! Strict native App Shell wire projection.
//!
//! The application model remains provider-free and non-serializable.  This
//! module is the only native boundary projection: it converts the immutable
//! [`AppSnapshot`] into a closed, camelCase DTO consumed by the Tauri shell.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::fmt;

use crate::application::{AppReadiness, CoordinatorEvent, CoordinatorReplay, IntentOutcome};
use crate::{
    Activity, AgentControlState, AgentId, AgentStatus, AppError, AppErrorCode, AppSnapshot,
    DisabledReason, DomainErrorCode, NavigationContext, RuntimeHealth, SurfaceKey,
    SurfaceResolution, UserIntent, WorkspaceAggregateStatus, WorkspaceId, WorkspaceState,
    SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH,
};

pub const APP_SHELL_SCHEMA_VERSION: u16 = 1;
pub const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotWireError {
    NonUtf8Path,
    UnsafeInteger,
    InvalidContract(&'static str),
}

impl fmt::Display for SnapshotWireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NonUtf8Path => "snapshot contains a non-UTF-8 path",
            Self::UnsafeInteger => "snapshot contains an integer outside JavaScript safe range",
            Self::InvalidContract(message) => message,
        })
    }
}

impl std::error::Error for SnapshotWireError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSnapshotWire {
    #[schemars(range(min = APP_SHELL_SCHEMA_VERSION, max = APP_SHELL_SCHEMA_VERSION))]
    schema_version: u16,
    #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
    revision: u64,
    readiness: AppReadiness,
    selection: SelectionWire,
    activities: [ActivityWire; 3],
    workspaces: Vec<WorkspaceWire>,
    sidebar: SidebarWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionWire {
    context: ContextWire,
    activity: ActivityName,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ActivityName {
    Editor,
    Agent,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub enum ContextWire {
    Global,
    Workspace {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    Agent {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
}

impl<'de> Deserialize<'de> for ContextWire {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("context must be an object"))?;
        let kind = object
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("context kind is required"))?;
        let allowed = match kind {
            "global" => &["kind"][..],
            "workspace" => &["kind", "workspaceId"][..],
            "agent" => &["kind", "agentId"][..],
            _ => return Err(serde::de::Error::custom("unknown context kind")),
        };
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(serde::de::Error::custom("unknown context field"));
        }
        match kind {
            "global" => Ok(Self::Global),
            "workspace" => Ok(Self::Workspace {
                workspace_id: object
                    .get("workspaceId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| serde::de::Error::custom("workspaceId is required"))?
                    .to_owned(),
            }),
            "agent" => Ok(Self::Agent {
                agent_id: object
                    .get("agentId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| serde::de::Error::custom("agentId is required"))?
                    .to_owned(),
            }),
            _ => unreachable!("context kind validated above"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityWire {
    activity: ActivityName,
    resolution: ResolutionWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename_all = "snake_case", deny_unknown_fields)]
pub enum ResolutionWire {
    Enabled {
        #[serde(rename = "surfaceKey")]
        surface_key: String,
    },
    Disabled {
        reason: DisabledReasonWire,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DisabledReasonWire {
    GlobalAgentNotApplicable,
    WorkspaceAgentRequiresAgentSelection,
    WorkspaceUnavailable,
    WorkspaceClosing,
    WorkspaceClosingFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceStateWire {
    Available,
    Unavailable,
    Closing,
    ClosingFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeHealthWire {
    Starting,
    Healthy,
    Degraded,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AgentControlStateWire {
    Running,
    Stopping,
    StopFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWire {
    id: String,
    label: String,
    root: String,
    selected_path: String,
    state: WorkspaceStateWire,
    aggregate_status: AgentStatusWire,
    agents: Vec<AgentWire>,
    can_create_agent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWire {
    id: String,
    workspace_id: String,
    profile_id: String,
    display_name: String,
    ordinal: u32,
    status: AgentStatusWire,
    runtime_health: RuntimeHealthWire,
    control_state: AgentControlStateWire,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatusWire {
    Working,
    Waiting,
    Idle,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidebarWire {
    #[schemars(range(min = SIDEBAR_MIN_WIDTH, max = SIDEBAR_MAX_WIDTH))]
    width: u16,
    expanded_workspace_ids: Vec<String>,
}

/// User input accepted by the native shell. No IntentId, canonical path,
/// provider observation, or generated domain identity is accepted here; the
/// native ingress creates the correlation identity and the coordinator owns
/// all resulting state transitions.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub enum AppIntentWire {
    SelectContext {
        context: ContextInputWire,
    },
    SelectActivity {
        activity: ActivityName,
    },
    ToggleWorkspaceDisclosure {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        expanded: bool,
    },
    ResizeSidebar {
        #[schemars(range(min = SIDEBAR_MIN_WIDTH, max = SIDEBAR_MAX_WIDTH))]
        width: u16,
    },
    OpenWorkspacePicker,
    RequestCreateAgent {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    RetryWorkspace {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
}

pub type ContextInputWire = ContextWire;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename_all = "snake_case", deny_unknown_fields)]
pub enum AppOutcomeWire {
    Noop {
        snapshot: AppSnapshotWire,
    },
    Updated {
        snapshot: AppSnapshotWire,
    },
    ConfirmationRequired {
        #[serde(rename = "confirmationId")]
        confirmation_id: String,
        snapshot: AppSnapshotWire,
    },
    Deferred {
        #[serde(rename = "operationId")]
        operation_id: String,
        snapshot: AppSnapshotWire,
    },
    Detached {
        snapshot: AppSnapshotWire,
    },
    PersistenceDegraded {
        snapshot: AppSnapshotWire,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AppErrorCodeWire {
    InvalidIntent,
    ActivityDisabled,
    UnknownContext,
    WorkspaceUnavailable,
    WorkspaceClosing,
    WorkspaceCloseFailed,
    OperationPending,
    PersistenceDegraded,
    NativeUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppErrorWire {
    code: AppErrorCodeWire,
    summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayWire {
    #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
    cursor: u64,
    history_gap: bool,
    snapshot: AppSnapshotWire,
    events: Vec<ReplayEventWire>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayEventWire {
    #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
    sequence: u64,
    kind: ReplayEventKindWire,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReplayEventKindWire {
    Snapshot,
    Noop,
    Error,
    OperationCompleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidIntent;

impl AppIntentWire {
    pub fn validate(&self) -> Result<(), SnapshotWireError> {
        if let Self::ResizeSidebar { width } = self {
            if !(SIDEBAR_MIN_WIDTH..=SIDEBAR_MAX_WIDTH).contains(width) {
                return Err(SnapshotWireError::InvalidContract(
                    "sidebar width is outside the App Shell range",
                ));
            }
        }
        Ok(())
    }

    pub fn into_user_intent(self) -> Result<UserIntent, InvalidIntent> {
        match self {
            Self::SelectContext { context } => {
                Ok(UserIntent::SelectContext(context.into_domain()?))
            }
            Self::SelectActivity { activity } => {
                Ok(UserIntent::SelectActivity(activity.into_domain()))
            }
            Self::ToggleWorkspaceDisclosure { workspace_id, expanded } => {
                Ok(UserIntent::ToggleWorkspaceDisclosure {
                    workspace_id: parse_workspace_id(workspace_id)?,
                    expanded,
                })
            }
            Self::ResizeSidebar { width } => Ok(UserIntent::ResizeSidebar { width }),
            // The picker is a UI affordance. Until the resolver/file dialog
            // adapter is wired, treating it as a failed intent is safer than
            // returning a false success or inventing a canonical path.
            Self::OpenWorkspacePicker | Self::RetryWorkspace { .. } => Err(InvalidIntent),
            // A profile chooser/composer owns the profile selection. The
            // shell must not invent a profile merely to make this button
            // appear successful, so this MVP ingress is explicitly rejected.
            Self::RequestCreateAgent { .. } => Err(InvalidIntent),
        }
    }
}

impl ActivityName {
    fn into_domain(self) -> Activity {
        match self {
            Self::Editor => Activity::Editor,
            Self::Agent => Activity::Agent,
            Self::Terminal => Activity::Terminal,
        }
    }
}

impl ContextWire {
    fn into_domain(self) -> Result<NavigationContext, InvalidIntent> {
        match self {
            Self::Global => Ok(NavigationContext::Global),
            Self::Workspace { workspace_id } => {
                Ok(NavigationContext::Workspace(parse_workspace_id(workspace_id)?))
            }
            Self::Agent { agent_id } => Ok(NavigationContext::Agent(
                AgentId::from_uuid(agent_id).map_err(|_| InvalidIntent)?,
            )),
        }
    }
}

fn parse_workspace_id(raw: String) -> Result<WorkspaceId, InvalidIntent> {
    WorkspaceId::from_uuid(raw).map_err(|_| InvalidIntent)
}

impl AppOutcomeWire {
    pub fn snapshot(&self) -> &AppSnapshotWire {
        match self {
            Self::Noop { snapshot }
            | Self::Updated { snapshot }
            | Self::ConfirmationRequired { snapshot, .. }
            | Self::Deferred { snapshot, .. }
            | Self::Detached { snapshot }
            | Self::PersistenceDegraded { snapshot } => snapshot,
        }
    }

    pub fn from_outcome(
        outcome: &IntentOutcome,
        readiness: AppReadiness,
    ) -> Result<Self, SnapshotWireError> {
        let snapshot = AppSnapshotWire::from_snapshot(outcome.snapshot(), readiness)?;
        Ok(match outcome {
            IntentOutcome::Noop { .. } => Self::Noop { snapshot },
            IntentOutcome::Updated { .. } => Self::Updated { snapshot },
            IntentOutcome::ConfirmationRequired { confirmation_id, .. } => {
                Self::ConfirmationRequired {
                    confirmation_id: confirmation_id.to_string(),
                    snapshot,
                }
            }
            IntentOutcome::Deferred { operation_id, .. } => {
                Self::Deferred { operation_id: operation_id.to_string(), snapshot }
            }
            IntentOutcome::Detached { .. } => Self::Detached { snapshot },
            IntentOutcome::PersistenceDegraded { .. } => Self::PersistenceDegraded { snapshot },
        })
    }
}

impl AppErrorWire {
    pub fn native_unavailable() -> Self {
        Self { code: AppErrorCodeWire::NativeUnavailable, summary: "native_unavailable".to_owned() }
    }

    pub fn invalid_intent() -> Self {
        Self { code: AppErrorCodeWire::InvalidIntent, summary: "invalid_intent".to_owned() }
    }

    pub fn persistence_degraded() -> Self {
        Self {
            code: AppErrorCodeWire::PersistenceDegraded,
            summary: "persistence_degraded".to_owned(),
        }
    }

    pub fn with_summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = summary.into();
        self
    }

    pub fn from_error(error: &AppError) -> Self {
        let code = match error.code() {
            AppErrorCode::Domain => match error.domain_code() {
                Some(DomainErrorCode::ActivityDisabled) => AppErrorCodeWire::ActivityDisabled,
                Some(DomainErrorCode::UnknownWorkspace) | Some(DomainErrorCode::UnknownAgent) => {
                    AppErrorCodeWire::UnknownContext
                }
                Some(DomainErrorCode::WorkspaceUnavailable) => {
                    AppErrorCodeWire::WorkspaceUnavailable
                }
                Some(DomainErrorCode::WorkspaceClosing) => AppErrorCodeWire::WorkspaceClosing,
                Some(DomainErrorCode::WorkspaceClosingFailed) => {
                    AppErrorCodeWire::WorkspaceCloseFailed
                }
                _ => AppErrorCodeWire::InvalidIntent,
            },
            AppErrorCode::DuplicateIntent
            | AppErrorCode::InvalidIntent
            | AppErrorCode::UnknownIntent
            | AppErrorCode::UnknownOperation
            | AppErrorCode::StaleCompletion
            | AppErrorCode::ConfirmationExpired => AppErrorCodeWire::InvalidIntent,
            AppErrorCode::ConfirmationRequired
            | AppErrorCode::OperationInProgress
            | AppErrorCode::OperationGenerationExhausted => AppErrorCodeWire::OperationPending,
            AppErrorCode::PersistenceDegraded => AppErrorCodeWire::PersistenceDegraded,
            AppErrorCode::PortUnavailable => AppErrorCodeWire::NativeUnavailable,
        };
        let summary = format!("{code:?}");
        Self { summary, code }
    }
}

impl ReplayWire {
    pub fn validate(&self) -> Result<(), SnapshotWireError> {
        if self.cursor > MAX_SAFE_JS_INTEGER {
            return Err(SnapshotWireError::UnsafeInteger);
        }
        let mut previous_sequence = 0;
        for event in &self.events {
            if event.sequence == 0 || event.sequence > MAX_SAFE_JS_INTEGER {
                return Err(if event.sequence > MAX_SAFE_JS_INTEGER {
                    SnapshotWireError::UnsafeInteger
                } else {
                    SnapshotWireError::InvalidContract("replay event sequence must be positive")
                });
            }
            if event.sequence <= previous_sequence || event.sequence > self.cursor {
                return Err(SnapshotWireError::InvalidContract(
                    "replay event sequence must increase within the cursor",
                ));
            }
            previous_sequence = event.sequence;
        }
        self.snapshot.validate()
    }

    pub fn from_replay(
        replay: &CoordinatorReplay,
        readiness: AppReadiness,
    ) -> Result<Self, SnapshotWireError> {
        if replay.cursor() > MAX_SAFE_JS_INTEGER {
            return Err(SnapshotWireError::UnsafeInteger);
        }
        let wire = Self {
            cursor: replay.cursor(),
            history_gap: replay.history_gap(),
            snapshot: AppSnapshotWire::from_snapshot(replay.snapshot(), readiness)?,
            // Effects (and provider payloads that are only used to produce
            // them) are an internal native execution detail.  They still
            // consume a process sequence, so the cursor remains the
            // coordinator cursor even when an event is omitted from the
            // public projection.  This keeps reconnects gap-safe without
            // exposing commands or provider data to the UI.
            events: replay
                .events()
                .iter()
                .filter_map(|event| {
                    let kind = match event.event() {
                        CoordinatorEvent::Snapshot(_) => ReplayEventKindWire::Snapshot,
                        CoordinatorEvent::Effect(_) => return None,
                        CoordinatorEvent::Noop => ReplayEventKindWire::Noop,
                        CoordinatorEvent::Error(_) => ReplayEventKindWire::Error,
                        CoordinatorEvent::OperationCompleted { .. } => {
                            ReplayEventKindWire::OperationCompleted
                        }
                    };
                    Some(ReplayEventWire { sequence: event.sequence(), kind })
                })
                .collect(),
        };
        wire.validate()?;
        Ok(wire)
    }
}

impl AppSnapshotWire {
    pub fn validate(&self) -> Result<(), SnapshotWireError> {
        if self.schema_version != APP_SHELL_SCHEMA_VERSION {
            return Err(SnapshotWireError::InvalidContract("unsupported App Shell schema version"));
        }
        if self.revision > MAX_SAFE_JS_INTEGER {
            return Err(SnapshotWireError::UnsafeInteger);
        }
        if !(SIDEBAR_MIN_WIDTH..=SIDEBAR_MAX_WIDTH).contains(&self.sidebar.width) {
            return Err(SnapshotWireError::InvalidContract(
                "sidebar width is outside the App Shell range",
            ));
        }
        Ok(())
    }

    pub fn from_snapshot(
        snapshot: &AppSnapshot,
        readiness: AppReadiness,
    ) -> Result<Self, SnapshotWireError> {
        if snapshot.revision() > MAX_SAFE_JS_INTEGER {
            return Err(SnapshotWireError::UnsafeInteger);
        }
        let activities = snapshot.activities().clone().map(|activity| ActivityWire {
            activity: activity_name(activity.activity()),
            resolution: resolution_wire(activity.resolution()),
        });
        let wire = Self {
            schema_version: APP_SHELL_SCHEMA_VERSION,
            revision: snapshot.revision(),
            readiness,
            selection: SelectionWire {
                context: context_wire(snapshot.selected_context()),
                activity: activity_name(snapshot.active_activity()),
            },
            activities,
            workspaces: snapshot
                .workspaces()
                .iter()
                .map(|workspace| -> Result<WorkspaceWire, SnapshotWireError> {
                    Ok(WorkspaceWire {
                        id: workspace.id().to_string(),
                        label: workspace.label().to_owned(),
                        root: path_string(workspace.root().as_path())?,
                        selected_path: path_string(workspace.selected_path().as_path())?,
                        state: workspace_state_name(workspace.state()),
                        aggregate_status: aggregate_status_name(workspace.aggregate_status()),
                        agents: workspace
                            .agents()
                            .iter()
                            .map(|agent| AgentWire {
                                id: agent.id().to_string(),
                                workspace_id: agent.workspace_id().to_string(),
                                profile_id: agent.profile_id().to_string(),
                                display_name: agent.display_name().to_owned(),
                                ordinal: agent.ordinal(),
                                status: agent_status_name(agent.status()),
                                runtime_health: runtime_health_name(agent.runtime_health()),
                                control_state: control_state_name(agent.control_state()),
                            })
                            .collect(),
                        can_create_agent: workspace.can_create_agent(),
                    })
                })
                .collect::<Result<Vec<_>, SnapshotWireError>>()?,
            sidebar: SidebarWire {
                width: snapshot.sidebar().width(),
                expanded_workspace_ids: snapshot
                    .sidebar()
                    .expanded_workspace_ids()
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            },
        };
        wire.validate()?;
        Ok(wire)
    }
}

fn path_string(path: &std::path::Path) -> Result<String, SnapshotWireError> {
    path.to_str().map(ToOwned::to_owned).ok_or(SnapshotWireError::NonUtf8Path)
}

fn activity_name(activity: Activity) -> ActivityName {
    match activity {
        Activity::Editor => ActivityName::Editor,
        Activity::Agent => ActivityName::Agent,
        Activity::Terminal => ActivityName::Terminal,
    }
}

fn context_wire(context: &NavigationContext) -> ContextWire {
    match context {
        NavigationContext::Global => ContextWire::Global,
        NavigationContext::Workspace(id) => ContextWire::Workspace { workspace_id: id.to_string() },
        NavigationContext::Agent(id) => ContextWire::Agent { agent_id: id.to_string() },
    }
}

fn resolution_wire(resolution: &SurfaceResolution) -> ResolutionWire {
    match resolution {
        SurfaceResolution::Enabled(key) => {
            ResolutionWire::Enabled { surface_key: surface_key_name(key) }
        }
        SurfaceResolution::Disabled(reason) => {
            ResolutionWire::Disabled { reason: disabled_reason_name(*reason) }
        }
    }
}

fn surface_key_name(key: &SurfaceKey) -> String {
    match key {
        SurfaceKey::GlobalEditor => "global-editor".to_owned(),
        SurfaceKey::GlobalTerminal => "global-terminal".to_owned(),
        SurfaceKey::WorkspaceEditor(id) => format!("workspace-editor:{id}"),
        SurfaceKey::WorkspaceTerminal(id) => format!("workspace-terminal:{id}"),
        SurfaceKey::Agent(id) => format!("agent:{id}"),
    }
}

fn disabled_reason_name(reason: DisabledReason) -> DisabledReasonWire {
    match reason {
        DisabledReason::GlobalAgentNotApplicable => DisabledReasonWire::GlobalAgentNotApplicable,
        DisabledReason::WorkspaceAgentRequiresAgentSelection => {
            DisabledReasonWire::WorkspaceAgentRequiresAgentSelection
        }
        DisabledReason::WorkspaceUnavailable => DisabledReasonWire::WorkspaceUnavailable,
        DisabledReason::WorkspaceClosing => DisabledReasonWire::WorkspaceClosing,
        DisabledReason::WorkspaceClosingFailed => DisabledReasonWire::WorkspaceClosingFailed,
    }
}

fn workspace_state_name(state: WorkspaceState) -> WorkspaceStateWire {
    match state {
        WorkspaceState::Available => WorkspaceStateWire::Available,
        WorkspaceState::Unavailable { .. } => WorkspaceStateWire::Unavailable,
        WorkspaceState::Closing { .. } => WorkspaceStateWire::Closing,
        WorkspaceState::ClosingFailed { .. } => WorkspaceStateWire::ClosingFailed,
    }
}

fn aggregate_status_name(status: WorkspaceAggregateStatus) -> AgentStatusWire {
    match status {
        WorkspaceAggregateStatus::Idle => AgentStatusWire::Idle,
        WorkspaceAggregateStatus::Working => AgentStatusWire::Working,
        WorkspaceAggregateStatus::Waiting => AgentStatusWire::Waiting,
        WorkspaceAggregateStatus::Error => AgentStatusWire::Error,
    }
}

fn agent_status_name(status: AgentStatus) -> AgentStatusWire {
    match status {
        AgentStatus::Working => AgentStatusWire::Working,
        AgentStatus::Waiting => AgentStatusWire::Waiting,
        AgentStatus::Idle => AgentStatusWire::Idle,
        AgentStatus::Error => AgentStatusWire::Error,
    }
}

fn runtime_health_name(health: RuntimeHealth) -> RuntimeHealthWire {
    match health {
        RuntimeHealth::Starting => RuntimeHealthWire::Starting,
        RuntimeHealth::Healthy => RuntimeHealthWire::Healthy,
        RuntimeHealth::Degraded => RuntimeHealthWire::Degraded,
        RuntimeHealth::Unavailable => RuntimeHealthWire::Unavailable,
        RuntimeHealth::Failed => RuntimeHealthWire::Failed,
    }
}

fn control_state_name(state: AgentControlState) -> AgentControlStateWire {
    match state {
        AgentControlState::Running => AgentControlStateWire::Running,
        AgentControlState::Stopping => AgentControlStateWire::Stopping,
        AgentControlState::StopFailed { .. } => AgentControlStateWire::StopFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppCoordinator, AppModel, OperationId};

    #[test]
    fn app_snapshot_wire_is_closed_and_camel_case() {
        let snapshot =
            AppSnapshotWire::from_snapshot(&AppModel::new().snapshot(), AppReadiness::Ready)
                .expect("default snapshot is representable");
        let value = serde_json::to_value(snapshot).expect("wire snapshot serializes");
        let object = value.as_object().expect("wire snapshot is an object");
        assert_eq!(object.get("schemaVersion").and_then(|value| value.as_u64()), Some(1));
        assert_eq!(object.get("readiness").and_then(|value| value.as_str()), Some("ready"));
        assert!(!object.contains_key("selectedPath"));
        assert!(object.contains_key("selection"));
        assert!(object.contains_key("activities"));
        assert!(object.contains_key("workspaces"));
        assert!(object.contains_key("sidebar"));
        assert_eq!(value["selection"]["context"]["kind"], "global");
        assert_eq!(value["selection"]["activity"], "terminal");
        assert_eq!(value["activities"][0]["resolution"]["kind"], "enabled");
        assert!(value["activities"][0]["resolution"].get("surfaceKey").is_some());
    }

    #[test]
    fn app_intent_wire_rejects_unsupported_profileless_creation() {
        let intent: AppIntentWire = serde_json::from_value(serde_json::json!({
            "type": "request_create_agent",
            "workspaceId": "00000000-0000-4000-8000-000000000001"
        }))
        .expect("request shape is strict and valid");
        assert!(intent.into_user_intent().is_err());
    }

    #[test]
    fn app_intent_wire_rejects_unknown_fields() {
        let result = serde_json::from_value::<AppIntentWire>(serde_json::json!({
            "type": "resize_sidebar",
            "width": 248,
            "unexpected": true
        }));
        assert!(result.is_err());
    }

    #[test]
    fn javascript_safe_integer_limit_is_explicit() {
        assert_eq!(MAX_SAFE_JS_INTEGER, 9_007_199_254_740_991);
    }

    #[test]
    fn replay_wire_rejects_non_monotonic_sequences_outside_the_cursor() {
        let snapshot =
            AppSnapshotWire::from_snapshot(&AppModel::new().snapshot(), AppReadiness::Ready)
                .expect("default snapshot is representable");
        let replay = ReplayWire {
            cursor: 1,
            history_gap: false,
            snapshot,
            events: vec![ReplayEventWire { sequence: 0, kind: ReplayEventKindWire::Noop }],
        };
        assert!(replay.validate().is_err());
    }

    #[test]
    fn replay_wire_hides_effects_but_keeps_the_internal_cursor() {
        let mut coordinator = AppCoordinator::new();
        let operation_id = OperationId::for_test("00000000-0000-4000-8000-000000000101");
        coordinator
            .request_agents_reconcile(operation_id)
            .expect("reconciliation effect is accepted");

        let replay = coordinator.replay_from(0);
        let effect_sequence = replay
            .events()
            .iter()
            .find_map(|event| {
                matches!(event.event(), CoordinatorEvent::Effect(_)).then_some(event.sequence())
            })
            .expect("replay contains the internal effect advancement");
        let wire = ReplayWire::from_replay(&replay, AppReadiness::Ready)
            .expect("internal effects do not make the public replay invalid");

        assert_eq!(wire.cursor, replay.cursor());
        assert!(wire.events.iter().all(|event| event.sequence != effect_sequence));
        assert!(wire.events.iter().all(|event| {
            matches!(
                event.kind,
                ReplayEventKindWire::Snapshot
                    | ReplayEventKindWire::Noop
                    | ReplayEventKindWire::Error
                    | ReplayEventKindWire::OperationCompleted
            )
        }));
        assert!(wire.events.len() < replay.events().len());
        wire.validate().expect("filtered events retain cursor-safe ordering");
    }

    #[test]
    fn shared_valid_fixture_round_trips_through_rust_wire_types() {
        for value in serde_json::from_str::<Vec<serde_json::Value>>(include_str!(
            "../../../contracts/app-shell/valid.json"
        ))
        .expect("valid fixture array")
        {
            if value.get("type").is_some() {
                let intent: AppIntentWire = serde_json::from_value(value).expect("valid intent");
                intent.validate().expect("valid intent constraints");
            } else if value.get("cursor").is_some() {
                let replay: ReplayWire = serde_json::from_value(value).expect("valid replay");
                replay.validate().expect("valid replay constraints");
            } else if value.get("kind").is_some() {
                let outcome: AppOutcomeWire = serde_json::from_value(value).expect("valid outcome");
                outcome.snapshot().validate().expect("valid outcome snapshot");
            } else {
                let snapshot: AppSnapshotWire =
                    serde_json::from_value(value).expect("valid snapshot");
                snapshot.validate().expect("valid snapshot constraints");
            }
        }
    }

    #[test]
    fn shared_invalid_fixture_is_rejected_by_rust_wire_types() {
        for value in serde_json::from_str::<Vec<serde_json::Value>>(include_str!(
            "../../../contracts/app-shell/invalid.json"
        ))
        .expect("invalid fixture array")
        {
            let rejected = if value.get("type").is_some() {
                serde_json::from_value::<AppIntentWire>(value.clone())
                    .and_then(|intent| {
                        intent
                            .validate()
                            .map_err(|error| serde_json::Error::io(std::io::Error::other(error)))
                    })
                    .is_err()
            } else if value.get("cursor").is_some() {
                serde_json::from_value::<ReplayWire>(value.clone())
                    .and_then(|replay| {
                        replay
                            .validate()
                            .map_err(|error| serde_json::Error::io(std::io::Error::other(error)))
                    })
                    .is_err()
            } else {
                serde_json::from_value::<AppSnapshotWire>(value.clone())
                    .and_then(|snapshot| {
                        snapshot
                            .validate()
                            .map_err(|error| serde_json::Error::io(std::io::Error::other(error)))
                    })
                    .is_err()
            };
            assert!(rejected, "invalid fixture was accepted: {value}");
        }
    }
}
