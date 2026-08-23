//! Authenticated loopback transport for the frozen DevHub Bridge contract.
//!
//! The transport owns only RFC6455 framing, the loopback upgrade boundary, and
//! physical socket lifecycle.  Message ordering, connection generations,
//! replay ledgers, and request validation remain in the core `BridgeHost`.

use devhub_app_core::bridge::{
    bearer_token, BridgeHost, ClientRequest, ContentFreeSummary, Context, Envelope, ErrorCode,
    HostReceiveOutcome, IdSourceHandle, LoopbackEndpoint, MessageKind, Payload, Readiness,
    ResponseResult, Uuid,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{accept_hdr_with_config, Message, WebSocket};

use super::error::{EditorError, EditorErrorCode, EditorResult};
use super::token::SecretToken;

const BRIDGE_PATH: &str = "/bridge";
const MAX_HTTP_HEADERS: usize = 16 * 1024;
const MAX_FRAME_BYTES: usize = devhub_app_core::bridge::MAX_MESSAGE_BYTES;
const MAX_CONNECTIONS: usize = 128;
const ACCEPT_POLL: Duration = Duration::from_millis(25);
const SOCKET_READ_POLL: Duration = Duration::from_millis(100);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// A stable native identity carried by typed Bridge events.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct BridgeSurfaceId(Uuid);

impl BridgeSurfaceId {
    pub(crate) fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    pub(crate) fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

/// Domain-only observations emitted by the Bridge host. No JSON, URL query,
/// bearer token, extension identifier, or provider handle crosses this seam.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BridgeEvent {
    Connected {
        surface_id: BridgeSurfaceId,
        generation: u64,
    },
    Disconnected {
        surface_id: BridgeSurfaceId,
        generation: u64,
    },
    Snapshot {
        surface_id: BridgeSurfaceId,
        generation: u64,
        readiness: Readiness,
        context: Context,
        dirty: bool,
    },
    ReadinessChanged {
        surface_id: BridgeSurfaceId,
        generation: u64,
        readiness: Readiness,
    },
    IdentityChanged {
        surface_id: BridgeSurfaceId,
        generation: u64,
        context: Context,
    },
    DirtyChanged {
        surface_id: BridgeSurfaceId,
        generation: u64,
        dirty: bool,
    },
    RequestFailed {
        handle: BridgeRequestHandle,
        reason: devhub_app_core::bridge::RequestFailureReason,
    },
}

/// Typed result for a request that originated in the extension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BridgeRequestResult {
    WorkspaceRouted { context: Context },
    GlobalRouted { context: Context },
    SnapshotWillFollow,
    Focused,
    Error { code: ErrorCode, summary: ContentFreeSummary },
}

/// Opaque identity for completing one extension-originated request. The
/// connection ID and generation prevent an old WebSocket from completing a
/// request after reconnect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeRequestHandle {
    surface_id: BridgeSurfaceId,
    connection_id: Uuid,
    connection_generation: u64,
    request_message_id: Uuid,
}

impl BridgeRequestHandle {
    pub fn surface_id(&self) -> &BridgeSurfaceId {
        &self.surface_id
    }

    pub fn connection_generation(&self) -> u64 {
        self.connection_generation
    }
}

/// Typed request handed to the host integration seam. No raw envelope, URL,
/// bearer token, or provider-specific identifier crosses this boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeRequest {
    handle: BridgeRequestHandle,
    request: ClientRequest,
}

impl BridgeRequest {
    pub fn handle(&self) -> &BridgeRequestHandle {
        &self.handle
    }

    pub fn request(&self) -> &ClientRequest {
        &self.request
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BridgeRequestDisposition {
    Immediate(BridgeRequestResult),
    Pending,
}

/// Requests and observations are the only integration seam exposed by the
/// transport. Implementations must keep user-facing diagnostics content-free.
pub trait BridgeEventSink: Send + Sync {
    fn on_event(&self, event: BridgeEvent);

    /// Enqueue or complete the request without blocking on external
    /// coordination. Returning [`BridgeRequestDisposition::Pending`] leaves
    /// the typed handle available for `EditorHost::complete_bridge_request`.
    fn on_request(&self, request: &BridgeRequest) -> BridgeRequestDisposition;
}

#[derive(Debug, Default)]
pub(crate) struct NoopBridgeEventSink;

impl BridgeEventSink for NoopBridgeEventSink {
    fn on_event(&self, _event: BridgeEvent) {}

    fn on_request(&self, request: &BridgeRequest) -> BridgeRequestDisposition {
        match request.request() {
            ClientRequest::OpenWorkspace(_) | ClientRequest::NewWindow(_) => {
                BridgeRequestDisposition::Immediate(BridgeRequestResult::Error {
                    code: ErrorCode::SurfaceUnavailable,
                    summary: ContentFreeSummary::Failed,
                })
            }
            ClientRequest::RequestStateSnapshot(_) => {
                BridgeRequestDisposition::Immediate(BridgeRequestResult::SnapshotWillFollow)
            }
            ClientRequest::Focus(_) => {
                BridgeRequestDisposition::Immediate(BridgeRequestResult::Focused)
            }
        }
    }
}

trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}

#[derive(Debug, Default)]
struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

type BridgeSocket = WebSocket<HeaderLimitedStream>;

struct BridgeConnection {
    surface_id: BridgeSurfaceId,
    connection_id: Uuid,
    connection_generation: u64,
    stream: Arc<Mutex<BridgeSocket>>,
    finished: AtomicBool,
}

impl fmt::Debug for BridgeConnection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BridgeConnection")
            .field("surface_id", &self.surface_id)
            .field("connection_id", &"<redacted>")
            .finish()
    }
}

impl BridgeConnection {
    fn close(&self) {
        if let Ok(mut stream) = self.stream.lock() {
            let _ = stream.close(None);
            let _ = stream.get_mut().shutdown();
        }
    }

    fn finish_once(&self) -> bool {
        !self.finished.swap(true, Ordering::AcqRel)
    }
}

struct TransportState {
    expected: BTreeSet<Uuid>,
    hosts: BTreeMap<Uuid, BridgeHost>,
    connections: BTreeMap<Uuid, Arc<BridgeConnection>>,
}

struct BridgeTransportInner {
    endpoint: Arc<LoopbackEndpoint>,
    expected_host: String,
    stop: AtomicBool,
    pending_connections: std::sync::atomic::AtomicUsize,
    next_worker_id: AtomicU64,
    worker_panicked: AtomicBool,
    workers: Mutex<BTreeMap<u64, Worker>>,
    state: Mutex<TransportState>,
    sink: Arc<dyn BridgeEventSink>,
    id_source: IdSourceHandle,
    clock: Arc<dyn Clock>,
    listener_thread: Mutex<Option<JoinHandle<()>>>,
}

struct Worker {
    abort: TcpStream,
    handle: JoinHandle<()>,
}

struct BridgeTransportOwner {
    count: AtomicUsize,
}

/// Bounds the bytes consumed by tungstenite's HTTP upgrade parser without
/// duplicating its RFC parser. Once the header terminator is seen, normal
/// WebSocket frame reads are delegated unchanged.
struct HeaderLimitedStream {
    inner: TcpStream,
    header_bytes: usize,
    header_complete: bool,
    header_tail: Vec<u8>,
}

impl HeaderLimitedStream {
    fn new(inner: TcpStream) -> Self {
        Self { inner, header_bytes: 0, header_complete: false, header_tail: Vec::with_capacity(3) }
    }

    fn shutdown(&mut self) -> io::Result<()> {
        self.inner.shutdown(Shutdown::Both)
    }
}

impl Read for HeaderLimitedStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        if !self.header_complete {
            self.header_bytes = self.header_bytes.saturating_add(count);
            if self.header_bytes > MAX_HTTP_HEADERS {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "upgrade header too large"));
            }
            let mut probe = Vec::with_capacity(self.header_tail.len() + count);
            probe.extend_from_slice(&self.header_tail);
            probe.extend_from_slice(&buffer[..count]);
            if probe.windows(4).any(|window| window == b"\r\n\r\n") {
                self.header_complete = true;
            } else {
                self.header_tail.clear();
                let keep = probe.len().min(3);
                self.header_tail.extend_from_slice(&probe[probe.len() - keep..]);
            }
        }
        Ok(count)
    }
}

impl Write for HeaderLimitedStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.inner.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// The host-owned loopback Bridge endpoint. It is created before the
/// OpenVSCode child process and remains alive across child crash/restart.
pub(crate) struct BridgeTransport {
    inner: Arc<BridgeTransportInner>,
    owner: Arc<BridgeTransportOwner>,
    token: SecretToken,
    endpoint: String,
}

pub(crate) trait BridgeTransportFactory: Send + Sync {
    fn bind(
        &self,
        token: SecretToken,
        expected: Vec<Uuid>,
        sink: Arc<dyn BridgeEventSink>,
    ) -> EditorResult<BridgeTransport>;
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct SystemBridgeTransportFactory;

impl BridgeTransportFactory for SystemBridgeTransportFactory {
    fn bind(
        &self,
        token: SecretToken,
        expected: Vec<Uuid>,
        sink: Arc<dyn BridgeEventSink>,
    ) -> EditorResult<BridgeTransport> {
        BridgeTransport::bind(token, expected, sink)
    }
}

#[cfg(test)]
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct NoopBridgeTransportFactory;

#[cfg(test)]
impl BridgeTransportFactory for NoopBridgeTransportFactory {
    fn bind(
        &self,
        token: SecretToken,
        _expected: Vec<Uuid>,
        _sink: Arc<dyn BridgeEventSink>,
    ) -> EditorResult<BridgeTransport> {
        Ok(BridgeTransport::noop(token))
    }
}

impl fmt::Debug for BridgeTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BridgeTransport")
            .field("endpoint", &self.endpoint)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl Clone for BridgeTransport {
    fn clone(&self) -> Self {
        self.owner.count.fetch_add(1, Ordering::Relaxed);
        Self {
            inner: Arc::clone(&self.inner),
            owner: Arc::clone(&self.owner),
            token: self.token.clone(),
            endpoint: self.endpoint.clone(),
        }
    }
}

impl BridgeTransport {
    pub(crate) fn bind(
        token: SecretToken,
        expected: impl IntoIterator<Item = Uuid>,
        sink: Arc<dyn BridgeEventSink>,
    ) -> EditorResult<Self> {
        Self::bind_with_clock_and_ids(
            token,
            expected,
            sink,
            Arc::new(SystemClock),
            Arc::new(Mutex::new(devhub_app_core::bridge::SecureIdSource)),
        )
    }

    fn bind_with_clock_and_ids(
        token: SecretToken,
        expected: impl IntoIterator<Item = Uuid>,
        sink: Arc<dyn BridgeEventSink>,
        clock: Arc<dyn Clock>,
        id_source: IdSourceHandle,
    ) -> EditorResult<Self> {
        let listener = TcpListener::bind((super::paths::LOOPBACK_HOST, 0))
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let port = listener
            .local_addr()
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?
            .port();
        let endpoint_text = format!("ws://{}:{port}{BRIDGE_PATH}", super::paths::LOOPBACK_HOST);
        let endpoint_token = bearer_token(token.hex())
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let endpoint = LoopbackEndpoint::new(endpoint_text.clone(), endpoint_token)
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let endpoint = Arc::new(endpoint);
        let inner = Arc::new(BridgeTransportInner {
            endpoint,
            expected_host: format!("{}:{port}", super::paths::LOOPBACK_HOST),
            stop: AtomicBool::new(false),
            pending_connections: std::sync::atomic::AtomicUsize::new(0),
            next_worker_id: AtomicU64::new(1),
            worker_panicked: AtomicBool::new(false),
            workers: Mutex::new(BTreeMap::new()),
            state: Mutex::new(TransportState {
                expected: expected.into_iter().collect(),
                hosts: BTreeMap::new(),
                connections: BTreeMap::new(),
            }),
            sink,
            id_source,
            clock,
            listener_thread: Mutex::new(None),
        });
        let thread_inner = Arc::clone(&inner);
        let listener_thread = thread::Builder::new()
            .name("devhub-bridge-listener".to_owned())
            .spawn(move || accept_loop(listener, thread_inner))
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        *inner
            .listener_thread
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))? =
            Some(listener_thread);
        Ok(Self {
            inner,
            owner: Arc::new(BridgeTransportOwner { count: AtomicUsize::new(1) }),
            token,
            endpoint: endpoint_text,
        })
    }

    #[cfg(test)]
    pub(crate) fn noop(token: SecretToken) -> Self {
        let endpoint_text = "ws://127.0.0.1:1/bridge".to_owned();
        let endpoint_token = bearer_token(token.hex()).expect("test token is valid");
        let endpoint = LoopbackEndpoint::new(endpoint_text.clone(), endpoint_token)
            .expect("test endpoint is valid");
        let endpoint = Arc::new(endpoint);
        let inner = Arc::new(BridgeTransportInner {
            endpoint,
            expected_host: "127.0.0.1:1".to_owned(),
            stop: AtomicBool::new(false),
            pending_connections: std::sync::atomic::AtomicUsize::new(0),
            next_worker_id: AtomicU64::new(1),
            worker_panicked: AtomicBool::new(false),
            workers: Mutex::new(BTreeMap::new()),
            state: Mutex::new(TransportState {
                expected: BTreeSet::new(),
                hosts: BTreeMap::new(),
                connections: BTreeMap::new(),
            }),
            sink: Arc::new(NoopBridgeEventSink),
            id_source: Arc::new(Mutex::new(devhub_app_core::bridge::SecureIdSource)),
            clock: Arc::new(SystemClock),
            listener_thread: Mutex::new(None),
        });
        Self {
            inner,
            owner: Arc::new(BridgeTransportOwner { count: AtomicUsize::new(1) }),
            token,
            endpoint: endpoint_text,
        }
    }

    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(crate) fn token_hex(&self) -> String {
        self.token.hex()
    }

    pub(crate) fn set_expected(&self, expected: impl IntoIterator<Item = Uuid>) {
        let next: BTreeSet<Uuid> = expected.into_iter().collect();
        let (stale, disconnected, failures) = self
            .inner
            .state
            .lock()
            .ok()
            .map(|mut state| {
                let stale_keys: Vec<Uuid> = state
                    .connections
                    .keys()
                    .filter(|surface_id| !next.contains(*surface_id))
                    .cloned()
                    .collect();
                let mut stale = Vec::with_capacity(stale_keys.len());
                let mut disconnected = Vec::with_capacity(stale_keys.len());
                let mut failures = Vec::new();
                for surface_id in stale_keys {
                    if let Some(connection) = state.connections.remove(&surface_id) {
                        if connection.finish_once() {
                            if let Some(host) = state.hosts.get_mut(&surface_id) {
                                failures.extend(
                                    host.connection_lost(
                                        &connection.connection_id,
                                        self.inner.clock.now(),
                                    )
                                    .into_iter()
                                    .map(|failure| (connection.surface_id.clone(), failure)),
                                );
                            }
                            disconnected.push((
                                connection.surface_id.clone(),
                                connection.connection_generation,
                            ));
                        }
                        stale.push(connection);
                    }
                }
                let retired_hosts: Vec<Uuid> = state
                    .hosts
                    .keys()
                    .filter(|surface_id| !next.contains(*surface_id))
                    .cloned()
                    .collect();
                for surface_id in retired_hosts {
                    state.hosts.remove(&surface_id);
                }
                state.expected = next;
                (stale, disconnected, failures)
            })
            .unwrap_or_default();
        for connection in stale {
            connection.close();
        }
        for (surface_id, failure) in failures {
            self.inner.sink.on_event(request_failure_event(&surface_id, failure));
        }
        for (surface_id, generation) in disconnected {
            self.inner.sink.on_event(BridgeEvent::Disconnected { surface_id, generation });
        }
    }

    /// Requests a complete state snapshot from a connected Workbench.
    pub(crate) fn request_snapshot(&self, surface_id: &BridgeSurfaceId) -> EditorResult<()> {
        self.send_host_request(surface_id, true)
    }

    /// Requests focus from a connected Workbench.
    pub(crate) fn request_focus(&self, surface_id: &BridgeSurfaceId) -> EditorResult<()> {
        self.send_host_request(surface_id, false)
    }

    pub(crate) fn complete_bridge_request(
        &self,
        handle: BridgeRequestHandle,
        result: BridgeRequestResult,
    ) -> EditorResult<()> {
        complete_request_inner(&self.inner, handle, result)
    }

    fn send_host_request(&self, surface_id: &BridgeSurfaceId, snapshot: bool) -> EditorResult<()> {
        let connection = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
            let connection = state
                .connections
                .get(surface_id.as_uuid())
                .cloned()
                .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
            let host = state
                .hosts
                .get_mut(surface_id.as_uuid())
                .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
            let envelope = if snapshot {
                host.request_snapshot_at(
                    &connection.connection_id,
                    devhub_app_core::bridge::SnapshotRequestReason::HostReconcile,
                    self.inner.clock.now(),
                )
            } else {
                host.request_focus_at(
                    &connection.connection_id,
                    devhub_app_core::bridge::FocusReason::WindowRestore,
                    self.inner.clock.now(),
                )
            }
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
            (connection, envelope)
        };
        write_text_frame(&connection.0.stream, &connection.1)
    }

    pub(crate) fn stop(&self) -> EditorResult<()> {
        let first_stop = !self.inner.stop.swap(true, Ordering::AcqRel);
        if first_stop {
            let connections = self
                .inner
                .state
                .lock()
                .map(|state| state.connections.values().cloned().collect::<Vec<_>>())
                .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
            for connection in connections {
                connection.close();
            }
        }
        if let Some(thread) = self
            .inner
            .listener_thread
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?
            .take()
        {
            thread.join().map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        }
        shutdown_workers(&self.inner);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let finished = self
                .inner
                .workers
                .lock()
                .map(|mut workers| {
                    let ids: Vec<u64> = workers
                        .iter()
                        .filter_map(|(id, worker)| worker.handle.is_finished().then_some(*id))
                        .collect();
                    ids.into_iter().filter_map(|id| workers.remove(&id)).collect::<Vec<_>>()
                })
                .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
            for worker in finished {
                worker
                    .handle
                    .join()
                    .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
            }
            let remaining = self
                .inner
                .workers
                .lock()
                .map(|workers| !workers.is_empty())
                .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
            if !remaining {
                if self.inner.worker_panicked.load(Ordering::Acquire) {
                    return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
                }
                return Ok(());
            }
            if Instant::now() >= deadline {
                // Keep the handles in the registry. A later shutdown attempt
                // can repeat the raw shutdown and reap a worker that was
                // temporarily unable to observe the first close.
                return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for BridgeTransport {
    fn drop(&mut self) {
        if self.owner.count.fetch_sub(1, Ordering::AcqRel) == 1 {
            let _ = self.stop();
        }
    }
}

fn accept_loop(listener: TcpListener, inner: Arc<BridgeTransportInner>) {
    while !inner.stop.load(Ordering::Acquire) {
        prune_finished_workers(&inner);
        match listener.accept() {
            Ok((stream, _peer)) => {
                let reserved = inner
                    .pending_connections
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                        (count < MAX_CONNECTIONS).then_some(count + 1)
                    })
                    .is_ok();
                if !reserved {
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                if inner.stop.load(Ordering::Acquire) {
                    let _ = stream.shutdown(Shutdown::Both);
                    inner.pending_connections.fetch_sub(1, Ordering::AcqRel);
                    break;
                }
                let abort = match stream.try_clone() {
                    Ok(abort) => abort,
                    Err(_) => {
                        let _ = stream.shutdown(Shutdown::Both);
                        inner.pending_connections.fetch_sub(1, Ordering::AcqRel);
                        continue;
                    }
                };
                let worker_id = inner.next_worker_id.fetch_add(1, Ordering::Relaxed);
                let connection_inner = Arc::clone(&inner);
                let handle = thread::Builder::new()
                    .name("devhub-bridge-connection".to_owned())
                    .spawn(move || {
                        if catch_unwind(AssertUnwindSafe(|| {
                            connection_loop(stream, connection_inner.clone());
                        }))
                        .is_err()
                        {
                            connection_inner.worker_panicked.store(true, Ordering::Release);
                        }
                        connection_inner.pending_connections.fetch_sub(1, Ordering::AcqRel);
                    });
                match handle {
                    Ok(handle) => {
                        if let Ok(mut workers) = inner.workers.lock() {
                            workers.insert(worker_id, Worker { abort, handle });
                        } else {
                            let _ = abort.shutdown(Shutdown::Both);
                        }
                    }
                    Err(_) => {
                        let _ = abort.shutdown(Shutdown::Both);
                        inner.pending_connections.fetch_sub(1, Ordering::AcqRel);
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
            Err(_) => {
                if !inner.stop.load(Ordering::Acquire) {
                    thread::sleep(ACCEPT_POLL);
                }
            }
        }
    }
}

fn shutdown_workers(inner: &BridgeTransportInner) {
    if let Ok(workers) = inner.workers.lock() {
        for worker in workers.values() {
            let _ = worker.abort.shutdown(Shutdown::Both);
        }
    }
}

fn prune_finished_workers(inner: &BridgeTransportInner) {
    let finished = inner
        .workers
        .lock()
        .ok()
        .map(|mut workers| {
            let ids: Vec<u64> = workers
                .iter()
                .filter_map(|(id, worker)| worker.handle.is_finished().then_some(*id))
                .collect();
            ids.into_iter().filter_map(|id| workers.remove(&id)).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for worker in finished {
        let _ = worker.handle.join();
    }
}

fn expire_requests(inner: &BridgeTransportInner) {
    let Some(responses) = inner.state.lock().ok().map(|mut state| {
        let now = inner.clock.now();
        let mut responses = Vec::new();
        for host in state.hosts.values_mut() {
            responses.extend(host.expire_requests(now));
        }
        responses
            .into_iter()
            .filter_map(|response| {
                let connection_id = response.connection_id()?.clone();
                state
                    .connections
                    .values()
                    .find(|connection| connection.connection_id == connection_id)
                    .cloned()
                    .map(|connection| (connection, response))
            })
            .collect::<Vec<_>>()
    }) else {
        return;
    };
    for (connection, response) in responses {
        let _ = write_text_frame(&connection.stream, &response);
    }
}

fn connection_loop(stream: TcpStream, inner: Arc<BridgeTransportInner>) {
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut connection: Option<Arc<BridgeConnection>> = None;
    let result = (|| -> EditorResult<()> {
        let mut socket = accept_socket(stream, &inner)?;
        let _ = socket.get_mut().inner.set_read_timeout(Some(SOCKET_READ_POLL));
        let socket = Arc::new(Mutex::new(socket));
        loop {
            expire_requests(&inner);
            let frame = match socket
                .lock()
                .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?
                .read()
            {
                Ok(frame) => frame,
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    if inner.stop.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    continue;
                }
                Err(_) => return Err(EditorError::new(EditorErrorCode::BridgeUnavailable)),
            };
            match frame {
                Message::Text(text) => {
                    if text.len() > MAX_FRAME_BYTES {
                        return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
                    }
                    let envelope = Envelope::decode(text.as_bytes())
                        .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
                    let is_hello = envelope.kind() == MessageKind::Hello;
                    if is_hello && connection.is_some() {
                        return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
                    }
                    if is_hello {
                        let surface_id = match envelope.payload() {
                            Payload::Hello(payload) => payload.surface_id.clone(),
                            _ => return Err(EditorError::new(EditorErrorCode::BridgeUnavailable)),
                        };
                        let accepted =
                            handle_hello(&inner, surface_id, envelope, Arc::clone(&socket))?;
                        connection = Some(accepted);
                        continue;
                    }
                    let Some(active) = connection.as_ref() else {
                        return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
                    };
                    handle_message(&inner, active, envelope)?;
                }
                Message::Ping(_) | Message::Pong(_) => {}
                Message::Close(_) => return Ok(()),
                Message::Binary(_) | Message::Frame(_) => {
                    return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
                }
            }
        }
    })();
    let _ = result;
    if let Some(connection) = connection {
        finish_connection(&inner, &connection);
    }
}

#[allow(clippy::result_large_err)]
fn accept_socket(stream: TcpStream, inner: &BridgeTransportInner) -> EditorResult<BridgeSocket> {
    let endpoint = Arc::clone(&inner.endpoint);
    let expected_host = inner.expected_host.clone();
    let callback = move |request: &Request, response: Response| {
        validate_upgrade_request(request, &endpoint, &expected_host)
            .map(|()| response)
            .map_err(|_| rejected_upgrade_response())
    };
    let config = WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .write_buffer_size(16 * 1024)
        .max_write_buffer_size(64 * 1024)
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES));
    accept_hdr_with_config(HeaderLimitedStream::new(stream), callback, Some(config))
        .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))
}

fn rejected_upgrade_response() -> ErrorResponse {
    tungstenite::http::Response::builder()
        .status(tungstenite::http::StatusCode::UNAUTHORIZED)
        .body(Some(String::new()))
        .expect("static response is valid")
}

fn validate_upgrade_request(
    request: &Request,
    endpoint: &LoopbackEndpoint,
    expected_host: &str,
) -> Result<(), ()> {
    if request.uri().path() != BRIDGE_PATH || request.uri().query().is_some() {
        return Err(());
    }
    for name in [
        "authorization",
        "connection",
        "host",
        "sec-websocket-key",
        "sec-websocket-version",
        "upgrade",
    ] {
        if request.headers().get_all(name).iter().count() != 1 {
            return Err(());
        }
    }
    let host = request.headers().get("host").and_then(|value| value.to_str().ok()).ok_or(())?;
    if host != expected_host {
        return Err(());
    }
    let authorization =
        request.headers().get("authorization").and_then(|value| value.to_str().ok());
    endpoint.validate_authorization(authorization).map_err(|_| ())
}

fn handle_hello(
    inner: &BridgeTransportInner,
    surface_uuid: Uuid,
    hello: Envelope,
    stream: Arc<Mutex<BridgeSocket>>,
) -> EditorResult<Arc<BridgeConnection>> {
    let (accepted, old_connection, connection, event, failures) = {
        let mut state =
            inner.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        if !state.expected.contains(&surface_uuid) {
            return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
        }
        let accepted = {
            let host = state.hosts.entry(surface_uuid.clone()).or_insert_with(|| {
                BridgeHost::with_id_source([surface_uuid.clone()], Arc::clone(&inner.id_source))
            });
            match host.receive_at(hello, inner.clock.now()) {
                HostReceiveOutcome::HelloAccepted(accepted) => accepted,
                _ => return Err(EditorError::new(EditorErrorCode::BridgeUnavailable)),
            }
        };
        let connection_id = accepted
            .connection_id()
            .cloned()
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let generation = match accepted.payload() {
            Payload::HelloAccepted(payload) => payload.connection_generation,
            _ => return Err(EditorError::new(EditorErrorCode::BridgeUnavailable)),
        };
        let surface_id = BridgeSurfaceId::from_uuid(surface_uuid.clone());
        let failures = state
            .hosts
            .get_mut(&surface_uuid)
            .map(BridgeHost::take_reconciliation_failures)
            .unwrap_or_default();
        let old_connection = state.connections.remove(&surface_uuid);
        let connection = Arc::new(BridgeConnection {
            surface_id: surface_id.clone(),
            connection_id,
            connection_generation: generation,
            stream,
            finished: AtomicBool::new(false),
        });
        state.connections.insert(surface_uuid, Arc::clone(&connection));
        let event = BridgeEvent::Connected { surface_id: surface_id.clone(), generation };
        (accepted, old_connection, Arc::clone(&connection), event, failures)
    };
    if let Some(old_connection) = old_connection {
        old_connection.close();
    }
    write_text_frame(&connection.stream, &accepted)?;
    for failure in failures {
        inner.sink.on_event(request_failure_event(&connection.surface_id, failure));
    }
    inner.sink.on_event(event);
    Ok(connection)
}

fn handle_message(
    inner: &BridgeTransportInner,
    connection: &Arc<BridgeConnection>,
    envelope: Envelope,
) -> EditorResult<()> {
    let message_kind = envelope.kind();
    let action = {
        let mut state =
            inner.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let host = state
            .hosts
            .get_mut(connection.surface_id.as_uuid())
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        match host.receive_at(envelope, inner.clock.now()) {
            HostReceiveOutcome::SnapshotApplied => {
                host.projection(connection.surface_id.as_uuid()).cloned().map(|projection| {
                    TransportAction::Snapshot(BridgeEvent::Snapshot {
                        surface_id: connection.surface_id.clone(),
                        generation: connection.connection_generation,
                        readiness: projection.readiness,
                        context: projection.context,
                        dirty: projection.dirty,
                    })
                })
            }
            HostReceiveOutcome::EventApplied => host
                .projection(connection.surface_id.as_uuid())
                .cloned()
                .and_then(|projection| match message_kind {
                    MessageKind::ReadyChanged => {
                        Some(TransportAction::Event(BridgeEvent::ReadinessChanged {
                            surface_id: connection.surface_id.clone(),
                            generation: connection.connection_generation,
                            readiness: projection.readiness,
                        }))
                    }
                    MessageKind::IdentityChanged => {
                        Some(TransportAction::Event(BridgeEvent::IdentityChanged {
                            surface_id: connection.surface_id.clone(),
                            generation: connection.connection_generation,
                            context: projection.context,
                        }))
                    }
                    MessageKind::DirtyChanged => {
                        Some(TransportAction::Event(BridgeEvent::DirtyChanged {
                            surface_id: connection.surface_id.clone(),
                            generation: connection.connection_generation,
                            dirty: projection.dirty,
                        }))
                    }
                    _ => None,
                }),
            HostReceiveOutcome::RequestPending {
                connection_id,
                connection_generation,
                request_message_id,
                request,
            } => Some(TransportAction::Request {
                handle: BridgeRequestHandle {
                    surface_id: connection.surface_id.clone(),
                    connection_id,
                    connection_generation,
                    request_message_id,
                },
                request,
            }),
            HostReceiveOutcome::Replayed(envelope)
            | HostReceiveOutcome::HelloAccepted(envelope) => Some(TransportAction::Send(envelope)),
            HostReceiveOutcome::ResponseAccepted | HostReceiveOutcome::DuplicateIgnored => None,
            HostReceiveOutcome::ProtocolError { .. }
            | HostReceiveOutcome::StaleConnection { .. } => Some(TransportAction::Close),
        }
    };
    let Some(action) = action else { return Ok(()) };
    match action {
        TransportAction::Snapshot(event) | TransportAction::Event(event) => {
            inner.sink.on_event(event)
        }
        TransportAction::Request { handle, request } => {
            let request = BridgeRequest { handle, request };
            match inner.sink.on_request(&request) {
                BridgeRequestDisposition::Immediate(result) => {
                    complete_request_inner(inner, request.handle.clone(), result)?;
                }
                BridgeRequestDisposition::Pending => {}
            }
        }
        TransportAction::Send(envelope) => write_text_frame(&connection.stream, &envelope)?,
        TransportAction::Close => return Err(EditorError::new(EditorErrorCode::BridgeUnavailable)),
    }
    Ok(())
}

enum TransportAction {
    Snapshot(BridgeEvent),
    Event(BridgeEvent),
    Request { handle: BridgeRequestHandle, request: ClientRequest },
    Send(Envelope),
    Close,
}

fn map_request_result(
    result: BridgeRequestResult,
) -> Result<ResponseResult, (ErrorCode, ContentFreeSummary)> {
    match result {
        BridgeRequestResult::WorkspaceRouted { context } => {
            Ok(ResponseResult::WorkspaceRouted { context })
        }
        BridgeRequestResult::GlobalRouted { context } => {
            Ok(ResponseResult::GlobalRouted { context })
        }
        BridgeRequestResult::SnapshotWillFollow => Ok(ResponseResult::SnapshotWillFollow),
        BridgeRequestResult::Focused => Ok(ResponseResult::Focused),
        BridgeRequestResult::Error { code, summary } => Err((code, summary)),
    }
}

fn complete_request_inner(
    inner: &BridgeTransportInner,
    handle: BridgeRequestHandle,
    result: BridgeRequestResult,
) -> EditorResult<()> {
    let (connection, response) = {
        let mut state =
            inner.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let connection = state
            .connections
            .get(handle.surface_id.as_uuid())
            .cloned()
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        if connection.connection_id != handle.connection_id
            || connection.connection_generation != handle.connection_generation
        {
            return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
        }
        let host = state
            .hosts
            .get_mut(handle.surface_id.as_uuid())
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        if host.connection_generation(handle.surface_id.as_uuid())
            != Some(handle.connection_generation)
        {
            return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
        }
        let response = host
            .complete_request(
                &handle.connection_id,
                &handle.request_message_id,
                map_request_result(result),
                inner.clock.now(),
            )
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        (connection, response)
    };
    write_text_frame(&connection.stream, &response)
}

fn finish_connection(inner: &BridgeTransportInner, connection: &Arc<BridgeConnection>) {
    if !connection.finish_once() {
        return;
    }
    let removed = inner
        .state
        .lock()
        .ok()
        .and_then(|mut state| {
            let was_current = state
                .connections
                .get(connection.surface_id.as_uuid())
                .is_some_and(|current| current.connection_id == connection.connection_id);
            if !was_current {
                return Some((false, Vec::new()));
            }
            state.connections.remove(connection.surface_id.as_uuid());
            state.hosts.get_mut(connection.surface_id.as_uuid()).map(|host| {
                (true, host.connection_lost(&connection.connection_id, inner.clock.now()))
            })
        })
        .unwrap_or((false, Vec::new()));
    if removed.0 {
        for failure in removed.1 {
            inner.sink.on_event(request_failure_event(&connection.surface_id, failure));
        }
        inner.sink.on_event(BridgeEvent::Disconnected {
            surface_id: connection.surface_id.clone(),
            generation: connection.connection_generation,
        });
    }
}

fn request_failure_event(
    surface_id: &BridgeSurfaceId,
    failure: devhub_app_core::bridge::RequestFailure,
) -> BridgeEvent {
    BridgeEvent::RequestFailed {
        handle: BridgeRequestHandle {
            surface_id: surface_id.clone(),
            connection_id: failure.pending.connection_id,
            connection_generation: failure.pending.connection_generation,
            request_message_id: failure.pending.request_message_id,
        },
        reason: failure.reason,
    }
}

fn write_text_frame(stream: &Arc<Mutex<BridgeSocket>>, envelope: &Envelope) -> EditorResult<()> {
    let payload =
        envelope.encode().map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
    let payload = String::from_utf8(payload)
        .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
    }
    stream
        .lock()
        .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?
        .write(Message::text(payload))
        .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))
}

#[cfg(test)]
mod tests {
    use super::*;
    use devhub_app_core::bridge::{
        FocusPayload, FocusReason, HelloPayload, ResponseResult, SemVer, StateSnapshotPayload,
    };
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    struct FixedIds {
        next: AtomicUsize,
    }

    impl devhub_app_core::bridge::IdSource for FixedIds {
        fn next_uuid(&mut self) -> Result<Uuid, devhub_app_core::bridge::IdSourceError> {
            let index = self.next.fetch_add(1, Ordering::Relaxed);
            let value = format!("{:08x}-0000-4000-8000-{:012x}", index + 1, index + 1);
            Uuid::parse(value)
                .map_err(|_| devhub_app_core::bridge::IdSourceError::Invalid("test".to_owned()))
        }
    }

    struct AdvancingClock {
        now: Mutex<SystemTime>,
    }

    impl Clock for AdvancingClock {
        fn now(&self) -> SystemTime {
            let mut now = self.now.lock().expect("clock");
            let current = *now;
            *now += Duration::from_secs(1);
            current
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<BridgeEvent>>,
    }

    impl BridgeEventSink for RecordingSink {
        fn on_event(&self, event: BridgeEvent) {
            self.events.lock().expect("events").push(event);
        }

        fn on_request(&self, request: &BridgeRequest) -> BridgeRequestDisposition {
            match request.request() {
                ClientRequest::RequestStateSnapshot(_) => {
                    BridgeRequestDisposition::Immediate(BridgeRequestResult::SnapshotWillFollow)
                }
                ClientRequest::Focus(_) => {
                    BridgeRequestDisposition::Immediate(BridgeRequestResult::Focused)
                }
                ClientRequest::OpenWorkspace(_) | ClientRequest::NewWindow(_) => {
                    BridgeRequestDisposition::Immediate(BridgeRequestResult::Error {
                        code: ErrorCode::SurfaceUnavailable,
                        summary: ContentFreeSummary::Failed,
                    })
                }
            }
        }
    }

    #[derive(Default)]
    struct DeferredSink {
        requests: Mutex<Vec<BridgeRequest>>,
    }

    impl BridgeEventSink for DeferredSink {
        fn on_event(&self, _event: BridgeEvent) {}

        fn on_request(&self, request: &BridgeRequest) -> BridgeRequestDisposition {
            self.requests.lock().expect("requests").push(request.clone());
            BridgeRequestDisposition::Pending
        }
    }

    #[test]
    fn loopback_transport_runs_core_handshake_snapshot_and_reconnect() {
        let surface = Uuid::parse("11111111-1111-4111-8111-111111111111").expect("surface");
        let sink = Arc::new(RecordingSink::default());
        let token = SecretToken::from_bytes_for_test([7; 32]);
        match TcpListener::bind((super::super::paths::LOOPBACK_HOST, 0)) {
            Ok(listener) => drop(listener),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind probe: {error}"),
        }
        let transport = match BridgeTransport::bind_with_clock_and_ids(
            token.clone(),
            vec![surface.clone()],
            sink.clone(),
            Arc::new(SystemClock),
            Arc::new(Mutex::new(FixedIds { next: AtomicUsize::new(0) })),
        ) {
            Ok(transport) => transport,
            Err(error) => panic!("transport bind: {error}"),
        };
        let port = transport
            .endpoint()
            .split(':')
            .nth(2)
            .and_then(|value| value.split('/').next())
            .and_then(|value| value.parse::<u16>().ok())
            .expect("endpoint port");
        let mut client =
            TcpStream::connect((super::super::paths::LOOPBACK_HOST, port)).expect("connect");
        client.set_read_timeout(Some(Duration::from_secs(2))).expect("timeout");
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let request = format!(
            "GET /bridge HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nAuthorization: Bearer {}\r\n\r\n",
            token.hex()
        );
        client.write_all(request.as_bytes()).expect("upgrade");
        let response = read_test_headers(&mut client);
        assert!(response.starts_with("HTTP/1.1 101 Switching Protocols"));
        let hello = Envelope::new(
            None,
            1,
            Uuid::parse("22222222-2222-4222-8222-222222222222").expect("message"),
            MessageKind::Hello,
            Payload::Hello(HelloPayload {
                extension_version: SemVer::parse("0.1.0").expect("version"),
                surface_id: surface.clone(),
                workbench_instance_id: Uuid::parse("33333333-3333-4333-8333-333333333333")
                    .expect("instance"),
            }),
        )
        .expect("hello");
        write_test_client_frame(&mut client, &hello.encode().expect("hello bytes"));
        let accepted = Envelope::decode(&read_test_server_frame(&mut client)).expect("accepted");
        assert_eq!(accepted.kind(), MessageKind::HelloAccepted);
        let connection = accepted.connection_id().cloned().expect("connection");
        let snapshot = Envelope::new(
            Some(connection.clone()),
            2,
            Uuid::parse("44444444-4444-4444-8444-444444444444").expect("snapshot message"),
            MessageKind::StateSnapshot,
            Payload::StateSnapshot(StateSnapshotPayload {
                surface_id: surface.clone(),
                readiness: Readiness::Ready,
                context: Context::Global,
                dirty: false,
            }),
        )
        .expect("snapshot");
        write_test_client_frame(&mut client, &snapshot.encode().expect("snapshot bytes"));
        std::thread::sleep(Duration::from_millis(50));
        assert!(sink
            .events
            .lock()
            .expect("events")
            .iter()
            .any(|event| matches!(event, BridgeEvent::Snapshot { surface_id, .. } if surface_id.as_str() == surface.as_str())));

        let _ = client.shutdown(Shutdown::Both);
        std::thread::sleep(Duration::from_millis(25));
        let mut reconnect =
            TcpStream::connect((super::super::paths::LOOPBACK_HOST, port)).expect("reconnect");
        reconnect.set_read_timeout(Some(Duration::from_secs(2))).expect("timeout");
        reconnect.write_all(request.as_bytes()).expect("upgrade");
        let _ = read_test_headers(&mut reconnect);
        write_test_client_frame(&mut reconnect, &hello.encode().expect("hello bytes"));
        let accepted_again =
            Envelope::decode(&read_test_server_frame(&mut reconnect)).expect("accepted");
        let generation = match accepted_again.payload() {
            Payload::HelloAccepted(payload) => payload.connection_generation,
            _ => 0,
        };
        assert_eq!(generation, 2);
        transport.stop().expect("stop");
    }

    #[test]
    fn deferred_request_completion_is_typed_and_generation_bound() {
        let surface = Uuid::parse("55555555-5555-4555-8555-555555555555").expect("surface");
        let sink = Arc::new(DeferredSink::default());
        let token = SecretToken::from_bytes_for_test([6; 32]);
        let transport =
            match BridgeTransport::bind(token.clone(), vec![surface.clone()], sink.clone()) {
                Ok(transport) => transport,
                Err(error) if error.code() == EditorErrorCode::BridgeUnavailable => return,
                Err(error) => panic!("transport bind: {error:?}"),
            };
        let port = transport
            .endpoint()
            .split(':')
            .nth(2)
            .and_then(|value| value.split('/').next())
            .and_then(|value| value.parse::<u16>().ok())
            .expect("endpoint port");
        let mut client =
            TcpStream::connect((super::super::paths::LOOPBACK_HOST, port)).expect("connect");
        client.set_read_timeout(Some(Duration::from_secs(2))).expect("timeout");
        let request = format!(
            "GET /bridge HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer {}\r\n\r\n",
            token.hex()
        );
        client.write_all(request.as_bytes()).expect("upgrade");
        let _ = read_test_headers(&mut client);
        let hello = Envelope::new(
            None,
            1,
            Uuid::parse("66666666-6666-4666-8666-666666666666").expect("message"),
            MessageKind::Hello,
            Payload::Hello(HelloPayload {
                extension_version: SemVer::parse("0.1.0").expect("version"),
                surface_id: surface.clone(),
                workbench_instance_id: Uuid::parse("77777777-7777-4777-8777-777777777777")
                    .expect("instance"),
            }),
        )
        .expect("hello");
        write_test_client_frame(&mut client, &hello.encode().expect("hello bytes"));
        let accepted = Envelope::decode(&read_test_server_frame(&mut client)).expect("accepted");
        let connection = accepted.connection_id().cloned().expect("connection");
        let snapshot = Envelope::new(
            Some(connection.clone()),
            2,
            Uuid::parse("88888888-8888-4888-8888-888888888888").expect("snapshot message"),
            MessageKind::StateSnapshot,
            Payload::StateSnapshot(StateSnapshotPayload {
                surface_id: surface.clone(),
                readiness: Readiness::Ready,
                context: Context::Global,
                dirty: false,
            }),
        )
        .expect("snapshot");
        write_test_client_frame(&mut client, &snapshot.encode().expect("snapshot bytes"));
        let request_id = Uuid::parse("99999999-9999-4999-8999-999999999999").expect("request");
        let focus = Envelope::new(
            Some(connection),
            3,
            request_id.clone(),
            MessageKind::Focus,
            Payload::Focus(FocusPayload { reason: FocusReason::Navigation }),
        )
        .expect("focus");
        write_test_client_frame(&mut client, &focus.encode().expect("focus bytes"));
        let handle = loop {
            if let Some(request) = sink.requests.lock().expect("requests").pop() {
                break request.handle().clone();
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(handle.connection_generation(), 1);
        let stale_handle = handle.clone();
        transport.complete_bridge_request(handle, BridgeRequestResult::Focused).expect("complete");
        let response = Envelope::decode(&read_test_server_frame(&mut client)).expect("response");
        assert!(
            matches!(response.payload(), Payload::Response(payload) if payload.request_message_id == request_id && payload.result == ResponseResult::Focused)
        );
        let _ = client.shutdown(Shutdown::Both);
        std::thread::sleep(Duration::from_millis(25));
        let mut reconnect =
            TcpStream::connect((super::super::paths::LOOPBACK_HOST, port)).expect("reconnect");
        reconnect.set_read_timeout(Some(Duration::from_secs(2))).expect("timeout");
        reconnect.write_all(request.as_bytes()).expect("upgrade");
        let _ = read_test_headers(&mut reconnect);
        write_test_client_frame(&mut reconnect, &hello.encode().expect("hello bytes"));
        let accepted_again =
            Envelope::decode(&read_test_server_frame(&mut reconnect)).expect("accepted");
        assert!(
            matches!(accepted_again.payload(), Payload::HelloAccepted(payload) if payload.connection_generation == 2)
        );
        assert!(transport
            .complete_bridge_request(stale_handle, BridgeRequestResult::Focused)
            .is_err());
        transport.stop().expect("stop");
    }

    #[test]
    fn continuous_ping_traffic_does_not_extend_pending_request_timeout() {
        let surface = Uuid::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").expect("surface");
        let sink = Arc::new(DeferredSink::default());
        let token = SecretToken::from_bytes_for_test([5; 32]);
        let clock = Arc::new(AdvancingClock { now: Mutex::new(SystemTime::UNIX_EPOCH) });
        let transport = match BridgeTransport::bind_with_clock_and_ids(
            token.clone(),
            vec![surface.clone()],
            sink.clone(),
            clock,
            Arc::new(Mutex::new(FixedIds { next: AtomicUsize::new(0) })),
        ) {
            Ok(transport) => transport,
            Err(error) if error.code() == EditorErrorCode::BridgeUnavailable => return,
            Err(error) => panic!("transport bind: {error:?}"),
        };
        let port = transport
            .endpoint()
            .split(':')
            .nth(2)
            .and_then(|value| value.split('/').next())
            .and_then(|value| value.parse::<u16>().ok())
            .expect("endpoint port");
        let mut client =
            TcpStream::connect((super::super::paths::LOOPBACK_HOST, port)).expect("connect");
        client.set_read_timeout(Some(Duration::from_secs(2))).expect("timeout");
        let request = format!(
            "GET /bridge HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer {}\r\n\r\n",
            token.hex()
        );
        client.write_all(request.as_bytes()).expect("upgrade");
        let _ = read_test_headers(&mut client);
        let hello = Envelope::new(
            None,
            1,
            Uuid::parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").expect("message"),
            MessageKind::Hello,
            Payload::Hello(HelloPayload {
                extension_version: SemVer::parse("0.1.0").expect("version"),
                surface_id: surface.clone(),
                workbench_instance_id: Uuid::parse("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
                    .expect("instance"),
            }),
        )
        .expect("hello");
        write_test_client_frame(&mut client, &hello.encode().expect("hello bytes"));
        let accepted = Envelope::decode(&read_test_server_frame(&mut client)).expect("accepted");
        let connection = accepted.connection_id().cloned().expect("connection");
        let snapshot = Envelope::new(
            Some(connection.clone()),
            2,
            Uuid::parse("dddddddd-dddd-4ddd-8ddd-dddddddddddd").expect("snapshot message"),
            MessageKind::StateSnapshot,
            Payload::StateSnapshot(StateSnapshotPayload {
                surface_id: surface.clone(),
                readiness: Readiness::Ready,
                context: Context::Global,
                dirty: false,
            }),
        )
        .expect("snapshot");
        write_test_client_frame(&mut client, &snapshot.encode().expect("snapshot bytes"));
        let request_id = Uuid::parse("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee").expect("request");
        let focus = Envelope::new(
            Some(connection),
            3,
            request_id.clone(),
            MessageKind::Focus,
            Payload::Focus(FocusPayload { reason: FocusReason::Navigation }),
        )
        .expect("focus");
        write_test_client_frame(&mut client, &focus.encode().expect("focus bytes"));
        let _handle = loop {
            if let Some(request) = sink.requests.lock().expect("requests").pop() {
                break request.handle().clone();
            }
            std::thread::sleep(Duration::from_millis(5));
        };

        let mut ping_client = client.try_clone().expect("ping clone");
        let pinger = thread::spawn(move || {
            for _ in 0..100 {
                write_test_client_control_frame(&mut ping_client, 0x9, &[]);
                thread::sleep(Duration::from_millis(5));
            }
        });
        let mut timed_out = false;
        for _ in 0..100 {
            let (opcode, payload) = read_test_server_frame_with_opcode(&mut client)
                .expect("server frame while pings are active");
            if opcode == 0xA {
                continue;
            }
            if opcode == 0x1 {
                let envelope = Envelope::decode(&payload).expect("timeout envelope");
                if matches!(envelope.payload(), Payload::Error(error) if error.request_message_id.as_ref() == Some(&request_id) && error.code == ErrorCode::BridgeTimeout)
                {
                    timed_out = true;
                    break;
                }
            }
        }
        pinger.join().expect("pinger");
        assert!(timed_out, "pending request remained alive under continuous ping traffic");
        transport.stop().expect("stop");
    }

    #[test]
    fn stop_terminates_silent_pre_auth_peer_within_bound() {
        let token = SecretToken::from_bytes_for_test([9; 32]);
        let transport =
            match BridgeTransport::bind(token, Vec::<Uuid>::new(), Arc::new(NoopBridgeEventSink)) {
                Ok(transport) => transport,
                Err(error) if error.code() == EditorErrorCode::BridgeUnavailable => return,
                Err(error) => panic!("transport bind: {error:?}"),
            };
        let port = transport
            .endpoint()
            .split(':')
            .nth(2)
            .and_then(|value| value.split('/').next())
            .and_then(|value| value.parse::<u16>().ok())
            .expect("endpoint port");
        let peer = TcpStream::connect((super::super::paths::LOOPBACK_HOST, port));
        if peer.is_err() {
            let _ = transport.stop();
            return;
        }
        let _peer = peer.expect("peer");
        std::thread::sleep(Duration::from_millis(50));
        let started = std::time::Instant::now();
        transport.stop().expect("bounded stop");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn dropping_transport_owner_stops_listener_and_workers() {
        let token = SecretToken::from_bytes_for_test([8; 32]);
        let transport =
            match BridgeTransport::bind(token, Vec::<Uuid>::new(), Arc::new(NoopBridgeEventSink)) {
                Ok(transport) => transport,
                Err(error) if error.code() == EditorErrorCode::BridgeUnavailable => return,
                Err(error) => panic!("transport bind: {error:?}"),
            };
        let port = transport
            .endpoint()
            .split(':')
            .nth(2)
            .and_then(|value| value.split('/').next())
            .and_then(|value| value.parse::<u16>().ok())
            .expect("endpoint port");
        let _peer = TcpStream::connect((super::super::paths::LOOPBACK_HOST, port));
        let temporary = transport.clone();
        drop(temporary);
        assert!(TcpStream::connect((super::super::paths::LOOPBACK_HOST, port)).is_ok());
        std::thread::sleep(Duration::from_millis(50));
        drop(transport);
        assert!(TcpStream::connect((super::super::paths::LOOPBACK_HOST, port)).is_err());
    }

    fn read_test_headers(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 256];
        while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut chunk).expect("headers");
            assert!(read > 0);
            bytes.extend_from_slice(&chunk[..read]);
            assert!(bytes.len() <= 16 * 1024);
        }
        String::from_utf8(bytes).expect("headers utf8")
    }

    fn write_test_client_frame(stream: &mut TcpStream, payload: &[u8]) {
        write_test_client_control_frame(stream, 0x1, payload);
    }

    fn write_test_client_control_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) {
        assert!(payload.len() < 126);
        let mask = [1_u8, 2, 3, 4];
        let mut frame = vec![0x80 | opcode, 0x80 | payload.len() as u8];
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ mask[index % 4]));
        stream.write_all(&frame).expect("frame");
    }

    fn read_test_server_frame(stream: &mut TcpStream) -> Vec<u8> {
        read_test_server_frame_with_opcode(stream).expect("frame").1
    }

    fn read_test_server_frame_with_opcode(stream: &mut TcpStream) -> io::Result<(u8, Vec<u8>)> {
        let mut header = [0_u8; 2];
        stream.read_exact(&mut header)?;
        assert_eq!(header[0] & 0x80, 0x80);
        let opcode = header[0] & 0x0f;
        let length = match header[1] & 0x7f {
            value @ 0..=125 => value as usize,
            126 => {
                let mut bytes = [0_u8; 2];
                stream.read_exact(&mut bytes)?;
                u16::from_be_bytes(bytes) as usize
            }
            _ => panic!("unexpected test frame length"),
        };
        let mut payload = vec![0_u8; length];
        stream.read_exact(&mut payload)?;
        Ok((opcode, payload))
    }
}
