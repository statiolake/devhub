#![forbid(unsafe_code)]

//! Rust-owned state for the native DevHub application shell.
//!
//! The pure [`domain`] and [`snapshot`] modules own Workspace, Agent,
//! navigation, lifecycle, and immutable UI projection rules. The shell seam
//! below remains deliberately separate: provider/editor/terminal adapters and
//! Tauri command wiring do not enter the pure model.

pub mod application;
pub mod bridge;
pub mod config;
pub mod domain;
pub mod ports;
pub mod snapshot;
pub mod state;

pub use application::*;
pub use domain::*;
pub use ports::*;
pub use snapshot::*;
pub use state::*;

use std::fmt;

use serde::Serialize;

/// Version of the shell snapshot wire shape.
pub const SHELL_SNAPSHOT_SCHEMA_VERSION: u16 = 1;

/// Stable native-shell identity values.
pub const DEVHUB_PRODUCT_NAME: &str = "DevHub";
pub const DEVHUB_PLATFORM: &str = "macos";
pub const DEVHUB_WINDOW_LABEL: &str = "app-shell";

/// Readiness of the native application shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellReadiness {
    Starting,
    Ready,
}

/// Immutable serializable state crossing the native shell seam.
///
/// The fields are private and the type has no mutation methods.  The only
/// producer is [`ShellStore`], so callers cannot create a snapshot that claims
/// a revision or readiness the owner has not established.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSnapshot {
    schema_version: u16,
    revision: u64,
    product_name: String,
    platform: String,
    window_label: String,
    readiness: ShellReadiness,
}

impl ShellSnapshot {
    pub const fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn product_name(&self) -> &str {
        &self.product_name
    }

    pub fn platform(&self) -> &str {
        &self.platform
    }

    pub fn window_label(&self) -> &str {
        &self.window_label
    }

    pub const fn readiness(&self) -> ShellReadiness {
        self.readiness
    }
}

/// Errors that prevent creation or access to shell state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ShellStoreError {
    EmptyIdentity,
    StateUnavailable,
}

impl fmt::Display for ShellStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyIdentity => formatter.write_str("shell identity values cannot be empty"),
            Self::StateUnavailable => formatter.write_str("shell state is unavailable"),
        }
    }
}

impl std::error::Error for ShellStoreError {}

/// The authoritative, private shell implementation behind a small interface.
pub struct ShellStore {
    state: ShellState,
}

impl ShellStore {
    /// Creates a shell store with `Starting` readiness and revision zero.
    pub fn new(
        product_name: impl Into<String>,
        platform: impl Into<String>,
        window_label: impl Into<String>,
    ) -> Result<Self, ShellStoreError> {
        let product_name = product_name.into();
        let platform = platform.into();
        let window_label = window_label.into();
        if product_name.trim().is_empty()
            || platform.trim().is_empty()
            || window_label.trim().is_empty()
        {
            return Err(ShellStoreError::EmptyIdentity);
        }

        Ok(Self {
            state: ShellState {
                product_name,
                platform,
                window_label,
                revision: 0,
                readiness: ShellReadiness::Starting,
            },
        })
    }

    /// Returns an immutable copy of the current shell state.
    pub fn snapshot(&self) -> ShellSnapshot {
        self.state.snapshot()
    }

    /// Marks the shell ready and returns the resulting snapshot.
    ///
    /// Repeating this command is an intentional no-op: the revision advances
    /// only for an actual readiness transition.
    pub fn mark_ready(&mut self) -> ShellSnapshot {
        if self.state.readiness != ShellReadiness::Ready {
            self.state.readiness = ShellReadiness::Ready;
            self.state.revision = self.state.revision.saturating_add(1);
        }

        self.state.snapshot()
    }
}

struct ShellState {
    product_name: String,
    platform: String,
    window_label: String,
    revision: u64,
    readiness: ShellReadiness,
}

impl ShellState {
    fn snapshot(&self) -> ShellSnapshot {
        ShellSnapshot {
            schema_version: SHELL_SNAPSHOT_SCHEMA_VERSION,
            revision: self.revision,
            product_name: self.product_name.clone(),
            platform: self.platform.clone(),
            window_label: self.window_label.clone(),
            readiness: self.readiness,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_is_immutable_and_serializable() {
        let mut store = ShellStore::new(DEVHUB_PRODUCT_NAME, DEVHUB_PLATFORM, DEVHUB_WINDOW_LABEL)
            .expect("valid shell identity");
        let starting = store.snapshot();

        assert_eq!(starting.schema_version(), SHELL_SNAPSHOT_SCHEMA_VERSION);
        assert_eq!(starting.revision(), 0);
        assert_eq!(starting.product_name(), DEVHUB_PRODUCT_NAME);
        assert_eq!(starting.platform(), DEVHUB_PLATFORM);
        assert_eq!(starting.window_label(), DEVHUB_WINDOW_LABEL);
        assert_eq!(starting.readiness(), ShellReadiness::Starting);
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/shell-snapshot.v1.json"))
                .expect("canonical shell snapshot fixture is valid JSON");

        assert_eq!(
            serde_json::to_value(&starting).expect("snapshot serializes"),
            fixture["starting"]
        );

        let ready = store.mark_ready();
        assert_eq!(ready.revision(), 1);
        assert_eq!(ready.readiness(), ShellReadiness::Ready);
        assert_eq!(serde_json::to_value(&ready).expect("snapshot serializes"), fixture["ready"]);
        assert_eq!(starting.revision(), 0);
        assert_eq!(starting.readiness(), ShellReadiness::Starting);
    }

    #[test]
    fn revision_is_noop_aware() {
        let mut store = ShellStore::new(DEVHUB_PRODUCT_NAME, DEVHUB_PLATFORM, DEVHUB_WINDOW_LABEL)
            .expect("valid shell identity");

        let first = store.mark_ready();
        let second = store.mark_ready();

        assert_eq!(first.revision(), 1);
        assert_eq!(second.revision(), 1);
        assert_eq!(first, second);
    }

    #[test]
    fn invalid_initialization_is_error_safe() {
        assert!(matches!(
            ShellStore::new("  ", DEVHUB_PLATFORM, DEVHUB_WINDOW_LABEL),
            Err(ShellStoreError::EmptyIdentity)
        ));
    }
}
