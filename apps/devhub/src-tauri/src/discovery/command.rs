//! Shell-free command sources for workspace discovery.
//!
//! This module deliberately stops at a provider-free, bounded result.  The
//! discovery coordinator owns candidate deduplication and event emission;
//! this adapter owns process lifetime, output limits, and path validation.

use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use devhub_app_core::config::CommandSource;
use devhub_app_core::ports::{CancellationToken, WorkspaceDiscoveryErrorCode};

/// The command source is intentionally bounded independently of the global
/// discovery event limit.  A command is allowed to emit a useful set of
/// paths, but it cannot retain unbounded process output in the app.
pub(super) const MAX_STDOUT_BYTES: usize = 1024 * 1024;
pub(super) const MAX_STDERR_BYTES: usize = 64 * 1024;
pub(super) const MAX_LINES: usize = 4096;
pub(super) const MAX_LINE_BYTES: usize = 8 * 1024;
const MIN_TIMEOUT_MS: u32 = 100;
const MAX_TIMEOUT_MS: u32 = 30_000;
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// A candidate path produced by one command line.  The selected path is the
/// user-visible spelling after leading-`~` expansion; the canonical path is
/// the stable identity used by the parent discovery coordinator.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct CommandCandidate {
    pub(super) selected_path: PathBuf,
    pub(super) canonical_path: PathBuf,
}

impl fmt::Debug for CommandCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandCandidate")
            .field("selected_path", &"<redacted>")
            .field("canonical_path", &"<redacted>")
            .finish()
    }
}

/// A parsed path or a content-free per-line diagnostic.  A malformed line
/// never aborts the other lines from the same successful invocation.
#[derive(Clone, PartialEq, Eq)]
pub(super) enum CommandRecord {
    Candidate(CommandCandidate),
    Error(WorkspaceDiscoveryErrorCode),
}

impl fmt::Debug for CommandRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Candidate(candidate) => {
                formatter.debug_tuple("Candidate").field(candidate).finish()
            }
            Self::Error(code) => formatter.debug_tuple("Error").field(code).finish(),
        }
    }
}

/// The process outcome is kept separate from per-line records.  In
/// particular, a non-zero exit, timeout, cancellation, or output limit makes
/// the invocation unusable and the parent must discard any candidate records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CommandOutcome {
    Completed,
    Unavailable,
    Failed,
    TimedOut,
    Cancelled,
    OutputLimit,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct CommandRun {
    pub(super) outcome: CommandOutcome,
    pub(super) records: Vec<CommandRecord>,
    /// Number of stderr bytes observed, capped at `MAX_STDERR_BYTES`.
    /// Content is never retained or exposed.
    pub(super) stderr_bytes: usize,
}

impl fmt::Debug for CommandRun {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandRun")
            .field("outcome", &self.outcome)
            .field("record_count", &self.records.len())
            .field("stderr_bytes", &self.stderr_bytes)
            .field("records", &self.records)
            .finish()
    }
}

impl CommandRun {
    fn new(outcome: CommandOutcome, records: Vec<CommandRecord>) -> Self {
        Self { outcome, records, stderr_bytes: 0 }
    }

    fn with_stderr(
        outcome: CommandOutcome,
        records: Vec<CommandRecord>,
        stderr_bytes: usize,
    ) -> Self {
        Self { outcome, records, stderr_bytes: stderr_bytes.min(MAX_STDERR_BYTES) }
    }
}

/// Execute exactly one configured command source.
///
/// `home` is the only working-directory input.  The command array is passed
/// directly to `std::process::Command`; no shell, login environment, or
/// string re-parsing is involved.  The returned records retain source order.
pub(super) fn run_command_source(
    source: &CommandSource,
    home: &Path,
    cancel: &CancellationToken,
) -> CommandRun {
    if cancel.is_cancelled() {
        return CommandRun::new(CommandOutcome::Cancelled, Vec::new());
    }

    let Some((executable, arguments)) = source.command.split_first() else {
        return CommandRun::new(CommandOutcome::Unavailable, Vec::new());
    };

    // Config validation enforces this range, but the process adapter is a
    // trust boundary and must remain safe when called with a constructed
    // value from native code or a future test seam.
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&source.timeout_ms) {
        return CommandRun::new(CommandOutcome::Failed, Vec::new());
    }

    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let outcome = if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
            ) {
                CommandOutcome::Unavailable
            } else {
                CommandOutcome::Failed
            };
            return CommandRun::new(outcome, Vec::new());
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => return reap_after_spawn_failure(&mut child),
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => return reap_after_spawn_failure(&mut child),
    };

    let stdout_state = Arc::new(StreamState::new(MAX_STDOUT_BYTES));
    let stderr_state = Arc::new(StreamState::new(MAX_STDERR_BYTES));
    let stdout_thread = match spawn_reader(stdout, Arc::clone(&stdout_state), true) {
        Ok(thread) => thread,
        Err(_) => {
            terminate_and_wait(&mut child);
            return CommandRun::new(CommandOutcome::Failed, Vec::new());
        }
    };
    let stderr_thread = match spawn_reader(stderr, Arc::clone(&stderr_state), false) {
        Ok(thread) => thread,
        Err(_) => {
            terminate_and_wait(&mut child);
            let _ = join_reader(stdout_thread);
            return CommandRun::new(CommandOutcome::Failed, Vec::new());
        }
    };

    let deadline = Instant::now() + Duration::from_millis(u64::from(source.timeout_ms));
    let mut interrupted = None;
    let status = loop {
        if cancel.is_cancelled() {
            interrupted = Some(CommandOutcome::Cancelled);
            terminate_and_wait(&mut child);
            break None;
        }
        if stdout_state.limit_reached() || stderr_state.limit_reached() {
            interrupted = Some(CommandOutcome::OutputLimit);
            terminate_and_wait(&mut child);
            break None;
        }
        if stdout_state.read_failed() || stderr_state.read_failed() {
            interrupted = Some(CommandOutcome::Failed);
            terminate_and_wait(&mut child);
            break None;
        }
        if Instant::now() >= deadline {
            interrupted = Some(CommandOutcome::TimedOut);
            terminate_and_wait(&mut child);
            break None;
        }

        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(_) => {
                interrupted = Some(CommandOutcome::Failed);
                terminate_and_wait(&mut child);
                break None;
            }
        }
    };

    // The child has exited or has been killed and waited for before joining
    // readers.  This order guarantees no reader is left blocked on a pipe.
    let stdout = join_reader(stdout_thread);
    let stderr = join_reader(stderr_thread);
    let stderr_bytes = stderr.byte_count.max(stderr_state.bytes_observed());
    if let Some(outcome) = interrupted {
        return CommandRun::with_stderr(outcome, Vec::new(), stderr_bytes);
    }
    if stdout.read_failed || stderr.read_failed || stderr_state.read_failed() {
        return CommandRun::with_stderr(CommandOutcome::Failed, Vec::new(), stderr_bytes);
    }
    if stdout.limit_reached || stderr.limit_reached || stderr_state.limit_reached() {
        return CommandRun::with_stderr(CommandOutcome::OutputLimit, Vec::new(), stderr_bytes);
    }

    let Some(status) = status else {
        return CommandRun::with_stderr(CommandOutcome::Failed, Vec::new(), stderr_bytes);
    };
    if !status.success() {
        return CommandRun::with_stderr(CommandOutcome::Failed, Vec::new(), stderr_bytes);
    }

    let mut run = parse_stdout(&stdout.bytes, home);
    run.stderr_bytes = stderr_bytes;
    run
}

fn reap_after_spawn_failure(child: &mut Child) -> CommandRun {
    terminate_and_wait(child);
    CommandRun::new(CommandOutcome::Failed, Vec::new())
}

fn terminate_and_wait(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

struct StreamState {
    limit: usize,
    limit_reached: AtomicBool,
    read_failed: AtomicBool,
    bytes_observed: std::sync::atomic::AtomicUsize,
}

impl StreamState {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            limit_reached: AtomicBool::new(false),
            read_failed: AtomicBool::new(false),
            bytes_observed: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn limit_reached(&self) -> bool {
        self.limit_reached.load(Ordering::Acquire)
    }

    fn read_failed(&self) -> bool {
        self.read_failed.load(Ordering::Acquire)
    }

    fn bytes_observed(&self) -> usize {
        self.bytes_observed.load(Ordering::Acquire)
    }
}

struct ReaderOutput {
    bytes: Vec<u8>,
    limit_reached: bool,
    read_failed: bool,
    byte_count: usize,
}

fn spawn_reader<R>(
    mut reader: R,
    state: Arc<StreamState>,
    retain_output: bool,
) -> io::Result<JoinHandle<ReaderOutput>>
where
    R: Read + Send + 'static,
{
    thread::Builder::new().name("devhub-discovery-command-pipe".to_owned()).spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut output = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let observed = state.bytes_observed();
                    if observed.saturating_add(count) > state.limit {
                        state.bytes_observed.store(state.limit, Ordering::Release);
                        state.limit_reached.store(true, Ordering::Release);
                        break;
                    }
                    state.bytes_observed.store(observed + count, Ordering::Release);
                    if retain_output {
                        output.extend_from_slice(&buffer[..count]);
                    }
                }
                Err(_) => {
                    state.read_failed.store(true, Ordering::Release);
                    break;
                }
            }
        }
        ReaderOutput {
            bytes: output,
            limit_reached: state.limit_reached(),
            read_failed: state.read_failed(),
            byte_count: state.bytes_observed(),
        }
    })
}

fn join_reader(handle: JoinHandle<ReaderOutput>) -> ReaderOutput {
    handle.join().unwrap_or(ReaderOutput {
        bytes: Vec::new(),
        limit_reached: false,
        read_failed: true,
        byte_count: 0,
    })
}

fn parse_stdout(stdout: &[u8], home: &Path) -> CommandRun {
    let text = match std::str::from_utf8(stdout) {
        Ok(text) => text,
        Err(_) => {
            return CommandRun::new(
                CommandOutcome::Completed,
                vec![CommandRecord::Error(WorkspaceDiscoveryErrorCode::InvalidUtf8)],
            );
        }
    };

    let mut records = Vec::new();
    for (line_count, line) in text.split_terminator('\n').enumerate() {
        if line_count >= MAX_LINES {
            return CommandRun::new(CommandOutcome::OutputLimit, Vec::new());
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_LINE_BYTES {
            return CommandRun::new(CommandOutcome::OutputLimit, Vec::new());
        }
        match validate_candidate(line, home) {
            Ok(candidate) => records.push(CommandRecord::Candidate(candidate)),
            Err(code) => records.push(CommandRecord::Error(code)),
        }
    }
    CommandRun::new(CommandOutcome::Completed, records)
}

fn validate_candidate(
    raw: &str,
    home: &Path,
) -> Result<CommandCandidate, WorkspaceDiscoveryErrorCode> {
    let selected_path = expand_leading_tilde(raw, home);
    if !selected_path.is_absolute() {
        return Err(WorkspaceDiscoveryErrorCode::InvalidCandidate);
    }
    if selected_path.to_str().is_none() {
        return Err(WorkspaceDiscoveryErrorCode::InvalidUtf8);
    }
    let metadata =
        std::fs::metadata(&selected_path).map_err(|error| map_candidate_io_error(error.kind()))?;
    if !metadata.is_dir() {
        return Err(WorkspaceDiscoveryErrorCode::InvalidCandidate);
    }
    let canonical_path = std::fs::canonicalize(&selected_path)
        .map_err(|error| map_candidate_io_error(error.kind()))?;
    if canonical_path.to_str().is_none() {
        return Err(WorkspaceDiscoveryErrorCode::InvalidUtf8);
    }
    Ok(CommandCandidate { selected_path, canonical_path })
}

fn map_candidate_io_error(kind: io::ErrorKind) -> WorkspaceDiscoveryErrorCode {
    match kind {
        io::ErrorKind::NotFound => WorkspaceDiscoveryErrorCode::InvalidCandidate,
        io::ErrorKind::PermissionDenied => WorkspaceDiscoveryErrorCode::PermissionDenied,
        _ => WorkspaceDiscoveryErrorCode::Io,
    }
}

fn expand_leading_tilde(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        home.to_path_buf()
    } else if let Some(suffix) = raw.strip_prefix("~/") {
        home.join(suffix)
    } else {
        PathBuf::from(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devhub_app_core::application::OperationId;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TempTree {
        path: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("devhub-command-{label}-{}-{sequence}", std::process::id()));
            fs::create_dir_all(&path).expect("create command temp tree");
            Self { path }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn token(number: u128) -> CancellationToken {
        let suffix = format!("{number:012x}");
        let uuid = format!("00000000-0000-4000-8000-{suffix}");
        CancellationToken::new(OperationId::from_uuid(uuid).expect("test operation ID"))
    }

    fn source(command: Vec<String>, timeout_ms: u32) -> CommandSource {
        CommandSource { id: "command-test".to_owned(), command, timeout_ms }
    }

    fn candidate_paths(run: &CommandRun) -> Vec<PathBuf> {
        run.records
            .iter()
            .filter_map(|record| match record {
                CommandRecord::Candidate(candidate) => Some(candidate.selected_path.clone()),
                CommandRecord::Error(_) => None,
            })
            .collect()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn passes_exact_argument_array_and_preserves_non_line_whitespace() {
        let tree = TempTree::new("args");
        let first = tree.path.join("first dir");
        let second = tree.path.join("second");
        fs::create_dir_all(&first).expect("first");
        fs::create_dir_all(&second).expect("second");
        let argument =
            format!("{}\n{}\r\n{}  \n", first.display(), second.display(), first.display());
        let run = run_command_source(
            &source(vec!["/usr/bin/printf".to_owned(), "%s".to_owned(), argument], 2_000),
            &tree.path,
            &token(1),
        );
        assert_eq!(run.outcome, CommandOutcome::Completed);
        let paths = candidate_paths(&run);
        assert_eq!(paths, vec![first.clone(), second.clone()]);
        assert!(run.records.iter().any(|record| matches!(
            record,
            CommandRecord::Error(WorkspaceDiscoveryErrorCode::InvalidCandidate)
        )));
        let debug = format!("{run:?}");
        assert!(!debug.contains(first.to_string_lossy().as_ref()));
        assert!(debug.contains("redacted"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launches_with_injected_home_as_the_working_directory() {
        let tree = TempTree::new("cwd");
        let run =
            run_command_source(&source(vec!["/bin/pwd".to_owned()], 2_000), &tree.path, &token(11));
        assert_eq!(run.outcome, CommandOutcome::Completed);
        assert_eq!(
            candidate_paths(&run),
            vec![fs::canonicalize(&tree.path).expect("canonical home")]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn expands_tilde_and_keeps_relative_nonexistent_and_file_lines_isolated() {
        let tree = TempTree::new("validation");
        let valid = tree.path.join("valid");
        let file = tree.path.join("file");
        fs::create_dir_all(&valid).expect("valid");
        fs::write(&file, b"file").expect("file");
        let argument =
            format!("~/valid\nrelative\n{}/missing\n{}\n", valid.display(), file.display());
        let run = run_command_source(
            &source(vec!["/usr/bin/printf".to_owned(), "%s".to_owned(), argument], 2_000),
            &tree.path,
            &token(2),
        );
        assert_eq!(run.outcome, CommandOutcome::Completed);
        assert_eq!(candidate_paths(&run), vec![tree.path.join("valid")]);
        assert_eq!(
            run.records
                .iter()
                .filter(|record| matches!(
                    record,
                    CommandRecord::Error(WorkspaceDiscoveryErrorCode::InvalidCandidate)
                ))
                .count(),
            3
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn non_zero_exit_discards_output_and_never_surfaces_stderr() {
        let tree = TempTree::new("failure");
        let valid = tree.path.join("valid");
        fs::create_dir_all(&valid).expect("valid");
        let run = run_command_source(
            &source(vec!["/usr/bin/false".to_owned()], 2_000),
            &tree.path,
            &token(3),
        );
        assert_eq!(run.outcome, CommandOutcome::Failed);
        assert!(run.records.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn strict_utf8_is_a_source_diagnostic() {
        let tree = TempTree::new("utf8");
        let run = run_command_source(
            &source(
                vec!["/usr/bin/printf".to_owned(), "%b".to_owned(), "\\377\\n".to_owned()],
                2_000,
            ),
            &tree.path,
            &token(31),
        );
        assert_eq!(run.outcome, CommandOutcome::Completed);
        assert_eq!(
            run.records,
            vec![CommandRecord::Error(WorkspaceDiscoveryErrorCode::InvalidUtf8)]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn timeout_and_cancellation_kill_and_reap_the_child() {
        let tree = TempTree::new("interrupt");
        let started = Instant::now();
        let timeout = run_command_source(
            &source(vec!["/bin/sleep".to_owned(), "30".to_owned()], 100),
            &tree.path,
            &token(4),
        );
        assert_eq!(timeout.outcome, CommandOutcome::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));

        let cancel = token(5);
        let worker_cancel = cancel.clone();
        let worker_home = tree.path.clone();
        let worker = thread::spawn(move || {
            run_command_source(
                &source(vec!["/bin/sleep".to_owned(), "30".to_owned()], 30_000),
                &worker_home,
                &worker_cancel,
            )
        });
        thread::sleep(Duration::from_millis(100));
        let cancellation_started = Instant::now();
        cancel.cancel();
        let cancellation = worker.join().expect("cancellation worker");
        assert_eq!(cancellation.outcome, CommandOutcome::Cancelled);
        assert!(cancellation_started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stdout_and_stderr_limits_are_bounded() {
        let tree = TempTree::new("limits");
        let stdout = run_command_source(
            &source(vec!["/usr/bin/yes".to_owned()], 2_000),
            &tree.path,
            &token(6),
        );
        assert_eq!(stdout.outcome, CommandOutcome::OutputLimit);

        let mut stderr_command = vec!["/bin/ls".to_owned()];
        stderr_command.extend(
            (0..(MAX_STDERR_BYTES / 64 + 128))
                .map(|index| format!("/definitely/missing/devhub-{index:060}")),
        );
        let stderr = run_command_source(&source(stderr_command, 2_000), &tree.path, &token(7));
        assert_eq!(stderr.outcome, CommandOutcome::OutputLimit);
        assert_eq!(stderr.stderr_bytes, MAX_STDERR_BYTES);
        let debug = format!("{stderr:?}");
        assert!(debug.contains("stderr_bytes"));
        assert!(!debug.contains("/definitely/missing"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn line_count_and_line_bytes_are_bounded_before_candidate_emission() {
        let tree = TempTree::new("line-limits");
        let mut many_lines = vec!["/usr/bin/printf".to_owned(), "%s".to_owned()];
        many_lines.extend((0..(MAX_LINES + 1)).map(|_| "x\n".to_owned()));
        let too_many = run_command_source(&source(many_lines, 2_000), &tree.path, &token(41));
        assert_eq!(too_many.outcome, CommandOutcome::OutputLimit);

        let too_long = run_command_source(
            &source(
                vec![
                    "/usr/bin/printf".to_owned(),
                    "%s".to_owned(),
                    format!("{}\n", "x".repeat(MAX_LINE_BYTES + 1)),
                ],
                2_000,
            ),
            &tree.path,
            &token(42),
        );
        assert_eq!(too_long.outcome, CommandOutcome::OutputLimit);
    }

    #[test]
    fn rejects_invalid_timeout_without_spawning() {
        let tree = TempTree::new("invalid-timeout");
        for timeout in [0, MIN_TIMEOUT_MS - 1, MAX_TIMEOUT_MS + 1] {
            let run = run_command_source(
                &source(vec!["/usr/bin/false".to_owned()], timeout),
                &tree.path,
                &token(8 + u128::from(timeout)),
            );
            assert_eq!(run.outcome, CommandOutcome::Failed);
            assert!(run.records.is_empty());
        }
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("test reader failure"))
        }
    }

    #[test]
    fn reader_io_failure_is_reported_and_unexpected_path_io_is_typed() {
        let state = Arc::new(StreamState::new(8));
        let output = join_reader(
            spawn_reader(FailingReader, state, false).expect("reader thread should spawn"),
        );
        assert!(output.read_failed);
        assert!(!output.limit_reached);
        assert_eq!(map_candidate_io_error(io::ErrorKind::Other), WorkspaceDiscoveryErrorCode::Io);
    }
}
