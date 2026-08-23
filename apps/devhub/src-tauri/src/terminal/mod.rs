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
use std::sync::{Arc, Mutex};
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
    SocketTargetPreflightState, TerminalInspection, TerminalPreflight, TerminalResult,
    TerminalRuntime, TerminalTarget, WorkspaceTerminalTarget,
};
use devhub_app_core::{DiagnosticCode, ResourceInspection, WorkspaceId};

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

/// A startup-frozen tmux adapter.  A missing executable is represented by
/// `None` and is a runtime health failure, not a process-start failure.
#[derive(Clone)]
pub(crate) struct TmuxTerminalRuntime {
    context: RuntimeLaunchContext,
    tmux: Option<ResolvedExecutable>,
    shell_name: Option<String>,
    tmux_args: Vec<String>,
    effective_socket: Option<SocketName>,
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
            effective_socket: SocketName::new(effective_socket_name).ok(),
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

    fn socket(&self) -> Result<&SocketName, PortError> {
        self.effective_socket.as_ref().ok_or_else(|| PortError::new(PortErrorCode::Failed))
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
        let socket = self.socket()?.clone();
        let deadline = OperationDeadline::new(self.timeout);
        self.ensure_version(&socket, cancel, deadline)?;
        self.ensure_server(&socket, cancel, deadline)?;
        let sessions = self.list_sessions(&socket, cancel, deadline)?;
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
        self.create_session(&socket, &spec, cancel, deadline)?;
        Ok(TerminalResult::new(target.clone()))
    }

    fn inspect_sync(
        &self,
        target: &TerminalTarget,
        cancel: &CancellationToken,
    ) -> Result<TerminalInspection, PortError> {
        let socket = match self.socket() {
            Ok(socket) => socket.clone(),
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
        let socket = self.socket()?.clone();
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
            return Err(PortError::new(PortErrorCode::Failed));
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
        if self.marker_state(socket, cancel, deadline)? != MarkerState::Owned {
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
        if self.marker_state(socket, cancel, deadline)? != MarkerState::Owned {
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
            .field("effective_socket", &self.effective_socket)
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
        spawn_operation(cancel, move || runtime.ensure_sync(&target, &worker_cancel))
    }

    fn inspect(
        &self,
        target: TerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<TerminalInspection> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || runtime.inspect_sync(&target, &worker_cancel))
    }

    fn close_workspace(
        &self,
        target: WorkspaceTerminalTarget,
        cancel: CancellationToken,
    ) -> PortFuture<()> {
        let runtime = self.clone();
        let worker_cancel = cancel.clone();
        spawn_operation(cancel, move || runtime.close_sync(&target, &worker_cancel))
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
mod tests {
    use super::*;
    use devhub_app_core::{WorkspaceId, WorkspaceRoot};

    fn root() -> WorkspaceRoot {
        WorkspaceRoot::new("/tmp/devhub-terminal-test").expect("root")
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
        runtime.close_sync(&workspace_target, &cancel).expect("workspace close");
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
}
