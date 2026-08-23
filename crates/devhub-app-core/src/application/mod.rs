//! Application-level orchestration contracts.
//!
//! This module is the only place where domain transitions are combined with
//! provider-facing operations.  Concrete providers are intentionally absent;
//! this wave freezes the small seam they will implement later.

mod coordinator;
mod error;
mod intent;
mod types;

pub use coordinator::{
    AppCoordinator, ConfirmationPurpose, CoordinatorEffect, CoordinatorEvent, CoordinatorReplay,
    CoordinatorSubscription, DetachReason, Effect, SequencedCoordinatorEvent,
    MAX_COMPLETED_TOKEN_ENTRIES, MAX_CONFIRMATION_ID_ENTRIES, MAX_INTENT_LEDGER_ENTRIES,
    MAX_PROVIDER_LEDGER_ENTRIES, MAX_RETAINED_EVENTS,
};
pub use error::{AppError, AppErrorCode};
pub use intent::{
    AgentLaunchResult, AgentStopResult, CleanupStep, ConfirmationOutcomePurpose, Intent,
    IntentEnvelope, IntentOutcome, PersistenceHealth, ProviderEvent, ProviderEventEnvelope,
    RequestedPath, UserIntent, WorkspaceCleanupResult,
};
pub use types::{
    AppReadiness, ConfirmationId, IntentId, OperationId, OperationToken, ProviderEventId,
};
