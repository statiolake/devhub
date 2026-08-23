//! Dedicated tmux-backed terminal runtime.
//!
//! This module is the only native owner of DevHub's tmux socket, session
//! names, and marker metadata.  The core port deliberately exposes only
//! domain targets and inspection values; tmux names, formats, process output,
//! and child handles stop here.

use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Poll, Waker};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use sha2::{Digest, Sha256};

use crate::runtime::{ChildCleanup, ResolvedExecutable, RuntimeLaunchContext};
use devhub_app_core::config::is_safe_tmux_argument;
use devhub_app_core::ports::{
    CancellationToken, PortError, PortErrorCode, PortFuture, SocketName,
    SocketTargetPreflightState, TerminalInspection, TerminalOwnedSessions, TerminalPreflight,
    TerminalResult, TerminalRuntime, TerminalTarget, WorkspaceTerminalTarget,
};
use devhub_app_core::state::{OwnedSessionRecord, PersistedAppState, RequiredTerminalSet};
use devhub_app_core::{DiagnosticCode, ResourceInspection, WorkspaceId};

pub(crate) mod contract;
mod pty;
pub(crate) use contract::{
    validate_attach_request, validate_attachment_id, validate_input_sequence, validate_schema,
    validate_surface_key, AckRequest, AttachReceipt, AttachRequest, DetachRequest, InputRequest,
    PtySize as TerminalPtySize, ResizeRequest, TerminalError, TerminalErrorCode,
};
pub(crate) use pty::AttachmentIdentity;
use pty::{AttachContext, AttachmentManager};

const PROTOCOL_OPTION: &str = "@devhub-protocol";
const PROTOCOL_VALUE: &str = "1";
const CONTEXT_OPTION: &str = "@devhub-context";
const WORKSPACE_ID_OPTION: &str = "@devhub-workspace-id";
const ROOT_OPTION: &str = "@devhub-root";
const GLOBAL_CONTEXT: &str = "global";
const WORKSPACE_CONTEXT: &str = "workspace";
const GLOBAL_ID: &str = "global";
const SCRATCH_SESSION: &str = "scratch";
const MIN_TMUX_MAJOR: u32 = 3;
const MIN_TMUX_MINOR: u32 = 3;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const MAX_LINES: usize = 2048;
const MAX_LINE_BYTES: usize = 4096;
const MAX_ROOT_METADATA_BYTES: usize = 16 * 1024;
const MAX_SESSIONS: usize = 1024;
const MAX_WINDOWS: usize = 256;
const MAX_PANES: usize = 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);
const BOOTSTRAP_ENV_ROOT: &str = "DEVHUB_BOOTSTRAP_ROOT";
const BOOTSTRAP_ENV_USER_CONFIG: &str = "DEVHUB_USER_TMUX_CONFIG";
const BOOTSTRAP_CONFIG: &str = concat!(
    // `-f` selects this file instead of tmux's normal startup config.  The
    // native adapter supplies a trusted, preselected user-config path via a
    // fixed environment variable; no user value is interpolated into argv.
    "source-file -q \"$DEVHUB_USER_TMUX_CONFIG\"\n",
    // Keep the ownership transaction on one tmux command sequence.  A
    // failure creating Scratch (for example because trusted user config
    // already created a foreign session with that name) stops every following
    // metadata/marker command.
    "new-session -d -s scratch -c \"$DEVHUB_BOOTSTRAP_ROOT\" ; ",
    "set-option -t scratch @devhub-context global ; ",
    "set-option -t scratch @devhub-workspace-id global ; ",
    "set-option -t scratch @devhub-root \"$DEVHUB_BOOTSTRAP_ROOT\" ; ",
    "set-option -g @devhub-protocol 1\n",
);

#[derive(Clone, Copy)]
struct OperationDeadline {
    at: Instant,
}

impl OperationDeadline {
    fn new(timeout: Duration) -> Self {
        Self { at: Instant::now() + timeout }
    }

    fn remaining(self) -> Result<Duration, PortError> {
        let now = Instant::now();
        if now >= self.at {
            Err(PortError::new(PortErrorCode::TimedOut))
        } else {
            Ok(self.at.saturating_duration_since(now))
        }
    }

    fn check(self, cancel: &CancellationToken) -> Result<(), PortError> {
        if cancel.is_cancelled() {
            Err(PortError::new(PortErrorCode::Cancelled))
        } else {
            self.remaining().map(|_| ())
        }
    }
}

#[derive(Default)]
struct RuntimeGateState {
    transition_active: bool,
    active_operations: usize,
}

/// Logical read/write exclusion for the one native terminal owner. The
/// permit keeps ownership across provider I/O, while the mutex is held only
/// while acquiring or releasing that permit. Ordinary operations therefore
/// cannot slip between the final old-socket inventory and the effective-name
/// commit, and cancellation can still interrupt a waiter.
struct RuntimeOperationGate {
    state: Mutex<RuntimeGateState>,
    wake: Condvar,
}

pub(crate) struct RuntimeOperationPermit {
    gate: Arc<RuntimeOperationGate>,
}

pub(crate) struct RuntimeTransitionPermit {
    gate: Arc<RuntimeOperationGate>,
}

impl RuntimeOperationGate {
    fn acquire_operation(
        self: &Arc<Self>,
        cancel: &CancellationToken,
    ) -> Result<RuntimeOperationPermit, PortError> {
        let mut state = self.state.lock().map_err(|_| PortError::new(PortErrorCode::Failed))?;
        loop {
            if cancel.is_cancelled() {
                return Err(PortError::new(PortErrorCode::Cancelled));
            }
            if !state.transition_active {
                state.active_operations = state.active_operations.saturating_add(1);
                return Ok(RuntimeOperationPermit { gate: Arc::clone(self) });
            }
            state = self
                .wake
                .wait_timeout(state, POLL_INTERVAL)
                .map_err(|_| PortError::new(PortErrorCode::Failed))?
                .0;
        }
    }

    fn acquire_transition(
        self: &Arc<Self>,
        cancel: &CancellationToken,
    ) -> Result<RuntimeTransitionPermit, PortError> {
        let mut state = self.state.lock().map_err(|_| PortError::new(PortErrorCode::Failed))?;
        loop {
            if cancel.is_cancelled() {
                return Err(PortError::new(PortErrorCode::Cancelled));
            }
            if !state.transition_active && state.active_operations == 0 {
                state.transition_active = true;
                return Ok(RuntimeTransitionPermit { gate: Arc::clone(self) });
            }
            state = self
                .wake
                .wait_timeout(state, POLL_INTERVAL)
                .map_err(|_| PortError::new(PortErrorCode::Failed))?
                .0;
        }
    }
}

impl Drop for RuntimeOperationPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.active_operations = state.active_operations.saturating_sub(1);
            self.gate.wake.notify_all();
        }
    }
}

impl Drop for RuntimeTransitionPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.transition_active = false;
            self.gate.wake.notify_all();
        }
    }
}

/// A startup-frozen tmux adapter.  A missing executable is represented by
/// `None` and is a runtime health failure, not a process-start failure.
#[derive(Clone)]
pub(crate) struct TmuxTerminalRuntime {
    context: RuntimeLaunchContext,
    tmux: Option<ResolvedExecutable>,
    shell_name: Option<String>,
    tmux_args: Vec<String>,
    effective_socket: Arc<Mutex<Option<SocketName>>>,
    operation_gate: Arc<RuntimeOperationGate>,
    attachments: AttachmentManager,
    timeout: Duration,
}

impl TmuxTerminalRuntime {
    pub(crate) fn new(
        context: RuntimeLaunchContext,
        tmux: Option<ResolvedExecutable>,
        shell: Option<ResolvedExecutable>,
        tmux_args: Vec<String>,
        effective_socket_name: impl Into<String>,
    ) -> Self {
        let tmux_args_valid = tmux_args.iter().all(|argument| is_safe_tmux_argument(argument));
        Self {
            context,
            tmux: tmux.filter(|_| tmux_args_valid),
            shell_name: shell.and_then(|shell| shell.basename().map(str::to_owned)),
            tmux_args: if tmux_args_valid { tmux_args } else { Vec::new() },
            effective_socket: Arc::new(Mutex::new(SocketName::new(effective_socket_name).ok())),
            operation_gate: Arc::new(RuntimeOperationGate {
                state: Mutex::new(RuntimeGateState::default()),
                wake: Condvar::new(),
            }),
            attachments: AttachmentManager::new(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn executable(&self) -> Result<&ResolvedExecutable, PortError> {
        self.tmux.as_ref().ok_or_else(|| PortError::new(PortErrorCode::Unavailable))
    }

    fn socket(&self) -> Result<SocketName, PortError> {
        self.effective_socket
            .lock()
            .map_err(|_| PortError::new(PortErrorCode::Failed))?
            .clone()
            .ok_or_else(|| PortError::new(PortErrorCode::Failed))
    }

    pub(crate) fn adapter_available(&self) -> bool {
        self.tmux.is_some()
            && self.effective_socket.lock().ok().is_some_and(|socket| socket.is_some())
    }

    pub(crate) fn set_effective_socket(&self, socket: SocketName) -> Result<(), PortError> {
        *self.effective_socket.lock().map_err(|_| PortError::new(PortErrorCode::Failed))? =
            Some(socket);
        Ok(())
    }

    /// Attaches one short-lived PTY client to an already verified marked
    /// session. The attachment manager owns only the client process and file
    /// descriptors; the tmux session remains owned by this runtime.
    pub(crate) fn attach_surface(
        &self,
        target: &TerminalTarget,
        surface_key: String,
        webview_label: String,
        size: TerminalPtySize,
        channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
        cancel: &CancellationToken,
    ) -> Result<AttachReceipt, TerminalError> {
        self.attachments.attach(
            self,
            AttachContext { target, surface_key, webview_label, size, channel, cancel },
        )
    }

    pub(crate) fn terminal_input(
        &self,
        identity: AttachmentIdentity<'_>,
        input_sequence: u64,
        bytes: &[u8],
    ) -> Result<(), TerminalError> {
        self.attachments.input(identity, input_sequence, bytes)
    }

    pub(crate) fn terminal_resize(
        &self,
        identity: AttachmentIdentity<'_>,
        size: TerminalPtySize,
        cancel: &CancellationToken,
    ) -> Result<(), TerminalError> {
        let _permit = self.operation_permit(cancel).map_err(TerminalError::from_port)?;
        self.attachments.resize(identity, size)?;
        self.resize_owned_window(identity.target, size, cancel).map_err(TerminalError::from_port)
    }

    pub(crate) fn terminal_acknowledge(
        &self,
        identity: AttachmentIdentity<'_>,
        sequence: u64,
    ) -> Result<(), TerminalError> {
        self.attachments.acknowledge(identity, sequence)
    }

    pub(crate) fn detach_surface(
        &self,
        surface_key: &str,
        attachment_id: &str,
        webview_label: &str,
        target_generation: u64,
    ) -> Result<(), TerminalError> {
        self.attachments.detach(surface_key, attachment_id, webview_label, target_generation)
    }

    pub(crate) fn detach_webview(&self, webview_label: &str) {
        self.attachments.detach_webview(webview_label);
    }

    pub(crate) fn detach_all_surfaces(&self) {
        self.attachments.detach_all();
    }

    pub(crate) fn detach_target(&self, target: &TerminalTarget) {
        self.attachments.detach_target(target);
    }

    /// Closes one exact marked Workspace session after its PTY clients have
    /// been detached.  The operation permit serializes this destructive
    /// provider call with socket transitions and carries cancellation through
    /// every tmux probe/revalidation.
    pub(crate) fn close_workspace_target(
        &self,
        target: &WorkspaceTerminalTarget,
        cancel: &CancellationToken,
    ) -> Result<(), PortError> {
        let _permit = self.operation_permit(cancel)?;
        self.close_sync(target, cancel)
    }

    pub(crate) fn begin_transition(
        &self,
        cancel: &CancellationToken,
    ) -> Result<RuntimeTransitionPermit, PortError> {
        self.operation_gate.acquire_transition(cancel)
    }

    pub(crate) fn transition_preflight(
        &self,
        socket: SocketName,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalPreflight> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || runtime.preflight_sync(socket, &worker_cancel))
    }

    pub(crate) fn transition_inspect_owned_sessions(
        &self,
        socket: SocketName,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalOwnedSessions> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            runtime.inspect_owned_sessions_sync(&socket, &worker_cancel)
        })
    }

    pub(crate) fn transition_close_owned_session(
        &self,
        socket: SocketName,
        session: OwnedSessionRecord,
        cancel: CancellationToken,
    ) -> PortFuture<()> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            runtime.close_owned_session_sync(&socket, &session, &worker_cancel)
        })
    }

    pub(crate) fn transition_ensure_on_socket(
        &self,
        socket: SocketName,
        target: TerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalResult> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            runtime.ensure_sync_on_socket(&socket, &target, &worker_cancel)
        })
    }

    fn operation_permit(
        &self,
        cancel: &CancellationToken,
    ) -> Result<RuntimeOperationPermit, PortError> {
        self.operation_gate.acquire_operation(cancel)
    }

    /// Builds the recreation set from the canonical persisted open Workspace
    /// records. Session names are deterministic domain values; provider
    /// handles never leave this adapter.
    pub(crate) fn required_terminal_set(
        &self,
        state: &PersistedAppState,
    ) -> Result<RequiredTerminalSet, PortError> {
        let mut sessions =
            vec![OwnedSessionRecord::Scratch { session_name: SCRATCH_SESSION.to_owned() }];
        for workspace in &state.workspaces {
            let workspace_id = WorkspaceId::from_uuid(workspace.workspace_id.clone())
                .map_err(|_| PortError::new(PortErrorCode::Failed))?;
            let digest = workspace_digest(Path::new(&workspace.canonical_path))?;
            sessions.push(OwnedSessionRecord::Workspace {
                workspace_id: workspace_id.to_string(),
                session_name: format!("ws-{}", &digest[..20]),
            });
        }
        RequiredTerminalSet::new(sessions).map_err(|_| PortError::new(PortErrorCode::Failed))
    }

    fn preflight_sync(
        &self,
        requested_socket_name: SocketName,
        cancel: &CancellationToken,
    ) -> Result<TerminalPreflight, PortError> {
        let deadline = OperationDeadline::new(self.timeout);
        self.ensure_version(&requested_socket_name, cancel, deadline)?;
        let marker = self.marker_state(&requested_socket_name, cancel, deadline)?;
        let (state, owned, unknown) = match marker {
            MarkerState::Absent => (SocketTargetPreflightState::TargetAbsent, 0, 0),
            MarkerState::Wrong => (SocketTargetPreflightState::WrongMarker, 0, 0),
            MarkerState::Owned => {
                let sessions = self.list_sessions(&requested_socket_name, cancel, deadline)?;
                let owned = sessions
                    .iter()
                    .filter(|session| session.is_marked(&self.context_home()))
                    .count();
                let unknown = sessions.len().saturating_sub(owned);
                let state = if owned == 0 {
                    SocketTargetPreflightState::TargetDevhubEmpty
                } else {
                    SocketTargetPreflightState::MarkedSessions
                };
                (state, owned as u32, unknown as u32)
            }
        };
        TerminalPreflight::try_new(requested_socket_name, state, owned, unknown)
    }

    fn ensure_sync(
        &self,
        target: &TerminalTarget,
        cancel: &CancellationToken,
    ) -> Result<TerminalResult, PortError> {
        let socket = self.socket()?;
        self.ensure_sync_on_socket(&socket, target, cancel)
    }

    fn ensure_sync_on_socket(
        &self,
        socket: &SocketName,
        target: &TerminalTarget,
        cancel: &CancellationToken,
    ) -> Result<TerminalResult, PortError> {
        let deadline = OperationDeadline::new(self.timeout);
        self.ensure_version(socket, cancel, deadline)?;
        self.ensure_server(socket, cancel, deadline)?;
        let sessions = self.list_sessions(socket, cancel, deadline)?;
        let (session_name, root, workspace_id, context) =
            self.target_identity(target, &sessions)?;
        if let Some(existing) = sessions.iter().find(|session| session.name == session_name) {
            if existing.matches(context, &workspace_id, &root) {
                return Ok(TerminalResult::new(target.clone()));
            }
            return Err(PortError::new(PortErrorCode::Conflict));
        }
        let spec =
            SessionSpec { name: &session_name, root: &root, context, workspace_id: &workspace_id };
        self.create_session(socket, &spec, cancel, deadline)?;
        Ok(TerminalResult::new(target.clone()))
    }

    /// Lists exact marked sessions from a dedicated socket. This is the only
    /// operation that turns provider metadata into durable cleanup records;
    /// unmarked sessions remain an opaque count and never become kill targets.
    fn inspect_owned_sessions_sync(
        &self,
        socket: &SocketName,
        cancel: &CancellationToken,
    ) -> Result<TerminalOwnedSessions, PortError> {
        let deadline = OperationDeadline::new(self.timeout);
        self.ensure_version(socket, cancel, deadline)?;
        let marker = self.marker_state(socket, cancel, deadline)?;
        match marker {
            MarkerState::Absent => return TerminalOwnedSessions::new(Vec::new(), 0),
            MarkerState::Wrong => return Err(PortError::new(PortErrorCode::Conflict)),
            MarkerState::Owned => {}
        }
        let sessions = self.list_sessions(socket, cancel, deadline)?;
        let mut owned = Vec::new();
        for session in &sessions {
            if !session.is_marked(&self.context_home()) {
                continue;
            }
            owned.push(self.owned_session_record(session)?);
        }
        let unknown = sessions.len().saturating_sub(owned.len());
        TerminalOwnedSessions::new(owned, u32::try_from(unknown).unwrap_or(u32::MAX))
    }

    fn owned_session_record(&self, session: &SessionInfo) -> Result<OwnedSessionRecord, PortError> {
        match (session.context.as_deref(), session.workspace_id.as_deref()) {
            (Some(GLOBAL_CONTEXT), Some(GLOBAL_ID)) if session.name == SCRATCH_SESSION => {
                Ok(OwnedSessionRecord::Scratch { session_name: SCRATCH_SESSION.to_owned() })
            }
            (Some(WORKSPACE_CONTEXT), Some(workspace_id)) => {
                let workspace_id = WorkspaceId::from_uuid(workspace_id.to_owned())
                    .map_err(|_| PortError::new(PortErrorCode::Conflict))?;
                Ok(OwnedSessionRecord::Workspace {
                    workspace_id: workspace_id.to_string(),
                    session_name: session.name.clone(),
                })
            }
            _ => Err(PortError::new(PortErrorCode::Conflict)),
        }
    }

    fn close_owned_session_sync(
        &self,
        socket: &SocketName,
        expected: &OwnedSessionRecord,
        cancel: &CancellationToken,
    ) -> Result<(), PortError> {
        let deadline = OperationDeadline::new(self.timeout);
        self.ensure_version(socket, cancel, deadline)?;
        match self.marker_state(socket, cancel, deadline)? {
            MarkerState::Absent => return Ok(()),
            MarkerState::Wrong => return Err(PortError::new(PortErrorCode::Conflict)),
            MarkerState::Owned => {}
        }
        let sessions = self.list_sessions(socket, cancel, deadline)?;
        let Some(_) = sessions.iter().find(|session| {
            session.name == expected.session_name() && self.matches_owned_record(session, expected)
        }) else {
            // A missing exact session is already complete. A same-name
            // unmarked/replaced session is a conflict and must remain intact.
            if sessions.iter().any(|session| session.name == expected.session_name()) {
                return Err(PortError::new(PortErrorCode::Conflict));
            }
            return Ok(());
        };
        // The first marker/list pair only establishes an idempotent candidate.
        // Reinspect both immediately before kill so a replaced session or a
        // server marker change cannot turn this exact record into a broad
        // name-based destructive operation.
        match self.marker_state(socket, cancel, deadline)? {
            MarkerState::Absent => return Ok(()),
            MarkerState::Wrong => return Err(PortError::new(PortErrorCode::Conflict)),
            MarkerState::Owned => {}
        }
        let current_sessions = self.list_sessions(socket, cancel, deadline)?;
        let Some(current) = current_sessions.iter().find(|session| {
            session.name == expected.session_name() && self.matches_owned_record(session, expected)
        }) else {
            if current_sessions.iter().any(|session| session.name == expected.session_name()) {
                return Err(PortError::new(PortErrorCode::Conflict));
            }
            return Ok(());
        };
        let root =
            current.root.as_deref().map(PathBuf::from).unwrap_or_else(|| self.context_home());
        let output = self.run_tmux(
            socket,
            &["kill-session".to_owned(), "-t".to_owned(), expected.session_name().to_owned()],
            &root,
            cancel,
            deadline,
        )?;
        if !output.status.success() {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        // Confirm the destructive operation's result. This makes completion
        // idempotent across a crash and prevents a replacement from being
        // mistaken for the owned session we intended to remove.
        let remaining = self.list_sessions(socket, cancel, deadline)?;
        match remaining.iter().find(|session| session.name == expected.session_name()) {
            None => Ok(()),
            Some(session) if self.matches_owned_record(session, expected) => {
                Err(PortError::new(PortErrorCode::Failed))
            }
            Some(_) => Err(PortError::new(PortErrorCode::Conflict)),
        }
    }

    fn matches_owned_record(&self, session: &SessionInfo, expected: &OwnedSessionRecord) -> bool {
        match expected {
            OwnedSessionRecord::Scratch { session_name } => {
                session.name == session_name.as_str()
                    && session.matches(GLOBAL_CONTEXT, GLOBAL_ID, &self.context_home())
            }
            OwnedSessionRecord::Workspace { workspace_id, session_name } => {
                let Some(root) = session.root.as_deref() else {
                    return false;
                };
                session.name == session_name.as_str()
                    && session.context.as_deref() == Some(WORKSPACE_CONTEXT)
                    && session.workspace_id.as_deref() == Some(workspace_id)
                    && is_root_metadata(root)
                    && is_workspace_session_name(session_name, root)
            }
        }
    }

    fn inspect_sync(
        &self,
        target: &TerminalTarget,
        cancel: &CancellationToken,
    ) -> Result<TerminalInspection, PortError> {
        let socket = match self.socket() {
            Ok(socket) => socket,
            Err(error) => return inspection_failure(error),
        };
        let deadline = OperationDeadline::new(self.timeout);
        if let Err(error) = self.ensure_version(&socket, cancel, deadline) {
            return inspection_failure(error);
        }
        let marker = match self.marker_state(&socket, cancel, deadline) {
            Ok(marker) => marker,
            Err(error) => return inspection_failure(error),
        };
        match marker {
            MarkerState::Absent => return Ok(clean_inspection()),
            MarkerState::Wrong => return Ok(unknown_inspection()),
            MarkerState::Owned => {}
        }
        let sessions = match self.list_sessions(&socket, cancel, deadline) {
            Ok(sessions) => sessions,
            Err(error) => return inspection_failure(error),
        };
        let (session_name, root, workspace_id, context) =
            match self.target_identity(target, &sessions) {
                Ok(identity) => identity,
                Err(error) => return inspection_failure(error),
            };
        let Some(session) = sessions.iter().find(|session| session.name == session_name) else {
            return Ok(clean_inspection());
        };
        if !session.matches(context, &workspace_id, &root) {
            return Ok(unknown_inspection());
        }
        if self.shell_name.is_none() {
            return Ok(unknown_inspection());
        }
        let windows = match self.list_count(
            &socket,
            &session.name,
            "list-windows",
            "#{window_id}",
            cancel,
            deadline,
        ) {
            Ok(windows) => windows,
            Err(error) => return inspection_failure(error),
        };
        let panes = match self.list_panes(&socket, &session.name, cancel, deadline) {
            Ok(panes) => panes,
            Err(error) => return inspection_failure(error),
        };
        let process = match resource_count(
            panes.iter().filter(|pane| !self.is_configured_shell_command(pane)).count(),
        ) {
            Ok(process) => process,
            Err(error) => return inspection_failure(error),
        };
        let extra_panes = match resource_count(panes.len().saturating_sub(1)) {
            Ok(extra_panes) => extra_panes,
            Err(error) => return inspection_failure(error),
        };
        let extra_windows = match resource_count(windows.saturating_sub(1)) {
            Ok(extra_windows) => extra_windows,
            Err(error) => return inspection_failure(error),
        };
        Ok(TerminalInspection::new(process, extra_panes, extra_windows))
    }

    fn close_sync(
        &self,
        target: &WorkspaceTerminalTarget,
        cancel: &CancellationToken,
    ) -> Result<(), PortError> {
        let socket = self.socket()?;
        let deadline = OperationDeadline::new(self.timeout);
        self.ensure_version(&socket, cancel, deadline)?;
        match self.marker_state(&socket, cancel, deadline)? {
            MarkerState::Absent => return Ok(()),
            MarkerState::Wrong => return Err(PortError::new(PortErrorCode::Conflict)),
            MarkerState::Owned => {}
        }
        let sessions = self.list_sessions(&socket, cancel, deadline)?;
        let (session_name, root, workspace_id, _) = self.workspace_identity(target, &sessions)?;
        let Some(existing) = sessions.iter().find(|session| session.name == session_name) else {
            return Ok(());
        };
        if !existing.matches(WORKSPACE_CONTEXT, &workspace_id, &root) {
            return Err(PortError::new(PortErrorCode::Conflict));
        }
        // Reinspect immediately before the destructive command.  A session
        // may have been replaced or its ownership metadata changed between
        // the initial probe and this point; never kill a mismatched resource.
        match self.marker_state(&socket, cancel, deadline)? {
            MarkerState::Absent => return Ok(()),
            MarkerState::Wrong => return Err(PortError::new(PortErrorCode::Conflict)),
            MarkerState::Owned => {}
        }
        let current_sessions = self.list_sessions(&socket, cancel, deadline)?;
        let Some(current) = current_sessions.iter().find(|session| session.name == session_name)
        else {
            return Ok(());
        };
        if !current.matches(WORKSPACE_CONTEXT, &workspace_id, &root) {
            return Err(PortError::new(PortErrorCode::Conflict));
        }
        let output = self.run_tmux(
            &socket,
            &["kill-session".to_owned(), "-t".to_owned(), session_name],
            root.as_path(),
            cancel,
            deadline,
        )?;
        if output.status.success() {
            Ok(())
        } else {
            Err(PortError::new(PortErrorCode::Failed))
        }
    }

    /// tmux keeps a detached session window at its previous dimensions even
    /// after the attached client reports a new terminal size.  Resize the
    /// exact marked target as part of the same operation-gated resize so the
    /// interactive pane, not only the client PTY, observes the request.
    fn resize_owned_window(
        &self,
        target: &TerminalTarget,
        size: TerminalPtySize,
        cancel: &CancellationToken,
    ) -> Result<(), PortError> {
        let socket = self.socket()?;
        let deadline = OperationDeadline::new(self.timeout);
        self.ensure_version(&socket, cancel, deadline)?;
        if self.marker_state(&socket, cancel, deadline)? != MarkerState::Owned {
            return Err(PortError::new(PortErrorCode::Conflict));
        }
        let sessions = self.list_sessions(&socket, cancel, deadline)?;
        let (session_name, root, workspace_id, context) =
            self.target_identity(target, &sessions)?;
        let exact = sessions
            .iter()
            .find(|session| session.name == session_name)
            .filter(|session| session.matches(context, &workspace_id, &root))
            .ok_or_else(|| PortError::new(PortErrorCode::Conflict))?;
        let output = self.run_tmux(
            &socket,
            &[
                "resize-window".to_owned(),
                "-t".to_owned(),
                exact.name.clone(),
                "-x".to_owned(),
                size.cols.to_string(),
                "-y".to_owned(),
                size.rows.to_string(),
            ],
            &root,
            cancel,
            deadline,
        )?;
        if output.status.success() {
            Ok(())
        } else {
            Err(PortError::new(PortErrorCode::Failed))
        }
    }

    fn ensure_server(
        &self,
        socket: &SocketName,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<(), PortError> {
        match self.marker_state(socket, cancel, deadline)? {
            MarkerState::Owned => self.ensure_scratch(socket, cancel, deadline),
            MarkerState::Wrong => Err(PortError::new(PortErrorCode::Conflict)),
            MarkerState::Absent => {
                self.bootstrap_absent_server(socket, cancel, deadline)?;
                self.ensure_scratch(socket, cancel, deadline)
            }
        }
    }

    /// Verifies the complete global Scratch identity after every bootstrap or
    /// attach.  A marker alone is not ownership: an existing partial or
    /// mismatched `scratch` session is opaque and must never be repaired in
    /// place.  If the exact session is absent on an otherwise-owned server,
    /// create it through the same metadata chain and read it back again.
    fn ensure_scratch(
        &self,
        socket: &SocketName,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<(), PortError> {
        let home = self.context_home();
        let sessions = self.list_sessions(socket, cancel, deadline)?;
        if let Some(scratch) = sessions.iter().find(|session| session.name == SCRATCH_SESSION) {
            if scratch.matches(GLOBAL_CONTEXT, GLOBAL_ID, &home) {
                return if self.marker_state(socket, cancel, deadline)? == MarkerState::Owned {
                    Ok(())
                } else {
                    Err(PortError::new(PortErrorCode::Conflict))
                };
            }
            return Err(PortError::new(PortErrorCode::Conflict));
        }

        let spec = SessionSpec {
            name: SCRATCH_SESSION,
            root: &home,
            context: GLOBAL_CONTEXT,
            workspace_id: GLOBAL_ID,
        };
        self.create_session(socket, &spec, cancel, deadline)?;
        if self.marker_state(socket, cancel, deadline)? != MarkerState::Owned {
            return Err(PortError::new(PortErrorCode::Conflict));
        }
        let sessions = self.list_sessions(socket, cancel, deadline)?;
        match sessions.iter().find(|session| session.name == SCRATCH_SESSION) {
            Some(scratch) if scratch.matches(GLOBAL_CONTEXT, GLOBAL_ID, &home) => Ok(()),
            Some(_) | None => Err(PortError::new(PortErrorCode::Conflict)),
        }
    }

    fn marker_state(
        &self,
        socket: &SocketName,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<MarkerState, PortError> {
        let output = self.run_tmux(
            socket,
            &["show-options".to_owned(), "-gqv".to_owned(), PROTOCOL_OPTION.to_owned()],
            &self.context_home(),
            cancel,
            deadline,
        )?;
        if !output.status.success() {
            if is_no_server_error(&output.stderr) {
                return Ok(MarkerState::Absent);
            }
            // A reachable server without this option is an existing foreign
            // server, not an absent server. Treat a missing marker as the
            // same fail-closed conflict as an explicitly wrong marker.
            return Ok(MarkerState::Wrong);
        }
        if output.stdout.is_empty() {
            // A live server without the ownership option is a foreign or
            // legacy server, never an absent target.
            return Ok(MarkerState::Wrong);
        }
        let value = parse_option_value(&output.stdout)?;
        if value == PROTOCOL_VALUE {
            Ok(MarkerState::Owned)
        } else {
            Ok(MarkerState::Wrong)
        }
    }

    fn ensure_version(
        &self,
        socket: &SocketName,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<(), PortError> {
        let output =
            self.run_tmux(socket, &["-V".to_owned()], &self.context_home(), cancel, deadline)?;
        if !output.status.success() {
            return Err(PortError::new(PortErrorCode::Unavailable));
        }
        let line = parse_lines(&output.stdout)?
            .into_iter()
            .next()
            .ok_or_else(|| PortError::new(PortErrorCode::Incompatible))?;
        let Some(version) = line.strip_prefix("tmux ") else {
            return Err(PortError::new(PortErrorCode::Incompatible));
        };
        let mut numbers = version.split('.').map(parse_numeric_prefix);
        let major = numbers.next().unwrap_or(0);
        let minor = numbers.next().unwrap_or(0);
        if major < MIN_TMUX_MAJOR || (major == MIN_TMUX_MAJOR && minor < MIN_TMUX_MINOR) {
            return Err(PortError::new(PortErrorCode::Incompatible));
        }
        Ok(())
    }

    fn target_identity(
        &self,
        target: &TerminalTarget,
        sessions: &[SessionInfo],
    ) -> Result<(String, PathBuf, String, &'static str), PortError> {
        match (target.workspace_id(), target.root()) {
            (None, None) => Ok((
                SCRATCH_SESSION.to_owned(),
                self.context_home(),
                GLOBAL_ID.to_owned(),
                GLOBAL_CONTEXT,
            )),
            (Some(workspace_id), Some(root)) => {
                let workspace = WorkspaceTerminalTarget::new(workspace_id.clone(), root.clone());
                self.workspace_identity(&workspace, sessions)
            }
            _ => Err(PortError::new(PortErrorCode::Failed)),
        }
    }

    fn workspace_identity(
        &self,
        target: &WorkspaceTerminalTarget,
        sessions: &[SessionInfo],
    ) -> Result<(String, PathBuf, String, &'static str), PortError> {
        let root = target.root().as_path().to_path_buf();
        if !root.is_absolute() || root.to_str().is_none() {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let workspace_id = target.workspace_id().as_str().to_owned();
        let digest = workspace_digest(&root)?;
        let short = format!("ws-{}", &digest[..20]);
        let long = format!("ws-{}", &digest[..32]);
        let expected = |name: &str| {
            sessions
                .iter()
                .find(|session| session.name == name)
                .map(|session| session.matches(WORKSPACE_CONTEXT, &workspace_id, &root))
        };
        match expected(&short) {
            None | Some(true) => Ok((short, root, workspace_id, WORKSPACE_CONTEXT)),
            Some(false) => match expected(&long) {
                None | Some(true) => Ok((long, root, workspace_id, WORKSPACE_CONTEXT)),
                Some(false) => Err(PortError::new(PortErrorCode::Conflict)),
            },
        }
    }

    fn create_session(
        &self,
        socket: &SocketName,
        spec: &SessionSpec<'_>,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<(), PortError> {
        if !spec.root.is_dir() {
            return Err(PortError::new(PortErrorCode::Unavailable));
        }
        let initial_marker = self.marker_state(socket, cancel, deadline)?;
        if initial_marker != MarkerState::Owned {
            return Err(PortError::new(PortErrorCode::Conflict));
        }
        let canonical_root =
            fs::canonicalize(spec.root).map_err(|_| PortError::new(PortErrorCode::Unavailable))?;
        if canonical_root != spec.root {
            return Err(PortError::new(PortErrorCode::Conflict));
        }
        let root = spec.root.to_str().ok_or_else(|| PortError::new(PortErrorCode::Failed))?;
        let args = vec![
            "new-session".to_owned(),
            "-d".to_owned(),
            "-s".to_owned(),
            spec.name.to_owned(),
            "-c".to_owned(),
            root.to_owned(),
            ";".to_owned(),
            "set-option".to_owned(),
            "-t".to_owned(),
            spec.name.to_owned(),
            CONTEXT_OPTION.to_owned(),
            spec.context.to_owned(),
            ";".to_owned(),
            "set-option".to_owned(),
            "-t".to_owned(),
            spec.name.to_owned(),
            WORKSPACE_ID_OPTION.to_owned(),
            spec.workspace_id.to_owned(),
            ";".to_owned(),
            "set-option".to_owned(),
            "-t".to_owned(),
            spec.name.to_owned(),
            ROOT_OPTION.to_owned(),
            root.to_owned(),
        ];
        // This is the last read before creating a session.  The earlier
        // ownership check protects path validation; this one prevents a
        // server that changed marker state while we were preparing argv from
        // receiving a destructive command.
        let final_marker = self.marker_state(socket, cancel, deadline)?;
        if final_marker != MarkerState::Owned {
            return Err(PortError::new(PortErrorCode::Conflict));
        }
        let output = self.run_tmux(socket, &args, &self.context_home(), cancel, deadline)?;
        if output.status.success() {
            Ok(())
        } else {
            // Leave a possibly-created session for exact reconciliation. A
            // blind kill could destroy a concurrent or unknown resource.
            Err(PortError::new(PortErrorCode::Conflict))
        }
    }

    fn list_sessions(
        &self,
        socket: &SocketName,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<Vec<SessionInfo>, PortError> {
        let output = self.run_tmux(
            socket,
            &["list-sessions".to_owned(), "-F".to_owned(), "#{session_name}".to_owned()],
            &self.context_home(),
            cancel,
            deadline,
        )?;
        if !output.status.success() {
            if is_no_server_error(&output.stderr) {
                return Ok(Vec::new());
            }
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let names = parse_lines(&output.stdout)?;
        if names.len() > MAX_SESSIONS {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        names
            .into_iter()
            .map(|name| {
                let context = self.show_option(socket, &name, CONTEXT_OPTION, cancel, deadline)?;
                let workspace_id =
                    self.show_option(socket, &name, WORKSPACE_ID_OPTION, cancel, deadline)?;
                let root = self.show_option(socket, &name, ROOT_OPTION, cancel, deadline)?;
                Ok(SessionInfo { name, context, workspace_id, root })
            })
            .collect()
    }

    fn show_option(
        &self,
        socket: &SocketName,
        session: &str,
        option: &str,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<Option<String>, PortError> {
        let output = self.run_tmux(
            socket,
            &[
                "show-options".to_owned(),
                "-t".to_owned(),
                session.to_owned(),
                "-qv".to_owned(),
                option.to_owned(),
            ],
            &self.context_home(),
            cancel,
            deadline,
        )?;
        if !output.status.success() {
            return Ok(None);
        }
        if output.stdout.is_empty() {
            return Ok(None);
        }
        Ok(Some(parse_option_value(&output.stdout)?))
    }

    fn list_count(
        &self,
        socket: &SocketName,
        session: &str,
        command: &str,
        format: &str,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<usize, PortError> {
        let output = self.run_tmux(
            socket,
            &[
                command.to_owned(),
                "-t".to_owned(),
                session.to_owned(),
                "-F".to_owned(),
                format.to_owned(),
            ],
            &self.context_home(),
            cancel,
            deadline,
        )?;
        if !output.status.success() {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let lines = parse_lines(&output.stdout)?;
        if lines.len() > MAX_WINDOWS {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        Ok(lines.len())
    }

    fn list_panes(
        &self,
        socket: &SocketName,
        session: &str,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<Vec<String>, PortError> {
        let output = self.run_tmux(
            socket,
            &[
                "list-panes".to_owned(),
                "-t".to_owned(),
                session.to_owned(),
                "-F".to_owned(),
                "#{pane_current_command}".to_owned(),
            ],
            &self.context_home(),
            cancel,
            deadline,
        )?;
        if !output.status.success() {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let lines = parse_lines(&output.stdout)?;
        if lines.len() > MAX_PANES {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        Ok(lines)
    }

    fn context_home(&self) -> PathBuf {
        self.context.home().to_path_buf()
    }

    fn user_tmux_config_path(&self) -> PathBuf {
        let home = self.context_home();
        let mut candidates = vec![home.join(".tmux.conf")];
        if let Some(xdg) = self.context.environment_value("XDG_CONFIG_HOME") {
            let xdg = PathBuf::from(xdg);
            if xdg.is_absolute() {
                candidates.push(xdg.join("tmux").join("tmux.conf"));
            } else {
                candidates.push(home.join(".config").join("tmux").join("tmux.conf"));
            }
        } else {
            candidates.push(home.join(".config").join("tmux").join("tmux.conf"));
        }
        candidates
            .into_iter()
            .find(|path| fs::metadata(path).is_ok_and(|metadata| metadata.is_file()))
            .unwrap_or_else(|| PathBuf::from("/dev/null"))
    }

    fn is_configured_shell_command(&self, command: &str) -> bool {
        let Some(shell_name) = self.shell_name.as_deref() else {
            return false;
        };
        let command = command.trim_start_matches('-');
        let command =
            Path::new(command).file_name().and_then(|name| name.to_str()).unwrap_or(command);
        command == shell_name
    }

    /// Probes or bootstraps an absent server through a startup config. tmux
    /// reads `-f` only while creating a new server; when a server already
    /// exists, this invocation is a read-only `show-options` probe and the
    /// config is ignored. This closes the absent-to-wrong-marker race without
    /// issuing a mutating client command against an existing server.
    fn bootstrap_absent_server(
        &self,
        socket: &SocketName,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<(), PortError> {
        let config = BootstrapConfig::create()?;
        let root = self.context_home();
        let root = root.to_str().ok_or_else(|| PortError::new(PortErrorCode::Failed))?;
        let output = self.run_bootstrap_probe(&config, socket, root, cancel, deadline)?;
        if output.status.success() {
            if output.stdout.is_empty() {
                return Err(PortError::new(PortErrorCode::Conflict));
            }
            let marker = parse_option_value(&output.stdout)?;
            if marker == PROTOCOL_VALUE {
                Ok(())
            } else {
                Err(PortError::new(PortErrorCode::Conflict))
            }
        } else {
            // A trusted user config may already have created a session named
            // Scratch with a foreign/partial identity.  Reclassify that
            // observable collision as Conflict, while retaining Failed for
            // an actual server/provider startup error.
            if self.list_sessions(socket, cancel, deadline).ok().is_some_and(|sessions| {
                sessions.iter().any(|session| session.name == SCRATCH_SESSION)
            }) {
                return Err(PortError::new(PortErrorCode::Conflict));
            }
            Err(PortError::new(PortErrorCode::Failed))
        }
    }

    fn run_bootstrap_probe(
        &self,
        config: &BootstrapConfig,
        socket: &SocketName,
        root: &str,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<CommandOutput, PortError> {
        let executable = self.executable()?;
        let mut command = self.context.command(executable);
        command
            .current_dir(self.context_home())
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .env(BOOTSTRAP_ENV_ROOT, root)
            .env(BOOTSTRAP_ENV_USER_CONFIG, self.user_tmux_config_path())
            .args(&self.tmux_args)
            .arg("-f")
            .arg(&config.path)
            .args(["-L", socket.as_str()])
            // `show-options` alone does not create a tmux server.  Start the
            // server and immediately read the marker in one client queue.  On
            // an existing server `start-server` is a no-op and tmux ignores
            // this invocation's startup config, so the queue remains
            // observational there; on a new server the config creates the
            // fully marked Scratch session before this read runs.
            .args(["start-server", ";", "show-options", "-gqv", PROTOCOL_OPTION])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        run_bounded(command, deadline, cancel)
    }

    fn run_tmux(
        &self,
        socket: &SocketName,
        args: &[String],
        _cwd: &Path,
        cancel: &CancellationToken,
        deadline: OperationDeadline,
    ) -> Result<CommandOutput, PortError> {
        let executable = self.executable()?;
        let mut command = self.context.command(executable);
        command
            // The adapter's client cwd must remain usable even when a
            // workspace has been deleted; session creation still receives
            // its target root through tmux's explicit `-c` argument.
            .current_dir(self.context_home())
            // A DevHub launched from an existing tmux pane must still create
            // and inspect its dedicated server rather than inheriting the
            // parent client's nested-session hints.
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .args(&self.tmux_args)
            .args(["-L", socket.as_str()])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        run_bounded(command, deadline, cancel)
    }
}

impl fmt::Debug for TmuxTerminalRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TmuxTerminalRuntime")
            .field("tmux", &self.tmux)
            .field("tmux_args_count", &self.tmux_args.len())
            .field("effective_socket", &self.effective_socket.lock().ok())
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl TerminalRuntime for TmuxTerminalRuntime {
    fn preflight(
        &self,
        requested_socket_name: SocketName,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalPreflight> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            let _permit = runtime.operation_permit(&worker_cancel)?;
            runtime.preflight_sync(requested_socket_name, &worker_cancel)
        })
    }

    fn ensure(
        &self,
        target: TerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalResult> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            let _permit = runtime.operation_permit(&worker_cancel)?;
            runtime.ensure_sync(&target, &worker_cancel)
        })
    }

    fn inspect(
        &self,
        target: TerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalInspection> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            let _permit = runtime.operation_permit(&worker_cancel)?;
            runtime.inspect_sync(&target, &worker_cancel)
        })
    }

    fn close_workspace(
        &self,
        target: WorkspaceTerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<()> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            let _permit = runtime.operation_permit(&worker_cancel)?;
            runtime.close_sync(&target, &worker_cancel)
        })
    }

    fn inspect_owned_sessions(
        &self,
        socket: SocketName,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalOwnedSessions> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            let _permit = runtime.operation_permit(&worker_cancel)?;
            runtime.inspect_owned_sessions_sync(&socket, &worker_cancel)
        })
    }

    fn close_owned_session(
        &self,
        socket: SocketName,
        session: OwnedSessionRecord,
        cancel: CancellationToken,
    ) -> PortFuture<()> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            let _permit = runtime.operation_permit(&worker_cancel)?;
            runtime.close_owned_session_sync(&socket, &session, &worker_cancel)
        })
    }

    fn ensure_on_socket(
        &self,
        socket: SocketName,
        target: TerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalResult> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || {
            let _permit = runtime.operation_permit(&worker_cancel)?;
            runtime.ensure_sync_on_socket(&socket, &target, &worker_cancel)
        })
    }
}

struct BootstrapConfig {
    path: PathBuf,
}

impl BootstrapConfig {
    fn create() -> Result<Self, PortError> {
        for _ in 0..8 {
            let sequence = BOOTSTRAP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("devhub-tmux-bootstrap-{}-{sequence}", std::process::id()));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let Ok(mut file) = options.open(&path) else {
                continue;
            };
            if file.write_all(BOOTSTRAP_CONFIG.as_bytes()).is_err() || file.sync_all().is_err() {
                let _ = fs::remove_file(&path);
                return Err(PortError::new(PortErrorCode::Failed));
            }
            return Ok(Self { path });
        }
        Err(PortError::new(PortErrorCode::Failed))
    }
}

impl Drop for BootstrapConfig {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

static BOOTSTRAP_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
static REAL_TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerState {
    Absent,
    Wrong,
    Owned,
}

#[derive(Clone)]
struct SessionInfo {
    name: String,
    context: Option<String>,
    workspace_id: Option<String>,
    root: Option<String>,
}

struct SessionSpec<'a> {
    name: &'a str,
    root: &'a Path,
    context: &'a str,
    workspace_id: &'a str,
}

impl SessionInfo {
    fn is_marked(&self, expected_global_root: &Path) -> bool {
        match (self.context.as_deref(), self.workspace_id.as_deref(), self.root.as_deref()) {
            (Some(GLOBAL_CONTEXT), Some(GLOBAL_ID), Some(root)) => {
                self.name == SCRATCH_SESSION
                    && expected_global_root.to_str() == Some(root)
                    && is_root_metadata(root)
            }
            (Some(WORKSPACE_CONTEXT), Some(workspace_id), Some(root)) => {
                WorkspaceId::from_uuid(workspace_id).is_ok()
                    && is_root_metadata(root)
                    && is_workspace_session_name(&self.name, root)
            }
            _ => false,
        }
    }

    fn matches(&self, context: &str, workspace_id: &str, root: &Path) -> bool {
        let Some(root) = root.to_str() else {
            return false;
        };
        self.context.as_deref() == Some(context)
            && self.workspace_id.as_deref() == Some(workspace_id)
            && self.root.as_deref() == Some(root)
    }
}

fn workspace_digest(root: &Path) -> Result<String, PortError> {
    let text = root.to_str().ok_or_else(|| PortError::new(PortErrorCode::Failed))?;
    let digest = Sha256::digest(text.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn is_workspace_session_name(name: &str, root: &str) -> bool {
    let Ok(digest) = workspace_digest(Path::new(root)) else {
        return false;
    };
    name == format!("ws-{}", &digest[..20]) || name == format!("ws-{}", &digest[..32])
}

fn resource_count(count: usize) -> Result<ResourceInspection, PortError> {
    if count == 0 {
        Ok(ResourceInspection::clean())
    } else {
        ResourceInspection::busy(u32::try_from(count).unwrap_or(u32::MAX))
            .map_err(|_| PortError::new(PortErrorCode::Failed))
    }
}

fn clean_inspection() -> TerminalInspection {
    TerminalInspection::new(
        ResourceInspection::clean(),
        ResourceInspection::clean(),
        ResourceInspection::clean(),
    )
}

fn unknown_inspection() -> TerminalInspection {
    TerminalInspection::new(
        ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
        ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
        ResourceInspection::unknown(DiagnosticCode::CloseTerminalUnknown),
    )
}

/// Inspection is intentionally fail-closed.  Provider failures (missing
/// executable, malformed output, protocol/version errors, and timeouts) are
/// projected as an unknown resource state so callers cannot treat an
/// unverified terminal as clean.  Cancellation remains an operation error so
/// lifecycle code can distinguish an explicit abort from an unavailable
/// inspection.
fn inspection_failure(error: PortError) -> Result<TerminalInspection, PortError> {
    if error.code() == PortErrorCode::Cancelled {
        Err(error)
    } else {
        Ok(unknown_inspection())
    }
}

fn is_root_metadata(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ROOT_METADATA_BYTES
        && !value.contains('\0')
        && Path::new(value).is_absolute()
}

fn parse_numeric_prefix(value: &str) -> u32 {
    let digits = value.chars().take_while(char::is_ascii_digit).collect::<String>();
    digits.parse().unwrap_or(0)
}

fn is_no_server_error(stderr: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(stderr) else {
        return false;
    };
    let text = text.trim().to_ascii_lowercase();
    text.contains("no server running")
        || text == "no server"
        || (text.starts_with("error connecting") && text.contains("no such file or directory"))
}

struct CommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    /// Bounded private stderr used only for classifying the exact no-server
    /// condition.  It is never included in a public error or Debug value.
    stderr: Vec<u8>,
}

fn run_bounded(
    mut command: Command,
    deadline: OperationDeadline,
    cancel: &CancellationToken,
) -> Result<CommandOutput, PortError> {
    // The operation deadline starts at the caller's first probe, not when
    // this child happens to be spawned.  Refuse a late spawn and give
    // cancellation precedence over timeout.
    deadline.check(cancel)?;
    let mut child = command.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
            PortError::new(PortErrorCode::Unavailable)
        }
        _ => PortError::new(PortErrorCode::Failed),
    })?;
    let process_id = child.id();
    let mut cleanup = ChildCleanup::new(process_id);
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            cleanup.terminate(&mut child);
            return Err(PortError::new(PortErrorCode::Failed));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            cleanup.terminate(&mut child);
            return Err(PortError::new(PortErrorCode::Failed));
        }
    };
    let stdout_state = Arc::new(StreamState::new(MAX_OUTPUT_BYTES));
    let stderr_state = Arc::new(StreamState::new(MAX_STDERR_BYTES));
    let stdout_reader = match spawn_reader(stdout, Arc::clone(&stdout_state), true) {
        Ok(reader) => reader,
        Err(error) => {
            cleanup.terminate(&mut child);
            return Err(error);
        }
    };
    let stderr_reader = match spawn_reader(stderr, Arc::clone(&stderr_state), true) {
        Ok(reader) => reader,
        Err(error) => {
            cleanup.terminate(&mut child);
            let _ = join_reader_bounded(stdout_reader, deadline.at);
            return Err(error);
        }
    };
    let mut failure = None;
    let status = loop {
        if cancel.is_cancelled() {
            cleanup.terminate(&mut child);
            failure = Some(PortError::new(PortErrorCode::Cancelled));
            break None;
        }
        if stdout_state.limit_hit() || stderr_state.limit_hit() {
            cleanup.terminate(&mut child);
            failure = Some(PortError::new(PortErrorCode::Failed));
            break None;
        }
        if Instant::now() >= deadline.at {
            cleanup.terminate(&mut child);
            failure = Some(PortError::new(PortErrorCode::TimedOut));
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(_) => {
                cleanup.terminate(&mut child);
                failure = Some(PortError::new(PortErrorCode::Failed));
                break None;
            }
        }
    };
    // Reader drain is part of the same operation budget.  In particular, a
    // successful child cannot extend the timeout with a fresh grace window
    // while a descendant still holds a pipe open.
    let stdout = join_reader_bounded(stdout_reader, deadline.at);
    let stderr = join_reader_bounded(stderr_reader, deadline.at);
    if let Some(error) = failure {
        return Err(error);
    }
    let Some(status) = status else {
        return Err(PortError::new(PortErrorCode::Failed));
    };
    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        // The leader has exited, but a descendant may still hold one of the
        // pipes. Reconcile that process group before marking the cleanup
        // guard as reaped; the bounded join must not leave a live child.
        cleanup.terminate(&mut child);
        return Err(PortError::new(PortErrorCode::TimedOut));
    };
    cleanup.mark_reaped();
    if stdout.failed || stderr.failed || stdout.limit_hit || stderr.limit_hit {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    Ok(CommandOutput { status, stdout: stdout.bytes, stderr: stderr.bytes })
}

struct StreamState {
    limit: usize,
    observed: AtomicUsize,
    limit_reached: AtomicBool,
}

impl StreamState {
    fn new(limit: usize) -> Self {
        Self { limit, observed: AtomicUsize::new(0), limit_reached: AtomicBool::new(false) }
    }

    fn limit_hit(&self) -> bool {
        self.limit_reached.load(Ordering::Acquire)
    }
}

struct ReaderResult {
    bytes: Vec<u8>,
    failed: bool,
    limit_hit: bool,
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    state: Arc<StreamState>,
    retain: bool,
) -> Result<thread::JoinHandle<ReaderResult>, PortError> {
    thread::Builder::new()
        .name("devhub-tmux-reader".to_owned())
        .spawn(move || {
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 8192];
            let mut failed = false;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let observed = state.observed.fetch_add(read, Ordering::AcqRel);
                        if observed.saturating_add(read) > state.limit {
                            state.limit_reached.store(true, Ordering::Release);
                        } else if retain {
                            bytes.extend_from_slice(&buffer[..read]);
                        }
                    }
                    Err(_) => {
                        failed = true;
                        break;
                    }
                }
            }
            ReaderResult { bytes, failed, limit_hit: state.limit_hit() }
        })
        .map_err(|_| PortError::new(PortErrorCode::Failed))
}

fn join_reader_bounded(
    reader: thread::JoinHandle<ReaderResult>,
    deadline: Instant,
) -> Option<ReaderResult> {
    while !reader.is_finished() && Instant::now() < deadline {
        thread::sleep(POLL_INTERVAL);
    }
    if !reader.is_finished() {
        drop(reader);
        return None;
    }
    reader.join().ok()
}

fn parse_lines(output: &[u8]) -> Result<Vec<String>, PortError> {
    let text = std::str::from_utf8(output).map_err(|_| PortError::new(PortErrorCode::Failed))?;
    if text.contains('\0') {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_LINE_BYTES || lines.len() == MAX_LINES {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        lines.push(line.to_owned());
    }
    Ok(lines)
}

/// Parses one tmux option value without treating an embedded newline as a
/// record separator. tmux appends exactly one newline to `show-options`; a
/// path may itself contain newlines and those bytes remain part of identity.
fn parse_option_value(output: &[u8]) -> Result<String, PortError> {
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    let text = std::str::from_utf8(output).map_err(|_| PortError::new(PortErrorCode::Failed))?;
    if text.contains('\0') {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    let value = text.strip_suffix('\n').ok_or_else(|| PortError::new(PortErrorCode::Failed))?;
    if value.len() > MAX_ROOT_METADATA_BYTES {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    Ok(value.to_owned())
}

struct OperationState<T> {
    result: Option<Result<T, PortError>>,
    waker: Option<Waker>,
}

struct OperationFuture<T> {
    state: Arc<Mutex<OperationState<T>>>,
    cancel: Option<CancellationToken>,
}

impl<T: Send + 'static> std::future::Future for OperationFuture<T> {
    type Output = Result<T, PortError>;

    fn poll(self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.as_ref().get_ref();
        let mut state = match this.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        match state.result.take() {
            Some(result) => Poll::Ready(result),
            None => {
                state.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl<T> Drop for OperationFuture<T> {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
    }
}

fn spawn_operation<T, F>(cancel: CancellationToken, operation: F) -> PortFuture<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, PortError> + Send + 'static,
{
    let state = Arc::new(Mutex::new(OperationState { result: None, waker: None }));
    let worker_state = Arc::clone(&state);
    let spawned =
        thread::Builder::new().name("devhub-terminal-operation".to_owned()).spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
                .unwrap_or_else(|_| Err(PortError::new(PortErrorCode::Failed)));
            let waker = {
                let mut state = match worker_state.lock() {
                    Ok(state) => state,
                    Err(poisoned) => poisoned.into_inner(),
                };
                state.result = Some(result);
                state.waker.take()
            };
            if let Some(waker) = waker {
                waker.wake();
            }
        });
    if spawned.is_err() {
        return Box::pin(async { Err(PortError::new(PortErrorCode::Unavailable)) });
    }
    Box::pin(OperationFuture { state, cancel: Some(cancel) })
}

#[cfg(test)]
struct TmuxServerGuard<'a> {
    runtime: &'a TmuxTerminalRuntime,
    socket: SocketName,
    cancel: CancellationToken,
}

#[cfg(test)]
impl Drop for TmuxServerGuard<'_> {
    fn drop(&mut self) {
        let _ = self.runtime.run_tmux(
            &self.socket,
            &["kill-server".to_owned()],
            &self.runtime.context_home(),
            &self.cancel,
            OperationDeadline::new(self.runtime.timeout),
        );
    }
}

#[cfg(test)]
struct RealTmuxFixture {
    home: PathBuf,
    runtime: TmuxTerminalRuntime,
    socket: SocketName,
    cancel: CancellationToken,
}

#[cfg(test)]
impl Drop for RealTmuxFixture {
    fn drop(&mut self) {
        let _ = self.runtime.run_tmux(
            &self.socket,
            &["kill-server".to_owned()],
            &self.home,
            &self.cancel,
            OperationDeadline::new(self.runtime.timeout),
        );
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devhub_app_core::{WorkspaceId, WorkspaceRoot};

    fn root() -> WorkspaceRoot {
        WorkspaceRoot::new("/tmp/devhub-terminal-test").expect("root")
    }

    fn real_tmux_fixture(label: &str) -> Option<RealTmuxFixture> {
        if std::env::var_os("CODEX_SANDBOX").is_some_and(|value| value == "seatbelt") {
            return None;
        }
        let tmux_path = [
            Path::new("/opt/homebrew/bin/tmux"),
            Path::new("/usr/local/bin/tmux"),
            Path::new("/usr/bin/tmux"),
        ]
        .into_iter()
        .find(|path| path.is_file())?;
        let sequence = REAL_TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let home = std::env::temp_dir()
            .join(format!("devhub-socket-transition-{label}-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&home).ok()?;
        let home = fs::canonicalize(&home).ok()?;
        let socket =
            SocketName::new(format!("dh{label}{}{}", std::process::id(), sequence)).ok()?;
        let context = RuntimeLaunchContext::new(&home, std::env::vars_os().collect()).ok()?;
        let runtime = TmuxTerminalRuntime::new(
            context,
            Some(ResolvedExecutable::for_test(tmux_path)),
            None,
            Vec::new(),
            socket.as_str(),
        )
        .with_timeout(Duration::from_secs(5));
        let operation = devhub_app_core::application::OperationId::from_uuid(format!(
            "00000000-0000-4000-8000-{sequence:012x}"
        ))
        .ok()?;
        Some(RealTmuxFixture { home, runtime, socket, cancel: CancellationToken::new(operation) })
    }

    #[test]
    fn workspace_names_are_stable_and_bounded() {
        let root = root();
        let digest = workspace_digest(root.as_path()).expect("digest");
        assert_eq!(digest.len(), 64);
        assert!(format!("ws-{}", &digest[..20]).len() <= 256);
        assert!(format!("ws-{}", &digest[..32]).len() <= 256);
    }

    #[test]
    fn socket_selector_args_disable_the_runtime() {
        let context =
            RuntimeLaunchContext::new("/tmp", std::env::vars_os().collect()).expect("context");
        let runtime = TmuxTerminalRuntime::new(
            context,
            None,
            None,
            vec!["-L".to_owned(), "evil".to_owned()],
            "devhub",
        )
        .with_timeout(Duration::from_millis(1));
        assert!(runtime.tmux.is_none());
        assert_eq!(runtime.timeout, Duration::from_millis(1));
    }

    #[test]
    fn session_metadata_never_treats_unknown_as_owned() {
        let info = SessionInfo {
            name: "scratch".to_owned(),
            context: Some("other".to_owned()),
            workspace_id: Some("secret".to_owned()),
            root: Some("/tmp/secret".to_owned()),
        };
        assert!(!info.is_marked(Path::new("/tmp")));
        assert!(!info.matches(GLOBAL_CONTEXT, GLOBAL_ID, Path::new("/tmp")));
    }

    #[test]
    fn target_debug_redacts_workspace_identity() {
        let target = TerminalTarget::workspace(
            devhub_app_core::WorkspaceId::from_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
                .expect("workspace id"),
            root(),
        );
        let debug = format!("{target:?}");
        assert!(debug.contains("redacted"));
        assert!(!debug.contains("devhub-terminal-test"));
    }

    #[test]
    fn tmux_version_accepts_numeric_suffixes_but_rejects_old_versions() {
        for version in ["3.3", "3.7b", "4.0"] {
            let mut numbers = version.split('.').map(parse_numeric_prefix);
            let major = numbers.next().unwrap_or(0);
            let minor = numbers.next().unwrap_or(0);
            assert!(major > MIN_TMUX_MAJOR || (major == MIN_TMUX_MAJOR && minor >= MIN_TMUX_MINOR));
        }
        let mut numbers = "3.2".split('.').map(parse_numeric_prefix);
        let major = numbers.next().unwrap_or(0);
        let minor = numbers.next().unwrap_or(0);
        assert!(major < MIN_TMUX_MAJOR || (major == MIN_TMUX_MAJOR && minor < MIN_TMUX_MINOR));
    }

    #[test]
    fn inspection_provider_failure_projects_unknown_resources() {
        let context =
            RuntimeLaunchContext::new("/tmp", std::env::vars_os().collect()).expect("context");
        let runtime = TmuxTerminalRuntime::new(context, None, None, Vec::new(), "devhub")
            .with_timeout(Duration::from_millis(1));
        let operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000043",
        )
        .expect("operation id");
        let cancel = CancellationToken::new(operation);
        let inspection = runtime
            .inspect_sync(&TerminalTarget::scratch(), &cancel)
            .expect("provider failure is an unknown projection");
        assert!(matches!(inspection.process(), ResourceInspection::Unknown { .. }));
        assert!(matches!(inspection.extra_panes(), ResourceInspection::Unknown { .. }));
        assert!(matches!(inspection.extra_windows(), ResourceInspection::Unknown { .. }));
    }

    #[test]
    fn bootstrap_config_selects_one_trusted_user_config_by_precedence() {
        let home = std::env::temp_dir().join(format!(
            "devhub-user-config-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let xdg = home.join("xdg");
        std::fs::create_dir_all(xdg.join("tmux")).expect("config directories");
        std::fs::write(xdg.join("tmux").join("tmux.conf"), "# xdg\n").expect("xdg config");
        let mut environment = std::env::vars_os().collect::<std::collections::BTreeMap<_, _>>();
        environment.insert("XDG_CONFIG_HOME".into(), xdg.clone().into_os_string());
        let context = RuntimeLaunchContext::new(&home, environment).expect("context");
        let runtime = TmuxTerminalRuntime::new(context, None, None, Vec::new(), "devhub");
        assert_eq!(runtime.user_tmux_config_path(), xdg.join("tmux").join("tmux.conf"));

        std::fs::write(home.join(".tmux.conf"), "# home\n").expect("home config");
        assert_eq!(runtime.user_tmux_config_path(), home.join(".tmux.conf"));
        std::fs::remove_file(home.join(".tmux.conf")).expect("remove home config");
        std::fs::remove_dir_all(&xdg).expect("remove xdg config");
        assert_eq!(runtime.user_tmux_config_path(), PathBuf::from("/dev/null"));
        std::fs::remove_dir(&home).expect("remove config home");
    }

    #[test]
    fn bounded_runner_checks_cancel_and_deadline_before_spawn() {
        let operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000045",
        )
        .expect("operation id");
        let cancel = CancellationToken::new(operation);
        let command = Command::new("not-spawned-before-deadline");
        let deadline = OperationDeadline { at: Instant::now() - Duration::from_millis(1) };
        let expired = match run_bounded(command, deadline, &cancel) {
            Err(error) => error,
            Ok(_) => panic!("expired operation spawned a child"),
        };
        assert_eq!(expired.code(), PortErrorCode::TimedOut);

        let cancelled_operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000046",
        )
        .expect("operation id");
        let cancelled = CancellationToken::new(cancelled_operation);
        cancelled.cancel();
        let command = Command::new("not-spawned-after-cancel");
        let cancelled_error = match run_bounded(
            command,
            OperationDeadline::new(Duration::from_secs(1)),
            &cancelled,
        ) {
            Err(error) => error,
            Ok(_) => panic!("cancelled operation spawned a child"),
        };
        assert_eq!(cancelled_error.code(), PortErrorCode::Cancelled);
    }

    #[test]
    fn runtime_gate_excludes_normal_operations_and_honors_cancellation() {
        let gate = Arc::new(RuntimeOperationGate {
            state: Mutex::new(RuntimeGateState::default()),
            wake: Condvar::new(),
        });
        let transition_operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000061",
        )
        .expect("transition operation id");
        let transition_cancel = CancellationToken::new(transition_operation);
        let lease = gate.acquire_transition(&transition_cancel).expect("transition lease");

        let operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000062",
        )
        .expect("normal operation id");
        let operation_cancel = CancellationToken::new(operation);
        let waiting_gate = Arc::clone(&gate);
        let waiting_cancel = operation_cancel.clone();
        let waiter = thread::spawn(move || waiting_gate.acquire_operation(&waiting_cancel));
        thread::sleep(Duration::from_millis(20));
        operation_cancel.cancel();
        let waited = waiter.join().expect("gate waiter join");
        assert!(matches!(waited, Err(error) if error.code() == PortErrorCode::Cancelled));

        drop(lease);
        let operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000063",
        )
        .expect("post-transition operation id");
        let post_transition_cancel = CancellationToken::new(operation);
        let _permit = gate
            .acquire_operation(&post_transition_cancel)
            .expect("normal operation after transition");
    }

    #[test]
    fn real_transition_sockets_cover_conflicts_unknown_preservation_and_dynamic_rebind() {
        let Some(old) = real_tmux_fixture("old") else {
            return;
        };
        let Some(target) = real_tmux_fixture("target") else {
            return;
        };
        let Some(wrong) = real_tmux_fixture("wrong") else {
            return;
        };

        let old_socket = old.socket.clone();
        old.runtime.preflight_sync(old_socket.clone(), &old.cancel).expect("old absent preflight");
        assert_eq!(
            old.runtime
                .preflight_sync(old_socket.clone(), &old.cancel)
                .expect("old absent preflight state")
                .state(),
            SocketTargetPreflightState::TargetAbsent
        );
        assert_eq!(
            target
                .runtime
                .preflight_sync(target.socket.clone(), &target.cancel)
                .expect("target absent preflight")
                .state(),
            SocketTargetPreflightState::TargetAbsent
        );
        old.runtime
            .ensure_server(&old_socket, &old.cancel, OperationDeadline::new(old.runtime.timeout))
            .expect("old owned server");
        let unknown = old
            .runtime
            .run_tmux(
                &old_socket,
                &[
                    "new-session".to_owned(),
                    "-d".to_owned(),
                    "-s".to_owned(),
                    "foreign".to_owned(),
                    "-c".to_owned(),
                    old.home.to_string_lossy().into_owned(),
                ],
                &old.home,
                &old.cancel,
                OperationDeadline::new(old.runtime.timeout),
            )
            .expect("unknown session");
        assert!(unknown.status.success());
        assert_eq!(
            old.runtime
                .preflight_sync(old_socket.clone(), &old.cancel)
                .expect("old marked preflight")
                .state(),
            SocketTargetPreflightState::MarkedSessions
        );
        let inventory = old
            .runtime
            .inspect_owned_sessions_sync(&old_socket, &old.cancel)
            .expect("old inventory");
        assert_eq!(
            inventory.sessions(),
            &[OwnedSessionRecord::Scratch { session_name: SCRATCH_SESSION.to_owned() }]
        );
        assert_eq!(inventory.unknown_session_count(), 1);
        old.runtime
            .close_owned_session_sync(
                &old_socket,
                &OwnedSessionRecord::Scratch { session_name: SCRATCH_SESSION.to_owned() },
                &old.cancel,
            )
            .expect("partial scratch cleanup");
        let remaining = old
            .runtime
            .list_sessions(&old_socket, &old.cancel, OperationDeadline::new(old.runtime.timeout))
            .expect("unknown remains");
        assert!(remaining.iter().any(|session| session.name == "foreign"));

        target
            .runtime
            .ensure_server(
                &target.socket,
                &target.cancel,
                OperationDeadline::new(target.runtime.timeout),
            )
            .expect("marked target");
        assert_eq!(
            target
                .runtime
                .preflight_sync(target.socket.clone(), &target.cancel)
                .expect("marked target preflight")
                .state(),
            SocketTargetPreflightState::MarkedSessions
        );
        wrong
            .runtime
            .run_tmux(
                &wrong.socket,
                &[
                    "new-session".to_owned(),
                    "-d".to_owned(),
                    "-s".to_owned(),
                    "foreign".to_owned(),
                    "-c".to_owned(),
                    wrong.home.to_string_lossy().into_owned(),
                ],
                &wrong.home,
                &wrong.cancel,
                OperationDeadline::new(wrong.runtime.timeout),
            )
            .expect("wrong-marker server");
        wrong
            .runtime
            .run_tmux(
                &wrong.socket,
                &[
                    "set-option".to_owned(),
                    "-g".to_owned(),
                    PROTOCOL_OPTION.to_owned(),
                    "999".to_owned(),
                ],
                &wrong.home,
                &wrong.cancel,
                OperationDeadline::new(wrong.runtime.timeout),
            )
            .expect("wrong marker");
        assert_eq!(
            wrong
                .runtime
                .preflight_sync(wrong.socket.clone(), &wrong.cancel)
                .expect("wrong marker preflight")
                .state(),
            SocketTargetPreflightState::WrongMarker
        );

        let tmux_path = [
            Path::new("/opt/homebrew/bin/tmux"),
            Path::new("/usr/local/bin/tmux"),
            Path::new("/usr/bin/tmux"),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .expect("tmux binary");
        let missing_socket = SocketName::new(format!(
            "dhmissing{}{}",
            std::process::id(),
            REAL_TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
        .expect("missing-marker socket");
        let missing_home = old.home.to_string_lossy().into_owned();
        let missing_setup = Command::new(tmux_path)
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .args([
                "-f",
                "/dev/null",
                "-L",
                missing_socket.as_str(),
                "new-session",
                "-d",
                "-s",
                "foreign",
                "-c",
                missing_home.as_str(),
            ])
            .output()
            .expect("missing-marker server");
        assert!(missing_setup.status.success());
        assert_eq!(
            old.runtime
                .preflight_sync(missing_socket.clone(), &old.cancel)
                .expect("missing marker preflight")
                .state(),
            SocketTargetPreflightState::WrongMarker
        );
        let _ = Command::new(tmux_path)
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .args(["-L", missing_socket.as_str(), "kill-server"])
            .status();

        let workspace_path = old.home.join("workspace");
        fs::create_dir(&workspace_path).expect("workspace directory");
        let workspace_root = WorkspaceRoot::new(fs::canonicalize(&workspace_path).expect("root"))
            .expect("workspace root");
        let workspace_id =
            WorkspaceId::from_uuid("00000000-0000-4000-8000-000000000051").expect("workspace id");
        old.runtime
            .ensure_server(&old_socket, &old.cancel, OperationDeadline::new(old.runtime.timeout))
            .expect("workspace preflight server");
        old.runtime
            .ensure_sync(
                &TerminalTarget::workspace(workspace_id.clone(), workspace_root.clone()),
                &old.cancel,
            )
            .expect("workspace recreation after partial cleanup");
        let inventory = old
            .runtime
            .inspect_owned_sessions_sync(&old_socket, &old.cancel)
            .expect("partial inventory");
        let workspace_session = inventory
            .sessions()
            .iter()
            .find(|session| matches!(session, OwnedSessionRecord::Workspace { .. }))
            .cloned()
            .expect("workspace record");
        old.runtime
            .close_owned_session_sync(&old_socket, &workspace_session, &old.cancel)
            .expect("workspace cleanup");
        old.runtime
            .close_owned_session_sync(
                &old_socket,
                &OwnedSessionRecord::Scratch { session_name: SCRATCH_SESSION.to_owned() },
                &old.cancel,
            )
            .expect("idempotent scratch cleanup");
        let inventory = old
            .runtime
            .inspect_owned_sessions_sync(&old_socket, &old.cancel)
            .expect("old exact inventory is empty");
        assert!(inventory.sessions().is_empty());
        assert_eq!(inventory.unknown_session_count(), 1);

        let rebound_socket = SocketName::new(format!(
            "dhrebind{}",
            REAL_TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
        .expect("rebind socket");
        old.runtime
            .ensure_server(
                &rebound_socket,
                &old.cancel,
                OperationDeadline::new(old.runtime.timeout),
            )
            .expect("new effective server");
        old.runtime.set_effective_socket(rebound_socket.clone()).expect("dynamic effective socket");
        old.runtime
            .ensure_sync(&TerminalTarget::scratch(), &old.cancel)
            .expect("ordinary runtime follows rebind");
        assert!(old
            .runtime
            .list_sessions(
                &rebound_socket,
                &old.cancel,
                OperationDeadline::new(old.runtime.timeout)
            )
            .expect("rebound sessions")
            .iter()
            .any(|session| session.name == SCRATCH_SESSION));
        let _ = old.runtime.run_tmux(
            &rebound_socket,
            &["kill-server".to_owned()],
            &old.home,
            &old.cancel,
            OperationDeadline::new(old.runtime.timeout),
        );
    }

    #[test]
    fn root_metadata_is_bounded_and_unambiguous() {
        let first = "/tmp/a\nb";
        let second = "/tmp/ab";
        assert_ne!(first, second);
        assert!(is_root_metadata(first));
        let info = SessionInfo {
            name: "workspace".to_owned(),
            context: Some(GLOBAL_CONTEXT.to_owned()),
            workspace_id: Some(GLOBAL_ID.to_owned()),
            root: Some(first.to_owned()),
        };
        assert!(info.matches(GLOBAL_CONTEXT, GLOBAL_ID, Path::new(first)));
        assert!(!is_root_metadata("hex:2f746d70"));
    }

    #[test]
    fn tmux_37b_uses_an_isolated_socket_and_marks_only_scratch() {
        if std::env::var_os("CODEX_SANDBOX").is_some_and(|value| value == "seatbelt") {
            // The desktop seatbelt disallows creating a fresh Unix socket;
            // the same test runs on the macOS host/CI lane where tmux can
            // create its dedicated -L server.
            return;
        }
        let tmux_path = [
            Path::new("/opt/homebrew/bin/tmux"),
            Path::new("/usr/local/bin/tmux"),
            Path::new("/usr/bin/tmux"),
        ]
        .into_iter()
        .find(|path| path.is_file());
        let Some(tmux_path) = tmux_path else {
            // The native MVP is macOS-only; non-macOS check environments may
            // not provide tmux and should still exercise the pure seam tests.
            return;
        };
        let suffix = format!("{}-{}", std::process::id(), Instant::now().elapsed().as_nanos());
        let home = std::env::temp_dir().join(format!("devhub-tmux-{suffix}-quote\"\nline"));
        std::fs::create_dir(&home).expect("temporary tmux home");
        let xdg_config = home.join("xdg").join("tmux");
        std::fs::create_dir_all(&xdg_config).expect("temporary xdg config");
        let home_config = "set-option -g @devhub-test-user-config home\n";
        std::fs::write(home.join(".tmux.conf"), home_config).expect("home tmux config");
        std::fs::write(
            xdg_config.join("tmux.conf"),
            "set-option -g @devhub-test-user-config xdg\n",
        )
        .expect("xdg tmux config");
        let socket =
            SocketName::new(format!("devhubtest{}", std::process::id())).expect("socket name");
        let mut environment = std::env::vars_os().collect::<std::collections::BTreeMap<_, _>>();
        environment.insert("XDG_CONFIG_HOME".into(), home.join("xdg").into_os_string());
        let context = RuntimeLaunchContext::new(&home, environment).expect("launch context");
        let shell = std::env::var("SHELL").ok().and_then(|shell| context.resolve(&shell).ok());
        let runtime = TmuxTerminalRuntime::new(
            context,
            Some(ResolvedExecutable::for_test(tmux_path)),
            shell,
            Vec::new(),
            socket.as_str(),
        )
        .with_timeout(Duration::from_secs(5));
        let operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000041",
        )
        .expect("operation id");
        let cancel = CancellationToken::new(operation);
        let cleanup =
            TmuxServerGuard { runtime: &runtime, socket: socket.clone(), cancel: cancel.clone() };

        runtime
            .ensure_version(&socket, &cancel, OperationDeadline::new(runtime.timeout))
            .expect("tmux version");
        runtime
            .ensure_server(&socket, &cancel, OperationDeadline::new(runtime.timeout))
            .expect("isolated server");
        let preflight = runtime.preflight_sync(socket.clone(), &cancel).expect("socket preflight");
        assert_eq!(preflight.state(), SocketTargetPreflightState::MarkedSessions);
        assert_eq!(preflight.owned_session_count(), 1);
        assert_eq!(preflight.unknown_session_count(), 0);
        let sessions = runtime
            .list_sessions(&socket, &cancel, OperationDeadline::new(runtime.timeout))
            .expect("sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, SCRATCH_SESSION);
        assert!(sessions[0].is_marked(&home));
        assert_eq!(sessions[0].context.as_deref(), Some(GLOBAL_CONTEXT));
        let user_config = runtime
            .run_tmux(
                &socket,
                &[
                    "show-options".to_owned(),
                    "-gqv".to_owned(),
                    "@devhub-test-user-config".to_owned(),
                ],
                &home,
                &cancel,
                OperationDeadline::new(runtime.timeout),
            )
            .expect("user config read-back");
        assert_eq!(user_config.stdout, b"home\n");

        // An owned server with a missing Scratch session may safely recreate
        // the exact global target; marker-only ownership is never enough.
        let removed_scratch = runtime
            .run_tmux(
                &socket,
                &["kill-session".to_owned(), "-t".to_owned(), SCRATCH_SESSION.to_owned()],
                &home,
                &cancel,
                OperationDeadline::new(runtime.timeout),
            )
            .expect("remove scratch for recovery test");
        assert!(removed_scratch.status.success());
        runtime
            .ensure_server(&socket, &cancel, OperationDeadline::new(runtime.timeout))
            .expect("recreate missing scratch");
        let sessions = runtime
            .list_sessions(&socket, &cancel, OperationDeadline::new(runtime.timeout))
            .expect("recreated scratch");
        assert!(sessions.iter().any(|session| session.is_marked(&home)));

        let workspace_path = home.join("workspace");
        std::fs::create_dir(&workspace_path).expect("workspace directory");
        let canonical_workspace_path =
            std::fs::canonicalize(&workspace_path).expect("canonical workspace");
        let workspace_root = WorkspaceRoot::new(&canonical_workspace_path).expect("workspace root");
        let workspace_id =
            WorkspaceId::from_uuid("00000000-0000-4000-8000-000000000042").expect("workspace id");
        let workspace_target =
            WorkspaceTerminalTarget::new(workspace_id.clone(), workspace_root.clone());
        runtime
            .ensure_sync(
                &TerminalTarget::workspace(workspace_id.clone(), workspace_root.clone()),
                &cancel,
            )
            .expect("workspace terminal");
        let sessions = runtime
            .list_sessions(&socket, &cancel, OperationDeadline::new(runtime.timeout))
            .expect("workspace session");
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().any(|session| {
            session.matches(WORKSPACE_CONTEXT, workspace_id.as_str(), &canonical_workspace_path)
        }));
        runtime.close_workspace_target(&workspace_target, &cancel).expect("workspace close");
        let sessions = runtime
            .list_sessions(&socket, &cancel, OperationDeadline::new(runtime.timeout))
            .expect("remaining scratch session");
        assert_eq!(sessions.len(), 1);

        // A trusted user config can create a foreign Scratch before DevHub's
        // ownership transaction.  The single bootstrap command sequence must
        // stop at the duplicate new-session error, leaving all foreign
        // metadata untouched and never committing the global marker.
        let foreign_config = concat!(
            "new-session -d -s scratch -c \"$DEVHUB_BOOTSTRAP_ROOT\"\n",
            "set-option -t scratch @devhub-context foreign\n",
            "set-option -t scratch @devhub-workspace-id foreign\n",
            "set-option -t scratch @devhub-root /foreign\n",
        );
        std::fs::write(home.join(".tmux.conf"), foreign_config).expect("foreign tmux config");
        let foreign_socket =
            SocketName::new(format!("devhubforeign{}", std::process::id())).expect("socket name");
        let foreign_cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000047",
            )
            .expect("operation id"),
        );
        let foreign_runtime = TmuxTerminalRuntime::new(
            runtime.context.clone(),
            runtime.tmux.clone(),
            None,
            Vec::new(),
            foreign_socket.as_str(),
        )
        .with_timeout(Duration::from_secs(5));
        let foreign_guard = TmuxServerGuard {
            runtime: &foreign_runtime,
            socket: foreign_socket.clone(),
            cancel: foreign_cancel.clone(),
        };
        assert_eq!(
            foreign_runtime
                .ensure_sync(&TerminalTarget::scratch(), &foreign_cancel)
                .expect_err("foreign Scratch must not be claimed")
                .code(),
            PortErrorCode::Conflict
        );
        let foreign_sessions = foreign_runtime
            .list_sessions(
                &foreign_socket,
                &foreign_cancel,
                OperationDeadline::new(foreign_runtime.timeout),
            )
            .expect("foreign session remains inspectable");
        assert_eq!(foreign_sessions.len(), 1);
        assert!(!foreign_sessions[0].matches(GLOBAL_CONTEXT, GLOBAL_ID, &home));
        assert_eq!(foreign_sessions[0].name, SCRATCH_SESSION);
        assert_eq!(foreign_sessions[0].context.as_deref(), Some("foreign"));
        assert_eq!(foreign_sessions[0].workspace_id.as_deref(), Some("foreign"));
        assert_eq!(foreign_sessions[0].root.as_deref(), Some("/foreign"));
        let foreign_marker = foreign_runtime
            .run_tmux(
                &foreign_socket,
                &["show-options".to_owned(), "-gqv".to_owned(), PROTOCOL_OPTION.to_owned()],
                &home,
                &foreign_cancel,
                OperationDeadline::new(foreign_runtime.timeout),
            )
            .expect("foreign marker read-back");
        assert!(foreign_marker.status.success());
        assert_ne!(foreign_marker.stdout, b"1\n");
        drop(foreign_guard);
        std::fs::write(home.join(".tmux.conf"), home_config).expect("restore home config");

        // A server with a foreign marker is an opaque resource.  The
        // DevHub adapter must reject it without creating Scratch or touching
        // the existing foreign session.
        let wrong_socket =
            SocketName::new(format!("devhubwrong{}", std::process::id())).expect("socket name");
        let wrong_cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000044",
            )
            .expect("operation id"),
        );
        let wrong_runtime = TmuxTerminalRuntime::new(
            runtime.context.clone(),
            runtime.tmux.clone(),
            None,
            Vec::new(),
            wrong_socket.as_str(),
        )
        .with_timeout(Duration::from_secs(5));
        let wrong_guard = TmuxServerGuard {
            runtime: &wrong_runtime,
            socket: wrong_socket.clone(),
            cancel: wrong_cancel.clone(),
        };
        let setup = Command::new(tmux_path)
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .args(["-f", "/dev/null", "-L", wrong_socket.as_str()])
            .args(["new-session", "-d", "-s", "foreign", "-c"])
            .arg(&home)
            .output()
            .expect("foreign server");
        assert!(setup.status.success());
        let marker = Command::new(tmux_path)
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .args(["-f", "/dev/null", "-L", wrong_socket.as_str()])
            .args(["set-option", "-g", PROTOCOL_OPTION, "999"])
            .output()
            .expect("foreign marker");
        assert!(marker.status.success());
        assert_eq!(
            wrong_runtime
                .ensure_sync(&TerminalTarget::scratch(), &wrong_cancel)
                .expect_err("foreign marker must conflict")
                .code(),
            PortErrorCode::Conflict
        );
        let foreign_sessions = wrong_runtime
            .list_sessions(&wrong_socket, &wrong_cancel, OperationDeadline::new(runtime.timeout))
            .expect("foreign sessions");
        assert_eq!(foreign_sessions.len(), 1);
        assert_eq!(foreign_sessions[0].name, "foreign");
        assert_eq!(
            wrong_runtime
                .marker_state(
                    &wrong_socket,
                    &wrong_cancel,
                    OperationDeadline::new(runtime.timeout),
                )
                .expect("foreign marker state"),
            MarkerState::Wrong
        );
        drop(wrong_guard);

        drop(cleanup);
        std::fs::remove_dir(&workspace_path).expect("workspace directory removed");
        std::fs::remove_file(home.join(".tmux.conf")).expect("home config removed");
        std::fs::remove_dir_all(home.join("xdg")).expect("xdg config removed");
        std::fs::remove_dir(&home).expect("temporary tmux home removed");
    }

    fn decode_test_channel_frame(
        body: tauri::ipc::InvokeResponseBody,
    ) -> Option<(String, u64, Vec<u8>)> {
        let tauri::ipc::InvokeResponseBody::Raw(bytes) = body else {
            return None;
        };
        if bytes.len() < 8 {
            return None;
        }
        let header_len = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
        if 8 + header_len > bytes.len() {
            return None;
        }
        let header: serde_json::Value = serde_json::from_slice(&bytes[8..8 + header_len]).ok()?;
        let frame_type = header.get("type")?.as_str()?.to_owned();
        let sequence = header.get("sequence")?.as_u64()?;
        Some((frame_type, sequence, bytes[8 + header_len..].to_vec()))
    }

    fn terminal_identity<'a>(
        target: &'a TerminalTarget,
        surface_key: &'a str,
        attachment_id: &'a str,
        webview_label: &'a str,
        target_generation: u64,
    ) -> AttachmentIdentity<'a> {
        AttachmentIdentity { target, surface_key, attachment_id, webview_label, target_generation }
    }

    #[test]
    fn real_tmux_pty_roundtrip_resize_detach_and_replacement_preserve_session() {
        let Some(fixture) = real_tmux_fixture("pty") else {
            return;
        };
        let target = TerminalTarget::scratch();
        fixture.runtime.ensure_sync(&target, &fixture.cancel).expect("Scratch session");

        let (frame_sender, frame_receiver) = std::sync::mpsc::channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            let _ = frame_sender.send(body);
            Ok(())
        });
        let size = TerminalPtySize { cols: 80, rows: 24, pixel_width: 0, pixel_height: 0 };
        let receipt = fixture
            .runtime
            .attach_surface(
                &target,
                "global-terminal".to_owned(),
                "real-pty-window".to_owned(),
                size,
                channel,
                &fixture.cancel,
            )
            .expect("attach PTY client");
        let (frame_type, sequence, payload) = decode_test_channel_frame(
            frame_receiver.recv_timeout(Duration::from_secs(3)).expect("Started frame"),
        )
        .expect("raw Started frame");
        assert_eq!(frame_type, "started");
        assert_eq!(sequence, 0);
        assert!(payload.is_empty());

        fixture
            .runtime
            .terminal_input(
                terminal_identity(
                    &target,
                    "global-terminal",
                    &receipt.attachment_id,
                    "real-pty-window",
                    receipt.target_generation,
                ),
                1,
                b"printf 'DEVHUB_PTY_'$(printf 'ROUNDTRIP_OUTPUT')'\\n'\r",
            )
            .expect("write ordered input");
        let marker = b"DEVHUB_PTY_ROUNDTRIP_OUTPUT";
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_marker = false;
        while Instant::now() < deadline && !saw_marker {
            let body =
                frame_receiver.recv_timeout(Duration::from_millis(250)).expect("PTY output frame");
            let Some((frame_type, sequence, payload)) = decode_test_channel_frame(body) else {
                continue;
            };
            if frame_type == "output" {
                saw_marker |= payload.windows(marker.len()).any(|window| window == marker);
                fixture
                    .runtime
                    .terminal_acknowledge(
                        terminal_identity(
                            &target,
                            "global-terminal",
                            &receipt.attachment_id,
                            "real-pty-window",
                            receipt.target_generation,
                        ),
                        sequence,
                    )
                    .expect("cumulative output ACK");
            }
            if frame_type == "error" {
                break;
            }
        }
        assert!(saw_marker, "the attached tmux pane must echo the input marker");

        fixture
            .runtime
            .terminal_resize(
                terminal_identity(
                    &target,
                    "global-terminal",
                    &receipt.attachment_id,
                    "real-pty-window",
                    receipt.target_generation,
                ),
                TerminalPtySize { cols: 100, rows: 30, pixel_width: 0, pixel_height: 0 },
                &fixture.cancel,
            )
            .expect("queue PTY resize");
        let resize_deadline = Instant::now() + Duration::from_secs(3);
        let mut resized = false;
        while Instant::now() < resize_deadline {
            let pane = fixture
                .runtime
                .run_tmux(
                    &fixture.socket,
                    &[
                        "display-message".to_owned(),
                        "-p".to_owned(),
                        "-t".to_owned(),
                        "scratch:0.0".to_owned(),
                        "#{pane_width}x#{pane_height}".to_owned(),
                    ],
                    &fixture.home,
                    &fixture.cancel,
                    OperationDeadline::new(fixture.runtime.timeout),
                )
                .expect("inspect tmux pane dimensions");
            resized = pane.stdout.windows(b"100x30".len()).any(|window| window == b"100x30");
            if resized {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(resized, "the exact owned tmux pane must observe the requested geometry");
        thread::sleep(Duration::from_millis(250));

        fixture
            .runtime
            .terminal_input(
                terminal_identity(
                    &target,
                    "global-terminal",
                    &receipt.attachment_id,
                    "real-pty-window",
                    receipt.target_generation,
                ),
                2,
                b"printf 'DEVHUB_PTY_'$(printf 'SIZE_OUTPUT')':'; stty size; printf '\\n'\r",
            )
            .expect("query resized PTY dimensions");
        let size_deadline = Instant::now() + Duration::from_secs(3);
        let mut size_output = Vec::new();
        let mut saw_size = false;
        while Instant::now() < size_deadline && !saw_size {
            let body = frame_receiver
                .recv_timeout(Duration::from_millis(250))
                .expect("resized PTY output frame");
            let Some((frame_type, sequence, payload)) = decode_test_channel_frame(body) else {
                continue;
            };
            if frame_type == "output" {
                size_output.extend_from_slice(&payload);
                saw_size = size_output
                    .windows(b"DEVHUB_PTY_SIZE_OUTPUT:".len())
                    .any(|window| window == b"DEVHUB_PTY_SIZE_OUTPUT:")
                    && size_output.windows(b"30 100".len()).any(|window| window == b"30 100");
                fixture
                    .runtime
                    .terminal_acknowledge(
                        terminal_identity(
                            &target,
                            "global-terminal",
                            &receipt.attachment_id,
                            "real-pty-window",
                            receipt.target_generation,
                        ),
                        sequence,
                    )
                    .expect("ACK resized output");
            }
        }
        assert!(saw_size, "the attached shell must observe the requested PTY rows and columns");

        fixture
            .runtime
            .detach_surface(
                "global-terminal",
                &receipt.attachment_id,
                "real-pty-window",
                receipt.target_generation,
            )
            .expect("detach PTY client");
        assert_eq!(fixture.runtime.attachments.count(), 0);
        assert!(fixture
            .runtime
            .list_sessions(
                &fixture.socket,
                &fixture.cancel,
                OperationDeadline::new(fixture.runtime.timeout),
            )
            .expect("session survives PTY detach")
            .iter()
            .any(|session| session.name == SCRATCH_SESSION && session.is_marked(&fixture.home)));

        // Repeated attach replaces the old view only.  The stale receipt is
        // rejected by identity/generation, while the new client remains
        // usable and the tmux owner is untouched.
        let replacement_channel = tauri::ipc::Channel::new(|_| Ok(()));
        let replacement = fixture
            .runtime
            .attach_surface(
                &target,
                "global-terminal".to_owned(),
                "real-pty-window".to_owned(),
                size,
                replacement_channel,
                &fixture.cancel,
            )
            .expect("replacement attach");
        let latest_channel = tauri::ipc::Channel::new(|_| Ok(()));
        let latest = fixture
            .runtime
            .attach_surface(
                &target,
                "global-terminal".to_owned(),
                "real-pty-window".to_owned(),
                size,
                latest_channel,
                &fixture.cancel,
            )
            .expect("second replacement attach");
        assert_ne!(replacement.attachment_id, latest.attachment_id);
        assert!(matches!(
            fixture.runtime.terminal_input(
                terminal_identity(
                    &target,
                    "global-terminal",
                    &replacement.attachment_id,
                    "real-pty-window",
                    replacement.target_generation,
                ),
                1,
                b"stale\r",
            ),
            Err(error) if error.code() == TerminalErrorCode::WrongAttachment
        ));
        fixture
            .runtime
            .detach_surface(
                "global-terminal",
                &latest.attachment_id,
                "real-pty-window",
                latest.target_generation,
            )
            .expect("detach replacement");
        assert_eq!(fixture.runtime.attachments.count(), 0);
    }
}
