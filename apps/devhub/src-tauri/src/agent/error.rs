//! Bounded, content-free AgentRuntime errors.

use std::fmt;

use devhub_app_core::ports::{PortError, PortErrorCode};

/// Stable local failure categories. No provider response, path, command,
/// token, environment value, or agent content is stored in this type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentRuntimeErrorCode {
    InvalidProfile,
    MissingExecutable,
    BootstrapFailed,
    ProtocolMismatch,
    CapabilityMismatch,
    Unavailable,
    Disconnected,
    Timeout,
    Cancelled,
    Conflict,
    ProviderRejected,
    ProviderNotFound,
    CleanupPending,
    BoundedInput,
    Internal,
}

impl AgentRuntimeErrorCode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidProfile => "invalid profile",
            Self::MissingExecutable => "Herdr executable unavailable",
            Self::BootstrapFailed => "Herdr bootstrap failed",
            Self::ProtocolMismatch => "Herdr protocol mismatch",
            Self::CapabilityMismatch => "Herdr capability mismatch",
            Self::Unavailable => "Agent runtime unavailable",
            Self::Disconnected => "Agent runtime disconnected",
            Self::Timeout => "Agent runtime timed out",
            Self::Cancelled => "Agent operation cancelled",
            Self::Conflict => "Agent runtime ownership conflict",
            Self::ProviderRejected => "Agent provider rejected operation",
            Self::ProviderNotFound => "Agent provider resource is gone",
            Self::CleanupPending => "Agent cleanup pending",
            Self::BoundedInput => "Agent input exceeded the safety bound",
            Self::Internal => "Agent runtime internal failure",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct AgentRuntimeError {
    code: AgentRuntimeErrorCode,
}

impl AgentRuntimeError {
    pub(crate) const fn new(code: AgentRuntimeErrorCode) -> Self {
        Self { code }
    }

    pub(crate) const fn code(self) -> AgentRuntimeErrorCode {
        self.code
    }

    pub(crate) const fn port_code(self) -> PortErrorCode {
        match self.code {
            AgentRuntimeErrorCode::ProtocolMismatch | AgentRuntimeErrorCode::CapabilityMismatch => {
                PortErrorCode::Incompatible
            }
            AgentRuntimeErrorCode::Conflict => PortErrorCode::Conflict,
            AgentRuntimeErrorCode::Timeout => PortErrorCode::TimedOut,
            AgentRuntimeErrorCode::Cancelled => PortErrorCode::Cancelled,
            AgentRuntimeErrorCode::Unavailable
            | AgentRuntimeErrorCode::MissingExecutable
            | AgentRuntimeErrorCode::Disconnected => PortErrorCode::Unavailable,
            _ => PortErrorCode::Failed,
        }
    }
}

impl fmt::Debug for AgentRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("AgentRuntimeError").field("code", &self.code).finish()
    }
}

impl fmt::Display for AgentRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code.as_str())
    }
}

impl std::error::Error for AgentRuntimeError {}

impl From<AgentRuntimeError> for PortError {
    fn from(error: AgentRuntimeError) -> Self {
        PortError::new(error.port_code())
    }
}
