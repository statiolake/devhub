//! Trusted launch context for native child processes.
//!
//! Runtime configuration is deliberately split into two stages.  The
//! [`RuntimeLaunchContext`] is built once from an injected environment and a
//! trusted home directory.  A configured executable is then resolved against
//! that context and represented by [`ResolvedExecutable`].  Neither value
//! exposes environment contents or host paths through its public API or
//! `Debug` implementation.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::process::Output;

#[cfg(unix)]
use nix::sys::signal::{kill, Signal};
#[cfg(unix)]
use nix::unistd::Pid;
#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

const LOGIN_SHELL_SCRIPT: &str = "printf '\\0DEVHUB_STARTUP_ENV\\0'; exec /usr/bin/env -0";
const STARTUP_ENV_SENTINEL: &[u8] = b"\0DEVHUB_STARTUP_ENV\0";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_STDOUT_LIMIT: usize = 1024 * 1024;
const STARTUP_STDERR_LIMIT: usize = 64 * 1024;
const READER_JOIN_GRACE: Duration = Duration::from_millis(250);
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// The local, content-free failure categories emitted by runtime resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum RuntimeErrorCode {
    InvalidHome,
    InvalidEnvironmentKey,
    InvalidEnvironmentValue,
    InvalidExecutable,
    MissingPath,
    MissingExecutable,
    NotRegularFile,
    NotExecutable,
    CanonicalizationFailed,
    ShellUnavailable,
    ShellTimedOut,
    ShellOutputLimit,
    InvalidEnvironmentCapture,
}

/// Safe health state for the one-time login-environment import.
///
/// The failed variant contains only a stable local error code.  The shell
/// path, output, and environment values never cross this seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum LoginEnvironmentStatus {
    Ambient,
    Imported,
    Failed(RuntimeErrorCode),
}

/// A runtime failure that is safe to pass to diagnostics.
///
/// Raw environment values, executable strings, and filesystem paths are kept
/// out of this type so formatting an error cannot disclose user data.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct RuntimeError {
    code: RuntimeErrorCode,
}

impl RuntimeError {
    const fn new(code: RuntimeErrorCode) -> Self {
        Self { code }
    }

    pub(crate) const fn code(self) -> RuntimeErrorCode {
        self.code
    }
}

impl fmt::Debug for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("RuntimeError").field("code", &self.code).finish()
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "runtime operation failed ({:?})", self.code)
    }
}

impl std::error::Error for RuntimeError {}

/// Whether an executable came from an explicit path or a PATH lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ResolutionMode {
    ExplicitPath,
    PathLookup,
}

/// A validated executable selected by a [`RuntimeLaunchContext`].
///
/// The canonical path is private on purpose.  Callers can use it only by
/// asking the owning context for a preconfigured [`Command`].
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ResolvedExecutable {
    path: PathBuf,
    mode: ResolutionMode,
}

impl ResolvedExecutable {
    pub(crate) fn basename(&self) -> Option<&str> {
        self.path.file_name().and_then(|name| name.to_str())
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(test)]
    pub(crate) const fn mode(&self) -> ResolutionMode {
        self.mode
    }

    #[cfg(test)]
    pub(crate) fn for_test(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), mode: ResolutionMode::ExplicitPath }
    }
}

impl fmt::Debug for ResolvedExecutable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedExecutable")
            .field("path", &"<redacted>")
            .field("mode", &self.mode)
            .finish()
    }
}

/// An immutable, redacted environment used for all native child launches.
///
/// The environment is injected rather than read from the ambient process. It
/// therefore gives the application one auditable launch boundary and makes
/// runtime resolution deterministic in tests and in production.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct RuntimeLaunchContext {
    home: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    login_environment_status: LoginEnvironmentStatus,
}

impl RuntimeLaunchContext {
    /// Creates a context from a trusted home directory and an injected
    /// environment.  The map is validated and then owned immutably.
    pub(crate) fn new(
        home: impl Into<PathBuf>,
        environment: BTreeMap<OsString, OsString>,
    ) -> Result<Self, RuntimeError> {
        let home = home.into();
        if !home.is_absolute() || !home.is_dir() {
            return Err(RuntimeError::new(RuntimeErrorCode::InvalidHome));
        }
        validate_environment(&environment)?;
        Ok(Self { home, environment, login_environment_status: LoginEnvironmentStatus::Ambient })
    }

    /// Builds the launch context from the native process environment.
    ///
    /// When login import is disabled, the current environment is copied and
    /// validated without resolving or launching the configured shell.  When
    /// enabled, the shell is resolved against that ambient environment and is
    /// invoked once with the fixed login probe below.  No configured value is
    /// interpolated into the probe command.
    pub(crate) fn from_startup(
        home: impl Into<PathBuf>,
        import_login_environment: bool,
        configured_shell: &str,
    ) -> Result<Self, RuntimeError> {
        let home = home.into();
        let ambient_environment: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
        let ambient = Self::new(home.clone(), ambient_environment)?;
        if !import_login_environment {
            return Ok(ambient);
        }

        let shell = match ambient.resolve(configured_shell) {
            Ok(shell) => shell,
            Err(error) => return Ok(ambient.failed_import(error.code())),
        };
        let environment = match ambient.run_login_shell(&shell) {
            Ok(environment) => environment,
            Err(error) => return Ok(ambient.failed_import(error.code())),
        };
        match Self::new(home, environment) {
            Ok(mut imported) => {
                imported.login_environment_status = LoginEnvironmentStatus::Imported;
                Ok(imported)
            }
            Err(error) => Ok(ambient.failed_import(error.code())),
        }
    }

    fn failed_import(mut self, code: RuntimeErrorCode) -> Self {
        self.login_environment_status = LoginEnvironmentStatus::Failed(code);
        self
    }

    pub(crate) fn login_environment_status(&self) -> LoginEnvironmentStatus {
        self.login_environment_status
    }

    /// Performs a bounded, fresh login-shell probe for Settings recheck. The
    /// startup status remains immutable; this method is deliberately read-only
    /// and returns only a boolean health fact.
    pub(crate) fn recheck_login_shell(&self, configured_shell: &str) -> bool {
        let Ok(shell) = self.resolve(configured_shell) else { return false };
        self.run_login_shell(&shell).is_ok()
    }

    /// Runs a bounded direct executable probe without consulting a shell or
    /// exposing child output. This is used by Settings recheck for git and
    /// other configured command adapters.
    pub(crate) fn recheck_command(&self, configured: &str, argument: &str) -> bool {
        let Ok(executable) = self.resolve(configured) else { return false };
        let mut command = self.command(&executable);
        command
            .arg(argument)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let Ok(mut child) = command.spawn() else { return false };
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(None) | Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }
    }

    /// Resolves an absolute path, a leading-`~` path, or a command name.
    ///
    /// Relative paths containing a separator are never interpreted relative
    /// to the current process.  Command names are searched only in absolute
    /// PATH entries; empty and relative entries are ignored.
    pub(crate) fn resolve(&self, configured: &str) -> Result<ResolvedExecutable, RuntimeError> {
        if configured.is_empty() || configured.contains('\0') {
            return Err(RuntimeError::new(RuntimeErrorCode::InvalidExecutable));
        }

        if let Some(expanded) = expand_leading_tilde(configured, &self.home) {
            return self.resolve_path(&expanded, ResolutionMode::ExplicitPath);
        }

        if configured.starts_with('/') {
            return self.resolve_path(Path::new(configured), ResolutionMode::ExplicitPath);
        }

        if configured.contains('/') {
            return Err(RuntimeError::new(RuntimeErrorCode::InvalidExecutable));
        }

        let Some(path) = self.environment.get(OsStr::new("PATH")) else {
            return Err(RuntimeError::new(RuntimeErrorCode::MissingPath));
        };
        let mut saw_non_executable = false;
        let mut saw_non_regular = false;
        for entry in std::env::split_paths(path) {
            if entry.as_os_str().is_empty() || !entry.is_absolute() {
                continue;
            }
            let candidate = entry.join(configured);
            match self.inspect_path(&candidate, ResolutionMode::PathLookup) {
                Ok(resolved) => return Ok(resolved),
                Err(error) => match error.code() {
                    RuntimeErrorCode::MissingExecutable => {}
                    RuntimeErrorCode::NotExecutable => saw_non_executable = true,
                    RuntimeErrorCode::NotRegularFile => saw_non_regular = true,
                    _ => return Err(error),
                },
            }
        }
        if saw_non_executable {
            return Err(RuntimeError::new(RuntimeErrorCode::NotExecutable));
        }
        if saw_non_regular {
            return Err(RuntimeError::new(RuntimeErrorCode::NotRegularFile));
        }
        Err(RuntimeError::new(RuntimeErrorCode::MissingExecutable))
    }

    /// Returns a direct, shell-free command with the launch environment
    /// applied.  The caller may append fixed arguments before spawning it.
    pub(crate) fn command(&self, executable: &ResolvedExecutable) -> Command {
        let mut command = Command::new(&executable.path);
        self.apply_to_command(&mut command);
        #[cfg(unix)]
        command.process_group(0);
        command
    }

    pub(crate) fn home(&self) -> &Path {
        &self.home
    }

    pub(crate) fn environment_value(&self, name: &str) -> Option<&OsStr> {
        self.environment.get(OsStr::new(name)).map(OsString::as_os_str)
    }

    /// The PTY adapter uses the same startup-frozen environment as every
    /// other native child. Values stay inside the child command and never
    /// cross a product wire contract or diagnostic surface.
    pub(crate) fn environment_entries(&self) -> impl Iterator<Item = (&OsString, &OsString)> {
        self.environment.iter()
    }

    /// Applies the same current directory and isolated environment to an
    /// already-created direct command.  This does not invoke a shell.
    pub(crate) fn apply_to_command(&self, command: &mut Command) {
        command.current_dir(&self.home).env_clear().envs(&self.environment);
    }

    fn run_login_shell(
        &self,
        shell: &ResolvedExecutable,
    ) -> Result<BTreeMap<OsString, OsString>, RuntimeError> {
        run_login_shell_with_limits(
            self,
            shell,
            STARTUP_TIMEOUT,
            STARTUP_STDOUT_LIMIT,
            STARTUP_STDERR_LIMIT,
        )
    }

    /// Test-only convenience for proving that `command` carries the injected
    /// environment.  It remains private to this module's implementation.
    #[cfg(test)]
    fn output(&self, executable: &ResolvedExecutable, args: &[&str]) -> Output {
        self.command(executable).args(args).output().expect("test command")
    }

    fn resolve_path(
        &self,
        path: &Path,
        mode: ResolutionMode,
    ) -> Result<ResolvedExecutable, RuntimeError> {
        self.inspect_path(path, mode)
    }

    fn inspect_path(
        &self,
        path: &Path,
        mode: ResolutionMode,
    ) -> Result<ResolvedExecutable, RuntimeError> {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(RuntimeError::new(RuntimeErrorCode::MissingExecutable));
            }
            Err(_) => return Err(RuntimeError::new(RuntimeErrorCode::CanonicalizationFailed)),
        };
        if !metadata.is_file() {
            return Err(RuntimeError::new(RuntimeErrorCode::NotRegularFile));
        }
        if !is_executable(&metadata) {
            return Err(RuntimeError::new(RuntimeErrorCode::NotExecutable));
        }
        let path = fs::canonicalize(path)
            .map_err(|_| RuntimeError::new(RuntimeErrorCode::CanonicalizationFailed))?;
        Ok(ResolvedExecutable { path, mode })
    }
}

impl fmt::Debug for RuntimeLaunchContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeLaunchContext")
            .field("home", &"<redacted>")
            .field("environment_entries", &self.environment.len())
            .field("has_path", &self.environment.contains_key(OsStr::new("PATH")))
            .field("login_environment_status", &self.login_environment_status)
            .finish()
    }
}

fn run_login_shell_with_limits(
    context: &RuntimeLaunchContext,
    shell: &ResolvedExecutable,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<BTreeMap<OsString, OsString>, RuntimeError> {
    let mut command = context.command(shell);
    command
        .args(["-l", "-c", LOGIN_SHELL_SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child =
        command.spawn().map_err(|_| RuntimeError::new(RuntimeErrorCode::ShellUnavailable))?;
    let process_id = child.id();
    let mut cleanup = ChildCleanup::new(process_id);
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            cleanup.terminate(&mut child);
            return Err(RuntimeError::new(RuntimeErrorCode::ShellUnavailable));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            cleanup.terminate(&mut child);
            return Err(RuntimeError::new(RuntimeErrorCode::ShellUnavailable));
        }
    };

    let stdout_limit_hit = Arc::new(AtomicBool::new(false));
    let stderr_limit_hit = Arc::new(AtomicBool::new(false));
    let reader_failed = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_capture_reader(
        stdout,
        stdout_limit,
        true,
        Arc::clone(&stdout_limit_hit),
        Arc::clone(&reader_failed),
    )
    .map_err(|_| {
        cleanup.terminate(&mut child);
        RuntimeError::new(RuntimeErrorCode::ShellUnavailable)
    })?;
    let stderr_reader = match spawn_capture_reader(
        stderr,
        stderr_limit,
        false,
        Arc::clone(&stderr_limit_hit),
        Arc::clone(&reader_failed),
    ) {
        Ok(reader) => reader,
        Err(_) => {
            cleanup.terminate(&mut child);
            let _ = join_reader_bounded(stdout_reader, Instant::now() + READER_JOIN_GRACE);
            return Err(RuntimeError::new(RuntimeErrorCode::ShellUnavailable));
        }
    };

    let deadline = Instant::now() + timeout;
    let mut terminal_error = None;
    let status = loop {
        if stdout_limit_hit.load(Ordering::Acquire) || stderr_limit_hit.load(Ordering::Acquire) {
            terminal_error = Some(RuntimeErrorCode::ShellOutputLimit);
            cleanup.terminate(&mut child);
            break None;
        }
        if reader_failed.load(Ordering::Acquire) {
            terminal_error = Some(RuntimeErrorCode::InvalidEnvironmentCapture);
            cleanup.terminate(&mut child);
            break None;
        }
        if Instant::now() >= deadline {
            terminal_error = Some(RuntimeErrorCode::ShellTimedOut);
            cleanup.terminate(&mut child);
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(_) => {
                terminal_error = Some(RuntimeErrorCode::ShellUnavailable);
                cleanup.terminate(&mut child);
                break None;
            }
        }
    };

    let reader_deadline = Instant::now() + READER_JOIN_GRACE;
    while (!stdout_reader.is_finished() || !stderr_reader.is_finished())
        && Instant::now() < reader_deadline
    {
        thread::sleep(POLL_INTERVAL);
    }
    if !stdout_reader.is_finished() || !stderr_reader.is_finished() {
        // A descendant can keep a pipe open after the shell itself exits.  The
        // shell owns a private process group, so clean that group before the
        // final bounded join rather than waiting forever on the pipe.
        cleanup.terminate(&mut child);
    }
    let stdout_result = join_reader_bounded(stdout_reader, Instant::now() + READER_JOIN_GRACE);
    let stderr_result = join_reader_bounded(stderr_reader, Instant::now() + READER_JOIN_GRACE);

    if let Some(code) = observed_terminal_error(
        terminal_error,
        stdout_limit_hit.load(Ordering::Acquire),
        stderr_limit_hit.load(Ordering::Acquire),
        reader_failed.load(Ordering::Acquire),
    ) {
        return Err(RuntimeError::new(code));
    }
    if stderr_result.is_none() {
        return Err(RuntimeError::new(RuntimeErrorCode::InvalidEnvironmentCapture));
    }
    let Some(stdout) = stdout_result else {
        return Err(RuntimeError::new(RuntimeErrorCode::InvalidEnvironmentCapture));
    };
    let Some(status) = status else {
        return Err(RuntimeError::new(RuntimeErrorCode::ShellUnavailable));
    };
    if !status.success() {
        return Err(RuntimeError::new(RuntimeErrorCode::ShellUnavailable));
    }

    parse_captured_environment(&stdout.bytes)
}

fn observed_terminal_error(
    terminal_error: Option<RuntimeErrorCode>,
    stdout_limit_hit: bool,
    stderr_limit_hit: bool,
    reader_failed: bool,
) -> Option<RuntimeErrorCode> {
    // Reader threads can observe a limit or I/O failure while the bounded
    // post-termination join is draining their pipes. Those observations are
    // stronger than a wall-clock timeout selected before the join.
    if stdout_limit_hit || stderr_limit_hit {
        Some(RuntimeErrorCode::ShellOutputLimit)
    } else if reader_failed {
        Some(RuntimeErrorCode::InvalidEnvironmentCapture)
    } else {
        terminal_error
    }
}

struct CaptureReaderOutput {
    bytes: Vec<u8>,
}

#[derive(Default)]
struct CleanupState {
    terminated: bool,
}

impl CleanupState {
    fn begin(&mut self) -> bool {
        if self.terminated {
            return false;
        }
        self.terminated = true;
        true
    }
}

/// Owns the one allowed process-group termination for one spawned child.
///
/// Provider adapters can borrow this guard while they drain bounded pipes;
/// after the child is reaped, a later reader timeout cannot signal the same
/// numeric process-group ID again.
pub(crate) struct ChildCleanup {
    process_id: u32,
    state: CleanupState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShutdownSignal {
    /// Ctrl+C semantics, for a provider owner that is a shell wrapper and
    /// forwards the signal to the process actually doing the work. Nothing
    /// spawns one now that the Editor runs a server binary directly; the path
    /// is kept, and tested, because a provider that needs it may return.
    #[allow(dead_code)]
    Interrupt,
    Terminate,
}

impl ChildCleanup {
    pub(crate) fn new(process_id: u32) -> Self {
        Self { process_id, state: CleanupState::default() }
    }

    pub(crate) fn terminate(&mut self, child: &mut Child) {
        if self.state.begin() {
            terminate_and_reap(child, self.process_id);
        }
    }

    /// Terminates the owned process group and polls the leader only until the
    /// supplied lifecycle deadline. A caller that receives `false` may move
    /// the Child to a bounded app-local reaper instead of blocking quit on
    /// `Child::wait`.
    /// Lets a foreground provider owner forward TERM to detached workers
    /// before the owned process group is escalated.
    pub(crate) fn terminate_until_with_grace(
        &mut self,
        child: &mut Child,
        deadline: Instant,
        termination_grace: Duration,
        shutdown_signal: ShutdownSignal,
    ) -> bool {
        if self.state.begin() {
            #[cfg(unix)]
            match shutdown_signal {
                ShutdownSignal::Interrupt => {
                    // Ctrl+C is a foreground-process-group contract. The
                    // official `code` entry point can be a shell wrapper whose
                    // child Rust CLI owns the signal receiver, so signalling
                    // only the wrapper PID or treating wrapper exit as success
                    // orphans the actual serve-web runtime.
                    send_process_group_signal(self.process_id, Signal::SIGINT);
                    let now = Instant::now();
                    let grace_deadline =
                        now + termination_grace.min(deadline.saturating_duration_since(now));
                    loop {
                        let leader = child.try_wait();
                        let leader_reaped = matches!(leader, Ok(Some(_)));
                        if leader_reaped && !process_group_is_alive(self.process_id) {
                            return true;
                        }
                        if Instant::now() >= grace_deadline {
                            break;
                        }
                        thread::sleep(POLL_INTERVAL);
                    }
                    // The PGID is the exact private group created at spawn,
                    // not a process-name match. Escalating this same owned
                    // boundary reaches a wrapper child without touching any
                    // ambient VS Code or user process.
                    if process_group_is_alive(self.process_id) {
                        send_process_group_signal(self.process_id, Signal::SIGKILL);
                    }
                    loop {
                        let leader_reaped = matches!(child.try_wait(), Ok(Some(_)));
                        if leader_reaped && !process_group_is_alive(self.process_id) {
                            return true;
                        }
                        if Instant::now() >= deadline {
                            return false;
                        }
                        thread::sleep(POLL_INTERVAL);
                    }
                }
                ShutdownSignal::Terminate => {
                    terminate_process_group_until(self.process_id, deadline, termination_grace);
                }
            }
            #[cfg(not(unix))]
            let _ = child.kill();
        }
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(POLL_INTERVAL);
                }
                Ok(None) => return false,
                Err(_) => return false,
            }
        }
    }

    /// Records that the leader has already been reaped.  This prevents a
    /// later bounded-pipe cleanup from signalling a potentially reused
    /// process-group identifier.
    pub(crate) fn mark_reaped(&mut self) {
        self.state.terminated = true;
    }

    /// Returns whether any process still belongs to the exact private process
    /// group created for this child.  A shell wrapper may exit before the
    /// provider process it launched, so leader exit alone is not a completed
    /// lifecycle transition.
    pub(crate) fn owned_group_is_alive(&self) -> bool {
        #[cfg(unix)]
        {
            process_group_is_alive(self.process_id)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

fn spawn_capture_reader<R>(
    mut reader: R,
    limit: usize,
    capture: bool,
    limit_hit: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
) -> std::io::Result<std::thread::JoinHandle<std::io::Result<CaptureReaderOutput>>>
where
    R: std::io::Read + Send + 'static,
{
    thread::Builder::new().spawn(move || {
        let mut bytes = Vec::with_capacity(limit.min(16 * 1024));
        let mut observed = 0_usize;
        let mut buffer = [0_u8; 8192];
        loop {
            let read = match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(read) => read,
                Err(error) => {
                    failed.store(true, Ordering::Release);
                    return Err(error);
                }
            };
            if read == 0 {
                break;
            }
            observed = observed.saturating_add(read);
            if capture && bytes.len() < limit {
                let remaining = limit - bytes.len();
                bytes.extend_from_slice(&buffer[..read.min(remaining)]);
            }
            if observed > limit {
                limit_hit.store(true, Ordering::Release);
            }
        }
        Ok(CaptureReaderOutput { bytes })
    })
}

fn join_reader_bounded(
    reader: std::thread::JoinHandle<std::io::Result<CaptureReaderOutput>>,
    deadline: Instant,
) -> Option<CaptureReaderOutput> {
    while !reader.is_finished() && Instant::now() < deadline {
        thread::sleep(POLL_INTERVAL);
    }
    if !reader.is_finished() {
        drop(reader);
        return None;
    }
    reader.join().ok().and_then(Result::ok)
}

fn terminate_and_reap(child: &mut Child, process_id: u32) {
    #[cfg(unix)]
    terminate_process_group(process_id);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn terminate_process_group(process_id: u32) {
    let group = format!("-{process_id}");
    for signal in ["-TERM", "-KILL"] {
        for executable in ["/bin/kill", "/usr/bin/kill"] {
            let mut command = Command::new(executable);
            command
                .args([signal, group.as_str()])
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Ok(mut killer) = command.spawn() {
                let _ = killer.wait();
                break;
            }
        }
        if signal == "-TERM" {
            thread::sleep(Duration::from_millis(25));
        }
    }
}

#[cfg(unix)]
fn terminate_process_group_until(process_id: u32, deadline: Instant, termination_grace: Duration) {
    // Signal synchronously before checking the deadline. A quit deadline can
    // be exhausted by an unrelated local worker, but the owned VS Code Server
    // process group must still receive termination before its Child is handed
    // to the bounded reaper. If time remains, allow TERM a short grace period
    // before escalating; with no time left, KILL is issued immediately.
    send_process_group_signal(process_id, Signal::SIGTERM);
    if Instant::now() < deadline {
        thread::sleep(termination_grace.min(deadline.saturating_duration_since(Instant::now())));
    }
    send_process_group_signal(process_id, Signal::SIGKILL);
}

/// Stop a process group DevHub started but holds no `Child` handle for: a
/// server left behind by a run that was killed before it could stop its own.
///
/// The identifier is a process-group leader created by the process adapter, so
/// the negative PID reaches exactly that tree. Nothing is reaped here — the
/// orphan is not this process's child — and a group that is already gone is
/// reported as reclaimed without a signal being sent.
#[cfg(unix)]
pub(crate) fn reclaim_orphaned_process_group(process_id: u32, deadline: Instant) -> bool {
    if !process_group_is_alive(process_id) {
        return true;
    }
    terminate_process_group_until(process_id, deadline, Duration::from_millis(250));
    !process_group_is_alive(process_id)
}

#[cfg(not(unix))]
pub(crate) fn reclaim_orphaned_process_group(_process_id: u32, _deadline: Instant) -> bool {
    false
}

/// Whether the command lines in a process group look like the VS Code Server
/// DevHub runs out of its own provider directory.
///
/// A recorded process id can be reused by anything once its owner is gone, so
/// liveness alone is not identity — signalling on that basis would let a stale
/// record take out an unrelated process group. `serve-web` running against
/// DevHub's own `--server-data-dir` is a claim nothing but DevHub's server can
/// make.
#[cfg(unix)]
pub(crate) fn process_group_runs_editor_server(process_id: u32, server_data: &Path) -> bool {
    let Some(server_data) = server_data.to_str() else { return false };
    let Ok(output) = Command::new("/bin/ps")
        .args(["-o", "command=", "-g", &process_id.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.contains("serve-web") && line.contains(server_data))
}

#[cfg(not(unix))]
pub(crate) fn process_group_runs_editor_server(_process_id: u32, _server_data: &Path) -> bool {
    false
}

#[cfg(unix)]
fn send_process_group_signal(process_id: u32, signal: Signal) {
    let Ok(process_id) = i32::try_from(process_id) else { return };
    // The adapter creates the child in its own process group, so the negative
    // PID targets only DevHub-owned VS Code Server descendants. ESRCH is expected
    // when the group exited between the bounded identity check and this call.
    let _ = kill(Pid::from_raw(-process_id), signal);
}

#[cfg(unix)]
fn process_group_is_alive(process_id: u32) -> bool {
    let Ok(process_id) = i32::try_from(process_id) else { return false };
    match kill(Pid::from_raw(-process_id), None) {
        Ok(()) | Err(nix::errno::Errno::EPERM) => true,
        Err(nix::errno::Errno::ESRCH) => false,
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_process_id: u32) {}

fn parse_captured_environment(output: &[u8]) -> Result<BTreeMap<OsString, OsString>, RuntimeError> {
    let Some(start) = find_bytes(output, STARTUP_ENV_SENTINEL) else {
        return Err(RuntimeError::new(RuntimeErrorCode::InvalidEnvironmentCapture));
    };
    let payload = &output[start + STARTUP_ENV_SENTINEL.len()..];
    let mut environment = BTreeMap::new();
    for entry in payload.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let Some(separator) = entry.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        let Some(key) = os_string_from_bytes(&entry[..separator]) else {
            continue;
        };
        let Some(value) = os_string_from_bytes(&entry[separator + 1..]) else {
            continue;
        };
        if !valid_environment_key(&key) || contains_nul(&value) {
            continue;
        }
        // `insert` intentionally gives the last duplicate the winning value.
        environment.insert(key, value);
    }
    Ok(environment)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn os_string_from_bytes(bytes: &[u8]) -> Option<OsString> {
    #[cfg(unix)]
    {
        Some(OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec()).ok().map(OsString::from)
    }
}

fn validate_environment(environment: &BTreeMap<OsString, OsString>) -> Result<(), RuntimeError> {
    for (key, value) in environment {
        if !valid_environment_key(key) {
            return Err(RuntimeError::new(RuntimeErrorCode::InvalidEnvironmentKey));
        }
        if contains_nul(value) {
            return Err(RuntimeError::new(RuntimeErrorCode::InvalidEnvironmentValue));
        }
    }
    Ok(())
}

fn valid_environment_key(key: &OsStr) -> bool {
    #[cfg(unix)]
    {
        let bytes = key.as_bytes();
        !bytes.is_empty() && !bytes.iter().any(|byte| *byte == b'=' || *byte == 0)
    }
    #[cfg(not(unix))]
    {
        let value = key.to_string_lossy();
        !value.is_empty() && !value.contains('=') && !value.contains('\0')
    }
}

fn contains_nul(value: &OsStr) -> bool {
    #[cfg(unix)]
    {
        value.as_bytes().contains(&0)
    }
    #[cfg(not(unix))]
    {
        value.to_string_lossy().contains('\0')
    }
}

fn expand_leading_tilde(configured: &str, home: &Path) -> Option<PathBuf> {
    if configured == "~" {
        return Some(home.to_path_buf());
    }
    configured.strip_prefix("~/").map(|relative| home.join(relative))
}

fn is_executable(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        !metadata.permissions().readonly()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    #[test]
    fn a_live_process_group_that_is_not_our_server_is_not_claimed() {
        // This is the guard that stands between a stale process-id record and
        // somebody else's process group. The test runner is as live a group as
        // there is, and it is emphatically not `serve-web`.
        let own_group = u32::try_from(nix::unistd::getpgrp().as_raw()).expect("own group");
        assert!(process_group_is_alive(own_group));
        assert!(!process_group_runs_editor_server(
            own_group,
            Path::new("/nonexistent/server-data")
        ));
    }

    struct TempDir {
        path: PathBuf,
    }

    static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

    impl TempDir {
        fn new() -> Self {
            let base = std::env::temp_dir();
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
            let serial = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
            let path = base.join(format!("devhub-runtime-{stamp}-{}-{serial}", std::process::id()));
            fs::create_dir_all(&path).expect("temporary directory");
            Self { path }
        }

        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn env_with_path(path: &str) -> BTreeMap<OsString, OsString> {
        BTreeMap::from([
            (OsString::from("PATH"), OsString::from(path)),
            (OsString::from("DEVHUB_SECRET"), OsString::from("secret-value")),
        ])
    }

    fn context(home: &Path, path: &str) -> RuntimeLaunchContext {
        RuntimeLaunchContext::new(home.to_path_buf(), env_with_path(path)).expect("context")
    }

    fn write_executable(path: &Path, output: &str, executable: bool) {
        let script = if output == "$DEVHUB_SECRET" {
            "#!/bin/sh\nprintf '%s' \"$DEVHUB_SECRET\"\n".to_owned()
        } else {
            format!("#!/bin/sh\nprintf '%s' '{output}'\n")
        };
        fs::write(path, script).expect("fixture");
        #[cfg(unix)]
        {
            let mode = if executable { 0o755 } else { 0o644 };
            let mut permissions = fs::metadata(path).expect("metadata").permissions();
            permissions.set_mode(mode);
            fs::set_permissions(path, permissions).expect("permissions");
        }
    }

    fn write_python_executable(path: &Path, body: &str) {
        let script = format!("#!/usr/bin/python3\n{body}\n");
        fs::write(path, script).expect("python fixture");
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("permissions");
        }
    }

    #[test]
    fn resolves_tilde_and_runs_with_injected_environment() {
        let temp = TempDir::new();
        let executable = temp.child("bin/tilde-tool");
        fs::create_dir_all(executable.parent().expect("parent")).expect("bin");
        write_executable(&executable, "$DEVHUB_SECRET", true);
        let context = context(&temp.path, "/usr/bin");
        let resolved = context.resolve("~/bin/tilde-tool").expect("tilde resolution");
        let output = context.output(&resolved, &[]);
        assert!(output.status.success());
        assert_eq!(output.stdout, b"secret-value");
        assert_eq!(resolved.mode(), ResolutionMode::ExplicitPath);
    }

    #[test]
    fn path_lookup_uses_first_executable_absolute_entry() {
        let temp = TempDir::new();
        let first = temp.child("first");
        let second = temp.child("second");
        fs::create_dir_all(&first).expect("first");
        fs::create_dir_all(&second).expect("second");
        write_executable(&first.join("chosen"), "first", true);
        write_executable(&second.join("chosen"), "second", true);
        let path = format!("{}:relative:{}", first.display(), second.display());
        let context = context(&temp.path, &path);
        let resolved = context.resolve("chosen").expect("PATH lookup");
        let output = context.output(&resolved, &[]);
        assert!(output.status.success());
        assert_eq!(output.stdout, b"first");
        assert_eq!(resolved.mode(), ResolutionMode::PathLookup);
    }

    #[test]
    fn missing_and_unexecutable_paths_have_typed_errors() {
        let temp = TempDir::new();
        let context = context(&temp.path, &temp.path.to_string_lossy());
        let missing = context.resolve("missing-tool").expect_err("missing");
        assert_eq!(missing.code(), RuntimeErrorCode::MissingExecutable);

        let unexecutable = temp.child("not-executable");
        write_executable(&unexecutable, "no", false);
        let error = context.resolve(unexecutable.to_str().expect("utf8")).expect_err("mode");
        #[cfg(unix)]
        assert_eq!(error.code(), RuntimeErrorCode::NotExecutable);
        #[cfg(not(unix))]
        assert!(matches!(
            error.code(),
            RuntimeErrorCode::NotExecutable | RuntimeErrorCode::CanonicalizationFailed
        ));
    }

    #[test]
    fn invalid_environment_keys_and_values_are_rejected() {
        let temp = TempDir::new();
        let mut empty_key = BTreeMap::new();
        empty_key.insert(OsString::new(), OsString::from("value"));
        assert_eq!(
            RuntimeLaunchContext::new(&temp.path, empty_key).expect_err("empty key").code(),
            RuntimeErrorCode::InvalidEnvironmentKey
        );

        let mut equals_key = BTreeMap::new();
        equals_key.insert(OsString::from("BAD=KEY"), OsString::from("value"));
        assert_eq!(
            RuntimeLaunchContext::new(&temp.path, equals_key).expect_err("equals key").code(),
            RuntimeErrorCode::InvalidEnvironmentKey
        );

        let mut nul_value = BTreeMap::new();
        nul_value.insert(OsString::from("KEY"), OsString::from("bad\0value"));
        assert_eq!(
            RuntimeLaunchContext::new(&temp.path, nul_value).expect_err("nul value").code(),
            RuntimeErrorCode::InvalidEnvironmentValue
        );
    }

    #[test]
    fn debug_is_redacted_and_reports_only_safe_shape() {
        let temp = TempDir::new();
        let context = context(&temp.path, "/usr/bin");
        let executable = context.resolve("/usr/bin/env").expect("env");
        let debug = format!("{context:?} {executable:?}");
        assert!(!debug.contains("secret-value"));
        assert!(!debug.contains(temp.path.to_string_lossy().as_ref()));
        assert!(!debug.contains("/usr/bin/env"));
        assert!(debug.contains("environment_entries"));
        assert!(debug.contains("PathLookup") || debug.contains("ExplicitPath"));
    }

    #[test]
    fn relative_paths_with_separators_are_not_looked_up_from_current_directory() {
        let temp = TempDir::new();
        let context = context(&temp.path, "/usr/bin");
        let error = context.resolve("bin/tool").expect_err("relative path");
        assert_eq!(error.code(), RuntimeErrorCode::InvalidExecutable);
    }

    #[test]
    fn startup_parser_discards_preamble_filters_entries_and_keeps_bytes() {
        let mut output = b"shell preamble\n".to_vec();
        output.extend_from_slice(STARTUP_ENV_SENTINEL);
        output.extend_from_slice(
            b"DUP=first\0DUP=last\0NO_SEPARATOR\0=empty-key\0NONUTF8=\xff\0GOOD=value\0",
        );
        let environment = parse_captured_environment(&output).expect("capture");
        assert_eq!(
            environment.get(OsStr::new("DUP")).map(OsString::as_os_str),
            Some(OsStr::new("last"))
        );
        assert!(!environment.contains_key(OsStr::new("NO_SEPARATOR")));
        assert!(!environment.contains_key(OsStr::new("")));
        assert_eq!(
            environment.get(OsStr::new("GOOD")).map(OsString::as_os_str),
            Some(OsStr::new("value"))
        );
        #[cfg(unix)]
        assert_eq!(
            environment.get(OsStr::new("NONUTF8")).map(|value| value.as_os_str().as_bytes()),
            Some(&b"\xff"[..])
        );
    }

    #[test]
    fn startup_parser_requires_the_fixed_sentinel() {
        let error = parse_captured_environment(b"PATH=/usr/bin\0").expect_err("sentinel");
        assert_eq!(error.code(), RuntimeErrorCode::InvalidEnvironmentCapture);
    }

    #[test]
    fn startup_without_login_import_captures_ambient_environment() {
        let temp = TempDir::new();
        let context =
            RuntimeLaunchContext::from_startup(&temp.path, false, "\0").expect("ambient context");
        assert_eq!(context.login_environment_status(), LoginEnvironmentStatus::Ambient);
        assert_eq!(
            context.environment.get(OsStr::new("PATH")).map(OsString::as_os_str),
            std::env::var_os("PATH").as_deref()
        );
    }

    #[test]
    fn login_shell_import_uses_fixed_probe_and_redacts_capture() {
        let temp = TempDir::new();
        let shell = temp.child("fake-login");
        write_python_executable(
            &shell,
            r#"
import sys
sys.stdout.buffer.write(b"preamble")
sys.stdout.buffer.write(b"\0DEVHUB_STARTUP_ENV\0")
sys.stdout.buffer.write(b"PATH=/usr/bin\0DUP=first\0DUP=last\0BAD\0SECRET=secret-value\0")
sys.stdout.flush()
"#,
        );
        let context = RuntimeLaunchContext::from_startup(
            &temp.path,
            true,
            shell.to_str().expect("shell path"),
        )
        .expect("login import");
        assert_eq!(context.login_environment_status(), LoginEnvironmentStatus::Imported);
        assert_eq!(
            context.environment.get(OsStr::new("DUP")).map(OsString::as_os_str),
            Some(OsStr::new("last"))
        );
        assert!(!context.environment.contains_key(OsStr::new("BAD")));
        let debug = format!("{context:?}");
        assert!(!debug.contains("secret-value"));
        assert!(!debug.contains(temp.path.to_string_lossy().as_ref()));
    }

    #[test]
    fn missing_login_shell_keeps_ambient_context_and_reports_health_failure() {
        let temp = TempDir::new();
        let context = RuntimeLaunchContext::from_startup(
            &temp.path,
            true,
            temp.child("missing-login-shell").to_str().expect("shell path"),
        )
        .expect("missing shell is a health failure, not a startup failure");
        assert_eq!(
            context.login_environment_status(),
            LoginEnvironmentStatus::Failed(RuntimeErrorCode::MissingExecutable)
        );
        assert_eq!(
            context.environment.get(OsStr::new("PATH")).map(OsString::as_os_str),
            std::env::var_os("PATH").as_deref()
        );
    }

    #[test]
    fn login_shell_timeout_and_output_limits_are_bounded() {
        let temp = TempDir::new();
        let timeout_shell = temp.child("timeout-login");
        write_python_executable(&timeout_shell, "import time\ntime.sleep(5)");
        let ambient = RuntimeLaunchContext::new(
            &temp.path,
            std::env::vars_os().collect::<BTreeMap<OsString, OsString>>(),
        )
        .expect("ambient");
        let timeout_shell =
            ambient.resolve(timeout_shell.to_str().expect("shell path")).expect("timeout shell");
        let started = Instant::now();
        let timeout = run_login_shell_with_limits(
            &ambient,
            &timeout_shell,
            Duration::from_millis(100),
            1024,
            1024,
        )
        .expect_err("timeout");
        assert_eq!(timeout.code(), RuntimeErrorCode::ShellTimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));

        let output_shell_path = temp.child("output-login");
        write_python_executable(
            &output_shell_path,
            "import sys\nsys.stdout.buffer.write(b'x' * 4096)\nsys.stdout.flush()",
        );
        let output_shell =
            ambient.resolve(output_shell_path.to_str().expect("shell path")).expect("output shell");
        let started = Instant::now();
        let output_limit =
            run_login_shell_with_limits(&ambient, &output_shell, Duration::from_secs(2), 128, 1024)
                .expect_err("output limit");
        assert_eq!(output_limit.code(), RuntimeErrorCode::ShellOutputLimit);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn login_shell_reader_observations_win_over_timeout_race() {
        assert_eq!(
            observed_terminal_error(Some(RuntimeErrorCode::ShellTimedOut), true, false, false,),
            Some(RuntimeErrorCode::ShellOutputLimit)
        );
        assert_eq!(
            observed_terminal_error(Some(RuntimeErrorCode::ShellTimedOut), false, false, true,),
            Some(RuntimeErrorCode::InvalidEnvironmentCapture)
        );
        assert_eq!(
            observed_terminal_error(Some(RuntimeErrorCode::ShellTimedOut), false, false, false),
            Some(RuntimeErrorCode::ShellTimedOut)
        );
    }

    #[test]
    fn cleanup_state_allows_one_process_group_termination_only() {
        let mut state = CleanupState::default();
        assert!(state.begin());
        assert!(!state.begin());
        assert!(!state.begin());
    }

    #[cfg(unix)]
    #[test]
    fn interrupt_shutdown_reaches_a_signal_receiver_beneath_a_shell_wrapper() {
        let temp = TempDir::new();
        let marker = temp.child("child-received-interrupt");
        let ready = temp.child("child-ready");
        let receiver = temp.child("receiver.py");
        write_python_executable(
            &receiver,
            &format!(
                "import pathlib, signal, time\nmarker = pathlib.Path({:?})\nready = pathlib.Path({:?})\ndef interrupted(_signal, _frame):\n    marker.write_text('handled')\n    raise SystemExit(42)\nsignal.signal(signal.SIGINT, interrupted)\nready.write_text('ready')\nwhile True:\n    time.sleep(0.01)",
                marker.to_string_lossy(),
                ready.to_string_lossy(),
            ),
        );
        let script = format!("{} & wait", receiver.display());
        let mut child = Command::new("/bin/sh")
            .args(["-c", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("interrupt fixture");
        let ready_deadline = Instant::now() + Duration::from_secs(1);
        while !ready.is_file() && Instant::now() < ready_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(ready.is_file(), "child fixture must install its signal handler");
        let mut cleanup = ChildCleanup::new(child.id());
        assert!(cleanup.terminate_until_with_grace(
            &mut child,
            Instant::now() + Duration::from_secs(1),
            Duration::from_millis(500),
            ShutdownSignal::Interrupt,
        ));
        assert!(marker.is_file(), "the wrapper's child must receive group Ctrl+C");
        assert!(!process_group_is_alive(child.id()));
    }

    #[cfg(unix)]
    #[test]
    fn interrupt_shutdown_does_not_accept_wrapper_exit_while_its_child_remains() {
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "trap 'exit 0' INT; /bin/sh -c 'trap \"\" INT; while :; do :; done' & wait",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("wrapper fixture");
        thread::sleep(Duration::from_millis(30));
        let group = child.id();
        let started = Instant::now();
        let mut cleanup = ChildCleanup::new(group);
        assert!(cleanup.terminate_until_with_grace(
            &mut child,
            Instant::now() + Duration::from_secs(1),
            Duration::from_millis(40),
            ShutdownSignal::Interrupt,
        ));
        assert!(started.elapsed() >= Duration::from_millis(35));
        assert!(!process_group_is_alive(group));
    }

    #[cfg(unix)]
    #[test]
    fn interrupt_shutdown_escalates_only_the_exact_owned_process_group() {
        use std::os::unix::process::ExitStatusExt;

        let mut child = Command::new("/bin/sh")
            .args(["-c", "trap '' INT; while :; do :; done"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("interrupt escalation fixture");
        let mut unrelated = Command::new("/bin/sh")
            .args(["-c", "trap '' INT; while :; do :; done"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("unrelated fixture");
        thread::sleep(Duration::from_millis(30));
        let mut cleanup = ChildCleanup::new(child.id());
        assert!(cleanup.terminate_until_with_grace(
            &mut child,
            Instant::now() + Duration::from_secs(1),
            Duration::from_millis(40),
            ShutdownSignal::Interrupt,
        ));
        assert_eq!(
            child.try_wait().expect("status").and_then(|status| status.signal()),
            Some(nix::libc::SIGKILL),
        );
        assert!(unrelated.try_wait().expect("unrelated status").is_none());
        let mut unrelated_cleanup = ChildCleanup::new(unrelated.id());
        unrelated_cleanup.terminate(&mut unrelated);
    }
}
