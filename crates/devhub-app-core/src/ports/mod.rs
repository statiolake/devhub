//! Narrow provider seams owned by the domain crate.
//!
//! These traits mention only DevHub values.  Tauri, WRY, Herdr, tmux, Git,
//! OpenVSCode, process handles and provider IDs belong in later adapters.

use std::fmt;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use crate::state::{OpaqueProviderMapping, OwnedSessionRecord};
use crate::{
    AgentId, AgentObservation, AgentProfile, AgentProfileId, AgentReconciliation,
    CloseInspectionInputs, DisplayPath, RemoteIdentity, ResourceInspection, WorkspaceId,
    WorkspaceRoot,
};

use crate::application::{OperationId, RequestedPath};
pub use crate::state::SocketTargetPreflightState;

/// Validated tmux socket identity shared by Config, StateStore, and the
/// native TerminalRuntime. The inner string is private so callers cannot
/// smuggle a selector, path, or empty name across the seam.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SocketName(String);

impl SocketName {
    pub fn new(value: impl Into<String>) -> Result<Self, PortError> {
        let value = value.into();
        if crate::state::is_valid_socket_name(&value) {
            Ok(Self(value))
        } else {
            Err(PortError::new(PortErrorCode::Failed))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SocketName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SocketName(<redacted>)")
    }
}

pub type PortFuture<T> = Pin<Box<dyn Future<Output = Result<T, PortError>> + Send + 'static>>;
/// StateStore keeps its content-free, typed recovery error instead of
/// collapsing it into the generic provider-port error vocabulary.
pub type StatePortFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, crate::state::StateError>> + Send + 'static>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PortErrorCode {
    Unavailable,
    Incompatible,
    Cancelled,
    TimedOut,
    Conflict,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortError {
    code: PortErrorCode,
}

impl PortError {
    pub const fn new(code: PortErrorCode) -> Self {
        Self { code }
    }

    pub const fn code(self) -> PortErrorCode {
        self.code
    }
}

/// A cancellation handle shared by a caller and its provider adapter.
///
/// The operation ID remains the stable value used for diagnostics at the port
/// boundary. Equality additionally includes the shared cancellation identity:
/// two independent tokens for one operation must not compare equal, while a
/// clone/child token intentionally does.
#[derive(Clone)]
pub struct CancellationToken {
    operation_id: OperationId,
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new(operation_id: OperationId) -> Self {
        Self { operation_id, cancelled: Arc::new(AtomicBool::new(false)) }
    }

    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn child(&self) -> Self {
        self.clone()
    }
}

impl fmt::Debug for CancellationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancellationToken")
            .field("operation_id", &self.operation_id)
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl PartialEq for CancellationToken {
    fn eq(&self, other: &Self) -> bool {
        self.operation_id == other.operation_id && Arc::ptr_eq(&self.cancelled, &other.cancelled)
    }
}

impl Eq for CancellationToken {}

impl Hash for CancellationToken {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.operation_id.hash(state);
        (Arc::as_ptr(&self.cancelled) as usize).hash(state);
    }
}

/// A complete validated configuration plus the exact content revision from
/// which it was read.  The revision is part of the port value so a Settings
/// save cannot silently overwrite an external edit.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigSnapshot {
    pub config: crate::config::Config,
    pub revision: crate::config::ContentRevision,
}

impl ConfigSnapshot {
    pub const fn new(
        config: crate::config::Config,
        revision: crate::config::ContentRevision,
    ) -> Self {
        Self { config, revision }
    }

    pub const fn schema_version(&self) -> u16 {
        self.config.version
    }
}

/// The complete Rust-owned runtime-state document. Keeping the port's value
/// equal to the deep StateStore contract prevents a compatibility adapter
/// from accidentally dropping navigation, workspace, or transition fields.
pub type PersistedState = crate::state::PersistedAppState;
pub type PersistedStateLoad = crate::state::StateLoad;

#[derive(Clone, PartialEq, Eq)]
pub struct WorkspaceCandidate {
    pub root: WorkspaceRoot,
    pub selected_path: DisplayPath,
}

impl fmt::Debug for WorkspaceCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceCandidate")
            .field("root", &"<redacted>")
            .field("selected_path", &"<redacted>")
            .finish()
    }
}

/// Stable, provider-free picker projection. The discovery adapter owns how
/// these strings are derived; the UI only consumes the projection.
#[derive(Clone, PartialEq, Eq)]
pub struct WorkspaceSearchProjection {
    pub label: String,
    pub search_text: String,
    pub tie_break: String,
}

impl fmt::Debug for WorkspaceSearchProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceSearchProjection")
            .field("label", &"<redacted>")
            .field("search_text", &"<redacted>")
            .field("tie_break", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkspaceDiscoveryErrorCode {
    SourceUnavailable,
    PermissionDenied,
    Io,
    InvalidCandidate,
    InvalidUtf8,
    CommandUnavailable,
    CommandFailed,
    CommandTimedOut,
    OutputLimit,
    CandidateLimit,
}

/// Content-free event kind emitted while configured sources are scanned.
/// Source IDs are validated configuration IDs, never raw paths or commands.
#[derive(Clone, PartialEq, Eq)]
pub enum WorkspaceDiscoveryEventKind {
    Candidate {
        source_id: String,
        candidate: WorkspaceCandidate,
        projection: WorkspaceSearchProjection,
    },
    SourceError {
        source_id: String,
        code: WorkspaceDiscoveryErrorCode,
        count: u32,
    },
    SourceCompleted {
        source_id: String,
        candidate_count: u32,
        error_count: u32,
        stderr_bytes: u32,
    },
    Cancelled {
        source_id: Option<String>,
    },
}

impl fmt::Debug for WorkspaceDiscoveryEventKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Candidate { source_id, .. } => formatter
                .debug_struct("Candidate")
                .field("source_id", source_id)
                .field("candidate", &"<redacted>")
                .field("projection", &"<redacted>")
                .finish(),
            Self::SourceError { source_id, code, count } => formatter
                .debug_struct("SourceError")
                .field("source_id", source_id)
                .field("code", code)
                .field("count", count)
                .finish(),
            Self::SourceCompleted { source_id, candidate_count, error_count, stderr_bytes } => {
                formatter
                    .debug_struct("SourceCompleted")
                    .field("source_id", source_id)
                    .field("candidate_count", candidate_count)
                    .field("error_count", error_count)
                    .field("stderr_bytes", stderr_bytes)
                    .finish()
            }
            Self::Cancelled { source_id } => {
                formatter.debug_struct("Cancelled").field("source_id", source_id).finish()
            }
        }
    }
}

/// A discovery event is scoped to one scan operation and carries a sequence
/// independent of model/content revisions.  Consumers can reject a late
/// event from a cooperatively-cancelled scan by checking both fields before
/// applying its provider-free kind.
#[derive(Clone, PartialEq, Eq)]
pub struct WorkspaceDiscoveryEvent {
    pub operation_id: OperationId,
    pub sequence: u64,
    pub kind: WorkspaceDiscoveryEventKind,
}

impl fmt::Debug for WorkspaceDiscoveryEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceDiscoveryEvent")
            .field("operation_id", &self.operation_id)
            .field("sequence", &self.sequence)
            .field("kind", &self.kind)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WorkspaceDiscoverySummary {
    pub candidate_count: u32,
    pub source_count: u32,
    pub error_count: u32,
    /// Aggregate stderr byte count from command sources. Content is never
    /// retained or exposed through this value.
    pub stderr_bytes: u32,
    pub cancelled: bool,
    /// A configured safety bound or output bound stopped the scan before all
    /// eligible entries could be represented. This is distinct from caller
    /// cancellation.
    pub truncated: bool,
}

/// Object-safe event sink. Implementations may forward events to an app
/// model, a Tauri adapter, or a deterministic test collector.
pub trait WorkspaceDiscoverySink: Send + Sync {
    fn emit(&self, event: WorkspaceDiscoveryEvent);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkspacePath {
    pub root: WorkspaceRoot,
    pub selected_path: DisplayPath,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RepositoryResolutionState {
    /// The workspace root is not inside a Git work tree.
    NotRepository,
    /// The workspace is a Git work tree, but no valid remote was found.
    NoRemote,
    /// At least one remote URL normalized to a repository identity.
    Associated,
}

/// The provider-free result of Git metadata resolution.
///
/// `primary_remote` is the selected normalized identity; `aliases` contains
/// every distinct valid normalized remote. Raw URLs, remote names, Git paths,
/// and process diagnostics never cross this boundary.
#[derive(Clone, PartialEq, Eq)]
pub struct RepositoryResolution {
    state: RepositoryResolutionState,
    primary_remote: Option<RemoteIdentity>,
    aliases: Vec<RemoteIdentity>,
}

impl RepositoryResolution {
    pub fn not_repository() -> Self {
        Self {
            state: RepositoryResolutionState::NotRepository,
            primary_remote: None,
            aliases: Vec::new(),
        }
    }

    pub fn no_remote() -> Self {
        Self {
            state: RepositoryResolutionState::NoRemote,
            primary_remote: None,
            aliases: Vec::new(),
        }
    }

    pub fn associated(
        primary: RemoteIdentity,
        aliases: impl IntoIterator<Item = RemoteIdentity>,
    ) -> Self {
        let mut aliases = aliases.into_iter().collect::<Vec<_>>();
        if !aliases.iter().any(|alias| alias == &primary) {
            aliases.push(primary.clone());
        }
        aliases.sort();
        aliases.dedup();
        Self {
            state: RepositoryResolutionState::Associated,
            primary_remote: Some(primary),
            aliases,
        }
    }

    pub const fn state(&self) -> RepositoryResolutionState {
        self.state
    }

    pub fn primary_remote(&self) -> Option<&RemoteIdentity> {
        self.primary_remote.as_ref()
    }

    pub fn aliases(&self) -> &[RemoteIdentity] {
        &self.aliases
    }
}

impl fmt::Debug for RepositoryResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RepositoryResolution")
            .field("state", &self.state)
            .field("primary_remote", &self.primary_remote.as_ref().map(|_| "<redacted>"))
            .field("alias_count", &self.aliases.len())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorHostResult {
    pub ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunchReceipt {
    pub agent_id: AgentId,
    /// Adapter-owned reattachment state. The application may persist this
    /// value, but must not interpret, log, or display its contents.
    pub provider_mapping: OpaqueProviderMapping,
}

pub type AgentAttachment = AgentObservation;

/// Alias retained at the provider seam; the aggregate itself is a domain
/// value and is applied atomically by `AppModel`.
pub type ProviderAgentReconciliation = AgentReconciliation;

/// Provider-free Bridge observation. Editor content, provider IDs, and
/// transport handles remain inside the EditorHost/Bridge adapters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeObservation {
    pub ready: bool,
    pub dirty: bool,
}

/// A terminal surface target expressed entirely in DevHub domain values.
/// Provider session/window/pane identifiers never cross this boundary.
///
/// The fields are private so an adapter cannot construct a target with a
/// provider-derived identity or accidentally replace the canonical Workspace
/// root.  Use the constructors below and carry the resulting value through
/// the port unchanged.
#[derive(Clone, PartialEq, Eq)]
pub struct TerminalTarget(TerminalTargetKind);

#[derive(Clone, PartialEq, Eq)]
enum TerminalTargetKind {
    Scratch,
    Workspace(WorkspaceTerminalTarget),
}

impl TerminalTarget {
    pub const fn scratch() -> Self {
        Self(TerminalTargetKind::Scratch)
    }

    pub fn workspace(workspace_id: WorkspaceId, root: WorkspaceRoot) -> Self {
        Self(TerminalTargetKind::Workspace(WorkspaceTerminalTarget::new(workspace_id, root)))
    }

    pub fn workspace_id(&self) -> Option<&WorkspaceId> {
        match &self.0 {
            TerminalTargetKind::Scratch => None,
            TerminalTargetKind::Workspace(target) => Some(target.workspace_id()),
        }
    }

    pub fn root(&self) -> Option<&WorkspaceRoot> {
        match &self.0 {
            TerminalTargetKind::Scratch => None,
            TerminalTargetKind::Workspace(target) => Some(target.root()),
        }
    }
}

impl fmt::Debug for TerminalTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            TerminalTargetKind::Scratch => formatter.write_str("Scratch"),
            TerminalTargetKind::Workspace(_) => formatter.write_str("Workspace(<redacted>)"),
        }
    }
}

/// A Workspace-specific target used for destructive terminal cleanup.
///
/// Keeping Scratch out of this type makes it impossible for a generic close
/// call to terminate the global terminal by mistake.  The root is carried as
/// an expected identity and must be revalidated by the native adapter before
/// it mutates a tmux session.
#[derive(Clone, PartialEq, Eq)]
pub struct WorkspaceTerminalTarget {
    workspace_id: WorkspaceId,
    root: WorkspaceRoot,
}

impl WorkspaceTerminalTarget {
    pub fn new(workspace_id: WorkspaceId, root: WorkspaceRoot) -> Self {
        Self { workspace_id, root }
    }

    pub fn workspace_id(&self) -> &WorkspaceId {
        &self.workspace_id
    }

    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }
}

impl fmt::Debug for WorkspaceTerminalTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WorkspaceTerminalTarget(<redacted>)")
    }
}

/// The canonical persisted preflight state.  The alias keeps terminal code
/// readable while ensuring Settings, StateStore, and the provider seam cannot
/// drift into separate socket-state enums.
pub type TerminalPreflightState = SocketTargetPreflightState;

/// Result of probing the requested socket name.  The requested name is part
/// of the value so a delayed completion cannot be applied to a different
/// socket transition.
pub struct TerminalPreflight {
    requested_socket_name: SocketName,
    state: SocketTargetPreflightState,
    owned_session_count: u32,
    unknown_session_count: u32,
}

impl TerminalPreflight {
    pub fn try_new(
        requested_socket_name: SocketName,
        state: SocketTargetPreflightState,
        owned_session_count: u32,
        unknown_session_count: u32,
    ) -> Result<Self, PortError> {
        if (state == SocketTargetPreflightState::TargetAbsent
            && (owned_session_count != 0 || unknown_session_count != 0))
            || (state == SocketTargetPreflightState::TargetDevhubEmpty && owned_session_count != 0)
        {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        Ok(Self { requested_socket_name, state, owned_session_count, unknown_session_count })
    }

    pub fn requested_socket_name(&self) -> &str {
        self.requested_socket_name.as_str()
    }

    pub const fn state(&self) -> SocketTargetPreflightState {
        self.state
    }

    pub const fn owned_session_count(&self) -> u32 {
        self.owned_session_count
    }

    pub const fn unknown_session_count(&self) -> u32 {
        self.unknown_session_count
    }
}

impl fmt::Debug for TerminalPreflight {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalPreflight")
            .field("requested_socket_name", &self.requested_socket_name)
            .field("state", &self.state)
            .field("owned_session_count", &self.owned_session_count)
            .field("unknown_session_count", &self.unknown_session_count)
            .finish()
    }
}

/// The provider-free inventory of exact marked sessions on one dedicated
/// socket. Unknown sessions are represented only by a bounded count and can
/// never be passed to a destructive operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOwnedSessions {
    sessions: Vec<OwnedSessionRecord>,
    unknown_session_count: u32,
}

impl TerminalOwnedSessions {
    pub fn new(
        sessions: Vec<OwnedSessionRecord>,
        unknown_session_count: u32,
    ) -> Result<Self, PortError> {
        let mut names = std::collections::BTreeSet::new();
        for session in &sessions {
            if !names.insert(session.session_name().to_owned()) {
                return Err(PortError::new(PortErrorCode::Failed));
            }
        }
        Ok(Self { sessions, unknown_session_count })
    }

    pub fn sessions(&self) -> &[OwnedSessionRecord] {
        &self.sessions
    }

    pub const fn unknown_session_count(&self) -> u32 {
        self.unknown_session_count
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct TerminalInspection {
    process: ResourceInspection,
    extra_panes: ResourceInspection,
    extra_windows: ResourceInspection,
}

impl TerminalInspection {
    pub const fn new(
        process: ResourceInspection,
        extra_panes: ResourceInspection,
        extra_windows: ResourceInspection,
    ) -> Self {
        Self { process, extra_panes, extra_windows }
    }

    pub const fn process(&self) -> ResourceInspection {
        self.process
    }

    pub const fn extra_panes(&self) -> ResourceInspection {
        self.extra_panes
    }

    pub const fn extra_windows(&self) -> ResourceInspection {
        self.extra_windows
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct TerminalResult {
    target: TerminalTarget,
}

impl TerminalResult {
    pub fn new(target: TerminalTarget) -> Self {
        Self { target }
    }

    pub fn target(&self) -> &TerminalTarget {
        &self.target
    }
}

impl fmt::Debug for TerminalResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("TerminalResult").field("target", &self.target).finish()
    }
}

pub trait ConfigStore: Send + Sync {
    fn load(&self, cancel: CancellationToken) -> PortFuture<ConfigSnapshot>;
    fn save(&self, snapshot: ConfigSnapshot, cancel: CancellationToken) -> PortFuture<()>;
}

pub trait StateStore: Send + Sync {
    fn load(&self, cancel: CancellationToken) -> StatePortFuture<PersistedStateLoad>;
    fn save(&self, state: PersistedState, cancel: CancellationToken) -> StatePortFuture<()>;
}

pub trait WorkspaceDiscovery: Send + Sync {
    fn discover(
        &self,
        cancel: CancellationToken,
        sink: Arc<dyn WorkspaceDiscoverySink>,
    ) -> PortFuture<WorkspaceDiscoverySummary>;
}

pub trait WorkspacePathResolver: Send + Sync {
    fn resolve(
        &self,
        path: RequestedPath,
        cancel: CancellationToken,
    ) -> PortFuture<ResolvedWorkspacePath>;
}

pub trait RepositoryResolver: Send + Sync {
    fn resolve(
        &self,
        root: WorkspaceRoot,
        cancel: CancellationToken,
    ) -> PortFuture<RepositoryResolution>;
}

/// Resolves a user-facing profile identity to the immutable profile snapshot
/// used to launch an Agent.  The profile ID itself is intentionally the only
/// profile value that crosses the intent boundary.
pub trait AgentProfileResolver: Send + Sync {
    fn resolve(
        &self,
        profile_id: AgentProfileId,
        cancel: CancellationToken,
    ) -> PortFuture<AgentProfile>;
}

/// Provider-owned close inspection.  The coordinator accepts only the
/// provider-free aggregate values returned by this seam.
pub trait WorkspaceInspector: Send + Sync {
    fn inspect(
        &self,
        workspace_id: WorkspaceId,
        cancel: CancellationToken,
    ) -> PortFuture<CloseInspectionInputs>;
}

pub trait EditorHost: Send + Sync {
    fn ensure(&self, cancel: CancellationToken) -> PortFuture<EditorHostResult>;
    fn close_workspace(
        &self,
        workspace_id: WorkspaceId,
        cancel: CancellationToken,
    ) -> PortFuture<()>;
    fn shutdown(&self, cancel: CancellationToken) -> PortFuture<()>;
}

pub trait AgentRuntime: Send + Sync {
    fn launch(
        &self,
        agent_id: AgentId,
        profile: AgentProfile,
        cancel: CancellationToken,
    ) -> PortFuture<AgentLaunchReceipt>;
    fn terminate(&self, agent_id: AgentId, cancel: CancellationToken) -> PortFuture<()>;

    /// Re-attaches a persisted domain Agent after app/provider reconstruction.
    /// The mapping is adapter-owned and may be absent when the provider can
    /// reconstruct a marked resource authoritatively.
    fn attach(
        &self,
        agent_id: AgentId,
        provider_mapping: Option<OpaqueProviderMapping>,
        cancel: CancellationToken,
    ) -> PortFuture<AgentAttachment> {
        Box::pin(async move {
            let _ = (agent_id, provider_mapping, cancel);
            Err(PortError::new(PortErrorCode::Unavailable))
        })
    }

    /// Returns one atomic provider observation used to reconcile status and
    /// natural exits without leaking provider models.
    fn reconcile(&self, cancel: CancellationToken) -> PortFuture<AgentReconciliation> {
        Box::pin(async move {
            let _ = cancel;
            Err(PortError::new(PortErrorCode::Unavailable))
        })
    }
}

pub trait TerminalRuntime: Send + Sync {
    fn preflight(
        &self,
        requested_socket_name: SocketName,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalPreflight>;
    fn ensure(
        &self,
        target: TerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalResult>;
    fn inspect(
        &self,
        target: TerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalInspection>;
    fn close_workspace(
        &self,
        target: WorkspaceTerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<()>;

    /// Lists only exact marked sessions on the supplied socket. The adapter
    /// must classify ownership immediately before returning this value.
    fn inspect_owned_sessions(
        &self,
        socket: SocketName,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalOwnedSessions> {
        Box::pin(async move {
            let _ = (socket, cancel);
            Err(PortError::new(PortErrorCode::Unavailable))
        })
    }

    /// Idempotently terminates one previously verified marked session. The
    /// adapter re-verifies marker and metadata at the destructive seam and
    /// must refuse an unknown or replaced session.
    fn close_owned_session(
        &self,
        socket: SocketName,
        session: OwnedSessionRecord,
        cancel: CancellationToken,
    ) -> PortFuture<()> {
        Box::pin(async move {
            let _ = (socket, session, cancel);
            Err(PortError::new(PortErrorCode::Unavailable))
        })
    }

    /// Ensures a fresh Scratch or open-Workspace session on an explicit
    /// socket. This is distinct from `ensure`, which targets the current
    /// effective socket and is used by ordinary Terminal Activity opening.
    fn ensure_on_socket(
        &self,
        socket: SocketName,
        target: TerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalResult> {
        Box::pin(async move {
            let _ = (socket, target, cancel);
            Err(PortError::new(PortErrorCode::Unavailable))
        })
    }
}

/// Domain-owned seam for the narrow Bridge observation contract. Content and
/// upstream Workbench handles are intentionally absent.
pub trait BridgeHost: Send + Sync {
    fn observe(
        &self,
        workspace_id: WorkspaceId,
        cancel: CancellationToken,
    ) -> PortFuture<BridgeObservation>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}

/// Adapter-owned identity source. The pure coordinator consumes generated
/// values only through explicit effects/completions; it never synthesizes
/// Workspace, Agent, Repository, Confirmation, or Intent identities.
pub trait IdGenerator: Send + Sync {
    fn next_operation_id(&self) -> Result<OperationId, PortError>;

    /// Generates the user-command correlation root.  The coordinator derives
    /// no replacement operation identity: the trusted ingress supplies this
    /// value and the application keeps it paired with the IntentId for the
    /// complete operation lifecycle.
    fn next_intent_id(&self) -> Result<crate::application::IntentId, PortError> {
        let operation_id = self.next_operation_id()?;
        crate::application::IntentId::from_uuid(operation_id.as_str().to_owned())
            .map_err(|_| PortError::new(PortErrorCode::Failed))
    }

    fn next_workspace_id(&self) -> Result<WorkspaceId, PortError> {
        let operation_id = self.next_operation_id()?;
        WorkspaceId::from_uuid(operation_id.as_str().to_owned())
            .map_err(|_| PortError::new(PortErrorCode::Failed))
    }

    fn next_agent_id(&self) -> Result<AgentId, PortError> {
        let operation_id = self.next_operation_id()?;
        AgentId::from_uuid(operation_id.as_str().to_owned())
            .map_err(|_| PortError::new(PortErrorCode::Failed))
    }

    fn next_repository_id(&self) -> Result<crate::RepositoryId, PortError> {
        let operation_id = self.next_operation_id()?;
        crate::RepositoryId::from_uuid(operation_id.as_str().to_owned())
            .map_err(|_| PortError::new(PortErrorCode::Failed))
    }

    fn next_confirmation_id(&self) -> Result<crate::application::ConfirmationId, PortError> {
        let operation_id = self.next_operation_id()?;
        crate::application::ConfirmationId::from_uuid(operation_id.as_str().to_owned())
            .map_err(|_| PortError::new(PortErrorCode::Failed))
    }
}

pub type SharedPort<T> = Arc<T>;

/// Compatibility spelling for adapters that call this seam a profile store.
pub use AgentProfileResolver as ProfileResolver;

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(raw: &str) -> RemoteIdentity {
        RemoteIdentity::normalize(raw).expect("valid remote fixture")
    }

    #[test]
    fn repository_resolution_constructors_preserve_state_invariants() {
        let not_repository = RepositoryResolution::not_repository();
        assert_eq!(not_repository.state(), RepositoryResolutionState::NotRepository);
        assert!(not_repository.primary_remote().is_none());
        assert!(not_repository.aliases().is_empty());

        let no_remote = RepositoryResolution::no_remote();
        assert_eq!(no_remote.state(), RepositoryResolutionState::NoRemote);
        assert!(no_remote.primary_remote().is_none());
        assert!(no_remote.aliases().is_empty());

        let primary = remote("https://github.com/owner/repo.git");
        let alias = remote("https://code.example/team/repo.git");
        let associated = RepositoryResolution::associated(
            primary.clone(),
            [alias.clone(), primary.clone(), alias.clone()],
        );
        assert_eq!(associated.state(), RepositoryResolutionState::Associated);
        assert_eq!(associated.primary_remote(), Some(&primary));
        assert_eq!(associated.aliases(), &[alias, primary]);
    }

    #[test]
    fn repository_resolution_debug_redacts_normalized_remote_values() {
        let primary = remote("https://github.com/owner/private-repo.git");
        let resolution = RepositoryResolution::associated(primary, []);
        let debug = format!("{resolution:?}");
        assert!(debug.contains("redacted"));
        assert!(!debug.contains("private-repo"));
    }

    #[test]
    fn terminal_targets_and_socket_names_are_validated_and_redacted() {
        let socket = SocketName::new("devhub").expect("valid socket");
        assert_eq!(socket.as_str(), "devhub");
        assert!(SocketName::new("").is_err());
        assert!(SocketName::new("../escape").is_err());
        let socket_debug = format!("{socket:?}");
        assert!(socket_debug.contains("redacted"));
        assert!(!socket_debug.contains("devhub"));

        let workspace = WorkspaceRoot::new("/Users/statiolake/private-project").expect("root");
        let workspace_id =
            WorkspaceId::from_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").expect("workspace id");
        let target = TerminalTarget::workspace(workspace_id, workspace);
        let target_debug = format!("{target:?}");
        assert!(target_debug.contains("redacted"));
        assert!(!target_debug.contains("private-project"));
        assert!(format!(
            "{:?}",
            WorkspaceTerminalTarget::new(
                WorkspaceId::from_uuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").expect("id"),
                WorkspaceRoot::new("/Users/statiolake/another-private-project").expect("root"),
            )
        )
        .contains("redacted"));
    }

    #[test]
    fn terminal_port_is_object_safe_and_preflight_invariants_are_checked() {
        fn assert_object_safe(_: Option<&dyn TerminalRuntime>) {}
        assert_object_safe(None);

        let socket = SocketName::new("devhub").expect("valid socket");
        let preflight = TerminalPreflight::try_new(
            socket.clone(),
            SocketTargetPreflightState::MarkedSessions,
            1,
            2,
        )
        .expect("valid preflight");
        assert_eq!(preflight.requested_socket_name(), "devhub");
        assert_eq!(preflight.owned_session_count(), 1);
        assert_eq!(preflight.unknown_session_count(), 2);
        assert!(
            TerminalPreflight::try_new(socket, SocketTargetPreflightState::TargetAbsent, 1, 0,)
                .is_err()
        );
    }
}
