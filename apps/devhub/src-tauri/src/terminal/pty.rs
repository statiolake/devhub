//! PTY attachment implementation for the terminal surface.
//!
//! `TmuxTerminalRuntime` owns sessions; this module owns only short-lived
//! tmux client processes and their PTY file descriptors.  Detaching an
//! attachment kills the client process, never the marked tmux session.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};

use devhub_app_core::ports::{CancellationToken, PortError, PortErrorCode, TerminalTarget};

use super::contract::{
    encode_frame, validate_attachment_id, validate_input, validate_input_sequence,
    validate_surface_key, AttachReceipt, ExitReason, PtySize as WirePtySize, TerminalError,
    TerminalErrorCode, TerminalFrame, MAX_ATTACHMENT_COUNT, MAX_OUTPUT_BUFFER_BYTES,
    MAX_OUTPUT_FRAME_BYTES, MAX_TARGET_GENERATION, RESIZE_INTERVAL_MS, TERMINAL_PROTOCOL_VERSION,
};
use super::{OperationDeadline, TmuxTerminalRuntime};

const MAX_IN_FLIGHT_FRAMES: usize = 8;
const MAX_IN_FLIGHT_BYTES: usize = MAX_OUTPUT_BUFFER_BYTES;
const FLOW_CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const INPUT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const INPUT_WRITE_POLL: Duration = Duration::from_millis(2);

#[derive(Clone)]
pub(crate) struct AttachmentManager {
    state: Arc<AttachmentState>,
}

struct AttachmentState {
    attachments: Mutex<HashMap<String, Attachment>>,
    lifecycle: Mutex<LifecycleState>,
    lifecycle_wake: Condvar,
    next_id: AtomicU64,
    next_generation: AtomicU64,
    generation_available: bool,
}

struct LifecycleState {
    epoch: u64,
    next_attach: u64,
    in_flight: BTreeMap<u64, InFlightAttachment>,
}

struct InFlightAttachment {
    webview_label: String,
    target: TerminalTarget,
    cancel: CancellationToken,
}

fn attach_permit_is_current(lifecycle: &LifecycleState, permit: &AttachPermit) -> bool {
    lifecycle.epoch == permit.epoch
        && !permit.cancel.is_cancelled()
        && lifecycle.in_flight.get(&permit.key).is_some_and(|owner| !owner.cancel.is_cancelled())
}

struct AttachPermit {
    state: Arc<AttachmentState>,
    key: u64,
    epoch: u64,
    cancel: CancellationToken,
}

#[derive(Clone, Copy)]
pub(crate) struct AttachmentIdentity<'a> {
    pub(crate) target: &'a TerminalTarget,
    pub(crate) surface_key: &'a str,
    pub(crate) attachment_id: &'a str,
    pub(crate) webview_label: &'a str,
    pub(crate) target_generation: u64,
}

struct PublishError {
    replaced: Vec<Attachment>,
    candidate: Attachment,
    error: TerminalError,
}

struct Attachment {
    target: TerminalTarget,
    surface_key: String,
    target_generation: u64,
    webview_label: String,
    stop: Arc<AtomicBool>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    child_slot: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    resize: Arc<ResizeState>,
    reader: Mutex<Option<thread::JoinHandle<()>>>,
    flow: Arc<FlowControl>,
    last_input_sequence: Arc<AtomicU64>,
}

struct ResizeState {
    pending: Mutex<Option<WirePtySize>>,
    last_applied: Mutex<Option<Instant>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    wake: Condvar,
}

struct FlowControl {
    state: Mutex<FlowState>,
    wake: Condvar,
}

struct FlowState {
    pending: BTreeMap<u64, usize>,
    last_sent: u64,
    closed: bool,
}

pub(crate) struct AttachContext<'a> {
    pub(crate) target: &'a TerminalTarget,
    pub(crate) surface_key: String,
    pub(crate) webview_label: String,
    pub(crate) size: WirePtySize,
    pub(crate) channel: Channel<InvokeResponseBody>,
    pub(crate) cancel: &'a CancellationToken,
}

struct ReaderContext {
    reader: Box<dyn Read + Send>,
    attachment_id: String,
    channel: Channel<InvokeResponseBody>,
    stop: Arc<AtomicBool>,
    child: Box<dyn Child + Send + Sync>,
    flow: Arc<FlowControl>,
    state: Weak<AttachmentState>,
    identity_stop: Arc<AtomicBool>,
}

impl Drop for AttachPermit {
    fn drop(&mut self) {
        if let Ok(mut lifecycle) = self.state.lifecycle.lock() {
            lifecycle.in_flight.remove(&self.key);
            self.state.lifecycle_wake.notify_all();
        }
    }
}

/// Prevents a short-lived PTY from finishing before its JoinHandle has been
/// placed in the manager. Without this handshake, a reader could remove its
/// own attachment while `attach` was still publishing the handle, leaving a
/// detached thread behind.
struct ReaderGate {
    started: Mutex<bool>,
    wake: Condvar,
}

impl ReaderGate {
    fn new() -> Self {
        Self { started: Mutex::new(false), wake: Condvar::new() }
    }

    fn wait_until_started(&self) {
        let Ok(started) = self.started.lock() else {
            return;
        };
        let mut started = started;
        while !*started {
            started = match self.wake.wait(started) {
                Ok(next) => next,
                Err(_) => return,
            };
        }
    }

    fn start(&self) {
        if let Ok(mut started) = self.started.lock() {
            *started = true;
            self.wake.notify_all();
        }
    }
}

impl AttachmentManager {
    pub(crate) fn new() -> Self {
        let generation_seed = generation_seed();
        Self {
            state: Arc::new(AttachmentState {
                attachments: Mutex::new(HashMap::new()),
                lifecycle: Mutex::new(LifecycleState {
                    epoch: 0,
                    next_attach: 1,
                    in_flight: BTreeMap::new(),
                }),
                lifecycle_wake: Condvar::new(),
                next_id: AtomicU64::new(1),
                next_generation: AtomicU64::new(generation_seed.unwrap_or(0)),
                generation_available: generation_seed.is_some(),
            }),
        }
    }

    fn begin_attach(
        &self,
        target: &TerminalTarget,
        webview_label: &str,
        cancel: &CancellationToken,
    ) -> Result<AttachPermit, TerminalError> {
        cancel.check()?;
        let mut lifecycle = self
            .state
            .lifecycle
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        let key = lifecycle.next_attach;
        lifecycle.next_attach = lifecycle
            .next_attach
            .checked_add(1)
            .ok_or_else(|| TerminalError::new(TerminalErrorCode::RuntimeUnavailable))?;
        // A webview owns one mounted Terminal Surface at a time.  Supersede
        // an older attach before registering this one so two concurrent
        // attaches cannot both publish a receipt for the same view.  The
        // canceled operation remains in the ledger until its permit drops;
        // this gives the publisher a definitive stale result instead of a
        // timing-dependent map lookup.
        for in_flight in lifecycle.in_flight.values() {
            if in_flight.webview_label == webview_label || in_flight.target == *target {
                in_flight.cancel.cancel();
            }
        }
        let operation_cancel = cancel.child();
        lifecycle.in_flight.insert(
            key,
            InFlightAttachment {
                webview_label: webview_label.to_owned(),
                target: target.clone(),
                cancel: operation_cancel.clone(),
            },
        );
        let epoch = lifecycle.epoch;
        Ok(AttachPermit { state: Arc::clone(&self.state), key, epoch, cancel: operation_cancel })
    }

    fn publish_attachment(
        &self,
        permit: &AttachPermit,
        id: &str,
        attachment: Attachment,
    ) -> Result<Vec<Attachment>, Box<PublishError>> {
        let lifecycle = match self.state.lifecycle.lock() {
            Ok(lifecycle) => lifecycle,
            Err(_) => {
                return Err(Box::new(PublishError {
                    replaced: Vec::new(),
                    candidate: attachment,
                    error: TerminalError::new(TerminalErrorCode::Internal),
                }))
            }
        };
        let Some(owner) = lifecycle.in_flight.get(&permit.key) else {
            return Err(Box::new(PublishError {
                replaced: Vec::new(),
                candidate: attachment,
                error: TerminalError::new(TerminalErrorCode::StaleTarget),
            }));
        };
        if !attach_permit_is_current(&lifecycle, permit)
            || owner.webview_label != attachment.webview_label
            || owner.target != attachment.target
        {
            return Err(Box::new(PublishError {
                replaced: Vec::new(),
                candidate: attachment,
                error: TerminalError::new(TerminalErrorCode::StaleTarget),
            }));
        }
        let owner_label = attachment.webview_label.clone();
        let surface_key = attachment.surface_key.clone();
        let mut attachments = match self.state.attachments.lock() {
            Ok(attachments) => attachments,
            Err(_) => {
                return Err(Box::new(PublishError {
                    replaced: Vec::new(),
                    candidate: attachment,
                    error: TerminalError::new(TerminalErrorCode::Internal),
                }))
            }
        };
        let replaced_ids = attachments
            .iter()
            .filter(|(_, existing)| {
                existing.surface_key == surface_key || existing.webview_label == owner_label
            })
            .map(|(existing_id, _)| existing_id.clone())
            .collect::<Vec<_>>();
        let old = replaced_ids
            .iter()
            .filter_map(|existing_id| attachments.remove(existing_id))
            .collect::<Vec<_>>();
        if attachments.len() >= MAX_ATTACHMENT_COUNT {
            return Err(Box::new(PublishError {
                replaced: old,
                candidate: attachment,
                error: TerminalError::new(TerminalErrorCode::AttachmentLimit),
            }));
        }
        if attachments.contains_key(id) {
            return Err(Box::new(PublishError {
                replaced: old,
                candidate: attachment,
                error: TerminalError::new(TerminalErrorCode::RuntimeUnavailable),
            }));
        }
        attachments.insert(id.to_owned(), attachment);
        Ok(old)
    }

    fn invalidate_matching<F>(&self, advance_epoch: bool, matches: F) -> Vec<Attachment>
    where
        F: Fn(&str, &TerminalTarget) -> bool,
    {
        self.invalidate_matching_until(
            advance_epoch,
            matches,
            Instant::now() + Duration::from_secs(5),
        )
        .0
    }

    fn invalidate_matching_until<F>(
        &self,
        advance_epoch: bool,
        matches: F,
        deadline: Instant,
    ) -> (Vec<Attachment>, bool)
    where
        F: Fn(&str, &TerminalTarget) -> bool,
    {
        let Ok(mut lifecycle) = self.state.lifecycle.lock() else {
            return (Vec::new(), false);
        };
        if advance_epoch {
            lifecycle.epoch = lifecycle.epoch.wrapping_add(1);
        }
        for in_flight in lifecycle.in_flight.values() {
            if matches(&in_flight.webview_label, &in_flight.target) {
                in_flight.cancel.cancel();
            }
        }
        let removed = self.state.attachments.lock().ok().map(|mut attachments| {
            let ids = attachments
                .iter()
                .filter(|(_, attachment)| matches(&attachment.webview_label, &attachment.target))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter().filter_map(|id| attachments.remove(&id)).collect::<Vec<_>>()
        });
        // A close operation must not return while a canceled attach can still
        // publish a child. Attachments publish under this lifecycle lock, so
        // waiting here closes the race without holding the map lock while
        // reaping PTY threads.
        let mut completed = true;
        loop {
            let pending = lifecycle
                .in_flight
                .values()
                .any(|in_flight| matches(&in_flight.webview_label, &in_flight.target));
            if !pending {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                completed = false;
                break;
            }
            lifecycle = match self.state.lifecycle_wake.wait_timeout(lifecycle, remaining) {
                Ok((next, result)) if result.timed_out() => {
                    completed = false;
                    next
                }
                Ok((next, _)) => next,
                Err(_) => return (removed.unwrap_or_default(), false),
            };
            if !lifecycle
                .in_flight
                .values()
                .any(|in_flight| matches(&in_flight.webview_label, &in_flight.target))
            {
                break;
            }
            if !completed {
                break;
            }
        }
        drop(lifecycle);
        (removed.unwrap_or_default(), completed)
    }

    pub(crate) fn attach(
        &self,
        runtime: &TmuxTerminalRuntime,
        context: AttachContext<'_>,
    ) -> Result<AttachReceipt, TerminalError> {
        let AttachContext { target, surface_key, webview_label, size, channel, cancel } = context;
        size.validate()?;
        validate_surface_key(&surface_key)?;
        let attach_permit = self.begin_attach(target, &webview_label, cancel)?;
        let cancel = &attach_permit.cancel;

        // This permit excludes persisted socket transitions while the exact
        // marked session is resolved and the PTY client is spawned.
        let _permit = runtime.operation_permit(cancel).map_err(TerminalError::from_port)?;
        let deadline = OperationDeadline::new(runtime.timeout);
        let socket = runtime.socket().map_err(TerminalError::from_port)?;
        runtime.ensure_version(&socket, cancel, deadline).map_err(TerminalError::from_port)?;
        runtime.ensure_server(&socket, cancel, deadline).map_err(TerminalError::from_port)?;
        // `ensure_server` only guarantees Scratch. Ensure the semantic target
        // itself so a missing Workspace session is recreated before attach.
        runtime.ensure_sync_on_socket(&socket, target, cancel).map_err(TerminalError::from_port)?;
        let sessions =
            runtime.list_sessions(&socket, cancel, deadline).map_err(TerminalError::from_port)?;
        let (session_name, root, workspace_id, context) =
            runtime.target_identity(target, &sessions).map_err(TerminalError::from_port)?;
        let exact = sessions
            .iter()
            .find(|session| session.name == session_name)
            .filter(|session| session.matches(context, &workspace_id, &root))
            .ok_or_else(|| TerminalError::new(TerminalErrorCode::SessionUnavailable))?;
        cancel.check()?;

        let id = self.next_id()?;
        let target_generation = self.next_generation()?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(portable_pty::PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: size.pixel_width,
                pixel_height: size.pixel_height,
            })
            .map_err(|_| TerminalError::new(TerminalErrorCode::PtyUnavailable))?;
        let executable = runtime.executable().map_err(TerminalError::from_port)?;
        let mut command = CommandBuilder::new(executable.path());
        command.args(&runtime.tmux_args);
        command.args(["-L", socket.as_str(), "attach-session", "-t", exact.name.as_str()]);
        command.cwd(runtime.context_home());
        command.env_clear();
        for (key, value) in runtime.context.environment_entries() {
            command.env(key, value);
        }
        // The surface is xterm.js, so its PTY capability is deliberately
        // stable across launch environments.  Inheriting a shell/host TERM
        // (including `dumb`, Ghostty, or WezTerm-specific values) can make
        // tmux reject the client or describe capabilities the webview does
        // not actually provide.
        command.env("TERM", "xterm-256color");
        command.env_remove("TMUX");
        command.env_remove("TMUX_PANE");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| TerminalError::new(TerminalErrorCode::PtyUnavailable))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        set_master_nonblocking(&*pair.master).map_err(|_| {
            kill_and_wait(&mut *child);
            TerminalError::new(TerminalErrorCode::PtyUnavailable)
        })?;
        let reader = pair.master.try_clone_reader().map_err(|_| {
            kill_and_wait(&mut *child);
            TerminalError::new(TerminalErrorCode::PtyUnavailable)
        })?;
        let writer = pair.master.take_writer().map_err(|_| {
            kill_and_wait(&mut *child);
            TerminalError::new(TerminalErrorCode::PtyUnavailable)
        })?;
        let child_slot = Arc::new(Mutex::new(Some(child)));
        let killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>> = Arc::new(Mutex::new(killer));
        let master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
            Arc::new(Mutex::new(Some(pair.master)));
        let writer: Arc<Mutex<Option<Box<dyn Write + Send>>>> = Arc::new(Mutex::new(Some(writer)));
        let stop = Arc::new(AtomicBool::new(false));
        let resize = Arc::new(ResizeState {
            pending: Mutex::new(None),
            last_applied: Mutex::new(Some(Instant::now())),
            worker: Mutex::new(None),
            wake: Condvar::new(),
        });
        let flow = Arc::new(FlowControl {
            state: Mutex::new(FlowState { pending: BTreeMap::new(), last_sent: 0, closed: false }),
            wake: Condvar::new(),
        });
        let last_input_sequence = Arc::new(AtomicU64::new(0));
        let receipt = AttachReceipt {
            schema_version: TERMINAL_PROTOCOL_VERSION,
            attachment_id: id.clone(),
            surface_key: surface_key.clone(),
            target_generation,
        };

        // Keep exactly one resize worker for the lifetime of the attachment.
        // A worker-per-burst design has a lost-wake race when a request
        // publishes pending work while the previous worker is clearing its
        // active flag and returning.  This worker owns the pending state,
        // coalesces requests, and exits only when the attachment is stopped.
        let resize_worker_state = Arc::clone(&resize);
        let resize_worker_master = Arc::clone(&master);
        let resize_worker_stop = Arc::clone(&stop);
        let resize_worker_handle = match thread::Builder::new()
            .name("devhub-terminal-pty-resize".to_owned())
            .spawn(move || {
                resize_worker(resize_worker_state, resize_worker_master, resize_worker_stop)
            }) {
            Ok(handle) => handle,
            Err(_) => {
                send_attach_failure(&channel, &id, TerminalErrorCode::PtyUnavailable);
                reap_unpublished_client(&stop, &resize, &writer, &master, &killer, &child_slot);
                return Err(TerminalError::new(TerminalErrorCode::PtyUnavailable));
            }
        };
        match resize.worker.lock() {
            Ok(mut worker) => *worker = Some(resize_worker_handle),
            Err(_) => {
                stop.store(true, Ordering::Release);
                resize.wake.notify_all();
                let _ = resize_worker_handle.join();
                send_attach_failure(&channel, &id, TerminalErrorCode::Internal);
                reap_unpublished_client(&stop, &resize, &writer, &master, &killer, &child_slot);
                return Err(TerminalError::new(TerminalErrorCode::Internal));
            }
        }

        let started = TerminalFrame::Started {
            schema_version: TERMINAL_PROTOCOL_VERSION,
            attachment_id: id.clone(),
            sequence: 0,
            surface_key: surface_key.clone(),
            target_generation,
            cols: size.cols,
            rows: size.rows,
        };
        let reader_gate = Arc::new(ReaderGate::new());
        let weak_state = Arc::downgrade(&self.state);
        let channel_for_reader = channel.clone();
        let reader_stop = Arc::clone(&stop);
        let reader_child_slot = Arc::clone(&child_slot);
        let reader_flow = Arc::clone(&flow);
        let reader_id = id.clone();
        let reader_identity = Arc::clone(&stop);
        let reader_gate_for_thread = Arc::clone(&reader_gate);
        let reader_handle = match thread::Builder::new()
            .name("devhub-terminal-pty-reader".to_owned())
            .spawn(move || {
                reader_gate_for_thread.wait_until_started();
                let child = reader_child_slot.lock().ok().and_then(|mut slot| slot.take());
                if let Some(child) = child {
                    read_pty(ReaderContext {
                        reader,
                        attachment_id: reader_id,
                        channel: channel_for_reader,
                        stop: reader_stop,
                        child,
                        flow: reader_flow,
                        state: weak_state,
                        identity_stop: reader_identity,
                    });
                }
            }) {
            Ok(handle) => handle,
            Err(_) => {
                send_attach_failure(&channel, &id, TerminalErrorCode::PtyUnavailable);
                reader_gate.start();
                reap_unpublished_client(&stop, &resize, &writer, &master, &killer, &child_slot);
                return Err(TerminalError::new(TerminalErrorCode::PtyUnavailable));
            }
        };

        let attachment = Attachment {
            target: target.clone(),
            surface_key: surface_key.clone(),
            target_generation,
            webview_label,
            stop: Arc::clone(&stop),
            killer: Arc::clone(&killer),
            child_slot: Arc::clone(&child_slot),
            master: Arc::clone(&master),
            writer: Arc::clone(&writer),
            resize: Arc::clone(&resize),
            reader: Mutex::new(Some(reader_handle)),
            flow: Arc::clone(&flow),
            last_input_sequence: Arc::clone(&last_input_sequence),
        };
        let replaced = match self.publish_attachment(&attach_permit, &id, attachment) {
            Ok(replaced) => replaced,
            Err(error) => {
                let PublishError { replaced, candidate, error } = *error;
                send_attach_failure(&channel, &id, error.code());
                reader_gate.start();
                candidate.stop_and_reap();
                for existing in replaced {
                    existing.stop_and_reap();
                }
                return Err(error);
            }
        };
        // The reader thread has been spawned and its JoinHandle is in the
        // manager. Publish Started only now, so every subsequent Output has a
        // registered attachment and a deterministic sequence predecessor.
        if let Err(error) =
            self.send_started_if_current(&attach_permit, &id, &stop, &channel, &started)
        {
            let removed = self.remove_current_attachment(&id, &stop);
            reader_gate.start();
            if let Some(removed) = removed {
                removed.stop_and_reap();
            } else {
                stop.store(true, Ordering::Release);
                flow.close();
            }
            return Err(error);
        }
        // Release the reader gate only after Started has been queued. A
        // short-lived PTY therefore cannot emit Output before its receipt.
        reader_gate.start();
        // Never run child/PTY cleanup while holding the attachment map lock.
        for existing in replaced {
            existing.stop_and_reap();
        }
        Ok(receipt)
    }

    /// Serialize the publication check and Started enqueue with lifecycle
    /// invalidation.  A window close can therefore not observe a successful
    /// attach halfway through its handshake and leave a receipt for a client
    /// it has already canceled.
    fn send_started_if_current(
        &self,
        permit: &AttachPermit,
        id: &str,
        stop: &Arc<AtomicBool>,
        channel: &Channel<InvokeResponseBody>,
        started: &TerminalFrame,
    ) -> Result<(), TerminalError> {
        let lifecycle = self
            .state
            .lifecycle
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        let Some(_) = lifecycle.in_flight.get(&permit.key) else {
            return Err(TerminalError::new(TerminalErrorCode::StaleTarget));
        };
        if !attach_permit_is_current(&lifecycle, permit) {
            return Err(TerminalError::new(TerminalErrorCode::StaleTarget));
        }
        let attachments = self
            .state
            .attachments
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        let Some(current) = attachments.get(id) else {
            return Err(TerminalError::new(TerminalErrorCode::StaleTarget));
        };
        if !Arc::ptr_eq(&current.stop, stop) {
            return Err(TerminalError::new(TerminalErrorCode::StaleTarget));
        }
        send_frame(channel, started)
    }

    fn remove_current_attachment(
        &self,
        attachment_id: &str,
        stop: &Arc<AtomicBool>,
    ) -> Option<Attachment> {
        let _lifecycle = self.state.lifecycle.lock().ok()?;
        let mut attachments = self.state.attachments.lock().ok()?;
        let is_current =
            attachments.get(attachment_id).is_some_and(|current| Arc::ptr_eq(&current.stop, stop));
        is_current.then(|| attachments.remove(attachment_id)).flatten()
    }

    pub(crate) fn input(
        &self,
        identity: AttachmentIdentity<'_>,
        input_sequence: u64,
        bytes: &[u8],
    ) -> Result<(), TerminalError> {
        validate_attachment_id(identity.attachment_id)?;
        validate_input_sequence(input_sequence)?;
        validate_input(bytes)?;
        let attachment = self.find_owned(identity)?;
        if attachment.stop.load(Ordering::Acquire) {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        let mut writer = attachment
            .writer
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        let writer =
            writer.as_mut().ok_or_else(|| TerminalError::new(TerminalErrorCode::ChannelClosed))?;
        // Sequence acceptance and the actual PTY write share one critical
        // section. A concurrent seq2 request can therefore never pass the
        // ledger and overtake a blocked seq1 writer.
        accept_input_sequence(&attachment.last_input_sequence, input_sequence)?;
        write_input_bounded(writer.as_mut(), bytes, &attachment.stop)
    }

    pub(crate) fn resize(
        &self,
        identity: AttachmentIdentity<'_>,
        size: WirePtySize,
    ) -> Result<(), TerminalError> {
        validate_attachment_id(identity.attachment_id)?;
        let size = size.validate()?;
        let attachment = self.find_owned(identity)?;
        if attachment.stop.load(Ordering::Acquire) {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        attachment.request_resize(size)
    }

    pub(crate) fn acknowledge(
        &self,
        identity: AttachmentIdentity<'_>,
        sequence: u64,
    ) -> Result<(), TerminalError> {
        validate_attachment_id(identity.attachment_id)?;
        validate_input_sequence(sequence)?;
        let attachment = self.find_owned(identity)?;
        attachment.flow.acknowledge(sequence)
    }

    pub(crate) fn detach(
        &self,
        surface_key: &str,
        attachment_id: &str,
        webview_label: &str,
        target_generation: u64,
    ) -> Result<(), TerminalError> {
        let existing = {
            // The lifecycle/map locks protect publication and replacement,
            // but are released before any PTY kill or JoinHandle wait.
            let _lifecycle = self
                .state
                .lifecycle
                .lock()
                .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
            let mut attachments = self
                .state
                .attachments
                .lock()
                .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
            let Some(existing) = attachments.get(attachment_id) else {
                // Detach is idempotent for the exact opaque handle. A
                // different handle cannot be inferred or acted upon.
                return Ok(());
            };
            if existing.surface_key != surface_key
                || existing.webview_label != webview_label
                || existing.target_generation != target_generation
            {
                return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
            }
            attachments.remove(attachment_id).expect("attachment still present")
        };
        existing.stop_and_reap();
        Ok(())
    }

    pub(crate) fn detach_webview(&self, webview_label: &str) {
        let removed = self.invalidate_matching(true, |label, _| label == webview_label);
        for attachment in removed {
            attachment.stop_and_reap();
        }
    }

    pub(crate) fn detach_all(&self) {
        let _ = self.detach_all_until(Instant::now() + Duration::from_secs(5));
    }

    pub(crate) fn detach_all_until(&self, deadline: Instant) -> bool {
        let (removed, mut completed) = self.invalidate_matching_until(true, |_, _| true, deadline);
        for attachment in removed {
            completed &= attachment.stop_and_reap_until(deadline);
        }
        completed
    }

    pub(crate) fn detach_target(&self, target: &TerminalTarget) {
        let removed = self.invalidate_matching(false, |_, existing| existing == target);
        for attachment in removed {
            attachment.stop_and_reap();
        }
    }

    #[cfg(test)]
    pub(crate) fn count(&self) -> usize {
        self.state.attachments.lock().map(|attachments| attachments.len()).unwrap_or(0)
    }

    fn find_owned(
        &self,
        identity: AttachmentIdentity<'_>,
    ) -> Result<AttachmentHandle, TerminalError> {
        validate_attachment_id(identity.attachment_id)?;
        if identity.target_generation == 0 {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        let attachments = self
            .state
            .attachments
            .lock()
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        let attachment = attachments
            .get(identity.attachment_id)
            .ok_or_else(|| TerminalError::new(TerminalErrorCode::WrongAttachment))?;
        if &attachment.target != identity.target
            || attachment.surface_key != identity.surface_key
            || attachment.webview_label != identity.webview_label
            || attachment.target_generation != identity.target_generation
        {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        Ok(AttachmentHandle {
            stop: Arc::clone(&attachment.stop),
            writer: Arc::clone(&attachment.writer),
            resize: Arc::clone(&attachment.resize),
            flow: Arc::clone(&attachment.flow),
            last_input_sequence: Arc::clone(&attachment.last_input_sequence),
        })
    }

    fn next_id(&self) -> Result<String, TerminalError> {
        // The OS random source makes an attachment unguessable across app
        // launches. Never fall back to a predictable capability.
        let counter = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let mut bytes = [0_u8; 16];
        if File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)).is_ok() {
            bytes[0] ^= (counter & 0xff) as u8;
            return Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect());
        }
        Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable))
    }

    fn next_generation(&self) -> Result<u64, TerminalError> {
        if !self.state.generation_available {
            return Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable));
        }
        loop {
            let generation = self.state.next_generation.load(Ordering::Acquire);
            if generation == 0 || generation > MAX_TARGET_GENERATION {
                return Err(TerminalError::new(TerminalErrorCode::RuntimeUnavailable));
            }
            let next = if generation == MAX_TARGET_GENERATION { 1 } else { generation + 1 };
            if self
                .state
                .attachments
                .lock()
                .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?
                .values()
                .any(|attachment| attachment.target_generation == generation)
            {
                let _ = self.state.next_generation.compare_exchange(
                    generation,
                    next,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                continue;
            }
            if self
                .state
                .next_generation
                .compare_exchange(generation, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(generation);
            }
        }
    }
}

fn accept_input_sequence(last: &AtomicU64, sequence: u64) -> Result<(), TerminalError> {
    validate_input_sequence(sequence)?;
    let previous = last.load(Ordering::Acquire);
    if sequence != previous.saturating_add(1)
        || last.compare_exchange(previous, sequence, Ordering::AcqRel, Ordering::Acquire).is_err()
    {
        return Err(TerminalError::new(TerminalErrorCode::InvalidRequest));
    }
    Ok(())
}

struct AttachmentHandle {
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    resize: Arc<ResizeState>,
    flow: Arc<FlowControl>,
    last_input_sequence: Arc<AtomicU64>,
}

impl Attachment {
    fn stop_and_kill(&self) {
        self.stop.store(true, Ordering::Release);
        self.resize.wake.notify_all();
        self.flow.close();
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }

    fn stop_and_reap(&self) {
        let _ = self.stop_and_reap_until(Instant::now() + Duration::from_secs(5));
    }

    fn stop_and_reap_until(&self, deadline: Instant) -> bool {
        self.stop_and_kill();
        // Close both PTY endpoints before joining workers. The reader owns a
        // cloned read FD, while this Attachment owns the master and writer;
        // retaining either Arc during join can keep EOF from reaching the
        // reader after the child has been killed.
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
        let mut completed = true;
        if let Ok(mut worker) = self.resize.worker.lock() {
            if let Some(handle) = worker.take() {
                if handle.thread().id() != thread::current().id() {
                    completed &= join_reaper_until(handle, deadline);
                }
            }
        }
        let handle = self.reader.lock().ok().and_then(|mut reader| reader.take());
        if let Some(handle) = handle {
            if handle.thread().id() != thread::current().id() {
                completed &= join_reaper_until(handle, deadline);
            }
        }
        // The reader normally owns the wait.  A reader spawn failure leaves
        // the child in this slot, so take and reap it here as the fallback;
        // this is also safe if a worker exits before taking ownership.
        if let Some(child) = self.child_slot.lock().ok().and_then(|mut slot| slot.take()) {
            completed &= reap_child_until(child, deadline);
        }
        completed
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.stop_and_reap();
    }
}

impl AttachmentHandle {
    fn request_resize(&self, size: WirePtySize) -> Result<(), TerminalError> {
        if self.stop.load(Ordering::Acquire) {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        queue_resize(&self.resize, size)?;
        if self.stop.load(Ordering::Acquire) {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        Ok(())
    }
}

fn queue_resize(state: &ResizeState, size: WirePtySize) -> Result<(), TerminalError> {
    let mut pending =
        state.pending.lock().map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
    *pending = Some(size);
    drop(pending);
    state.wake.notify_all();
    Ok(())
}

fn resize_worker(
    state: Arc<ResizeState>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    stop: Arc<AtomicBool>,
) {
    let interval = Duration::from_millis(RESIZE_INTERVAL_MS);
    loop {
        let size = {
            let mut pending = match state.pending.lock() {
                Ok(value) => value,
                Err(_) => break,
            };
            while pending.is_none() && !stop.load(Ordering::Acquire) {
                pending = match state.wake.wait(pending) {
                    Ok(next) => next,
                    Err(_) => return,
                };
            }
            if stop.load(Ordering::Acquire) {
                break;
            }
            loop {
                let elapsed = state
                    .last_applied
                    .lock()
                    .ok()
                    .and_then(|last| *last)
                    .map(|last| last.elapsed())
                    .unwrap_or_default();
                if elapsed >= interval {
                    break pending.take();
                }
                let wait = interval.saturating_sub(elapsed);
                let (next, timeout) = match state.wake.wait_timeout(pending, wait) {
                    Ok(value) => value,
                    Err(_) => break None,
                };
                pending = next;
                if timeout.timed_out() {
                    break pending.take();
                }
                if stop.load(Ordering::Acquire) {
                    break None;
                }
            }
        };
        let Some(size) = size else {
            if stop.load(Ordering::Acquire) {
                break;
            }
            continue;
        };
        if stop.load(Ordering::Acquire) {
            break;
        }
        if let Ok(master) = master.lock() {
            if let Some(master) = master.as_ref() {
                let _ = master.resize(PtySize {
                    rows: size.rows,
                    cols: size.cols,
                    pixel_width: size.pixel_width,
                    pixel_height: size.pixel_height,
                });
            }
        }
        if let Ok(mut last) = state.last_applied.lock() {
            *last = Some(Instant::now());
        }
    }
}

impl FlowControl {
    fn reserve(&self, sequence: u64, bytes: usize, stop: &AtomicBool) -> Result<(), TerminalError> {
        validate_input_sequence(sequence)?;
        if bytes > MAX_OUTPUT_FRAME_BYTES {
            return Err(TerminalError::new(TerminalErrorCode::Backpressure));
        }
        let deadline = Instant::now() + FLOW_CONTROL_TIMEOUT;
        let mut state =
            self.state.lock().map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        loop {
            if state.closed || stop.load(Ordering::Acquire) {
                return Err(TerminalError::new(TerminalErrorCode::ChannelClosed));
            }
            let in_flight_bytes = state.pending.values().sum::<usize>();
            if state.pending.len() < MAX_IN_FLIGHT_FRAMES
                && in_flight_bytes.saturating_add(bytes) <= MAX_IN_FLIGHT_BYTES
            {
                state.pending.insert(sequence, bytes);
                state.last_sent = sequence;
                return Ok(());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(TerminalError::new(TerminalErrorCode::Backpressure));
            }
            let (next, _) = self
                .wake
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
            state = next;
        }
    }

    fn acknowledge(&self, sequence: u64) -> Result<(), TerminalError> {
        validate_input_sequence(sequence)?;
        let mut state =
            self.state.lock().map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
        if sequence > state.last_sent {
            return Err(TerminalError::new(TerminalErrorCode::InvalidRequest));
        }
        let completed = state.pending.range(..=sequence).map(|(_, bytes)| *bytes).sum::<usize>();
        let keys =
            state.pending.range(..=sequence).map(|(sequence, _)| *sequence).collect::<Vec<_>>();
        for key in keys {
            state.pending.remove(&key);
        }
        if completed > 0 {
            self.wake.notify_all();
        }
        Ok(())
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.pending.clear();
            self.wake.notify_all();
        }
    }
}

fn read_pty(context: ReaderContext) {
    let ReaderContext {
        reader,
        attachment_id,
        channel,
        stop,
        mut child,
        flow,
        state,
        identity_stop,
    } = context;
    let mut reader = reader;
    let mut sequence = 0_u64;
    let mut buffer = vec![0_u8; MAX_OUTPUT_FRAME_BYTES];
    let mut reason = ExitReason::Eof;
    loop {
        if stop.load(Ordering::Acquire) {
            reason = ExitReason::Detached;
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if count > MAX_OUTPUT_FRAME_BYTES {
                    sequence = sequence.saturating_add(1);
                    let error = TerminalFrame::Error {
                        schema_version: TERMINAL_PROTOCOL_VERSION,
                        attachment_id: attachment_id.clone(),
                        sequence,
                        error: TerminalError::new(TerminalErrorCode::Backpressure),
                    };
                    let _ = send_frame(&channel, &error);
                    stop.store(true, Ordering::Release);
                    reason = ExitReason::Detached;
                    break;
                }
                sequence = sequence.saturating_add(1);
                let output = TerminalFrame::Output {
                    schema_version: TERMINAL_PROTOCOL_VERSION,
                    attachment_id: attachment_id.clone(),
                    sequence,
                    bytes: buffer[..count].to_vec(),
                };
                if let Err(error) = flow.reserve(sequence, count, &stop) {
                    sequence = sequence.saturating_add(1);
                    let error_frame = TerminalFrame::Error {
                        schema_version: TERMINAL_PROTOCOL_VERSION,
                        attachment_id: attachment_id.clone(),
                        sequence,
                        error,
                    };
                    let _ = send_frame(&channel, &error_frame);
                    flow.close();
                    stop.store(true, Ordering::Release);
                    reason = ExitReason::Detached;
                    break;
                }
                if send_frame(&channel, &output).is_err() {
                    flow.close();
                    stop.store(true, Ordering::Release);
                    reason = ExitReason::Detached;
                    break;
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if stop.load(Ordering::Acquire) {
                    reason = ExitReason::Detached;
                    break;
                }
                thread::sleep(INPUT_WRITE_POLL);
            }
            Err(_error) => {
                if child.try_wait().ok().flatten().is_some() {
                    reason = ExitReason::Eof;
                    break;
                }
                sequence = sequence.saturating_add(1);
                let error = TerminalFrame::Error {
                    schema_version: TERMINAL_PROTOCOL_VERSION,
                    attachment_id: attachment_id.clone(),
                    sequence,
                    error: TerminalError::new(TerminalErrorCode::ChannelClosed),
                };
                let _ = send_frame(&channel, &error);
                stop.store(true, Ordering::Release);
                reason = ExitReason::Detached;
                break;
            }
        }
    }
    if stop.load(Ordering::Acquire) && reason == ExitReason::Detached {
        let _ = child.kill();
    }
    let _ = child.wait();
    sequence = sequence.saturating_add(1);
    let exited = TerminalFrame::Exited {
        schema_version: TERMINAL_PROTOCOL_VERSION,
        attachment_id: attachment_id.clone(),
        sequence,
        reason,
    };
    let _ = send_frame(&channel, &exited);
    if let Some(state) = state.upgrade() {
        let removed = state.attachments.lock().ok().and_then(|mut attachments| {
            let is_current = attachments
                .get(&attachment_id)
                .is_some_and(|current| Arc::ptr_eq(&current.stop, &identity_stop));
            is_current.then(|| attachments.remove(&attachment_id)).flatten()
        });
        // Dropping the removed attachment here is safe: if this is the
        // current reader, `stop_and_reap` detects the current thread and does
        // not self-join. A stale reader can never remove a replacement now.
        drop(removed);
    }
}

fn kill_and_wait(child: &mut (dyn Child + Send + Sync)) {
    let _ = child.kill();
    let _ = child.wait();
}

/// PTY masters are opened in non-blocking mode before their reader and writer
/// clones are taken.  That makes both directions interruptible by the stop
/// flag and lets the bounded write loop enforce its deadline instead of
/// parking a command on a full kernel input queue.
#[cfg(unix)]
fn set_master_nonblocking(master: &dyn MasterPty) -> Result<(), ()> {
    use nix::fcntl::{fcntl, FcntlArg, OFlag};

    let fd = master.as_raw_fd().ok_or(())?;
    let flags = fcntl(fd, FcntlArg::F_GETFL).map_err(|_| ())?;
    let flags = OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK;
    fcntl(fd, FcntlArg::F_SETFL(flags)).map_err(|_| ())?;
    Ok(())
}

#[cfg(not(unix))]
fn set_master_nonblocking(_master: &dyn MasterPty) -> Result<(), ()> {
    Ok(())
}

fn write_input_bounded(
    writer: &mut dyn Write,
    bytes: &[u8],
    stop: &AtomicBool,
) -> Result<(), TerminalError> {
    let deadline = Instant::now() + INPUT_WRITE_TIMEOUT;
    let mut offset = 0_usize;
    while offset < bytes.len() {
        if stop.load(Ordering::Acquire) {
            return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
        }
        match writer.write(&bytes[offset..]) {
            Ok(0) => return Err(TerminalError::new(TerminalErrorCode::ChannelClosed)),
            Ok(written) => offset = offset.saturating_add(written),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(TerminalError::new(TerminalErrorCode::Backpressure));
                }
                thread::sleep(INPUT_WRITE_POLL);
            }
            Err(_) => return Err(TerminalError::new(TerminalErrorCode::ChannelClosed)),
        }
        if Instant::now() >= deadline && offset < bytes.len() {
            return Err(TerminalError::new(TerminalErrorCode::Backpressure));
        }
    }
    // The PTY writer is an unbuffered file descriptor; flushing here would
    // reintroduce an unbounded operation for custom writers without changing
    // PTY delivery semantics.
    Ok(())
}

fn reap_unpublished_client(
    stop: &Arc<AtomicBool>,
    resize: &Arc<ResizeState>,
    writer: &Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    master: &Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    killer: &Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    child_slot: &Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
) {
    stop.store(true, Ordering::Release);
    resize.wake.notify_all();
    if let Ok(mut killer) = killer.lock() {
        let _ = killer.kill();
    }
    // Close PTY endpoints before joining the resize worker.  This mirrors
    // Attachment::stop_and_reap and keeps all pre-publication failure paths
    // from leaving a waiting worker or an owned descriptor behind.
    if let Ok(mut writer) = writer.lock() {
        writer.take();
    }
    if let Ok(mut master) = master.lock() {
        master.take();
    }
    if let Ok(mut worker) = resize.worker.lock() {
        if let Some(handle) = worker.take() {
            let _ = handle.join();
        }
    }
    if let Some(mut child) = child_slot.lock().ok().and_then(|mut slot| slot.take()) {
        kill_and_wait(&mut *child);
    }
}

fn generation_seed() -> Option<u64> {
    let mut bytes = [0_u8; 8];
    if File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)).is_err() {
        return None;
    }
    let seed = u64::from_ne_bytes(bytes) & MAX_TARGET_GENERATION;
    (seed != 0).then_some(seed)
}

fn join_reaper_until(handle: thread::JoinHandle<()>, deadline: Instant) -> bool {
    // `stop_and_reap` closes the writer and master before reaching this point,
    // and the reader observes the stop flag/child kill. Normally this is an
    // immediate EOF/EIO wakeup; the deadline keeps a broken PTY implementation
    // from hanging process quit forever.
    while !handle.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    if handle.is_finished() {
        handle.join().is_ok()
    } else {
        drop(handle);
        false
    }
}

fn reap_child_until(mut child: Box<dyn Child + Send + Sync>, deadline: Instant) -> bool {
    let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
    let worker = thread::Builder::new().name("devhub-pty-reaper".to_owned()).spawn(move || {
        kill_and_wait(&mut *child);
        let _ = done_tx.send(());
    });
    let Ok(worker) = worker else { return false };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if done_rx.recv_timeout(remaining).is_ok() {
        worker.join().is_ok()
    } else {
        drop(worker);
        false
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

fn send_attach_failure(
    channel: &Channel<InvokeResponseBody>,
    attachment_id: &str,
    code: TerminalErrorCode,
) {
    let error = TerminalFrame::Error {
        schema_version: TERMINAL_PROTOCOL_VERSION,
        attachment_id: attachment_id.to_owned(),
        sequence: 0,
        error: TerminalError::new(code),
    };
    let _ = send_frame(channel, &error);
    let exited = TerminalFrame::Exited {
        schema_version: TERMINAL_PROTOCOL_VERSION,
        attachment_id: attachment_id.to_owned(),
        sequence: 1,
        reason: ExitReason::ChildExited,
    };
    let _ = send_frame(channel, &exited);
}

impl TerminalError {
    pub(crate) fn from_port(error: PortError) -> Self {
        let code = match error.code() {
            PortErrorCode::Unavailable => TerminalErrorCode::RuntimeUnavailable,
            PortErrorCode::Conflict => TerminalErrorCode::SessionUnavailable,
            PortErrorCode::Cancelled => TerminalErrorCode::StaleTarget,
            PortErrorCode::TimedOut => TerminalErrorCode::RuntimeUnavailable,
            PortErrorCode::Incompatible => TerminalErrorCode::RuntimeUnavailable,
            PortErrorCode::Failed => TerminalErrorCode::Internal,
        };
        Self::new(code)
    }
}

trait CancellationTokenExt {
    fn check(&self) -> Result<(), TerminalError>;
}

impl CancellationTokenExt for CancellationToken {
    fn check(&self) -> Result<(), TerminalError> {
        if self.is_cancelled() {
            Err(TerminalError::new(TerminalErrorCode::StaleTarget))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow() -> Arc<FlowControl> {
        Arc::new(FlowControl {
            state: Mutex::new(FlowState { pending: BTreeMap::new(), last_sent: 0, closed: false }),
            wake: Condvar::new(),
        })
    }

    #[test]
    fn flow_control_blocks_a_non_consuming_frontend_until_cumulative_ack() {
        let flow = flow();
        let stop = Arc::new(AtomicBool::new(false));
        for sequence in 1..=MAX_IN_FLIGHT_FRAMES as u64 {
            flow.reserve(sequence, 1, &stop).expect("window credit");
        }
        let waiter_flow = Arc::clone(&flow);
        let waiter_stop = Arc::clone(&stop);
        let waiter = thread::spawn(move || waiter_flow.reserve(9, 1, &waiter_stop));
        thread::sleep(Duration::from_millis(30));
        assert!(!waiter.is_finished(), "output must not run ahead of an unconsuming view");
        flow.acknowledge(MAX_IN_FLIGHT_FRAMES as u64).expect("cumulative ack");
        assert!(waiter.join().expect("waiter").is_ok());
    }

    #[test]
    fn flow_control_rejects_future_ack_and_unbounded_frame() {
        let flow = flow();
        let stop = AtomicBool::new(false);
        let max_sequence = super::super::contract::MAX_INPUT_SEQUENCE;
        assert!(flow.acknowledge(0).is_err());
        assert!(flow.acknowledge(max_sequence.saturating_add(1)).is_err());
        assert!(flow.reserve(1, MAX_OUTPUT_FRAME_BYTES + 1, &stop).is_err());
        assert!(flow.acknowledge(1).is_err());
    }

    #[test]
    fn generation_ledger_is_monotonic_when_random_seed_is_available() {
        let manager = AttachmentManager::new();
        if manager.state.generation_available {
            let first = manager.next_generation().expect("first generation");
            let second = manager.next_generation().expect("second generation");
            assert!(first > 0);
            assert_eq!(second, first + 1);
        }
    }

    #[test]
    fn input_sequence_is_strictly_ordered_and_rejects_replays_or_gaps() {
        let last = AtomicU64::new(0);
        let max_sequence = super::super::contract::MAX_INPUT_SEQUENCE;
        assert!(validate_input_sequence(max_sequence).is_ok());
        assert!(validate_input_sequence(max_sequence.saturating_add(1)).is_err());
        assert!(accept_input_sequence(&last, 1).is_ok());
        assert!(accept_input_sequence(&last, 3).is_err());
        assert_eq!(last.load(Ordering::Acquire), 1);
        assert!(accept_input_sequence(&last, 2).is_ok());
        assert!(accept_input_sequence(&last, 2).is_err());
    }

    #[test]
    fn newer_attach_supersedes_older_inflight_before_publish() {
        let manager = AttachmentManager::new();
        let target = TerminalTarget::scratch();
        let first_cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000051",
            )
            .expect("first operation id"),
        );
        let second_cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000052",
            )
            .expect("second operation id"),
        );
        let first =
            manager.begin_attach(&target, "app-shell", &first_cancel).expect("first attach permit");
        let second = manager
            .begin_attach(&target, "app-shell", &second_cancel)
            .expect("replacement attach permit");

        let lifecycle = manager.state.lifecycle.lock().expect("lifecycle");
        assert!(!attach_permit_is_current(&lifecycle, &first));
        assert!(attach_permit_is_current(&lifecycle, &second));
        assert_eq!(
            lifecycle.in_flight.values().filter(|entry| !entry.cancel.is_cancelled()).count(),
            1
        );
        let current = lifecycle.in_flight.get(&second.key).expect("replacement ledger entry");
        assert_eq!(current.webview_label, "app-shell");
        assert_eq!(current.target, target);
        drop(lifecycle);

        // Dropping the stale permit must not remove the replacement's ledger
        // entry; this is the publication barrier used by Started.
        drop(first);
        let lifecycle = manager.state.lifecycle.lock().expect("lifecycle after stale drop");
        assert!(attach_permit_is_current(&lifecycle, &second));
        assert_eq!(lifecycle.in_flight.len(), 1);
    }

    struct PartialWriter {
        max_write: usize,
        bytes: Vec<u8>,
    }

    impl Write for PartialWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let count = bytes.len().min(self.max_write);
            self.bytes.extend_from_slice(&bytes[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn bounded_input_write_preserves_order_across_partial_writes() {
        let stop = AtomicBool::new(false);
        let mut writer = PartialWriter { max_write: 2, bytes: Vec::new() };
        write_input_bounded(&mut writer, b"first\nsecond\n", &stop).expect("partial writes");
        assert_eq!(writer.bytes, b"first\nsecond\n");
    }

    #[test]
    fn resize_pending_is_latest_wins_and_worker_has_no_active_flag_race() {
        let state = Arc::new(ResizeState {
            pending: Mutex::new(None),
            last_applied: Mutex::new(Some(Instant::now())),
            worker: Mutex::new(None),
            wake: Condvar::new(),
        });
        let first = WirePtySize { cols: 80, rows: 24, pixel_width: 0, pixel_height: 0 };
        let second = WirePtySize { cols: 100, rows: 30, pixel_width: 0, pixel_height: 0 };
        let third = WirePtySize { cols: 120, rows: 40, pixel_width: 0, pixel_height: 0 };
        queue_resize(&state, first).expect("first resize");
        queue_resize(&state, second).expect("coalesced resize");
        queue_resize(&state, third).expect("latest resize");
        assert_eq!(*state.pending.lock().expect("pending"), Some(third));

        // The long-lived worker can be stopped independently of pending work;
        // detach therefore cannot strand a request between worker iterations.
        let stop = Arc::new(AtomicBool::new(false));
        let worker_state = Arc::clone(&state);
        let worker_stop = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            resize_worker(worker_state, Arc::new(Mutex::new(None)), worker_stop)
        });
        thread::sleep(Duration::from_millis(2));
        stop.store(true, Ordering::Release);
        state.wake.notify_all();
        worker.join().expect("resize worker reaped");
    }
}
