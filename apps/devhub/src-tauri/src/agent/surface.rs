//! Provider-free Agent Surface control seam.

use devhub_app_core::ports::PortError;
use devhub_app_core::AgentId;

use super::runtime::HerdrAgentRuntime;

/// A writable Agent Surface owns a logical DevHub surface key, never a Herdr
/// pane or terminal identifier. Herdr IDs stay inside the runtime methods.
pub struct AgentSurface {
    runtime: HerdrAgentRuntime,
    agent_id: AgentId,
    surface_key: String,
}

impl AgentSurface {
    pub(crate) fn new(runtime: HerdrAgentRuntime, agent_id: AgentId, surface_key: String) -> Self {
        Self { runtime, agent_id, surface_key }
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn surface_key(&self) -> &str {
        &self.surface_key
    }

    pub fn send_text(&self, text: &str) -> Result<(), PortError> {
        self.runtime.surface_send_text(&self.agent_id, &self.surface_key, text)
    }

    pub fn read_recent(&self) -> Result<Vec<u8>, PortError> {
        self.runtime.surface_read_recent(&self.agent_id, &self.surface_key)
    }

    pub fn detach(&self) {
        self.runtime.surface_detach(&self.agent_id, &self.surface_key);
    }
}

impl Drop for AgentSurface {
    fn drop(&mut self) {
        self.runtime.surface_detach(&self.agent_id, &self.surface_key);
    }
}
