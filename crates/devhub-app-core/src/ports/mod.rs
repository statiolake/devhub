//! Narrow provider seams owned by the domain crate.
//!
//! These traits mention only DevHub values.  Tauri, WRY, Herdr, tmux, Git,
//! OpenVSCode, process handles and provider IDs belong in later adapters.

use std::future::Future;
use std::pin::Pin;
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CancellationToken {
    operation_id: OperationId,
}

impl CancellationToken {
    pub const fn new(operation_id: OperationId) -> Self {
        Self { operation_id }
    }

    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceCandidate {
    pub root: WorkspaceRoot,
    pub selected_path: DisplayPath,
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
    fn discover(&self, cancel: CancellationToken) -> PortFuture<Vec<WorkspaceCandidate>>;
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
