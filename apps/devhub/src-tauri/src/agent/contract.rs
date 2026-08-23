//! Versioned, provider-local Herdr contract values.

/// The one named Herdr session owned by DevHub.
pub(crate) const HERDR_SESSION_NAME: &str = "devhub-session";
/// Exact Herdr CLI version accepted by this adapter.
pub(crate) const HERDR_VERSION: &str = "0.8.1";
/// Exact Herdr JSON API protocol accepted by this adapter.
pub(crate) const HERDR_PROTOCOL_VERSION: u32 = 20;

/// Capability names are adapter-internal labels. They are deliberately not
/// exposed in domain or UI contracts.
const REQUIRED_CAPABILITIES: &[&str] = &[
    "session.snapshot",
    "events.subscribe",
    "workspace.create",
    "workspace.list",
    "workspace.close",
    "tab.create",
    "tab.list",
    "pane.create",
    "pane.list",
    "pane.get",
    "pane.close",
    "pane.send_input",
    "agent.start:codex",
    "agent.start:claude",
    "terminal.control",
];

pub(crate) const fn expected_version() -> &'static str {
    HERDR_VERSION
}

pub(crate) const fn expected_protocol() -> u32 {
    HERDR_PROTOCOL_VERSION
}

pub(crate) fn required_capabilities() -> &'static [&'static str] {
    REQUIRED_CAPABILITIES
}
