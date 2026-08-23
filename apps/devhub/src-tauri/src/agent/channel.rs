//! Native Agent Surface Channel attachments.
//!
//! The Channel is deliberately a view transport only.  Agent identity and
//! the opaque provider control live in `AgentRuntime`; this manager owns the
//! short-lived webview attachment, bounded framing, and detach lifecycle.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};

use devhub_app_core::ports::CancellationToken;
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

#[derive(Clone)]
pub(crate) struct AgentSurfaceManager {
    state: Arc<AgentSurfaceState>,
}

struct AgentSurfaceState {
    /// Attach, detach, and publication are one lifecycle transaction per
    /// manager. The epoch below makes a reader that outlives a reconnect
    /// unable to remove the replacement attachment.
    lifecycle: Mutex<()>,
    attachments: Mutex<HashMap<String, Arc<AgentAttachment>>>,
    webview_epochs: Mutex<HashMap<String, u64>>,
    next_id: AtomicU64,
    next_generation: AtomicU64,
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
                lifecycle: Mutex::new(()),
                attachments: Mutex::new(HashMap::new()),
                webview_epochs: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
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

        // A webview has one mounted Agent Surface. Keep the old attachment
        // release, provider attach, and new publication in one serialized
        // lifecycle epoch. A late reader can therefore never delete the
        // replacement published by a reconnect.
        let _lifecycle = self
            .state
            .lifecycle
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        self.detach_webview_locked(webview_label);
        let lifecycle_epoch = self.next_webview_epoch(webview_label)?;
        let operation_id = self.next_operation_id()?;
        let cancel = CancellationToken::new(operation_id);
        let (surface, observation) =
            tauri::async_runtime::block_on(runtime.attach_surface_with_observation(
                agent_id.clone(),
                request.surface_key.clone(),
                true,
                cancel,
            ))
            .map_err(TerminalError::from_port)?;
        let surface = Arc::new(surface);
        let attachment_id = self.next_attachment_id()?;
        let target_generation = self.next_generation()?;
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
        {
            let mut attachments = self
                .state
                .attachments
                .lock()
                .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
            if attachments.len() >= MAX_ATTACHMENTS {
                surface.detach();
                return Err(TerminalError::new(TerminalErrorCode::AttachmentLimit));
            }
            attachments.insert(attachment_id.clone(), Arc::new(attachment));
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
            let _ = self.detach_receipt_locked(webview_label, &receipt);
            return Err(TerminalError::new(TerminalErrorCode::ChannelClosed));
        }

        let reader_agent_id = surface.agent_id().clone();
        let reader = AgentSurfaceReader {
            manager: self.clone(),
            surface,
            stop,
            channel,
            attachment_id,
            surface_key: receipt.surface_key.clone(),
            target_generation,
            lifecycle_epoch,
            agent_id: reader_agent_id,
            on_failure,
        };
        let spawned = thread::Builder::new()
            .name("devhub-agent-surface".to_owned())
            .spawn(move || read_surface(reader));
        if spawned.is_err() {
            let _ = self.detach_receipt_locked(webview_label, &receipt);
            return Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable));
        }
        Ok((receipt, observation))
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
        let _lifecycle = self
            .state
            .lifecycle
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        self.detach_exact_locked(webview_label, &request)
    }

    pub(crate) fn detach_webview(&self, webview_label: &str) {
        let Ok(_lifecycle) = self.state.lifecycle.lock() else { return };
        self.detach_webview_locked(webview_label);
    }

    fn detach_webview_locked(&self, webview_label: &str) {
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
        let Ok(_lifecycle) = self.state.lifecycle.lock() else { return };
        let removed =
            self.state.attachments.lock().ok().map(|mut attachments| {
                attachments.drain().map(|(_, value)| value).collect::<Vec<_>>()
            });
        for attachment in removed.unwrap_or_default() {
            attachment.stop.store(true, Ordering::Release);
            attachment.surface.detach();
        }
    }

    fn detach_exact_locked(
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

    fn detach_receipt_locked(
        &self,
        webview_label: &str,
        receipt: &AttachReceipt,
    ) -> Result<(), TerminalError> {
        self.detach_exact_locked(
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
        let Ok(_lifecycle) = self.state.lifecycle.lock() else { return false };
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
}
