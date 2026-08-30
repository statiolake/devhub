#![forbid(unsafe_code)]

//! The Rust side of DevHub's Bridge protocol.
//!
//! The Bridge is the narrow, versioned surface between DevHub and the VS Code
//! extension that runs inside a workbench. The protocol types here own the
//! schema and its canonical fixtures; the TypeScript consumer is generated from
//! them, so the two cannot drift.
//!
//! DevHub's own application state lives in the desktop app's main process, not
//! here.

pub mod bridge;
