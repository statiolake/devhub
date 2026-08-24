//! Deep, local-only diagnostics owned by the native App Shell.
//!
//! The public boundary accepts only closed, content-free facts. Emission is
//! deliberately non-blocking: callers enqueue an owned record and a single
//! writer thread performs all filesystem work, rotation, and fsync.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nix::unistd::geteuid;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

pub const LOG_LIMIT_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_GENERATIONS: usize = 5;
const MAX_EVENT_BYTES: usize = 16 * 1024;
const MAX_SUMMARY_BYTES: usize = 4 * 1024;
const MAX_RECENT_CODES: usize = 16;
const QUEUE_CAPACITY: usize = 256;
const LOG_FILE: &str = "devhub.jsonl";
const MARKER_FILE: &str = "session.json";
const OPEN_COMMAND: &str = "/usr/bin/open";
const PBCOPY_COMMAND: &str = "/usr/bin/pbcopy";
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
static FALLBACK_COUNTER: AtomicU64 = AtomicU64::new(1);

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
    Health { component: Component, health: Health, code: Option<Code> },
    Error { module: Module, code: Code },
    ProviderExit { component: Component, code: Code },
    Retry { module: Module, code: Code, attempt: u32 },
    Migration { module: Module, from: u32, to: u32 },
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
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<LifecyclePhase>,
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
    directory: PathBuf,
    file: Option<File>,
}

enum Command {
    Record { bytes: Vec<u8> },
    Marker { clean: bool },
    Flush(SyncSender<bool>),
    Stop(SyncSender<bool>),
}

#[derive(Debug, Clone)]
pub struct Diagnostics {
    inner: Arc<Inner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionError {
    Unavailable,
    PermissionDenied,
    TimedOut,
}

#[derive(Debug)]
struct Inner {
    home: PathBuf,
    session_id: String,
    version: String,
    level: LogLevel,
    directory: PathBuf,
    marker_path: PathBuf,
    previous_exit: PreviousExit,
    sender: SyncSender<Command>,
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
        let marker_path = directory.join(MARKER_FILE);
        let marker_exit =
            ensure_log_directory(home).ok().and_then(|_| read_previous_marker(&directory));
        let previous_exit = reconcile_previous_exit(state_clean, marker_exit);
        let session_id = new_session_id();
        let version = version.into();
        let file = open_log(&directory).ok();
        let initial_health = if file.is_some() { 1 } else { 2 };
        let (sender, receiver) = sync_channel(QUEUE_CAPACITY);
        let inner = Arc::new(Inner {
            home: home.to_path_buf(),
            session_id,
            version,
            level: LogLevel::Info,
            directory: directory.clone(),
            marker_path,
            previous_exit,
            sender,
            health: AtomicU8::new(initial_health),
            recent_codes: Mutex::new(BTreeSet::new()),
        });
        let worker_inner = inner.clone();
        let _ = thread::Builder::new().name("devhub-diagnostics".to_owned()).spawn(move || {
            writer_loop(receiver, Writer { directory, file }, worker_inner);
        });
        let diagnostics = Self { inner };
        diagnostics.enqueue_control(Command::Marker { clean: false }, FLUSH_TIMEOUT);
        diagnostics.emit(DiagnosticEvent::Launch { previous_exit });
        if matches!(previous_exit, PreviousExit::Unclean) {
            diagnostics.emit(DiagnosticEvent::Error {
                module: Module::Diagnostics,
                code: Code::CrashRecovered,
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
    pub fn mark_clean_shutdown(&self) {
        if self.enqueue_control(Command::Marker { clean: true }, FLUSH_TIMEOUT) {
            let _ = self.flush(FLUSH_TIMEOUT);
        }
    }

    pub fn flush(&self, timeout: Duration) -> bool {
        let (ack, receiver) = sync_channel(0);
        if !self.enqueue_control(Command::Flush(ack), timeout) {
            return false;
        }
        receiver.recv_timeout(timeout).unwrap_or(false)
    }

    pub fn shutdown(&self, timeout: Duration) -> bool {
        let (ack, receiver) = sync_channel(0);
        if !self.enqueue_control(Command::Stop(ack), timeout) {
            return false;
        }
        receiver.recv_timeout(timeout).unwrap_or(false)
    }

    pub fn safe_directory(&self) -> io::Result<PathBuf> {
        ensure_log_directory(&self.inner.home)
    }

    pub fn open_log_folder(&self, timeout: Duration) -> Result<(), ActionError> {
        let directory = self.safe_directory().map_err(|_| ActionError::PermissionDenied)?;
        run_bounded(ProcessCommand::new(OPEN_COMMAND).arg(directory), timeout)
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
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            session_id: &self.inner.session_id,
            level: self.inner.level,
            event: "event",
            version: None,
            phase: None,
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
            DiagnosticEvent::Health { component, health, code } => {
                record.event = "health";
                record.component = Some(component);
                record.health = Some(health);
                record.code = code;
            }
            DiagnosticEvent::Error { module, code } => {
                record.event = "error";
                record.module = Some(module);
                record.code = Some(code);
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

    fn enqueue_control(&self, mut command: Command, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
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

fn writer_loop(receiver: Receiver<Command>, mut writer: Writer, diagnostics: Arc<Inner>) {
    while let Ok(command) = receiver.recv() {
        match command {
            Command::Record { bytes } => {
                if write_record(&mut writer, &bytes).is_err() {
                    diagnostics.health.store(2, Ordering::Release);
                    if let Ok(mut recent) = diagnostics.recent_codes.lock() {
                        recent.insert(Code::LogUnavailable);
                    }
                    writer.file = None;
                }
            }
            Command::Marker { clean } => {
                if write_marker(
                    &writer.directory,
                    &diagnostics.marker_path,
                    clean,
                    &diagnostics.session_id,
                )
                .is_err()
                {
                    diagnostics.health.store(2, Ordering::Release);
                }
            }
            Command::Flush(ack) => {
                let _ = ack.send(
                    writer.file.as_mut().map(|file| file.sync_data().is_ok()).unwrap_or(false),
                );
            }
            Command::Stop(ack) => {
                let result =
                    writer.file.as_mut().map(|file| file.sync_all().is_ok()).unwrap_or(false);
                let _ = ack.send(result);
                break;
            }
        }
    }
}

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
    if file.metadata()?.len().saturating_add(bytes.len() as u64) > LOG_LIMIT_BYTES {
        rotate(writer)?;
    }
    writer.file.as_mut().ok_or(io::ErrorKind::NotFound)?.write_all(bytes)?;
    writer.file.as_mut().ok_or(io::ErrorKind::NotFound)?.sync_data()
}

fn rotate(writer: &mut Writer) -> io::Result<()> {
    validate_rotation_entries(&writer.directory)?;
    writer.file.take();
    for generation in (1..MAX_GENERATIONS).rev() {
        let source = writer.directory.join(if generation == 1 {
            LOG_FILE.to_owned()
        } else {
            format!("{LOG_FILE}.{}", generation - 1)
        });
        let target = writer.directory.join(format!("{LOG_FILE}.{generation}"));
        if path_exists(&source) {
            fs::rename(source, target)?;
        }
    }
    writer.file = Some(open_log(&writer.directory)?);
    Ok(())
}

fn ensure_log_directory(home: &Path) -> io::Result<PathBuf> {
    validate_directory_component(home)?;
    let library = ensure_directory_component(home, Some("Library"))?;
    let logs = ensure_directory_component(&library, Some("Logs"))?;
    ensure_directory_component(&logs, Some("DevHub"))
}

fn validate_directory_component(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

fn ensure_directory_component(parent: &Path, name: Option<&str>) -> io::Result<PathBuf> {
    let path = name.map_or_else(|| parent.to_path_buf(), |name| parent.join(name));
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&path)?;
            fs::symlink_metadata(&path)?
        }
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    set_private_directory(&path)?;
    Ok(path)
}

fn open_log(directory: &Path) -> io::Result<File> {
    let directory = match fs::symlink_metadata(directory) {
        Ok(_) => ensure_directory_component(directory, None)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let home = directory
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .ok_or(io::ErrorKind::PermissionDenied)?;
            ensure_log_directory(home)?
        }
        Err(error) => return Err(error),
    };
    let path = directory.join(LOG_FILE);
    if path_exists(&path) {
        validate_private_regular(&path)?;
    }
    let file = OpenOptions::new().create(true).append(true).read(true).open(&path)?;
    set_private_file(&path)?;
    Ok(file)
}

fn validate_rotation_entries(directory: &Path) -> io::Result<()> {
    for generation in 0..=MAX_GENERATIONS {
        let path = if generation == 0 {
            directory.join(LOG_FILE)
        } else {
            directory.join(format!("{LOG_FILE}.{generation}"))
        };
        if path_exists(&path) {
            validate_private_regular(&path)?;
        }
    }
    Ok(())
}

fn validate_private_regular(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    #[cfg(unix)]
    if metadata.uid() != geteuid().as_raw() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

fn set_private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn set_private_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

fn write_marker(
    directory: &Path,
    marker_path: &Path,
    clean: bool,
    session_id: &str,
) -> io::Result<()> {
    ensure_directory_component(directory, None)?;
    if path_exists(marker_path) {
        validate_private_regular(marker_path)?;
    }
    let temp = directory
        .join(format!(".{MARKER_FILE}.tmp-{}", FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let bytes = serde_json::to_vec(&Marker { clean, session_id: session_id.to_owned() })
        .map_err(|_| io::ErrorKind::InvalidData)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
    set_private_file(&temp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    if path_exists(marker_path) {
        validate_private_regular(marker_path)?;
    }
    fs::rename(&temp, marker_path)?;
    Ok(())
}

fn read_previous_marker(directory: &Path) -> Option<PreviousExit> {
    let path = directory.join(MARKER_FILE);
    if !path_exists(&path) {
        return None;
    }
    if validate_private_regular(&path).is_err() {
        return Some(PreviousExit::Unknown);
    }
    let mut bytes = Vec::new();
    File::open(path).ok()?.take(4096).read_to_end(&mut bytes).ok()?;
    let marker = serde_json::from_slice::<Marker>(&bytes).ok()?;
    Some(if marker.clean { PreviousExit::Clean } else { PreviousExit::Unclean })
}

fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
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
        diagnostics
            .emit(DiagnosticEvent::Error { module: Module::Config, code: Code::ConfigInvalid });
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
        assert!(diagnostics.shutdown(Duration::from_secs(2)));
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
        assert!(diagnostics.shutdown(Duration::from_secs(2)));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn clean_marker_and_state_must_agree_for_clean_start() {
        let home = temp_home();
        let diagnostics = Diagnostics::open(&home, "0.1.0", Some(true));
        diagnostics.mark_clean_shutdown();
        assert!(diagnostics.shutdown(Duration::from_secs(2)));
        let next = Diagnostics::open(&home, "0.1.0", Some(true));
        assert_eq!(next.previous_exit(), PreviousExit::Clean);
        assert!(next.shutdown(Duration::from_secs(2)));
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
        assert!(validate_rotation_entries(diagnostics.directory()).is_err());
        assert!(diagnostics.shutdown(Duration::from_secs(2)));
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
        assert!(diagnostics.shutdown(Duration::from_secs(2)));
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
            assert!(diagnostics.shutdown(Duration::from_secs(2)));
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
        assert!(contents.contains("provider_exit"));
        assert!(contents.contains("migration"));
        assert!(!contents.contains("provider-id"));
        assert!(!contents.contains("/Users/"));
        assert!(diagnostics.shutdown(Duration::from_secs(2)));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn native_action_commands_are_absolute_and_not_path_resolved() {
        assert_eq!(OPEN_COMMAND, "/usr/bin/open");
        assert_eq!(PBCOPY_COMMAND, "/usr/bin/pbcopy");
    }
}
