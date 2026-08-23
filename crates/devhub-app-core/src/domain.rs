//! Pure DevHub domain values and lifecycle rules.
//!
//! This module deliberately has no provider, filesystem, process, or Tauri
//! dependency.  Adapters hand validated values across this seam; the domain
//! keeps identity, ownership, and lifecycle invariants in one place.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

/// Stable schema version for the pure application projection.
pub const APP_SNAPSHOT_SCHEMA_VERSION: u16 = 1;

/// Stable error codes exposed by pure domain operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DomainErrorCode {
    InvalidId,
    InvalidPath,
    InvalidRemote,
    InvalidDisplayName,
    InvalidOrdinal,
    OrdinalExhausted,
    InvalidBusyCount,
    DuplicateWorkspace,
    DuplicateWorkspaceRoot,
    DuplicateAgent,
    UnknownRepository,
    RepositoryIdentityConflict,
    RepositoryRemoteConflict,
    UnknownWorkspace,
    UnknownAgent,
    WorkspaceUnavailable,
    ActivityDisabled,
    WorkspaceNotClean,
    GlobalContextCannotClose,
    InvalidProfile,
    AgentWorkspaceMismatch,
    WorkspaceNotUnavailable,
    InvalidAgentControlTransition,
    WorkspaceHasLiveAgents,
    WorkspaceClosing,
    WorkspaceClosingFailed,
    InvalidSidebarWidth,
}

impl DomainErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidId => "INVALID_ID",
            Self::InvalidPath => "INVALID_PATH",
            Self::InvalidRemote => "INVALID_REMOTE",
            Self::InvalidDisplayName => "INVALID_DISPLAY_NAME",
            Self::InvalidOrdinal => "INVALID_ORDINAL",
            Self::OrdinalExhausted => "ORDINAL_EXHAUSTED",
            Self::InvalidBusyCount => "INVALID_BUSY_COUNT",
            Self::DuplicateWorkspace => "DUPLICATE_WORKSPACE",
            Self::DuplicateWorkspaceRoot => "DUPLICATE_WORKSPACE_ROOT",
            Self::DuplicateAgent => "DUPLICATE_AGENT",
            Self::UnknownRepository => "UNKNOWN_REPOSITORY",
            Self::RepositoryIdentityConflict => "REPOSITORY_IDENTITY_CONFLICT",
            Self::RepositoryRemoteConflict => "REPOSITORY_REMOTE_CONFLICT",
            Self::UnknownWorkspace => "UNKNOWN_WORKSPACE",
            Self::UnknownAgent => "UNKNOWN_AGENT",
            Self::WorkspaceUnavailable => "WORKSPACE_UNAVAILABLE",
            Self::ActivityDisabled => "ACTIVITY_DISABLED",
            Self::WorkspaceNotClean => "WORKSPACE_NOT_CLEAN",
            Self::GlobalContextCannotClose => "GLOBAL_CONTEXT_CANNOT_CLOSE",
            Self::InvalidProfile => "INVALID_PROFILE",
            Self::AgentWorkspaceMismatch => "AGENT_WORKSPACE_MISMATCH",
            Self::WorkspaceNotUnavailable => "WORKSPACE_NOT_UNAVAILABLE",
            Self::InvalidAgentControlTransition => "INVALID_AGENT_CONTROL_TRANSITION",
            Self::WorkspaceHasLiveAgents => "WORKSPACE_HAS_LIVE_AGENTS",
            Self::WorkspaceClosing => "WORKSPACE_CLOSING",
            Self::WorkspaceClosingFailed => "WORKSPACE_CLOSING_FAILED",
            Self::InvalidSidebarWidth => "INVALID_SIDEBAR_WIDTH",
        }
    }
}

/// A domain operation failure.  The code is stable; no provider or user
/// content is stored in the error itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DomainError {
    code: DomainErrorCode,
}

impl DomainError {
    pub const fn new(code: DomainErrorCode) -> Self {
        Self { code }
    }

    pub const fn code(self) -> DomainErrorCode {
        self.code
    }
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code.as_str())
    }
}

impl std::error::Error for DomainError {}

fn invalid(code: DomainErrorCode) -> DomainError {
    DomainError::new(code)
}

#[cfg(test)]
fn validate_identifier(raw: String) -> Result<String, DomainError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed != raw || raw.contains('\0') || raw.len() > 256 {
        return Err(invalid(DomainErrorCode::InvalidId));
    }
    Ok(raw)
}

fn validate_uuid(raw: &str) -> bool {
    raw.len() == 36
        && raw == raw.to_ascii_lowercase()
        && raw.bytes().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                .then_some(byte == b'-')
                .unwrap_or_else(|| byte.is_ascii_hexdigit())
        })
}

macro_rules! uuid_id {
    ($name:ident) => {
        /// An opaque, non-interchangeable identity value.
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            /// Validated UUID constructor for persisted production IDs.
            pub fn from_uuid(raw: impl Into<String>) -> Result<Self, DomainError> {
                let raw = raw.into();
                if !validate_uuid(&raw) {
                    return Err(invalid(DomainErrorCode::InvalidId));
                }
                Ok(Self(raw))
            }

            /// Deterministic constructor for pure tests and fixtures.  It is
            /// intentionally separate from production ID generation.
            #[cfg(test)]
            pub fn for_test(seed: impl Into<String>) -> Self {
                Self(validate_identifier(seed.into()).expect("test identity must be valid"))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = DomainError;

            fn from_str(raw: &str) -> Result<Self, Self::Err> {
                Self::from_uuid(raw)
            }
        }
    };
}

macro_rules! profile_id {
    ($name:ident) => {
        /// A validated configuration identifier, distinct from runtime UUIDs.
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn from_slug(raw: impl Into<String>) -> Result<Self, DomainError> {
                Ok(Self(validate_slug(raw.into())?))
            }

            #[cfg(test)]
            pub fn for_test(seed: impl Into<String>) -> Self {
                Self::from_slug(seed).expect("test profile identity must be a valid slug")
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = DomainError;

            fn from_str(raw: &str) -> Result<Self, Self::Err> {
                Self::from_slug(raw)
            }
        }
    };
}

uuid_id!(WorkspaceId);
uuid_id!(RepositoryId);
uuid_id!(AgentId);
profile_id!(AgentProfileId);

fn validate_slug(raw: String) -> Result<String, DomainError> {
    let bytes = raw.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        });
    if !valid {
        return Err(invalid(DomainErrorCode::InvalidId));
    }
    Ok(raw)
}

/// A selected path presented by the user.  The adapter expands `~` and
/// performs filesystem canonicalization before constructing this value.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DisplayPath(PathBuf);

impl DisplayPath {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, DomainError> {
        let path = path.into();
        validate_absolute_path(&path).map(Self)
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

/// Canonical Workspace Root.  It is the duplicate-prevention key and is
/// distinct from the owning Repository identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WorkspaceRoot(PathBuf);

impl WorkspaceRoot {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, DomainError> {
        let path = path.into();
        validate_absolute_path(&path).map(Self)
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn basename(&self) -> String {
        self.0
            .file_name()
            .and_then(|value| value.to_str().map(str::to_owned))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/".to_owned())
    }

    pub(crate) fn parent_components(&self) -> Vec<String> {
        let mut components = self
            .0
            .parent()
            .into_iter()
            .flat_map(Path::components)
            .filter_map(|component| match component {
                Component::Normal(value) => value.to_str().map(str::to_owned),
                _ => None,
            })
            .collect::<Vec<_>>();
        components.reverse();
        components
    }
}

fn validate_absolute_path(path: &Path) -> Result<PathBuf, DomainError> {
    let path_text = path.to_str().ok_or_else(|| invalid(DomainErrorCode::InvalidPath))?;
    if path_text.is_empty() || path_text.contains('\0') || !path.is_absolute() {
        return Err(invalid(DomainErrorCode::InvalidPath));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(invalid(DomainErrorCode::InvalidPath));
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    if normalized.as_os_str().is_empty() || !normalized.is_absolute() {
        return Err(invalid(DomainErrorCode::InvalidPath));
    }
    Ok(normalized)
}

/// A normalized remote identity.  Credentials, scheme, leading slash, and
/// trailing `.git` are deliberately absent so HTTPS and SSH aliases compare
/// equal without touching Git or the network.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RemoteIdentity(String);

impl RemoteIdentity {
    pub fn normalize(raw: impl AsRef<str>) -> Result<Self, DomainError> {
        let raw = raw.as_ref().trim();
        if raw.is_empty() || raw.contains('\0') {
            return Err(invalid(DomainErrorCode::InvalidRemote));
        }

        let without_query = raw.split(['?', '#']).next().unwrap_or_default();
        let (host, path, scheme) = if !without_query.contains("://") {
            if let Some((authority, path)) = without_query.split_once(':') {
                let host = authority
                    .rsplit_once('@')
                    .map(|(_, host)| host)
                    .ok_or_else(|| invalid(DomainErrorCode::InvalidRemote))?;
                (host, path, RemoteScheme::Scp)
            } else {
                let (host, path) = without_query
                    .split_once('/')
                    .ok_or_else(|| invalid(DomainErrorCode::InvalidRemote))?;
                (host, path, RemoteScheme::Bare)
            }
        } else if let Some(rest) = without_query.strip_prefix("https://") {
            let (authority, path) =
                rest.split_once('/').ok_or_else(|| invalid(DomainErrorCode::InvalidRemote))?;
            (authority.rsplit('@').next().unwrap_or_default(), path, RemoteScheme::Https)
        } else if let Some(rest) = without_query.strip_prefix("http://") {
            let (authority, path) =
                rest.split_once('/').ok_or_else(|| invalid(DomainErrorCode::InvalidRemote))?;
            (authority.rsplit('@').next().unwrap_or_default(), path, RemoteScheme::Http)
        } else if let Some(rest) = without_query.strip_prefix("ssh://") {
            let (authority, path) =
                rest.split_once('/').ok_or_else(|| invalid(DomainErrorCode::InvalidRemote))?;
            (authority.rsplit('@').next().unwrap_or_default(), path, RemoteScheme::Ssh)
        } else {
            return Err(invalid(DomainErrorCode::InvalidRemote));
        };

        let (host, port) = normalize_authority(host)?;
        let port = match (scheme.default_port(), port) {
            (Some(default), Some(actual)) if default == actual => None,
            (_, port) => port,
        };
        let path = path.trim().trim_matches('/');
        let path = path.strip_suffix(".git").unwrap_or(path);
        let host = host.trim();
        if host.is_empty()
            || path.is_empty()
            || host.chars().any(char::is_whitespace)
            || path.chars().any(char::is_whitespace)
            || path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(invalid(DomainErrorCode::InvalidRemote));
        }

        let host = host.to_ascii_lowercase();
        let normalized_path =
            if host == "github.com" { path.to_ascii_lowercase() } else { path.to_owned() };
        let authority = match port {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        Ok(Self(format!("{authority}/{normalized_path}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy)]
enum RemoteScheme {
    Bare,
    Scp,
    Http,
    Https,
    Ssh,
}

impl RemoteScheme {
    const fn default_port(self) -> Option<u16> {
        match self {
            Self::Http => Some(80),
            Self::Https => Some(443),
            Self::Ssh => Some(22),
            Self::Bare | Self::Scp => None,
        }
    }
}

fn normalize_authority(authority: &str) -> Result<(String, Option<u16>), DomainError> {
    let authority = authority.trim();
    if let Some((host, port)) = authority.rsplit_once(':') {
        if !host.is_empty() && !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) {
            let port = port.parse().map_err(|_| invalid(DomainErrorCode::InvalidRemote))?;
            return Ok((host.to_owned(), Some(port)));
        }
    }
    if authority.is_empty() {
        return Err(invalid(DomainErrorCode::InvalidRemote));
    }
    Ok((authority.to_owned(), None))
}

impl fmt::Display for RemoteIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A Git remote identity and its normalized aliases.  The actual remote
/// lookup and precedence rules belong to the repository adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repository {
    id: RepositoryId,
    primary_remote: RemoteIdentity,
    aliases: Vec<RemoteIdentity>,
}

impl Repository {
    pub fn new(
        id: RepositoryId,
        primary_remote: RemoteIdentity,
        aliases: impl IntoIterator<Item = RemoteIdentity>,
    ) -> Self {
        let mut unique = BTreeSet::new();
        unique.insert(primary_remote.clone());
        unique.extend(aliases);
        Self { id, primary_remote, aliases: unique.into_iter().collect() }
    }

    pub fn id(&self) -> &RepositoryId {
        &self.id
    }

    pub fn primary_remote(&self) -> &RemoteIdentity {
        &self.primary_remote
    }

    pub fn aliases(&self) -> &[RemoteIdentity] {
        &self.aliases
    }

    pub fn matches_remote(&self, remote: &RemoteIdentity) -> bool {
        self.aliases.iter().any(|alias| alias == remote)
    }
}

/// MVP-supported agent runtime kind.  Provider-specific IDs and protocol
/// values remain inside the AgentRuntime adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentProfileKind {
    Codex,
    Claude,
}

/// A user-configured profile snapshot.  An Agent keeps a clone at launch so
/// later profile edits do not mutate an already-running session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfile {
    id: AgentProfileId,
    display_name: String,
    kind: AgentProfileKind,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

impl AgentProfile {
    pub fn new(
        id: AgentProfileId,
        display_name: impl Into<String>,
        kind: AgentProfileKind,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    ) -> Result<Self, DomainError> {
        let display_name = display_name.into();
        if !valid_display_name(&display_name) {
            return Err(invalid(DomainErrorCode::InvalidDisplayName));
        }
        if args.iter().any(|arg| arg.contains('\0'))
            || env
                .iter()
                .any(|(key, value)| key.is_empty() || key.contains('\0') || value.contains('\0'))
        {
            return Err(invalid(DomainErrorCode::InvalidProfile));
        }
        Ok(Self { id, display_name, kind, args, env })
    }

    pub fn id(&self) -> &AgentProfileId {
        &self.id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub const fn kind(&self) -> AgentProfileKind {
        self.kind
    }

    pub fn args(&self) -> &[String] {
        &self.args
    }

    pub fn env(&self) -> &BTreeMap<String, String> {
        &self.env
    }
}

/// Product-level Agent status; this is not a provider status enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentStatus {
    Working,
    Waiting,
    Idle,
    Error,
}

/// Product-level runtime health projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuntimeHealth {
    Starting,
    Healthy,
    Degraded,
    Unavailable,
    Failed,
}

/// Provider-free observation used for one atomic Agent reconciliation. The
/// provider adapter converts its own status vocabulary before crossing this
/// domain seam.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentObservation {
    agent_id: AgentId,
    status: AgentStatus,
    runtime_health: RuntimeHealth,
}

impl AgentObservation {
    pub const fn new(
        agent_id: AgentId,
        status: AgentStatus,
        runtime_health: RuntimeHealth,
    ) -> Self {
        Self { agent_id, status, runtime_health }
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub const fn status(&self) -> AgentStatus {
        self.status
    }

    pub const fn runtime_health(&self) -> RuntimeHealth {
        self.runtime_health
    }
}

/// Complete provider reconciliation projection. Missing provider Agents are
/// represented by `exited`; observations and exits are applied atomically by
/// `AppModel` after all identities have been validated.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentReconciliation {
    observations: Vec<AgentObservation>,
    exited: Vec<AgentId>,
}

impl AgentReconciliation {
    pub fn new(
        observations: impl IntoIterator<Item = AgentObservation>,
        exited: impl IntoIterator<Item = AgentId>,
    ) -> Self {
        Self {
            observations: observations.into_iter().collect(),
            exited: exited.into_iter().collect(),
        }
    }

    pub fn observations(&self) -> &[AgentObservation] {
        &self.observations
    }

    pub fn exited(&self) -> &[AgentId] {
        &self.exited
    }
}

/// Product-level control lifecycle for an Agent. This is independent from
/// visible work status and runtime health.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentControlState {
    Running,
    Stopping,
    StopFailed { diagnostic: DiagnosticCode },
}

impl AgentControlState {
    pub const fn is_interactive(self) -> bool {
        matches!(self, Self::Running)
    }

    pub const fn can_retry_stop(self) -> bool {
        matches!(self, Self::StopFailed { .. })
    }
}

/// Validated, provider-free restoration record for an existing Agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRestoreRecord {
    id: AgentId,
    workspace_id: WorkspaceId,
    profile: AgentProfile,
    ordinal: u32,
    temporary_name: Option<String>,
    status: AgentStatus,
    runtime_health: RuntimeHealth,
    control_state: AgentControlState,
}

impl AgentRestoreRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: AgentId,
        workspace_id: WorkspaceId,
        profile: AgentProfile,
        ordinal: u32,
        temporary_name: Option<String>,
        status: AgentStatus,
        runtime_health: RuntimeHealth,
        control_state: AgentControlState,
    ) -> Result<Self, DomainError> {
        if ordinal == 0 {
            return Err(invalid(DomainErrorCode::InvalidOrdinal));
        }
        if temporary_name.as_deref().is_some_and(|name| !valid_display_name(name)) {
            return Err(invalid(DomainErrorCode::InvalidDisplayName));
        }
        Ok(Self {
            id,
            workspace_id,
            profile,
            ordinal,
            temporary_name,
            status,
            runtime_health,
            control_state,
        })
    }

    pub fn id(&self) -> &AgentId {
        &self.id
    }

    pub fn workspace_id(&self) -> &WorkspaceId {
        &self.workspace_id
    }

    pub fn profile(&self) -> &AgentProfile {
        &self.profile
    }

    pub const fn ordinal(&self) -> u32 {
        self.ordinal
    }

    pub fn temporary_name(&self) -> Option<&str> {
        self.temporary_name.as_deref()
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
}

/// Agent resource owned by exactly one Workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    id: AgentId,
    workspace_id: WorkspaceId,
    profile: AgentProfile,
    ordinal: u32,
    name_override: Option<String>,
    status: AgentStatus,
    runtime_health: RuntimeHealth,
    control_state: AgentControlState,
}

impl Agent {
    pub fn new(
        id: AgentId,
        workspace_id: WorkspaceId,
        profile: AgentProfile,
        ordinal: u32,
    ) -> Result<Self, DomainError> {
        Self::restore(AgentRestoreRecord::new(
            id,
            workspace_id,
            profile,
            ordinal,
            None,
            AgentStatus::Idle,
            RuntimeHealth::Starting,
            AgentControlState::Running,
        )?)
    }

    pub fn restore(record: AgentRestoreRecord) -> Result<Self, DomainError> {
        Ok(Self {
            id: record.id,
            workspace_id: record.workspace_id,
            profile: record.profile,
            ordinal: record.ordinal,
            name_override: record.temporary_name,
            status: record.status,
            runtime_health: record.runtime_health,
            control_state: record.control_state,
        })
    }

    pub fn id(&self) -> &AgentId {
        &self.id
    }

    pub fn workspace_id(&self) -> &WorkspaceId {
        &self.workspace_id
    }

    pub fn profile(&self) -> &AgentProfile {
        &self.profile
    }

    pub const fn ordinal(&self) -> u32 {
        self.ordinal
    }

    pub fn display_name(&self) -> String {
        self.name_override
            .clone()
            .unwrap_or_else(|| format!("{} {}", self.profile.display_name(), self.ordinal))
    }

    pub(crate) fn rename(&mut self, display_name: impl Into<String>) -> Result<bool, DomainError> {
        let display_name = display_name.into();
        if !valid_display_name(&display_name) {
            return Err(invalid(DomainErrorCode::InvalidDisplayName));
        }
        if self.name_override.as_deref() == Some(display_name.as_str()) {
            return Ok(false);
        }
        self.name_override = Some(display_name);
        Ok(true)
    }

    pub(crate) fn reset_name(&mut self) -> bool {
        if self.name_override.is_none() {
            return false;
        }
        self.name_override = None;
        true
    }

    pub const fn status(&self) -> AgentStatus {
        self.status
    }

    pub(crate) fn set_status(&mut self, status: AgentStatus) -> bool {
        if self.status == status {
            return false;
        }
        self.status = status;
        true
    }

    pub const fn runtime_health(&self) -> RuntimeHealth {
        self.runtime_health
    }

    pub(crate) fn set_runtime_health(&mut self, health: RuntimeHealth) -> bool {
        if self.runtime_health == health {
            return false;
        }
        self.runtime_health = health;
        true
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

    pub(crate) fn request_stop(&mut self) -> bool {
        if matches!(self.control_state, AgentControlState::Stopping) {
            return false;
        }
        self.control_state = AgentControlState::Stopping;
        true
    }

    pub(crate) fn mark_stop_failed(
        &mut self,
        diagnostic: DiagnosticCode,
    ) -> Result<bool, DomainError> {
        if matches!(self.control_state, AgentControlState::Running) {
            return Err(invalid(DomainErrorCode::InvalidAgentControlTransition));
        }
        let next = AgentControlState::StopFailed { diagnostic };
        if self.control_state == next {
            return Ok(false);
        }
        self.control_state = next;
        Ok(true)
    }

    pub(crate) fn return_to_running(&mut self) -> bool {
        if matches!(self.control_state, AgentControlState::Running) {
            return false;
        }
        self.control_state = AgentControlState::Running;
        true
    }
}

fn valid_display_name(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0')
}

/// Why a Workspace is unavailable or cannot finish cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DiagnosticCode {
    RootMissing,
    RootInaccessible,
    CloseAgentsUnknown,
    CloseTerminalUnknown,
    CloseEditorUnknown,
    CleanupFailed,
    RuntimeUnavailable,
}

/// Progress retained when a Workspace close partially fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupProgress {
    agents_closed: u32,
    agents_step_completed: bool,
    terminal_closed: bool,
    editor_closed: bool,
}

impl CleanupProgress {
    pub const fn new(agents_closed: u32, terminal_closed: bool, editor_closed: bool) -> Self {
        Self {
            agents_closed,
            agents_step_completed: agents_closed > 0,
            terminal_closed,
            editor_closed,
        }
    }

    pub const fn after_agents(
        agents_closed: u32,
        terminal_closed: bool,
        editor_closed: bool,
    ) -> Self {
        Self { agents_closed, agents_step_completed: true, terminal_closed, editor_closed }
    }

    pub const fn agents_closed(self) -> u32 {
        self.agents_closed
    }

    pub const fn agents_step_completed(self) -> bool {
        self.agents_step_completed
    }

    pub const fn with_terminal_closed(self, terminal_closed: bool) -> Self {
        Self { terminal_closed, ..self }
    }

    pub const fn with_editor_closed(self, editor_closed: bool) -> Self {
        Self { editor_closed, ..self }
    }

    pub const fn terminal_closed(self) -> bool {
        self.terminal_closed
    }

    pub const fn editor_closed(self) -> bool {
        self.editor_closed
    }
}

/// Workspace availability/lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceState {
    Available,
    Unavailable { reason: DiagnosticCode },
    Closing { progress: CleanupProgress },
    ClosingFailed { diagnostic: DiagnosticCode, progress: CleanupProgress },
}

impl WorkspaceState {
    pub const fn is_available(self) -> bool {
        matches!(self, Self::Available)
    }

    pub const fn is_closing(self) -> bool {
        matches!(self, Self::Closing { .. })
    }

    pub const fn cleanup_progress(self) -> Option<CleanupProgress> {
        match self {
            Self::Closing { progress } | Self::ClosingFailed { progress, .. } => Some(progress),
            Self::Available | Self::Unavailable { .. } => None,
        }
    }
}

/// A Workspace is an open context rooted at one canonical folder.  Repository
/// identity is optional and never replaces Workspace identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    id: WorkspaceId,
    root: WorkspaceRoot,
    selected_path: DisplayPath,
    repository_id: Option<RepositoryId>,
    state: WorkspaceState,
    agents: Vec<Agent>,
}

impl Workspace {
    pub fn new(
        id: WorkspaceId,
        root: WorkspaceRoot,
        selected_path: DisplayPath,
        repository_id: Option<RepositoryId>,
    ) -> Self {
        Self {
            id,
            root,
            selected_path,
            repository_id,
            state: WorkspaceState::Available,
            agents: Vec::new(),
        }
    }

    pub fn id(&self) -> &WorkspaceId {
        &self.id
    }

    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    pub fn selected_path(&self) -> &DisplayPath {
        &self.selected_path
    }

    pub fn repository_id(&self) -> Option<&RepositoryId> {
        self.repository_id.as_ref()
    }

    pub(crate) fn set_repository_id(&mut self, repository_id: Option<RepositoryId>) -> bool {
        if self.repository_id == repository_id {
            return false;
        }
        self.repository_id = repository_id;
        true
    }

    pub const fn state(&self) -> WorkspaceState {
        self.state
    }

    /// Rebinds an unavailable Workspace to a newly located canonical root
    /// while preserving its WorkspaceId and live Agent collection.
    pub(crate) fn relocate(&mut self, root: WorkspaceRoot, selected_path: DisplayPath) {
        self.root = root;
        self.selected_path = selected_path;
        self.state = WorkspaceState::Available;
    }

    pub(crate) fn mark_unavailable(&mut self, reason: DiagnosticCode) -> bool {
        let next = WorkspaceState::Unavailable { reason };
        if self.state == next {
            return false;
        }
        self.state = next;
        true
    }

    pub(crate) fn mark_available(&mut self) -> bool {
        if self.state == WorkspaceState::Available {
            return false;
        }
        self.state = WorkspaceState::Available;
        true
    }

    pub(crate) fn mark_closing_failed(
        &mut self,
        diagnostic: DiagnosticCode,
        progress: CleanupProgress,
    ) -> bool {
        let next = WorkspaceState::ClosingFailed { diagnostic, progress };
        if self.state == next {
            return false;
        }
        self.state = next;
        true
    }

    pub(crate) fn mark_closing(&mut self, progress: CleanupProgress) -> Result<bool, DomainError> {
        match self.state {
            WorkspaceState::Available | WorkspaceState::ClosingFailed { .. } => {
                let next = WorkspaceState::Closing { progress };
                if self.state == next {
                    return Ok(false);
                }
                self.state = next;
                Ok(true)
            }
            WorkspaceState::Closing { .. } => Err(invalid(DomainErrorCode::WorkspaceClosing)),
            WorkspaceState::Unavailable { .. } => {
                Err(invalid(DomainErrorCode::WorkspaceUnavailable))
            }
        }
    }

    pub(crate) fn update_closing_progress(
        &mut self,
        progress: CleanupProgress,
    ) -> Result<bool, DomainError> {
        match self.state {
            WorkspaceState::Closing { progress: current } => {
                if current == progress {
                    return Ok(false);
                }
                self.state = WorkspaceState::Closing { progress };
                Ok(true)
            }
            WorkspaceState::ClosingFailed { .. } => {
                Err(invalid(DomainErrorCode::WorkspaceClosingFailed))
            }
            WorkspaceState::Available | WorkspaceState::Unavailable { .. } => {
                Err(invalid(DomainErrorCode::WorkspaceUnavailable))
            }
        }
    }

    pub fn can_create_agent(&self) -> bool {
        self.state.is_available()
    }

    pub fn agents(&self) -> &[Agent] {
        &self.agents
    }

    pub fn agent(&self, id: &AgentId) -> Option<&Agent> {
        self.agents.iter().find(|agent| agent.id() == id)
    }

    pub(crate) fn agent_mut(&mut self, id: &AgentId) -> Option<&mut Agent> {
        self.agents.iter_mut().find(|agent| agent.id() == id)
    }

    pub(crate) fn add_agent(&mut self, agent: Agent) -> Result<(), DomainError> {
        if !self.can_create_agent() {
            return Err(invalid(DomainErrorCode::WorkspaceUnavailable));
        }
        if agent.workspace_id() != &self.id {
            return Err(invalid(DomainErrorCode::AgentWorkspaceMismatch));
        }
        if self.agent(agent.id()).is_some() {
            return Err(invalid(DomainErrorCode::DuplicateAgent));
        }
        self.agents.push(agent);
        Ok(())
    }

    pub(crate) fn restore_agent(&mut self, agent: Agent) -> Result<(), DomainError> {
        if agent.workspace_id() != &self.id {
            return Err(invalid(DomainErrorCode::AgentWorkspaceMismatch));
        }
        if self.agent(agent.id()).is_some() {
            return Err(invalid(DomainErrorCode::DuplicateAgent));
        }
        self.agents.push(agent);
        Ok(())
    }

    pub(crate) fn remove_agent(&mut self, id: &AgentId) -> Option<Agent> {
        let position = self.agents.iter().position(|agent| agent.id() == id)?;
        Some(self.agents.remove(position))
    }
}

/// The left-pane Navigation Context.  It is deliberately distinct from
/// Activity and from the concrete SurfaceKey.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum NavigationContext {
    Global,
    Workspace(WorkspaceId),
    Agent(AgentId),
}

impl NavigationContext {
    pub const fn global() -> Self {
        Self::Global
    }

    pub fn workspace(id: WorkspaceId) -> Self {
        Self::Workspace(id)
    }

    pub fn agent(id: AgentId) -> Self {
        Self::Agent(id)
    }
}

/// Fixed top-level choices.  Activities are never created or destroyed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Activity {
    Editor,
    Agent,
    Terminal,
}

impl Activity {
    pub const ALL: [Self; 3] = [Self::Editor, Self::Agent, Self::Terminal];
}

/// Why an Activity is disabled for a context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DisabledReason {
    GlobalAgentNotApplicable,
    WorkspaceAgentRequiresAgentSelection,
    WorkspaceUnavailable,
    WorkspaceClosing,
    WorkspaceClosingFailed,
}

/// An Activity's availability and semantic target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceResolution {
    Enabled(SurfaceKey),
    Disabled(DisabledReason),
}

/// Semantic DevHub surface identity.  Provider/editor IDs do not cross this
/// seam and future Bridge `surface_id` values remain separate.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SurfaceKey {
    GlobalEditor,
    GlobalTerminal,
    WorkspaceEditor(WorkspaceId),
    WorkspaceTerminal(WorkspaceId),
    Agent(AgentId),
}

/// One input to the consolidated Workspace close inspection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceInspection {
    Clean,
    Busy { count: u32 },
    Unknown { diagnostic: DiagnosticCode },
}

impl ResourceInspection {
    pub const fn clean() -> Self {
        Self::Clean
    }

    pub fn busy(count: u32) -> Result<Self, DomainError> {
        if count == 0 {
            return Err(invalid(DomainErrorCode::InvalidBusyCount));
        }
        Ok(Self::Busy { count })
    }

    pub const fn unknown(diagnostic: DiagnosticCode) -> Self {
        Self::Unknown { diagnostic }
    }
}

/// Resource counts collected before a Workspace close confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloseInspectionInputs {
    agents: ResourceInspection,
    terminal_processes: ResourceInspection,
    terminal_panes: ResourceInspection,
    terminal_windows: ResourceInspection,
    unsaved_editors: ResourceInspection,
}

impl CloseInspectionInputs {
    pub const fn new(
        agents: ResourceInspection,
        terminal_processes: ResourceInspection,
        terminal_panes: ResourceInspection,
        terminal_windows: ResourceInspection,
        unsaved_editors: ResourceInspection,
    ) -> Self {
        Self { agents, terminal_processes, terminal_panes, terminal_windows, unsaved_editors }
    }

    pub const fn clean() -> Self {
        Self::new(
            ResourceInspection::Clean,
            ResourceInspection::Clean,
            ResourceInspection::Clean,
            ResourceInspection::Clean,
            ResourceInspection::Clean,
        )
    }

    pub const fn agents(&self) -> ResourceInspection {
        self.agents
    }

    pub const fn terminal_processes(&self) -> ResourceInspection {
        self.terminal_processes
    }

    pub const fn terminal_panes(&self) -> ResourceInspection {
        self.terminal_panes
    }

    pub const fn terminal_windows(&self) -> ResourceInspection {
        self.terminal_windows
    }

    pub const fn unsaved_editors(&self) -> ResourceInspection {
        self.unsaved_editors
    }
}

/// Rust-owned, content-free projection used by the consolidated close
/// confirmation. The UI renders these states but never recomputes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseInspectionProjection {
    workspace_id: WorkspaceId,
    workspace_label: String,
    agents: ResourceInspection,
    terminal_processes: ResourceInspection,
    terminal_panes: ResourceInspection,
    terminal_windows: ResourceInspection,
    unsaved_editors: ResourceInspection,
}

impl CloseInspectionProjection {
    pub fn from_inputs(
        workspace_id: WorkspaceId,
        workspace_label: impl Into<String>,
        inputs: CloseInspectionInputs,
    ) -> Self {
        Self {
            workspace_id,
            workspace_label: workspace_label.into(),
            agents: inputs.agents(),
            terminal_processes: inputs.terminal_processes(),
            terminal_panes: inputs.terminal_panes(),
            terminal_windows: inputs.terminal_windows(),
            unsaved_editors: inputs.unsaved_editors(),
        }
    }

    pub fn workspace_id(&self) -> &WorkspaceId {
        &self.workspace_id
    }

    pub fn workspace_label(&self) -> &str {
        &self.workspace_label
    }

    pub const fn agents(&self) -> ResourceInspection {
        self.agents
    }

    pub const fn terminal_processes(&self) -> ResourceInspection {
        self.terminal_processes
    }

    pub const fn terminal_panes(&self) -> ResourceInspection {
        self.terminal_panes
    }

    pub const fn terminal_windows(&self) -> ResourceInspection {
        self.terminal_windows
    }

    pub const fn unsaved_editors(&self) -> ResourceInspection {
        self.unsaved_editors
    }
}

/// The only three consolidated close outcomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseInspection {
    Clean,
    RequiresConfirmation { reasons: BusyReasons, unknown_diagnostics: Vec<DiagnosticCode> },
}

impl CloseInspection {
    pub fn consolidate(inputs: CloseInspectionInputs) -> Self {
        let checks = [
            (inputs.agents, BusyReason::Agents),
            (inputs.terminal_processes, BusyReason::TerminalProcesses),
            (inputs.terminal_panes, BusyReason::TerminalPanes),
            (inputs.terminal_windows, BusyReason::TerminalWindows),
            (inputs.unsaved_editors, BusyReason::UnsavedEditors),
        ];

        let mut unknown_diagnostics = Vec::new();
        for (check, _) in checks {
            if let ResourceInspection::Unknown { diagnostic } = check {
                if !unknown_diagnostics.contains(&diagnostic) {
                    unknown_diagnostics.push(diagnostic);
                }
            }
        }

        let mut reasons = BusyReasons::default();
        for (check, reason) in checks {
            if let ResourceInspection::Busy { count } = check {
                reasons.add(reason, count);
            }
        }
        if reasons.is_empty() && unknown_diagnostics.is_empty() {
            Self::Clean
        } else {
            Self::RequiresConfirmation { reasons, unknown_diagnostics }
        }
    }

    pub const fn is_clean(&self) -> bool {
        matches!(self, Self::Clean)
    }

    pub fn busy_reasons(&self) -> Option<&BusyReasons> {
        match self {
            Self::Clean => None,
            Self::RequiresConfirmation { reasons, .. } => Some(reasons),
        }
    }

    pub fn unknown_diagnostics(&self) -> &[DiagnosticCode] {
        match self {
            Self::Clean => &[],
            Self::RequiresConfirmation { unknown_diagnostics, .. } => unknown_diagnostics,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BusyReason {
    Agents,
    TerminalProcesses,
    TerminalPanes,
    TerminalWindows,
    UnsavedEditors,
}

/// Counted reasons shown in one destructive Workspace confirmation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BusyReasons {
    agents: u32,
    terminal_processes: u32,
    terminal_panes: u32,
    terminal_windows: u32,
    unsaved_editors: u32,
}

impl BusyReasons {
    fn add(&mut self, reason: BusyReason, count: u32) {
        match reason {
            BusyReason::Agents => self.agents = count,
            BusyReason::TerminalProcesses => self.terminal_processes = count,
            BusyReason::TerminalPanes => self.terminal_panes = count,
            BusyReason::TerminalWindows => self.terminal_windows = count,
            BusyReason::UnsavedEditors => self.unsaved_editors = count,
        }
    }

    fn is_empty(self) -> bool {
        self.agents == 0
            && self.terminal_processes == 0
            && self.terminal_panes == 0
            && self.terminal_windows == 0
            && self.unsaved_editors == 0
    }

    pub const fn agents(self) -> u32 {
        self.agents
    }

    pub const fn terminal_processes(self) -> u32 {
        self.terminal_processes
    }

    pub const fn terminal_panes(self) -> u32 {
        self.terminal_panes
    }

    pub const fn terminal_windows(self) -> u32 {
        self.terminal_windows
    }

    pub const fn unsaved_editors(self) -> u32 {
        self.unsaved_editors
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(path: &str) -> (WorkspaceRoot, DisplayPath) {
        let root = WorkspaceRoot::new(path).expect("absolute root");
        let selected = DisplayPath::new(path).expect("absolute selected path");
        (root, selected)
    }

    #[test]
    fn opaque_ids_do_not_interchange_and_reject_invalid_values() {
        let workspace = WorkspaceId::for_test("workspace-a");
        let repository = RepositoryId::for_test("workspace-a");
        assert_ne!(workspace.as_str(), "");
        assert!(WorkspaceId::from_uuid("workspace-a").is_err());
        assert!(WorkspaceId::from_uuid("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(WorkspaceId::from_uuid("550E8400-e29b-41d4-a716-446655440000").is_err());
        assert!(WorkspaceId::from_uuid("550e8400e29b41d4a716446655440000").is_err());
        assert!(AgentProfileId::from_slug("Codex").is_err());
        let _repository = repository;
    }

    #[test]
    fn canonical_roots_are_identity_values_but_repositories_can_be_shared() {
        let repository = RepositoryId::for_test("repo");
        let (root_a, selected_a) = root("/dev/worktree-a");
        let (root_b, selected_b) = root("/dev/worktree-b");
        let a = Workspace::new(
            WorkspaceId::for_test("workspace-a"),
            root_a,
            selected_a,
            Some(repository.clone()),
        );
        let b = Workspace::new(
            WorkspaceId::for_test("workspace-b"),
            root_b,
            selected_b,
            Some(repository.clone()),
        );
        assert_ne!(a.id(), b.id());
        assert_ne!(a.root(), b.root());
        assert_eq!(a.repository_id(), b.repository_id());
    }

    #[test]
    fn paths_are_utf8_absolute_and_lexically_normalized() {
        let normalized = WorkspaceRoot::new("/dev/./worktree/../repo").unwrap();
        let canonical = WorkspaceRoot::new("/dev/repo").unwrap();
        assert_eq!(normalized, canonical);
        assert_eq!(DisplayPath::new("/dev/./repo").unwrap().as_path(), Path::new("/dev/repo"));
        assert!(WorkspaceRoot::new("relative/repo").is_err());
        assert!(WorkspaceRoot::new("/../repo").is_err());
        assert!(WorkspaceRoot::new("/..").is_err());
        assert!(WorkspaceRoot::new("/../../repo").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_paths_are_rejected_instead_of_lossily_labeled() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let non_utf8 = PathBuf::from(OsString::from_vec(vec![b'/', b'd', b'e', b'v', b'/', 0xff]));
        assert!(WorkspaceRoot::new(non_utf8.clone()).is_err());
        assert!(DisplayPath::new(non_utf8).is_err());
    }

    #[test]
    fn remote_aliases_normalize_https_and_ssh_without_credentials() {
        let https = RemoteIdentity::normalize("https://USER:secret@GitHub.com/Owner/Repo.git")
            .expect("valid https remote");
        let ssh =
            RemoteIdentity::normalize("git@github.com:owner/repo.git").expect("valid ssh remote");
        let custom_user =
            RemoteIdentity::normalize("alice@github.com:OWNER/Repo.git").expect("valid scp remote");
        assert_eq!(https.as_str(), "github.com/owner/repo");
        assert_eq!(https, ssh);
        assert_eq!(custom_user, ssh);

        let with_port = RemoteIdentity::normalize("https://github.com:443/OWNER/Repo.git")
            .expect("valid remote with port");
        assert_eq!(with_port, https);
        let https_non_default = RemoteIdentity::normalize("https://github.com:8443/OWNER/Repo.git")
            .expect("valid non-default https port");
        assert_eq!(https_non_default.as_str(), "github.com:8443/owner/repo");
        assert_ne!(https_non_default, https);
        assert_eq!(
            RemoteIdentity::normalize("http://code.example:80/Owner/Repo").unwrap(),
            RemoteIdentity::normalize("http://code.example/Owner/Repo").unwrap()
        );
        assert_eq!(
            RemoteIdentity::normalize("ssh://git@code.example:22/Owner/Repo").unwrap(),
            RemoteIdentity::normalize("ssh://git@code.example/Owner/Repo").unwrap()
        );
        assert_eq!(
            RemoteIdentity::normalize("ssh://git@code.example:2222/Owner/Repo").unwrap().as_str(),
            "code.example:2222/Owner/Repo"
        );
        let case_sensitive = RemoteIdentity::normalize("https://code.example/Owner/Repo.git")
            .expect("valid non-GitHub remote");
        assert_eq!(case_sensitive.as_str(), "code.example/Owner/Repo");
        assert!(RemoteIdentity::normalize("https://code.example/owner/../repo").is_err());

        let repository = Repository::new(
            RepositoryId::for_test("repo"),
            https.clone(),
            [RemoteIdentity::normalize("ssh://git@github.com/owner/repo").unwrap()],
        );
        assert_eq!(repository.aliases().len(), 1);
        assert!(repository.matches_remote(&ssh));
    }

    #[test]
    fn profile_snapshot_and_instance_name_are_stable_and_renamable() {
        let profile = AgentProfile::new(
            AgentProfileId::for_test("codex"),
            "Codex",
            AgentProfileKind::Codex,
            vec!["--full-auto".to_owned()],
            BTreeMap::new(),
        )
        .expect("valid profile");
        let mut agent = Agent::new(
            AgentId::for_test("agent-a"),
            WorkspaceId::for_test("workspace-a"),
            profile.clone(),
            2,
        )
        .expect("valid agent");
        assert_eq!(agent.display_name(), "Codex 2");
        assert_eq!(agent.profile(), &profile);
        agent.rename("Investigator").expect("valid rename");
        assert_eq!(agent.display_name(), "Investigator");
        agent.reset_name();
        assert_eq!(agent.display_name(), "Codex 2");
    }

    #[test]
    fn unavailable_workspace_preserves_agents_but_rejects_new_agents() {
        let profile = AgentProfile::new(
            AgentProfileId::for_test("codex"),
            "Codex",
            AgentProfileKind::Codex,
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let (root, selected) = root("/dev/project");
        let mut workspace =
            Workspace::new(WorkspaceId::for_test("workspace"), root, selected, None);
        workspace
            .add_agent(
                Agent::new(
                    AgentId::for_test("agent-a"),
                    WorkspaceId::for_test("workspace"),
                    profile.clone(),
                    1,
                )
                .unwrap(),
            )
            .unwrap();
        workspace.mark_unavailable(DiagnosticCode::RootMissing);
        assert_eq!(workspace.agents().len(), 1);
        assert!(!workspace.can_create_agent());
        let error = workspace
            .add_agent(
                Agent::new(
                    AgentId::for_test("agent-b"),
                    WorkspaceId::for_test("workspace"),
                    profile,
                    2,
                )
                .unwrap(),
            )
            .expect_err("unavailable workspace rejects creation");
        assert_eq!(error.code(), DomainErrorCode::WorkspaceUnavailable);
    }

    #[test]
    fn close_inspection_preserves_busy_counts_and_all_unknown_diagnostics() {
        assert_eq!(
            CloseInspection::consolidate(CloseInspectionInputs::clean()),
            CloseInspection::Clean
        );
        let busy = CloseInspection::consolidate(CloseInspectionInputs::new(
            ResourceInspection::busy(2).unwrap(),
            ResourceInspection::busy(3).unwrap(),
            ResourceInspection::Clean,
            ResourceInspection::Clean,
            ResourceInspection::busy(1).unwrap(),
        ));
        let CloseInspection::RequiresConfirmation { reasons, unknown_diagnostics } = busy else {
            panic!("expected confirmation inspection");
        };
        assert_eq!(reasons.agents(), 2);
        assert_eq!(reasons.terminal_processes(), 3);
        assert_eq!(reasons.unsaved_editors(), 1);
        assert!(unknown_diagnostics.is_empty());

        let unknown = CloseInspection::consolidate(CloseInspectionInputs::new(
            ResourceInspection::busy(1).unwrap(),
            ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
            ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
            ResourceInspection::unknown(DiagnosticCode::CloseEditorUnknown),
            ResourceInspection::Clean,
        ));
        let CloseInspection::RequiresConfirmation { reasons, unknown_diagnostics } = &unknown
        else {
            panic!("expected confirmation inspection");
        };
        assert_eq!(reasons.agents(), 1);
        assert_eq!(
            unknown_diagnostics,
            &[DiagnosticCode::CloseTerminalUnknown, DiagnosticCode::CloseEditorUnknown]
        );
        assert!(!unknown.is_clean());
    }

    #[test]
    fn close_inspection_projection_retains_workspace_identity_and_each_resource_state() {
        let projection = CloseInspectionProjection::from_inputs(
            WorkspaceId::for_test("workspace-a"),
            "DevHub",
            CloseInspectionInputs::new(
                ResourceInspection::busy(2).unwrap(),
                ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
                ResourceInspection::clean(),
                ResourceInspection::clean(),
                ResourceInspection::busy(1).unwrap(),
            ),
        );
        assert_eq!(projection.workspace_id().as_str(), "workspace-a");
        assert_eq!(projection.workspace_label(), "DevHub");
        assert_eq!(projection.agents(), ResourceInspection::Busy { count: 2 });
        assert_eq!(projection.terminal_panes(), ResourceInspection::Clean);
        assert_eq!(projection.unsaved_editors(), ResourceInspection::Busy { count: 1 });
    }
}
