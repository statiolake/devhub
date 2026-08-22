//! Transport-neutral ordering, reconnect, replacement, ledger, and timeout
//! state for the Bridge v1 contract.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use super::protocol::*;

pub type IdSourceHandle = Arc<Mutex<dyn IdSource + Send>>;

fn secure_id_source() -> IdSourceHandle {
    Arc::new(Mutex::new(SecureIdSource))
}

fn next_id(source: &IdSourceHandle) -> Result<Uuid, IdSourceError> {
    let mut source = source
        .lock()
        .map_err(|_| IdSourceError::Unavailable("identifier source lock poisoned".to_owned()))?;
    Uuid::from_source(&mut *source)
}

/// The result retained by the host's per-surface deduplication ledger.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CachedRequestResult {
    Response(ResponseResult),
    Error { code: ErrorCode, summary: ContentFreeSummary },
}

impl CachedRequestResult {
    fn into_payload(self, request_message_id: Option<Uuid>) -> Payload {
        match self {
            Self::Response(result) => Payload::Response(ResponsePayload {
                request_message_id: request_message_id.expect("response IDs are required"),
                result,
            }),
            Self::Error { code, summary } => {
                Payload::Error(ErrorPayload { request_message_id, code, summary })
            }
        }
    }
}

#[derive(Clone, Debug)]
struct LedgerEntry {
    result: CachedRequestResult,
    recorded_at: SystemTime,
    fingerprint: Option<String>,
}

/// A bounded, age-pruned request result ledger.
///
/// The defaults satisfy the protocol minimums.  The configurable constructor
/// is useful for deterministic tests, but rejects values below the contract
/// minimum rather than allowing a caller to weaken deduplication guarantees.
#[derive(Clone, Debug)]
pub struct RequestLedger {
    entries: BTreeMap<Uuid, LedgerEntry>,
    order: VecDeque<Uuid>,
    capacity: usize,
    retention: Duration,
}

impl Default for RequestLedger {
    fn default() -> Self {
        Self::new()
    }
}

impl RequestLedger {
    pub fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            order: VecDeque::new(),
            capacity: REQUEST_LEDGER_MIN_ENTRIES,
            retention: Duration::from_secs(REQUEST_LEDGER_MIN_RETENTION_SECONDS),
        }
    }

    pub fn with_limits(capacity: usize, retention: Duration) -> Result<Self, ProtocolError> {
        if !(REQUEST_LEDGER_MIN_ENTRIES..=REQUEST_LEDGER_MAX_ENTRIES).contains(&capacity)
            || retention < Duration::from_secs(REQUEST_LEDGER_MIN_RETENTION_SECONDS)
        {
            return Err(ProtocolError::invalid("ledger limits are below protocol minimums"));
        }
        Ok(Self { entries: BTreeMap::new(), order: VecDeque::new(), capacity, retention })
    }

    pub fn len(&mut self, now: SystemTime) -> usize {
        self.prune(now);
        self.entries.len()
    }

    pub fn is_empty(&mut self, now: SystemTime) -> bool {
        self.len(now) == 0
    }

    pub fn lookup(&mut self, message_id: &Uuid, now: SystemTime) -> Option<CachedRequestResult> {
        self.prune(now);
        self.entries.get(message_id).map(|entry| entry.result.clone())
    }

    fn fingerprint(&mut self, message_id: &Uuid, now: SystemTime) -> Option<String> {
        self.prune(now);
        self.entries.get(message_id).and_then(|entry| entry.fingerprint.clone())
    }

    /// Inserts a result exactly once.  An existing ID is never overwritten,
    /// preserving the first side effect's result across reconnects.
    pub fn record(
        &mut self,
        message_id: Uuid,
        result: CachedRequestResult,
        now: SystemTime,
    ) -> CachedRequestResult {
        self.prune(now);
        if let Some(existing) = self.entries.get(&message_id) {
            return existing.result.clone();
        }
        self.order.push_back(message_id.clone());
        self.entries.insert(
            message_id.clone(),
            LedgerEntry { result: result.clone(), recorded_at: now, fingerprint: None },
        );
        self.prune(now);
        result
    }

    fn record_request(
        &mut self,
        message_id: Uuid,
        fingerprint: String,
        result: CachedRequestResult,
        now: SystemTime,
    ) -> CachedRequestResult {
        self.prune(now);
        if let Some(existing) = self.entries.get(&message_id) {
            return existing.result.clone();
        }
        self.order.push_back(message_id.clone());
        self.entries.insert(
            message_id,
            LedgerEntry {
                result: result.clone(),
                recorded_at: now,
                fingerprint: Some(fingerprint),
            },
        );
        self.prune(now);
        result
    }

    fn prune(&mut self, now: SystemTime) {
        let retention = self.retention;
        // Retention is preferred while traffic is normal, but the absolute
        // bound is non-negotiable. This preserves the latest IDs and makes a
        // burst unable to grow the process without limit.
        while self.entries.len() > REQUEST_LEDGER_MAX_ENTRIES {
            let Some(oldest) = self.order.front().cloned() else {
                break;
            };
            self.order.pop_front();
            self.entries.remove(&oldest);
        }
        while self.entries.len() > self.capacity {
            let Some(oldest) = self.order.front().cloned() else {
                break;
            };
            let expired = self.entries.get(&oldest).is_some_and(|entry| {
                now.duration_since(entry.recorded_at).is_ok_and(|age| age >= retention)
            });
            if !expired {
                break;
            }
            self.order.pop_front();
            self.entries.remove(&oldest);
        }
    }
}

/// A request waiting for a response or a five-second deadline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRequest {
    pub request_message_id: Uuid,
    pub connection_id: Uuid,
    pub connection_generation: u64,
    pub request: ClientRequest,
    pub started_at: SystemTime,
}

/// Why a pending request can no longer receive its original response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestFailureReason {
    TimedOut,
    ConnectionLost,
}

/// Typed loss outcome. A caller must reconcile with a complete snapshot before
/// issuing a new-generation request; the bridge never retries automatically.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestFailure {
    pub pending: PendingRequest,
    pub reason: RequestFailureReason,
    pub snapshot_reconciliation_required: bool,
}

impl RequestFailure {
    fn timeout(pending: PendingRequest) -> Self {
        Self {
            pending,
            reason: RequestFailureReason::TimedOut,
            snapshot_reconciliation_required: true,
        }
    }

    fn connection_lost(pending: PendingRequest) -> Self {
        Self {
            pending,
            reason: RequestFailureReason::ConnectionLost,
            snapshot_reconciliation_required: true,
        }
    }
}

/// A deterministic pending-request tracker used by either endpoint.
#[derive(Clone, Debug, Default)]
pub struct PendingRequests {
    entries: BTreeMap<Uuid, PendingRequest>,
}

impl PendingRequests {
    pub fn insert(&mut self, request: PendingRequest) -> Option<PendingRequest> {
        self.entries.insert(request.request_message_id.clone(), request)
    }

    pub fn remove(&mut self, request_message_id: &Uuid) -> Option<PendingRequest> {
        self.entries.remove(request_message_id)
    }

    pub fn get(&self, request_message_id: &Uuid) -> Option<&PendingRequest> {
        self.entries.get(request_message_id)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn expire(&mut self, now: SystemTime) -> Vec<PendingRequest> {
        let deadline = Duration::from_secs(REQUEST_DEADLINE_SECONDS);
        let expired_ids: Vec<Uuid> = self
            .entries
            .values()
            .filter(|entry| now.duration_since(entry.started_at).is_ok_and(|age| age >= deadline))
            .map(|entry| entry.request_message_id.clone())
            .collect();
        expired_ids
            .iter()
            .filter_map(|request_message_id| self.remove(request_message_id))
            .collect()
    }

    pub fn fail_connection(&mut self, connection_id: &Uuid) -> Vec<PendingRequest> {
        let ids: Vec<Uuid> = self
            .entries
            .values()
            .filter(|entry| &entry.connection_id == connection_id)
            .map(|entry| entry.request_message_id.clone())
            .collect();
        ids.iter().filter_map(|id| self.remove(id)).collect()
    }
}

/// Full Bridge projection for one Editor Surface.  Applying a snapshot
/// replaces every field, which makes reconnect reconciliation idempotent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SurfaceProjection {
    pub surface_id: Uuid,
    pub workbench_instance_id: Uuid,
    pub connection_id: Uuid,
    pub connection_generation: u64,
    pub readiness: Readiness,
    pub context: Context,
    pub dirty: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConnectionPhase {
    AwaitingSnapshot,
    Active,
    Closed,
}

#[derive(Clone, Debug)]
struct HostConnection {
    surface_id: Uuid,
    workbench_instance_id: Uuid,
    connection_id: Uuid,
    connection_generation: u64,
    phase: ConnectionPhase,
    next_client_sequence: u64,
    next_server_sequence: u64,
    seen_client_frames: BTreeMap<u64, Uuid>,
    seen_client_order: VecDeque<u64>,
    pending: BTreeMap<Uuid, PendingRequest>,
    pending_host_requests: BTreeMap<Uuid, PendingRequest>,
    pending_fingerprints: BTreeMap<Uuid, String>,
}

impl HostConnection {
    fn new(
        surface_id: Uuid,
        workbench_instance_id: Uuid,
        connection_id: Uuid,
        connection_generation: u64,
    ) -> Self {
        Self {
            surface_id,
            workbench_instance_id,
            connection_id,
            connection_generation,
            phase: ConnectionPhase::AwaitingSnapshot,
            next_client_sequence: 2,
            next_server_sequence: 2,
            seen_client_frames: BTreeMap::new(),
            seen_client_order: VecDeque::new(),
            pending: BTreeMap::new(),
            pending_host_requests: BTreeMap::new(),
            pending_fingerprints: BTreeMap::new(),
        }
    }
}

/// The result of feeding one client frame into [`BridgeHost`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostReceiveOutcome {
    HelloAccepted(Envelope),
    SnapshotApplied,
    EventApplied,
    RequestPending {
        connection_id: Uuid,
        connection_generation: u64,
        request_message_id: Uuid,
        request: ClientRequest,
    },
    Replayed(Envelope),
    ResponseAccepted,
    DuplicateIgnored,
    ProtocolError {
        error: ErrorPayload,
        close_connection: bool,
    },
    StaleConnection {
        error: ErrorPayload,
        close_connection: bool,
    },
}

/// Errors returned by explicit request completion APIs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostRequestError {
    UnknownRequest,
    StaleConnection,
    IdSourceUnavailable,
    InvalidResult(ProtocolError),
}

impl fmt::Display for HostRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnknownRequest => "unknown bridge request",
            Self::StaleConnection => "stale bridge connection",
            Self::IdSourceUnavailable => "secure bridge identifier source unavailable",
            Self::InvalidResult(_) => "invalid bridge request result",
        })
    }
}

impl std::error::Error for HostRequestError {}

/// Host-owned, transport-neutral Bridge state machine.
#[derive(Clone)]
pub struct BridgeHost {
    expected_surfaces: Option<BTreeSet<Uuid>>,
    generations: BTreeMap<Uuid, u64>,
    current_connections: BTreeMap<Uuid, Uuid>,
    connections: BTreeMap<Uuid, HostConnection>,
    projections: BTreeMap<Uuid, SurfaceProjection>,
    ledgers: BTreeMap<Uuid, RequestLedger>,
    reconciliation_failures: Vec<RequestFailure>,
    id_source: IdSourceHandle,
}

impl BridgeHost {
    pub fn new(expected_surfaces: impl IntoIterator<Item = Uuid>) -> Self {
        Self::with_id_source(expected_surfaces, secure_id_source())
    }

    pub fn with_id_source(
        expected_surfaces: impl IntoIterator<Item = Uuid>,
        id_source: IdSourceHandle,
    ) -> Self {
        Self {
            expected_surfaces: Some(expected_surfaces.into_iter().collect()),
            generations: BTreeMap::new(),
            current_connections: BTreeMap::new(),
            connections: BTreeMap::new(),
            projections: BTreeMap::new(),
            ledgers: BTreeMap::new(),
            reconciliation_failures: Vec::new(),
            id_source,
        }
    }

    /// A host with no pre-registered surfaces accepts the identity supplied in
    /// hello.  Production callers generally use [`BridgeHost::new`].
    pub fn accepting_any_surface() -> Self {
        Self::accepting_any_surface_with_id_source(secure_id_source())
    }

    pub fn accepting_any_surface_with_id_source(id_source: IdSourceHandle) -> Self {
        Self {
            expected_surfaces: None,
            generations: BTreeMap::new(),
            current_connections: BTreeMap::new(),
            connections: BTreeMap::new(),
            projections: BTreeMap::new(),
            ledgers: BTreeMap::new(),
            reconciliation_failures: Vec::new(),
            id_source,
        }
    }

    pub fn projection(&self, surface_id: &Uuid) -> Option<&SurfaceProjection> {
        self.projections.get(surface_id)
    }

    pub fn connection_generation(&self, surface_id: &Uuid) -> Option<u64> {
        self.generations.get(surface_id).copied()
    }

    pub fn current_connection(&self, surface_id: &Uuid) -> Option<&Uuid> {
        self.current_connections.get(surface_id)
    }

    /// Returns failures raised while replacing a connection. A transport
    /// caller must surface these typed outcomes and reconcile from a complete
    /// snapshot before issuing requests on the new generation.
    pub fn take_reconciliation_failures(&mut self) -> Vec<RequestFailure> {
        std::mem::take(&mut self.reconciliation_failures)
    }

    pub fn receive(&mut self, frame: Envelope) -> HostReceiveOutcome {
        self.receive_at(frame, SystemTime::now())
    }

    pub fn receive_at(&mut self, frame: Envelope, now: SystemTime) -> HostReceiveOutcome {
        if frame.version() != BRIDGE_PROTOCOL_VERSION {
            return self.protocol_error_with_request_id(
                frame.connection_id().cloned(),
                ErrorCode::UnsupportedVersion,
                "unsupported bridge protocol version",
                true,
                request_id_for_frame(&frame),
            );
        }
        if frame.kind() == MessageKind::Hello {
            return self.accept_hello(frame, now);
        }
        let Some(connection_id) = frame.connection_id().cloned() else {
            return self.protocol_error_with_request_id(
                None,
                ErrorCode::InvalidIdentity,
                "message has no connection identity",
                true,
                request_id_for_frame(&frame),
            );
        };
        let Some(connection) = self.connections.get(&connection_id) else {
            return self.stale_error_for_frame(
                ErrorCode::ConnectionLost,
                "connection is not active",
                true,
                &frame,
            );
        };
        if connection.phase == ConnectionPhase::Closed
            || self.current_connections.get(&connection.surface_id) != Some(&connection_id)
        {
            return self.stale_error_for_frame(
                ErrorCode::ConnectionLost,
                "connection generation is stale",
                true,
                &frame,
            );
        }
        if frame.connection_id() != Some(&connection.connection_id) {
            return self.protocol_error_for_frame(
                Some(connection_id),
                ErrorCode::InvalidIdentity,
                "connection identity mismatch",
                true,
                &frame,
            );
        }
        let expected = connection.next_client_sequence;
        if expected == 0 || expected > MAX_SAFE_INTEGER {
            return self.protocol_error_for_frame(
                Some(connection_id),
                ErrorCode::SequenceError,
                "client sequence exhausted",
                true,
                &frame,
            );
        }
        if frame.sequence() < expected {
            if connection
                .seen_client_frames
                .get(&frame.sequence())
                .is_some_and(|message_id| *message_id == *frame.message_id())
            {
                if let Some(request_id) = request_id_for_frame(&frame) {
                    if let Some(result) = self
                        .ledgers
                        .entry(connection.surface_id.clone())
                        .or_default()
                        .lookup(&request_id, now)
                    {
                        return self.replay_result(&connection_id, request_id, result);
                    }
                }
                return HostReceiveOutcome::DuplicateIgnored;
            }
            return self.protocol_error_for_frame(
                Some(connection_id),
                ErrorCode::SequenceError,
                "sequence reused with a different message ID",
                true,
                &frame,
            );
        }
        if frame.sequence() != expected {
            return self.protocol_error_for_frame(
                Some(connection_id),
                ErrorCode::SequenceError,
                "sequence gap or decrease",
                true,
                &frame,
            );
        }
        if connection
            .seen_client_frames
            .values()
            .any(|message_id| *message_id == *frame.message_id())
        {
            return self.protocol_error_for_frame(
                Some(connection_id),
                ErrorCode::InvalidMessage,
                "message ID was already used",
                true,
                &frame,
            );
        }
        if let Some(connection) = self.connections.get_mut(&connection_id) {
            connection.next_client_sequence =
                connection.next_client_sequence.checked_add(1).unwrap_or(MAX_SAFE_INTEGER + 1);
            connection.seen_client_frames.insert(frame.sequence(), frame.message_id().clone());
            connection.seen_client_order.push_back(frame.sequence());
            while connection.seen_client_order.len() > REQUEST_LEDGER_MIN_ENTRIES {
                if let Some(sequence) = connection.seen_client_order.pop_front() {
                    connection.seen_client_frames.remove(&sequence);
                }
            }
        }

        if self
            .connections
            .get(&connection_id)
            .is_some_and(|connection| connection.phase == ConnectionPhase::AwaitingSnapshot)
        {
            return self.accept_snapshot(connection_id, frame);
        }
        if frame.kind() == MessageKind::StateSnapshot {
            return self.accept_snapshot(connection_id, frame);
        }

        match frame.payload().clone() {
            Payload::ReadyChanged(payload) => {
                if let Some(projection) = self.projection_for_connection_mut(&connection_id) {
                    projection.readiness = payload.readiness;
                }
                HostReceiveOutcome::EventApplied
            }
            Payload::IdentityChanged(payload) => {
                if let Some(projection) = self.projection_for_connection_mut(&connection_id) {
                    projection.context = payload.context;
                }
                HostReceiveOutcome::EventApplied
            }
            Payload::DirtyChanged(payload) => {
                if let Some(projection) = self.projection_for_connection_mut(&connection_id) {
                    projection.dirty = payload.dirty;
                }
                HostReceiveOutcome::EventApplied
            }
            Payload::OpenWorkspaceRequested(payload) => self.accept_request(
                connection_id,
                frame.message_id().clone(),
                ClientRequest::OpenWorkspace(payload),
                request_fingerprint(&frame),
                now,
            ),
            Payload::NewWindowRequested(payload) => self.accept_request(
                connection_id,
                frame.message_id().clone(),
                ClientRequest::NewWindow(payload),
                request_fingerprint(&frame),
                now,
            ),
            Payload::Response(payload) => self.accept_response(connection_id, payload),
            Payload::Error(payload) => self.accept_error(connection_id, payload),
            _ => self.protocol_error(
                Some(connection_id),
                ErrorCode::InvalidMessage,
                "message kind is not valid in the active host phase",
                true,
            ),
        }
    }

    fn accept_hello(&mut self, frame: Envelope, now: SystemTime) -> HostReceiveOutcome {
        let Payload::Hello(payload) = frame.payload().clone() else {
            return self.protocol_error(
                None,
                ErrorCode::InvalidMessage,
                "hello payload is invalid",
                true,
            );
        };
        if frame.sequence() != 1 || frame.connection_id().is_some() {
            return self.protocol_error(
                None,
                ErrorCode::SequenceError,
                "first message must be hello sequence 1",
                true,
            );
        }
        if self
            .expected_surfaces
            .as_ref()
            .is_some_and(|surfaces| !surfaces.contains(&payload.surface_id))
        {
            return self.protocol_error(
                None,
                ErrorCode::InvalidIdentity,
                "surface identity is not registered",
                true,
            );
        }
        let previous_generation = self.generations.get(&payload.surface_id).copied().unwrap_or(0);
        let Some(generation) =
            previous_generation.checked_add(1).filter(|value| *value <= MAX_SAFE_INTEGER)
        else {
            return self.protocol_error(
                None,
                ErrorCode::SurfaceUnavailable,
                "connection generation exhausted",
                true,
            );
        };
        let connection_id = match next_id(&self.id_source) {
            Ok(id) => id,
            Err(_) => {
                return self.protocol_error(
                    None,
                    ErrorCode::SurfaceUnavailable,
                    "secure identifier source unavailable",
                    true,
                )
            }
        };
        let acceptance_message_id = match next_id(&self.id_source) {
            Ok(id) => id,
            Err(_) => {
                return self.protocol_error(
                    None,
                    ErrorCode::SurfaceUnavailable,
                    "secure identifier source unavailable",
                    true,
                )
            }
        };
        self.generations.insert(payload.surface_id.clone(), generation);
        if let Some(previous) =
            self.current_connections.insert(payload.surface_id.clone(), connection_id.clone())
        {
            let (pending, pending_host_requests, fingerprints) = if let Some(previous_connection) =
                self.connections.get_mut(&previous)
            {
                previous_connection.phase = ConnectionPhase::Closed;
                let pending = std::mem::take(&mut previous_connection.pending);
                let pending_host_requests =
                    std::mem::take(&mut previous_connection.pending_host_requests);
                let fingerprints = std::mem::take(&mut previous_connection.pending_fingerprints);
                (pending, pending_host_requests, fingerprints)
            } else {
                (BTreeMap::new(), BTreeMap::new(), BTreeMap::new())
            };
            self.reconciliation_failures
                .extend(pending_host_requests.into_values().map(RequestFailure::connection_lost));
            for (request_message_id, _request) in pending {
                let fingerprint =
                    fingerprints.get(&request_message_id).cloned().unwrap_or_default();
                self.ledgers.entry(payload.surface_id.clone()).or_default().record_request(
                    request_message_id,
                    fingerprint,
                    CachedRequestResult::Error {
                        code: ErrorCode::ConnectionLost,
                        summary: ContentFreeSummary::parse("connection lost")
                            .expect("static summary"),
                    },
                    now,
                );
            }
        }
        let mut connection = HostConnection::new(
            payload.surface_id.clone(),
            payload.workbench_instance_id,
            connection_id.clone(),
            generation,
        );
        let accepted = Envelope::new(
            Some(connection_id.clone()),
            1,
            acceptance_message_id,
            MessageKind::HelloAccepted,
            Payload::HelloAccepted(HelloAcceptedPayload {
                accepted_version: BRIDGE_PROTOCOL_VERSION,
                surface_id: payload.surface_id.clone(),
                connection_generation: generation,
            }),
        )
        .expect("hello acceptance is valid");
        connection.next_server_sequence = 2;
        self.connections.insert(connection_id, connection);
        HostReceiveOutcome::HelloAccepted(accepted)
    }

    fn accept_snapshot(&mut self, connection_id: Uuid, frame: Envelope) -> HostReceiveOutcome {
        let Some(connection) = self.connections.get(&connection_id) else {
            return self.stale_error(ErrorCode::ConnectionLost, "connection is not active", true);
        };
        let surface_id = connection.surface_id.clone();
        let workbench_instance_id = connection.workbench_instance_id.clone();
        let generation = connection.connection_generation;
        let request_message_id = request_id_for_frame(&frame);
        let Payload::StateSnapshot(payload) = frame.payload().clone() else {
            return self.protocol_error_with_request_id(
                Some(connection_id),
                ErrorCode::InvalidMessage,
                "snapshot is required before other messages",
                true,
                request_message_id,
            );
        };
        if payload.surface_id != surface_id {
            return self.protocol_error(
                Some(connection_id),
                ErrorCode::InvalidIdentity,
                "snapshot surface does not match hello",
                true,
            );
        }
        self.projections.insert(
            surface_id.clone(),
            SurfaceProjection {
                surface_id,
                workbench_instance_id,
                connection_id: connection_id.clone(),
                connection_generation: generation,
                readiness: payload.readiness,
                context: payload.context,
                dirty: payload.dirty,
            },
        );
        if let Some(connection) = self.connections.get_mut(&connection_id) {
            connection.phase = ConnectionPhase::Active;
        }
        HostReceiveOutcome::SnapshotApplied
    }

    fn accept_request(
        &mut self,
        connection_id: Uuid,
        request_message_id: Uuid,
        request: ClientRequest,
        fingerprint: String,
        now: SystemTime,
    ) -> HostReceiveOutcome {
        let Some(connection) = self.connections.get(&connection_id) else {
            return self.stale_error(ErrorCode::ConnectionLost, "connection is not active", true);
        };
        let surface_id = connection.surface_id.clone();
        let ledger = self.ledgers.entry(surface_id).or_default();
        if let Some(existing) = ledger.fingerprint(&request_message_id, now) {
            if existing != fingerprint {
                return self.protocol_error_with_request_id(
                    Some(connection_id),
                    ErrorCode::InvalidMessage,
                    "request ID reused with a different payload",
                    true,
                    Some(request_message_id),
                );
            }
        }
        if let Some(result) = ledger.lookup(&request_message_id, now) {
            return self.replay_result(&connection_id, request_message_id, result);
        }
        if let Some(connection) = self.connections.get_mut(&connection_id) {
            connection.pending.insert(
                request_message_id.clone(),
                PendingRequest {
                    request_message_id: request_message_id.clone(),
                    connection_id: connection_id.clone(),
                    connection_generation: connection.connection_generation,
                    request: request.clone(),
                    started_at: now,
                },
            );
            connection.pending_fingerprints.insert(request_message_id.clone(), fingerprint);
        }
        HostReceiveOutcome::RequestPending {
            connection_id: connection_id.clone(),
            connection_generation: self
                .connections
                .get(&connection_id)
                .map_or(0, |connection| connection.connection_generation),
            request_message_id,
            request,
        }
    }

    fn replay_result(
        &mut self,
        connection_id: &Uuid,
        request_message_id: Uuid,
        result: CachedRequestResult,
    ) -> HostReceiveOutcome {
        let Some(envelope) =
            self.server_envelope(connection_id, result.into_payload(Some(request_message_id)))
        else {
            return self.stale_error(ErrorCode::ConnectionLost, "connection is not active", true);
        };
        HostReceiveOutcome::Replayed(envelope)
    }

    /// Completes an extension request and records its result across future
    /// connection generations.  The result is never re-applied for a duplicate
    /// message ID.
    pub fn complete_request(
        &mut self,
        connection_id: &Uuid,
        request_message_id: &Uuid,
        result: Result<ResponseResult, (ErrorCode, ContentFreeSummary)>,
        now: SystemTime,
    ) -> Result<Envelope, HostRequestError> {
        let Some(connection) = self.connections.get(connection_id) else {
            return Err(HostRequestError::StaleConnection);
        };
        if connection.phase == ConnectionPhase::Closed
            || self.current_connections.get(&connection.surface_id) != Some(connection_id)
        {
            return Err(HostRequestError::StaleConnection);
        }
        let Some(request) = connection.pending.get(request_message_id).cloned() else {
            if let Some(cached) = self
                .ledgers
                .entry(connection.surface_id.clone())
                .or_default()
                .lookup(request_message_id, now)
            {
                return self
                    .server_envelope(
                        connection_id,
                        cached.into_payload(Some(request_message_id.clone())),
                    )
                    .ok_or(HostRequestError::StaleConnection);
            }
            return Err(HostRequestError::UnknownRequest);
        };
        let cached = match result {
            Ok(result) => {
                result
                    .validate_for_request(&request.request)
                    .map_err(HostRequestError::InvalidResult)?;
                CachedRequestResult::Response(result)
            }
            Err((code, summary)) => CachedRequestResult::Error { code, summary },
        };
        let fingerprint =
            connection.pending_fingerprints.get(request_message_id).cloned().unwrap_or_default();
        let stored = self.ledgers.entry(connection.surface_id.clone()).or_default().record_request(
            request_message_id.clone(),
            fingerprint,
            cached,
            now,
        );
        if let Some(connection) = self.connections.get_mut(connection_id) {
            connection.pending.remove(request_message_id);
            connection.pending_fingerprints.remove(request_message_id);
        }
        self.server_envelope(connection_id, stored.into_payload(Some(request_message_id.clone())))
            .ok_or(HostRequestError::StaleConnection)
    }

    fn accept_response(
        &mut self,
        connection_id: Uuid,
        payload: ResponsePayload,
    ) -> HostReceiveOutcome {
        let Some(connection) = self.connections.get_mut(&connection_id) else {
            return self.stale_error(ErrorCode::ConnectionLost, "connection is not active", true);
        };
        let Some(request) = connection.pending_host_requests.remove(&payload.request_message_id)
        else {
            return self.protocol_error_with_request_id(
                Some(connection_id),
                ErrorCode::InvalidMessage,
                "response does not match a pending host request",
                true,
                Some(payload.request_message_id),
            );
        };
        if payload.result.validate_for_request(&request.request).is_err() {
            return self.protocol_error_with_request_id(
                Some(connection_id),
                ErrorCode::InvalidMessage,
                "response result does not match host request",
                true,
                Some(payload.request_message_id),
            );
        }
        HostReceiveOutcome::ResponseAccepted
    }

    fn accept_error(&mut self, connection_id: Uuid, payload: ErrorPayload) -> HostReceiveOutcome {
        let Some(request_message_id) = payload.request_message_id else {
            return HostReceiveOutcome::ResponseAccepted;
        };
        let Some(connection) = self.connections.get_mut(&connection_id) else {
            return self.stale_error(ErrorCode::ConnectionLost, "connection is not active", true);
        };
        if connection.pending_host_requests.remove(&request_message_id).is_none()
            && connection.pending.remove(&request_message_id).is_none()
        {
            return self.protocol_error_with_request_id(
                Some(connection_id),
                ErrorCode::InvalidMessage,
                "error does not match a pending request",
                true,
                Some(request_message_id),
            );
        }
        HostReceiveOutcome::ResponseAccepted
    }

    fn projection_for_connection_mut(
        &mut self,
        connection_id: &Uuid,
    ) -> Option<&mut SurfaceProjection> {
        let surface_id = self.connections.get(connection_id)?.surface_id.clone();
        self.projections.get_mut(&surface_id)
    }

    /// Sends a host request.  The caller must wait for exactly one response or
    /// error before sending another response for that ID.
    pub fn request_snapshot(
        &mut self,
        connection_id: &Uuid,
        reason: SnapshotRequestReason,
    ) -> Result<Envelope, HostRequestError> {
        self.request_snapshot_at(connection_id, reason, SystemTime::now())
    }

    pub fn request_snapshot_at(
        &mut self,
        connection_id: &Uuid,
        reason: SnapshotRequestReason,
        now: SystemTime,
    ) -> Result<Envelope, HostRequestError> {
        self.send_host_request(
            connection_id,
            ClientRequest::RequestStateSnapshot(RequestStateSnapshotPayload { reason }),
            now,
        )
    }

    pub fn request_focus(
        &mut self,
        connection_id: &Uuid,
        reason: FocusReason,
    ) -> Result<Envelope, HostRequestError> {
        self.request_focus_at(connection_id, reason, SystemTime::now())
    }

    pub fn request_focus_at(
        &mut self,
        connection_id: &Uuid,
        reason: FocusReason,
        now: SystemTime,
    ) -> Result<Envelope, HostRequestError> {
        self.send_host_request(connection_id, ClientRequest::Focus(FocusPayload { reason }), now)
    }

    fn send_host_request(
        &mut self,
        connection_id: &Uuid,
        request: ClientRequest,
        now: SystemTime,
    ) -> Result<Envelope, HostRequestError> {
        if self
            .connections
            .get(connection_id)
            .is_none_or(|connection| connection.phase != ConnectionPhase::Active)
        {
            return Err(HostRequestError::StaleConnection);
        }
        let payload = match &request {
            ClientRequest::RequestStateSnapshot(payload) => {
                Payload::RequestStateSnapshot(payload.clone())
            }
            ClientRequest::Focus(payload) => Payload::Focus(payload.clone()),
            _ => return Err(HostRequestError::UnknownRequest),
        };
        let message_id =
            next_id(&self.id_source).map_err(|_| HostRequestError::IdSourceUnavailable)?;
        let envelope = self
            .server_envelope_with_id(connection_id, message_id.clone(), payload)
            .ok_or(HostRequestError::StaleConnection)?;
        let Some(connection) = self.connections.get_mut(connection_id) else {
            return Err(HostRequestError::StaleConnection);
        };
        connection.pending_host_requests.insert(
            message_id.clone(),
            PendingRequest {
                request_message_id: message_id,
                connection_id: connection_id.clone(),
                connection_generation: connection.connection_generation,
                request,
                started_at: now,
            },
        );
        Ok(envelope)
    }

    /// Marks a connection lost and fails all of its pending requests.  Cached
    /// failures make later duplicate IDs deterministic across reconnects.
    pub fn connection_lost(
        &mut self,
        connection_id: &Uuid,
        now: SystemTime,
    ) -> Vec<RequestFailure> {
        let Some(connection) = self.connections.get(connection_id).cloned() else {
            return Vec::new();
        };
        let (pending, pending_host, fingerprints): (
            Vec<PendingRequest>,
            Vec<PendingRequest>,
            BTreeMap<Uuid, String>,
        ) = if let Some(active) = self.connections.get_mut(connection_id) {
            active.phase = ConnectionPhase::Closed;
            (
                active.pending.values().cloned().collect(),
                active.pending_host_requests.values().cloned().collect(),
                active.pending_fingerprints.clone(),
            )
        } else {
            (Vec::new(), Vec::new(), BTreeMap::new())
        };
        if let Some(active) = self.connections.get_mut(connection_id) {
            active.pending.clear();
            active.pending_host_requests.clear();
            active.pending_fingerprints.clear();
        }
        for request in &pending {
            let cached = CachedRequestResult::Error {
                code: ErrorCode::ConnectionLost,
                summary: ContentFreeSummary::parse("connection lost").expect("static summary"),
            };
            self.ledgers.entry(connection.surface_id.clone()).or_default().record_request(
                request.request_message_id.clone(),
                fingerprints.get(&request.request_message_id).cloned().unwrap_or_default(),
                cached,
                now,
            );
        }
        let mut all_pending = pending;
        all_pending.extend(pending_host);
        if self.current_connections.get(&connection.surface_id) == Some(connection_id) {
            self.current_connections.remove(&connection.surface_id);
        }
        all_pending.into_iter().map(RequestFailure::connection_lost).collect()
    }

    /// Expires requests at the protocol deadline and returns response frames
    /// for requests whose connection remains active.
    pub fn expire_requests(&mut self, now: SystemTime) -> Vec<Envelope> {
        let mut responses = Vec::new();
        let ids: Vec<Uuid> = self.connections.keys().cloned().collect();
        for connection_id in ids {
            let Some(connection) = self.connections.get(&connection_id).cloned() else {
                continue;
            };
            let expired: Vec<Uuid> = connection
                .pending
                .values()
                .filter(|pending| {
                    now.duration_since(pending.started_at)
                        .is_ok_and(|age| age >= Duration::from_secs(REQUEST_DEADLINE_SECONDS))
                })
                .map(|pending| pending.request_message_id.clone())
                .collect();
            for request_message_id in expired {
                if let Ok(response) = self.complete_request(
                    &connection_id,
                    &request_message_id,
                    Err((
                        ErrorCode::BridgeTimeout,
                        ContentFreeSummary::parse("bridge request timed out")
                            .expect("static summary"),
                    )),
                    now,
                ) {
                    responses.push(response);
                }
            }

            let expired_host: Vec<Uuid> = connection
                .pending_host_requests
                .values()
                .filter(|pending| {
                    now.duration_since(pending.started_at)
                        .is_ok_and(|age| age >= Duration::from_secs(REQUEST_DEADLINE_SECONDS))
                })
                .map(|pending| pending.request_message_id.clone())
                .collect();
            for request_message_id in expired_host {
                let removed = self
                    .connections
                    .get_mut(&connection_id)
                    .and_then(|active| active.pending_host_requests.remove(&request_message_id));
                if removed.is_some() {
                    if let Some(response) = self.server_envelope(
                        &connection_id,
                        Payload::Error(ErrorPayload {
                            request_message_id: Some(request_message_id),
                            code: ErrorCode::BridgeTimeout,
                            summary: ContentFreeSummary::parse("bridge request timed out")
                                .expect("static summary"),
                        }),
                    ) {
                        responses.push(response);
                    }
                }
            }
        }
        responses
    }

    /// Expires host-side pending requests as typed failures when a transport
    /// wants to reconcile out-of-band instead of emitting an error frame.
    pub fn expire_request_failures(&mut self, now: SystemTime) -> Vec<RequestFailure> {
        let deadline = Duration::from_secs(REQUEST_DEADLINE_SECONDS);
        let mut failures = Vec::new();
        let connection_ids: Vec<Uuid> = self.connections.keys().cloned().collect();
        for connection_id in connection_ids {
            let Some(connection) = self.connections.get(&connection_id).cloned() else {
                continue;
            };
            let ids: Vec<Uuid> = connection
                .pending
                .values()
                .chain(connection.pending_host_requests.values())
                .filter(|pending| {
                    now.duration_since(pending.started_at).is_ok_and(|age| age >= deadline)
                })
                .map(|pending| pending.request_message_id.clone())
                .collect();
            for id in ids {
                let (pending, extension_originated, fingerprint) = {
                    let Some(active) = self.connections.get_mut(&connection_id) else {
                        continue;
                    };
                    if let Some(pending) = active.pending.remove(&id) {
                        let fingerprint =
                            active.pending_fingerprints.remove(&id).unwrap_or_default();
                        (pending, true, fingerprint)
                    } else if let Some(pending) = active.pending_host_requests.remove(&id) {
                        (pending, false, String::new())
                    } else {
                        continue;
                    }
                };
                if extension_originated {
                    if let Some(surface_id) =
                        self.connections.get(&connection_id).map(|c| c.surface_id.clone())
                    {
                        self.ledgers.entry(surface_id).or_default().record_request(
                            id.clone(),
                            fingerprint,
                            CachedRequestResult::Error {
                                code: ErrorCode::BridgeTimeout,
                                summary: ContentFreeSummary::parse("bridge request timed out")
                                    .expect("static summary"),
                            },
                            now,
                        );
                    }
                }
                failures.push(RequestFailure::timeout(pending));
            }
        }
        failures
    }

    fn server_envelope(&mut self, connection_id: &Uuid, payload: Payload) -> Option<Envelope> {
        let message_id = next_id(&self.id_source).ok()?;
        self.server_envelope_with_id(connection_id, message_id, payload)
    }

    fn server_envelope_with_id(
        &mut self,
        connection_id: &Uuid,
        message_id: Uuid,
        payload: Payload,
    ) -> Option<Envelope> {
        let connection = self.connections.get_mut(connection_id)?;
        if connection.phase == ConnectionPhase::Closed {
            return None;
        }
        let sequence = connection.next_server_sequence;
        if sequence == 0 || sequence > MAX_SAFE_INTEGER {
            return None;
        }
        connection.next_server_sequence = sequence.checked_add(1).unwrap_or(MAX_SAFE_INTEGER + 1);
        Envelope::new(Some(connection_id.clone()), sequence, message_id, payload.kind(), payload)
            .ok()
    }

    fn protocol_error(
        &mut self,
        connection_id: Option<Uuid>,
        code: ErrorCode,
        summary: &str,
        close_connection: bool,
    ) -> HostReceiveOutcome {
        let error = ErrorPayload {
            request_message_id: None,
            code,
            summary: ContentFreeSummary::parse(summary).unwrap_or_else(|_| {
                ContentFreeSummary::parse("invalid bridge message").expect("static summary")
            }),
        };
        if close_connection {
            if let Some(connection_id) = connection_id {
                if let Some(connection) = self.connections.get_mut(&connection_id) {
                    connection.phase = ConnectionPhase::Closed;
                }
            }
        }
        HostReceiveOutcome::ProtocolError { error, close_connection }
    }

    fn protocol_error_for_frame(
        &mut self,
        connection_id: Option<Uuid>,
        code: ErrorCode,
        summary: &str,
        close_connection: bool,
        frame: &Envelope,
    ) -> HostReceiveOutcome {
        self.protocol_error_with_request_id(
            connection_id,
            code,
            summary,
            close_connection,
            request_id_for_frame(frame),
        )
    }

    fn protocol_error_with_request_id(
        &mut self,
        connection_id: Option<Uuid>,
        code: ErrorCode,
        summary: &str,
        close_connection: bool,
        request_message_id: Option<Uuid>,
    ) -> HostReceiveOutcome {
        match self.protocol_error(connection_id, code, summary, close_connection) {
            HostReceiveOutcome::ProtocolError { mut error, close_connection } => {
                error.request_message_id = request_message_id;
                HostReceiveOutcome::ProtocolError { error, close_connection }
            }
            outcome => outcome,
        }
    }

    fn stale_error(
        &self,
        code: ErrorCode,
        summary: &str,
        close_connection: bool,
    ) -> HostReceiveOutcome {
        HostReceiveOutcome::StaleConnection {
            error: ErrorPayload {
                request_message_id: None,
                code,
                summary: ContentFreeSummary::parse(summary)
                    .unwrap_or(ContentFreeSummary::InvalidMessage),
            },
            close_connection,
        }
    }

    fn stale_error_for_frame(
        &self,
        code: ErrorCode,
        summary: &str,
        close_connection: bool,
        frame: &Envelope,
    ) -> HostReceiveOutcome {
        let request_message_id = request_id_for_frame(frame);
        match self.stale_error(code, summary, close_connection) {
            HostReceiveOutcome::StaleConnection { mut error, close_connection } => {
                error.request_message_id = request_message_id;
                HostReceiveOutcome::StaleConnection { error, close_connection }
            }
            outcome => outcome,
        }
    }
}

fn request_id_for_frame(frame: &Envelope) -> Option<Uuid> {
    if frame.is_request() {
        Some(frame.message_id().clone())
    } else {
        None
    }
}

fn request_fingerprint(frame: &Envelope) -> String {
    format!("{:?}:{:?}", frame.kind(), frame.payload())
}

/// Client-side handshake and ordering state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientPhase {
    HelloPending,
    SnapshotPending,
    Active,
    Closed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientReceiveOutcome {
    HelloAccepted,
    HostRequest { request_message_id: Uuid, request: ClientRequest },
    Response(ResponsePayload),
    Error(ErrorPayload),
    SnapshotApplied,
    Replayed(Envelope),
    DuplicateIgnored,
    ProtocolError(ErrorPayload),
}

/// Client-side protocol state. A reconnect creates a new value; pending
/// request state is intentionally not copied across connection generations.
#[derive(Clone)]
pub struct BridgeClient {
    surface_id: Uuid,
    workbench_instance_id: Uuid,
    extension_version: SemVer,
    connection_id: Option<Uuid>,
    connection_generation: u64,
    phase: ClientPhase,
    next_client_sequence: u64,
    next_server_sequence: u64,
    seen_server_frames: BTreeMap<u64, Uuid>,
    seen_server_order: VecDeque<u64>,
    pending: PendingRequests,
    pending_host: BTreeMap<Uuid, PendingRequest>,
    pending_host_fingerprints: BTreeMap<Uuid, String>,
    host_ledger: RequestLedger,
    id_source: IdSourceHandle,
}

impl BridgeClient {
    pub fn new(surface_id: Uuid, workbench_instance_id: Uuid, extension_version: SemVer) -> Self {
        Self::with_id_source(
            surface_id,
            workbench_instance_id,
            extension_version,
            secure_id_source(),
        )
    }

    pub fn with_id_source(
        surface_id: Uuid,
        workbench_instance_id: Uuid,
        extension_version: SemVer,
        id_source: IdSourceHandle,
    ) -> Self {
        Self {
            surface_id,
            workbench_instance_id,
            extension_version,
            connection_id: None,
            connection_generation: 0,
            phase: ClientPhase::HelloPending,
            next_client_sequence: 1,
            next_server_sequence: 1,
            seen_server_frames: BTreeMap::new(),
            seen_server_order: VecDeque::new(),
            pending: PendingRequests::default(),
            pending_host: BTreeMap::new(),
            pending_host_fingerprints: BTreeMap::new(),
            host_ledger: RequestLedger::new(),
            id_source,
        }
    }

    pub fn phase(&self) -> ClientPhase {
        self.phase.clone()
    }

    pub fn connection_id(&self) -> Option<&Uuid> {
        self.connection_id.as_ref()
    }

    fn protocol_error_for_frame(
        &mut self,
        code: ErrorCode,
        summary: &'static str,
        frame: Option<&Envelope>,
    ) -> ClientReceiveOutcome {
        self.protocol_error_with_request_id(code, summary, frame.and_then(request_id_for_frame))
    }

    fn protocol_error_with_request_id(
        &mut self,
        code: ErrorCode,
        summary: &'static str,
        request_message_id: Option<Uuid>,
    ) -> ClientReceiveOutcome {
        self.phase = ClientPhase::Closed;
        ClientReceiveOutcome::ProtocolError(ErrorPayload {
            request_message_id,
            code,
            summary: ContentFreeSummary::parse(summary)
                .unwrap_or(ContentFreeSummary::InvalidMessage),
        })
    }

    pub fn hello(&mut self) -> Result<Envelope, ProtocolError> {
        if self.phase != ClientPhase::HelloPending || self.next_client_sequence != 1 {
            return Err(ProtocolError::sequence("hello has already been sent"));
        }
        let message_id =
            next_id(&self.id_source).map_err(|_| ProtocolError::id_source_unavailable())?;
        let message = Envelope::new(
            None,
            1,
            message_id,
            MessageKind::Hello,
            Payload::Hello(HelloPayload {
                extension_version: self.extension_version.clone(),
                surface_id: self.surface_id.clone(),
                workbench_instance_id: self.workbench_instance_id.clone(),
            }),
        )?;
        self.next_client_sequence = 2;
        Ok(message)
    }

    pub fn accept_hello(&mut self, frame: &Envelope) -> Result<(), ProtocolError> {
        if frame.version() != BRIDGE_PROTOCOL_VERSION {
            return Err(ProtocolError::unsupported_version());
        }
        if self.phase != ClientPhase::HelloPending || frame.sequence() != 1 {
            return Err(ProtocolError::sequence("hello acceptance is out of order"));
        }
        let Some(connection_id) = frame.connection_id().cloned() else {
            return Err(ProtocolError::invalid_identity("hello acceptance has no connection ID"));
        };
        let Payload::HelloAccepted(payload) = frame.payload() else {
            return Err(ProtocolError::invalid("expected hello acceptance"));
        };
        if payload.surface_id != self.surface_id
            || payload.accepted_version != BRIDGE_PROTOCOL_VERSION
        {
            return Err(ProtocolError::invalid_identity("hello acceptance identity mismatch"));
        }
        self.connection_id = Some(connection_id);
        self.connection_generation = payload.connection_generation;
        self.phase = ClientPhase::SnapshotPending;
        self.next_server_sequence = 2;
        self.seen_server_frames.insert(frame.sequence(), frame.message_id().clone());
        self.seen_server_order.push_back(frame.sequence());
        while self.seen_server_order.len() > REQUEST_LEDGER_MIN_ENTRIES {
            if let Some(sequence) = self.seen_server_order.pop_front() {
                self.seen_server_frames.remove(&sequence);
            }
        }
        Ok(())
    }

    pub fn snapshot(
        &mut self,
        readiness: Readiness,
        context: Context,
        dirty: bool,
    ) -> Result<Envelope, ProtocolError> {
        if self.phase != ClientPhase::SnapshotPending {
            return Err(ProtocolError::sequence("snapshot is not expected"));
        }
        self.send(Payload::StateSnapshot(StateSnapshotPayload {
            surface_id: self.surface_id.clone(),
            readiness,
            context,
            dirty,
        }))
    }

    pub fn send(&mut self, payload: Payload) -> Result<Envelope, ProtocolError> {
        if self.phase == ClientPhase::HelloPending || self.phase == ClientPhase::Closed {
            return Err(ProtocolError::sequence("client connection is not established"));
        }
        if matches!(
            payload.kind(),
            MessageKind::Hello
                | MessageKind::HelloAccepted
                | MessageKind::RequestStateSnapshot
                | MessageKind::Focus
        ) {
            return Err(ProtocolError::invalid("message kind is not valid for client output"));
        }
        if self.phase == ClientPhase::SnapshotPending
            && payload.kind() != MessageKind::StateSnapshot
        {
            return Err(ProtocolError::sequence("state snapshot is required before events"));
        }
        let connection_id = self
            .connection_id
            .clone()
            .ok_or_else(|| ProtocolError::invalid_identity("client has no connection ID"))?;
        if self.next_client_sequence == 0 || self.next_client_sequence > MAX_SAFE_INTEGER {
            return Err(ProtocolError::sequence("client sequence exhausted"));
        }
        let message_id =
            next_id(&self.id_source).map_err(|_| ProtocolError::id_source_unavailable())?;
        let message = Envelope::new(
            Some(connection_id),
            self.next_client_sequence,
            message_id,
            payload.kind(),
            payload,
        )?;
        self.next_client_sequence =
            self.next_client_sequence.checked_add(1).unwrap_or(MAX_SAFE_INTEGER + 1);
        if self.phase == ClientPhase::SnapshotPending
            && message.kind() == MessageKind::StateSnapshot
        {
            self.phase = ClientPhase::Active;
        }
        Ok(message)
    }

    pub fn request(
        &mut self,
        request: ClientRequest,
        now: SystemTime,
    ) -> Result<Envelope, ProtocolError> {
        if self.phase != ClientPhase::Active {
            return Err(ProtocolError::sequence("requests require an active connection"));
        }
        let payload = match &request {
            ClientRequest::OpenWorkspace(payload) => {
                Payload::OpenWorkspaceRequested(payload.clone())
            }
            ClientRequest::NewWindow(payload) => Payload::NewWindowRequested(payload.clone()),
            ClientRequest::RequestStateSnapshot(_) | ClientRequest::Focus(_) => {
                return Err(ProtocolError::invalid(
                    "client requests cannot use host request variants",
                ));
            }
        };
        let message = self.send(payload)?;
        self.pending.insert(PendingRequest {
            request_message_id: message.message_id().clone(),
            connection_id: self.connection_id.clone().expect("send requires connection"),
            connection_generation: self.connection_generation,
            request,
            started_at: now,
        });
        Ok(message)
    }

    pub fn receive(&mut self, frame: Envelope) -> ClientReceiveOutcome {
        self.receive_at(frame, SystemTime::now())
    }

    pub fn receive_at(&mut self, frame: Envelope, now: SystemTime) -> ClientReceiveOutcome {
        if frame.version() != BRIDGE_PROTOCOL_VERSION {
            return self.protocol_error_for_frame(
                ErrorCode::UnsupportedVersion,
                "unsupported bridge protocol version",
                Some(&frame),
            );
        }
        if self.phase == ClientPhase::HelloPending && frame.kind() == MessageKind::HelloAccepted {
            return match self.accept_hello(&frame) {
                Ok(()) => ClientReceiveOutcome::HelloAccepted,
                Err(error) => ClientReceiveOutcome::ProtocolError(ErrorPayload {
                    request_message_id: None,
                    code: error.code(),
                    summary: ContentFreeSummary::parse("invalid hello acceptance")
                        .expect("static summary"),
                }),
            };
        }
        if frame.connection_id() != self.connection_id.as_ref() {
            return self.protocol_error_for_frame(
                ErrorCode::InvalidIdentity,
                "connection identity mismatch",
                Some(&frame),
            );
        }
        if self.next_server_sequence == 0 || self.next_server_sequence > MAX_SAFE_INTEGER {
            return self.protocol_error_for_frame(
                ErrorCode::SequenceError,
                "server sequence exhausted",
                Some(&frame),
            );
        }
        if matches!(frame.kind(), MessageKind::RequestStateSnapshot | MessageKind::Focus) {
            let fingerprint = request_fingerprint(&frame);
            let prior = {
                let ledger = &mut self.host_ledger;
                let fingerprint_match = ledger
                    .fingerprint(frame.message_id(), now)
                    .map(|existing| existing == fingerprint);
                let result = ledger.lookup(frame.message_id(), now);
                (fingerprint_match, result)
            };
            if prior.0 == Some(false) {
                return self.protocol_error_with_request_id(
                    ErrorCode::InvalidMessage,
                    "host request ID reused with a different payload",
                    Some(frame.message_id().clone()),
                );
            }
            if let Some(result) = prior.1 {
                if let Ok(replay) = self.send(result.into_payload(Some(frame.message_id().clone())))
                {
                    return ClientReceiveOutcome::Replayed(replay);
                }
            }
        }
        if frame.sequence() < self.next_server_sequence {
            if self
                .seen_server_frames
                .get(&frame.sequence())
                .is_some_and(|message_id| *message_id == *frame.message_id())
            {
                if let Some(result) = self.host_ledger.lookup(frame.message_id(), now) {
                    if let Ok(replay) =
                        self.send(result.into_payload(Some(frame.message_id().clone())))
                    {
                        return ClientReceiveOutcome::Replayed(replay);
                    }
                }
                return ClientReceiveOutcome::DuplicateIgnored;
            }
            return self.protocol_error_for_frame(
                ErrorCode::SequenceError,
                "server sequence error",
                Some(&frame),
            );
        }
        if frame.sequence() != self.next_server_sequence {
            return self.protocol_error_for_frame(
                ErrorCode::SequenceError,
                "server sequence error",
                Some(&frame),
            );
        }
        if self.seen_server_frames.values().any(|message_id| *message_id == *frame.message_id()) {
            return self.protocol_error_for_frame(
                ErrorCode::InvalidMessage,
                "message ID was already used",
                Some(&frame),
            );
        }
        self.next_server_sequence =
            self.next_server_sequence.checked_add(1).unwrap_or(MAX_SAFE_INTEGER + 1);
        self.seen_server_frames.insert(frame.sequence(), frame.message_id().clone());
        self.seen_server_order.push_back(frame.sequence());
        while self.seen_server_order.len() > REQUEST_LEDGER_MIN_ENTRIES {
            if let Some(sequence) = self.seen_server_order.pop_front() {
                self.seen_server_frames.remove(&sequence);
            }
        }
        let frame_request_message_id = request_id_for_frame(&frame);
        match frame.payload().clone() {
            Payload::RequestStateSnapshot(payload) => {
                if self.phase != ClientPhase::Active {
                    return self.protocol_error_with_request_id(
                        ErrorCode::SequenceError,
                        "host request arrived before snapshot reconciliation",
                        frame_request_message_id,
                    );
                }
                let request = ClientRequest::RequestStateSnapshot(payload);
                self.pending_host.insert(
                    frame.message_id().clone(),
                    PendingRequest {
                        request_message_id: frame.message_id().clone(),
                        connection_id: self.connection_id.clone().expect("active connection"),
                        connection_generation: self.connection_generation,
                        request: request.clone(),
                        started_at: now,
                    },
                );
                self.pending_host_fingerprints
                    .insert(frame.message_id().clone(), request_fingerprint(&frame));
                ClientReceiveOutcome::HostRequest {
                    request_message_id: frame.message_id().clone(),
                    request,
                }
            }
            Payload::Focus(payload) => {
                if self.phase != ClientPhase::Active {
                    return self.protocol_error_with_request_id(
                        ErrorCode::SequenceError,
                        "host request arrived before snapshot reconciliation",
                        frame_request_message_id,
                    );
                }
                let request = ClientRequest::Focus(payload);
                self.pending_host.insert(
                    frame.message_id().clone(),
                    PendingRequest {
                        request_message_id: frame.message_id().clone(),
                        connection_id: self.connection_id.clone().expect("active connection"),
                        connection_generation: self.connection_generation,
                        request: request.clone(),
                        started_at: now,
                    },
                );
                self.pending_host_fingerprints
                    .insert(frame.message_id().clone(), request_fingerprint(&frame));
                ClientReceiveOutcome::HostRequest {
                    request_message_id: frame.message_id().clone(),
                    request,
                }
            }
            Payload::Response(payload) => {
                let response_request_message_id = payload.request_message_id.clone();
                if self.phase != ClientPhase::Active {
                    return self.protocol_error_with_request_id(
                        ErrorCode::SequenceError,
                        "response arrived before snapshot reconciliation",
                        Some(response_request_message_id),
                    );
                }
                let Some(pending) = self.pending.get(&payload.request_message_id) else {
                    self.phase = ClientPhase::Closed;
                    return ClientReceiveOutcome::ProtocolError(ErrorPayload {
                        request_message_id: Some(payload.request_message_id),
                        code: ErrorCode::InvalidMessage,
                        summary: ContentFreeSummary::parse("response has no pending request")
                            .expect("static summary"),
                    });
                };
                if payload.result.validate_for_request(&pending.request).is_err() {
                    self.phase = ClientPhase::Closed;
                    return ClientReceiveOutcome::ProtocolError(ErrorPayload {
                        request_message_id: Some(payload.request_message_id),
                        code: ErrorCode::InvalidMessage,
                        summary: ContentFreeSummary::parse("response result is invalid")
                            .expect("static summary"),
                    });
                }
                self.pending.remove(&payload.request_message_id);
                ClientReceiveOutcome::Response(payload)
            }
            Payload::Error(payload) => {
                let error_request_message_id = payload.request_message_id.clone();
                if self.phase != ClientPhase::Active {
                    return self.protocol_error_with_request_id(
                        ErrorCode::SequenceError,
                        "error arrived before snapshot reconciliation",
                        error_request_message_id,
                    );
                }
                if let Some(request_message_id) = &payload.request_message_id {
                    let removed_client = self.pending.remove(request_message_id).is_some();
                    let removed_host = self.pending_host.remove(request_message_id).is_some();
                    if removed_host {
                        let fingerprint = self
                            .pending_host_fingerprints
                            .remove(request_message_id)
                            .unwrap_or_default();
                        self.host_ledger.record_request(
                            request_message_id.clone(),
                            fingerprint,
                            CachedRequestResult::Error {
                                code: payload.code,
                                summary: payload.summary,
                            },
                            now,
                        );
                    }
                    if !removed_client && !removed_host {
                        self.phase = ClientPhase::Closed;
                        return ClientReceiveOutcome::ProtocolError(ErrorPayload {
                            request_message_id: Some(request_message_id.clone()),
                            code: ErrorCode::InvalidMessage,
                            summary: ContentFreeSummary::parse("error has no pending request")
                                .expect("static summary"),
                        });
                    }
                }
                ClientReceiveOutcome::Error(payload)
            }
            Payload::HelloAccepted(_) | Payload::StateSnapshot(_) => self
                .protocol_error_with_request_id(
                    ErrorCode::InvalidMessage,
                    "unexpected handshake message",
                    frame_request_message_id,
                ),
            _ => self.protocol_error_with_request_id(
                ErrorCode::InvalidMessage,
                "unexpected server message",
                frame_request_message_id,
            ),
        }
    }

    pub fn respond_to_host_request(
        &mut self,
        request_message_id: &Uuid,
        result: Result<ResponseResult, (ErrorCode, ContentFreeSummary)>,
    ) -> Result<Envelope, ProtocolError> {
        self.respond_to_host_request_at(request_message_id, result, SystemTime::now())
    }

    pub fn respond_to_host_request_at(
        &mut self,
        request_message_id: &Uuid,
        result: Result<ResponseResult, (ErrorCode, ContentFreeSummary)>,
        now: SystemTime,
    ) -> Result<Envelope, ProtocolError> {
        let pending = self
            .pending_host
            .remove(request_message_id)
            .ok_or_else(|| ProtocolError::invalid("unknown host request"))?;
        let request = pending.request;
        let cached = match result {
            Ok(result) => {
                result.validate_for_request(&request)?;
                CachedRequestResult::Response(result)
            }
            Err((code, summary)) => CachedRequestResult::Error { code, summary },
        };
        let fingerprint =
            self.pending_host_fingerprints.remove(request_message_id).unwrap_or_default();
        self.host_ledger.record_request(
            request_message_id.clone(),
            fingerprint,
            cached.clone(),
            now,
        );
        self.send(cached.into_payload(Some(request_message_id.clone())))
    }

    pub fn expire_requests(&mut self, now: SystemTime) -> Vec<RequestFailure> {
        self.pending.expire(now).into_iter().map(RequestFailure::timeout).collect()
    }

    pub fn expire_host_requests(&mut self, now: SystemTime) -> Vec<RequestFailure> {
        let deadline = Duration::from_secs(REQUEST_DEADLINE_SECONDS);
        let expired: Vec<Uuid> = self
            .pending_host
            .values()
            .filter(|pending| {
                now.duration_since(pending.started_at).is_ok_and(|age| age >= deadline)
            })
            .map(|pending| pending.request_message_id.clone())
            .collect();
        expired
            .iter()
            .filter_map(|request_message_id| self.pending_host.remove(request_message_id))
            .map(|pending| {
                let fingerprint = self
                    .pending_host_fingerprints
                    .remove(&pending.request_message_id)
                    .unwrap_or_default();
                self.host_ledger.record_request(
                    pending.request_message_id.clone(),
                    fingerprint,
                    CachedRequestResult::Error {
                        code: ErrorCode::BridgeTimeout,
                        summary: ContentFreeSummary::parse("bridge request timed out")
                            .expect("static summary"),
                    },
                    now,
                );
                RequestFailure::timeout(pending)
            })
            .collect()
    }

    pub fn connection_lost(&mut self) -> Vec<RequestFailure> {
        self.connection_lost_at(SystemTime::now())
    }

    pub fn connection_lost_at(&mut self, now: SystemTime) -> Vec<RequestFailure> {
        self.phase = ClientPhase::Closed;
        let ids: Vec<Uuid> = self.pending.entries.keys().cloned().collect();
        let mut lost: Vec<RequestFailure> = ids
            .iter()
            .filter_map(|id| self.pending.remove(id))
            .map(RequestFailure::connection_lost)
            .collect();
        lost.extend(std::mem::take(&mut self.pending_host).into_values().map(|pending| {
            let fingerprint = self
                .pending_host_fingerprints
                .remove(&pending.request_message_id)
                .unwrap_or_default();
            self.host_ledger.record_request(
                pending.request_message_id.clone(),
                fingerprint,
                CachedRequestResult::Error {
                    code: ErrorCode::ConnectionLost,
                    summary: ContentFreeSummary::parse("connection lost").expect("static summary"),
                },
                now,
            );
            RequestFailure::connection_lost(pending)
        }));
        self.pending_host_fingerprints.clear();
        lost
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uuid(value: &str) -> Uuid {
        Uuid::parse(value).expect("fixture UUID")
    }

    fn semver(value: &str) -> SemVer {
        SemVer::parse(value).expect("fixture semver")
    }

    fn path(value: &str) -> AbsolutePath {
        AbsolutePath::parse(value).expect("fixture path")
    }

    fn context() -> Context {
        Context::workspace(uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), path("/tmp/workspace"))
    }

    fn handshake(host: &mut BridgeHost, client: &mut BridgeClient) -> Uuid {
        let hello = client.hello().expect("hello");
        let HostReceiveOutcome::HelloAccepted(accepted) = host.receive(hello) else {
            panic!("hello accepted")
        };
        let connection_id = accepted.connection_id().cloned().expect("connection");
        client.accept_hello(&accepted).expect("client accepts hello");
        let snapshot = client.snapshot(Readiness::Ready, context(), false).expect("snapshot");
        assert_eq!(host.receive(snapshot), HostReceiveOutcome::SnapshotApplied);
        connection_id
    }

    #[test]
    fn handshake_requires_snapshot_and_replaces_projection() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let instance = uuid("44444444-4444-4444-8444-444444444444");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(surface.clone(), instance, semver("0.0.1"));
        let connection = handshake(&mut host, &mut client);
        let projection = host.projection(&surface).expect("projection");
        assert_eq!(projection.connection_id, connection);
        assert_eq!(projection.context, context());

        let snapshot = client
            .send(Payload::StateSnapshot(StateSnapshotPayload {
                surface_id: surface.clone(),
                readiness: Readiness::Unavailable,
                context: Context::Global,
                dirty: true,
            }))
            .expect("replacement snapshot");
        assert_eq!(host.receive(snapshot), HostReceiveOutcome::SnapshotApplied);
        let projection = host.projection(&surface).expect("projection");
        assert_eq!(projection.context, Context::Global);
        assert_eq!(projection.readiness, Readiness::Unavailable);
        assert!(projection.dirty);
    }

    #[test]
    fn sequence_duplicate_and_gap_rules_are_enforced() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface,
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let connection = handshake(&mut host, &mut client);
        let event =
            client.send(Payload::DirtyChanged(DirtyChangedPayload { dirty: true })).expect("event");
        assert_eq!(host.receive(event.clone()), HostReceiveOutcome::EventApplied);
        let later = client
            .send(Payload::ReadyChanged(ReadyChangedPayload { readiness: Readiness::Ready }))
            .expect("later event");
        assert_eq!(host.receive(later), HostReceiveOutcome::EventApplied);
        assert_eq!(host.receive(event), HostReceiveOutcome::DuplicateIgnored);
        let gap = Envelope::new(
            Some(connection),
            6,
            Uuid::parse("66666666-6666-4666-8666-666666666666").expect("request ID"),
            MessageKind::OpenWorkspaceRequested,
            Payload::OpenWorkspaceRequested(OpenWorkspaceRequestedPayload {
                absolute_path: path("/tmp/workspace"),
                source: OpenWorkspaceSource::OpenFolder,
            }),
        )
        .expect("envelope");
        assert!(matches!(
            host.receive(gap),
            HostReceiveOutcome::ProtocolError {
                error: ErrorPayload {
                    request_message_id: Some(_),
                    code: ErrorCode::SequenceError,
                    ..
                },
                ..
            }
        ));
        let after_close = client
            .send(Payload::DirtyChanged(DirtyChangedPayload { dirty: false }))
            .expect("next frame");
        assert!(matches!(
            host.receive(after_close),
            HostReceiveOutcome::StaleConnection { .. } | HostReceiveOutcome::ProtocolError { .. }
        ));
    }

    #[test]
    fn protocol_errors_preserve_decoded_request_ids() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let request_id = uuid("66666666-6666-4666-8666-666666666666");
        let request = Envelope::new(
            Some(uuid("55555555-5555-4555-8555-555555555555")),
            2,
            request_id.clone(),
            MessageKind::OpenWorkspaceRequested,
            Payload::OpenWorkspaceRequested(OpenWorkspaceRequestedPayload {
                absolute_path: path("/tmp/workspace"),
                source: OpenWorkspaceSource::OpenFolder,
            }),
        )
        .expect("request envelope");
        let mut host = BridgeHost::new([surface]);
        let error = match host.receive(request) {
            HostReceiveOutcome::ProtocolError { error, .. }
            | HostReceiveOutcome::StaleConnection { error, .. } => error,
            other => panic!("missing connection identity was accepted: {other:?}"),
        };
        assert_eq!(error.request_message_id, Some(request_id));
    }

    #[test]
    fn duplicate_request_is_replayed_across_reconnect() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let instance = uuid("44444444-4444-4444-8444-444444444444");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(surface.clone(), instance.clone(), semver("0.0.1"));
        let connection = handshake(&mut host, &mut client);
        let request = client
            .request(
                ClientRequest::OpenWorkspace(OpenWorkspaceRequestedPayload {
                    absolute_path: path("/tmp/workspace"),
                    source: OpenWorkspaceSource::OpenFolder,
                }),
                SystemTime::UNIX_EPOCH,
            )
            .expect("request");
        let request_id = request.message_id().clone();
        assert!(matches!(
            host.receive_at(request.clone(), SystemTime::UNIX_EPOCH),
            HostReceiveOutcome::RequestPending { .. }
        ));
        let response = host
            .complete_request(
                &connection,
                &request_id,
                Ok(ResponseResult::WorkspaceRouted { context: context() }),
                SystemTime::UNIX_EPOCH,
            )
            .expect("complete");
        assert!(matches!(response.payload(), Payload::Response(_)));
        host.connection_lost(&connection, SystemTime::UNIX_EPOCH);

        let mut reconnect = BridgeClient::new(
            surface.clone(),
            uuid("99999999-9999-4999-8999-999999999999"),
            semver("0.0.1"),
        );
        let new_connection = handshake(&mut host, &mut reconnect);
        let replay = Envelope::new(
            Some(new_connection),
            3,
            request_id.clone(),
            MessageKind::OpenWorkspaceRequested,
            Payload::OpenWorkspaceRequested(OpenWorkspaceRequestedPayload {
                absolute_path: path("/tmp/workspace"),
                source: OpenWorkspaceSource::OpenFolder,
            }),
        )
        .expect("replayed request");
        assert!(matches!(
            host.receive_at(replay, SystemTime::UNIX_EPOCH),
            HostReceiveOutcome::Replayed(_)
        ));
    }

    #[test]
    fn lost_request_id_with_a_different_payload_is_rejected_after_reconnect() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface.clone(),
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let connection = handshake(&mut host, &mut client);
        let request = client
            .request(
                ClientRequest::OpenWorkspace(OpenWorkspaceRequestedPayload {
                    absolute_path: path("/tmp/workspace"),
                    source: OpenWorkspaceSource::OpenFolder,
                }),
                SystemTime::UNIX_EPOCH,
            )
            .expect("request");
        let request_id = request.message_id().clone();
        assert!(matches!(
            host.receive_at(request, SystemTime::UNIX_EPOCH),
            HostReceiveOutcome::RequestPending { .. }
        ));
        let failures = host.connection_lost(&connection, SystemTime::UNIX_EPOCH);
        assert_eq!(failures.len(), 1);

        let mut reconnect = BridgeClient::new(
            surface.clone(),
            uuid("99999999-9999-4999-8999-999999999999"),
            semver("0.0.1"),
        );
        let new_connection = handshake(&mut host, &mut reconnect);
        let replay = Envelope::new(
            Some(new_connection),
            3,
            request_id,
            MessageKind::OpenWorkspaceRequested,
            Payload::OpenWorkspaceRequested(OpenWorkspaceRequestedPayload {
                absolute_path: path("/tmp/different-workspace"),
                source: OpenWorkspaceSource::OpenFolder,
            }),
        )
        .expect("replayed request");
        let outcome = host.receive_at(replay, SystemTime::UNIX_EPOCH);
        assert!(matches!(
            outcome,
            HostReceiveOutcome::ProtocolError { error, .. }
                if error.code == ErrorCode::InvalidMessage
        ));
    }

    #[test]
    fn replacing_a_connection_surfaces_pending_host_requests_for_reconciliation() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface.clone(),
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let connection = handshake(&mut host, &mut client);
        host.request_focus_at(&connection, FocusReason::Navigation, SystemTime::UNIX_EPOCH)
            .expect("host request");
        let mut replacement = BridgeClient::new(
            surface,
            uuid("99999999-9999-4999-8999-999999999999"),
            semver("0.0.1"),
        );
        let _ = handshake(&mut host, &mut replacement);
        let failures = host.take_reconciliation_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].reason, RequestFailureReason::ConnectionLost);
        assert!(failures[0].snapshot_reconciliation_required);
    }

    #[test]
    fn reconnect_fails_an_uncompleted_request_before_replay() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface.clone(),
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let old_connection = handshake(&mut host, &mut client);
        let request = client
            .request(
                ClientRequest::OpenWorkspace(OpenWorkspaceRequestedPayload {
                    absolute_path: path("/tmp/workspace"),
                    source: OpenWorkspaceSource::OpenFolder,
                }),
                SystemTime::UNIX_EPOCH,
            )
            .expect("request");
        assert!(matches!(
            host.receive_at(request.clone(), SystemTime::UNIX_EPOCH),
            HostReceiveOutcome::RequestPending { .. }
        ));

        let mut reconnect = BridgeClient::new(
            surface,
            uuid("99999999-9999-4999-8999-999999999999"),
            semver("0.0.1"),
        );
        let new_connection = handshake(&mut host, &mut reconnect);
        assert_ne!(old_connection, new_connection);
        let replay = Envelope::new(
            Some(new_connection),
            3,
            request.message_id().clone(),
            MessageKind::OpenWorkspaceRequested,
            Payload::OpenWorkspaceRequested(OpenWorkspaceRequestedPayload {
                absolute_path: path("/tmp/workspace"),
                source: OpenWorkspaceSource::OpenFolder,
            }),
        )
        .expect("replay");
        let HostReceiveOutcome::Replayed(response) =
            host.receive_at(replay, SystemTime::UNIX_EPOCH)
        else {
            panic!("connection loss must be replayed as a cached result")
        };
        let Payload::Error(error) = response.into_payload() else {
            panic!("connection loss replay must be an error")
        };
        assert_eq!(error.code, ErrorCode::ConnectionLost);
        assert_eq!(error.request_message_id, Some(request.message_id().clone()));
    }

    #[test]
    fn typed_timeout_is_replayed_after_reconnect_without_repeating_side_effect() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface.clone(),
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let old_connection = handshake(&mut host, &mut client);
        let request = client
            .request(
                ClientRequest::OpenWorkspace(OpenWorkspaceRequestedPayload {
                    absolute_path: path("/tmp/workspace"),
                    source: OpenWorkspaceSource::OpenFolder,
                }),
                SystemTime::UNIX_EPOCH,
            )
            .expect("request");
        assert!(matches!(
            host.receive_at(request.clone(), SystemTime::UNIX_EPOCH),
            HostReceiveOutcome::RequestPending { .. }
        ));
        let failures =
            host.expire_request_failures(SystemTime::UNIX_EPOCH + Duration::from_secs(5));
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].reason, RequestFailureReason::TimedOut);

        let mut reconnect = BridgeClient::new(
            surface,
            uuid("99999999-9999-4999-8999-999999999999"),
            semver("0.0.1"),
        );
        let new_connection = handshake(&mut host, &mut reconnect);
        assert_ne!(old_connection, new_connection);
        let replay = Envelope::new(
            Some(new_connection),
            3,
            request.message_id().clone(),
            MessageKind::OpenWorkspaceRequested,
            Payload::OpenWorkspaceRequested(OpenWorkspaceRequestedPayload {
                absolute_path: path("/tmp/workspace"),
                source: OpenWorkspaceSource::OpenFolder,
            }),
        )
        .expect("replay");
        let HostReceiveOutcome::Replayed(response) =
            host.receive_at(replay, SystemTime::UNIX_EPOCH + Duration::from_secs(5))
        else {
            panic!("typed timeout must be replayed from the stable ledger")
        };
        let Payload::Error(error) = response.into_payload() else {
            panic!("timeout replay must be an error")
        };
        assert_eq!(error.code, ErrorCode::BridgeTimeout);
        assert_eq!(error.request_message_id, Some(request.message_id().clone()));
    }

    #[test]
    fn client_replays_cached_host_request_on_an_exact_duplicate() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface,
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let connection = handshake(&mut host, &mut client);
        let request =
            host.request_focus(&connection, FocusReason::Navigation).expect("host request");
        let request_id = request.message_id().clone();
        let ClientReceiveOutcome::HostRequest { request_message_id, .. } =
            client.receive_at(request.clone(), SystemTime::UNIX_EPOCH)
        else {
            panic!("host request must be delivered")
        };
        assert_eq!(request_message_id, request_id);
        let response = client
            .respond_to_host_request(&request_id, Ok(ResponseResult::Focused))
            .expect("host response");
        assert!(matches!(response.payload(), Payload::Response(_)));

        let ClientReceiveOutcome::Replayed(replay) =
            client.receive_at(request, SystemTime::UNIX_EPOCH)
        else {
            panic!("exact host-request duplicate must replay its cached result")
        };
        assert!(matches!(replay.payload(), Payload::Response(_)));
    }

    #[test]
    fn ledger_retains_latest_capacity_and_expires_by_age() {
        let mut ledger = RequestLedger::new();
        let start = SystemTime::UNIX_EPOCH;
        let mut oldest = None;
        for _ in 0..REQUEST_LEDGER_MIN_ENTRIES {
            let message_id = Uuid::fresh();
            oldest.get_or_insert_with(|| message_id.clone());
            ledger.record(
                message_id,
                CachedRequestResult::Error {
                    code: ErrorCode::RequestFailed,
                    summary: ContentFreeSummary::parse("failed").expect("summary"),
                },
                start,
            );
        }
        assert_eq!(ledger.len(start), REQUEST_LEDGER_MIN_ENTRIES);
        let id = Uuid::fresh();
        ledger.record(
            id.clone(),
            CachedRequestResult::Error {
                code: ErrorCode::RequestFailed,
                summary: ContentFreeSummary::parse("failed").expect("summary"),
            },
            start,
        );
        assert_eq!(ledger.len(start), REQUEST_LEDGER_MIN_ENTRIES + 1);
        assert!(ledger.lookup(&id, start).is_some());
        assert!(ledger
            .lookup(&id, start + Duration::from_secs(REQUEST_LEDGER_MIN_RETENTION_SECONDS))
            .is_some());
        assert!(ledger
            .lookup(
                oldest.as_ref().expect("oldest ID"),
                start + Duration::from_secs(REQUEST_LEDGER_MIN_RETENTION_SECONDS)
            )
            .is_none());
    }

    #[test]
    fn ledger_has_an_absolute_bound_even_during_the_retention_window() {
        let mut ledger = RequestLedger::new();
        let now = SystemTime::UNIX_EPOCH;
        for _ in 0..=REQUEST_LEDGER_MAX_ENTRIES {
            ledger.record(
                Uuid::fresh(),
                CachedRequestResult::Error {
                    code: ErrorCode::RequestFailed,
                    summary: ContentFreeSummary::parse("failed").expect("summary"),
                },
                now,
            );
        }
        assert_eq!(ledger.len(now), REQUEST_LEDGER_MAX_ENTRIES);
    }

    #[test]
    fn pending_deadline_and_connection_loss_are_deterministic() {
        let id = uuid("77777777-7777-4777-8777-777777777777");
        let connection = uuid("55555555-5555-4555-8555-555555555555");
        let mut pending = PendingRequests::default();
        pending.insert(PendingRequest {
            request_message_id: id,
            connection_id: connection.clone(),
            connection_generation: 1,
            request: ClientRequest::Focus(FocusPayload { reason: FocusReason::Navigation }),
            started_at: SystemTime::UNIX_EPOCH,
        });
        assert_eq!(pending.expire(SystemTime::UNIX_EPOCH + Duration::from_secs(5)).len(), 1);
    }

    #[test]
    fn timeout_and_loss_are_typed_reconciliation_outcomes() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface,
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let connection = handshake(&mut host, &mut client);
        let request = client
            .request(
                ClientRequest::OpenWorkspace(OpenWorkspaceRequestedPayload {
                    absolute_path: path("/tmp/workspace"),
                    source: OpenWorkspaceSource::OpenFolder,
                }),
                SystemTime::UNIX_EPOCH,
            )
            .expect("request");
        assert!(matches!(host.receive(request.clone()), HostReceiveOutcome::RequestPending { .. }));
        let timeout = client.expire_requests(SystemTime::now() + Duration::from_secs(5));
        assert_eq!(timeout.len(), 1);
        assert_eq!(timeout[0].reason, RequestFailureReason::TimedOut);
        assert!(timeout[0].snapshot_reconciliation_required);

        let loss = host.connection_lost(&connection, SystemTime::UNIX_EPOCH);
        assert_eq!(loss.len(), 1);
        assert_eq!(loss[0].reason, RequestFailureReason::ConnectionLost);
        assert!(loss[0].snapshot_reconciliation_required);
        assert_eq!(request.kind(), MessageKind::OpenWorkspaceRequested);
    }

    #[test]
    fn host_request_timeout_and_connection_loss_are_recorded_once() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface,
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let connection = handshake(&mut host, &mut client);
        let request = host
            .request_focus_at(&connection, FocusReason::Navigation, SystemTime::UNIX_EPOCH)
            .expect("host request");
        assert!(matches!(
            client.receive_at(request.clone(), SystemTime::UNIX_EPOCH),
            ClientReceiveOutcome::HostRequest { .. }
        ));
        let failure = client.expire_host_requests(SystemTime::UNIX_EPOCH + Duration::from_secs(5));
        assert_eq!(failure.len(), 1);
        assert_eq!(failure[0].reason, RequestFailureReason::TimedOut);
        assert!(client
            .expire_host_requests(SystemTime::UNIX_EPOCH + Duration::from_secs(6))
            .is_empty());

        let request = host
            .request_focus_at(&connection, FocusReason::WindowRestore, SystemTime::UNIX_EPOCH)
            .expect("second host request");
        assert!(matches!(
            client.receive_at(request, SystemTime::UNIX_EPOCH),
            ClientReceiveOutcome::HostRequest { .. }
        ));
        let lost = client.connection_lost_at(SystemTime::UNIX_EPOCH);
        assert_eq!(lost.len(), 1);
        assert_eq!(lost[0].reason, RequestFailureReason::ConnectionLost);
        assert!(client.connection_lost_at(SystemTime::UNIX_EPOCH).is_empty());
    }

    #[test]
    fn host_request_ledger_replays_non_adjacent_duplicate() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::new([surface.clone()]);
        let mut client = BridgeClient::new(
            surface,
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
        );
        let connection = handshake(&mut host, &mut client);
        let mut first = None;
        for index in 0..(REQUEST_LEDGER_MIN_ENTRIES + 1) {
            let request = host
                .request_focus_at(
                    &connection,
                    if index % 2 == 0 {
                        FocusReason::Navigation
                    } else {
                        FocusReason::WindowRestore
                    },
                    SystemTime::UNIX_EPOCH,
                )
                .expect("host request");
            first.get_or_insert_with(|| request.clone());
            let ClientReceiveOutcome::HostRequest { request_message_id, .. } =
                client.receive_at(request, SystemTime::UNIX_EPOCH)
            else {
                panic!("host request must be delivered")
            };
            let response = client
                .respond_to_host_request_at(
                    &request_message_id,
                    Ok(ResponseResult::Focused),
                    SystemTime::UNIX_EPOCH,
                )
                .expect("response");
            assert!(matches!(
                host.receive_at(response, SystemTime::UNIX_EPOCH),
                HostReceiveOutcome::ResponseAccepted
            ));
        }
        let duplicate = first.expect("first host request");
        assert!(matches!(
            client.receive_at(duplicate, SystemTime::UNIX_EPOCH),
            ClientReceiveOutcome::Replayed(_)
        ));
    }

    #[test]
    fn injected_identifier_failure_is_typed() {
        #[derive(Debug)]
        struct FailingSource;
        impl IdSource for FailingSource {
            fn next_uuid(&mut self) -> Result<Uuid, IdSourceError> {
                Err(IdSourceError::Unavailable("test".to_owned()))
            }
        }
        let source: IdSourceHandle = Arc::new(Mutex::new(FailingSource));
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let mut host = BridgeHost::with_id_source([surface.clone()], source.clone());
        let mut client = BridgeClient::with_id_source(
            surface,
            uuid("44444444-4444-4444-8444-444444444444"),
            semver("0.0.1"),
            source,
        );
        assert_eq!(
            client.hello().expect_err("failing source").code(),
            ErrorCode::SurfaceUnavailable
        );
        let hello = Envelope::new(
            None,
            1,
            uuid("33333333-3333-4333-8333-333333333333"),
            MessageKind::Hello,
            Payload::Hello(HelloPayload {
                extension_version: semver("0.0.1"),
                surface_id: uuid("11111111-1111-4111-8111-111111111111"),
                workbench_instance_id: uuid("44444444-4444-4444-8444-444444444444"),
            }),
        )
        .expect("hello");
        assert!(matches!(
            host.receive(hello),
            HostReceiveOutcome::ProtocolError {
                error: ErrorPayload { code: ErrorCode::SurfaceUnavailable, .. },
                ..
            }
        ));
    }
}
