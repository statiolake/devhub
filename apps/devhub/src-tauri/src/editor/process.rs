//! VS Code Server process identity and bounded supervision.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::error::{EditorError, EditorErrorCode, EditorResult};
use crate::runtime::ShutdownSignal;

pub const MAX_RESTARTS: u8 = 3;
const DEFAULT_TERMINATION_GRACE: Duration = Duration::from_millis(25);

#[derive(Clone, PartialEq, Eq)]
pub struct ProcessSpec {
    executable: PathBuf,
    args: Vec<String>,
    /// Environment values are kept out of `Debug` and diagnostics. The
    /// process adapter is the only consumer of this field.
    env: Vec<(String, String)>,
    termination_grace: Duration,
    shutdown_signal: ShutdownSignal,
}

impl ProcessSpec {
    pub fn new(executable: impl Into<PathBuf>, args: impl IntoIterator<Item = String>) -> Self {
        Self {
            executable: executable.into(),
            args: args.into_iter().collect(),
            env: Vec::new(),
            termination_grace: DEFAULT_TERMINATION_GRACE,
            shutdown_signal: ShutdownSignal::Terminate,
        }
    }

    pub fn with_env(mut self, env: impl IntoIterator<Item = (String, String)>) -> Self {
        self.env = env.into_iter().collect();
        self
    }

    pub fn with_termination_grace(mut self, termination_grace: Duration) -> Self {
        self.termination_grace = termination_grace;
        self
    }

    pub fn with_shutdown_signal(mut self, shutdown_signal: ShutdownSignal) -> Self {
        self.shutdown_signal = shutdown_signal;
        self
    }

    pub(crate) fn executable(&self) -> &Path {
        &self.executable
    }

    pub(crate) fn args(&self) -> &[String] {
        &self.args
    }

    pub(crate) fn env(&self) -> &[(String, String)] {
        &self.env
    }

    pub(crate) const fn termination_grace(&self) -> Duration {
        self.termination_grace
    }

    pub(crate) const fn shutdown_signal(&self) -> ShutdownSignal {
        self.shutdown_signal
    }
}

impl fmt::Debug for ProcessSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProcessSpec")
            .field("executable", &"<redacted>")
            .field("arg_count", &self.args.len())
            .field("environment_keys", &self.env.iter().map(|(key, _)| key).collect::<Vec<_>>())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pid: u32,
    executable: PathBuf,
}

impl fmt::Debug for ProcessIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProcessIdentity")
            .field("pid", &self.pid)
            .field("executable", &"<redacted>")
            .finish()
    }
}

impl ProcessIdentity {
    pub fn new(pid: u32, executable: impl Into<PathBuf>) -> Self {
        Self { pid, executable: executable.into() }
    }

    pub const fn pid(&self) -> u32 {
        self.pid
    }
}

pub trait ManagedProcess: Send {
    fn identity(&self) -> ProcessIdentity;
    fn identity_verified(&self) -> bool;
    fn try_wait(&mut self) -> EditorResult<Option<ProcessExit>>;

    /// Implementations must provide a deadline-aware stop operation. The
    /// process adapter may need to reap a child and that wait is allowed to
    /// outlive a quit deadline only in an explicitly owned reaper.
    fn terminate_until(&mut self, deadline: Instant) -> EditorResult<bool>;
}

pub trait ProcessAdapter: Send + Sync {
    fn spawn(&self, spec: &ProcessSpec) -> EditorResult<Box<dyn ManagedProcess>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessExit {
    pub code: Option<i32>,
}

impl From<ExitStatus> for ProcessExit {
    fn from(status: ExitStatus) -> Self {
        Self { code: status.code() }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemProcessAdapter;

impl ProcessAdapter for SystemProcessAdapter {
    fn spawn(&self, spec: &ProcessSpec) -> EditorResult<Box<dyn ManagedProcess>> {
        let mut command = Command::new(&spec.executable);
        command
            .args(spec.args())
            .envs(spec.env().iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child =
            command.spawn().map_err(|_| EditorError::new(EditorErrorCode::ProcessUnavailable))?;
        let pid = child.id();
        let process = SystemManagedProcess {
            child: Some(child),
            identity: ProcessIdentity::new(pid, spec.executable().to_path_buf()),
            cleanup: crate::runtime::ChildCleanup::new(pid),
            termination_grace: spec.termination_grace(),
            shutdown_signal: spec.shutdown_signal(),
            leader_exit: None,
            reaped: false,
        };
        Ok(Box::new(process))
    }
}

struct SystemManagedProcess {
    child: Option<Child>,
    identity: ProcessIdentity,
    cleanup: crate::runtime::ChildCleanup,
    termination_grace: Duration,
    shutdown_signal: ShutdownSignal,
    leader_exit: Option<ProcessExit>,
    reaped: bool,
}

impl ManagedProcess for SystemManagedProcess {
    fn identity(&self) -> ProcessIdentity {
        self.identity.clone()
    }

    fn identity_verified(&self) -> bool {
        // The owned, unreaped Child is the authority.  A process cannot
        // replace its executable in place; once wait(2) reports exit, the
        // cleanup guard is consumed and the supervisor drops this record
        // instead of rediscovering a PID that may have been reused.
        !self.reaped
    }

    fn try_wait(&mut self) -> EditorResult<Option<ProcessExit>> {
        if let Some(exit) = self.leader_exit {
            if self.cleanup.owned_group_is_alive() {
                return Ok(None);
            }
            self.reaped = true;
            self.cleanup.mark_reaped();
            return Ok(Some(exit));
        }
        let Some(child) = self.child.as_mut() else {
            return Ok(Some(ProcessExit { code: None }));
        };
        let status = child
            .try_wait()
            .map(|status| status.map(ProcessExit::from))
            .map_err(|_| EditorError::new(EditorErrorCode::ProcessUnavailable))?;
        if let Some(exit) = status {
            self.leader_exit = Some(exit);
            if self.cleanup.owned_group_is_alive() {
                return Ok(None);
            }
            self.reaped = true;
            self.cleanup.mark_reaped();
        }
        Ok(status)
    }

    fn terminate_until(&mut self, deadline: Instant) -> EditorResult<bool> {
        if !self.identity_verified() {
            return Err(EditorError::new(EditorErrorCode::ProcessIdentityMismatch));
        }
        let Some(mut child) = self.child.take() else { return Ok(true) };
        let stopped = self.cleanup.terminate_until_with_grace(
            &mut child,
            deadline,
            self.termination_grace,
            self.shutdown_signal,
        );
        if !stopped {
            // The process group has already received termination signals. Move
            // the owned Child to an app-local reaper so this bounded lifecycle
            // path never calls Child::wait after its deadline.
            let _ =
                thread::Builder::new().name("devhub-editor-reaper".to_owned()).spawn(move || {
                    let _ = child.wait();
                });
        } else {
            self.cleanup.mark_reaped();
        }
        self.reaped = true;
        Ok(stopped)
    }
}

/// The supervisor keeps process identity private and exposes only lifecycle
/// transitions. A failed readiness attempt consumes one bounded restart slot;
/// the stable port and token are never regenerated by this policy.
pub struct ProcessSupervisor {
    process: Option<Box<dyn ManagedProcess>>,
    restart_count: u8,
    max_restarts: u8,
}

impl Default for ProcessSupervisor {
    fn default() -> Self {
        Self::new(MAX_RESTARTS)
    }
}

impl ProcessSupervisor {
    pub const fn new(max_restarts: u8) -> Self {
        Self { process: None, restart_count: 0, max_restarts }
    }

    pub fn process(&self) -> Option<ProcessIdentity> {
        self.process.as_ref().map(|process| process.identity())
    }

    #[cfg(test)]
    pub const fn restart_count(&self) -> u8 {
        self.restart_count
    }

    pub fn is_running(&mut self) -> EditorResult<bool> {
        let Some(process) = self.process.as_mut() else { return Ok(false) };
        if process.try_wait()?.is_some() {
            return Ok(false);
        }
        if !process.identity_verified() {
            return Err(EditorError::new(EditorErrorCode::ProcessIdentityMismatch));
        }
        Ok(true)
    }

    pub fn spawn(&mut self, adapter: &dyn ProcessAdapter, spec: &ProcessSpec) -> EditorResult<()> {
        if self.is_running()? {
            return Ok(());
        }
        self.process = None;
        self.process = Some(adapter.spawn(spec)?);
        Ok(())
    }

    pub fn note_failed_start(&mut self) -> EditorResult<Duration> {
        if self.restart_count >= self.max_restarts {
            return Err(EditorError::new(EditorErrorCode::ReadinessTimeout));
        }
        let delay = match self.restart_count {
            0 => Duration::from_millis(100),
            1 => Duration::from_millis(250),
            _ => Duration::from_secs(1),
        };
        self.restart_count = self.restart_count.saturating_add(1);
        Ok(delay)
    }

    pub fn mark_ready(&mut self) {
        self.restart_count = 0;
    }

    pub fn stop(&mut self) -> EditorResult<()> {
        if !self.stop_until(Instant::now() + Duration::from_secs(5))? {
            return Err(EditorError::new(EditorErrorCode::ProcessUnavailable));
        }
        Ok(())
    }

    /// Stops the owned process without ever waiting beyond `deadline`. A
    /// false result means an app-local reaper owns the still-running Child;
    /// callers must treat that as a failed clean shutdown.
    pub fn stop_until(&mut self, deadline: Instant) -> EditorResult<bool> {
        let Some(process) = self.process.as_mut() else { return Ok(true) };
        match process.try_wait() {
            Ok(Some(_)) => {
                self.process = None;
                return Ok(true);
            }
            Ok(None) => {}
            Err(error) => return Err(error),
        }
        if !process.identity_verified() {
            return Err(EditorError::new(EditorErrorCode::ProcessIdentityMismatch));
        }
        let stopped = process.terminate_until(deadline)?;
        self.process = None;
        Ok(stopped)
    }

    pub fn forget_after_exit(&mut self) {
        self.process = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct FakeProcess {
        identity: ProcessIdentity,
        verified: bool,
        alive: bool,
        terminated: Arc<Mutex<bool>>,
    }

    impl ManagedProcess for FakeProcess {
        fn identity(&self) -> ProcessIdentity {
            self.identity.clone()
        }

        fn identity_verified(&self) -> bool {
            self.verified
        }

        fn try_wait(&mut self) -> EditorResult<Option<ProcessExit>> {
            if self.alive {
                Ok(None)
            } else {
                Ok(Some(ProcessExit { code: Some(0) }))
            }
        }

        fn terminate_until(&mut self, _deadline: Instant) -> EditorResult<bool> {
            *self.terminated.lock().expect("terminated") = true;
            self.alive = false;
            Ok(true)
        }
    }

    struct FakeAdapter {
        verified: bool,
        terminated: Arc<Mutex<bool>>,
    }

    impl ProcessAdapter for FakeAdapter {
        fn spawn(&self, spec: &ProcessSpec) -> EditorResult<Box<dyn ManagedProcess>> {
            Ok(Box::new(FakeProcess {
                identity: ProcessIdentity::new(42, spec.executable.clone()),
                verified: self.verified,
                alive: true,
                terminated: self.terminated.clone(),
            }))
        }
    }

    struct DeadlineProcess;

    impl ManagedProcess for DeadlineProcess {
        fn identity(&self) -> ProcessIdentity {
            ProcessIdentity::new(43, "/pinned/code")
        }

        fn identity_verified(&self) -> bool {
            true
        }

        fn try_wait(&mut self) -> EditorResult<Option<ProcessExit>> {
            Ok(None)
        }

        fn terminate_until(&mut self, deadline: Instant) -> EditorResult<bool> {
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(false)
        }
    }

    struct DeadlineAdapter;

    impl ProcessAdapter for DeadlineAdapter {
        fn spawn(&self, _spec: &ProcessSpec) -> EditorResult<Box<dyn ManagedProcess>> {
            Ok(Box::new(DeadlineProcess))
        }
    }

    #[test]
    fn stop_requires_verified_identity_and_only_stops_owned_child() {
        let terminated = Arc::new(Mutex::new(false));
        let adapter = FakeAdapter { verified: true, terminated: terminated.clone() };
        let mut supervisor = ProcessSupervisor::new(3);
        let spec = ProcessSpec::new("/pinned/code", []);
        supervisor.spawn(&adapter, &spec).expect("spawn");
        supervisor.stop().expect("stop");
        assert!(*terminated.lock().expect("terminated"));

        let mut unverified = ProcessSupervisor::new(3);
        let adapter = FakeAdapter { verified: false, terminated };
        unverified.spawn(&adapter, &spec).expect("spawn");
        let error = unverified.stop().expect_err("identity mismatch");
        assert_eq!(error.code(), EditorErrorCode::ProcessIdentityMismatch);
    }

    #[test]
    fn stop_until_does_not_fall_back_to_an_unbounded_terminate() {
        let mut supervisor = ProcessSupervisor::new(1);
        supervisor.spawn(&DeadlineAdapter, &ProcessSpec::new("/pinned/code", [])).expect("spawn");
        let started = Instant::now();
        assert!(!supervisor.stop_until(started + Duration::from_millis(25)).expect("bounded stop"));
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(supervisor.process().is_none());
    }

    #[test]
    fn restart_backoff_is_bounded_and_resets_when_ready() {
        let mut supervisor = ProcessSupervisor::new(2);
        assert_eq!(supervisor.note_failed_start().expect("first"), Duration::from_millis(100));
        assert_eq!(supervisor.note_failed_start().expect("second"), Duration::from_millis(250));
        assert_eq!(
            supervisor.note_failed_start().expect_err("bounded").code(),
            EditorErrorCode::ReadinessTimeout
        );
        supervisor.mark_ready();
        assert_eq!(supervisor.restart_count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn natural_wrapper_exit_keeps_ownership_until_its_group_is_gone() {
        let adapter = SystemProcessAdapter;
        let marker =
            std::env::temp_dir().join(format!("devhub-wrapper-exit-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let spec = ProcessSpec::new(
            "/bin/sh",
            ["-c".to_owned(), format!("sleep 30 & touch '{}'", marker.display())],
        );
        let mut child = adapter.spawn(&spec).expect("spawn");
        for _ in 0..500 {
            if marker.is_file() {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(marker.is_file(), "wrapper reached its natural exit");
        std::thread::sleep(Duration::from_millis(10));
        assert!(child.try_wait().expect("wait").is_none());
        assert!(child.identity_verified(), "descendant keeps ownership live");
        assert!(child
            .terminate_until(Instant::now() + Duration::from_secs(1))
            .expect("stop exact group"));
        assert!(!child.identity_verified());
        let _ = std::fs::remove_file(marker);
    }
}
