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
pub mod shell;
pub mod snapshot;
pub mod state;

pub use application::*;
pub use domain::*;
pub use ports::*;
pub use shell::*;
pub use snapshot::*;
pub use state::*;
