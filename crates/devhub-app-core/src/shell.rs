//! Strict native App Shell wire projection.
//!
//! The application model remains provider-free and non-serializable.  This
//! module is the only native boundary projection: it converts the immutable
//! [`AppSnapshot`] into a closed, camelCase DTO consumed by the Tauri shell.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::application::{
    AppReadiness, ConfirmationId, ConfirmationOutcomePurpose, CoordinatorEvent, CoordinatorReplay,
    IntentOutcome, RequestedPath,
};
use crate::config::AppearanceConfig;
use crate::{
    Activity, AgentControlState, AgentId, AgentProfile, AgentProfileKind, AgentStatus, AppError,
    AppErrorCode, AppSnapshot, CloseInspectionProjection, DiagnosticCode, DisabledReason,
    DomainErrorCode, EditorHostState, NavigationContext, ResourceInspection, RuntimeHealth,
    SurfaceKey, SurfaceResolution, UserIntent, WorkspaceAggregateStatus, WorkspaceId,
    WorkspaceState, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH,
};

pub const APP_SHELL_SCHEMA_VERSION: u16 = 1;
pub const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

/// The only appearance data the Workbench webview may receive from Settings.
///
/// This is intentionally a separate projection from `SettingsSnapshotWire`:
/// it contains no profiles, workspace sources, revisions, diagnostics, or
/// environment values. The terminal fields are retained for the future xterm
/// surface; the Workbench currently consumes `sidebar_density`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppAppearanceWire {
    #[schemars(range(min = 1, max = MAX_SAFE_JS_INTEGER))]
    pub sequence: u64,
    pub color_scheme: AppColorSchemeWire,
    pub sidebar_density: AppSidebarDensityWire,
    #[schemars(length(min = 1, max = 128))]
    pub terminal_font_family: String,
    #[schemars(range(min = 9, max = 24))]
    pub terminal_font_size: u8,
    #[schemars(range(min = 1.0, max = 2.0))]
    pub terminal_line_height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AppColorSchemeWire {
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AppSidebarDensityWire {
    Compact,
    Comfortable,
}

impl AppAppearanceWire {
    pub fn from_config(config: &AppearanceConfig, sequence: u64) -> Self {
        Self {
            sequence,
            color_scheme: AppColorSchemeWire::Light,
            sidebar_density: match config.sidebar_density.as_str() {
                "comfortable" => AppSidebarDensityWire::Comfortable,
                _ => AppSidebarDensityWire::Compact,
            },
            terminal_font_family: config.terminal_font_family.clone(),
            terminal_font_size: config.terminal_font_size,
            terminal_line_height: config.terminal_line_height,
        }
    }

    pub fn validate(&self) -> Result<(), SnapshotWireError> {
        if self.sequence == 0 || self.sequence > MAX_SAFE_JS_INTEGER {
            return Err(SnapshotWireError::UnsafeInteger);
        }
        if self.terminal_font_family.trim().is_empty()
            || self.terminal_font_family.chars().count() > 128
            || !(9..=24).contains(&self.terminal_font_size)
            || !self.terminal_line_height.is_finite()
            || !(1.0..=2.0).contains(&self.terminal_line_height)
        {
            return Err(SnapshotWireError::InvalidContract(
                "appearance projection is outside the supported range",
            ));
        }
        Ok(())
    }
}

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
    editor_host: EditorHostWire,
}

/// The shared editor host's state, so the Editor Surface can show a loading
/// state or the actual failure instead of a placeholder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields, tag = "status")]
#[schemars(rename_all = "camelCase", deny_unknown_fields, tag = "status")]
pub enum EditorHostWire {
    Starting,
    Ready,
    Failed {
        #[schemars(length(min = 1, max = 400))]
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        #[schemars(length(max = 4096))]
        detail: Option<String>,
    },
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

/// Secret-free profile choices exposed to the Workbench Agent picker. Args and
/// environment are intentionally omitted: the native coordinator resolves
/// the selected profile and retains the complete launch-time snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProfileWire {
    id: String,
    display_name: String,
    kind: AgentProfileKindWire,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentProfileKindWire {
    Codex,
    Claude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProfilesWire {
    #[schemars(range(min = 1, max = MAX_SAFE_JS_INTEGER))]
    sequence: u64,
    availability: AgentProfilesAvailabilityWire,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    diagnostic: Option<AgentProfilesDiagnosticWire>,
    profiles: Vec<AgentProfileWire>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentProfilesAvailabilityWire {
    Available,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentProfilesDiagnosticWire {
    ConfigurationInvalid,
    ConfigurationConflict,
    ProjectionUnavailable,
}

impl AgentProfilesWire {
    pub fn from_profiles(
        profiles: &[AgentProfile],
        sequence: u64,
    ) -> Result<Self, SnapshotWireError> {
        if sequence == 0 || sequence > MAX_SAFE_JS_INTEGER {
            return Err(SnapshotWireError::UnsafeInteger);
        }
        let profiles = profiles
            .iter()
            .map(|profile| AgentProfileWire {
                id: profile.id().to_string(),
                display_name: profile.display_name().to_owned(),
                kind: match profile.kind() {
                    AgentProfileKind::Codex => AgentProfileKindWire::Codex,
                    AgentProfileKind::Claude => AgentProfileKindWire::Claude,
                },
            })
            .collect();
        Ok(Self {
            sequence,
            availability: AgentProfilesAvailabilityWire::Available,
            diagnostic: None,
            profiles,
        })
    }

    pub fn degraded(mut self, diagnostic: AgentProfilesDiagnosticWire) -> Self {
        self.availability = AgentProfilesAvailabilityWire::Degraded;
        self.diagnostic = Some(diagnostic);
        self
    }

    pub fn unavailable(
        sequence: u64,
        diagnostic: AgentProfilesDiagnosticWire,
    ) -> Result<Self, SnapshotWireError> {
        if sequence == 0 || sequence > MAX_SAFE_JS_INTEGER {
            return Err(SnapshotWireError::UnsafeInteger);
        }
        Ok(Self {
            sequence,
            availability: AgentProfilesAvailabilityWire::Unavailable,
            diagnostic: Some(diagnostic),
            profiles: Vec::new(),
        })
    }

    pub fn validate(&self) -> Result<(), SnapshotWireError> {
        if self.sequence == 0 || self.sequence > MAX_SAFE_JS_INTEGER {
            return Err(SnapshotWireError::UnsafeInteger);
        }
        if self.profiles.iter().any(|profile| {
            profile.id.trim().is_empty()
                || profile.display_name.trim().is_empty()
                || profile.display_name.contains('\0')
        }) {
            return Err(SnapshotWireError::InvalidContract("invalid agent profile projection"));
        }
        if self.availability == AgentProfilesAvailabilityWire::Unavailable
            && !self.profiles.is_empty()
        {
            return Err(SnapshotWireError::InvalidContract(
                "unavailable agent profile projection must not contain choices",
            ));
        }
        if self.availability == AgentProfilesAvailabilityWire::Available
            && self.diagnostic.is_some()
        {
            return Err(SnapshotWireError::InvalidContract(
                "available agent profile projection cannot contain a diagnostic",
            ));
        }
        if self.availability != AgentProfilesAvailabilityWire::Available
            && self.diagnostic.is_none()
        {
            return Err(SnapshotWireError::InvalidContract(
                "degraded agent profile projection requires a diagnostic",
            ));
        }
        Ok(())
    }
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
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    RenameAgent {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "displayName")]
        #[schemars(rename = "displayName")]
        display_name: String,
    },
    StopAgent {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    ConfirmStopAgent {
        #[serde(rename = "confirmationId")]
        confirmation_id: String,
    },
    RetryStopAgent {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    ReconcileAgent {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    RetryWorkspace {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    LocateWorkspace {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        path: String,
    },
    RequestCloseWorkspace {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    ConfirmCloseWorkspace {
        #[serde(rename = "confirmationId")]
        confirmation_id: String,
    },
    RetryCloseWorkspace {
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
        purpose: ConfirmationPurposeWire,
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

/// Streaming Workspace Picker payload. This is part of the App Shell
/// contract so native and TypeScript consumers cannot silently diverge on
/// event shape or progress semantics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename_all = "kebab-case", deny_unknown_fields)]
pub enum WorkspacePickerEventWire {
    Candidate {
        #[schemars(length(min = 1, max = 128))]
        operation_id: String,
        #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
        sequence: u64,
        #[schemars(length(min = 1, max = 32_768))]
        label: String,
        #[schemars(length(min = 1, max = 32_768))]
        search_text: String,
        #[schemars(length(min = 1, max = 32_768))]
        path: String,
        score: u32,
    },
    Started {
        #[schemars(length(min = 1, max = 128))]
        operation_id: String,
        #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
        sequence: u64,
    },
    SourceError {
        #[schemars(length(min = 1, max = 128))]
        operation_id: String,
        #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
        sequence: u64,
        source_id: String,
        error_count: u32,
        truncated: bool,
    },
    SourceCompleted {
        #[schemars(length(min = 1, max = 128))]
        operation_id: String,
        #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
        sequence: u64,
        source_id: String,
        candidate_count: u32,
        error_count: u32,
        stderr_bytes: u32,
    },
    Cancelled {
        #[schemars(length(min = 1, max = 128))]
        operation_id: String,
        #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
        sequence: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
    },
    Completed {
        #[schemars(length(min = 1, max = 128))]
        operation_id: String,
        #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
        sequence: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
        candidate_count: u32,
        error_count: u32,
        stderr_bytes: u32,
        cancelled: bool,
        truncated: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename_all = "snake_case", deny_unknown_fields)]
pub enum ConfirmationPurposeWire {
    WorkspaceClose { inspection: CloseInspectionWire },
    AgentStop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename_all = "snake_case", deny_unknown_fields)]
pub enum CloseResourceWire {
    Clean,
    Busy { count: u32 },
    Unknown { diagnostic: CloseDiagnosticWire },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CloseDiagnosticWire {
    RootMissing,
    RootInaccessible,
    CloseAgentsUnknown,
    CloseTerminalUnknown,
    CloseEditorUnknown,
    CleanupFailed,
    RuntimeUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseInspectionWire {
    pub workspace_id: String,
    pub workspace_label: String,
    pub agents: CloseResourceWire,
    pub terminal_processes: CloseResourceWire,
    pub terminal_panes: CloseResourceWire,
    pub terminal_windows: CloseResourceWire,
    pub unsaved_editors: CloseResourceWire,
}

impl CloseResourceWire {
    fn from_domain(value: ResourceInspection) -> Self {
        match value {
            ResourceInspection::Clean => Self::Clean,
            ResourceInspection::Busy { count } => Self::Busy { count },
            ResourceInspection::Unknown { diagnostic } => {
                Self::Unknown { diagnostic: CloseDiagnosticWire::from_domain(diagnostic) }
            }
        }
    }
}

impl CloseDiagnosticWire {
    fn from_domain(value: DiagnosticCode) -> Self {
        match value {
            DiagnosticCode::RootMissing => Self::RootMissing,
            DiagnosticCode::RootInaccessible => Self::RootInaccessible,
            DiagnosticCode::CloseAgentsUnknown => Self::CloseAgentsUnknown,
            DiagnosticCode::CloseTerminalUnknown => Self::CloseTerminalUnknown,
            DiagnosticCode::CloseEditorUnknown => Self::CloseEditorUnknown,
            DiagnosticCode::CleanupFailed => Self::CleanupFailed,
            DiagnosticCode::RuntimeUnavailable => Self::RuntimeUnavailable,
        }
    }
}

impl CloseInspectionWire {
    fn from_domain(value: &CloseInspectionProjection) -> Result<Self, SnapshotWireError> {
        Ok(Self {
            workspace_id: value.workspace_id().to_string(),
            workspace_label: value.workspace_label().to_owned(),
            agents: CloseResourceWire::from_domain(value.agents()),
            terminal_processes: CloseResourceWire::from_domain(value.terminal_processes()),
            terminal_panes: CloseResourceWire::from_domain(value.terminal_panes()),
            terminal_windows: CloseResourceWire::from_domain(value.terminal_windows()),
            unsaved_editors: CloseResourceWire::from_domain(value.unsaved_editors()),
        })
    }
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
    /// The editor provider CLI could not be found on this machine.
    EditorProviderMissing,
    /// The editor provider's saved loopback port is held by something else.
    EditorPortUnavailable,
    /// The editor provider was found but could not be started.
    EditorUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AppErrorModuleWire {
    App,
    Config,
    State,
    Editor,
    Bridge,
    Agent,
    Terminal,
    Settings,
    Diagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AppErrorActionWire {
    Retry,
    OpenSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppErrorWire {
    code: AppErrorCodeWire,
    summary: String,
    module: AppErrorModuleWire,
    #[schemars(range(max = MAX_SAFE_JS_INTEGER))]
    timestamp_ms: u64,
    #[schemars(length(min = 1, max = 64))]
    runtime_version: String,
    actions: Vec<AppErrorActionWire>,
    /// Everything the local user needs to diagnose this failure themselves:
    /// the provider's own message, the port or path involved, an exit code, a
    /// backtrace. It is shown in the UI and written to the local log. DevHub
    /// is a single-user local application and this data never leaves the
    /// machine, so withholding it only hurt the person trying to fix it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[schemars(length(max = 4096))]
    detail: Option<String>,
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
            Self::OpenWorkspacePicker => Err(InvalidIntent),
            Self::RetryWorkspace { workspace_id } => {
                Ok(UserIntent::RetryWorkspace { workspace_id: parse_workspace_id(workspace_id)? })
            }
            Self::LocateWorkspace { workspace_id, path } => Ok(UserIntent::LocateWorkspace {
                workspace_id: parse_workspace_id(workspace_id)?,
                path: RequestedPath::new(path).map_err(|_| InvalidIntent)?,
            }),
            Self::RequestCloseWorkspace { workspace_id } => Ok(UserIntent::RequestCloseWorkspace {
                workspace_id: parse_workspace_id(workspace_id)?,
            }),
            Self::ConfirmCloseWorkspace { confirmation_id } => {
                Ok(UserIntent::ConfirmCloseWorkspace {
                    confirmation_id: ConfirmationId::from_uuid(confirmation_id)
                        .map_err(|_| InvalidIntent)?,
                })
            }
            Self::RetryCloseWorkspace { workspace_id } => Ok(UserIntent::RetryCloseWorkspace {
                workspace_id: parse_workspace_id(workspace_id)?,
            }),
            Self::RequestCreateAgent { workspace_id, profile_id } => Ok(UserIntent::CreateAgent {
                workspace_id: parse_workspace_id(workspace_id)?,
                profile_id: crate::AgentProfileId::from_slug(profile_id)
                    .map_err(|_| InvalidIntent)?,
            }),
            Self::RenameAgent { agent_id, display_name } => {
                if display_name.trim().is_empty()
                    || display_name.contains('\0')
                    || display_name.chars().count() > 256
                {
                    return Err(InvalidIntent);
                }
                Ok(UserIntent::RenameAgent {
                    agent_id: AgentId::from_uuid(agent_id).map_err(|_| InvalidIntent)?,
                    display_name,
                })
            }
            Self::StopAgent { agent_id } => Ok(UserIntent::StopAgent {
                agent_id: AgentId::from_uuid(agent_id).map_err(|_| InvalidIntent)?,
            }),
            Self::ConfirmStopAgent { confirmation_id } => Ok(UserIntent::ConfirmStopAgent {
                confirmation_id: ConfirmationId::from_uuid(confirmation_id)
                    .map_err(|_| InvalidIntent)?,
            }),
            Self::RetryStopAgent { agent_id } => Ok(UserIntent::RetryStopAgent {
                agent_id: AgentId::from_uuid(agent_id).map_err(|_| InvalidIntent)?,
            }),
            Self::ReconcileAgent { agent_id } => Ok(UserIntent::ReconcileAgent {
                agent_id: AgentId::from_uuid(agent_id).map_err(|_| InvalidIntent)?,
            }),
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
            IntentOutcome::ConfirmationRequired { confirmation_id, purpose, .. } => {
                Self::ConfirmationRequired {
                    confirmation_id: confirmation_id.to_string(),
                    snapshot,
                    purpose: match purpose {
                        ConfirmationOutcomePurpose::WorkspaceClose { inspection } => {
                            ConfirmationPurposeWire::WorkspaceClose {
                                inspection: CloseInspectionWire::from_domain(inspection)?,
                            }
                        }
                        ConfirmationOutcomePurpose::AgentStop => ConfirmationPurposeWire::AgentStop,
                    },
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
    /// Returns the stable error category used by native diagnostics.
    pub const fn code(&self) -> AppErrorCodeWire {
        self.code
    }

    pub fn native_unavailable() -> Self {
        Self::at(AppErrorCodeWire::NativeUnavailable, 0)
    }

    pub fn invalid_intent() -> Self {
        Self::at(AppErrorCodeWire::InvalidIntent, 0)
    }

    pub fn persistence_degraded() -> Self {
        Self::at(AppErrorCodeWire::PersistenceDegraded, 0)
    }

    /// Keeps the old call-site shape.
    /// Native/provider error text is never allowed to become product data.
    /// Replace the code's default sentence with a more specific one.
    pub fn with_summary(mut self, summary: impl Into<String>) -> Self {
        let summary = summary.into();
        self.summary =
            if summary.is_empty() { safe_error_summary(self.code).to_owned() } else { summary };
        self
    }

    /// Attach the diagnosable detail behind this error.
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        self.detail = (!detail.is_empty()).then(|| truncate_detail(&detail));
        self
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }

    pub fn with_module(mut self, module: AppErrorModuleWire) -> Self {
        self.module = module;
        self
    }

    pub fn at(code: AppErrorCodeWire, timestamp_ms: u64) -> Self {
        let timestamp_ms = if timestamp_ms == 0 { now_ms() } else { timestamp_ms };
        let module = default_error_module(code);
        let actions = if matches!(
            code,
            AppErrorCodeWire::NativeUnavailable
                | AppErrorCodeWire::PersistenceDegraded
                | AppErrorCodeWire::EditorProviderMissing
                | AppErrorCodeWire::EditorPortUnavailable
                | AppErrorCodeWire::EditorUnavailable
        ) {
            vec![AppErrorActionWire::Retry, AppErrorActionWire::OpenSettings]
        } else {
            vec![AppErrorActionWire::Retry]
        };
        Self {
            code,
            summary: safe_error_summary(code).to_owned(),
            module,
            timestamp_ms,
            runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
            actions,
            detail: None,
        }
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
        Self::at(code, 0)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(MAX_SAFE_JS_INTEGER as u128) as u64)
        .unwrap_or(0)
}

fn default_error_module(code: AppErrorCodeWire) -> AppErrorModuleWire {
    match code {
        AppErrorCodeWire::PersistenceDegraded => AppErrorModuleWire::State,
        AppErrorCodeWire::NativeUnavailable => AppErrorModuleWire::App,
        AppErrorCodeWire::EditorProviderMissing
        | AppErrorCodeWire::EditorPortUnavailable
        | AppErrorCodeWire::EditorUnavailable => AppErrorModuleWire::Editor,
        _ => AppErrorModuleWire::App,
    }
}

/// Keep one failure from filling the log or the Error Surface. The schema
/// caps this field, and a backtrace can be arbitrarily long.
fn truncate_detail(detail: &str) -> String {
    const MAX: usize = 4096;
    if detail.len() <= MAX {
        return detail.to_owned();
    }
    let mut end = MAX;
    while end > 0 && !detail.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &detail[..end])
}

fn safe_error_summary(code: AppErrorCodeWire) -> &'static str {
    match code {
        AppErrorCodeWire::InvalidIntent => "The requested action is not available.",
        AppErrorCodeWire::ActivityDisabled => {
            "This activity is unavailable in the current context."
        }
        AppErrorCodeWire::UnknownContext => "The selected context is no longer available.",
        AppErrorCodeWire::WorkspaceUnavailable => "The workspace is unavailable.",
        AppErrorCodeWire::WorkspaceClosing => "The workspace is already closing.",
        AppErrorCodeWire::WorkspaceCloseFailed => "The workspace could not be closed cleanly.",
        AppErrorCodeWire::OperationPending => "Another operation is still in progress.",
        AppErrorCodeWire::PersistenceDegraded => "Changes could not be saved.",
        AppErrorCodeWire::NativeUnavailable => "The native app shell is unavailable.",
        // These name the failure and the next step. The concrete cause rides
        // along in `detail` rather than being folded into the sentence.
        AppErrorCodeWire::EditorProviderMissing => {
            "DevHub could not find the Visual Studio Code `code` command. \
             Install VS Code, or run its \"Shell Command: Install 'code' command in PATH\" \
             from the Command Palette, then retry."
        }
        AppErrorCodeWire::EditorPortUnavailable => {
            "The editor's saved local port is being used by another process. \
             Quit any leftover VS Code server, then retry. Settings shows the port DevHub uses."
        }
        AppErrorCodeWire::EditorUnavailable => {
            "The editor could not start. Other activities keep working; \
             open Settings to check the editor runtime, then retry."
        }
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
        let editor_host = match snapshot.editor_host() {
            EditorHostState::Starting => EditorHostWire::Starting,
            EditorHostState::Ready => EditorHostWire::Ready,
            EditorHostState::Failed { summary, detail } => {
                EditorHostWire::Failed { summary: summary.clone(), detail: detail.clone() }
            }
        };
        let wire = Self {
            schema_version: APP_SHELL_SCHEMA_VERSION,
            revision: snapshot.revision(),
            readiness,
            editor_host,
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
    use std::collections::BTreeMap;

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
        let result = serde_json::from_value::<AppIntentWire>(serde_json::json!({
            "type": "request_create_agent",
            "workspaceId": "00000000-0000-4000-8000-000000000001"
        }));
        assert!(result.is_err());

        let intent: AppIntentWire = serde_json::from_value(serde_json::json!({
            "type": "request_create_agent",
            "workspaceId": "00000000-0000-4000-8000-000000000001",
            "profileId": "codex"
        }))
        .expect("profile selection is required");
        assert!(intent.into_user_intent().is_ok());
    }

    #[test]
    fn profile_projection_is_secret_free_and_sequence_bound() {
        let profile = AgentProfile::new(
            crate::AgentProfileId::from_slug("codex").expect("profile id"),
            "Codex",
            AgentProfileKind::Codex,
            vec!["--model".to_owned(), "secret-model".to_owned()],
            BTreeMap::from([(String::from("TOKEN"), String::from("secret-value"))]),
        )
        .expect("profile");
        let wire = AgentProfilesWire::from_profiles(&[profile], 7).expect("profile projection");
        let value = serde_json::to_value(wire).expect("profile wire serializes");
        assert_eq!(value["sequence"], 7);
        assert_eq!(
            value["profiles"][0],
            serde_json::json!({
                "id": "codex",
                "displayName": "Codex",
                "kind": "codex",
            })
        );
        let encoded = value.to_string();
        assert!(!encoded.contains("secret-model"));
        assert!(!encoded.contains("secret-value"));
        assert!(!encoded.contains("args"));
        assert!(!encoded.contains("env"));
    }

    #[test]
    fn error_surface_is_stable_timestamped_and_diagnosable() {
        let error = AppErrorWire::at(AppErrorCodeWire::NativeUnavailable, 7)
            .with_summary("The editor server could not start.")
            .with_detail("127.0.0.1:55971 is already in use by another process.");
        let value = serde_json::to_value(error).expect("error surface serializes");
        assert_eq!(value["code"], "native_unavailable");
        assert_eq!(value["module"], "app");
        assert_eq!(value["timestampMs"], 7);
        assert_eq!(value["actions"], serde_json::json!(["retry", "open_settings"]));
        // Both the caller's sentence and the concrete cause survive. DevHub is
        // a single-user local application: the person reading this error is
        // the person who has to fix it, and withholding the port number only
        // made that harder.
        assert_eq!(value["summary"], "The editor server could not start.");
        assert!(value["detail"].as_str().expect("detail").contains("55971"));
    }

    #[test]
    fn error_detail_is_bounded_so_one_failure_cannot_flood_the_log() {
        let error = AppErrorWire::at(AppErrorCodeWire::NativeUnavailable, 7)
            .with_detail("あ".repeat(8_000));
        let detail = error.detail().expect("detail");
        assert!(detail.len() <= 4_100, "{}", detail.len());
        assert!(detail.ends_with('…'));
    }

    #[test]
    fn empty_summary_falls_back_to_the_code_sentence() {
        let error = AppErrorWire::at(AppErrorCodeWire::NativeUnavailable, 7).with_summary("");
        let value = serde_json::to_value(error).expect("serializes");
        assert_eq!(value["summary"], "The native app shell is unavailable.");
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
            } else if value.get("profiles").is_some() {
                let profiles: AgentProfilesWire =
                    serde_json::from_value(value).expect("valid profile projection");
                profiles.validate().expect("valid profile projection constraints");
            } else if value.get("sidebarDensity").is_some() {
                let appearance: AppAppearanceWire =
                    serde_json::from_value(value).expect("valid appearance projection");
                appearance.validate().expect("valid appearance projection");
            } else if value.get("kind").is_some() {
                let outcome: AppOutcomeWire = serde_json::from_value(value).expect("valid outcome");
                outcome.snapshot().validate().expect("valid outcome snapshot");
            } else if value.get("code").is_some() && value.get("actions").is_some() {
                let error: AppErrorWire = serde_json::from_value(value).expect("valid error");
                assert!(error.timestamp_ms <= MAX_SAFE_JS_INTEGER);
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
            } else if value.get("sidebarDensity").is_some() {
                serde_json::from_value::<AppAppearanceWire>(value.clone())
                    .and_then(|appearance| {
                        appearance
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
