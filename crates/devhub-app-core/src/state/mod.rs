//! Durable, provider-free DevHub application state.
//!
//! [`JsonStateStore`] owns the machine-local `state.json` contract.  The
//! state is deliberately a projection of the application, not a cache of
//! tmux, Herdr, or VS Code Server.  Provider adapters can use the persisted
//! workspace and agent identities to reattach after a relaunch, but runtime
//! lifetimes remain outside this module.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::domain::{
    Activity, AgentControlState, AgentId, AgentProfile, AgentProfileId, AgentProfileKind,
    AgentRestoreRecord, AgentStatus, CleanupProgress, DiagnosticCode, DisplayPath,
    NavigationContext, Repository, RepositoryId, RuntimeHealth, SurfaceResolution, WorkspaceId,
    WorkspaceRoot, WorkspaceState,
};

/// The schema version written by this crate.
pub const STATE_SCHEMA_VERSION: u16 = 1;
/// The effective socket used by a fresh DevHub installation.
pub const DEFAULT_TMUX_SOCKET_NAME: &str = "devhub";
/// The persisted default sidebar width in points.
pub const DEFAULT_SIDEBAR_WIDTH: u16 = 248;

const MIN_SIDEBAR_WIDTH: u16 = 200;
const MAX_SIDEBAR_WIDTH: u16 = 400;
const DEFAULT_WINDOW_WIDTH: u32 = 1_200;
const DEFAULT_WINDOW_HEIGHT: u32 = 800;
const MAX_AGENT_NAME_BYTES: usize = 512;
const MAX_AGENT_PROFILE_ARGS: usize = 128;
const MAX_AGENT_PROFILE_ARG_BYTES: usize = 4_096;
const MAX_AGENT_PROFILE_ENV_ENTRIES: usize = 128;
const MAX_AGENT_PROFILE_ENV_KEY_BYTES: usize = 256;
const MAX_AGENT_PROFILE_ENV_VALUE_BYTES: usize = 16_384;
const MAX_AGENT_PROFILE_SNAPSHOT_BYTES: usize = 256 * 1024;
const MAX_OPAQUE_MAPPING_BYTES: usize = 4096;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Content-free errors exposed by durable state operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StateErrorCode {
    Io,
    PermissionDenied,
    UnsafePath,
    CorruptState,
    InvalidState,
    UnsupportedSchemaVersion,
    InvalidTransition,
    Cancelled,
}

impl StateErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Io => "STATE_IO",
            Self::PermissionDenied => "STATE_PERMISSION_DENIED",
            Self::UnsafePath => "STATE_UNSAFE_PATH",
            Self::CorruptState => "STATE_CORRUPT",
            Self::InvalidState => "STATE_INVALID",
            Self::UnsupportedSchemaVersion => "STATE_NEWER_VERSION",
            Self::InvalidTransition => "STATE_INVALID_TRANSITION",
            Self::Cancelled => "STATE_CANCELLED",
        }
    }
}

/// A state failure intentionally carries no path, command output, or user
/// content.  Callers can log the stable code without leaking local data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StateError {
    code: StateErrorCode,
}

impl StateError {
    pub const fn new(code: StateErrorCode) -> Self {
        Self { code }
    }

    pub const fn code(self) -> StateErrorCode {
        self.code
    }
}

impl fmt::Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code.as_str())
    }
}

impl std::error::Error for StateError {}

fn state_error(code: StateErrorCode) -> StateError {
    StateError::new(code)
}

/// A content-free reason why a load did not use the primary file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RecoveryReason {
    Missing,
    CorruptPrimary,
    CorruptPrimaryAndBackup,
}

/// Where the returned state came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StateOrigin {
    Primary,
    Backup,
    Fresh,
}

/// Result metadata for a state load.  The metadata is useful for local
/// diagnostics and recovery UX while remaining free of user content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoadMetadata {
    origin: StateOrigin,
    recovery_reason: Option<RecoveryReason>,
    primary_quarantined: bool,
    backup_quarantined: bool,
    migrated: bool,
}

impl LoadMetadata {
    pub const fn origin(self) -> StateOrigin {
        self.origin
    }

    pub const fn recovery_reason(self) -> Option<RecoveryReason> {
        self.recovery_reason
    }

    pub const fn primary_quarantined(self) -> bool {
        self.primary_quarantined
    }

    pub const fn backup_quarantined(self) -> bool {
        self.backup_quarantined
    }

    pub const fn migrated(self) -> bool {
        self.migrated
    }
}

/// A validated load result.  A corrupt primary never gets silently discarded:
/// it is quarantined before a valid backup is selected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateLoad {
    state: PersistedAppState,
    metadata: LoadMetadata,
}

impl StateLoad {
    pub fn state(&self) -> &PersistedAppState {
        &self.state
    }

    pub fn into_state(self) -> PersistedAppState {
        self.state
    }

    pub const fn metadata(&self) -> LoadMetadata {
        self.metadata
    }
}

/// A context record stored without provider/editor identities.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NavigationContextRecord {
    #[default]
    Global,
    Workspace {
        workspace_id: String,
    },
    Agent {
        agent_id: String,
    },
}

impl NavigationContextRecord {
    pub fn from_domain(context: &NavigationContext) -> Self {
        match context {
            NavigationContext::Global => Self::Global,
            NavigationContext::Workspace(id) => Self::Workspace { workspace_id: id.to_string() },
            NavigationContext::Agent(id) => Self::Agent { agent_id: id.to_string() },
        }
    }

    pub fn to_domain(&self) -> Result<NavigationContext, StateError> {
        match self {
            Self::Global => Ok(NavigationContext::Global),
            Self::Workspace { workspace_id } => WorkspaceId::from_uuid(workspace_id.clone())
                .map(NavigationContext::Workspace)
                .map_err(|_| state_error(StateErrorCode::InvalidState)),
            Self::Agent { agent_id } => AgentId::from_uuid(agent_id.clone())
                .map(NavigationContext::Agent)
                .map_err(|_| state_error(StateErrorCode::InvalidState)),
        }
    }
}

/// The fixed top-level activity persisted for the selected context.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityRecord {
    Editor,
    Agent,
    #[default]
    Terminal,
}

impl From<Activity> for ActivityRecord {
    fn from(activity: Activity) -> Self {
        match activity {
            Activity::Editor => Self::Editor,
            Activity::Agent => Self::Agent,
            Activity::Terminal => Self::Terminal,
        }
    }
}

impl From<ActivityRecord> for Activity {
    fn from(activity: ActivityRecord) -> Self {
        match activity {
            ActivityRecord::Editor => Self::Editor,
            ActivityRecord::Agent => Self::Agent,
            ActivityRecord::Terminal => Self::Terminal,
        }
    }
}

/// Native Window frame persisted by the shell.  It is geometry only; no
/// WebView/editor state is stored here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for WindowFrame {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
            maximized: false,
        }
    }
}

impl WindowFrame {
    pub fn validate(self) -> Result<Self, StateError> {
        if self.width == 0 || self.height == 0 || self.width > 32_768 || self.height > 32_768 {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        Ok(self)
    }
}

/// Sidebar geometry and disclosure state.  Workspaces are ordered in the
/// workspace record vector; this list only stores which rows are expanded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidebarState {
    pub width: u16,
    #[serde(default)]
    pub expanded_workspace_ids: Vec<String>,
}

impl Default for SidebarState {
    fn default() -> Self {
        Self { width: DEFAULT_SIDEBAR_WIDTH, expanded_workspace_ids: Vec::new() }
    }
}

impl SidebarState {
    pub fn new(width: u16, expanded_workspace_ids: Vec<String>) -> Result<Self, StateError> {
        let state = Self { width, expanded_workspace_ids };
        state.validate()?;
        Ok(state)
    }

    pub fn validate(&self) -> Result<(), StateError> {
        if !(MIN_SIDEBAR_WIDTH..=MAX_SIDEBAR_WIDTH).contains(&self.width) {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        let mut seen = BTreeSet::new();
        for id in &self.expanded_workspace_ids {
            validate_uuid(id)?;
            if !seen.insert(id) {
                return Err(state_error(StateErrorCode::InvalidState));
            }
        }
        Ok(())
    }
}

/// Redacted lifecycle metadata used to distinguish a clean relaunch from a
/// process that may have crashed during a transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShutdownMetadata {
    #[serde(default = "default_clean_shutdown")]
    pub clean: bool,
    #[serde(default)]
    pub launch_generation: u64,
}

fn default_clean_shutdown() -> bool {
    true
}

impl Default for ShutdownMetadata {
    fn default() -> Self {
        Self { clean: true, launch_generation: 0 }
    }
}

/// A provider mapping is intentionally opaque to the product.  It has no
/// provider type, runtime ID, terminal ID, prompt, or content field.  Runtime
/// adapters may use it as a local reattachment key, but StateStore never
/// interprets it or presents it to UI code.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpaqueProviderMapping {
    value: String,
}

impl fmt::Debug for OpaqueProviderMapping {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("OpaqueProviderMapping").field("value", &"<redacted>").finish()
    }
}

impl OpaqueProviderMapping {
    pub fn new(value: impl Into<String>) -> Result<Self, StateError> {
        let value = value.into();
        if value.is_empty() || value.len() > MAX_OPAQUE_MAPPING_BYTES || value.contains('\0') {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        Ok(Self { value })
    }

    pub fn as_str(&self) -> &str {
        &self.value
    }
}

/// Durable agent status mapping.  This is a DevHub status projection, never a
/// provider status or a runtime lifecycle owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistedAgentProfileKind {
    Codex,
    Claude,
}

impl From<AgentProfileKind> for PersistedAgentProfileKind {
    fn from(kind: AgentProfileKind) -> Self {
        match kind {
            AgentProfileKind::Codex => Self::Codex,
            AgentProfileKind::Claude => Self::Claude,
        }
    }
}

impl From<PersistedAgentProfileKind> for AgentProfileKind {
    fn from(kind: PersistedAgentProfileKind) -> Self {
        match kind {
            PersistedAgentProfileKind::Codex => Self::Codex,
            PersistedAgentProfileKind::Claude => Self::Claude,
        }
    }
}

/// The launch-time profile kind is optional only for legacy state files that
/// predate this field. New snapshots always write it. Keeping the kind in
/// state prevents a removed Claude profile from being silently reconstructed
/// as Codex during startup.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentStateRecord {
    pub agent_id: String,
    pub workspace_id: String,
    pub profile_id: String,
    #[serde(default)]
    pub profile_kind: Option<PersistedAgentProfileKind>,
    #[serde(default)]
    pub profile_display_name: Option<String>,
    /// Complete launch-time arguments. `None` is retained only for state
    /// written before launch profiles became immutable snapshots; new
    /// records always write `Some`, including for an empty argument list.
    #[serde(default)]
    pub profile_args: Option<Vec<String>>,
    /// Complete launch-time environment. `None` is retained only for legacy
    /// records; an empty environment in a new record is `Some(empty)`.
    #[serde(default)]
    pub profile_env: Option<BTreeMap<String, String>>,
    pub ordinal: u32,
    #[serde(default)]
    pub temporary_name: Option<String>,
    #[serde(default)]
    pub status: PersistedAgentStatus,
    #[serde(default)]
    pub runtime_health: PersistedRuntimeHealth,
    #[serde(default)]
    pub control_state: PersistedAgentControlState,
    #[serde(default)]
    pub provider_mapping: Option<OpaqueProviderMapping>,
}

impl fmt::Debug for AgentStateRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentStateRecord")
            .field("agent_id", &self.agent_id)
            .field("workspace_id", &self.workspace_id)
            .field("profile_id", &self.profile_id)
            .field("profile_kind", &self.profile_kind)
            .field(
                "profile_display_name",
                &self.profile_display_name.as_ref().map(|_| "<redacted>"),
            )
            .field("profile_args_count", &self.profile_args.as_ref().map(Vec::len))
            .field("profile_env_count", &self.profile_env.as_ref().map(BTreeMap::len))
            .field("ordinal", &self.ordinal)
            .field("temporary_name", &self.temporary_name.as_ref().map(|_| "<redacted>"))
            .field("status", &self.status)
            .field("runtime_health", &self.runtime_health)
            .field("control_state", &self.control_state)
            .field("provider_mapping", &self.provider_mapping.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl AgentStateRecord {
    pub fn from_restore_record(record: &AgentRestoreRecord) -> Self {
        Self {
            agent_id: record.id().to_string(),
            workspace_id: record.workspace_id().to_string(),
            profile_id: record.profile().id().to_string(),
            profile_kind: Some(record.profile().kind().into()),
            profile_display_name: Some(record.profile().display_name().to_owned()),
            profile_args: Some(record.profile().args().to_vec()),
            profile_env: Some(record.profile().env().clone()),
            ordinal: record.ordinal(),
            temporary_name: record.temporary_name().map(str::to_owned),
            status: record.status().into(),
            runtime_health: record.runtime_health().into(),
            control_state: record.control_state().into(),
            provider_mapping: None,
        }
    }

    pub fn to_restore_record(
        &self,
        profile: AgentProfile,
    ) -> Result<AgentRestoreRecord, StateError> {
        let profile = self.launch_profile(Some(&profile))?;
        let id = AgentId::from_uuid(self.agent_id.clone())
            .map_err(|_| state_error(StateErrorCode::InvalidState))?;
        let workspace_id = WorkspaceId::from_uuid(self.workspace_id.clone())
            .map_err(|_| state_error(StateErrorCode::InvalidState))?;
        AgentRestoreRecord::new(
            id,
            workspace_id,
            profile,
            self.ordinal,
            self.temporary_name.clone(),
            self.status.into(),
            self.runtime_health.into(),
            self.control_state.into(),
        )
        .map_err(|_| state_error(StateErrorCode::InvalidState))
    }

    /// Reconstructs the launch-time profile carried by this record. Complete
    /// snapshots never consult the fallback profile, so editing or removing
    /// a Settings profile cannot change an already-running Agent on reload.
    /// The fallback is used only for pre-snapshot state documents that did
    /// not carry args/env (and therefore cannot recover values they never
    /// persisted).
    fn launch_profile(&self, fallback: Option<&AgentProfile>) -> Result<AgentProfile, StateError> {
        let kind = self
            .profile_kind
            .map(AgentProfileKind::from)
            .or_else(|| fallback.map(AgentProfile::kind))
            .ok_or_else(|| state_error(StateErrorCode::InvalidState))?;
        let display_name = self
            .profile_display_name
            .as_deref()
            .or_else(|| fallback.map(AgentProfile::display_name))
            .ok_or_else(|| state_error(StateErrorCode::InvalidState))?;
        let args = self
            .profile_args
            .clone()
            .or_else(|| fallback.map(|profile| profile.args().to_vec()))
            .ok_or_else(|| state_error(StateErrorCode::InvalidState))?;
        let env = self
            .profile_env
            .clone()
            .or_else(|| fallback.map(|profile| profile.env().clone()))
            .ok_or_else(|| state_error(StateErrorCode::InvalidState))?;
        AgentProfile::new(
            AgentProfileId::from_slug(self.profile_id.clone())
                .map_err(|_| state_error(StateErrorCode::InvalidState))?,
            display_name,
            kind,
            args,
            env,
        )
        .map_err(|_| state_error(StateErrorCode::InvalidState))
    }

    fn validate(&self) -> Result<(), StateError> {
        validate_uuid(&self.agent_id)?;
        validate_uuid(&self.workspace_id)?;
        validate_slug(&self.profile_id)?;
        if self.ordinal == 0 {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        if let Some(name) = &self.temporary_name {
            validate_display_name(name)?;
        }
        if let Some(name) = &self.profile_display_name {
            validate_display_name(name)?;
        }
        if let Some(args) = &self.profile_args {
            if args.len() > MAX_AGENT_PROFILE_ARGS
                || args
                    .iter()
                    .any(|arg| arg.len() > MAX_AGENT_PROFILE_ARG_BYTES || arg.contains('\0'))
            {
                return Err(state_error(StateErrorCode::InvalidState));
            }
        }
        if let Some(env) = &self.profile_env {
            if env.len() > MAX_AGENT_PROFILE_ENV_ENTRIES
                || env.iter().any(|(key, value)| {
                    key.is_empty()
                        || key.len() > MAX_AGENT_PROFILE_ENV_KEY_BYTES
                        || value.len() > MAX_AGENT_PROFILE_ENV_VALUE_BYTES
                        || key.contains('\0')
                        || value.contains('\0')
                        || !is_environment_name(key)
                })
            {
                return Err(state_error(StateErrorCode::InvalidState));
            }
        }
        let snapshot_bytes = self
            .profile_args
            .as_ref()
            .map(|args| args.iter().map(String::len).sum::<usize>())
            .unwrap_or_default()
            .saturating_add(
                self.profile_env
                    .as_ref()
                    .map(|env| env.iter().map(|(key, value)| key.len() + value.len()).sum())
                    .unwrap_or_default(),
            );
        if snapshot_bytes > MAX_AGENT_PROFILE_SNAPSHOT_BYTES {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        if let Some(mapping) = &self.provider_mapping {
            let _ = OpaqueProviderMapping::new(mapping.value.clone())?;
        }
        Ok(())
    }
}

/// String-safe persisted status values.  Unknown values fail the load rather
/// than silently changing the visible status.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistedAgentStatus {
    Working,
    Waiting,
    #[default]
    Idle,
    Error,
}

impl From<AgentStatus> for PersistedAgentStatus {
    fn from(status: AgentStatus) -> Self {
        match status {
            AgentStatus::Working => Self::Working,
            AgentStatus::Waiting => Self::Waiting,
            AgentStatus::Idle => Self::Idle,
            AgentStatus::Error => Self::Error,
        }
    }
}

impl From<PersistedAgentStatus> for AgentStatus {
    fn from(status: PersistedAgentStatus) -> Self {
        match status {
            PersistedAgentStatus::Working => Self::Working,
            PersistedAgentStatus::Waiting => Self::Waiting,
            PersistedAgentStatus::Idle => Self::Idle,
            PersistedAgentStatus::Error => Self::Error,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistedRuntimeHealth {
    #[default]
    Starting,
    Healthy,
    Degraded,
    Unavailable,
    Failed,
}

impl From<RuntimeHealth> for PersistedRuntimeHealth {
    fn from(health: RuntimeHealth) -> Self {
        match health {
            RuntimeHealth::Starting => Self::Starting,
            RuntimeHealth::Healthy => Self::Healthy,
            RuntimeHealth::Degraded => Self::Degraded,
            RuntimeHealth::Unavailable => Self::Unavailable,
            RuntimeHealth::Failed => Self::Failed,
        }
    }
}

impl From<PersistedRuntimeHealth> for RuntimeHealth {
    fn from(health: PersistedRuntimeHealth) -> Self {
        match health {
            PersistedRuntimeHealth::Starting => Self::Starting,
            PersistedRuntimeHealth::Healthy => Self::Healthy,
            PersistedRuntimeHealth::Degraded => Self::Degraded,
            PersistedRuntimeHealth::Unavailable => Self::Unavailable,
            PersistedRuntimeHealth::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PersistedAgentControlState {
    #[default]
    Running,
    Stopping,
    StopFailed {
        diagnostic: PersistedDiagnosticCode,
    },
}

impl From<AgentControlState> for PersistedAgentControlState {
    fn from(state: AgentControlState) -> Self {
        match state {
            AgentControlState::Running => Self::Running,
            AgentControlState::Stopping => Self::Stopping,
            AgentControlState::StopFailed { diagnostic } => {
                Self::StopFailed { diagnostic: diagnostic.into() }
            }
        }
    }
}

impl From<PersistedAgentControlState> for AgentControlState {
    fn from(state: PersistedAgentControlState) -> Self {
        match state {
            PersistedAgentControlState::Running => Self::Running,
            PersistedAgentControlState::Stopping => Self::Stopping,
            PersistedAgentControlState::StopFailed { diagnostic } => {
                Self::StopFailed { diagnostic: diagnostic.into() }
            }
        }
    }
}

/// Only stable, content-free diagnostics may be persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistedDiagnosticCode {
    RootMissing,
    RootInaccessible,
    CloseAgentsUnknown,
    CloseTerminalUnknown,
    CloseEditorUnknown,
    CleanupFailed,
    RuntimeUnavailable,
}

impl From<DiagnosticCode> for PersistedDiagnosticCode {
    fn from(code: DiagnosticCode) -> Self {
        match code {
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

impl From<PersistedDiagnosticCode> for DiagnosticCode {
    fn from(code: PersistedDiagnosticCode) -> Self {
        match code {
            PersistedDiagnosticCode::RootMissing => Self::RootMissing,
            PersistedDiagnosticCode::RootInaccessible => Self::RootInaccessible,
            PersistedDiagnosticCode::CloseAgentsUnknown => Self::CloseAgentsUnknown,
            PersistedDiagnosticCode::CloseTerminalUnknown => Self::CloseTerminalUnknown,
            PersistedDiagnosticCode::CloseEditorUnknown => Self::CloseEditorUnknown,
            PersistedDiagnosticCode::CleanupFailed => Self::CleanupFailed,
            PersistedDiagnosticCode::RuntimeUnavailable => Self::RuntimeUnavailable,
        }
    }
}

/// Progress is recorded after each ordered close step so a retry can resume
/// without repeating completed destruction.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedCleanupProgress {
    #[serde(default)]
    pub agents_closed: u32,
    #[serde(default)]
    pub agents_step_completed: bool,
    #[serde(default)]
    pub terminal_closed: bool,
    #[serde(default)]
    pub editor_closed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceLifecycleRecord {
    #[default]
    Available,
    Unavailable {
        reason: PersistedDiagnosticCode,
    },
    Closing {
        progress: PersistedCleanupProgress,
    },
    ClosingFailed {
        diagnostic: PersistedDiagnosticCode,
        progress: PersistedCleanupProgress,
    },
}

impl From<WorkspaceState> for WorkspaceLifecycleRecord {
    fn from(state: WorkspaceState) -> Self {
        match state {
            WorkspaceState::Available => Self::Available,
            WorkspaceState::Unavailable { reason } => Self::Unavailable { reason: reason.into() },
            WorkspaceState::Closing { progress } => Self::Closing {
                progress: PersistedCleanupProgress {
                    agents_closed: progress.agents_closed(),
                    agents_step_completed: progress.agents_step_completed(),
                    terminal_closed: progress.terminal_closed(),
                    editor_closed: progress.editor_closed(),
                },
            },
            WorkspaceState::ClosingFailed { diagnostic, progress } => Self::ClosingFailed {
                diagnostic: diagnostic.into(),
                progress: PersistedCleanupProgress {
                    agents_closed: progress.agents_closed(),
                    agents_step_completed: progress.agents_step_completed(),
                    terminal_closed: progress.terminal_closed(),
                    editor_closed: progress.editor_closed(),
                },
            },
        }
    }
}

/// An ordered open Workspace record.  `selected_path` and `canonical_path`
/// remain present even when the root is currently unavailable.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceStateRecord {
    pub workspace_id: String,
    pub selected_path: String,
    pub canonical_path: String,
    #[serde(default)]
    pub repository_id: Option<String>,
    #[serde(default)]
    pub lifecycle: WorkspaceLifecycleRecord,
    #[serde(default)]
    pub agents: Vec<AgentStateRecord>,
}

impl fmt::Debug for WorkspaceStateRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceStateRecord")
            .field("workspace_id", &self.workspace_id)
            .field("selected_path", &"<redacted>")
            .field("canonical_path", &"<redacted>")
            .field("repository_id", &self.repository_id)
            .field("lifecycle", &self.lifecycle)
            .field("agents", &self.agents)
            .finish()
    }
}

impl WorkspaceStateRecord {
    pub fn new(
        workspace_id: impl Into<String>,
        selected_path: impl Into<String>,
        canonical_path: impl Into<String>,
    ) -> Result<Self, StateError> {
        let record = Self {
            workspace_id: workspace_id.into(),
            selected_path: selected_path.into(),
            canonical_path: canonical_path.into(),
            repository_id: None,
            lifecycle: WorkspaceLifecycleRecord::Available,
            agents: Vec::new(),
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), StateError> {
        validate_uuid(&self.workspace_id)?;
        validate_absolute_path(&self.selected_path)?;
        validate_absolute_path(&self.canonical_path)?;
        if let Some(repository_id) = &self.repository_id {
            validate_uuid(repository_id)?;
        }
        let mut ids = BTreeSet::new();
        for agent in &self.agents {
            agent.validate()?;
            if agent.workspace_id != self.workspace_id || !ids.insert(&agent.agent_id) {
                return Err(state_error(StateErrorCode::InvalidState));
            }
        }
        validate_lifecycle(&self.lifecycle)?;
        if let WorkspaceLifecycleRecord::Closing { progress }
        | WorkspaceLifecycleRecord::ClosingFailed { progress, .. } = &self.lifecycle
        {
            if progress.agents_closed > self.agents.len() as u32 {
                return Err(state_error(StateErrorCode::InvalidState));
            }
        }
        Ok(())
    }

    pub fn is_available(&self) -> bool {
        matches!(self.lifecycle, WorkspaceLifecycleRecord::Available)
    }

    pub fn to_domain_paths(&self) -> Result<(WorkspaceId, WorkspaceRoot, DisplayPath), StateError> {
        let id = WorkspaceId::from_uuid(self.workspace_id.clone())
            .map_err(|_| state_error(StateErrorCode::InvalidState))?;
        let root = WorkspaceRoot::new(PathBuf::from(&self.canonical_path))
            .map_err(|_| state_error(StateErrorCode::InvalidState))?;
        let selected = DisplayPath::new(PathBuf::from(&self.selected_path))
            .map_err(|_| state_error(StateErrorCode::InvalidState))?;
        Ok((id, root, selected))
    }
}

fn validate_lifecycle(lifecycle: &WorkspaceLifecycleRecord) -> Result<(), StateError> {
    if let WorkspaceLifecycleRecord::Closing { progress }
    | WorkspaceLifecycleRecord::ClosingFailed { progress, .. } = lifecycle
    {
        // A failed/closing record cannot claim the editor step before the
        // terminal step; the close order is part of the persisted contract.
        if progress.editor_closed && !progress.terminal_closed {
            return Err(state_error(StateErrorCode::InvalidState));
        }
    }
    Ok(())
}

/// A marked DevHub terminal session. Unknown tmux sessions are intentionally
/// absent from this type and therefore cannot be deleted during a retry.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OwnedSessionRecord {
    Scratch { session_name: String },
    Workspace { workspace_id: String, session_name: String },
}

impl OwnedSessionRecord {
    pub fn session_name(&self) -> &str {
        match self {
            Self::Scratch { session_name } | Self::Workspace { session_name, .. } => session_name,
        }
    }

    fn validate(&self) -> Result<(), StateError> {
        let name = self.session_name();
        if name.is_empty() || name.len() > 256 || name.contains('\0') {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        match self {
            Self::Scratch { .. } if name != "scratch" => {
                return Err(state_error(StateErrorCode::InvalidState));
            }
            Self::Workspace { workspace_id, .. } => {
                validate_uuid(workspace_id)?;
                let digest = name
                    .strip_prefix("ws-")
                    .ok_or_else(|| state_error(StateErrorCode::InvalidState))?;
                if !matches!(digest.len(), 20 | 32)
                    || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
            }
            Self::Scratch { .. } => {}
        }
        Ok(())
    }
}

/// The complete set of terminals that must be recreated on the new socket:
/// one Scratch session and exactly one marked session per currently open
/// Workspace. Unknown or orphaned tmux sessions are never part of this value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequiredTerminalSet {
    sessions: Vec<OwnedSessionRecord>,
}

impl RequiredTerminalSet {
    pub fn new(sessions: impl IntoIterator<Item = OwnedSessionRecord>) -> Result<Self, StateError> {
        let required = Self { sessions: sessions.into_iter().collect() };
        required.validate()?;
        Ok(required)
    }

    pub fn sessions(&self) -> &[OwnedSessionRecord] {
        &self.sessions
    }

    pub fn workspace_ids(&self) -> BTreeSet<String> {
        self.sessions
            .iter()
            .filter_map(|session| match session {
                OwnedSessionRecord::Scratch { .. } => None,
                OwnedSessionRecord::Workspace { workspace_id, .. } => Some(workspace_id.clone()),
            })
            .collect()
    }

    fn validate(&self) -> Result<(), StateError> {
        let refs = self.sessions.iter().collect::<Vec<_>>();
        validate_unique_sessions(&refs)?;
        if self
            .sessions
            .iter()
            .filter(|session| matches!(session, OwnedSessionRecord::Scratch { .. }))
            .count()
            != 1
        {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        let workspace_count = self.workspace_ids().len();
        if workspace_count + 1 != self.sessions.len() {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupSessionStatus {
    #[default]
    Pending,
    Completed,
    Failed,
    /// The same session name was observed with different ownership metadata.
    /// This is a durable pause, never a kill target.
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanupSessionRecord {
    pub session: OwnedSessionRecord,
    #[serde(default)]
    pub status: CleanupSessionStatus,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecreationSessionStatus {
    #[default]
    Pending,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecreationSessionRecord {
    pub session: OwnedSessionRecord,
    #[serde(default)]
    pub status: RecreationSessionStatus,
}

/// Content-free result of probing the requested target socket. Conflicts are
/// persisted so a relaunch can show the pending change without adopting or
/// mutating the target server.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SocketTargetPreflightState {
    #[default]
    NotChecked,
    TargetAbsent,
    TargetDevhubEmpty,
    WrongMarker,
    MarkedSessions,
}

/// The durable operation a relaunch should perform next.  In particular,
/// `FinishOldCleanup` and `FinishRecreation` are intentional restart points:
/// a crash may happen after the last provider operation succeeds but before
/// the corresponding state-transition commit is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketTransitionNextAction {
    AwaitTargetPreflight,
    InspectOldSessions,
    CleanOldSessions,
    FinishOldCleanup,
    RecreateSessions,
    FinishRecreation,
}

impl SocketTargetPreflightState {
    const fn is_valid_target(self) -> bool {
        matches!(self, Self::TargetAbsent | Self::TargetDevhubEmpty)
    }
}

fn default_cleaning_target_preflight() -> SocketTargetPreflightState {
    SocketTargetPreflightState::TargetAbsent
}

/// Persisted tmux socket-transition state.  Each variant is restartable and
/// contains only the marked sessions that DevHub verified as its own.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SocketTransitionState {
    #[default]
    Stable,
    Pending {
        requested_socket_name: String,
        required: RequiredTerminalSet,
        #[serde(default)]
        preflight: SocketTargetPreflightState,
        /// The exact marked sessions inspected on the old effective socket.
        /// `None` means that old-session inspection has not completed yet;
        /// `Some(empty)` is a valid inspection result and means there is no
        /// owned session to destroy. This is intentionally distinct from
        /// `required`, which is only the new-socket recreation set.
        #[serde(default)]
        verified_old_sessions: Option<Vec<OwnedSessionRecord>>,
    },
    CleaningOld {
        old_socket_name: String,
        requested_socket_name: String,
        required: RequiredTerminalSet,
        /// Older transition documents reached this phase only after a valid
        /// target preflight, so the compatibility default is the least
        /// permissive valid target and is rechecked before any kill.
        #[serde(default = "default_cleaning_target_preflight")]
        target_preflight: SocketTargetPreflightState,
        sessions: Vec<CleanupSessionRecord>,
    },
    OldCleaned {
        old_socket_name: String,
        new_socket_name: String,
        required: RequiredTerminalSet,
    },
    RecreationPending {
        effective_socket_name: String,
        required: RequiredTerminalSet,
        sessions: Vec<RecreationSessionRecord>,
    },
}

impl SocketTransitionState {
    fn validate(&self, effective_socket_name: &str) -> Result<(), StateError> {
        validate_socket_name(effective_socket_name)?;
        match self {
            Self::Stable => {}
            Self::Pending { requested_socket_name, required, preflight, verified_old_sessions } => {
                validate_socket_name(requested_socket_name)?;
                required.validate()?;
                if let Some(sessions) = verified_old_sessions {
                    if !preflight.is_valid_target() {
                        return Err(state_error(StateErrorCode::InvalidState));
                    }
                    let refs = sessions.iter().collect::<Vec<_>>();
                    validate_unique_sessions(&refs)?;
                }
                if requested_socket_name == effective_socket_name {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
            }
            Self::CleaningOld {
                old_socket_name,
                requested_socket_name,
                required,
                target_preflight,
                sessions,
            } => {
                validate_socket_name(old_socket_name)?;
                validate_socket_name(requested_socket_name)?;
                required.validate()?;
                validate_cleanup_sessions(sessions)?;
                // A confirmed cleanup may observe a target marker/session
                // conflict after one or more old sessions were removed. Keep
                // that exact conflict cursor durable so Retry can re-probe
                // and recover; a brand-new all-Pending phase still requires
                // a valid target before it can exist.
                if !target_preflight.is_valid_target()
                    && sessions.iter().all(|record| record.status == CleanupSessionStatus::Pending)
                {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
                if effective_socket_name != old_socket_name
                    || old_socket_name == requested_socket_name
                {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
            }
            Self::OldCleaned { old_socket_name, new_socket_name, required } => {
                validate_socket_name(old_socket_name)?;
                validate_socket_name(new_socket_name)?;
                required.validate()?;
                if effective_socket_name != old_socket_name || old_socket_name == new_socket_name {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
            }
            Self::RecreationPending {
                effective_socket_name: transition_socket,
                required,
                sessions,
            } => {
                validate_socket_name(transition_socket)?;
                required.validate()?;
                validate_recreation_sessions(sessions)?;
                if !same_terminal_set(required, sessions.iter().map(|record| &record.session)) {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
                if effective_socket_name != transition_socket {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
            }
        }
        Ok(())
    }

    pub fn is_stable(&self) -> bool {
        matches!(self, Self::Stable)
    }

    pub fn requested_socket_name(&self) -> Option<&str> {
        match self {
            Self::Pending { requested_socket_name, .. }
            | Self::CleaningOld { requested_socket_name, .. } => Some(requested_socket_name),
            Self::OldCleaned { new_socket_name, .. } => Some(new_socket_name),
            Self::RecreationPending { effective_socket_name, .. } => Some(effective_socket_name),
            Self::Stable => None,
        }
    }

    /// Returns the deterministic operation needed to resume this transition
    /// after a relaunch.  The action is derived solely from persisted state;
    /// callers never need to reconstruct or broaden the terminal set.
    pub fn next_action(&self) -> Option<SocketTransitionNextAction> {
        match self {
            Self::Stable => None,
            Self::Pending { preflight, .. } if !preflight.is_valid_target() => {
                Some(SocketTransitionNextAction::AwaitTargetPreflight)
            }
            Self::Pending { verified_old_sessions: None, .. } => {
                Some(SocketTransitionNextAction::InspectOldSessions)
            }
            Self::Pending { .. } => Some(SocketTransitionNextAction::CleanOldSessions),
            Self::CleaningOld { sessions, .. }
                if sessions
                    .iter()
                    .all(|record| record.status == CleanupSessionStatus::Completed) =>
            {
                Some(SocketTransitionNextAction::FinishOldCleanup)
            }
            Self::CleaningOld { .. } => Some(SocketTransitionNextAction::CleanOldSessions),
            Self::OldCleaned { .. } => Some(SocketTransitionNextAction::RecreateSessions),
            Self::RecreationPending { sessions, .. }
                if sessions
                    .iter()
                    .all(|record| record.status == RecreationSessionStatus::Completed) =>
            {
                Some(SocketTransitionNextAction::FinishRecreation)
            }
            Self::RecreationPending { .. } => Some(SocketTransitionNextAction::RecreateSessions),
        }
    }
}

fn validate_cleanup_sessions(sessions: &[CleanupSessionRecord]) -> Result<(), StateError> {
    let records = sessions.iter().map(|record| &record.session).collect::<Vec<_>>();
    validate_unique_sessions(&records)
}

fn validate_recreation_sessions(sessions: &[RecreationSessionRecord]) -> Result<(), StateError> {
    let records = sessions.iter().map(|record| &record.session).collect::<Vec<_>>();
    validate_unique_sessions(&records)
}

fn same_terminal_set<'a>(
    required: &RequiredTerminalSet,
    sessions: impl IntoIterator<Item = &'a OwnedSessionRecord>,
) -> bool {
    required.sessions.iter().cloned().collect::<BTreeSet<_>>()
        == sessions.into_iter().cloned().collect::<BTreeSet<_>>()
}

/// Effective socket and transition state persisted with the app state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TmuxState {
    #[serde(default = "default_tmux_socket_name")]
    pub effective_socket_name: String,
    #[serde(default)]
    pub transition: SocketTransitionState,
}

fn default_tmux_socket_name() -> String {
    DEFAULT_TMUX_SOCKET_NAME.to_owned()
}

impl Default for TmuxState {
    fn default() -> Self {
        Self {
            effective_socket_name: DEFAULT_TMUX_SOCKET_NAME.to_owned(),
            transition: SocketTransitionState::Stable,
        }
    }
}

impl TmuxState {
    pub fn validate(&self) -> Result<(), StateError> {
        self.transition.validate(&self.effective_socket_name)
    }

    pub fn request_socket_change(
        &mut self,
        requested: impl Into<String>,
        required: RequiredTerminalSet,
    ) -> Result<bool, StateError> {
        let requested = requested.into();
        validate_socket_name(&requested)?;
        required.validate()?;
        if requested == self.effective_socket_name {
            return match self.transition {
                SocketTransitionState::Stable => Ok(false),
                SocketTransitionState::Pending { .. } => {
                    self.transition = SocketTransitionState::Stable;
                    Ok(true)
                }
                SocketTransitionState::CleaningOld { .. }
                | SocketTransitionState::OldCleaned { .. }
                | SocketTransitionState::RecreationPending { .. } => {
                    Err(state_error(StateErrorCode::InvalidTransition))
                }
            };
        }
        match &self.transition {
            SocketTransitionState::Stable | SocketTransitionState::Pending { .. } => {
                let preflight = match &self.transition {
                    SocketTransitionState::Pending {
                        requested_socket_name: previous_requested,
                        required: previous_required,
                        preflight,
                        ..
                    } if previous_requested == &requested && previous_required == &required => {
                        *preflight
                    }
                    _ => SocketTargetPreflightState::NotChecked,
                };
                let verified_old_sessions = match &self.transition {
                    SocketTransitionState::Pending {
                        requested_socket_name: previous_requested,
                        required: previous_required,
                        verified_old_sessions,
                        ..
                    } if previous_requested == &requested && previous_required == &required => {
                        verified_old_sessions.clone()
                    }
                    _ => None,
                };
                let next = SocketTransitionState::Pending {
                    requested_socket_name: requested,
                    required,
                    preflight,
                    verified_old_sessions,
                };
                let changed = self.transition != next;
                self.transition = next;
                Ok(changed)
            }
            SocketTransitionState::CleaningOld { .. }
            | SocketTransitionState::OldCleaned { .. }
            | SocketTransitionState::RecreationPending { .. } => {
                Err(state_error(StateErrorCode::InvalidTransition))
            }
        }
    }

    pub fn record_target_preflight(
        &mut self,
        outcome: SocketTargetPreflightState,
    ) -> Result<bool, StateError> {
        let preflight = match &mut self.transition {
            SocketTransitionState::Pending { preflight, verified_old_sessions, .. } => {
                if *preflight != outcome {
                    *verified_old_sessions = None;
                }
                preflight
            }
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let changed = *preflight != outcome;
        *preflight = outcome;
        Ok(changed)
    }

    /// Persists the complete provider-verified marked-session inventory from
    /// the old effective socket. This inventory is intentionally allowed to
    /// contain sessions for Workspaces that are no longer open: those are
    /// cleanup-only records and must be destroyed before activation. Unknown
    /// sessions never cross this seam.
    pub fn record_verified_old_sessions(
        &mut self,
        sessions: impl IntoIterator<Item = OwnedSessionRecord>,
    ) -> Result<bool, StateError> {
        let pending = match &mut self.transition {
            SocketTransitionState::Pending { verified_old_sessions, preflight, .. } => {
                if !preflight.is_valid_target() {
                    return Err(state_error(StateErrorCode::InvalidTransition));
                }
                verified_old_sessions
            }
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let sessions = sessions.into_iter().collect::<Vec<_>>();
        let refs = sessions.iter().collect::<Vec<_>>();
        validate_unique_sessions(&refs)?;
        let next = Some(sessions);
        let changed = *pending != next;
        *pending = next;
        Ok(changed)
    }

    pub fn start_cleaning_old(&mut self) -> Result<bool, StateError> {
        let (requested, required, preflight, verified_old_sessions) = match &self.transition {
            SocketTransitionState::Pending {
                requested_socket_name,
                required,
                preflight,
                verified_old_sessions: Some(sessions),
            } => (requested_socket_name.clone(), required.clone(), *preflight, sessions.clone()),
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        if !preflight.is_valid_target() {
            return Err(state_error(StateErrorCode::InvalidTransition));
        }
        let records = verified_old_sessions
            .into_iter()
            .map(|session| CleanupSessionRecord { session, status: CleanupSessionStatus::Pending })
            .collect();
        let next = SocketTransitionState::CleaningOld {
            old_socket_name: self.effective_socket_name.clone(),
            requested_socket_name: requested,
            required,
            target_preflight: preflight,
            sessions: records,
        };
        let changed = self.transition != next;
        self.transition = next;
        Ok(changed)
    }

    /// Returns a not-yet-destructive cleanup plan to Pending after a fresh
    /// provider recheck changed either the requested target or the exact old
    /// inventory.  The caller persists this value before reporting a stale
    /// confirmation; no cleanup record is carried across the boundary because
    /// the provider result is the new inspection cursor.
    pub fn return_cleaning_to_pending(
        &mut self,
        preflight: SocketTargetPreflightState,
        verified_old_sessions: Option<Vec<OwnedSessionRecord>>,
    ) -> Result<bool, StateError> {
        let (requested_socket_name, required) = match &self.transition {
            SocketTransitionState::CleaningOld { requested_socket_name, required, .. } => {
                (requested_socket_name.clone(), required.clone())
            }
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let verified_old_sessions = if preflight.is_valid_target() {
            let sessions =
                verified_old_sessions.ok_or_else(|| state_error(StateErrorCode::InvalidState))?;
            let refs = sessions.iter().collect::<Vec<_>>();
            validate_unique_sessions(&refs)?;
            Some(sessions)
        } else {
            None
        };
        let next = SocketTransitionState::Pending {
            requested_socket_name,
            required,
            preflight,
            verified_old_sessions,
        };
        let changed = self.transition != next;
        self.transition = next;
        Ok(changed)
    }

    /// Reconciles a fresh exact inventory with the persisted cleanup ledger.
    /// A missing exact record is complete (idempotent retry), a still-present
    /// record becomes Pending again, and a newly discovered marked session is
    /// appended as a cleanup-only record. Unknown sessions are not represented
    /// and therefore cannot become kill targets.
    pub fn reconcile_old_sessions(
        &mut self,
        observed: impl IntoIterator<Item = OwnedSessionRecord>,
    ) -> Result<bool, StateError> {
        let observed = observed.into_iter().collect::<Vec<_>>();
        let refs = observed.iter().collect::<Vec<_>>();
        validate_unique_sessions(&refs)?;
        let transition = match &mut self.transition {
            SocketTransitionState::CleaningOld { sessions, .. } => sessions,
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let observed_by_name = observed
            .iter()
            .map(|session| (session.session_name(), session))
            .collect::<BTreeMap<_, _>>();
        let mut changed = false;
        for record in transition.iter_mut() {
            match observed_by_name.get(record.session.session_name()) {
                Some(observed) if **observed == record.session => {
                    // A failed attempt remains failed so the operation can
                    // stop with a durable Retry point. A Completed or
                    // Conflict record appearing again with the exact
                    // metadata is safe to retry.
                    if matches!(
                        record.status,
                        CleanupSessionStatus::Completed | CleanupSessionStatus::Conflict
                    ) {
                        record.status = CleanupSessionStatus::Pending;
                        changed = true;
                    }
                }
                Some(_) => {
                    // Same-name replacement is not an orphan and must never
                    // be appended as a second durable record. Persist the
                    // conflict on the original record and leave the provider
                    // session untouched until a later exact reinspection.
                    if record.status != CleanupSessionStatus::Conflict {
                        record.status = CleanupSessionStatus::Conflict;
                        changed = true;
                    }
                }
                None => {
                    // Missing exact records are idempotently complete. This
                    // also resolves a prior same-name conflict once the
                    // replacement has disappeared.
                    if record.status != CleanupSessionStatus::Completed {
                        record.status = CleanupSessionStatus::Completed;
                        changed = true;
                    }
                }
            }
        }
        for session in observed {
            if !transition
                .iter()
                .any(|record| record.session.session_name() == session.session_name())
            {
                transition
                    .push(CleanupSessionRecord { session, status: CleanupSessionStatus::Pending });
                changed = true;
            }
        }
        transition.sort_by(|left, right| left.session.cmp(&right.session));
        Ok(changed)
    }

    pub fn mark_old_session(
        &mut self,
        session_name: &str,
        status: CleanupSessionStatus,
    ) -> Result<bool, StateError> {
        let transition = match &mut self.transition {
            SocketTransitionState::CleaningOld { sessions, .. } => sessions,
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let record = transition
            .iter_mut()
            .find(|record| record.session.session_name() == session_name)
            .ok_or_else(|| state_error(StateErrorCode::InvalidTransition))?;
        if record.status == status {
            return Ok(false);
        }
        let valid = match (record.status, status) {
            (CleanupSessionStatus::Pending, CleanupSessionStatus::Completed)
            | (CleanupSessionStatus::Pending, CleanupSessionStatus::Failed)
            // A provider may complete an idempotent retry before the state
            // writer gets a chance to record the intermediate pending step.
            | (CleanupSessionStatus::Failed, CleanupSessionStatus::Completed) => true,
            _ => false,
        };
        if !valid {
            return Err(state_error(StateErrorCode::InvalidTransition));
        }
        record.status = status;
        Ok(true)
    }

    /// Records a fresh target probe while retaining the confirmed cleanup
    /// ledger. This is used by a partially completed transition: a valid
    /// Absent/DevHubEmpty change is safe to adopt, while a conflict remains a
    /// durable pause until a later probe recovers it.
    pub fn update_cleaning_target_preflight(
        &mut self,
        preflight: SocketTargetPreflightState,
    ) -> Result<bool, StateError> {
        let target_preflight = match &mut self.transition {
            SocketTransitionState::CleaningOld { target_preflight, .. } => target_preflight,
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let changed = *target_preflight != preflight;
        *target_preflight = preflight;
        Ok(changed)
    }

    pub fn retry_old_cleanup(&mut self) -> Result<bool, StateError> {
        let sessions = match &mut self.transition {
            SocketTransitionState::CleaningOld { sessions, .. } => sessions,
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let mut changed = false;
        for session in sessions {
            if session.status == CleanupSessionStatus::Failed {
                session.status = CleanupSessionStatus::Pending;
                changed = true;
            }
        }
        Ok(changed)
    }

    pub fn finish_old_cleanup(&mut self) -> Result<bool, StateError> {
        let (old_socket_name, new_socket_name, required, complete) = match &self.transition {
            SocketTransitionState::CleaningOld {
                old_socket_name,
                requested_socket_name,
                required,
                sessions,
                ..
            } => (
                old_socket_name.clone(),
                requested_socket_name.clone(),
                required.clone(),
                sessions.iter().all(|record| record.status == CleanupSessionStatus::Completed),
            ),
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        if !complete {
            return Err(state_error(StateErrorCode::InvalidTransition));
        }
        self.transition =
            SocketTransitionState::OldCleaned { old_socket_name, new_socket_name, required };
        Ok(true)
    }

    /// Atomically records the new effective socket and the full recreation
    /// list. The caller persists this value in one state-file commit before
    /// creating any fresh sessions.
    pub fn commit_new_socket(&mut self) -> Result<bool, StateError> {
        let (new_socket_name, required) = match &self.transition {
            SocketTransitionState::OldCleaned { new_socket_name, required, .. } => {
                (new_socket_name.clone(), required.clone())
            }
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let records = required
            .sessions()
            .iter()
            .cloned()
            .map(|session| RecreationSessionRecord {
                session,
                status: RecreationSessionStatus::Pending,
            })
            .collect::<Vec<_>>();
        self.effective_socket_name = new_socket_name.clone();
        self.transition = SocketTransitionState::RecreationPending {
            effective_socket_name: new_socket_name,
            required,
            sessions: records,
        };
        Ok(true)
    }

    pub fn mark_recreated(
        &mut self,
        session_name: &str,
        status: RecreationSessionStatus,
    ) -> Result<bool, StateError> {
        let sessions = match &mut self.transition {
            SocketTransitionState::RecreationPending { sessions, .. } => sessions,
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let record = sessions
            .iter_mut()
            .find(|record| record.session.session_name() == session_name)
            .ok_or_else(|| state_error(StateErrorCode::InvalidTransition))?;
        if record.status == status {
            return Ok(false);
        }
        let valid = match (record.status, status) {
            (RecreationSessionStatus::Pending, RecreationSessionStatus::Completed)
            | (RecreationSessionStatus::Pending, RecreationSessionStatus::Failed)
            // A provider may complete an idempotent retry before the state
            // writer gets a chance to record the intermediate pending step.
            | (RecreationSessionStatus::Failed, RecreationSessionStatus::Completed) => true,
            _ => false,
        };
        if !valid {
            return Err(state_error(StateErrorCode::InvalidTransition));
        }
        record.status = status;
        Ok(true)
    }

    pub fn retry_recreation(&mut self) -> Result<bool, StateError> {
        let sessions = match &mut self.transition {
            SocketTransitionState::RecreationPending { sessions, .. } => sessions,
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let mut changed = false;
        for session in sessions {
            if session.status == RecreationSessionStatus::Failed {
                session.status = RecreationSessionStatus::Pending;
                changed = true;
            }
        }
        Ok(changed)
    }

    pub fn finish_recreation(&mut self) -> Result<bool, StateError> {
        let complete = match &self.transition {
            SocketTransitionState::RecreationPending { sessions, .. } => {
                sessions.iter().all(|session| session.status == RecreationSessionStatus::Completed)
            }
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        if !complete {
            return Err(state_error(StateErrorCode::InvalidTransition));
        }
        self.transition = SocketTransitionState::Stable;
        Ok(true)
    }
}

fn validate_unique_sessions(sessions: &[&OwnedSessionRecord]) -> Result<(), StateError> {
    let mut names = BTreeSet::new();
    for session in sessions {
        session.validate()?;
        if !names.insert(session.session_name()) {
            return Err(state_error(StateErrorCode::InvalidState));
        }
    }
    Ok(())
}

/// The complete schema-versioned state document.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedAppState {
    pub schema_version: u16,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceStateRecord>,
    #[serde(default)]
    pub navigation: NavigationState,
    #[serde(default)]
    pub sidebar: SidebarState,
    #[serde(default)]
    pub window: WindowState,
    #[serde(default)]
    pub tmux: TmuxState,
    #[serde(default)]
    pub shutdown: ShutdownMetadata,
}

impl fmt::Debug for PersistedAppState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PersistedAppState")
            .field("schema_version", &self.schema_version)
            .field("workspaces", &self.workspaces)
            .field("navigation", &self.navigation)
            .field("sidebar", &self.sidebar)
            .field("window", &self.window)
            .field("tmux", &self.tmux)
            .field("shutdown", &self.shutdown)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NavigationState {
    #[serde(default)]
    pub context: NavigationContextRecord,
    #[serde(default)]
    pub activity: ActivityRecord,
}

impl Default for NavigationState {
    fn default() -> Self {
        Self { context: NavigationContextRecord::Global, activity: ActivityRecord::Terminal }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowState {
    #[serde(default)]
    pub frame: WindowFrame,
}

impl Default for PersistedAppState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            workspaces: Vec::new(),
            navigation: NavigationState::default(),
            sidebar: SidebarState::default(),
            window: WindowState::default(),
            tmux: TmuxState::default(),
            shutdown: ShutdownMetadata::default(),
        }
    }
}

impl PersistedAppState {
    pub fn validate(&self) -> Result<(), StateError> {
        if self.schema_version != STATE_SCHEMA_VERSION {
            return Err(state_error(StateErrorCode::UnsupportedSchemaVersion));
        }
        let mut workspace_ids = BTreeSet::new();
        let mut canonical_paths = BTreeSet::new();
        let mut agent_ids = BTreeSet::new();
        for workspace in &self.workspaces {
            workspace.validate()?;
            if !workspace_ids.insert(workspace.workspace_id.clone())
                || !canonical_paths.insert(normalize_path_string(&workspace.canonical_path))
            {
                return Err(state_error(StateErrorCode::InvalidState));
            }
            for agent in &workspace.agents {
                if !agent_ids.insert(agent.agent_id.clone()) {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
            }
        }
        self.sidebar.validate()?;
        self.window.frame.validate()?;
        self.tmux.validate()?;
        validate_tmux_ownership(&self.tmux.transition, &workspace_ids)?;
        for expanded in &self.sidebar.expanded_workspace_ids {
            if !workspace_ids.contains(expanded) {
                return Err(state_error(StateErrorCode::InvalidState));
            }
        }
        validate_navigation(&self.navigation, &workspace_ids, &agent_ids)?;
        Ok(())
    }

    pub fn fresh() -> Self {
        Self::default()
    }

    /// Hydrates the single pure application model from this validated state
    /// document. This is deliberately owned by the persistence/bootstrap
    /// boundary rather than [`AppModel`]: the domain model knows only domain
    /// values, while this module translates durable records and applies the
    /// existing navigation fallback rules.
    ///
    /// No filesystem, provider, editor, or tmux operation is performed here.
    /// Provider mappings and native runtime metadata remain in this state
    /// object for the concrete adapters that reattach after bootstrap.
    pub fn hydrate_model(
        &self,
        profiles: &[AgentProfile],
    ) -> Result<crate::snapshot::AppModel, StateError> {
        self.hydrate_model_with_repositories(profiles, &[])
    }

    /// Hydrates with a trusted repository discovery projection. A persisted
    /// repository ID is associated only when its full domain identity is
    /// available in `repositories`; an ID without that projection is retained
    /// by StateStore but not fabricated inside AppModel.
    pub fn hydrate_model_with_repositories(
        &self,
        profiles: &[AgentProfile],
        repositories: &[Repository],
    ) -> Result<crate::snapshot::AppModel, StateError> {
        self.validate()?;

        let mut profile_by_id = BTreeMap::<AgentProfileId, AgentProfile>::new();
        for profile in profiles {
            let id = profile.id().clone();
            if let Some(previous) = profile_by_id.insert(id, profile.clone()) {
                if previous != *profile {
                    return Err(state_error(StateErrorCode::InvalidState));
                }
            }
        }

        let mut model = crate::snapshot::AppModel::new();
        for repository in repositories {
            model
                .register_repository(repository.clone())
                .map_err(|_| state_error(StateErrorCode::InvalidState))?;
        }

        // `workspaces` and each `agents` vector are ordered durable records;
        // constructing in that order preserves sidebar order and ordinals.
        // All mutations target this temporary model, so no partially hydrated
        // model escapes if a later record is malformed.
        for record in &self.workspaces {
            let (workspace_id, root, selected_path) = record.to_domain_paths()?;
            let repository_id = record
                .repository_id
                .as_ref()
                .and_then(|raw| RepositoryId::from_uuid(raw.clone()).ok())
                .filter(|id| model.repository(id).is_some());
            model
                .add_workspace(crate::domain::Workspace::new(
                    workspace_id.clone(),
                    root,
                    selected_path,
                    repository_id,
                ))
                .map_err(|_| state_error(StateErrorCode::InvalidState))?;

            match &record.lifecycle {
                WorkspaceLifecycleRecord::Available => {}
                WorkspaceLifecycleRecord::Unavailable { reason } => model
                    .mark_workspace_unavailable(&workspace_id, (*reason).into())
                    .map_err(|_| state_error(StateErrorCode::InvalidState))?,
                WorkspaceLifecycleRecord::Closing { progress } => model
                    .mark_workspace_closing(
                        &workspace_id,
                        if progress.agents_step_completed {
                            CleanupProgress::after_agents(
                                progress.agents_closed,
                                progress.terminal_closed,
                                progress.editor_closed,
                            )
                        } else {
                            CleanupProgress::new(
                                progress.agents_closed,
                                progress.terminal_closed,
                                progress.editor_closed,
                            )
                        },
                    )
                    .map_err(|_| state_error(StateErrorCode::InvalidState))?,
                WorkspaceLifecycleRecord::ClosingFailed { diagnostic, progress } => model
                    .mark_workspace_closing_failed(
                        &workspace_id,
                        (*diagnostic).into(),
                        if progress.agents_step_completed {
                            CleanupProgress::after_agents(
                                progress.agents_closed,
                                progress.terminal_closed,
                                progress.editor_closed,
                            )
                        } else {
                            CleanupProgress::new(
                                progress.agents_closed,
                                progress.terminal_closed,
                                progress.editor_closed,
                            )
                        },
                    )
                    .map_err(|_| state_error(StateErrorCode::InvalidState))?,
            }

            for record in &record.agents {
                let profile_id = AgentProfileId::from_slug(record.profile_id.clone())
                    .map_err(|_| state_error(StateErrorCode::InvalidState))?;
                let (profile, status, runtime_health) = match profile_by_id.get(&profile_id) {
                    Some(configured) => {
                        // Complete records are immutable launch snapshots and
                        // never consult current Settings. The fallback is
                        // reached only for pre-snapshot records that did not
                        // persist args/env.
                        let profile = record.launch_profile(Some(configured))?;
                        (profile, record.status.into(), record.runtime_health.into())
                    }
                    None => {
                        // A Profile may be removed from Settings while its
                        // Agent remains durable. A complete snapshot still
                        // hydrates normally; only a legacy record without
                        // enough data needs an unavailable placeholder.
                        let profile = match record.launch_profile(None) {
                            Ok(profile) => profile,
                            Err(_) => {
                                let kind = record
                                    .profile_kind
                                    .map(AgentProfileKind::from)
                                    .ok_or_else(|| state_error(StateErrorCode::InvalidState))?;
                                let display_name = record
                                    .profile_display_name
                                    .as_deref()
                                    .unwrap_or(record.profile_id.as_str());
                                AgentProfile::new(
                                    profile_id.clone(),
                                    display_name,
                                    kind,
                                    Vec::new(),
                                    BTreeMap::new(),
                                )
                                .map_err(|_| state_error(StateErrorCode::InvalidState))?
                            }
                        };
                        (profile, AgentStatus::Waiting, RuntimeHealth::Unavailable)
                    }
                };
                let restore = AgentRestoreRecord::new(
                    AgentId::from_uuid(record.agent_id.clone())
                        .map_err(|_| state_error(StateErrorCode::InvalidState))?,
                    workspace_id.clone(),
                    profile,
                    record.ordinal,
                    record.temporary_name.clone(),
                    status,
                    runtime_health,
                    record.control_state.into(),
                )
                .map_err(|_| state_error(StateErrorCode::InvalidState))?;
                model
                    .restore_agent(restore)
                    .map_err(|_| state_error(StateErrorCode::InvalidState))?;
            }
        }

        let expanded = self
            .sidebar
            .expanded_workspace_ids
            .iter()
            .map(|raw| {
                WorkspaceId::from_uuid(raw.clone())
                    .map_err(|_| state_error(StateErrorCode::InvalidState))
            })
            .collect::<Result<Vec<_>, _>>()?;
        model
            .restore_sidebar(self.sidebar.width, expanded)
            .map_err(|_| state_error(StateErrorCode::InvalidState))?;

        // Resolve persisted navigation only after all identities have been
        // reconstructed. Unknown Workspace/Agent IDs use StateStore's
        // canonical fallback (next Agent, Workspace Editor, or Global).
        let navigation = self.restore_navigation()?;
        let context = navigation.context.to_domain()?;
        model.select_context(context).map_err(|_| state_error(StateErrorCode::InvalidState))?;
        let requested_activity: Activity = navigation.activity.into();
        if matches!(
            model.resolve_surface(model.selection().context(), requested_activity),
            SurfaceResolution::Enabled(_)
        ) {
            model
                .select_activity(requested_activity)
                .map_err(|_| state_error(StateErrorCode::InvalidState))?;
        }

        Ok(model)
    }

    /// Builds a new persistence document from the immutable app snapshot.
    /// This constructor is for first-run/bootstrap documents; callers
    /// updating an existing document must use [`Self::apply_snapshot`] so
    /// sidebar, Window, tmux, and shutdown metadata are retained.
    pub fn from_snapshot(snapshot: &crate::snapshot::AppSnapshot) -> Result<Self, StateError> {
        let state = Self {
            schema_version: STATE_SCHEMA_VERSION,
            workspaces: snapshot
                .workspaces()
                .iter()
                .map(|workspace| {
                    let mut record = WorkspaceStateRecord::new(
                        workspace.id().to_string(),
                        workspace
                            .selected_path()
                            .as_path()
                            .to_str()
                            .ok_or_else(|| state_error(StateErrorCode::InvalidState))?
                            .to_owned(),
                        workspace
                            .root()
                            .as_path()
                            .to_str()
                            .ok_or_else(|| state_error(StateErrorCode::InvalidState))?
                            .to_owned(),
                    )?;
                    record.repository_id = workspace.repository_id().map(ToString::to_string);
                    record.lifecycle = workspace.state().into();
                    record.agents = workspace
                        .agents()
                        .iter()
                        .map(|agent| AgentStateRecord {
                            agent_id: agent.id().to_string(),
                            workspace_id: agent.workspace_id().to_string(),
                            profile_id: agent.profile_id().to_string(),
                            profile_kind: Some(agent.profile_kind().into()),
                            profile_display_name: Some(agent.profile_display_name().to_owned()),
                            profile_args: Some(agent.profile().args().to_vec()),
                            profile_env: Some(agent.profile().env().clone()),
                            ordinal: agent.ordinal(),
                            temporary_name: Some(agent.display_name().to_owned()),
                            status: agent.status().into(),
                            runtime_health: agent.runtime_health().into(),
                            control_state: agent.control_state().into(),
                            provider_mapping: None,
                        })
                        .collect();
                    Ok(record)
                })
                .collect::<Result<Vec<_>, StateError>>()?,
            navigation: NavigationState {
                context: NavigationContextRecord::from_domain(snapshot.selected_context()),
                activity: snapshot.active_activity().into(),
            },
            sidebar: SidebarState::new(
                snapshot.sidebar().width(),
                snapshot
                    .sidebar()
                    .expanded_workspace_ids()
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            )?,
            ..Self::default()
        };
        state.validate()?;
        Ok(state)
    }

    /// Updates only the application projection fields from a new snapshot.
    /// Durable shell geometry, socket transition state, and clean-shutdown
    /// metadata belong to this document and are intentionally preserved.
    pub fn apply_snapshot(
        &mut self,
        snapshot: &crate::snapshot::AppSnapshot,
    ) -> Result<(), StateError> {
        let mut projected = Self::from_snapshot(snapshot)?;
        // The snapshot owns the live application projection. Durable
        // reattachment metadata belongs to StateStore and must survive the
        // ordinary snapshot cadence. Merge only by stable identities; any
        // Workspace/Agent absent from the new snapshot is intentionally
        // removed from the persisted open set.
        for workspace in &mut projected.workspaces {
            let Some(previous) = self
                .workspaces
                .iter()
                .find(|candidate| candidate.workspace_id == workspace.workspace_id)
            else {
                continue;
            };
            for agent in &mut workspace.agents {
                let Some(previous_agent) =
                    previous.agents.iter().find(|candidate| candidate.agent_id == agent.agent_id)
                else {
                    continue;
                };
                agent.profile_display_name = previous_agent
                    .profile_display_name
                    .clone()
                    .or_else(|| agent.profile_display_name.clone());
                agent.profile_kind = previous_agent.profile_kind.or(agent.profile_kind);
                agent.profile_args =
                    previous_agent.profile_args.clone().or_else(|| agent.profile_args.clone());
                agent.profile_env =
                    previous_agent.profile_env.clone().or_else(|| agent.profile_env.clone());
                agent.provider_mapping = previous_agent.provider_mapping.clone();
            }
        }
        self.workspaces = projected.workspaces;
        self.navigation = projected.navigation;
        self.sidebar = projected.sidebar;
        self.validate()
    }

    /// Resolve persisted selection against the records reconstructed by the
    /// provider adapters. Missing Agents fall back to their next sibling,
    /// then their Workspace Editor; missing Workspaces fall back to Global.
    pub fn restore_navigation(&self) -> Result<NavigationRestore, StateError> {
        self.validate()?;
        let workspace_ids = self
            .workspaces
            .iter()
            .map(|workspace| workspace.workspace_id.clone())
            .collect::<BTreeSet<_>>();
        let agent_ids = self
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.agents.iter().map(|agent| agent.agent_id.clone()))
            .collect::<BTreeSet<_>>();
        self.restore_navigation_for(&workspace_ids, &agent_ids)
    }

    /// Resolve selection against the identities currently reattached by the
    /// provider adapters. The persisted record remains authoritative for
    /// ordering and ownership, while the live sets describe what survived a
    /// crash or provider restart.
    pub fn restore_navigation_for(
        &self,
        live_workspace_ids: &BTreeSet<String>,
        live_agent_ids: &BTreeSet<String>,
    ) -> Result<NavigationRestore, StateError> {
        self.validate()?;
        match &self.navigation.context {
            NavigationContextRecord::Global => Ok(NavigationRestore {
                context: NavigationContextRecord::Global,
                activity: self.navigation.activity,
                changed: false,
            }),
            NavigationContextRecord::Workspace { workspace_id }
                if live_workspace_ids.contains(workspace_id) =>
            {
                Ok(NavigationRestore {
                    context: self.navigation.context.clone(),
                    activity: self.navigation.activity,
                    changed: false,
                })
            }
            NavigationContextRecord::Workspace { .. } => Ok(NavigationRestore {
                context: NavigationContextRecord::Global,
                activity: ActivityRecord::Terminal,
                changed: true,
            }),
            NavigationContextRecord::Agent { agent_id } if live_agent_ids.contains(agent_id) => {
                Ok(NavigationRestore {
                    context: self.navigation.context.clone(),
                    activity: self.navigation.activity,
                    changed: false,
                })
            }
            NavigationContextRecord::Agent { agent_id } => {
                self.restore_missing_agent(agent_id, live_workspace_ids, live_agent_ids)
            }
        }
    }

    fn restore_missing_agent(
        &self,
        missing_agent_id: &str,
        live_workspace_ids: &BTreeSet<String>,
        live_agent_ids: &BTreeSet<String>,
    ) -> Result<NavigationRestore, StateError> {
        let Some((workspace_index, agent_index)) =
            self.workspaces.iter().enumerate().find_map(|(workspace_index, workspace)| {
                workspace
                    .agents
                    .iter()
                    .position(|agent| agent.agent_id == missing_agent_id)
                    .map(|agent_index| (workspace_index, agent_index))
            })
        else {
            return Ok(NavigationRestore {
                context: NavigationContextRecord::Global,
                activity: ActivityRecord::Terminal,
                changed: true,
            });
        };
        let workspace = &self.workspaces[workspace_index];
        if !live_workspace_ids.contains(&workspace.workspace_id) {
            return Ok(NavigationRestore {
                context: NavigationContextRecord::Global,
                activity: ActivityRecord::Terminal,
                changed: true,
            });
        }
        if let Some(next_agent) = workspace
            .agents
            .iter()
            .skip(agent_index + 1)
            .find(|agent| live_agent_ids.contains(&agent.agent_id))
        {
            return Ok(NavigationRestore {
                context: NavigationContextRecord::Agent { agent_id: next_agent.agent_id.clone() },
                activity: ActivityRecord::Agent,
                changed: true,
            });
        }
        Ok(NavigationRestore {
            context: NavigationContextRecord::Workspace {
                workspace_id: workspace.workspace_id.clone(),
            },
            activity: ActivityRecord::Editor,
            changed: true,
        })
    }

    pub fn mark_starting(&mut self) -> bool {
        let previous_generation = self.shutdown.launch_generation;
        let was_clean = self.shutdown.clean;
        self.shutdown.clean = false;
        self.shutdown.launch_generation = self.shutdown.launch_generation.saturating_add(1);
        was_clean || self.shutdown.launch_generation != previous_generation
    }

    pub fn mark_clean_shutdown(&mut self) -> bool {
        if self.shutdown.clean {
            return false;
        }
        self.shutdown.clean = true;
        true
    }

    pub fn workspace_mut(&mut self, workspace_id: &str) -> Option<&mut WorkspaceStateRecord> {
        self.workspaces.iter_mut().find(|workspace| workspace.workspace_id == workspace_id)
    }

    /// Records an adapter-supplied reattachment key without giving the state
    /// layer any provider vocabulary to interpret. The mapping is durable
    /// metadata, not part of the AppSnapshot/UI projection.
    pub fn set_agent_provider_mapping(
        &mut self,
        agent_id: &AgentId,
        mapping: OpaqueProviderMapping,
    ) -> Result<bool, StateError> {
        let raw_agent_id = agent_id.as_str();
        let agent = self
            .workspaces
            .iter_mut()
            .flat_map(|workspace| workspace.agents.iter_mut())
            .find(|agent| agent.agent_id == raw_agent_id)
            .ok_or_else(|| state_error(StateErrorCode::InvalidTransition))?;
        if agent.provider_mapping.as_ref() == Some(&mapping) {
            return Ok(false);
        }
        agent.provider_mapping = Some(mapping);
        Ok(true)
    }

    /// Removes a provider mapping after a trusted runtime has proved that the
    /// corresponding resource is gone. This is idempotent for cleanup/retry.
    pub fn clear_agent_provider_mapping(&mut self, agent_id: &AgentId) -> Result<bool, StateError> {
        let raw_agent_id = agent_id.as_str();
        let agent = self
            .workspaces
            .iter_mut()
            .flat_map(|workspace| workspace.agents.iter_mut())
            .find(|agent| agent.agent_id == raw_agent_id)
            .ok_or_else(|| state_error(StateErrorCode::InvalidTransition))?;
        Ok(agent.provider_mapping.take().is_some())
    }

    /// Returns the opaque mapping for a durable Agent. Callers may pass it
    /// back to the provider adapter but must not decode or display it.
    pub fn agent_provider_mapping(&self, agent_id: &AgentId) -> Option<&OpaqueProviderMapping> {
        let raw_agent_id = agent_id.as_str();
        self.workspaces
            .iter()
            .flat_map(|workspace| workspace.agents.iter())
            .find(|agent| agent.agent_id == raw_agent_id)
            .and_then(|agent| agent.provider_mapping.as_ref())
    }

    pub fn begin_workspace_close(&mut self, workspace_id: &str) -> Result<bool, StateError> {
        let workspace = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| state_error(StateErrorCode::InvalidTransition))?;
        let next = WorkspaceLifecycleRecord::Closing {
            progress: match workspace.lifecycle {
                WorkspaceLifecycleRecord::Closing { progress }
                | WorkspaceLifecycleRecord::ClosingFailed { progress, .. } => progress,
                WorkspaceLifecycleRecord::Available => PersistedCleanupProgress::default(),
                // An unavailable root still has durable Agent/session
                // ownership to clean up. Keeping it in Closing preserves
                // the ID and both paths until the ordered cleanup commits.
                WorkspaceLifecycleRecord::Unavailable { .. } => PersistedCleanupProgress::default(),
            },
        };
        let changed = workspace.lifecycle != next;
        workspace.lifecycle = next;
        Ok(changed)
    }

    pub fn record_workspace_progress(
        &mut self,
        workspace_id: &str,
        progress: PersistedCleanupProgress,
    ) -> Result<bool, StateError> {
        let workspace = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| state_error(StateErrorCode::InvalidTransition))?;
        if progress.agents_closed > workspace.agents.len() as u32
            || (progress.editor_closed && !progress.terminal_closed)
        {
            return Err(state_error(StateErrorCode::InvalidState));
        }
        match workspace.lifecycle {
            WorkspaceLifecycleRecord::Closing { progress: previous } => {
                if progress.agents_closed < previous.agents_closed
                    || (previous.terminal_closed && !progress.terminal_closed)
                    || (previous.editor_closed && !progress.editor_closed)
                {
                    return Err(state_error(StateErrorCode::InvalidTransition));
                }
                let next = WorkspaceLifecycleRecord::Closing { progress };
                let changed = workspace.lifecycle != next;
                workspace.lifecycle = next;
                Ok(changed)
            }
            WorkspaceLifecycleRecord::ClosingFailed { .. } => {
                Err(state_error(StateErrorCode::InvalidTransition))
            }
            _ => Err(state_error(StateErrorCode::InvalidTransition)),
        }
    }

    pub fn mark_workspace_close_failed(
        &mut self,
        workspace_id: &str,
        diagnostic: DiagnosticCode,
    ) -> Result<bool, StateError> {
        let workspace = self
            .workspace_mut(workspace_id)
            .ok_or_else(|| state_error(StateErrorCode::InvalidTransition))?;
        let progress = match workspace.lifecycle {
            WorkspaceLifecycleRecord::Closing { progress }
            | WorkspaceLifecycleRecord::ClosingFailed { progress, .. } => progress,
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let next =
            WorkspaceLifecycleRecord::ClosingFailed { diagnostic: diagnostic.into(), progress };
        let changed = workspace.lifecycle != next;
        workspace.lifecycle = next;
        Ok(changed)
    }

    pub fn finish_workspace_close(&mut self, workspace_id: &str) -> Result<bool, StateError> {
        let index = self
            .workspaces
            .iter()
            .position(|workspace| workspace.workspace_id == workspace_id)
            .ok_or_else(|| state_error(StateErrorCode::InvalidTransition))?;
        let progress = match self.workspaces[index].lifecycle {
            WorkspaceLifecycleRecord::Closing { progress } => progress,
            _ => return Err(state_error(StateErrorCode::InvalidTransition)),
        };
        let had_selected_agent = match &self.navigation.context {
            NavigationContextRecord::Agent { agent_id } => {
                self.workspaces[index].agents.iter().any(|agent| &agent.agent_id == agent_id)
            }
            _ => false,
        };
        let agent_count = self.workspaces[index].agents.len() as u32;
        if progress.agents_closed < agent_count
            || !progress.terminal_closed
            || !progress.editor_closed
        {
            return Err(state_error(StateErrorCode::InvalidTransition));
        }
        self.workspaces.remove(index);
        self.sidebar.expanded_workspace_ids.retain(|id| id != workspace_id);
        self.navigation = match &self.navigation.context {
            NavigationContextRecord::Workspace { workspace_id: selected }
                if selected == workspace_id =>
            {
                NavigationState::default()
            }
            NavigationContextRecord::Agent { .. } if had_selected_agent => {
                NavigationState::default()
            }
            _ => self.navigation.clone(),
        };
        Ok(true)
    }
}

/// Navigation after applying missing-resource fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavigationRestore {
    pub context: NavigationContextRecord,
    pub activity: ActivityRecord,
    pub changed: bool,
}

fn validate_navigation(
    navigation: &NavigationState,
    _workspace_ids: &BTreeSet<String>,
    _agent_ids: &BTreeSet<String>,
) -> Result<(), StateError> {
    match &navigation.context {
        NavigationContextRecord::Global => {}
        NavigationContextRecord::Workspace { workspace_id } => {
            validate_uuid(workspace_id)?;
        }
        NavigationContextRecord::Agent { agent_id } => {
            validate_uuid(agent_id)?;
        }
    }
    Ok(())
}

fn validate_tmux_ownership(
    transition: &SocketTransitionState,
    workspace_ids: &BTreeSet<String>,
) -> Result<(), StateError> {
    let required = match transition {
        SocketTransitionState::Stable => return Ok(()),
        SocketTransitionState::Pending { required, .. }
        | SocketTransitionState::CleaningOld { required, .. }
        | SocketTransitionState::OldCleaned { required, .. }
        | SocketTransitionState::RecreationPending { required, .. } => required,
    };
    if &required.workspace_ids() != workspace_ids {
        return Err(state_error(StateErrorCode::InvalidState));
    }
    Ok(())
}

fn validate_uuid(value: &str) -> Result<(), StateError> {
    if value.len() != 36
        || value != value.to_ascii_lowercase()
        || !value.bytes().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                .then_some(byte == b'-')
                .unwrap_or_else(|| byte.is_ascii_hexdigit())
        })
    {
        return Err(state_error(StateErrorCode::InvalidState));
    }
    Ok(())
}

fn validate_slug(value: &str) -> Result<(), StateError> {
    if value.is_empty()
        || value.len() > 64
        || !value.as_bytes()[0].is_ascii_lowercase()
        || !value.as_bytes()[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
    {
        return Err(state_error(StateErrorCode::InvalidState));
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<(), StateError> {
    if value.trim().is_empty() || value.len() > MAX_AGENT_NAME_BYTES || value.contains('\0') {
        return Err(state_error(StateErrorCode::InvalidState));
    }
    Ok(())
}

fn is_environment_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

fn validate_absolute_path(value: &str) -> Result<(), StateError> {
    let path = Path::new(value);
    if value.is_empty() || value.contains('\0') || !path.is_absolute() {
        return Err(state_error(StateErrorCode::InvalidState));
    }
    Ok(())
}

fn normalize_path_string(value: &str) -> String {
    let mut normalized = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                let _ = normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

pub(crate) fn is_valid_socket_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn validate_socket_name(value: &str) -> Result<(), StateError> {
    if !is_valid_socket_name(value) {
        return Err(state_error(StateErrorCode::InvalidState));
    }
    Ok(())
}

/// Failure points are test-only seams for proving that a partially completed
/// atomic write leaves the prior committed state readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd)]
pub enum AtomicFailurePoint {
    BeforeTempWrite,
    AfterTempWrite,
    BeforeTempSync,
    AfterTempSync,
    BeforeBackupRename,
    AfterBackupRename,
    BeforePrimaryRename,
    AfterPrimaryRename,
    BeforeDirectorySync,
}

/// A filesystem-backed, schema-versioned StateStore.
pub struct JsonStateStore {
    path: PathBuf,
    failures: Mutex<BTreeSet<AtomicFailurePoint>>,
    write_lock: Mutex<()>,
}

impl fmt::Debug for JsonStateStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("JsonStateStore").finish_non_exhaustive()
    }
}

impl JsonStateStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            failures: Mutex::new(BTreeSet::new()),
            write_lock: Mutex::new(()),
        }
    }

    /// Constructs the canonical macOS application-support location. The
    /// caller supplies the home directory so tests need no global mutation.
    pub fn for_home(home: impl AsRef<Path>) -> Self {
        Self::new(home.as_ref().join("Library/Application Support/DevHub/state.json"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn backup_path(&self) -> PathBuf {
        sibling_with_suffix(&self.path, ".bak")
    }

    /// Arrange one deterministic failure. It is consumed once by `save`.
    pub fn fail_once(&self, point: AtomicFailurePoint) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.insert(point);
        }
    }

    pub fn load_state(&self) -> Result<StateLoad, StateError> {
        let _write_guard = self.write_lock.lock().map_err(|_| state_error(StateErrorCode::Io))?;
        self.load_state_locked()
    }

    fn load_state_locked(&self) -> Result<StateLoad, StateError> {
        let primary = read_candidate(&self.path)?;
        match primary {
            Candidate::Missing => self.load_backup_or_fresh(RecoveryReason::Missing, false),
            Candidate::Unsafe => Err(state_error(StateErrorCode::UnsafePath)),
            Candidate::Bytes(bytes) => match decode_state(&bytes) {
                Ok(decoded) => {
                    let state = decoded.state;
                    let migrated = decoded.migrated;
                    if migrated {
                        self.save_state_locked(&state)?;
                    }
                    Ok(StateLoad {
                        state,
                        metadata: LoadMetadata {
                            origin: StateOrigin::Primary,
                            recovery_reason: None,
                            primary_quarantined: false,
                            backup_quarantined: false,
                            migrated,
                        },
                    })
                }
                Err(DecodeError::NewerVersion) => {
                    Err(state_error(StateErrorCode::UnsupportedSchemaVersion))
                }
                Err(DecodeError::Corrupt) => {
                    let quarantined = quarantine_and_sync(&self.path).is_ok();
                    self.load_backup_or_fresh(RecoveryReason::CorruptPrimary, quarantined)
                }
            },
        }
    }

    fn load_backup_or_fresh(
        &self,
        reason: RecoveryReason,
        primary_quarantined: bool,
    ) -> Result<StateLoad, StateError> {
        match read_candidate(&self.backup_path())? {
            Candidate::Bytes(bytes) => match decode_state(&bytes) {
                Ok(decoded) => {
                    let state = decoded.state;
                    let migrated = decoded.migrated;
                    if migrated {
                        self.save_state_locked(&state)?;
                    }
                    Ok(StateLoad {
                        state,
                        metadata: LoadMetadata {
                            origin: StateOrigin::Backup,
                            recovery_reason: Some(reason),
                            primary_quarantined,
                            backup_quarantined: false,
                            migrated,
                        },
                    })
                }
                Err(DecodeError::NewerVersion) => {
                    Err(state_error(StateErrorCode::UnsupportedSchemaVersion))
                }
                Err(DecodeError::Corrupt) => {
                    let backup_quarantined = quarantine_and_sync(&self.backup_path()).is_ok();
                    Ok(StateLoad {
                        state: PersistedAppState::fresh(),
                        metadata: LoadMetadata {
                            origin: StateOrigin::Fresh,
                            recovery_reason: Some(RecoveryReason::CorruptPrimaryAndBackup),
                            primary_quarantined,
                            backup_quarantined,
                            migrated: false,
                        },
                    })
                }
            },
            Candidate::Missing => Ok(StateLoad {
                state: PersistedAppState::fresh(),
                metadata: LoadMetadata {
                    origin: StateOrigin::Fresh,
                    recovery_reason: Some(reason),
                    primary_quarantined,
                    backup_quarantined: false,
                    migrated: false,
                },
            }),
            Candidate::Unsafe => Err(state_error(StateErrorCode::UnsafePath)),
        }
    }

    pub fn save_state(&self, state: &PersistedAppState) -> Result<(), StateError> {
        let _write_guard = self.write_lock.lock().map_err(|_| state_error(StateErrorCode::Io))?;
        self.save_state_locked(state)
    }

    fn save_state_locked(&self, state: &PersistedAppState) -> Result<(), StateError> {
        state.validate()?;
        let parent = self.path.parent().ok_or_else(|| state_error(StateErrorCode::UnsafePath))?;
        ensure_directory_target(parent)?;
        fs::create_dir_all(parent).map_err(map_io_error)?;
        ensure_directory_target(parent)?;
        ensure_regular_target(&self.path)?;
        ensure_regular_target(&self.backup_path())?;

        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|_| state_error(StateErrorCode::CorruptState))?;
        let temp = temporary_path(&self.path);
        self.check_failure(AtomicFailurePoint::BeforeTempWrite)?;
        let mut file = open_private_new(&temp)?;
        file.write_all(&bytes).map_err(map_io_error)?;
        if self.should_fail(AtomicFailurePoint::AfterTempWrite) {
            let _ = fs::remove_file(&temp);
            return Err(state_error(StateErrorCode::Io));
        }
        self.check_failure(AtomicFailurePoint::BeforeTempSync)?;
        file.sync_all().map_err(map_io_error)?;
        self.check_failure(AtomicFailurePoint::AfterTempSync)?;
        drop(file);

        self.prepare_backup()?;
        self.check_failure(AtomicFailurePoint::BeforePrimaryRename)?;
        fs::rename(&temp, &self.path).map_err(map_io_error)?;
        self.check_failure(AtomicFailurePoint::AfterPrimaryRename)?;
        self.check_failure(AtomicFailurePoint::BeforeDirectorySync)?;
        sync_directory(parent)?;
        Ok(())
    }

    fn prepare_backup(&self) -> Result<(), StateError> {
        let primary = match read_candidate(&self.path)? {
            Candidate::Missing => return Ok(()),
            Candidate::Unsafe => return Err(state_error(StateErrorCode::UnsafePath)),
            Candidate::Bytes(bytes) => bytes,
        };
        match decode_state(&primary) {
            Ok(_) => {
                let backup_temp = temporary_path(&self.backup_path());
                copy_private(&self.path, &backup_temp)?;
                self.check_failure(AtomicFailurePoint::BeforeBackupRename)?;
                fs::rename(&backup_temp, self.backup_path()).map_err(map_io_error)?;
                self.check_failure(AtomicFailurePoint::AfterBackupRename)?;
                // Make the previous-primary backup durable before replacing
                // the primary. If the process dies between these renames,
                // recovery still has a known-good copy of the last commit.
                if let Some(parent) = self.path.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            }
            Err(DecodeError::NewerVersion) => {
                Err(state_error(StateErrorCode::UnsupportedSchemaVersion))
            }
            Err(DecodeError::Corrupt) => {
                quarantine_and_sync(&self.path).map_err(map_io_error)?;
                Ok(())
            }
        }
    }

    pub fn load_or_default(&self) -> Result<PersistedAppState, StateError> {
        Ok(self.load_state()?.into_state())
    }

    pub fn mark_starting(&self) -> Result<PersistedAppState, StateError> {
        let mut state = self.load_or_default()?;
        state.mark_starting();
        self.save_state(&state)?;
        Ok(state)
    }

    pub fn mark_clean_shutdown(&self) -> Result<PersistedAppState, StateError> {
        let mut state = self.load_or_default()?;
        state.mark_clean_shutdown();
        self.save_state(&state)?;
        Ok(state)
    }

    fn should_fail(&self, point: AtomicFailurePoint) -> bool {
        self.failures.lock().map(|mut failures| failures.remove(&point)).unwrap_or(false)
    }

    fn check_failure(&self, point: AtomicFailurePoint) -> Result<(), StateError> {
        if self.should_fail(point) {
            Err(state_error(StateErrorCode::Io))
        } else {
            Ok(())
        }
    }
}

/// Alias used by adapters that prefer the more explicit name.
pub type FileStateStore = JsonStateStore;
/// Alias used at the application-shell boundary where the port trait is
/// already named `StateStore`.
pub type StateStoreFile = JsonStateStore;

fn map_io_error(error: io::Error) -> StateError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        state_error(StateErrorCode::PermissionDenied)
    } else {
        state_error(StateErrorCode::Io)
    }
}

enum Candidate {
    Missing,
    Unsafe,
    Bytes(Vec<u8>),
}

fn read_candidate(path: &Path) -> Result<Candidate, StateError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Candidate::Missing),
        Err(error) => return Err(map_io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(Candidate::Unsafe);
    }
    ensure_private_permissions(&metadata)?;
    fs::read(path).map(Candidate::Bytes).map_err(map_io_error)
}

fn ensure_regular_target(path: &Path) -> Result<(), StateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(state_error(StateErrorCode::UnsafePath))
        }
        Ok(metadata) => ensure_private_permissions(&metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_io_error(error)),
    }
}

fn ensure_directory_target(path: &Path) -> Result<(), StateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(state_error(StateErrorCode::UnsafePath))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_io_error(error)),
    }
}

fn ensure_private_permissions(metadata: &fs::Metadata) -> Result<(), StateError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(state_error(StateErrorCode::UnsafePath));
        }
    }
    let _ = metadata;
    Ok(())
}

fn open_private_new(path: &Path) -> Result<File, StateError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(map_io_error)
}

fn copy_private(from: &Path, to: &Path) -> Result<(), StateError> {
    let mut source = File::open(from).map_err(map_io_error)?;
    let mut target = open_private_new(to)?;
    io::copy(&mut source, &mut target).map_err(map_io_error)?;
    target.sync_all().map_err(map_io_error)?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), StateError> {
    File::open(path).and_then(|directory| directory.sync_all()).map_err(map_io_error)
}

fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("state.json");
    path.with_file_name(format!("{file_name}{suffix}"))
}

fn temporary_path(path: &Path) -> PathBuf {
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("state.json");
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!("{file_name}.tmp.{}.{}", std::process::id(), counter))
}

fn quarantine(path: &Path) -> io::Result<()> {
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("state.json");
    for suffix in 0..1000_u32 {
        let candidate = path.with_file_name(format!("{file_name}.corrupt.{suffix}"));
        match fs::rename(path, candidate) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "quarantine slots exhausted"))
}

fn quarantine_and_sync(path: &Path) -> io::Result<()> {
    quarantine(path)?;
    if let Some(parent) = path.parent() {
        File::open(parent).and_then(|directory| directory.sync_all())?;
    }
    Ok(())
}

struct DecodedState {
    state: PersistedAppState,
    migrated: bool,
}

#[derive(Debug)]
enum DecodeError {
    Corrupt,
    NewerVersion,
}

fn decode_state(bytes: &[u8]) -> Result<DecodedState, DecodeError> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|_| DecodeError::Corrupt)?;
    let object = value.as_object_mut().ok_or(DecodeError::Corrupt)?;
    let version = object_version(object)?;
    if version > u64::from(STATE_SCHEMA_VERSION) {
        return Err(DecodeError::NewerVersion);
    }
    let migrated = version < u64::from(STATE_SCHEMA_VERSION) || object.get("version").is_some();
    if migrated {
        migrate_legacy(object);
    }
    let state: PersistedAppState =
        serde_json::from_value(value).map_err(|_| DecodeError::Corrupt)?;
    state.validate().map_err(|error| {
        if error.code() == StateErrorCode::UnsupportedSchemaVersion {
            DecodeError::NewerVersion
        } else {
            DecodeError::Corrupt
        }
    })?;
    Ok(DecodedState { state, migrated })
}

fn object_version(object: &Map<String, Value>) -> Result<u64, DecodeError> {
    let schema_version = object.get("schema_version").map(|value| value.as_u64());
    let legacy_version = object.get("version").map(|value| value.as_u64());
    match (schema_version, legacy_version) {
        (Some(Some(schema)), Some(Some(legacy))) if schema != legacy => Err(DecodeError::Corrupt),
        (Some(Some(schema)), _) | (None, Some(Some(schema))) => Ok(schema),
        // Schema version is mandatory. Version 0 is still accepted for the
        // explicit legacy shape (`version = 0`), not for an unversioned file.
        (None, None) => Err(DecodeError::Corrupt),
        _ => Err(DecodeError::Corrupt),
    }
}

fn migrate_legacy(object: &mut Map<String, Value>) {
    let version = object_version(object).unwrap_or(0);
    if version <= u64::from(STATE_SCHEMA_VERSION) {
        object.insert("schema_version".to_owned(), Value::from(STATE_SCHEMA_VERSION));
    }
    object.remove("version");
    object.entry("workspaces".to_owned()).or_insert_with(|| Value::Array(Vec::new()));
    object.entry("navigation".to_owned()).or_insert_with(
        || serde_json::json!({ "context": { "kind": "global" }, "activity": "terminal" }),
    );
    object.entry("sidebar".to_owned()).or_insert_with(
        || serde_json::json!({ "width": DEFAULT_SIDEBAR_WIDTH, "expanded_workspace_ids": [] }),
    );
    object.entry("window".to_owned()).or_insert_with(|| serde_json::json!({}));
    object.entry("tmux".to_owned()).or_insert_with(|| serde_json::json!({}));
    object.entry("shutdown".to_owned()).or_insert_with(|| serde_json::json!({}));
}

impl crate::ports::StateStore for JsonStateStore {
    fn load(
        &self,
        _cancel: crate::ports::CancellationToken,
    ) -> crate::ports::StatePortFuture<crate::ports::PersistedStateLoad> {
        let result = self.load_state();
        Box::pin(async move { result })
    }

    fn save(
        &self,
        state: crate::ports::PersistedState,
        _cancel: crate::ports::CancellationToken,
    ) -> crate::ports::StatePortFuture<()> {
        let result = self.save_state(&state);
        Box::pin(async move { result })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn uuid(seed: u8) -> String {
        format!("00000000-0000-4000-8000-{seed:012x}")
    }

    fn temp_store() -> (JsonStateStore, PathBuf) {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory =
            std::env::temp_dir().join(format!("devhub-state-test-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("state.json");
        (JsonStateStore::new(path), directory)
    }

    fn workspace(seed: u8, path: &str) -> WorkspaceStateRecord {
        WorkspaceStateRecord::new(uuid(seed), format!("{path}/selected"), path).unwrap()
    }

    fn cleanup(directory: &Path) {
        let _ = fs::remove_dir_all(directory);
    }

    fn required_set(sessions: impl IntoIterator<Item = OwnedSessionRecord>) -> RequiredTerminalSet {
        RequiredTerminalSet::new(sessions).unwrap()
    }

    fn state_result<T>(future: crate::ports::StatePortFuture<T>) -> Result<T, StateError> {
        let mut future = Box::pin(future);
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        match Future::poll(future.as_mut(), &mut context) {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("state port future unexpectedly pending"),
        }
    }

    fn ready<T>(future: crate::ports::StatePortFuture<T>) -> T {
        state_result(future).unwrap_or_else(|error| panic!("state port future failed: {error}"))
    }

    fn write_private(path: &Path, bytes: &[u8]) {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }

    #[test]
    fn default_state_is_global_scratch_and_content_free() {
        let state = PersistedAppState::fresh();
        state.validate().unwrap();
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("devhub"));
        assert!(!json.contains("provider_id"));
        assert!(!json.contains("editor_content"));
        assert!(matches!(state.navigation.context, NavigationContextRecord::Global));
        assert_eq!(state.tmux.effective_socket_name, DEFAULT_TMUX_SOCKET_NAME);
    }

    #[test]
    fn committed_v1_fixture_is_a_valid_safe_start_document() {
        let decoded = decode_state(include_bytes!("fixtures/state-v1.json")).unwrap();
        assert_eq!(decoded.state, PersistedAppState::fresh());
        assert!(!decoded.migrated);
    }

    #[test]
    fn committed_v1_agent_fixture_keeps_launch_profile_kind() {
        let decoded = decode_state(include_bytes!("fixtures/state-v1-agent.json")).unwrap();
        assert_eq!(decoded.state.workspaces.len(), 1);
        assert_eq!(
            decoded.state.workspaces[0].agents[0].profile_kind,
            Some(PersistedAgentProfileKind::Claude)
        );
        assert!(!decoded.migrated);
    }

    #[test]
    fn clean_shutdown_metadata_marks_crash_window_and_clean_exit() {
        let mut state = PersistedAppState::fresh();
        assert!(state.mark_starting());
        assert!(!state.shutdown.clean);
        assert_eq!(state.shutdown.launch_generation, 1);
        assert!(state.mark_clean_shutdown());
        assert!(!state.mark_clean_shutdown());
        assert!(state.shutdown.clean);
    }

    #[test]
    fn state_port_round_trip_preserves_the_complete_document() {
        let (store, directory) = temp_store();
        let mut state = PersistedAppState::fresh();
        let mut open_workspace = workspace(1, "/workspace");
        open_workspace.repository_id = Some(uuid(2));
        open_workspace.lifecycle = WorkspaceLifecycleRecord::ClosingFailed {
            diagnostic: PersistedDiagnosticCode::CleanupFailed,
            progress: PersistedCleanupProgress {
                agents_closed: 1,
                agents_step_completed: true,
                terminal_closed: false,
                editor_closed: false,
            },
        };
        open_workspace.agents.push(AgentStateRecord {
            agent_id: uuid(3),
            workspace_id: uuid(1),
            profile_id: "claude".into(),
            profile_kind: Some(PersistedAgentProfileKind::Claude),
            profile_display_name: Some("Claude".into()),
            profile_args: None,
            profile_env: None,
            ordinal: 2,
            temporary_name: Some("Review agent".into()),
            status: PersistedAgentStatus::Waiting,
            runtime_health: PersistedRuntimeHealth::Degraded,
            control_state: PersistedAgentControlState::StopFailed {
                diagnostic: PersistedDiagnosticCode::CleanupFailed,
            },
            provider_mapping: Some(OpaqueProviderMapping::new("opaque-reattach-key").unwrap()),
        });
        state.workspaces.push(open_workspace);
        state.sidebar.width = 300;
        state.sidebar.expanded_workspace_ids = vec![uuid(1)];
        state.window.frame.x = 24;
        state.window.frame.y = -12;
        state.window.frame.width = 1400;
        state.window.frame.height = 900;
        state.window.frame.maximized = true;
        state.navigation.context = NavigationContextRecord::Agent { agent_id: uuid(3) };
        state.navigation.activity = ActivityRecord::Agent;
        let required = required_set(vec![
            OwnedSessionRecord::Scratch { session_name: "scratch".into() },
            OwnedSessionRecord::Workspace {
                workspace_id: uuid(1),
                session_name: "ws-0123456789abcdef0123".into(),
            },
        ]);
        state.tmux.request_socket_change("next", required).unwrap();
        state.tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        state
            .tmux
            .record_verified_old_sessions([
                OwnedSessionRecord::Scratch { session_name: "scratch".into() },
                OwnedSessionRecord::Workspace {
                    workspace_id: uuid(99),
                    session_name: "ws-0123456789abcdef0123".into(),
                },
            ])
            .unwrap();
        state.tmux.start_cleaning_old().unwrap();
        state.tmux.mark_old_session("scratch", CleanupSessionStatus::Failed).unwrap();
        state.shutdown.clean = false;
        state.shutdown.launch_generation = 7;
        state.validate().unwrap();
        let operation = crate::application::OperationId::from_uuid(uuid(0)).unwrap();
        let cancel = crate::ports::CancellationToken::new(operation.clone());
        ready(<JsonStateStore as crate::ports::StateStore>::save(
            &store,
            state.clone(),
            cancel.clone(),
        ));
        let loaded = ready(<JsonStateStore as crate::ports::StateStore>::load(&store, cancel));
        assert_eq!(loaded.state(), &state);
        assert_eq!(loaded.metadata().origin(), StateOrigin::Primary);
        cleanup(&directory);
    }

    #[test]
    fn state_port_preserves_recovery_metadata_and_typed_errors() {
        let (store, directory) = temp_store();
        store.save_state(&PersistedAppState::fresh()).unwrap();
        store.save_state(&PersistedAppState::fresh()).unwrap();
        write_private(store.path(), b"corrupt");
        let operation = crate::application::OperationId::from_uuid(uuid(4)).unwrap();
        let cancel = crate::ports::CancellationToken::new(operation.clone());
        let recovered = ready(<JsonStateStore as crate::ports::StateStore>::load(&store, cancel));
        assert_eq!(recovered.metadata().origin(), StateOrigin::Backup);
        assert_eq!(recovered.metadata().recovery_reason(), Some(RecoveryReason::CorruptPrimary));

        write_private(store.path(), br#"{"schema_version":99}"#);
        let error = state_result(<JsonStateStore as crate::ports::StateStore>::load(
            &store,
            crate::ports::CancellationToken::new(operation),
        ))
        .unwrap_err();
        assert_eq!(error.code(), StateErrorCode::UnsupportedSchemaVersion);
        cleanup(&directory);
    }

    #[test]
    fn apply_snapshot_merges_durable_agent_metadata_by_stable_identity() {
        let workspace_id = WorkspaceId::from_uuid(uuid(1)).unwrap();
        let agent_id = AgentId::from_uuid(uuid(2)).unwrap();
        let mut model = crate::snapshot::AppModel::new();
        model
            .add_workspace(crate::domain::Workspace::new(
                workspace_id.clone(),
                WorkspaceRoot::new("/repo").unwrap(),
                DisplayPath::new("/repo/selected").unwrap(),
                None,
            ))
            .unwrap();
        model
            .add_agent(
                &workspace_id,
                agent_id.clone(),
                AgentProfile::new(
                    crate::domain::AgentProfileId::for_test("codex"),
                    "Codex",
                    crate::domain::AgentProfileKind::Codex,
                    Vec::new(),
                    BTreeMap::new(),
                )
                .unwrap(),
            )
            .unwrap();
        model.rename_agent(&agent_id, "Current display").unwrap();
        model
            .restore_sidebar(300, [workspace_id.clone()])
            .expect("agent workspace can be restored expanded");
        let snapshot = model.snapshot();
        let mut state = PersistedAppState::from_snapshot(&snapshot).unwrap();
        assert_eq!(state.sidebar.width, 300);
        assert_eq!(state.sidebar.expanded_workspace_ids, vec![uuid(1)]);
        assert_eq!(state.workspaces[0].agents[0].profile_display_name.as_deref(), Some("Codex"));
        state.workspaces[0].agents[0].profile_display_name = Some("Original profile".into());
        state.workspaces[0].agents[0].provider_mapping =
            Some(OpaqueProviderMapping::new("opaque-key").unwrap());
        state.workspaces[0].agents[0].status = PersistedAgentStatus::Error;

        model.restore_sidebar(320, [workspace_id.clone()]).unwrap();
        state.window.frame.width = 1_400;
        state.apply_snapshot(&model.snapshot()).unwrap();
        assert_eq!(state.sidebar.width, 320);
        assert_eq!(state.sidebar.expanded_workspace_ids, vec![uuid(1)]);
        assert_eq!(state.window.frame.width, 1_400);
        let merged = &state.workspaces[0].agents[0];
        assert_eq!(merged.profile_display_name.as_deref(), Some("Original profile"));
        assert_eq!(merged.provider_mapping.as_ref().unwrap().as_str(), "opaque-key");
        assert_eq!(merged.temporary_name.as_deref(), Some("Current display"));
        assert_eq!(merged.status, PersistedAgentStatus::Idle);

        let mut model_without_agent = crate::snapshot::AppModel::new();
        model_without_agent
            .add_workspace(crate::domain::Workspace::new(
                workspace_id,
                WorkspaceRoot::new("/repo").unwrap(),
                DisplayPath::new("/repo/selected").unwrap(),
                None,
            ))
            .unwrap();
        state.apply_snapshot(&model_without_agent.snapshot()).unwrap();
        assert!(state.workspaces[0].agents.is_empty());
    }

    #[test]
    fn debug_output_redacts_paths_and_provider_mapping_values() {
        let mut state = PersistedAppState::fresh();
        let mut record = workspace(1, "/private/repo");
        record.agents.push(AgentStateRecord {
            agent_id: uuid(2),
            workspace_id: uuid(1),
            profile_id: "codex".into(),
            profile_kind: Some(PersistedAgentProfileKind::Codex),
            profile_display_name: Some("Profile secret".into()),
            profile_args: Some(vec!["private-argument".into()]),
            profile_env: Some(BTreeMap::from([(
                "PRIVATE_TOKEN".into(),
                "private-secret-value".into(),
            )])),
            ordinal: 1,
            temporary_name: Some("Agent secret".into()),
            status: PersistedAgentStatus::Idle,
            runtime_health: PersistedRuntimeHealth::Starting,
            control_state: PersistedAgentControlState::Running,
            provider_mapping: Some(OpaqueProviderMapping::new("provider-secret").unwrap()),
        });
        state.workspaces.push(record);
        let state_debug = format!("{state:?}");
        assert!(!state_debug.contains("/private/repo"));
        assert!(!state_debug.contains("provider-secret"));
        assert!(!state_debug.contains("Profile secret"));
        assert!(!state_debug.contains("Agent secret"));
        assert!(!state_debug.contains("private-argument"));
        assert!(!state_debug.contains("private-secret-value"));

        let mapping_debug = format!("{:?}", OpaqueProviderMapping::new("provider-secret").unwrap());
        assert!(!mapping_debug.contains("provider-secret"));
        let store_debug = format!("{:?}", JsonStateStore::new("/private/state.json"));
        assert!(!store_debug.contains("/private/state.json"));
    }

    #[test]
    fn atomic_save_creates_backup_and_rejects_interrupted_primary_rename() {
        let (store, directory) = temp_store();
        let mut first = PersistedAppState::fresh();
        first.window.frame.width = 1000;
        store.save_state(&first).unwrap();
        let mut second = first.clone();
        second.window.frame.width = 1400;
        store.fail_once(AtomicFailurePoint::BeforePrimaryRename);
        assert_eq!(store.save_state(&second).unwrap_err().code(), StateErrorCode::Io);
        let loaded = store.load_state().unwrap();
        assert_eq!(loaded.state().window.frame.width, 1000);
        assert!(store.backup_path().exists());
        store.save_state(&second).unwrap();
        assert_eq!(store.load_or_default().unwrap().window.frame.width, 1400);
        let backup = JsonStateStore::new(store.backup_path()).load_or_default().unwrap();
        assert_eq!(backup.window.frame.width, 1000);
        cleanup(&directory);
    }

    #[cfg(unix)]
    #[test]
    fn committed_state_and_backup_are_owner_only_files() {
        use std::os::unix::fs::PermissionsExt;
        let (store, directory) = temp_store();
        store.save_state(&PersistedAppState::fresh()).unwrap();
        store.save_state(&PersistedAppState::fresh()).unwrap();
        assert_eq!(fs::metadata(store.path()).unwrap().permissions().mode() & 0o077, 0);
        assert_eq!(fs::metadata(store.backup_path()).unwrap().permissions().mode() & 0o077, 0);
        cleanup(&directory);
    }

    #[test]
    fn corrupt_primary_is_quarantined_and_backup_restored() {
        let (store, directory) = temp_store();
        let mut state = PersistedAppState::fresh();
        state.shutdown.launch_generation = 4;
        store.save_state(&state).unwrap();
        state.shutdown.launch_generation = 5;
        store.save_state(&state).unwrap();
        fs::write(store.path(), b"not json").unwrap();
        let loaded = store.load_state().unwrap();
        assert_eq!(loaded.metadata().origin(), StateOrigin::Backup);
        assert_eq!(loaded.state().shutdown.launch_generation, 4);
        assert!(loaded.metadata().primary_quarantined());
        assert!(directory.join("state.json.corrupt.0").exists());
        cleanup(&directory);
    }

    #[test]
    fn saving_over_corrupt_primary_quarantines_it_without_poisoning_backup() {
        let (store, directory) = temp_store();
        let mut first = PersistedAppState::fresh();
        first.window.frame.width = 1000;
        store.save_state(&first).unwrap();
        let mut second = first.clone();
        second.window.frame.width = 1100;
        store.save_state(&second).unwrap();
        write_private(store.path(), b"corrupt");
        let mut third = second.clone();
        third.window.frame.width = 1200;
        store.save_state(&third).unwrap();
        let backup = JsonStateStore::new(store.backup_path()).load_or_default().unwrap();
        assert_eq!(backup.window.frame.width, 1000);
        assert_eq!(store.load_or_default().unwrap().window.frame.width, 1200);
        cleanup(&directory);
    }

    #[test]
    fn newer_schema_is_rejected_without_fallback_or_mutation() {
        let (store, directory) = temp_store();
        write_private(store.path(), br#"{"schema_version":99}"#);
        assert_eq!(
            store.load_state().unwrap_err().code(),
            StateErrorCode::UnsupportedSchemaVersion
        );
        assert!(store.path().exists());
        cleanup(&directory);
    }

    #[test]
    fn legacy_version_migrates_with_safe_defaults() {
        let (store, directory) = temp_store();
        write_private(store.path(), br#"{"version":0,"workspaces":[]}"#);
        let loaded = store.load_state().unwrap();
        assert!(loaded.metadata().migrated());
        assert_eq!(loaded.state().schema_version, STATE_SCHEMA_VERSION);
        assert!(matches!(loaded.state().navigation.context, NavigationContextRecord::Global));
        let canonical = fs::read(store.path()).unwrap();
        let canonical: Value = serde_json::from_slice(&canonical).unwrap();
        assert_eq!(canonical.get("schema_version").and_then(Value::as_u64), Some(1));
        assert!(canonical.get("version").is_none());
        assert!(store.backup_path().exists());
        cleanup(&directory);
    }

    #[test]
    fn legacy_version_one_is_migrated_to_schema_version_one() {
        let (store, directory) = temp_store();
        write_private(store.path(), include_bytes!("fixtures/state-legacy-v1.json"));
        let loaded = store.load_state().unwrap();
        assert!(loaded.metadata().migrated());
        assert_eq!(loaded.state().schema_version, STATE_SCHEMA_VERSION);
        let canonical: Value = serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(canonical.get("schema_version").and_then(Value::as_u64), Some(1));
        assert!(canonical.get("version").is_none());
        cleanup(&directory);
    }

    #[test]
    fn migrated_backup_is_committed_without_destroying_recovery_evidence() {
        let (store, directory) = temp_store();
        write_private(&store.backup_path(), include_bytes!("fixtures/state-legacy-v1.json"));
        write_private(store.path(), b"corrupt primary");

        let loaded = store.load_state().unwrap();
        assert_eq!(loaded.metadata().origin(), StateOrigin::Backup);
        assert!(loaded.metadata().primary_quarantined());
        let canonical: Value = serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(canonical.get("schema_version").and_then(Value::as_u64), Some(1));
        assert!(canonical.get("version").is_none());
        // The old backup remains available as evidence even after the
        // recovered state is promoted to the primary.
        let backup: Value =
            serde_json::from_slice(&fs::read(store.backup_path()).unwrap()).unwrap();
        assert_eq!(backup.get("version").and_then(Value::as_u64), Some(1));
        cleanup(&directory);
    }

    #[test]
    fn unavailable_workspace_preserves_id_and_both_paths() {
        let (store, directory) = temp_store();
        let mut state = PersistedAppState::fresh();
        let mut record = workspace(1, "/missing/root");
        record.selected_path = "/missing/alias".to_owned();
        record.lifecycle =
            WorkspaceLifecycleRecord::Unavailable { reason: PersistedDiagnosticCode::RootMissing };
        state.workspaces.push(record.clone());
        state.validate().unwrap();
        store.save_state(&state).unwrap();
        let restored = store.load_or_default().unwrap();
        assert_eq!(restored.workspaces[0].workspace_id, uuid(1));
        assert_eq!(restored.workspaces[0].selected_path, "/missing/alias");
        assert_eq!(restored.workspaces[0].canonical_path, "/missing/root");
        cleanup(&directory);
    }

    #[test]
    fn navigation_fallback_and_order_are_deterministic() {
        let mut state = PersistedAppState::fresh();
        state.workspaces.push(workspace(1, "/a"));
        state.workspaces.push(workspace(2, "/b"));
        state.navigation.context = NavigationContextRecord::Workspace { workspace_id: uuid(9) };
        assert_eq!(state.restore_navigation().unwrap().context, NavigationContextRecord::Global);
        assert_eq!(state.workspaces[0].workspace_id, uuid(1));
        assert_eq!(state.workspaces[1].workspace_id, uuid(2));
    }

    #[test]
    fn state_invariants_reject_duplicate_roots_ids_and_invalid_close_order() {
        let mut duplicate_roots = PersistedAppState::fresh();
        duplicate_roots.workspaces.push(workspace(1, "/same"));
        duplicate_roots.workspaces.push(workspace(2, "/same/./"));
        assert_eq!(duplicate_roots.validate().unwrap_err().code(), StateErrorCode::InvalidState);

        let mut duplicate_agent = PersistedAppState::fresh();
        let mut first = workspace(1, "/first");
        let mut second = workspace(2, "/second");
        let agent = AgentStateRecord {
            agent_id: uuid(3),
            workspace_id: uuid(1),
            profile_id: "codex".into(),
            profile_kind: Some(PersistedAgentProfileKind::Codex),
            profile_display_name: None,
            profile_args: None,
            profile_env: None,
            ordinal: 1,
            temporary_name: None,
            status: PersistedAgentStatus::Idle,
            runtime_health: PersistedRuntimeHealth::Starting,
            control_state: PersistedAgentControlState::Running,
            provider_mapping: None,
        };
        first.agents.push(agent.clone());
        second.agents.push(AgentStateRecord { workspace_id: uuid(2), ..agent });
        duplicate_agent.workspaces.extend([first, second]);
        assert_eq!(duplicate_agent.validate().unwrap_err().code(), StateErrorCode::InvalidState);

        let mut invalid_progress = workspace(4, "/close");
        invalid_progress.lifecycle = WorkspaceLifecycleRecord::Closing {
            progress: PersistedCleanupProgress {
                agents_closed: 0,
                agents_step_completed: false,
                terminal_closed: false,
                editor_closed: true,
            },
        };
        assert_eq!(invalid_progress.validate().unwrap_err().code(), StateErrorCode::InvalidState);

        let mut regressing_cleanup = PersistedAppState::fresh();
        regressing_cleanup.workspaces.push(workspace(7, "/regress"));
        regressing_cleanup.begin_workspace_close(&uuid(7)).unwrap();
        regressing_cleanup
            .record_workspace_progress(
                &uuid(7),
                PersistedCleanupProgress {
                    agents_closed: 0,
                    agents_step_completed: false,
                    terminal_closed: true,
                    editor_closed: true,
                },
            )
            .unwrap();
        assert_eq!(
            regressing_cleanup
                .record_workspace_progress(
                    &uuid(7),
                    PersistedCleanupProgress {
                        agents_closed: 0,
                        agents_step_completed: false,
                        terminal_closed: false,
                        editor_closed: false,
                    },
                )
                .unwrap_err()
                .code(),
            StateErrorCode::InvalidTransition
        );
    }

    #[test]
    fn missing_live_agent_restores_next_sibling_then_workspace_editor() {
        let mut state = PersistedAppState::fresh();
        let mut record = workspace(1, "/a");
        for (agent_seed, ordinal) in [(2, 1), (3, 2)] {
            record.agents.push(AgentStateRecord {
                agent_id: uuid(agent_seed),
                workspace_id: uuid(1),
                profile_id: "codex".into(),
                profile_kind: Some(PersistedAgentProfileKind::Codex),
                profile_display_name: None,
                profile_args: None,
                profile_env: None,
                ordinal,
                temporary_name: None,
                status: PersistedAgentStatus::Idle,
                runtime_health: PersistedRuntimeHealth::Starting,
                control_state: PersistedAgentControlState::Running,
                provider_mapping: None,
            });
        }
        state.workspaces.push(record);
        state.navigation.context = NavigationContextRecord::Agent { agent_id: uuid(2) };
        state.navigation.activity = ActivityRecord::Agent;
        let live_workspaces = [uuid(1)].into_iter().collect();
        let live_agents = [uuid(3)].into_iter().collect();
        let restored = state.restore_navigation_for(&live_workspaces, &live_agents).unwrap();
        assert_eq!(restored.context, NavigationContextRecord::Agent { agent_id: uuid(3) });
        assert_eq!(restored.activity, ActivityRecord::Agent);

        let restored = state.restore_navigation_for(&live_workspaces, &BTreeSet::new()).unwrap();
        assert_eq!(restored.context, NavigationContextRecord::Workspace { workspace_id: uuid(1) });
        assert_eq!(restored.activity, ActivityRecord::Editor);
    }

    #[test]
    fn socket_transition_survives_each_restartable_state_and_retries_only_missing_sessions() {
        let mut tmux = TmuxState::default();
        let required =
            required_set(vec![OwnedSessionRecord::Scratch { session_name: "scratch".into() }]);
        tmux.request_socket_change("devhub-next", required).unwrap();
        tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        tmux.record_verified_old_sessions([OwnedSessionRecord::Scratch {
            session_name: "scratch".into(),
        }])
        .unwrap();
        tmux = serde_json::from_slice(&serde_json::to_vec(&tmux).unwrap()).unwrap();
        tmux.start_cleaning_old().unwrap();
        tmux = serde_json::from_slice(&serde_json::to_vec(&tmux).unwrap()).unwrap();
        tmux.mark_old_session("scratch", CleanupSessionStatus::Completed).unwrap();
        tmux.finish_old_cleanup().unwrap();
        tmux = serde_json::from_slice(&serde_json::to_vec(&tmux).unwrap()).unwrap();
        tmux.commit_new_socket().unwrap();
        assert_eq!(tmux.effective_socket_name, "devhub-next");
        tmux.mark_recreated("scratch", RecreationSessionStatus::Failed).unwrap();
        tmux = serde_json::from_slice(&serde_json::to_vec(&tmux).unwrap()).unwrap();
        tmux.retry_recreation().unwrap();
        tmux.mark_recreated("scratch", RecreationSessionStatus::Completed).unwrap();
        tmux.finish_recreation().unwrap();
        assert!(tmux.transition.is_stable());
        tmux.validate().unwrap();
    }

    #[test]
    fn all_completed_transition_records_are_restartable_finish_points() {
        let (store, directory) = temp_store();
        let mut tmux = TmuxState::default();
        let required =
            required_set(vec![OwnedSessionRecord::Scratch { session_name: "scratch".into() }]);
        tmux.request_socket_change("next", required).unwrap();
        tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        tmux.record_verified_old_sessions([OwnedSessionRecord::Scratch {
            session_name: "scratch".into(),
        }])
        .unwrap();
        tmux.start_cleaning_old().unwrap();
        tmux.mark_old_session("scratch", CleanupSessionStatus::Completed).unwrap();
        assert_eq!(
            tmux.transition.next_action(),
            Some(SocketTransitionNextAction::FinishOldCleanup)
        );
        let mut state = PersistedAppState::fresh();
        state.tmux = tmux;
        store.save_state(&state).unwrap();
        state = store.load_or_default().unwrap();
        tmux = state.tmux;
        assert_eq!(
            tmux.transition.next_action(),
            Some(SocketTransitionNextAction::FinishOldCleanup)
        );
        tmux.finish_old_cleanup().unwrap();
        tmux.commit_new_socket().unwrap();
        tmux.mark_recreated("scratch", RecreationSessionStatus::Completed).unwrap();
        assert_eq!(
            tmux.transition.next_action(),
            Some(SocketTransitionNextAction::FinishRecreation)
        );
        state.tmux = tmux;
        store.save_state(&state).unwrap();
        state = store.load_or_default().unwrap();
        tmux = state.tmux;
        assert_eq!(
            tmux.transition.next_action(),
            Some(SocketTransitionNextAction::FinishRecreation)
        );
        tmux.finish_recreation().unwrap();
        assert!(tmux.transition.is_stable());
        cleanup(&directory);
    }

    #[test]
    fn failed_old_cleanup_survives_reload_and_retries_only_failed_session() {
        let mut tmux = TmuxState::default();
        let required = required_set(vec![
            OwnedSessionRecord::Scratch { session_name: "scratch".into() },
            OwnedSessionRecord::Workspace {
                workspace_id: uuid(1),
                session_name: "ws-0123456789abcdef0123".into(),
            },
        ]);
        tmux.request_socket_change("next", required).unwrap();
        tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        tmux.record_verified_old_sessions([
            OwnedSessionRecord::Scratch { session_name: "scratch".into() },
            OwnedSessionRecord::Workspace {
                workspace_id: uuid(1),
                session_name: "ws-0123456789abcdef0123".into(),
            },
        ])
        .unwrap();
        tmux.start_cleaning_old().unwrap();
        tmux.mark_old_session("scratch", CleanupSessionStatus::Failed).unwrap();
        tmux.mark_old_session("ws-0123456789abcdef0123", CleanupSessionStatus::Completed).unwrap();
        tmux = serde_json::from_slice(&serde_json::to_vec(&tmux).unwrap()).unwrap();
        tmux.validate().unwrap();
        assert!(tmux.retry_old_cleanup().unwrap());
        assert!(matches!(
            tmux.transition,
            SocketTransitionState::CleaningOld { ref sessions, .. }
                if sessions.iter().find(|record| record.session.session_name() == "scratch").unwrap().status
                    == CleanupSessionStatus::Pending
                    && sessions.iter().find(|record| record.session.session_name() == "ws-0123456789abcdef0123").unwrap().status
                        == CleanupSessionStatus::Completed
        ));
        tmux.mark_old_session("scratch", CleanupSessionStatus::Completed).unwrap();
        tmux.finish_old_cleanup().unwrap();
    }

    #[test]
    fn target_preflight_conflicts_are_persisted_without_touching_unknown_sessions() {
        let mut tmux = TmuxState::default();
        let required =
            required_set(vec![OwnedSessionRecord::Scratch { session_name: "scratch".into() }]);
        tmux.request_socket_change("next", required.clone()).unwrap();
        assert!(matches!(
            tmux.transition,
            SocketTransitionState::Pending {
                preflight: SocketTargetPreflightState::NotChecked,
                ..
            }
        ));

        tmux.record_target_preflight(SocketTargetPreflightState::WrongMarker).unwrap();
        assert_eq!(
            tmux.start_cleaning_old().unwrap_err().code(),
            StateErrorCode::InvalidTransition
        );
        tmux.record_target_preflight(SocketTargetPreflightState::MarkedSessions).unwrap();
        assert_eq!(
            tmux.start_cleaning_old().unwrap_err().code(),
            StateErrorCode::InvalidTransition
        );

        tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        tmux.record_verified_old_sessions([OwnedSessionRecord::Scratch {
            session_name: "scratch".into(),
        }])
        .unwrap();
        tmux.start_cleaning_old().unwrap();
        assert_eq!(
            required.sessions(),
            &[OwnedSessionRecord::Scratch { session_name: "scratch".into() }]
        );
        assert!(matches!(
            tmux.transition,
            SocketTransitionState::CleaningOld { ref sessions, .. }
                if sessions.len() == 1 && sessions[0].session.session_name() == "scratch"
        ));
    }

    #[test]
    fn cleanup_inventory_is_independent_from_recreation_and_rechecks_are_restartable() {
        let required =
            required_set(vec![OwnedSessionRecord::Scratch { session_name: "scratch".into() }]);
        let orphan = OwnedSessionRecord::Workspace {
            workspace_id: uuid(99),
            session_name: "ws-0123456789abcdef0123".into(),
        };
        let mut tmux = TmuxState::default();
        tmux.request_socket_change("next", required.clone()).unwrap();
        tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        tmux.record_verified_old_sessions([
            OwnedSessionRecord::Scratch { session_name: "scratch".into() },
            orphan.clone(),
        ])
        .unwrap();
        tmux.start_cleaning_old().unwrap();
        assert_eq!(required.sessions().len(), 1);
        assert!(matches!(
            tmux.transition,
            SocketTransitionState::CleaningOld { ref sessions, .. }
                if sessions.len() == 2
        ));

        tmux.mark_old_session("scratch", CleanupSessionStatus::Completed).unwrap();
        tmux.reconcile_old_sessions([orphan.clone()]).unwrap();
        assert!(matches!(
            tmux.transition,
            SocketTransitionState::CleaningOld { ref sessions, .. }
                if sessions.len() == 2
                    && sessions.iter().any(|record| {
                        record.session == orphan && record.status == CleanupSessionStatus::Pending
                    })
        ));
        tmux.return_cleaning_to_pending(SocketTargetPreflightState::WrongMarker, None).unwrap();
        assert!(matches!(
            tmux.transition,
            SocketTransitionState::Pending {
                preflight: SocketTargetPreflightState::WrongMarker,
                verified_old_sessions: None,
                ..
            }
        ));
        tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        tmux.record_verified_old_sessions([orphan]).unwrap();
        tmux.start_cleaning_old().unwrap();
        tmux.mark_old_session("ws-0123456789abcdef0123", CleanupSessionStatus::Completed).unwrap();
        tmux.reconcile_old_sessions([]).unwrap();
        assert_eq!(
            tmux.transition.next_action(),
            Some(SocketTransitionNextAction::FinishOldCleanup)
        );

        // A partial cleanup can pause on a target conflict, but the cursor
        // remains durable and becomes resumable when a later probe is valid.
        let mut conflicted = TmuxState::default();
        conflicted
            .request_socket_change(
                "next",
                required_set(vec![OwnedSessionRecord::Scratch { session_name: "scratch".into() }]),
            )
            .unwrap();
        conflicted.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        conflicted
            .record_verified_old_sessions([OwnedSessionRecord::Scratch {
                session_name: "scratch".into(),
            }])
            .unwrap();
        conflicted.start_cleaning_old().unwrap();
        conflicted.mark_old_session("scratch", CleanupSessionStatus::Completed).unwrap();
        conflicted
            .update_cleaning_target_preflight(SocketTargetPreflightState::WrongMarker)
            .unwrap();
        conflicted.validate().unwrap();
        conflicted
            .update_cleaning_target_preflight(SocketTargetPreflightState::TargetDevhubEmpty)
            .unwrap();
        conflicted.validate().unwrap();
    }

    #[test]
    fn same_name_metadata_replacement_is_one_durable_conflict_record() {
        let original = OwnedSessionRecord::Workspace {
            workspace_id: uuid(1),
            session_name: "ws-0123456789abcdef0123".into(),
        };
        let replacement = OwnedSessionRecord::Workspace {
            workspace_id: uuid(2),
            session_name: "ws-0123456789abcdef0123".into(),
        };
        let mut tmux = TmuxState::default();
        tmux.request_socket_change(
            "next",
            required_set(vec![OwnedSessionRecord::Scratch { session_name: "scratch".into() }]),
        )
        .unwrap();
        tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        tmux.record_verified_old_sessions([original.clone()]).unwrap();
        tmux.start_cleaning_old().unwrap();

        assert!(tmux.reconcile_old_sessions([replacement]).unwrap());
        let SocketTransitionState::CleaningOld { ref sessions, .. } = tmux.transition else {
            panic!("replacement must keep cleanup paused");
        };
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session, original);
        assert_eq!(sessions[0].status, CleanupSessionStatus::Conflict);
        tmux.validate().unwrap();
        assert_eq!(
            tmux.transition.next_action(),
            Some(SocketTransitionNextAction::CleanOldSessions)
        );

        // Once the replacement disappears, the exact old record is complete;
        // no replacement record is ever appended to durable state.
        tmux.reconcile_old_sessions([]).unwrap();
        assert!(matches!(
            tmux.transition,
            SocketTransitionState::CleaningOld { ref sessions, .. }
                if sessions.len() == 1
                    && sessions[0].status == CleanupSessionStatus::Completed
        ));
    }

    #[test]
    fn required_terminal_set_rejects_duplicates_and_persisted_state_requires_open_workspaces() {
        assert_eq!(
            RequiredTerminalSet::new(vec![
                OwnedSessionRecord::Scratch { session_name: "scratch".into() },
                OwnedSessionRecord::Scratch { session_name: "scratch".into() }
            ])
            .unwrap_err()
            .code(),
            StateErrorCode::InvalidState
        );
        let mut state = PersistedAppState::fresh();
        state.workspaces.push(workspace(1, "/open"));
        let required =
            required_set(vec![OwnedSessionRecord::Scratch { session_name: "scratch".into() }]);
        state.tmux.request_socket_change("next", required).unwrap();
        state.tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        assert_eq!(state.validate().unwrap_err().code(), StateErrorCode::InvalidState);
    }

    #[test]
    fn transition_conflict_and_unknown_session_are_never_mutated() {
        let mut tmux = TmuxState::default();
        let required =
            required_set(vec![OwnedSessionRecord::Scratch { session_name: "scratch".into() }]);
        tmux.request_socket_change("other", required.clone()).unwrap();
        assert!(tmux.request_socket_change(DEFAULT_TMUX_SOCKET_NAME, required.clone()).unwrap());
        assert!(tmux.transition.is_stable());
        tmux.request_socket_change("other", required).unwrap();
        tmux.record_target_preflight(SocketTargetPreflightState::TargetAbsent).unwrap();
        tmux.record_verified_old_sessions([OwnedSessionRecord::Scratch {
            session_name: "scratch".into(),
        }])
        .unwrap();
        tmux.start_cleaning_old().unwrap();
        assert_eq!(
            tmux.mark_old_session("unknown", CleanupSessionStatus::Completed).unwrap_err().code(),
            StateErrorCode::InvalidTransition
        );
    }

    #[test]
    fn closing_failed_records_completed_steps_and_finish_requires_order() {
        let mut state = PersistedAppState::fresh();
        state.workspaces.push(workspace(1, "/a"));
        state.workspaces[0].agents.push(AgentStateRecord {
            agent_id: uuid(2),
            workspace_id: uuid(1),
            profile_id: "codex".into(),
            profile_kind: Some(PersistedAgentProfileKind::Codex),
            profile_display_name: Some("Codex".into()),
            profile_args: None,
            profile_env: None,
            ordinal: 1,
            temporary_name: None,
            status: PersistedAgentStatus::Idle,
            runtime_health: PersistedRuntimeHealth::Starting,
            control_state: PersistedAgentControlState::Running,
            provider_mapping: None,
        });
        state.validate().unwrap();
        state.begin_workspace_close(&uuid(1)).unwrap();
        state
            .record_workspace_progress(
                &uuid(1),
                PersistedCleanupProgress {
                    agents_closed: 1,
                    agents_step_completed: true,
                    terminal_closed: false,
                    editor_closed: false,
                },
            )
            .unwrap();
        state.mark_workspace_close_failed(&uuid(1), DiagnosticCode::CleanupFailed).unwrap();
        assert!(matches!(
            state.workspaces[0].lifecycle,
            WorkspaceLifecycleRecord::ClosingFailed { .. }
        ));
        state = serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        state.begin_workspace_close(&uuid(1)).unwrap();
        assert!(matches!(state.workspaces[0].lifecycle, WorkspaceLifecycleRecord::Closing { .. }));
        assert_eq!(
            state.finish_workspace_close(&uuid(1)).unwrap_err().code(),
            StateErrorCode::InvalidTransition
        );
    }

    #[test]
    fn hydrate_model_preserves_order_navigation_sidebar_and_durable_metadata() {
        use crate::domain::{AgentProfileKind, DisplayPath, RemoteIdentity, WorkspaceRoot};

        let profile = AgentProfile::new(
            AgentProfileId::for_test("codex"),
            "Codex",
            AgentProfileKind::Codex,
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let repository = Repository::new(
            RepositoryId::for_test(uuid(6)),
            RemoteIdentity::normalize("https://github.com/statiolake/devhub.git").unwrap(),
            [],
        );

        let mut first = workspace(1, "/dev/one");
        first.repository_id = Some(repository.id().to_string());
        first.agents.push(AgentStateRecord {
            agent_id: uuid(2),
            workspace_id: uuid(1),
            profile_id: "codex".into(),
            profile_kind: Some(PersistedAgentProfileKind::Codex),
            profile_display_name: Some("Recovered Codex".into()),
            profile_args: Some(Vec::new()),
            profile_env: Some(BTreeMap::new()),
            ordinal: 4,
            temporary_name: Some("Recovered Codex".into()),
            status: PersistedAgentStatus::Waiting,
            runtime_health: PersistedRuntimeHealth::Healthy,
            control_state: PersistedAgentControlState::Running,
            provider_mapping: Some(OpaqueProviderMapping::new("opaque-mapping").unwrap()),
        });
        first.agents.push(AgentStateRecord {
            agent_id: uuid(3),
            workspace_id: uuid(1),
            profile_id: "codex".into(),
            profile_kind: Some(PersistedAgentProfileKind::Codex),
            profile_display_name: None,
            profile_args: None,
            profile_env: None,
            ordinal: 5,
            temporary_name: None,
            status: PersistedAgentStatus::Idle,
            runtime_health: PersistedRuntimeHealth::Starting,
            control_state: PersistedAgentControlState::StopFailed {
                diagnostic: PersistedDiagnosticCode::CleanupFailed,
            },
            provider_mapping: None,
        });
        let mut second = workspace(4, "/dev/two");
        second.agents.push(AgentStateRecord {
            agent_id: uuid(5),
            workspace_id: uuid(4),
            profile_id: "removed-profile".into(),
            profile_kind: Some(PersistedAgentProfileKind::Claude),
            profile_display_name: Some("Removed Profile".into()),
            profile_args: None,
            profile_env: None,
            ordinal: 1,
            temporary_name: None,
            status: PersistedAgentStatus::Working,
            runtime_health: PersistedRuntimeHealth::Healthy,
            control_state: PersistedAgentControlState::Running,
            provider_mapping: None,
        });

        let mut state = PersistedAppState::fresh();
        state.workspaces = vec![first, second];
        state.sidebar = SidebarState::new(320, vec![uuid(1), uuid(4)]).unwrap();
        state.navigation = NavigationState {
            context: NavigationContextRecord::Agent { agent_id: uuid(3) },
            activity: ActivityRecord::Editor,
        };
        state.validate().unwrap();

        let model = state.hydrate_model_with_repositories(&[profile], &[repository]).unwrap();
        let snapshot = model.snapshot();
        assert_eq!(
            snapshot.workspaces().iter().map(|item| item.id().to_string()).collect::<Vec<_>>(),
            vec![uuid(1), uuid(4)]
        );
        assert_eq!(
            snapshot.workspaces()[0]
                .agents()
                .iter()
                .map(|item| item.id().to_string())
                .collect::<Vec<_>>(),
            vec![uuid(2), uuid(3)]
        );
        assert_eq!(snapshot.workspaces()[0].agents()[0].ordinal(), 4);
        assert_eq!(snapshot.workspaces()[0].agents()[0].status(), AgentStatus::Waiting);
        assert_eq!(snapshot.workspaces()[0].agents()[0].runtime_health(), RuntimeHealth::Healthy);
        assert_eq!(
            snapshot.workspaces()[0].repository_id().unwrap(),
            &RepositoryId::for_test(uuid(6))
        );
        assert!(snapshot.sidebar().is_expanded(&WorkspaceId::for_test(uuid(1))));
        assert!(snapshot.sidebar().is_expanded(&WorkspaceId::for_test(uuid(4))));
        assert_eq!(
            snapshot.selected_context(),
            &NavigationContext::Agent(AgentId::for_test(uuid(3)))
        );
        assert_eq!(snapshot.active_activity(), Activity::Editor);
        assert_eq!(snapshot.workspaces()[1].agents()[0].status(), AgentStatus::Waiting);
        assert_eq!(
            snapshot.workspaces()[1].agents()[0].runtime_health(),
            RuntimeHealth::Unavailable
        );

        let mut durable = PersistedAppState::from_snapshot(&snapshot).unwrap();
        durable.workspaces[0].agents[0].provider_mapping =
            Some(OpaqueProviderMapping::new("opaque-mapping").unwrap());
        durable.window.frame =
            WindowFrame { x: 10, y: 20, width: 1400, height: 900, maximized: true };
        durable.shutdown = ShutdownMetadata { clean: false, launch_generation: 7 };
        let expected_frame = durable.window.frame;
        let expected_shutdown = durable.shutdown;
        durable.apply_snapshot(&snapshot).unwrap();
        assert_eq!(durable.window.frame, expected_frame);
        assert_eq!(durable.shutdown, expected_shutdown);
        assert_eq!(durable.sidebar.width, 320);
        assert_eq!(durable.sidebar.expanded_workspace_ids, vec![uuid(1), uuid(4)]);
        assert_eq!(
            durable.workspaces[0].agents[0]
                .provider_mapping
                .as_ref()
                .map(OpaqueProviderMapping::as_str),
            Some("opaque-mapping")
        );

        // Keep these constructors referenced in this round-trip test to make
        // clear that only validated domain paths cross the hydration seam.
        assert_eq!(WorkspaceRoot::new("/dev/one").unwrap(), *snapshot.workspaces()[0].root());
        assert_eq!(
            DisplayPath::new("/dev/one/selected").unwrap(),
            *snapshot.workspaces()[0].selected_path()
        );
    }

    #[test]
    fn launch_profile_snapshot_survives_save_reload_and_settings_changes() {
        let workspace_id = WorkspaceId::from_uuid(uuid(1)).unwrap();
        let agent_id = AgentId::from_uuid(uuid(2)).unwrap();
        let profile_id = AgentProfileId::for_test("codex");
        let launch_profile = AgentProfile::new(
            profile_id.clone(),
            "Launch Codex",
            crate::domain::AgentProfileKind::Codex,
            vec!["--model".into(), "launch-model".into()],
            BTreeMap::from([("LAUNCH_TOKEN".into(), "launch-secret".into())]),
        )
        .unwrap();
        let profile_debug = format!("{launch_profile:?}");
        assert!(!profile_debug.contains("launch-model"));
        assert!(!profile_debug.contains("launch-secret"));
        let mut model = crate::snapshot::AppModel::new();
        model
            .add_workspace(crate::domain::Workspace::new(
                workspace_id.clone(),
                WorkspaceRoot::new("/repo/profile-snapshot").unwrap(),
                DisplayPath::new("/repo/profile-snapshot").unwrap(),
                None,
            ))
            .unwrap();
        model.add_agent(&workspace_id, agent_id.clone(), launch_profile.clone()).unwrap();

        let mut state = PersistedAppState::from_snapshot(&model.snapshot()).unwrap();
        let record = &state.workspaces[0].agents[0];
        assert_eq!(record.profile_kind, Some(PersistedAgentProfileKind::Codex));
        assert_eq!(record.profile_display_name.as_deref(), Some("Launch Codex"));
        assert_eq!(
            record.profile_args.as_ref().unwrap(),
            &vec!["--model".to_owned(), "launch-model".to_owned()]
        );
        assert_eq!(
            record.profile_env.as_ref().and_then(|env| env.get("LAUNCH_TOKEN")).map(String::as_str),
            Some("launch-secret")
        );

        let mapping = OpaqueProviderMapping::new("opaque-launch-mapping").unwrap();
        state.set_agent_provider_mapping(&agent_id, mapping).unwrap();
        let (store, directory) = temp_store();
        store.save_state(&state).unwrap();
        let reloaded = store.load_or_default().unwrap();
        assert_eq!(
            reloaded.agent_provider_mapping(&agent_id).map(OpaqueProviderMapping::as_str),
            Some("opaque-launch-mapping")
        );

        let changed_settings = AgentProfile::new(
            profile_id,
            "Changed Settings",
            crate::domain::AgentProfileKind::Claude,
            vec!["--model".into(), "changed-model".into()],
            BTreeMap::from([("LAUNCH_TOKEN".into(), "changed-secret".into())]),
        )
        .unwrap();
        let hydrated = reloaded.hydrate_model(&[changed_settings]).unwrap();
        let hydrated_snapshot = hydrated.snapshot();
        let hydrated_profile = hydrated_snapshot.workspaces()[0].agents()[0].profile();
        assert_eq!(hydrated_profile.display_name(), "Launch Codex");
        assert_eq!(hydrated_profile.kind(), crate::domain::AgentProfileKind::Codex);
        assert_eq!(hydrated_profile.args(), ["--model", "launch-model"]);
        assert_eq!(
            hydrated_profile.env().get("LAUNCH_TOKEN").map(String::as_str),
            Some("launch-secret")
        );
        cleanup(&directory);
    }

    #[test]
    fn legacy_agent_fixture_remains_hydratable_without_fabricating_snapshot_fields() {
        let decoded = decode_state(include_bytes!("fixtures/state-v1-agent.json")).unwrap();
        let record = &decoded.state.workspaces[0].agents[0];
        assert!(record.profile_args.is_none());
        assert!(record.profile_env.is_none());
        let profile = AgentProfile::new(
            AgentProfileId::for_test("claude"),
            "Current Claude",
            crate::domain::AgentProfileKind::Claude,
            vec!["--legacy".into()],
            BTreeMap::new(),
        )
        .unwrap();
        let model = decoded.state.hydrate_model(&[profile]).unwrap();
        assert_eq!(model.snapshot().workspaces()[0].agents()[0].profile().args(), ["--legacy"]);
    }

    #[test]
    fn launch_profile_snapshot_is_bounded_at_the_state_boundary() {
        let mut state = PersistedAppState::fresh();
        let mut record = workspace(1, "/repo/bounded-profile");
        record.agents.push(AgentStateRecord {
            agent_id: uuid(2),
            workspace_id: uuid(1),
            profile_id: "codex".into(),
            profile_kind: Some(PersistedAgentProfileKind::Codex),
            profile_display_name: Some("Codex".into()),
            profile_args: Some(vec!["arg".into(); MAX_AGENT_PROFILE_ARGS + 1]),
            profile_env: Some(BTreeMap::new()),
            ordinal: 1,
            temporary_name: None,
            status: PersistedAgentStatus::Idle,
            runtime_health: PersistedRuntimeHealth::Starting,
            control_state: PersistedAgentControlState::Running,
            provider_mapping: None,
        });
        state.workspaces.push(record);
        assert_eq!(state.validate().unwrap_err().code(), StateErrorCode::InvalidState);

        let mut value_bounded = PersistedAppState::fresh();
        let mut record = workspace(1, "/repo/bounded-env");
        record.agents.push(AgentStateRecord {
            agent_id: uuid(2),
            workspace_id: uuid(1),
            profile_id: "codex".into(),
            profile_kind: Some(PersistedAgentProfileKind::Codex),
            profile_display_name: Some("Codex".into()),
            profile_args: Some(Vec::new()),
            profile_env: Some(BTreeMap::from([(
                "TOKEN".into(),
                "x".repeat(MAX_AGENT_PROFILE_ENV_VALUE_BYTES + 1),
            )])),
            ordinal: 1,
            temporary_name: None,
            status: PersistedAgentStatus::Idle,
            runtime_health: PersistedRuntimeHealth::Starting,
            control_state: PersistedAgentControlState::Running,
            provider_mapping: None,
        });
        value_bounded.workspaces.push(record);
        assert_eq!(value_bounded.validate().unwrap_err().code(), StateErrorCode::InvalidState);
    }

    #[test]
    fn hydrate_model_uses_navigation_fallback_and_rejects_invalid_records_atomically() {
        use crate::domain::{AgentProfileKind, NavigationContext};

        let profile = AgentProfile::new(
            AgentProfileId::for_test("codex"),
            "Codex",
            AgentProfileKind::Codex,
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let mut state = PersistedAppState::fresh();
        state.workspaces.push(workspace(1, "/dev/one"));
        state.sidebar = SidebarState::new(248, vec![uuid(1)]).unwrap();
        state.navigation = NavigationState {
            context: NavigationContextRecord::Agent { agent_id: uuid(9) },
            activity: ActivityRecord::Agent,
        };
        state.validate().unwrap();
        let model = state.hydrate_model(&[profile]).unwrap();
        assert_eq!(model.snapshot().selected_context(), &NavigationContext::Global);
        assert_eq!(model.snapshot().active_activity(), Activity::Terminal);
        assert!(model.snapshot().sidebar().expanded_workspace_ids().is_empty());

        let mut missing_kind = state.clone();
        missing_kind.workspaces[0].agents.clear();
        missing_kind.workspaces.push({
            let mut record = workspace(2, "/dev/removed");
            record.agents.push(AgentStateRecord {
                agent_id: uuid(3),
                workspace_id: uuid(2),
                profile_id: "removed-profile".into(),
                profile_kind: None,
                profile_display_name: Some("Removed Profile".into()),
                profile_args: None,
                profile_env: None,
                ordinal: 1,
                temporary_name: None,
                status: PersistedAgentStatus::Idle,
                runtime_health: PersistedRuntimeHealth::Healthy,
                control_state: PersistedAgentControlState::Running,
                provider_mapping: None,
            });
            record
        });
        missing_kind.validate().unwrap();
        assert_eq!(
            missing_kind.hydrate_model(&[]).unwrap_err().code(),
            StateErrorCode::InvalidState
        );

        let mut invalid = state;
        invalid.workspaces[0].canonical_path = "relative/path".into();
        assert_eq!(invalid.hydrate_model(&[]).unwrap_err().code(), StateErrorCode::InvalidState);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_state_file_is_rejected_without_following_or_overwriting_target() {
        use std::os::unix::fs::symlink;
        let (store, directory) = temp_store();
        let target = directory.join("target");
        fs::write(&target, b"sentinel").unwrap();
        symlink(&target, store.path()).unwrap();
        assert_eq!(store.load_state().unwrap_err().code(), StateErrorCode::UnsafePath);
        assert_eq!(fs::read(&target).unwrap(), b"sentinel");
        cleanup(&directory);
    }
}
