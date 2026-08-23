//! Integrated application lifecycle modules.
//!
//! The provider adapters own their runtimes; this module owns only the
//! process/window lifecycle seam that coordinates reconstruction and clean
//! shutdown.

pub mod lifecycle;
