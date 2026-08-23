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

use crate::{
    AgentId, AgentObservation, AgentProfile, AgentProfileId, AgentReconciliation,
    CloseInspectionInputs, DisplayPath, RemoteIdentity, WorkspaceId, WorkspaceRoot,
};

use crate::application::{OperationId, RequestedPath};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryResolution {
    /// Normalized domain identity. Raw Git URL strings never cross this seam.
    pub remote: Option<RemoteIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorHostResult {
    pub ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunchReceipt {
    pub agent_id: AgentId,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalResult {
    pub workspace_id: Option<WorkspaceId>,
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

    /// Re-attaches a persisted domain Agent after app/provider
    /// reconstruction. The default keeps old adapters source-compatible
    /// until they implement this capability.
    fn attach(&self, agent_id: AgentId, cancel: CancellationToken) -> PortFuture<AgentAttachment> {
        Box::pin(async move {
            let _ = (agent_id, cancel);
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
    fn ensure(
        &self,
        workspace_id: Option<WorkspaceId>,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalResult>;
    fn close_workspace(
        &self,
        workspace_id: WorkspaceId,
        cancel: CancellationToken,
    ) -> PortFuture<()>;
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

pub trait Diagnostics: Send + Sync {
    fn record(&self, code: &'static str);
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
