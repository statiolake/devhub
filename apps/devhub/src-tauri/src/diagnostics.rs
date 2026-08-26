//! Deep, local-only diagnostics owned by the native App Shell.
//!
//! The public boundary accepts only closed, content-free facts. Emission is
//! deliberately non-blocking: callers enqueue an owned record and a single
//! writer thread performs all filesystem work, rotation, and fsync.

#[cfg(target_os = "macos")]
use objc2_app_kit::NSWorkspace;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSString, NSURL};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
#[cfg(any(not(unix), test))]
use std::fs;
use std::fs::File;
#[cfg(not(unix))]
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use nix::unistd::geteuid;
#[cfg(unix)]
use rustix::fs::{fchmod, mkdirat, open, openat, renameat, Mode, OFlags};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

pub const LOG_LIMIT_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_GENERATIONS: usize = 5;
const MAX_EVENT_BYTES: usize = 16 * 1024;
const MAX_SUMMARY_BYTES: usize = 4 * 1024;
const MAX_RECENT_CODES: usize = 16;
const QUEUE_CAPACITY: usize = 256;
const LOG_FILE: &str = "devhub.jsonl";
const MARKER_FILE: &str = "session.json";
#[cfg(not(target_os = "macos"))]
const OPEN_COMMAND: &str = "/usr/bin/open";
const PBCOPY_COMMAND: &str = "/usr/bin/pbcopy";
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
const OWNER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
static FALLBACK_COUNTER: AtomicU64 = AtomicU64::new(1);
static FINDER_OPERATION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(test)]
static TEST_DIAGNOSTICS: std::sync::OnceLock<Mutex<Vec<Weak<Inner>>>> = std::sync::OnceLock::new();

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Info,
    Debug,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Starting,
    Healthy,
    Degraded,
    Unavailable,
    Failed,
}

/// The only facts accepted by the diagnostics boundary.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiagnosticEvent {
    Launch { previous_exit: PreviousExit },
    Lifecycle { phase: LifecyclePhase },
    Performance { marker: PerformanceMarker },
    Health { component: Component, health: Health, code: Option<Code> },
    Error { module: Module, code: Code, detail: Option<String> },
    ProviderExit { component: Component, code: Code },
    Retry { module: Module, code: Code, attempt: u32 },
    Migration { module: Module, from: u32, to: u32 },
}

/// Readiness markers used by the opt-in native performance driver.
///
/// These are deliberately a closed vocabulary.  The driver can measure the
/// time between real native events without allowing arbitrary user content,
/// URLs, paths, or identifiers into the diagnostics stream.  The markers are
/// emitted only when `DEVHUB_Q5_PERFORMANCE` is set by the driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerformanceMarker {
    AppShellInteractive,
    ActivityInteractive,
    ScratchInteractive,
    PickerFirstResult,
    EditorBridgeReady,
    WindowReconstructionReady,
    DockReopenReceived,
    DockReopenSucceeded,
    DockReopenFailed,
    ProjectionCleanupStarted,
    EditorHostDetached,
    TerminalSurfacesDetached,
    AgentSurfacesDetached,
    ProjectionCleanupFinished,
    ReopenWorkerEntered,
    CleanupWaitFinished,
    CleanupWaitTimedOut,
    CoordinatorReopened,
    WindowBuilt,
    HostReconstructed,
    WindowShownFocused,
    TerminalAttachEntered,
    TerminalAttachFailedInvalidRequest,
    TerminalAttachFailedInvalidSurface,
    TerminalAttachFailedSurfaceUnavailable,
    TerminalAttachFailedStaleTarget,
    TerminalAttachFailedWrongAttachment,
    TerminalAttachFailedAttachmentLimit,
    TerminalAttachFailedSessionUnavailable,
    TerminalAttachFailedPtyUnavailable,
    TerminalAttachFailedInputTooLarge,
    TerminalAttachFailedInvalidResize,
    TerminalAttachFailedChannelClosed,
    TerminalAttachFailedBackpressure,
    TerminalAttachFailedRuntimeUnavailable,
    TerminalAttachFailedInternal,
    TerminalAttachSucceeded,
    TerminalAttachInvokeRejected,
    TerminalResizeInvokeEntered,
    TerminalResizeInvokeRejected,
    TerminalInputInvokeEntered,
    TerminalInputInvokeRejected,
    TerminalResizeEntered,
    TerminalResizeFailedInvalidRequest,
    TerminalResizeFailedInvalidSurface,
    TerminalResizeFailedSurfaceUnavailable,
    TerminalResizeFailedStaleTarget,
    TerminalResizeFailedWrongAttachment,
    TerminalResizeFailedAttachmentLimit,
    TerminalResizeFailedSessionUnavailable,
    TerminalResizeFailedPtyUnavailable,
    TerminalResizeFailedInputTooLarge,
    TerminalResizeFailedInvalidResize,
    TerminalResizeFailedChannelClosed,
    TerminalResizeFailedBackpressure,
    TerminalResizeFailedRuntimeUnavailable,
    TerminalResizeFailedInternal,
    TerminalResizeSucceeded,
    TerminalInputEntered,
    TerminalInputFailedInvalidRequest,
    TerminalInputFailedInvalidSurface,
    TerminalInputFailedSurfaceUnavailable,
    TerminalInputFailedStaleTarget,
    TerminalInputFailedWrongAttachment,
    TerminalInputFailedAttachmentLimit,
    TerminalInputFailedSessionUnavailable,
    TerminalInputFailedPtyUnavailable,
    TerminalInputFailedInputTooLarge,
    TerminalInputFailedInvalidResize,
    TerminalInputFailedChannelClosed,
    TerminalInputFailedBackpressure,
    TerminalInputFailedRuntimeUnavailable,
    TerminalInputFailedInternal,
    TerminalInputSucceeded,
    TerminalChannelCallbackReceived,
    TerminalStartedFrameValidated,
    TerminalFrameDecodeOrIdentityFailed,
    TerminalHandshakeTimeoutBeforeReceipt,
    TerminalHandshakeTimeoutAfterReceipt,
    TerminalReceiptBeforeStarted,
    TerminalOutputRendered,
    TerminalOutputAfterInputRendered,
    EditorProviderDegraded,
    EditorProviderRecovered,
    Q5FixtureWorkspaceReady,
    Q5FixtureWorkspaceFailed,
    Q5FixtureAgentReady,
    Q5FixtureAgentFailed,
    Q5FixtureProfilesUnavailable,
    Q5FixtureAgentLaunchFailed,
    Q5FixtureAgentDispatchFailed,
    Q5FixtureAgentProcessEvidenceTimeout,
    Q5FixtureAgentFinalReconcileTimeout,
    Q5FixtureSnapshotFailed,
    Q5FixtureHerdrReconcileFailed,
    Q5FixtureScaleDeadlineExceeded,
    Q5FixtureScaleSetupDeadline,
    Q5FixtureSurfaceWarmReady,
    Q5FixtureSurfaceWarmTimeout,
    Q5FixtureSurfaceWarmDispatchFailed,
    Q5FixtureSurfaceWarmWaitTimeout,
    Q5FixtureStarted,
    Q5FixtureStartSkipped,
    Q5FixtureStartFailed,
    Q5FixtureScaleReady,
    Q5HiddenPrepare,
    Q5HiddenHoldStarted,
    Q5HiddenContinuityVerified,
    Q5QuitRelaunchReady,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviousExit {
    Clean,
    Unclean,
    Unknown,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecyclePhase {
    Startup,
    Ready,
    WindowClose,
    WindowReopen,
    Quit,
    CrashRecovery,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Component {
    App,
    Editor,
    Agent,
    Terminal,
    Config,
    State,
    Bridge,
    Settings,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Module {
    App,
    Editor,
    Agent,
    Terminal,
    Config,
    State,
    Bridge,
    Settings,
    Diagnostics,
}

/// Stable, content-free codes. This list is intentionally closed.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    NativeUnavailable,
    PermissionDenied,
    RuntimeUnavailable,
    StateUnavailable,
    StateCorrupt,
    StateRecovered,
    ConfigInvalid,
    ConfigReloaded,
    ProviderExited,
    ProviderReconnect,
    BridgeDisconnected,
    TerminalDisconnected,
    EditorDisconnected,
    RetryLimit,
    LogUnavailable,
    LogRotated,
    CrashRecovered,
}

#[derive(Debug, Clone, Serialize)]
struct Record<'a> {
    timestamp_ms: u128,
    session_id: &'a str,
    level: LogLevel,
    event: &'a str,
    /// The concrete cause, when the emitter had one. This log is local to the
    /// machine and to the single user who runs DevHub.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<LifecyclePhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    marker: Option<PerformanceMarker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    component: Option<Component>,
    #[serde(skip_serializing_if = "Option::is_none")]
    module: Option<Module>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<Code>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health: Option<Health>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_exit: Option<PreviousExit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Marker {
    clean: bool,
    session_id: String,
}

#[derive(Debug)]
struct Writer {
    directory: Option<SecureDirectory>,
    file: Option<File>,
}

/// A directory opened once and then used as the authority for all diagnostics
/// filesystem operations.  Entries are opened with openat(O_NOFOLLOW), so a
/// path validation cannot be separated from the descriptor that is used.
#[cfg(unix)]
#[derive(Debug)]
struct SecureDirectory {
    path: PathBuf,
    fd: File,
}

#[cfg(not(unix))]
#[derive(Debug)]
struct SecureDirectory {
    path: PathBuf,
}

type FinderOpener = Box<dyn FnOnce(SecureDirectory) -> Result<(), ActionError> + Send + 'static>;

struct FinderRequest {
    operation_id: u64,
    directory: SecureDirectory,
    opener: FinderOpener,
    response: SyncSender<Result<(), ActionError>>,
}

enum Command {
    Record { bytes: Vec<u8> },
    Marker { clean: bool, ack: Option<SyncSender<bool>> },
    Flush(SyncSender<bool>),
    Stop(SyncSender<bool>),
}

#[derive(Debug, Clone)]
pub struct Diagnostics {
    inner: Arc<Inner>,
}

/// The process-owned last reference. Short-lived command clones remain cheap
/// `Diagnostics` handles; only this owner performs bounded best-effort
/// teardown when the native state is dropped without going through Quit.
pub struct DiagnosticsOwner {
    diagnostics: Diagnostics,
}

impl DiagnosticsOwner {
    pub fn new(diagnostics: Diagnostics) -> Self {
        Self { diagnostics }
    }
}

impl Drop for DiagnosticsOwner {
    fn drop(&mut self) {
        let _ = self.diagnostics.shutdown(OWNER_SHUTDOWN_TIMEOUT);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionError {
    Unavailable,
    PermissionDenied,
    Busy,
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownOutcome {
    Complete,
    TimedOut,
    Failed,
}

#[derive(Debug)]
struct Inner {
    home: PathBuf,
    session_id: String,
    version: String,
    level: LogLevel,
    directory: PathBuf,
    previous_exit: PreviousExit,
    sender: SyncSender<Command>,
    /// The writer is explicitly owned so test and process teardown can stop
    /// it before its HOME/log directory is removed. The worker only keeps a
    /// Weak reference back to this value; otherwise the handle and worker
    /// would form an Arc cycle and a dropped Diagnostics could never reclaim
    /// its thread.
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    worker_done: Arc<std::sync::atomic::AtomicBool>,
    /// 0=running, 1=stop sent, 2=stop acknowledged, 3=joined, 4=terminal
    /// stop failure. A failed send/ack is never retried with a duplicate Stop.
    shutdown_state: AtomicU8,
    stop_receiver: Mutex<Option<Receiver<bool>>>,
    stop_result: AtomicU8,
    shutdown_lock: Mutex<()>,
    /// A single actor is created for the native runtime owner.  Its operation
    /// may remain blocked until AppKit returns, but no second actor or
    /// per-request reaper can be created while that happens.
    finder_sender: Mutex<Option<SyncSender<FinderRequest>>>,
    finder_worker: Mutex<Option<thread::JoinHandle<()>>>,
    finder_operation: Arc<Mutex<Option<u64>>>,
    health: AtomicU8,
    recent_codes: Mutex<BTreeSet<Code>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsView {
    pub session_id: String,
    pub log_directory: String,
    pub log_level: LogLevel,
    pub previous_exit: PreviousExit,
    pub health: Health,
    pub recent_codes: Vec<String>,
}

impl Diagnostics {
    /// Unsafe log state degrades diagnostics but never prevents startup.
    pub fn open(home: &Path, version: impl Into<String>, state_clean: Option<bool>) -> Self {
        let directory = home.join("Library").join("Logs").join("DevHub");
        let secure_directory = open_secure_directory(&directory).ok();
        let marker_exit = secure_directory.as_ref().and_then(read_previous_marker);
        let previous_exit = reconcile_previous_exit(state_clean, marker_exit);
        let session_id = new_session_id();
        let version = version.into();
        let file = secure_directory.as_ref().and_then(|directory| open_log(directory).ok());
        let initial_health = if file.is_some() { 1 } else { 2 };
        let (sender, receiver) = sync_channel(QUEUE_CAPACITY);
        let (finder_sender, finder_receiver) = sync_channel(1);
        let finder_operation = Arc::new(Mutex::new(None));
        let inner = Arc::new(Inner {
            home: home.to_path_buf(),
            session_id,
            version,
            level: LogLevel::Info,
            directory: directory.clone(),
            previous_exit,
            sender,
            worker: Mutex::new(None),
            worker_done: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            shutdown_state: AtomicU8::new(0),
            stop_receiver: Mutex::new(None),
            stop_result: AtomicU8::new(0),
            shutdown_lock: Mutex::new(()),
            finder_sender: Mutex::new(Some(finder_sender)),
            finder_worker: Mutex::new(None),
            finder_operation: finder_operation.clone(),
            health: AtomicU8::new(initial_health),
            recent_codes: Mutex::new(BTreeSet::new()),
        });
        let worker_inner = Arc::downgrade(&inner);
        let worker_done = inner.worker_done.clone();
        if let Ok(worker) =
            thread::Builder::new().name("devhub-diagnostics".to_owned()).spawn(move || {
                writer_loop(
                    receiver,
                    Writer { directory: secure_directory, file },
                    worker_inner,
                    worker_done,
                );
            })
        {
            if let Ok(mut slot) = inner.worker.lock() {
                *slot = Some(worker);
            }
        } else {
            inner.health.store(2, Ordering::Release);
        }
        match thread::Builder::new()
            .name("devhub-finder".to_owned())
            .spawn(move || finder_loop(finder_receiver, finder_operation))
        {
            Ok(worker) => {
                if let Ok(mut slot) = inner.finder_worker.lock() {
                    *slot = Some(worker);
                }
            }
            Err(_) => {
                if let Ok(mut sender) = inner.finder_sender.lock() {
                    *sender = None;
                }
            }
        }
        #[cfg(test)]
        TEST_DIAGNOSTICS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .expect("diagnostics test registry")
            .push(Arc::downgrade(&inner));
        let diagnostics = Self { inner };
        diagnostics.enqueue_control_until(
            Command::Marker { clean: false, ack: None },
            std::time::Instant::now() + FLUSH_TIMEOUT,
        );
        diagnostics.emit(DiagnosticEvent::Launch { previous_exit });
        if matches!(previous_exit, PreviousExit::Unclean) {
            diagnostics.emit(DiagnosticEvent::Error {
                module: Module::Diagnostics,
                code: Code::CrashRecovered,
                detail: None,
            });
        }
        diagnostics
    }

    #[allow(dead_code)]
    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }
    #[allow(dead_code)]
    pub fn directory(&self) -> &Path {
        &self.inner.directory
    }
    pub fn previous_exit(&self) -> PreviousExit {
        self.inner.previous_exit
    }

    /// Writer health is independent of runtime health. A full queue, failed
    /// writer, unsafe path, or failed fsync is degraded.
    pub fn health(&self) -> Health {
        match self.inner.health.load(Ordering::Acquire) {
            1 => Health::Healthy,
            2 => Health::Degraded,
            _ => Health::Unavailable,
        }
    }

    /// Enqueue a record without doing filesystem work on the caller thread.
    /// A successful enqueue is durable after a successful `flush`.
    pub fn emit(&self, event: DiagnosticEvent) -> bool {
        let (bytes, code) = match self.serialize_record(event) {
            Ok(value) => value,
            Err(_) => {
                self.degrade();
                return false;
            }
        };
        if let Some(code) = code {
            self.remember_code(code);
        }
        self.enqueue(Command::Record { bytes })
    }

    /// Queues the clean marker and flushes with a bounded deadline. No caller
    /// mutex is held while the writer performs filesystem I/O.
    pub fn flush(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        self.flush_until(deadline)
    }

    fn flush_until(&self, deadline: std::time::Instant) -> bool {
        let (ack, receiver) = sync_channel(0);
        if !self.enqueue_control_until(Command::Flush(ack), deadline) {
            return false;
        }
        let Some(remaining) = remaining(deadline) else { return false };
        receiver.recv_timeout(remaining).unwrap_or(false)
    }

    /// Queue the clean marker and stop the writer under one absolute
    /// deadline. The caller may commit clean state only after Complete.
    #[cfg(test)]
    pub fn clean_shutdown(&self, timeout: Duration) -> ShutdownOutcome {
        self.clean_shutdown_until(std::time::Instant::now() + timeout)
    }

    pub fn clean_shutdown_until(&self, deadline: std::time::Instant) -> ShutdownOutcome {
        let Some(_shutdown) = self.lock_until(deadline) else { return ShutdownOutcome::Failed };
        if self.inner.shutdown_state.load(Ordering::Acquire) != 0 {
            return ShutdownOutcome::Failed;
        }
        if !self.mark_clean_until(deadline) {
            return match self.stop_until(deadline) {
                ShutdownOutcome::TimedOut => ShutdownOutcome::TimedOut,
                ShutdownOutcome::Complete | ShutdownOutcome::Failed => ShutdownOutcome::Failed,
            };
        }
        self.stop_until(deadline)
    }

    pub fn shutdown(&self, timeout: Duration) -> ShutdownOutcome {
        let deadline = std::time::Instant::now() + timeout;
        let Some(_shutdown) = self.lock_until(deadline) else { return ShutdownOutcome::Failed };
        self.stop_until(deadline)
    }

    fn mark_clean_until(&self, deadline: std::time::Instant) -> bool {
        if self.inner.shutdown_state.load(Ordering::Acquire) != 0 {
            return false;
        }
        let (ack, receiver) = sync_channel(0);
        if !self.enqueue_control_until(Command::Marker { clean: true, ack: Some(ack) }, deadline) {
            return false;
        }
        let Some(remaining) = remaining(deadline) else { return false };
        if !receiver.recv_timeout(remaining).unwrap_or(false) {
            return false;
        }
        self.flush_until(deadline)
    }

    fn stop_until(&self, deadline: std::time::Instant) -> ShutdownOutcome {
        const RUNNING: u8 = 0;
        const STOP_SENT: u8 = 1;
        const STOP_ACKED: u8 = 2;
        const JOINED: u8 = 3;
        const FAILED: u8 = 4;
        let state = self.inner.shutdown_state.load(Ordering::Acquire);
        if state == JOINED {
            return if self.inner.stop_result.load(Ordering::Acquire) == 1 {
                ShutdownOutcome::Complete
            } else {
                ShutdownOutcome::Failed
            };
        }
        if state == RUNNING {
            let (ack, receiver) = sync_channel(0);
            if !self.enqueue_control_until(Command::Stop(ack), deadline) {
                self.inner.shutdown_state.store(FAILED, Ordering::Release);
                return ShutdownOutcome::Failed;
            }
            if let Ok(mut current) = self.inner.stop_receiver.lock() {
                *current = Some(receiver);
            } else {
                self.inner.shutdown_state.store(FAILED, Ordering::Release);
                return ShutdownOutcome::Failed;
            }
            self.inner.shutdown_state.store(STOP_SENT, Ordering::Release);
        }

        if self.inner.shutdown_state.load(Ordering::Acquire) == STOP_SENT {
            let Some(remaining) = remaining(deadline) else { return ShutdownOutcome::TimedOut };
            let result = self.inner.stop_receiver.lock().ok().and_then(|mut receiver| {
                receiver.as_mut().map(|receiver| receiver.recv_timeout(remaining))
            });
            match result {
                Some(Ok(true)) => self.inner.stop_result.store(1, Ordering::Release),
                Some(Ok(false)) => self.inner.stop_result.store(2, Ordering::Release),
                Some(Err(std::sync::mpsc::RecvTimeoutError::Timeout)) => {
                    return ShutdownOutcome::TimedOut
                }
                Some(Err(std::sync::mpsc::RecvTimeoutError::Disconnected)) | None => {
                    self.inner.shutdown_state.store(FAILED, Ordering::Release);
                    return ShutdownOutcome::Failed;
                }
            }
            if let Ok(mut receiver) = self.inner.stop_receiver.lock() {
                receiver.take();
            }
            self.inner.shutdown_state.store(STOP_ACKED, Ordering::Release);
        }

        if self.inner.shutdown_state.load(Ordering::Acquire) == FAILED {
            if !self.inner.worker_done.load(Ordering::Acquire) {
                return ShutdownOutcome::TimedOut;
            }
            self.join_worker();
            return ShutdownOutcome::Failed;
        }

        while !self.inner.worker_done.load(Ordering::Acquire) {
            if remaining(deadline).is_none() {
                return ShutdownOutcome::TimedOut;
            }
            thread::yield_now();
        }
        self.join_worker();
        if self.inner.stop_result.load(Ordering::Acquire) == 1 {
            ShutdownOutcome::Complete
        } else {
            ShutdownOutcome::Failed
        }
    }

    fn join_worker(&self) {
        if let Some(worker) = self.inner.worker.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = worker.join();
        }
        self.inner.shutdown_state.store(3, Ordering::Release);
    }

    fn lock_until(&self, deadline: std::time::Instant) -> Option<std::sync::MutexGuard<'_, ()>> {
        loop {
            match self.inner.shutdown_lock.try_lock() {
                Ok(lock) => return Some(lock),
                Err(std::sync::TryLockError::Poisoned(_)) => return None,
                Err(std::sync::TryLockError::WouldBlock) if remaining(deadline).is_some() => {
                    thread::yield_now();
                }
                Err(std::sync::TryLockError::WouldBlock) => return None,
            }
        }
    }

    /// Test-only teardown for NativeAppState fixtures. Tests intentionally
    /// keep state alive until their assertions finish, so cleanup cannot rely
    /// on Rust drop order alone; this closes every writer rooted at the
    /// fixture HOME before its directory is removed.
    #[cfg(test)]
    pub(crate) fn shutdown_for_test_home(home: &Path, timeout: Duration) -> bool {
        let Some(registry) = TEST_DIAGNOSTICS.get() else { return true };
        let inners = {
            let Ok(mut entries) = registry.lock() else { return false };
            let mut live = Vec::new();
            entries.retain(|entry| {
                let Some(inner) = entry.upgrade() else { return false };
                if inner.home == home {
                    live.push(inner);
                }
                true
            });
            live
        };
        inners.into_iter().all(|inner| {
            let diagnostics = Diagnostics { inner };
            // A live worker drains queued records in FIFO order before Stop;
            // if production quit already joined it, shutdown is the
            // idempotent acknowledgement that no further writes are owned.
            matches!(diagnostics.shutdown(timeout), ShutdownOutcome::Complete)
        })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn safe_directory(&self) -> io::Result<PathBuf> {
        ensure_log_directory(&self.inner.home)
    }

    pub fn open_log_folder(&self, timeout: Duration) -> Result<(), ActionError> {
        let deadline = std::time::Instant::now() + timeout;
        let directory = open_secure_directory(&self.inner.directory)
            .map_err(|_| ActionError::PermissionDenied)?;
        self.open_log_folder_until(directory, deadline, move |directory| {
            Self::open_directory_native(directory)
        })
    }

    #[cfg(test)]
    fn open_log_folder_with<F>(
        &self,
        directory: SecureDirectory,
        timeout: Duration,
        opener: F,
    ) -> Result<(), ActionError>
    where
        F: FnOnce(SecureDirectory) -> Result<(), ActionError> + Send + 'static,
    {
        let deadline = std::time::Instant::now() + timeout;
        self.open_log_folder_until(directory, deadline, opener)
    }

    fn open_log_folder_until<F>(
        &self,
        directory: SecureDirectory,
        deadline: std::time::Instant,
        opener: F,
    ) -> Result<(), ActionError>
    where
        F: FnOnce(SecureDirectory) -> Result<(), ActionError> + Send + 'static,
    {
        if remaining(deadline).is_none() {
            return Err(ActionError::TimedOut);
        }
        let finder_sender = self
            .inner
            .finder_sender
            .lock()
            .map_err(|_| ActionError::Unavailable)?
            .clone()
            .ok_or(ActionError::Unavailable)?;
        let operation_id = FINDER_OPERATION_COUNTER.fetch_add(1, Ordering::Relaxed);
        {
            let mut operation =
                self.inner.finder_operation.lock().map_err(|_| ActionError::Unavailable)?;
            if operation.is_some() {
                return Err(ActionError::Busy);
            }
            *operation = Some(operation_id);
        }
        let (sender, receiver) = sync_channel(0);
        let request =
            FinderRequest { operation_id, directory, opener: Box::new(opener), response: sender };
        if finder_sender.send(request).is_err() {
            clear_finder_operation(&self.inner.finder_operation, operation_id);
            return Err(ActionError::Unavailable);
        }
        let Some(remaining) = remaining(deadline) else { return Err(ActionError::TimedOut) };
        receiver.recv_timeout(remaining).unwrap_or(Err(ActionError::TimedOut))
    }

    #[cfg(test)]
    fn finder_busy(&self) -> bool {
        self.inner.finder_operation.lock().ok().and_then(|value| *value).is_some()
    }

    #[cfg(target_os = "macos")]
    fn open_directory_native(directory: SecureDirectory) -> Result<(), ActionError> {
        open_directory_in_finder(&directory)
    }

    #[cfg(not(target_os = "macos"))]
    fn open_directory_native(directory: SecureDirectory) -> Result<(), ActionError> {
        run_bounded(ProcessCommand::new(OPEN_COMMAND).arg(directory.path), Duration::from_secs(30))
    }

    pub fn copy_summary(
        &self,
        health: Health,
        previous_exit: PreviousExit,
        timeout: Duration,
    ) -> Result<(), ActionError> {
        let summary = self.redacted_summary(health, previous_exit);
        let mut child = ProcessCommand::new(PBCOPY_COMMAND)
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|_| ActionError::Unavailable)?;
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ActionError::Unavailable);
        };
        stdin.write_all(summary.as_bytes()).map_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
            ActionError::Unavailable
        })?;
        drop(stdin);
        wait_bounded(&mut child, timeout)
    }

    pub fn view(&self, requested_health: Health, previous_exit: PreviousExit) -> DiagnosticsView {
        let health = merge_health(requested_health, self.health());
        let recent_codes = self
            .inner
            .recent_codes
            .lock()
            .map(|codes| codes.iter().map(|code| format!("{code:?}").to_lowercase()).collect())
            .unwrap_or_default();
        DiagnosticsView {
            session_id: self.inner.session_id.clone(),
            log_directory: abbreviate_path_with_home(&self.inner.directory, &self.inner.home),
            log_level: self.inner.level,
            previous_exit: if matches!(self.inner.previous_exit, PreviousExit::Unclean) {
                PreviousExit::Unclean
            } else {
                previous_exit
            },
            health,
            recent_codes,
        }
    }

    pub fn redacted_summary(&self, health: Health, previous_exit: PreviousExit) -> String {
        let view = self.view(health, previous_exit);
        let mut value = serde_json::to_string(&view)
            .unwrap_or_else(|_| "{\"diagnostics\":\"unavailable\"}".to_owned());
        if value.len() > MAX_SUMMARY_BYTES {
            value.truncate(MAX_SUMMARY_BYTES);
        }
        value
    }

    fn serialize_record(&self, event: DiagnosticEvent) -> io::Result<(Vec<u8>, Option<Code>)> {
        let mut record = Record {
            detail: None,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            session_id: &self.inner.session_id,
            level: self.inner.level,
            event: "event",
            version: None,
            phase: None,
            marker: None,
            component: None,
            module: None,
            code: None,
            health: None,
            previous_exit: None,
            attempt: None,
            from: None,
            to: None,
        };
        match event {
            DiagnosticEvent::Launch { previous_exit } => {
                record.event = "launch";
                record.version = Some(&self.inner.version);
                record.previous_exit = Some(previous_exit);
            }
            DiagnosticEvent::Lifecycle { phase } => {
                record.event = "lifecycle";
                record.phase = Some(phase);
            }
            DiagnosticEvent::Performance { marker } => {
                record.event = "performance";
                record.marker = Some(marker);
            }
            DiagnosticEvent::Health { component, health, code } => {
                record.event = "health";
                record.component = Some(component);
                record.health = Some(health);
                record.code = code;
            }
            DiagnosticEvent::Error { module, code, detail } => {
                record.event = "error";
                record.module = Some(module);
                record.code = Some(code);
                record.detail = detail;
            }
            DiagnosticEvent::ProviderExit { component, code } => {
                record.event = "provider_exit";
                record.component = Some(component);
                record.code = Some(code);
            }
            DiagnosticEvent::Retry { module, code, attempt } => {
                record.event = "retry";
                record.module = Some(module);
                record.code = Some(code);
                record.attempt = Some(attempt.min(1_000_000));
            }
            DiagnosticEvent::Migration { module, from, to } => {
                record.event = "migration";
                record.module = Some(module);
                record.from = Some(from);
                record.to = Some(to);
            }
        }
        let code = record.code;
        let mut bytes = serde_json::to_vec(&record).map_err(|_| io::ErrorKind::InvalidData)?;
        if bytes.len() >= MAX_EVENT_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        bytes.push(b'\n');
        Ok((bytes, code))
    }

    fn enqueue(&self, command: Command) -> bool {
        match self.inner.sender.try_send(command) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.degrade();
                false
            }
        }
    }

    fn enqueue_control_until(&self, mut command: Command, deadline: std::time::Instant) -> bool {
        loop {
            match self.inner.sender.try_send(command) {
                Ok(()) => return true,
                Err(TrySendError::Disconnected(_)) => {
                    self.degrade();
                    return false;
                }
                Err(TrySendError::Full(returned)) => {
                    command = returned;
                    if std::time::Instant::now() >= deadline {
                        self.degrade();
                        return false;
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            }
        }
    }
    fn remember_code(&self, code: Code) {
        if let Ok(mut recent) = self.inner.recent_codes.lock() {
            recent.insert(code);
            while recent.len() > MAX_RECENT_CODES {
                if let Some(first) = recent.iter().next().copied() {
                    recent.remove(&first);
                }
            }
        }
    }

    fn degrade(&self) {
        self.inner.health.store(2, Ordering::Release);
        self.remember_code(Code::LogUnavailable);
    }
}

fn remaining(deadline: std::time::Instant) -> Option<Duration> {
    deadline.checked_duration_since(std::time::Instant::now())
}

fn clear_finder_operation(operation_state: &Arc<Mutex<Option<u64>>>, operation_id: u64) {
    if let Ok(mut operation) = operation_state.lock() {
        if *operation == Some(operation_id) {
            *operation = None;
        }
    }
}

fn finder_loop(receiver: Receiver<FinderRequest>, operation_state: Arc<Mutex<Option<u64>>>) {
    while let Ok(request) = receiver.recv() {
        let FinderRequest { operation_id, directory, opener, response } = request;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| opener(directory)))
            .unwrap_or(Err(ActionError::Unavailable));
        // Clear before responding so a successful completion can be followed
        // immediately by another request without observing a stale Busy state.
        clear_finder_operation(&operation_state, operation_id);
        let _ = response.send(result);
    }
}

fn writer_loop(
    receiver: Receiver<Command>,
    mut writer: Writer,
    diagnostics: Weak<Inner>,
    worker_done: Arc<std::sync::atomic::AtomicBool>,
) {
    while let Ok(command) = receiver.recv() {
        match command {
            Command::Record { bytes } => {
                let Some(diagnostics) = diagnostics.upgrade() else { break };
                if write_record(&mut writer, &bytes).is_err() {
                    diagnostics.health.store(2, Ordering::Release);
                    if let Ok(mut recent) = diagnostics.recent_codes.lock() {
                        recent.insert(Code::LogUnavailable);
                    }
                    writer.file = None;
                }
            }
            Command::Marker { clean, ack } => {
                let Some(diagnostics) = diagnostics.upgrade() else { break };
                let result = writer
                    .directory
                    .as_ref()
                    .map_or(Err(io::ErrorKind::NotFound.into()), |directory| {
                        write_marker(directory, clean, &diagnostics.session_id)
                    })
                    .is_ok();
                if !result {
                    diagnostics.health.store(2, Ordering::Release);
                }
                if let Some(ack) = ack {
                    let _ = ack.send(result);
                }
            }
            Command::Flush(ack) => {
                let _ = ack.send(flush_writer(&mut writer, false));
            }
            Command::Stop(ack) => {
                let result = flush_writer(&mut writer, true);
                let _ = ack.send(result);
                break;
            }
        }
    }
    worker_done.store(true, Ordering::Release);
}

#[cfg(not(target_os = "macos"))]
fn run_bounded(command: &mut std::process::Command, timeout: Duration) -> Result<(), ActionError> {
    let mut child = command.spawn().map_err(|_| ActionError::Unavailable)?;
    wait_bounded(&mut child, timeout)
}

fn wait_bounded(child: &mut std::process::Child, timeout: Duration) -> Result<(), ActionError> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() { Ok(()) } else { Err(ActionError::PermissionDenied) }
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ActionError::TimedOut);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ActionError::Unavailable);
            }
        }
    }
}

fn write_record(writer: &mut Writer, bytes: &[u8]) -> io::Result<()> {
    let Some(file) = writer.file.as_ref() else {
        return Err(io::ErrorKind::NotFound.into());
    };
    validate_open_file(file)?;
    if file.metadata()?.len().saturating_add(bytes.len() as u64) > LOG_LIMIT_BYTES {
        rotate(writer)?;
    }
    let file = writer.file.as_mut().ok_or(io::ErrorKind::NotFound)?;
    validate_open_file(file)?;
    file.write_all(bytes)?;
    file.sync_data()
}

fn rotate(writer: &mut Writer) -> io::Result<()> {
    let directory = writer.directory.as_ref().ok_or(io::ErrorKind::NotFound)?;
    validate_rotation_entries(directory)?;
    writer.file.take();
    for generation in (1..MAX_GENERATIONS).rev() {
        let source = if generation == 1 {
            LOG_FILE.to_owned()
        } else {
            format!("{LOG_FILE}.{}", generation - 1)
        };
        let target = format!("{LOG_FILE}.{generation}");
        if relative_file_exists(directory, &source)? {
            renameat(&directory.fd, source.as_str(), &directory.fd, target.as_str())
                .map_err(io::Error::from)?;
        }
    }
    writer.file = Some(open_log(directory)?);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn ensure_log_directory(home: &Path) -> io::Result<PathBuf> {
    let directory = home.join("Library").join("Logs").join("DevHub");
    let _ = open_secure_directory(&directory)?;
    Ok(directory)
}

#[cfg(unix)]
fn open_secure_directory(path: &Path) -> io::Result<SecureDirectory> {
    use std::path::Component;

    if !path.is_absolute() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    // macOS exposes a few system directories (notably /var) as aliases. Resolve
    // only the already-existing prefix, then perform the actual traversal and
    // creation descriptor-relatively with O_NOFOLLOW.
    let existing = path
        .ancestors()
        .find(|candidate| {
            std::fs::symlink_metadata(candidate)
                .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
                .unwrap_or(false)
        })
        .ok_or(io::ErrorKind::NotFound)?;
    let canonical_existing = std::fs::canonicalize(existing)?;
    let resolved_path = canonical_existing
        .join(path.strip_prefix(existing).map_err(|_| io::ErrorKind::PermissionDenied)?);
    let mut current = File::from(
        open(
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .map_err(io::Error::from)?,
    );
    for component in resolved_path.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir) {
                continue;
            }
            return Err(io::ErrorKind::PermissionDenied.into());
        };
        let child = match openat(
            &current,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                mkdirat(&current, name, Mode::from_raw_mode(0o700)).map_err(io::Error::from)?;
                File::from(
                    openat(
                        &current,
                        name,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                        Mode::empty(),
                    )
                    .map_err(io::Error::from)?,
                )
            }
            Err(error) => return Err(error.into()),
        };
        validate_directory_fd(&child)?;
        current = child;
    }
    let metadata = current.metadata()?;
    if metadata.uid() != geteuid().as_raw() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    if (metadata.mode() & 0o077) != 0 {
        fchmod(&current, Mode::from_raw_mode(0o700)).map_err(io::Error::from)?;
    }
    Ok(SecureDirectory { path: path.to_owned(), fd: current })
}

#[cfg(not(unix))]
fn open_secure_directory(path: &Path) -> io::Result<SecureDirectory> {
    fs::create_dir_all(path)?;
    Ok(SecureDirectory { path: path.to_owned() })
}

#[cfg(unix)]
fn validate_directory_fd(directory: &File) -> io::Result<()> {
    let metadata = directory.metadata()?;
    if !metadata.is_dir() || (metadata.mode() & 0o022) != 0 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

#[cfg(unix)]
fn validate_open_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != geteuid().as_raw() || (metadata.mode() & 0o077) != 0
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_open_file(file: &File) -> io::Result<()> {
    if !file.metadata()?.is_file() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

#[cfg(unix)]
fn open_relative_file(directory: &SecureDirectory, name: &str, flags: OFlags) -> io::Result<File> {
    let file = File::from(
        openat(
            &directory.fd,
            name,
            flags | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )
        .map_err(io::Error::from)?,
    );
    validate_open_file(&file)?;
    fchmod(&file, Mode::from_raw_mode(0o600)).map_err(io::Error::from)?;
    Ok(file)
}

#[cfg(not(unix))]
fn open_relative_file(directory: &SecureDirectory, name: &str, _flags: ()) -> io::Result<File> {
    let path = directory.path.join(name);
    let file = OpenOptions::new().read(true).write(true).create(true).open(path)?;
    validate_open_file(&file)?;
    Ok(file)
}

fn open_log(directory: &SecureDirectory) -> io::Result<File> {
    #[cfg(unix)]
    let file =
        open_relative_file(directory, LOG_FILE, OFlags::RDWR | OFlags::APPEND | OFlags::CREATE)?;
    #[cfg(not(unix))]
    let file = open_relative_file(directory, LOG_FILE, ())?;
    Ok(file)
}

#[cfg(target_os = "macos")]
fn open_directory_in_finder(directory: &SecureDirectory) -> Result<(), ActionError> {
    if !verified_directory_is_current(directory) {
        return Err(ActionError::PermissionDenied);
    }
    let path = directory.path.to_str().ok_or(ActionError::PermissionDenied)?;
    let path = NSString::from_str(path);
    let path_url = NSURL::fileURLWithPath_isDirectory(&path, true);
    // A file-reference URL identifies the already-resolved filesystem object,
    // so Finder does not re-resolve a swapped directory name after this seam.
    let reference = path_url.fileReferenceURL().ok_or(ActionError::PermissionDenied)?;
    // Close the path-to-URL race: if replacement happened before URL creation,
    // the second fd identity check rejects it; replacement after this point is
    // harmless because `reference` is already object-backed.
    if !verified_directory_is_current(directory) {
        return Err(ActionError::PermissionDenied);
    }
    if NSWorkspace::sharedWorkspace().openURL(&reference) {
        Ok(())
    } else {
        Err(ActionError::Unavailable)
    }
}

#[cfg(unix)]
fn verified_directory_is_current(directory: &SecureDirectory) -> bool {
    let Ok(expected) = directory.fd.metadata() else { return false };
    let Ok(current) = open_secure_directory(&directory.path) else { return false };
    let Ok(current) = current.fd.metadata() else { return false };
    expected.dev() == current.dev() && expected.ino() == current.ino()
}

fn validate_rotation_entries(directory: &SecureDirectory) -> io::Result<()> {
    for generation in 0..=MAX_GENERATIONS {
        let name =
            if generation == 0 { LOG_FILE.to_owned() } else { format!("{LOG_FILE}.{generation}") };
        if relative_file_exists(directory, &name)? {
            #[cfg(unix)]
            let _ = open_relative_file(directory, &name, OFlags::RDONLY)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn relative_file_exists(directory: &SecureDirectory, name: &str) -> io::Result<bool> {
    match open_relative_file(directory, name, OFlags::RDONLY) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn relative_file_exists(directory: &SecureDirectory, name: &str) -> io::Result<bool> {
    Ok(directory.path.join(name).exists())
}

fn write_marker(directory: &SecureDirectory, clean: bool, session_id: &str) -> io::Result<()> {
    let temp = format!(".{MARKER_FILE}.tmp-{}", FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed));
    let bytes = serde_json::to_vec(&Marker { clean, session_id: session_id.to_owned() })
        .map_err(|_| io::ErrorKind::InvalidData)?;
    #[cfg(unix)]
    let mut file = File::from(
        openat(
            &directory.fd,
            temp.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )
        .map_err(io::Error::from)?,
    );
    #[cfg(not(unix))]
    let mut file =
        OpenOptions::new().write(true).create_new(true).open(directory.path.join(&temp))?;
    validate_open_file(&file)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    // Validate the destination through the same directory fd immediately
    // before the atomic replacement. Symlinks, non-regular entries, foreign
    // owners, and permissive modes are rejected and never overwritten.
    #[cfg(unix)]
    if let Err(error) = validate_marker_destination(directory) {
        let _ = rustix::fs::unlinkat(&directory.fd, temp.as_str(), rustix::fs::AtFlags::empty());
        return Err(error);
    }
    #[cfg(unix)]
    renameat(&directory.fd, temp.as_str(), &directory.fd, MARKER_FILE).map_err(io::Error::from)?;
    #[cfg(not(unix))]
    fs::rename(directory.path.join(&temp), directory.path.join(MARKER_FILE))?;
    directory_sync(directory)?;
    Ok(())
}

#[cfg(unix)]
fn validate_marker_destination(directory: &SecureDirectory) -> io::Result<()> {
    match open_relative_file(directory, MARKER_FILE, OFlags::RDONLY) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn read_previous_marker(directory: &SecureDirectory) -> Option<PreviousExit> {
    #[cfg(unix)]
    let file = match open_relative_file(directory, MARKER_FILE, OFlags::RDONLY) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(_) => return Some(PreviousExit::Unknown),
    };
    #[cfg(not(unix))]
    let mut file = match File::open(directory.path.join(MARKER_FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(_) => return Some(PreviousExit::Unknown),
    };
    let mut bytes = Vec::new();
    file.take(4096).read_to_end(&mut bytes).ok()?;
    let marker = serde_json::from_slice::<Marker>(&bytes).ok()?;
    Some(if marker.clean { PreviousExit::Clean } else { PreviousExit::Unclean })
}

fn flush_writer(writer: &mut Writer, all: bool) -> bool {
    let Some(file) = writer.file.as_mut() else { return false };
    if validate_open_file(file).is_err() {
        return false;
    }
    let synced = if all { file.sync_all() } else { file.sync_data() };
    if synced.is_err() {
        return false;
    }
    let Some(directory) = writer.directory.as_ref() else { return false };
    #[cfg(unix)]
    let current = match open_relative_file(directory, LOG_FILE, OFlags::RDONLY) {
        Ok(file) => file,
        Err(_) => return false,
    };
    #[cfg(unix)]
    {
        let Ok(opened) = file.metadata() else { return false };
        let Ok(named) = current.metadata() else { return false };
        if opened.dev() != named.dev() || opened.ino() != named.ino() {
            return false;
        }
    }
    directory_sync(directory).is_ok()
}

#[cfg(unix)]
fn directory_sync(directory: &SecureDirectory) -> io::Result<()> {
    directory.fd.sync_all()
}

#[cfg(not(unix))]
fn directory_sync(_directory: &SecureDirectory) -> io::Result<()> {
    Ok(())
}

fn reconcile_previous_exit(
    state_clean: Option<bool>,
    marker: Option<PreviousExit>,
) -> PreviousExit {
    if state_clean == Some(false) || marker == Some(PreviousExit::Unclean) {
        return PreviousExit::Unclean;
    }
    if state_clean == Some(true) && marker == Some(PreviousExit::Clean) {
        return PreviousExit::Clean;
    }
    PreviousExit::Unknown
}

fn merge_health(requested: Health, diagnostics: Health) -> Health {
    if matches!(diagnostics, Health::Unavailable | Health::Degraded | Health::Failed) {
        return diagnostics;
    }
    requested
}

#[allow(dead_code)]
pub fn abbreviate_path(path: &Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    home.as_deref()
        .map_or_else(|| "<redacted>".to_owned(), |home| abbreviate_path_with_home(path, home))
}
fn abbreviate_path_with_home(path: &Path, home: &Path) -> String {
    if let Ok(relative) = path.strip_prefix(home) {
        if relative.as_os_str().is_empty() {
            "~".to_owned()
        } else {
            format!("~/{}", relative.to_string_lossy())
        }
    } else {
        "<redacted>".to_owned()
    }
}

fn new_session_id() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut file) = File::open("/dev/urandom") {
        let _ = file.read_exact(&mut bytes);
    } else {
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
            ^ FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed) as u128;
        bytes.copy_from_slice(&seed.to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn temp_home() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "devhub-diagnostics-{}",
            FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn session_ids_are_uuid_v4_values() {
        let value = new_session_id();
        assert_eq!(value.len(), 36);
        assert_eq!(value.as_bytes()[14], b'4');
        assert!(matches!(value.as_bytes()[19], b'8'..=b'9' | b'a'..=b'b'));
    }
    #[test]
    fn summary_has_no_content_and_marker_is_private() {
        let home = temp_home();
        #[cfg(unix)]
        fs::set_permissions(&home, fs::Permissions::from_mode(0o755)).unwrap();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(false));
        diagnostics.emit(DiagnosticEvent::Error {
            module: Module::Config,
            code: Code::ConfigInvalid,
            detail: Some("invalid syntax at line 3".to_owned()),
        });
        assert!(diagnostics.flush(Duration::from_secs(2)));
        let summary = diagnostics.redacted_summary(Health::Degraded, PreviousExit::Unclean);
        assert!(summary.len() <= MAX_SUMMARY_BYTES);
        assert!(summary.contains("sessionId"));
        assert!(!summary.contains("password"));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(home.join("Library/Logs/DevHub/session.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        #[cfg(unix)]
        assert_eq!(fs::metadata(&home).unwrap().permissions().mode() & 0o777, 0o755);
        assert!(matches!(diagnostics.shutdown(Duration::from_secs(2)), ShutdownOutcome::Complete));
        let _ = fs::remove_dir_all(home);
    }
    #[test]
    fn marker_reconciliation_detects_corrupt_without_blocking() {
        let home = temp_home();
        let directory = home.join("Library/Logs/DevHub");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(MARKER_FILE), b"not-json").unwrap();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        assert_eq!(diagnostics.previous_exit(), PreviousExit::Unknown);
        assert!(matches!(diagnostics.shutdown(Duration::from_secs(2)), ShutdownOutcome::Complete));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn clean_marker_and_state_must_agree_for_clean_start() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        assert!(matches!(
            diagnostics.clean_shutdown(Duration::from_secs(2)),
            ShutdownOutcome::Complete
        ));
        let next = Diagnostics::open(&home, "0.1.0", Some(true));
        assert_eq!(next.previous_exit(), PreviousExit::Clean);
        assert!(matches!(next.shutdown(Duration::from_secs(2)), ShutdownOutcome::Complete));
        let _ = fs::remove_dir_all(home);
    }
    #[test]
    fn rotation_rejects_symlink_generation() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        #[cfg(unix)]
        std::os::unix::fs::symlink("/tmp", diagnostics.directory().join(format!("{LOG_FILE}.5")))
            .unwrap();
        #[cfg(unix)]
        let secure = open_secure_directory(diagnostics.directory()).unwrap();
        #[cfg(unix)]
        assert!(validate_rotation_entries(&secure).is_err());
        assert!(matches!(diagnostics.shutdown(Duration::from_secs(2)), ShutdownOutcome::Complete));
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_seam_rejects_symlink_marker_and_replaced_log_entry() {
        let home = temp_home();
        let directory = home.join("Library/Logs/DevHub");
        fs::create_dir_all(&directory).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", directory.join(MARKER_FILE)).unwrap();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        assert_eq!(diagnostics.previous_exit(), PreviousExit::Unknown);
        assert!(fs::symlink_metadata(directory.join(MARKER_FILE))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(diagnostics.emit(DiagnosticEvent::Lifecycle { phase: LifecyclePhase::Ready }));
        assert!(diagnostics.flush(Duration::from_secs(2)));

        let log = directory.join(LOG_FILE);
        let moved = directory.join("devhub.jsonl.moved");
        fs::rename(&log, &moved).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", &log).unwrap();
        assert!(!diagnostics.flush(Duration::from_secs(2)));
        assert!(!fs::read_to_string(&moved).unwrap().contains("passwd"));
        let _ = diagnostics.shutdown(Duration::from_secs(2));
        let _ = fs::remove_file(&log);
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn marker_destination_rejects_permissive_existing_file() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        let marker = diagnostics.directory().join(MARKER_FILE);
        fs::write(&marker, b"keep").unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o644)).unwrap();
        let directory = open_secure_directory(diagnostics.directory()).unwrap();
        assert!(write_marker(&directory, true, "test").is_err());
        assert_eq!(fs::read(&marker).unwrap(), b"keep");
        let _ = diagnostics.shutdown(Duration::from_secs(2));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn finder_open_is_single_flight_and_timeout_does_not_spawn_duplicates() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        let started = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let invocations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (finished_sender, finished_receiver) = sync_channel(0);
        let first = {
            let diagnostics = diagnostics.clone();
            let directory = open_secure_directory(diagnostics.directory()).unwrap();
            let started = started.clone();
            let release = release.clone();
            let invocations = invocations.clone();
            thread::spawn(move || {
                diagnostics.open_log_folder_with(directory, Duration::from_millis(20), move |_| {
                    invocations.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    started.wait();
                    release.wait();
                    let _ = finished_sender.send(());
                    Ok(())
                })
            })
        };
        started.wait();
        assert!(diagnostics.finder_busy());
        assert_eq!(invocations.load(std::sync::atomic::Ordering::SeqCst), 1);
        for _ in 0..100 {
            let second_directory = open_secure_directory(diagnostics.directory()).unwrap();
            assert_eq!(
                diagnostics.open_log_folder_with(second_directory, Duration::from_secs(1), |_| {
                    panic!("a busy request must not reach the finder actor")
                }),
                Err(ActionError::Busy)
            );
        }
        assert_eq!(first.join().unwrap(), Err(ActionError::TimedOut));
        release.wait();
        finished_receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        // The worker clears the ledger after the native operation returns.
        let clear_deadline = std::time::Instant::now() + Duration::from_secs(1);
        while diagnostics.finder_busy() && std::time::Instant::now() < clear_deadline {
            thread::yield_now();
        }
        assert!(!diagnostics.finder_busy());
        assert_eq!(invocations.load(std::sync::atomic::Ordering::SeqCst), 1);
        let third_directory = open_secure_directory(diagnostics.directory()).unwrap();
        assert_eq!(
            diagnostics.open_log_folder_with(third_directory, Duration::from_secs(1), |_| Ok(())),
            Ok(())
        );
        // The actor clears its ledger before delivering the result, so an
        // immediate successful retry does not observe a stale Busy state.
        let fourth_directory = open_secure_directory(diagnostics.directory()).unwrap();
        assert_eq!(
            diagnostics.open_log_folder_with(fourth_directory, Duration::from_secs(1), |_| Ok(())),
            Ok(())
        );
        let _ = diagnostics.shutdown(Duration::from_secs(2));
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_seam_rejects_symlink_log_directory() {
        let home = temp_home();
        let logs = home.join("Library/Logs");
        let target = home.join("outside");
        fs::create_dir_all(&logs).unwrap();
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, logs.join("DevHub")).unwrap();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        assert_eq!(diagnostics.health(), Health::Degraded);
        assert!(!target.join(LOG_FILE).exists());
        let _ = diagnostics.shutdown(Duration::from_secs(2));
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finder_action_rejects_directory_replacement_before_native_open() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        let directory = open_secure_directory(diagnostics.directory()).unwrap();
        let original = diagnostics.directory().to_owned();
        let moved = home.join("DevHub-moved");
        let replacement = home.join("DevHub-replacement");
        fs::create_dir(&replacement).unwrap();
        fs::rename(&original, &moved).unwrap();
        std::os::unix::fs::symlink(&replacement, &original).unwrap();
        assert!(!verified_directory_is_current(&directory));
        assert_eq!(open_directory_in_finder(&directory), Err(ActionError::PermissionDenied));
        let _ = diagnostics.shutdown(Duration::from_secs(2));
        let _ = fs::remove_file(&original);
        let _ = fs::remove_dir_all(home);
    }
    #[test]
    fn concurrent_emit_produces_complete_lines() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        let workers = (0..8)
            .map(|_| {
                let diagnostics = diagnostics.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        diagnostics.emit(DiagnosticEvent::ProviderExit {
                            component: Component::Agent,
                            code: Code::ProviderExited,
                        });
                    }
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(diagnostics.flush(Duration::from_secs(2)));
        let contents = fs::read_to_string(diagnostics.directory().join(LOG_FILE)).unwrap();
        assert!(contents
            .lines()
            .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok()));
        assert!(matches!(diagnostics.shutdown(Duration::from_secs(2)), ShutdownOutcome::Complete));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn accepted_records_are_visible_after_flush_across_repeated_starts() {
        for _ in 0..32 {
            let home = temp_home();
            let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
            assert!(matches!(diagnostics.health(), Health::Healthy));
            assert!(diagnostics.emit(DiagnosticEvent::Lifecycle { phase: LifecyclePhase::Ready }));
            assert!(diagnostics.flush(Duration::from_secs(2)));
            let contents = fs::read_to_string(diagnostics.directory().join(LOG_FILE)).unwrap();
            assert!(contents.contains("\"phase\":\"ready\""));
            assert!(matches!(
                diagnostics.shutdown(Duration::from_secs(2)),
                ShutdownOutcome::Complete
            ));
            let _ = fs::remove_dir_all(home);
        }
    }

    #[test]
    fn required_events_are_typed_and_content_free() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        let events = [
            DiagnosticEvent::Lifecycle { phase: LifecyclePhase::Ready },
            DiagnosticEvent::Lifecycle { phase: LifecyclePhase::WindowClose },
            DiagnosticEvent::Lifecycle { phase: LifecyclePhase::WindowReopen },
            DiagnosticEvent::Lifecycle { phase: LifecyclePhase::Quit },
            DiagnosticEvent::Performance { marker: PerformanceMarker::AppShellInteractive },
            DiagnosticEvent::ProviderExit {
                component: Component::Bridge,
                code: Code::BridgeDisconnected,
            },
            DiagnosticEvent::Retry { module: Module::Settings, code: Code::RetryLimit, attempt: 2 },
            DiagnosticEvent::Migration { module: Module::State, from: 1, to: 1 },
        ];
        for event in events {
            assert!(diagnostics.emit(event));
        }
        assert!(diagnostics.flush(Duration::from_secs(2)));
        let contents = fs::read_to_string(diagnostics.directory().join(LOG_FILE)).unwrap();
        assert!(contents.contains("window_close"));
        assert!(contents.contains("\"marker\":\"app_shell_interactive\""));
        assert!(contents.contains("provider_exit"));
        assert!(contents.contains("migration"));
        assert!(!contents.contains("provider-id"));
        assert!(!contents.contains("/Users/"));
        assert!(matches!(diagnostics.shutdown(Duration::from_secs(2)), ShutdownOutcome::Complete));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn terminal_attach_performance_markers_are_a_closed_content_free_vocabulary() {
        let markers = [
            PerformanceMarker::TerminalAttachEntered,
            PerformanceMarker::TerminalAttachFailedInvalidRequest,
            PerformanceMarker::TerminalAttachFailedInvalidSurface,
            PerformanceMarker::TerminalAttachFailedSurfaceUnavailable,
            PerformanceMarker::TerminalAttachFailedStaleTarget,
            PerformanceMarker::TerminalAttachFailedWrongAttachment,
            PerformanceMarker::TerminalAttachFailedAttachmentLimit,
            PerformanceMarker::TerminalAttachFailedSessionUnavailable,
            PerformanceMarker::TerminalAttachFailedPtyUnavailable,
            PerformanceMarker::TerminalAttachFailedInputTooLarge,
            PerformanceMarker::TerminalAttachFailedInvalidResize,
            PerformanceMarker::TerminalAttachFailedChannelClosed,
            PerformanceMarker::TerminalAttachFailedBackpressure,
            PerformanceMarker::TerminalAttachFailedRuntimeUnavailable,
            PerformanceMarker::TerminalAttachFailedInternal,
            PerformanceMarker::TerminalAttachSucceeded,
            PerformanceMarker::TerminalAttachInvokeRejected,
            PerformanceMarker::TerminalResizeInvokeEntered,
            PerformanceMarker::TerminalResizeInvokeRejected,
            PerformanceMarker::TerminalInputInvokeEntered,
            PerformanceMarker::TerminalInputInvokeRejected,
        ];
        let encoded: Vec<String> = markers
            .iter()
            .map(|marker| serde_json::to_string(marker).expect("marker JSON"))
            .collect();
        assert_eq!(
            encoded,
            [
                "\"terminal_attach_entered\"",
                "\"terminal_attach_failed_invalid_request\"",
                "\"terminal_attach_failed_invalid_surface\"",
                "\"terminal_attach_failed_surface_unavailable\"",
                "\"terminal_attach_failed_stale_target\"",
                "\"terminal_attach_failed_wrong_attachment\"",
                "\"terminal_attach_failed_attachment_limit\"",
                "\"terminal_attach_failed_session_unavailable\"",
                "\"terminal_attach_failed_pty_unavailable\"",
                "\"terminal_attach_failed_input_too_large\"",
                "\"terminal_attach_failed_invalid_resize\"",
                "\"terminal_attach_failed_channel_closed\"",
                "\"terminal_attach_failed_backpressure\"",
                "\"terminal_attach_failed_runtime_unavailable\"",
                "\"terminal_attach_failed_internal\"",
                "\"terminal_attach_succeeded\"",
                "\"terminal_attach_invoke_rejected\"",
                "\"terminal_resize_invoke_entered\"",
                "\"terminal_resize_invoke_rejected\"",
                "\"terminal_input_invoke_entered\"",
                "\"terminal_input_invoke_rejected\"",
            ]
        );
        assert!(encoded.iter().all(|marker| {
            (marker.contains("terminal_attach_")
                || marker == "\"terminal_resize_invoke_rejected\""
                || marker == "\"terminal_resize_invoke_entered\""
                || marker == "\"terminal_input_invoke_entered\""
                || marker == "\"terminal_input_invoke_rejected\"")
                && !marker.contains('/')
                && !marker.contains(':')
        }));
    }

    #[test]
    fn terminal_resize_input_and_render_markers_are_closed_content_free() {
        let markers = [
            PerformanceMarker::TerminalResizeEntered,
            PerformanceMarker::TerminalResizeFailedInvalidRequest,
            PerformanceMarker::TerminalResizeFailedInvalidSurface,
            PerformanceMarker::TerminalResizeFailedSurfaceUnavailable,
            PerformanceMarker::TerminalResizeFailedStaleTarget,
            PerformanceMarker::TerminalResizeFailedWrongAttachment,
            PerformanceMarker::TerminalResizeFailedAttachmentLimit,
            PerformanceMarker::TerminalResizeFailedSessionUnavailable,
            PerformanceMarker::TerminalResizeFailedPtyUnavailable,
            PerformanceMarker::TerminalResizeFailedInputTooLarge,
            PerformanceMarker::TerminalResizeFailedInvalidResize,
            PerformanceMarker::TerminalResizeFailedChannelClosed,
            PerformanceMarker::TerminalResizeFailedBackpressure,
            PerformanceMarker::TerminalResizeFailedRuntimeUnavailable,
            PerformanceMarker::TerminalResizeFailedInternal,
            PerformanceMarker::TerminalResizeSucceeded,
            PerformanceMarker::TerminalInputEntered,
            PerformanceMarker::TerminalInputFailedInvalidRequest,
            PerformanceMarker::TerminalInputFailedInvalidSurface,
            PerformanceMarker::TerminalInputFailedSurfaceUnavailable,
            PerformanceMarker::TerminalInputFailedStaleTarget,
            PerformanceMarker::TerminalInputFailedWrongAttachment,
            PerformanceMarker::TerminalInputFailedAttachmentLimit,
            PerformanceMarker::TerminalInputFailedSessionUnavailable,
            PerformanceMarker::TerminalInputFailedPtyUnavailable,
            PerformanceMarker::TerminalInputFailedInputTooLarge,
            PerformanceMarker::TerminalInputFailedInvalidResize,
            PerformanceMarker::TerminalInputFailedChannelClosed,
            PerformanceMarker::TerminalInputFailedBackpressure,
            PerformanceMarker::TerminalInputFailedRuntimeUnavailable,
            PerformanceMarker::TerminalInputFailedInternal,
            PerformanceMarker::TerminalInputSucceeded,
            PerformanceMarker::TerminalChannelCallbackReceived,
            PerformanceMarker::TerminalStartedFrameValidated,
            PerformanceMarker::TerminalFrameDecodeOrIdentityFailed,
            PerformanceMarker::TerminalHandshakeTimeoutBeforeReceipt,
            PerformanceMarker::TerminalHandshakeTimeoutAfterReceipt,
            PerformanceMarker::TerminalReceiptBeforeStarted,
            PerformanceMarker::TerminalOutputRendered,
            PerformanceMarker::TerminalOutputAfterInputRendered,
            PerformanceMarker::EditorProviderDegraded,
            PerformanceMarker::EditorProviderRecovered,
        ];
        let encoded: Vec<String> = markers
            .iter()
            .map(|marker| serde_json::to_string(marker).expect("marker JSON"))
            .collect();
        assert!(encoded.iter().all(|marker| {
            (marker.contains("terminal_resize_")
                || marker.contains("terminal_input_")
                || marker.contains("terminal_channel_")
                || marker.contains("terminal_started_frame_")
                || marker.contains("terminal_frame_decode_")
                || marker.contains("terminal_handshake_timeout_")
                || marker.contains("terminal_receipt_before_")
                || marker == "\"terminal_output_rendered\""
                || marker == "\"terminal_output_after_input_rendered\""
                || marker == "\"editor_provider_degraded\""
                || marker == "\"editor_provider_recovered\"")
                && !marker.contains('/')
                && !marker.contains(':')
        }));
        assert!(encoded.contains(&"\"terminal_resize_entered\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_input_succeeded\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_channel_callback_received\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_started_frame_validated\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_frame_decode_or_identity_failed\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_handshake_timeout_before_receipt\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_handshake_timeout_after_receipt\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_receipt_before_started\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_output_rendered\"".to_owned()));
        assert!(encoded.contains(&"\"terminal_output_after_input_rendered\"".to_owned()));
    }

    #[test]
    fn dock_reopen_markers_are_closed_content_free() {
        let markers = [
            PerformanceMarker::DockReopenReceived,
            PerformanceMarker::DockReopenSucceeded,
            PerformanceMarker::DockReopenFailed,
        ];
        let encoded: Vec<String> = markers
            .iter()
            .map(|marker| serde_json::to_string(marker).expect("marker JSON"))
            .collect();
        assert_eq!(
            encoded,
            ["\"dock_reopen_received\"", "\"dock_reopen_succeeded\"", "\"dock_reopen_failed\"",]
        );
        assert!(encoded.iter().all(|marker| {
            marker.starts_with("\"dock_reopen_") && !marker.contains('/') && !marker.contains(':')
        }));
    }

    #[test]
    fn lifecycle_projection_and_reopen_markers_are_closed_content_free() {
        let markers = [
            PerformanceMarker::ProjectionCleanupStarted,
            PerformanceMarker::EditorHostDetached,
            PerformanceMarker::TerminalSurfacesDetached,
            PerformanceMarker::AgentSurfacesDetached,
            PerformanceMarker::ProjectionCleanupFinished,
            PerformanceMarker::ReopenWorkerEntered,
            PerformanceMarker::CleanupWaitFinished,
            PerformanceMarker::CleanupWaitTimedOut,
            PerformanceMarker::CoordinatorReopened,
            PerformanceMarker::WindowBuilt,
            PerformanceMarker::HostReconstructed,
            PerformanceMarker::WindowShownFocused,
        ];
        let encoded: Vec<String> = markers
            .iter()
            .map(|marker| serde_json::to_string(marker).expect("marker JSON"))
            .collect();
        assert_eq!(
            encoded,
            [
                "\"projection_cleanup_started\"",
                "\"editor_host_detached\"",
                "\"terminal_surfaces_detached\"",
                "\"agent_surfaces_detached\"",
                "\"projection_cleanup_finished\"",
                "\"reopen_worker_entered\"",
                "\"cleanup_wait_finished\"",
                "\"cleanup_wait_timed_out\"",
                "\"coordinator_reopened\"",
                "\"window_built\"",
                "\"host_reconstructed\"",
                "\"window_shown_focused\"",
            ]
        );
        assert!(encoded.iter().all(|marker| {
            !marker.contains('/') && !marker.contains(':') && marker.starts_with('\"')
        }));
    }

    #[test]
    fn clean_shutdown_rejects_marker_failure_without_claiming_clean_state() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(false));
        fs::create_dir(diagnostics.directory().join(MARKER_FILE)).unwrap();
        assert!(matches!(
            diagnostics.clean_shutdown(Duration::from_secs(2)),
            ShutdownOutcome::Failed
        ));
        assert!(matches!(
            diagnostics.shutdown(Duration::from_secs(2)),
            ShutdownOutcome::Complete | ShutdownOutcome::Failed
        ));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn repeated_concurrent_shutdown_is_single_flight_and_idempotent() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(false));
        let callers = (0..8)
            .map(|_| {
                let diagnostics = diagnostics.clone();
                std::thread::spawn(move || diagnostics.shutdown(Duration::from_secs(2)))
            })
            .collect::<Vec<_>>();
        let outcomes = callers.into_iter().map(|caller| caller.join().unwrap()).collect::<Vec<_>>();
        assert!(outcomes
            .iter()
            .all(|outcome| matches!(outcome, ShutdownOutcome::Complete | ShutdownOutcome::Failed)));
        assert!(matches!(
            diagnostics.shutdown(Duration::from_secs(2)),
            ShutdownOutcome::Complete | ShutdownOutcome::Failed
        ));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn shutdown_zero_deadline_does_not_extend_or_resend_stop() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(false));
        let first = diagnostics.shutdown(Duration::ZERO);
        let second = diagnostics.shutdown(Duration::ZERO);
        assert!(matches!(first, ShutdownOutcome::TimedOut | ShutdownOutcome::Failed));
        assert!(matches!(second, ShutdownOutcome::TimedOut | ShutdownOutcome::Failed));
        let _ = diagnostics.shutdown(Duration::from_secs(2));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn owner_drop_stops_writer_before_home_cleanup() {
        let home = temp_home();
        let owner = DiagnosticsOwner::new(Diagnostics::open(&home, "0.1.0", Some(false)));
        drop(owner);
        fs::remove_dir_all(home).expect("owner must join diagnostics writer");
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn native_action_commands_are_absolute_and_not_path_resolved() {
        assert_eq!(OPEN_COMMAND, "/usr/bin/open");
        assert_eq!(PBCOPY_COMMAND, "/usr/bin/pbcopy");
    }
}
