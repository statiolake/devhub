//! OpenVSCode process identity and bounded supervision.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::Duration;

use super::error::{EditorError, EditorErrorCode, EditorResult};

pub const MAX_RESTARTS: u8 = 3;

#[derive(Clone, PartialEq, Eq)]
pub struct ProcessSpec {
    executable: PathBuf,
    args: Vec<String>,
    /// Environment values are kept out of `Debug` and diagnostics. The
    /// process adapter is the only consumer of this field.
    env: Vec<(String, String)>,
}

impl ProcessSpec {
    pub fn new(executable: impl Into<PathBuf>, args: impl IntoIterator<Item = String>) -> Self {
        Self { executable: executable.into(), args: args.into_iter().collect(), env: Vec::new() }
    }

    pub fn with_env(mut self, env: impl IntoIterator<Item = (String, String)>) -> Self {
        self.env = env.into_iter().collect();
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
    fn terminate(&mut self) -> EditorResult<()>;
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
            child,
            identity: ProcessIdentity::new(pid, spec.executable().to_path_buf()),
            cleanup: crate::runtime::ChildCleanup::new(pid),
            reaped: false,
        };
        Ok(Box::new(process))
    }
}

struct SystemManagedProcess {
    child: Child,
    identity: ProcessIdentity,
    cleanup: crate::runtime::ChildCleanup,
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
        let status = self
            .child
            .try_wait()
            .map(|status| status.map(ProcessExit::from))
            .map_err(|_| EditorError::new(EditorErrorCode::ProcessUnavailable))?;
        if status.is_some() {
            self.reaped = true;
            // Once wait(2) has reaped the leader, the numeric PID/PGID may be
            // reused. Mark the cleanup guard before any later drop/timeout
            // path can attempt a group signal.
            self.cleanup.mark_reaped();
            // The OpenVSCode entry point is a shell wrapper. Reap the whole
            // private group while the leader is still owned by this guard.
            // A naturally exited wrapper has no safe group identity to signal;
            // explicit shutdown uses `terminate` before `try_wait` instead.
        }
        Ok(status)
    }

    fn terminate(&mut self) -> EditorResult<()> {
        if !self.identity_verified() {
            return Err(EditorError::new(EditorErrorCode::ProcessIdentityMismatch));
        }
        self.cleanup.terminate(&mut self.child);
        Ok(())
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
        let Some(process) = self.process.as_mut() else { return Ok(()) };
        if process.try_wait()?.is_some() {
            self.process = None;
            return Ok(());
        }
        if !process.identity_verified() {
            return Err(EditorError::new(EditorErrorCode::ProcessIdentityMismatch));
        }
        process.terminate()?;
        let _ = process.try_wait();
        self.process = None;
        Ok(())
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

        fn terminate(&mut self) -> EditorResult<()> {
            *self.terminated.lock().expect("terminated") = true;
            self.alive = false;
            Ok(())
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

    #[test]
    fn stop_requires_verified_identity_and_only_stops_owned_child() {
        let terminated = Arc::new(Mutex::new(false));
        let adapter = FakeAdapter { verified: true, terminated: terminated.clone() };
        let mut supervisor = ProcessSupervisor::new(3);
        let spec = ProcessSpec::new("/pinned/openvscode-server", []);
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
    fn natural_exit_marks_cleanup_reaped_before_supervisor_forgets_identity() {
        let adapter = SystemProcessAdapter;
        let spec = ProcessSpec::new("/bin/sh", ["-c".to_owned(), "exit 0".to_owned()]);
        let mut child = adapter.spawn(&spec).expect("spawn");
        let mut exited = false;
        for _ in 0..100 {
            if child.try_wait().expect("wait").is_some() {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(exited, "child should exit");
        assert!(!child.identity_verified());
    }
}
