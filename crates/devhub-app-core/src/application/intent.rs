use crate::{
    Activity, AgentId, AgentProfile, AgentProfileId, AgentReconciliation, AgentStatus,
    CloseInspectionInputs, DiagnosticCode, DisplayPath, NavigationContext, RuntimeHealth,
    WorkspaceId, WorkspaceRoot,
};

use super::types::{ConfirmationId, IntentId, OperationId, OperationToken, ProviderEventId};

/// A path exactly as requested by a UI/Bridge caller. It is not a canonical
/// Workspace Root; only a resolver completion may create that domain value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestedPath(String);

impl RequestedPath {
    pub fn new(raw: impl Into<String>) -> Result<Self, crate::DomainError> {
        let raw = raw.into();
        if raw.trim().is_empty() || raw.contains('\0') || raw.len() > 32_768 {
            return Err(crate::DomainError::new(crate::DomainErrorCode::InvalidPath));
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// User-originated commands. This type cannot carry provider observations,
/// canonical roots, generated IDs, inspections, or profiles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserIntent {
    SelectContext(NavigationContext),
    SelectActivity(Activity),
    ToggleWorkspaceDisclosure { workspace_id: WorkspaceId, expanded: bool },
    ResizeSidebar { width: u16 },
    OpenFolder { path: RequestedPath },
    NewWindow { path: Option<RequestedPath> },
    CreateAgent { workspace_id: WorkspaceId, profile_id: AgentProfileId },
    RenameAgent { agent_id: AgentId, display_name: String },
    StopAgent { agent_id: AgentId },
    ConfirmStopAgent { confirmation_id: ConfirmationId },
    RetryStopAgent { agent_id: AgentId },
    RequestCloseWorkspace { workspace_id: WorkspaceId },
    ConfirmCloseWorkspace { confirmation_id: ConfirmationId },
    RetryCloseWorkspace { workspace_id: WorkspaceId },
    WindowClosed,
    Quit,
}

/// Backwards-compatible name for the user command algebra. Provider events
/// are a separate type and cannot be dispatched through this seam.
pub type Intent = UserIntent;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentEnvelope {
    intent_id: IntentId,
    operation_id: Option<OperationId>,
    intent: UserIntent,
}

impl IntentEnvelope {
    /// Constructs an envelope without a trusted operation identity. Native
    /// ingress must use [`Self::with_operation_id`] before dispatching; this
    /// constructor remains useful for decoding/validation boundaries that have
    /// not yet attached their trusted correlation identity.
    pub fn new(intent_id: IntentId, intent: UserIntent) -> Self {
        Self { intent_id, operation_id: None, intent }
    }

    pub fn with_operation_id(
        intent_id: IntentId,
        operation_id: OperationId,
        intent: UserIntent,
    ) -> Self {
        Self { intent_id, operation_id: Some(operation_id), intent }
    }

    pub fn intent_id(&self) -> &IntentId {
        &self.intent_id
    }

    pub fn intent(&self) -> &UserIntent {
        &self.intent
    }

    pub fn operation_id(&self) -> Option<&OperationId> {
        self.operation_id.as_ref()
    }

    pub fn into_parts(self) -> (IntentId, Option<OperationId>, UserIntent) {
        (self.intent_id, self.operation_id, self.intent)
    }
}

/// Provider/runtime observations and completions are accepted only by the
/// coordinator's separate completion seam. They are never UI-dispatchable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderEvent {
    WorkspacePathResolved {
        token: OperationToken,
        root: WorkspaceRoot,
        selected_path: DisplayPath,
    },
    WorkspaceIdGenerated {
        token: OperationToken,
        workspace_id: WorkspaceId,
    },
    WorkspaceInspectionCompleted {
        token: OperationToken,
        workspace_id: WorkspaceId,
        inspection: CloseInspectionInputs,
    },
    AgentStopCompleted {
        token: OperationToken,
        agent_id: AgentId,
        result: AgentStopResult,
    },
    AgentTerminationCompleted {
        token: OperationToken,
        agent_id: AgentId,
        result: AgentStopResult,
    },
    WorkspaceCleanupCompleted {
        token: OperationToken,
        workspace_id: WorkspaceId,
        result: WorkspaceCleanupResult,
    },
    ConfirmationIdGenerated {
        token: OperationToken,
        confirmation_id: ConfirmationId,
    },
    ProfileResolved {
        token: OperationToken,
        workspace_id: WorkspaceId,
        profile: AgentProfile,
    },
    AgentIdGenerated {
        token: OperationToken,
        workspace_id: WorkspaceId,
        agent_id: AgentId,
    },
    AgentLaunchCompleted {
        token: OperationToken,
        workspace_id: WorkspaceId,
        agent_id: AgentId,
        result: AgentLaunchResult,
    },
    AgentsReconciled {
        token: OperationToken,
        reconciliation: AgentReconciliation,
    },
    AgentStatusChanged {
        token: OperationToken,
        agent_id: AgentId,
        status: AgentStatus,
        runtime_health: RuntimeHealth,
    },
    AgentExited {
        token: OperationToken,
        agent_id: AgentId,
    },
    StatePersisted {
        token: OperationToken,
    },
    StatePersistenceFailed {
        token: OperationToken,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEventEnvelope {
    event_id: ProviderEventId,
    event: ProviderEvent,
}

impl ProviderEventEnvelope {
    pub fn new(event_id: impl Into<ProviderEventId>, event: ProviderEvent) -> Self {
        Self { event_id: event_id.into(), event }
    }

    pub fn event_id(&self) -> &ProviderEventId {
        &self.event_id
    }

    pub fn event(&self) -> &ProviderEvent {
        &self.event
    }

    pub fn into_parts(self) -> (ProviderEventId, ProviderEvent) {
        (self.event_id, self.event)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStopResult {
    Stopped,
    Failed { diagnostic: DiagnosticCode },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLaunchResult {
    Started,
    Failed { diagnostic: DiagnosticCode },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupStep {
    Agents,
    Terminal,
    Editor,
    StateCommitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceCleanupResult {
    StepCompleted(CleanupStep),
    Failed { step: CleanupStep, diagnostic: DiagnosticCode },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistenceHealth {
    Healthy,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntentOutcome {
    Noop { snapshot: crate::AppSnapshot },
    Updated { snapshot: crate::AppSnapshot },
    ConfirmationRequired { confirmation_id: ConfirmationId, snapshot: crate::AppSnapshot },
    Deferred { operation_id: OperationId, snapshot: crate::AppSnapshot },
    Detached { snapshot: crate::AppSnapshot },
    PersistenceDegraded { snapshot: crate::AppSnapshot },
}

impl IntentOutcome {
    pub fn snapshot(&self) -> &crate::AppSnapshot {
        match self {
            Self::Noop { snapshot }
            | Self::Updated { snapshot }
            | Self::ConfirmationRequired { snapshot, .. }
            | Self::Deferred { snapshot, .. }
            | Self::Detached { snapshot }
            | Self::PersistenceDegraded { snapshot } => snapshot,
        }
    }
}
