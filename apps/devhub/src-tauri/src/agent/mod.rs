//! Herdr-backed AgentRuntime adapter.
//!
//! This module is the only production boundary at which Herdr concepts are
//! allowed to exist. Provider workspace, tab, pane, terminal, and agent
//! identifiers must remain private to this module and its submodules.

mod api;
mod contract;
mod control;
mod error;
mod model;
mod runtime;
mod surface;

#[cfg(test)]
mod harness;

#[cfg(test)]
mod real_harness;

pub(crate) use contract::HERDR_SESSION_NAME;
pub use error::AgentRuntimeErrorCode;
pub use model::{AgentRuntimeHealth, AgentRuntimeHealthState};
pub use runtime::HerdrAgentRuntime;
pub use surface::AgentSurface;

#[cfg(test)]
mod tests {
    use super::contract::{
        expected_protocol, expected_version, required_capabilities, HERDR_PROTOCOL_VERSION,
        HERDR_VERSION,
    };
    use super::error::AgentRuntimeError;
    use super::*;

    #[test]
    fn herdr_contract_is_pinned() {
        assert_eq!(HERDR_SESSION_NAME, "devhub-session");
        assert_eq!(HERDR_VERSION, "0.8.1");
        assert_eq!(HERDR_PROTOCOL_VERSION, 20);
        assert_eq!(expected_version(), "0.8.1");
        assert_eq!(expected_protocol(), 20);
    }

    #[test]
    fn required_capabilities_are_stable_and_content_free() {
        let capabilities = required_capabilities();
        assert!(capabilities.contains(&"session.snapshot"));
        assert!(capabilities.contains(&"events.subscribe"));
        assert!(capabilities.contains(&"workspace.create"));
        assert!(capabilities.contains(&"tab.create"));
        assert!(capabilities.contains(&"pane.create"));
        assert!(capabilities.contains(&"pane.close"));
        assert!(capabilities.contains(&"agent.start:codex"));
        assert!(capabilities.contains(&"agent.start:claude"));
        assert!(capabilities.contains(&"terminal.control"));
        assert!(capabilities.iter().all(|value| !value.contains('/')));
    }

    #[test]
    fn errors_never_render_provider_or_user_content() {
        let error = AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch);
        assert_eq!(error.code(), AgentRuntimeErrorCode::ProtocolMismatch);
        assert!(!format!("{error:?}").contains("herdr"));
        assert!(!format!("{error}").contains("/Users"));
    }
}
