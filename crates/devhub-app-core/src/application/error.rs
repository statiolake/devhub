use std::fmt;

use super::types::{IntentId, OperationId, ProviderEventId};

/// Stable, content-free application error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AppErrorCode {
    Domain,
    DuplicateIntent,
    InvalidIntent,
    UnknownIntent,
    UnknownOperation,
    StaleCompletion,
    ConfirmationRequired,
    ConfirmationExpired,
    OperationInProgress,
    OperationGenerationExhausted,
    PersistenceDegraded,
    PortUnavailable,
}

impl AppErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Domain => "DOMAIN_ERROR",
            Self::DuplicateIntent => "DUPLICATE_INTENT",
            Self::InvalidIntent => "INVALID_INTENT",
            Self::UnknownIntent => "UNKNOWN_INTENT",
            Self::UnknownOperation => "UNKNOWN_OPERATION",
            Self::StaleCompletion => "STALE_COMPLETION",
            Self::ConfirmationRequired => "CONFIRMATION_REQUIRED",
            Self::ConfirmationExpired => "CONFIRMATION_EXPIRED",
            Self::OperationInProgress => "OPERATION_IN_PROGRESS",
            Self::OperationGenerationExhausted => "OPERATION_GENERATION_EXHAUSTED",
            Self::PersistenceDegraded => "PERSISTENCE_DEGRADED",
            Self::PortUnavailable => "PORT_UNAVAILABLE",
        }
    }
}

/// Application failure.  User content, provider identifiers, paths and
/// command output never enter this type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    code: AppErrorCode,
    domain_code: Option<crate::DomainErrorCode>,
    intent_id: Option<IntentId>,
    operation_id: Option<OperationId>,
    provider_event_id: Option<ProviderEventId>,
}

impl AppError {
    pub const fn new(code: AppErrorCode) -> Self {
        Self {
            code,
            domain_code: None,
            intent_id: None,
            operation_id: None,
            provider_event_id: None,
        }
    }

    pub const fn code(&self) -> AppErrorCode {
        self.code
    }

    /// Returns the stable domain code when this is a domain transition
    /// failure. User/provider content is intentionally never retained.
    pub const fn domain_code(&self) -> Option<crate::DomainErrorCode> {
        self.domain_code
    }

    pub const fn with_domain_code(mut self, code: crate::DomainErrorCode) -> Self {
        self.domain_code = Some(code);
        self
    }

    /// Compatibility spelling used by application transition code.
    pub const fn with_domain(self, code: crate::DomainErrorCode) -> Self {
        self.with_domain_code(code)
    }

    pub fn with_intent(mut self, intent_id: IntentId) -> Self {
        self.intent_id = Some(intent_id);
        self
    }

    pub fn with_operation(mut self, operation_id: OperationId) -> Self {
        self.operation_id = Some(operation_id);
        self
    }

    pub fn intent_id(&self) -> Option<&IntentId> {
        self.intent_id.as_ref()
    }

    pub fn operation_id(&self) -> Option<&OperationId> {
        self.operation_id.as_ref()
    }

    pub fn with_provider_event(mut self, event_id: ProviderEventId) -> Self {
        self.provider_event_id = Some(event_id);
        self
    }

    pub fn provider_event_id(&self) -> Option<&ProviderEventId> {
        self.provider_event_id.as_ref()
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code.as_str())
    }
}

impl std::error::Error for AppError {}

impl From<crate::DomainError> for AppError {
    fn from(error: crate::DomainError) -> Self {
        Self::new(AppErrorCode::Domain).with_domain_code(error.code())
    }
}
