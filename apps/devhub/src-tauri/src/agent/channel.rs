//! Native Agent Surface Channel attachments.
//!
//! The Channel is deliberately a view transport only.  Agent identity and
//! the opaque provider control live in `AgentRuntime`; this manager owns the
//! short-lived webview attachment, bounded framing, and detach lifecycle.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};

use devhub_app_core::ports::{CancellationToken, PortError};
use devhub_app_core::{AgentId, AgentObservation, OperationId};

use super::runtime::HerdrAgentRuntime;
use super::surface::AgentSurface;
use crate::terminal::contract::{
    encode_frame, validate_attachment_id, validate_input, validate_input_sequence, validate_schema,
    AckRequest, AttachReceipt, AttachRequest, DetachRequest, InputRequest, PtySize, ResizeRequest,
    TerminalError, TerminalErrorCode, TerminalFrame, MAX_ATTACH_REQUEST_BYTES,
    MAX_OUTPUT_FRAME_BYTES, MAX_TARGET_GENERATION, TERMINAL_PROTOCOL_VERSION,
};

const POLL_INTERVAL: Duration = Duration::from_millis(40);
const MAX_ATTACHMENTS: usize = 64;
/// Output is acknowledged cumulatively by the webview. Keep a bounded
/// number of frames and bytes in flight so a hidden/stalled webview cannot
/// turn a provider control stream into an unbounded native allocation.
const MAX_OUTPUT_IN_FLIGHT_FRAMES: usize = 64;
const MAX_OUTPUT_IN_FLIGHT_BYTES: usize = crate::terminal::contract::MAX_OUTPUT_BUFFER_BYTES;

type AttachResult = Result<(AgentSurface, AgentObservation), PortError>;
type AttachResultReceiver = Receiver<AttachResult>;

struct ReaderGate {
    started: Mutex<bool>,
    wake: Condvar,
}

impl ReaderGate {
    fn new() -> Self {
        Self { started: Mutex::new(false), wake: Condvar::new() }
    }

    fn wait(&self) {
        let Ok(mut started) = self.started.lock() else { return };
        while !*started {
            let Ok(next) = self.wake.wait(started) else { return };
            started = next;
        }
    }

    fn start(&self) {
        if let Ok(mut started) = self.started.lock() {
            *started = true;
            self.wake.notify_all();
        }
    }
}

#[derive(Clone)]
pub(crate) struct AgentSurfaceManager {
    state: Arc<AgentSurfaceState>,
}

struct AgentSurfaceState {
    attachments: Mutex<HashMap<String, Arc<AgentAttachment>>>,
    readers: Mutex<HashMap<String, thread::JoinHandle<()>>>,
    webview_epochs: Mutex<HashMap<String, u64>>,
    /// A reservation prevents a provider attach in flight from publishing
    /// after a close/replacement invalidated its webview. It is deliberately
    /// separate from `attachments`: provider I/O never runs under this lock.
    attach_reservations: Mutex<HashMap<String, u64>>,
    /// Every provider attach has an app-owned worker until its result is
    /// consumed or the quit path has joined/dropped it. Keeping the JoinHandle
    /// here closes the gap where a canceled reservation still left provider
    /// I/O running after all published readers had been reaped.
    attach_operations: Mutex<HashMap<u64, ActiveAttach>>,
    #[cfg(test)]
    attach_pre_spawn_hook: Mutex<Option<Arc<std::sync::Barrier>>>,
    next_id: AtomicU64,
    next_attach_operation: AtomicU64,
    next_generation: AtomicU64,
}

struct ActiveAttach {
    webview_label: String,
    lifecycle_epoch: u64,
    cancellation: CancellationToken,
    handle: Option<thread::JoinHandle<()>>,
}

struct AttachReservation {
    webview_label: String,
    lifecycle_epoch: u64,
}

struct AgentAttachment {
    surface_key: String,
    webview_label: String,
    target_generation: u64,
    lifecycle_epoch: u64,
    stop: Arc<AtomicBool>,
    surface: Arc<AgentSurface>,
    last_input_sequence: AtomicU64,
    output: Mutex<OutputFlow>,
}

#[derive(Default)]
struct OutputFlow {
    acknowledged_sequence: u64,
    last_sent_sequence: u64,
    in_flight_bytes: usize,
    in_flight: BTreeMap<u64, usize>,
}

impl OutputFlow {
    fn can_read(&self) -> bool {
        self.in_flight.len() < MAX_OUTPUT_IN_FLIGHT_FRAMES
            && self.in_flight_bytes < MAX_OUTPUT_IN_FLIGHT_BYTES
    }

    fn reserve(&mut self, sequence: u64, bytes: usize) -> Result<(), TerminalError> {
        if bytes == 0
            || bytes > MAX_OUTPUT_FRAME_BYTES
            || sequence != self.last_sent_sequence.saturating_add(1)
            || self.in_flight.len() >= MAX_OUTPUT_IN_FLIGHT_FRAMES
            || self.in_flight_bytes.saturating_add(bytes) > MAX_OUTPUT_IN_FLIGHT_BYTES
        {
            return Err(TerminalError::new(TerminalErrorCode::Backpressure));
        }
        self.last_sent_sequence = sequence;
        self.in_flight.insert(sequence, bytes);
        self.in_flight_bytes = self.in_flight_bytes.saturating_add(bytes);
        Ok(())
    }

    fn acknowledge(&mut self, sequence: u64) -> Result<(), TerminalError> {
        if sequence > self.last_sent_sequence {
            return Err(TerminalError::new(TerminalErrorCode::InvalidRequest));
        }
        if sequence <= self.acknowledged_sequence {
            return Ok(());
        }
        let acknowledged =
            self.in_flight.range(..=sequence).map(|(_, bytes)| *bytes).collect::<Vec<_>>();
        self.in_flight.retain(|sent, _| *sent > sequence);
        self.in_flight_bytes = self.in_flight_bytes.saturating_sub(acknowledged.into_iter().sum());
        self.acknowledged_sequence = sequence;
        Ok(())
    }
}

impl AgentSurfaceManager {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new(AgentSurfaceState {
                attachments: Mutex::new(HashMap::new()),
                readers: Mutex::new(HashMap::new()),
                webview_epochs: Mutex::new(HashMap::new()),
                attach_reservations: Mutex::new(HashMap::new()),
                attach_operations: Mutex::new(HashMap::new()),
                #[cfg(test)]
                attach_pre_spawn_hook: Mutex::new(None),
                next_id: AtomicU64::new(1),
                next_attach_operation: AtomicU64::new(1),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    pub(crate) fn attach(
        &self,
        runtime: &HerdrAgentRuntime,
        webview_label: &str,
        request: AttachRequest,
        channel: Channel<InvokeResponseBody>,
        on_failure: Arc<dyn Fn(AgentId) + Send + Sync>,
    ) -> Result<(AttachReceipt, AgentObservation), TerminalError> {
        validate_attach_request(&request)?;
        let agent_id = parse_agent_surface_key(&request.surface_key)?;

        // Reserve this webview and release the prior attachment using only
        // native maps. The Herdr attach below is provider I/O and must not
        // hold a lifecycle mutex: close/reopen can invalidate this
        // reservation while the provider is slow or unavailable.
        self.detach_webview(webview_label);
        let lifecycle_epoch = self.reserve_webview(webview_label)?;
        let operation_id = match self.next_operation_id() {
            Ok(operation_id) => operation_id,
            Err(error) => {
                self.clear_reservation(webview_label, lifecycle_epoch);
                return Err(error);
            }
        };
        let cancel = CancellationToken::new(operation_id);
        let reservation =
            AttachReservation { webview_label: webview_label.to_owned(), lifecycle_epoch };
        let (operation_key, result_receiver) = match self.start_attach_operation(
            runtime,
            agent_id,
            request.surface_key.clone(),
            true,
            reservation,
            cancel,
        ) {
            Ok(operation) => operation,
            Err(error) => {
                self.clear_reservation(webview_label, lifecycle_epoch);
                return Err(error);
            }
        };
        let (surface, observation) = match self.wait_for_attach_operation(
            operation_key,
            result_receiver,
            webview_label,
            lifecycle_epoch,
        ) {
            Ok(result) => result,
            Err(error) => {
                self.clear_reservation(webview_label, lifecycle_epoch);
                return Err(error);
            }
        };
        let surface = Arc::new(surface);
        if !self.reservation_is_current(webview_label, lifecycle_epoch) {
            surface.detach();
            return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable));
        }
        let attachment_id = match self.next_attachment_id() {
            Ok(attachment_id) => attachment_id,
            Err(error) => {
                self.clear_reservation(webview_label, lifecycle_epoch);
                surface.detach();
                return Err(error);
            }
        };
        let target_generation = match self.next_generation() {
            Ok(target_generation) => target_generation,
            Err(error) => {
                self.clear_reservation(webview_label, lifecycle_epoch);
                surface.detach();
                return Err(error);
            }
        };
        let stop = Arc::new(AtomicBool::new(false));
        let attachment = AgentAttachment {
            surface_key: request.surface_key.clone(),
            webview_label: webview_label.to_owned(),
            target_generation,
            lifecycle_epoch,
            stop: Arc::clone(&stop),
            surface: Arc::clone(&surface),
            last_input_sequence: AtomicU64::new(0),
            output: Mutex::new(OutputFlow::default()),
        };
        let publish_error = {
            let mut reservations = self
                .state
                .attach_reservations
                .lock()
                .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
            if reservations.get(webview_label).copied() != Some(lifecycle_epoch) {
                Some(TerminalErrorCode::SurfaceUnavailable)
            } else {
                let mut attachments = self
                    .state
                    .attachments
                    .lock()
                    .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
                if attachments.len() >= MAX_ATTACHMENTS {
                    reservations.remove(webview_label);
                    Some(TerminalErrorCode::AttachmentLimit)
                } else {
                    attachments.insert(attachment_id.clone(), Arc::new(attachment));
                    None
                }
            }
        };
        if let Some(error) = publish_error {
            surface.detach();
            return Err(TerminalError::new(error));
        }

        let receipt = AttachReceipt {
            schema_version: TERMINAL_PROTOCOL_VERSION,
            attachment_id: attachment_id.clone(),
            surface_key: request.surface_key.clone(),
            target_generation,
        };
        let started = TerminalFrame::Started {
            schema_version: TERMINAL_PROTOCOL_VERSION,
            attachment_id: attachment_id.clone(),
            sequence: 0,
            surface_key: request.surface_key,
            target_generation,
            cols: request.cols,
            rows: request.rows,
        };
        if send_frame(&channel, &started).is_err() {
            self.clear_reservation(webview_label, lifecycle_epoch);
            let _ = self.detach_receipt(webview_label, &receipt);
            return Err(TerminalError::new(TerminalErrorCode::ChannelClosed));
        }

        let reader_agent_id = surface.agent_id().clone();
        let reader_gate = Arc::new(ReaderGate::new());
        let reader_gate_for_thread = Arc::clone(&reader_gate);
        let reader_attachment_id = attachment_id.clone();
        let reader = AgentSurfaceReader {
            manager: self.clone(),
            surface,
            stop,
            channel,
            attachment_id: reader_attachment_id,
            surface_key: receipt.surface_key.clone(),
            target_generation,
            lifecycle_epoch,
            agent_id: reader_agent_id,
            on_failure,
        };
        let spawned =
            thread::Builder::new().name("devhub-agent-surface".to_owned()).spawn(move || {
                reader_gate_for_thread.wait();
                read_surface(reader);
            });
        let reader_handle = match spawned {
            Ok(handle) => handle,
            Err(_) => {
                self.clear_reservation(webview_label, lifecycle_epoch);
                let _ = self.detach_receipt(webview_label, &receipt);
                return Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable));
            }
        };
        if let Ok(mut readers) = self.state.readers.lock() {
            readers.insert(attachment_id.clone(), reader_handle);
        } else {
            reader_gate.start();
            self.detach_webview(webview_label);
            return Err(TerminalError::new(TerminalErrorCode::Internal));
        }
        if !self.reservation_is_current(webview_label, lifecycle_epoch) {
            reader_gate.start();
            let _ = self.detach_receipt(webview_label, &receipt);
            return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable));
        }
        self.clear_reservation(webview_label, lifecycle_epoch);
        reader_gate.start();
        Ok((receipt, observation))
    }

    fn start_attach_operation(
        &self,
        runtime: &HerdrAgentRuntime,
        agent_id: AgentId,
        surface_key: String,
        takeover: bool,
        reservation: AttachReservation,
        cancellation: CancellationToken,
    ) -> Result<(u64, AttachResultReceiver), TerminalError> {
        self.reap_finished_attach_operations();
        let operation_key = self.state.next_attach_operation.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver): (SyncSender<AttachResult>, AttachResultReceiver) =
            mpsc::sync_channel(1);
        let worker_runtime = runtime.clone();
        let worker_cancellation = cancellation.clone();
        // Register the ownership record before spawning provider work, while
        // holding the operation-map lock across the short spawn/publish
        // sequence. A concurrent close therefore either waits for the handle
        // to be published or observes the complete operation record; it can
        // never miss the narrow pre-registration window.
        let mut operations = self
            .state
            .attach_operations
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        operations.insert(
            operation_key,
            ActiveAttach {
                webview_label: reservation.webview_label,
                lifecycle_epoch: reservation.lifecycle_epoch,
                cancellation,
                handle: None,
            },
        );
        #[cfg(test)]
        if let Ok(mut hook) = self.state.attach_pre_spawn_hook.lock() {
            if let Some(hook) = hook.take() {
                // The operation-map lock is intentionally still held. The
                // test releases this barrier concurrently with detach_all;
                // that close can only observe the owned record after the
                // provider worker handle has been published.
                hook.wait();
            }
        }
        let handle = thread::Builder::new().name("devhub-agent-surface-attach".to_owned()).spawn(
            move || {
                let result = worker_runtime.attach_surface_with_observation_sync(
                    agent_id,
                    surface_key,
                    takeover,
                    &worker_cancellation,
                );
                // A canceled reservation may have abandoned its receiver. A
                // one-slot channel lets this worker publish-or-drop the
                // provider result without ever blocking the quit join path.
                let _ = sender.send(result);
            },
        );
        match handle {
            Ok(handle) => {
                let operation = operations
                    .get_mut(&operation_key)
                    .expect("attach operation remains registered while its map lock is held");
                operation.handle = Some(handle);
                Ok((operation_key, receiver))
            }
            Err(_) => {
                if let Some(operation) = operations.remove(&operation_key) {
                    operation.cancellation.cancel();
                }
                Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable))
            }
        }
    }

    fn wait_for_attach_operation(
        &self,
        operation_key: u64,
        receiver: AttachResultReceiver,
        webview_label: &str,
        lifecycle_epoch: u64,
    ) -> Result<(AgentSurface, AgentObservation), TerminalError> {
        loop {
            match receiver.recv_timeout(POLL_INTERVAL) {
                Ok(result) => {
                    let joined = self.join_completed_attach(operation_key);
                    if !joined {
                        return Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable));
                    }
                    return result.map_err(TerminalError::from_port);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !self.reservation_is_current(webview_label, lifecycle_epoch) {
                        // The owner has canceled this reservation. Leave the
                        // active operation in the map so detach_all_until can
                        // join or boundedly drop its provider worker.
                        self.cancel_attach_operation(operation_key);
                        return Err(TerminalError::new(TerminalErrorCode::SurfaceUnavailable));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = self.join_completed_attach(operation_key);
                    return Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable));
                }
            }
        }
    }

    pub(crate) fn input(
        &self,
        webview_label: &str,
        request: InputRequest,
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_agent_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        validate_input_sequence(request.input_sequence)?;
        validate_input(&request.bytes)?;
        let attachment = self.owned(
            &request.attachment_id,
            webview_label,
            &request.surface_key,
            request.target_generation,
        )?;
        let previous = attachment.last_input_sequence.load(Ordering::Acquire);
        if request.input_sequence != previous.saturating_add(1)
            || attachment
                .last_input_sequence
                .compare_exchange(
                    previous,
                    request.input_sequence,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_err()
        {
            return Err(TerminalError::new(TerminalErrorCode::InvalidRequest));
        }
        let text = String::from_utf8(request.bytes)
            .map_err(|_| TerminalError::new(TerminalErrorCode::InvalidRequest))?;
        attachment.surface.send_text(&text).map_err(TerminalError::from_port)
    }

    pub(crate) fn resize(
        &self,
        webview_label: &str,
        request: ResizeRequest,
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_agent_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        PtySize {
            cols: request.cols,
            rows: request.rows,
            pixel_width: request.pixel_width,
            pixel_height: request.pixel_height,
        }
        .validate()?;
        let _ = self.owned(
            &request.attachment_id,
            webview_label,
            &request.surface_key,
            request.target_generation,
        )?;
        // Herdr's control stream is a logical Agent Surface, not a PTY. It
        // has no resize operation; accepting the bounded geometry keeps the
        // xterm view responsive without inventing provider state.
        Ok(())
    }

    pub(crate) fn acknowledge(
        &self,
        webview_label: &str,
        request: AckRequest,
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_agent_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        validate_input_sequence(request.sequence)?;
        let attachment = self.owned(
            &request.attachment_id,
            webview_label,
            &request.surface_key,
            request.target_generation,
        )?;
        let mut output = attachment
            .output
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        output.acknowledge(request.sequence)?;
        drop(output);
        Ok(())
    }

    pub(crate) fn detach(
        &self,
        webview_label: &str,
        request: DetachRequest,
    ) -> Result<(), TerminalError> {
        validate_schema(request.schema_version)?;
        validate_agent_surface_key(&request.surface_key)?;
        validate_attachment_id(&request.attachment_id)?;
        if request.target_generation == 0 || request.target_generation > MAX_TARGET_GENERATION {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        self.detach_exact(webview_label, &request)
    }

    pub(crate) fn detach_webview(&self, webview_label: &str) {
        if let Ok(mut reservations) = self.state.attach_reservations.lock() {
            reservations.remove(webview_label);
        }
        self.cancel_reservation(webview_label);
        self.detach_webview_maps(webview_label);
        self.reap_finished_readers();
        self.reap_finished_attach_operations();
    }

    fn detach_webview_maps(&self, webview_label: &str) {
        let removed = self.state.attachments.lock().ok().map(|mut attachments| {
            let ids = attachments
                .iter()
                .filter(|(_, attachment)| attachment.webview_label == webview_label)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter().filter_map(|id| attachments.remove(&id)).collect::<Vec<_>>()
        });
        for attachment in removed.unwrap_or_default() {
            attachment.stop.store(true, Ordering::Release);
            attachment.surface.detach();
        }
    }

    pub(crate) fn detach_all(&self) {
        let _ = self.detach_all_until(Instant::now() + Duration::from_secs(5));
    }

    /// Detaches every Agent Surface and reaps its app-local reader before the
    /// caller's lifecycle deadline. Provider Agents remain untouched; a
    /// reader that misses the deadline is detached rather than joined.
    pub(crate) fn detach_all_until(&self, deadline: Instant) -> bool {
        self.reap_finished_readers();
        if let Ok(mut reservations) = self.state.attach_reservations.lock() {
            reservations.clear();
        }
        let attach_operations = self
            .state
            .attach_operations
            .lock()
            .ok()
            .map(|mut operations| {
                operations.drain().map(|(_, operation)| operation).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for operation in &attach_operations {
            operation.cancellation.cancel();
        }
        let removed = self
            .state
            .attachments
            .lock()
            .ok()
            .map(|mut attachments| attachments.drain().map(|(_, value)| value).collect::<Vec<_>>())
            .unwrap_or_default();
        let handles = self
            .state
            .readers
            .lock()
            .ok()
            .map(|mut readers| readers.drain().map(|(_, handle)| handle).collect::<Vec<_>>())
            .unwrap_or_default();
        let detached = detach_surfaces_until(&removed, deadline);
        let mut attach_operations_stopped = true;
        for operation in attach_operations {
            let Some(handle) = operation.handle else {
                attach_operations_stopped = false;
                continue;
            };
            if !join_reader_until(handle, deadline) {
                attach_operations_stopped = false;
            }
        }
        let mut readers_stopped = true;
        for handle in handles {
            if !join_reader_until(handle, deadline) {
                readers_stopped = false;
            }
        }
        detached && attach_operations_stopped && readers_stopped
    }

    fn reserve_webview(&self, webview_label: &str) -> Result<u64, TerminalError> {
        self.reap_finished_attach_operations();
        let epoch = self.next_webview_epoch(webview_label)?;
        self.state
            .attach_reservations
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?
            .insert(webview_label.to_owned(), epoch);
        Ok(epoch)
    }

    fn reservation_is_current(&self, webview_label: &str, epoch: u64) -> bool {
        self.state
            .attach_reservations
            .lock()
            .ok()
            .and_then(|reservations| reservations.get(webview_label).copied())
            == Some(epoch)
    }

    fn clear_reservation(&self, webview_label: &str, epoch: u64) {
        if let Ok(mut reservations) = self.state.attach_reservations.lock() {
            if reservations.get(webview_label).copied() == Some(epoch) {
                reservations.remove(webview_label);
            }
        }
        self.cancel_attach_operations(webview_label, epoch);
    }

    fn cancel_reservation(&self, webview_label: &str) {
        self.cancel_attach_operations(webview_label, u64::MAX);
    }

    fn cancel_attach_operation(&self, operation_key: u64) {
        if let Ok(operations) = self.state.attach_operations.lock() {
            if let Some(operation) = operations.get(&operation_key) {
                operation.cancellation.cancel();
            }
        }
    }

    fn cancel_attach_operations(&self, webview_label: &str, epoch: u64) {
        if let Ok(operations) = self.state.attach_operations.lock() {
            for operation in operations.values() {
                if operation.webview_label == webview_label
                    && (epoch == u64::MAX || operation.lifecycle_epoch == epoch)
                {
                    operation.cancellation.cancel();
                }
            }
        }
    }

    fn join_completed_attach(&self, operation_key: u64) -> bool {
        let operation = self
            .state
            .attach_operations
            .lock()
            .ok()
            .and_then(|mut operations| operations.remove(&operation_key));
        operation
            .is_none_or(|operation| operation.handle.is_none_or(|handle| handle.join().is_ok()))
    }

    /// Reaps workers which completed after their reservation was canceled.
    /// Joining happens outside the operation map so a worker that is just
    /// publishing its result cannot block a concurrent detach from canceling
    /// another attach.
    fn reap_finished_attach_operations(&self) {
        let finished = self
            .state
            .attach_operations
            .lock()
            .ok()
            .map(|mut operations| {
                let keys = operations
                    .iter()
                    .filter(|(_, operation)| {
                        operation.handle.as_ref().is_some_and(|handle| handle.is_finished())
                    })
                    .map(|(key, _)| *key)
                    .collect::<Vec<_>>();
                keys.into_iter().filter_map(|key| operations.remove(&key)).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for operation in finished {
            if let Some(handle) = operation.handle {
                let _ = handle.join();
            }
        }
    }

    fn reap_finished_readers(&self) {
        let finished = self
            .state
            .readers
            .lock()
            .ok()
            .map(|mut readers| {
                let ids = readers
                    .iter()
                    .filter(|(_, handle)| handle.is_finished())
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                ids.into_iter().filter_map(|id| readers.remove(&id)).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for handle in finished {
            let _ = handle.join();
        }
    }

    fn detach_exact(
        &self,
        webview_label: &str,
        request: &DetachRequest,
    ) -> Result<(), TerminalError> {
        let attachment = {
            let mut attachments = self
                .state
                .attachments
                .lock()
                .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
            let Some(existing) = attachments.get(&request.attachment_id) else {
                return Ok(());
            };
            if existing.webview_label != webview_label
                || existing.surface_key != request.surface_key
                || existing.target_generation != request.target_generation
            {
                return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
            }
            attachments.remove(&request.attachment_id).expect("attachment remains present")
        };
        attachment.stop.store(true, Ordering::Release);
        attachment.surface.detach();
        Ok(())
    }

    pub(crate) fn detach_receipt(
        &self,
        webview_label: &str,
        receipt: &AttachReceipt,
    ) -> Result<(), TerminalError> {
        self.detach_exact(
            webview_label,
            &DetachRequest {
                schema_version: receipt.schema_version,
                surface_key: receipt.surface_key.clone(),
                attachment_id: receipt.attachment_id.clone(),
                target_generation: receipt.target_generation,
            },
        )
    }

    fn owned(
        &self,
        attachment_id: &str,
        webview_label: &str,
        surface_key: &str,
        target_generation: u64,
    ) -> Result<Arc<AgentAttachment>, TerminalError> {
        if target_generation == 0 || target_generation > MAX_TARGET_GENERATION {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        let attachments = self
            .state
            .attachments
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        let attachment = attachments
            .get(attachment_id)
            .ok_or_else(|| TerminalError::new(TerminalErrorCode::WrongAttachment))?;
        if attachment.webview_label != webview_label
            || attachment.surface_key != surface_key
            || attachment.target_generation != target_generation
        {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        Ok(Arc::clone(attachment))
    }

    fn next_attachment_id(&self) -> Result<String, TerminalError> {
        let counter = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let mut bytes = [0_u8; 16];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes))
            .map_err(|_| TerminalError::new(TerminalErrorCode::RuntimeUnavailable))?;
        bytes[0] ^= (counter & 0xff) as u8;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    fn next_operation_id(&self) -> Result<OperationId, TerminalError> {
        let counter = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        if counter > 0x0000_ffff_ffff_ffff {
            return Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable));
        }
        OperationId::from_uuid(format!("00000000-0000-4000-8000-{counter:012x}"))
            .map_err(|_| TerminalError::new(TerminalErrorCode::RuntimeUnavailable))
    }

    fn next_generation(&self) -> Result<u64, TerminalError> {
        loop {
            let generation = self.state.next_generation.fetch_add(1, Ordering::AcqRel);
            if generation == 0 || generation > MAX_TARGET_GENERATION {
                return Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable));
            }
            let used = self
                .state
                .attachments
                .lock()
                .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?
                .values()
                .any(|attachment| attachment.target_generation == generation);
            if !used {
                return Ok(generation);
            }
        }
    }

    fn next_webview_epoch(&self, webview_label: &str) -> Result<u64, TerminalError> {
        let mut epochs = self
            .state
            .webview_epochs
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        let epoch = epochs.entry(webview_label.to_owned()).or_insert(0);
        *epoch = epoch
            .checked_add(1)
            .ok_or_else(|| TerminalError::new(TerminalErrorCode::RuntimeUnavailable))?;
        Ok(*epoch)
    }
}

struct AgentSurfaceReader {
    manager: AgentSurfaceManager,
    surface: Arc<AgentSurface>,
    stop: Arc<AtomicBool>,
    channel: Channel<InvokeResponseBody>,
    attachment_id: String,
    surface_key: String,
    target_generation: u64,
    lifecycle_epoch: u64,
    agent_id: AgentId,
    on_failure: Arc<dyn Fn(AgentId) + Send + Sync>,
}

fn read_surface(reader: AgentSurfaceReader) {
    let AgentSurfaceReader {
        manager,
        surface,
        stop,
        channel,
        attachment_id,
        surface_key,
        target_generation,
        lifecycle_epoch,
        agent_id,
        on_failure,
    } = reader;
    let mut pending = Vec::new();
    let mut pending_offset = 0_usize;
    let mut sequence = 0_u64;
    while !stop.load(Ordering::Acquire) {
        if pending_offset == pending.len() {
            pending.clear();
            pending_offset = 0;
            let can_read = self_can_read(&manager, &attachment_id, &surface_key, target_generation);
            if !can_read {
                thread::sleep(POLL_INTERVAL);
                continue;
            }
            match surface.read_recent() {
                Ok(output) => pending = output,
                Err(error) => {
                    if !stop.load(Ordering::Acquire) {
                        // A control-stream read failure is not evidence that
                        // the Agent exited. Reconcile its visible runtime
                        // health separately; only the provider reconciliation
                        // may remove an Agent.
                        on_failure(agent_id.clone());
                        let frame = TerminalFrame::Error {
                            schema_version: TERMINAL_PROTOCOL_VERSION,
                            attachment_id: attachment_id.clone(),
                            sequence: sequence.saturating_add(1),
                            error: TerminalError::from_port(error),
                        };
                        let _ = send_frame(&channel, &frame);
                    }
                    stop.store(true, Ordering::Release);
                    break;
                }
            }
        }
        while pending_offset < pending.len() {
            let end = (pending_offset + MAX_OUTPUT_FRAME_BYTES).min(pending.len());
            let chunk = &pending[pending_offset..end];
            sequence = sequence.saturating_add(1);
            if !reserve_output(
                &manager,
                &attachment_id,
                &surface_key,
                target_generation,
                sequence,
                chunk.len(),
            ) {
                sequence = sequence.saturating_sub(1);
                break;
            }
            let frame = TerminalFrame::Output {
                schema_version: TERMINAL_PROTOCOL_VERSION,
                attachment_id: attachment_id.clone(),
                sequence,
                bytes: chunk.to_vec(),
            };
            if send_frame(&channel, &frame).is_err() {
                stop.store(true, Ordering::Release);
                break;
            }
            pending_offset = end;
        }
        thread::sleep(POLL_INTERVAL);
    }
    let _ =
        manager.remove_if_current(&attachment_id, &surface_key, target_generation, lifecycle_epoch);
}

fn self_can_read(
    manager: &AgentSurfaceManager,
    attachment_id: &str,
    surface_key: &str,
    target_generation: u64,
) -> bool {
    manager
        .current(attachment_id, surface_key, target_generation)
        .and_then(|attachment| attachment.output.lock().ok().map(|flow| flow.can_read()))
        .unwrap_or(false)
}

fn reserve_output(
    manager: &AgentSurfaceManager,
    attachment_id: &str,
    surface_key: &str,
    target_generation: u64,
    sequence: u64,
    bytes: usize,
) -> bool {
    manager
        .current(attachment_id, surface_key, target_generation)
        .and_then(|attachment| {
            attachment.output.lock().ok().map(|mut flow| flow.reserve(sequence, bytes).is_ok())
        })
        .unwrap_or(false)
}

impl AgentSurfaceManager {
    fn current(
        &self,
        attachment_id: &str,
        surface_key: &str,
        target_generation: u64,
    ) -> Option<Arc<AgentAttachment>> {
        let attachments = self.state.attachments.lock().ok()?;
        let attachment = attachments.get(attachment_id)?;
        if attachment.surface_key != surface_key
            || attachment.target_generation != target_generation
        {
            return None;
        }
        Some(Arc::clone(attachment))
    }

    fn remove_if_current(
        &self,
        attachment_id: &str,
        surface_key: &str,
        target_generation: u64,
        lifecycle_epoch: u64,
    ) -> bool {
        let removed = self.state.attachments.lock().ok().and_then(|mut attachments| {
            let matches = attachments.get(attachment_id).is_some_and(|attachment| {
                attachment.surface_key == surface_key
                    && attachment.target_generation == target_generation
                    && attachment.lifecycle_epoch == lifecycle_epoch
            });
            matches.then(|| attachments.remove(attachment_id)).flatten()
        });
        if let Some(attachment) = removed {
            attachment.stop.store(true, Ordering::Release);
            attachment.surface.detach();
            true
        } else {
            false
        }
    }
}

fn join_reader_until(handle: thread::JoinHandle<()>, deadline: Instant) -> bool {
    if handle.thread().id() == thread::current().id() {
        return false;
    }
    while !handle.is_finished() && Instant::now() < deadline {
        thread::sleep(POLL_INTERVAL);
    }
    if handle.is_finished() {
        handle.join().is_ok()
    } else {
        drop(handle);
        false
    }
}

fn detach_surfaces_until(attachments: &[Arc<AgentAttachment>], deadline: Instant) -> bool {
    let mut handles = Vec::with_capacity(attachments.len());
    let mut spawned_all = true;
    for attachment in attachments {
        attachment.stop.store(true, Ordering::Release);
        let surface = Arc::clone(&attachment.surface);
        match thread::Builder::new()
            .name("devhub-agent-surface-detach".to_owned())
            .spawn(move || surface.detach())
        {
            Ok(handle) => handles.push(handle),
            Err(_) => spawned_all = false,
        }
    }
    let mut joined_all = true;
    for handle in handles {
        if !join_reader_until(handle, deadline) {
            joined_all = false;
        }
    }
    spawned_all && joined_all
}

fn send_frame(
    channel: &Channel<InvokeResponseBody>,
    frame: &TerminalFrame,
) -> Result<(), TerminalError> {
    channel
        .send(encode_frame(frame)?)
        .map_err(|_| TerminalError::new(TerminalErrorCode::ChannelClosed))
}

fn parse_agent_surface_key(surface_key: &str) -> Result<AgentId, TerminalError> {
    validate_agent_surface_key(surface_key)?;
    AgentId::from_uuid(surface_key.trim_start_matches("agent:").to_owned())
        .map_err(|_| TerminalError::new(TerminalErrorCode::InvalidSurface))
}

fn validate_agent_surface_key(surface_key: &str) -> Result<(), TerminalError> {
    if surface_key.is_empty()
        || surface_key.len() > crate::terminal::contract::MAX_SURFACE_KEY_BYTES
        || surface_key.bytes().any(|byte| byte == 0 || byte.is_ascii_whitespace())
    {
        return Err(TerminalError::new(TerminalErrorCode::InvalidSurface));
    }
    let Some(value) = surface_key.strip_prefix("agent:") else {
        return Err(TerminalError::new(TerminalErrorCode::InvalidSurface));
    };
    if value.is_empty() || AgentId::from_uuid(value.to_owned()).is_err() {
        return Err(TerminalError::new(TerminalErrorCode::InvalidSurface));
    }
    Ok(())
}

fn validate_attach_request(request: &AttachRequest) -> Result<(), TerminalError> {
    validate_schema(request.schema_version)?;
    validate_agent_surface_key(&request.surface_key)?;
    if request.target_generation != 0 {
        return Err(TerminalError::new(TerminalErrorCode::InvalidRequest));
    }
    PtySize {
        cols: request.cols,
        rows: request.rows,
        pixel_width: request.pixel_width,
        pixel_height: request.pixel_height,
    }
    .validate()?;
    if request.surface_key.len().saturating_add(64) > MAX_ATTACH_REQUEST_BYTES {
        return Err(TerminalError::new(TerminalErrorCode::InvalidRequest));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_surface_key_is_semantic_and_provider_free() {
        let id = "00000000-0000-4000-8000-000000000001";
        assert!(validate_agent_surface_key(&format!("agent:{id}")).is_ok());
        assert!(validate_agent_surface_key("agent:/tmp/herdr-pane").is_err());
        assert!(validate_agent_surface_key(
            "workspace-terminal:00000000-0000-4000-8000-000000000001"
        )
        .is_err());
    }

    #[test]
    fn input_sequence_is_validated_before_provider_control() {
        let request = InputRequest {
            schema_version: TERMINAL_PROTOCOL_VERSION,
            surface_key: "agent:00000000-0000-4000-8000-000000000001".to_owned(),
            attachment_id: "00000000000000000000000000000001".to_owned(),
            target_generation: 1,
            input_sequence: crate::terminal::contract::MAX_INPUT_SEQUENCE + 1,
            bytes: Vec::new(),
        };
        assert!(validate_input_sequence(request.input_sequence).is_err());
    }

    #[test]
    fn output_flow_is_bounded_and_cumulative_acknowledgements_release_bytes() {
        let mut flow = OutputFlow::default();
        let frame_bytes = MAX_OUTPUT_IN_FLIGHT_BYTES / MAX_OUTPUT_IN_FLIGHT_FRAMES;
        for sequence in 1..=MAX_OUTPUT_IN_FLIGHT_FRAMES as u64 {
            flow.reserve(sequence, frame_bytes).expect("frame fits");
        }
        assert!(!flow.can_read());
        assert!(flow.reserve(65, 1).is_err());
        flow.acknowledge(32).expect("cumulative ack");
        assert!(flow.can_read());
        flow.reserve(65, 1).expect("released frame fits");
        assert!(flow.acknowledge(66).is_err());
        assert!(flow.reserve(67, 1).is_err(), "output sequences cannot skip a frame");
    }

    #[test]
    fn output_flow_does_not_decode_or_diff_control_stream_bytes() {
        let mut flow = OutputFlow::default();
        let first = [0_u8, 0xff, 0x1b, b'[', b'2', b'J'];
        let second = [0_u8, 0xff, 0x1b, b'[', b'2', b'J'];
        flow.reserve(1, first.len()).expect("binary frame fits");
        flow.acknowledge(1).expect("first binary frame ack");
        flow.reserve(2, second.len()).expect("repeated binary frame fits");
        assert_eq!(first, second);
        assert_eq!(flow.last_sent_sequence, 2);
    }

    #[test]
    fn detach_all_until_cancels_and_bounds_inflight_attach_workers() {
        let manager = AgentSurfaceManager::new();
        let mut cancellations = Vec::new();
        for operation_key in 1..=2_u64 {
            let cancellation = CancellationToken::new(
                OperationId::from_uuid(format!("00000000-0000-4000-8000-{operation_key:012x}"))
                    .expect("operation id"),
            );
            cancellations.push(cancellation.clone());
            let handle = thread::spawn(|| thread::sleep(Duration::from_millis(500)));
            manager.state.attach_operations.lock().unwrap().insert(
                operation_key,
                ActiveAttach {
                    webview_label: "app-shell".to_owned(),
                    lifecycle_epoch: 1,
                    cancellation,
                    handle: Some(handle),
                },
            );
        }

        let start = Instant::now();
        let stopped = manager.detach_all_until(start + Duration::from_millis(25));
        assert!(!stopped, "silent attach workers must report a bounded shutdown failure");
        assert!(
            start.elapsed() < Duration::from_millis(180),
            "each attach worker must share the same absolute deadline"
        );
        assert!(cancellations.iter().all(CancellationToken::is_cancelled));
        assert!(manager.state.attach_operations.lock().unwrap().is_empty());
    }

    #[test]
    fn detach_cannot_miss_attach_registered_before_provider_spawn() {
        let manager = AgentSurfaceManager::new();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        *manager.state.attach_pre_spawn_hook.lock().unwrap() = Some(Arc::clone(&barrier));
        let runtime_home = std::env::temp_dir().join("devhub-agent-attach-race");
        std::fs::create_dir_all(&runtime_home).expect("runtime home");
        let runtime_context =
            crate::runtime::RuntimeLaunchContext::new(runtime_home, std::env::vars_os().collect())
                .expect("runtime context");
        let runtime = HerdrAgentRuntime::new(runtime_context, "/dev/null/devhub-herdr-missing");
        let cancellation = CancellationToken::new(
            OperationId::from_uuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_owned())
                .expect("operation id"),
        );
        let starter_manager = manager.clone();
        let starter_runtime = runtime.clone();
        let starter = thread::spawn(move || {
            starter_manager.start_attach_operation(
                &starter_runtime,
                "00000000-0000-4000-8000-000000000001".parse().expect("agent id"),
                "agent:00000000-0000-4000-8000-000000000001".to_owned(),
                true,
                AttachReservation { webview_label: "app-shell".to_owned(), lifecycle_epoch: 1 },
                cancellation,
            )
        });
        let detach_manager = manager.clone();
        let detach_barrier = Arc::clone(&barrier);
        let detach = thread::spawn(move || {
            detach_barrier.wait();
            detach_manager.detach_all_until(Instant::now() + Duration::from_millis(500))
        });
        barrier.wait();
        let started = starter.join().expect("attach starter joins");
        assert!(started.is_ok(), "provider worker launch is owned before detach races");
        assert!(detach.join().expect("detach joins"));
        assert!(manager.state.attach_operations.lock().unwrap().is_empty());
    }
}
