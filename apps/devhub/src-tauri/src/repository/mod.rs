//! Native Git-backed repository resolution.
//!
//! This module owns the synchronous probe and its async adapter. The async
//! adapter owns the future and cancellation lifecycle; this native
//! seam owns only exact-argv Git execution, bounded process I/O, and the
//! conversion of Git metadata into the provider-free core value.

use std::fmt;
use std::fs::{self, File};
use std::future::Future;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::task::{Context, Poll, Waker};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::runtime::{ChildCleanup, ResolvedExecutable, RuntimeLaunchContext};
use devhub_app_core::ports::{
    CancellationToken, PortError, PortErrorCode, PortFuture, RepositoryResolution,
    RepositoryResolver,
};
use devhub_app_core::{RemoteIdentity, WorkspaceRoot};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_STDOUT_LIMIT: usize = 64 * 1024;
const DEFAULT_STDERR_LIMIT: usize = 16 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Configuration for the native Git probe. The executable is invoked
/// directly; no shell, shell expansion, or user-controlled command string is
/// involved.
#[derive(Clone)]
pub(crate) struct GitRepositoryResolverConfig {
    context: RuntimeLaunchContext,
    git_executable: Option<ResolvedExecutable>,
    pub(crate) timeout: Duration,
    pub(crate) stdout_limit_bytes: usize,
    pub(crate) stderr_limit_bytes: usize,
    pub(crate) max_remote_count: usize,
    pub(crate) max_remote_url_count: usize,
    pub(crate) max_line_bytes: usize,
    pub(crate) max_alias_count: usize,
}

impl GitRepositoryResolverConfig {
    pub(crate) fn new(context: RuntimeLaunchContext, git_executable: ResolvedExecutable) -> Self {
        Self::with_executable(context, Some(git_executable))
    }

    pub(crate) fn unavailable(context: RuntimeLaunchContext) -> Self {
        Self::with_executable(context, None)
    }

    fn with_executable(
        context: RuntimeLaunchContext,
        git_executable: Option<ResolvedExecutable>,
    ) -> Self {
        Self {
            context,
            git_executable,
            timeout: DEFAULT_TIMEOUT,
            stdout_limit_bytes: DEFAULT_STDOUT_LIMIT,
            stderr_limit_bytes: DEFAULT_STDERR_LIMIT,
            max_remote_count: 64,
            max_remote_url_count: 16,
            max_line_bytes: 16 * 1024,
            max_alias_count: 256,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

impl fmt::Debug for GitRepositoryResolverConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitRepositoryResolverConfig")
            .field("context", &self.context)
            .field("git_executable", &self.git_executable)
            .field("timeout", &self.timeout)
            .field("stdout_limit_bytes", &self.stdout_limit_bytes)
            .field("stderr_limit_bytes", &self.stderr_limit_bytes)
            .field("max_remote_count", &self.max_remote_count)
            .field("max_remote_url_count", &self.max_remote_url_count)
            .field("max_line_bytes", &self.max_line_bytes)
            .field("max_alias_count", &self.max_alias_count)
            .finish()
    }
}

/// Native repository resolver. The async adapter is worker-backed so Git
/// process I/O never runs on a UI or Tauri command thread.
#[derive(Clone)]
pub(crate) struct GitRepositoryResolver {
    config: Arc<GitRepositoryResolverConfig>,
}

impl GitRepositoryResolver {
    pub(crate) fn new(config: GitRepositoryResolverConfig) -> Self {
        Self { config: Arc::new(config) }
    }

    pub(crate) fn is_available(&self) -> bool {
        self.config.git_executable.is_some()
    }

    pub(crate) fn resolve_sync(
        &self,
        root: &WorkspaceRoot,
        cancel: &CancellationToken,
    ) -> Result<RepositoryResolution, PortError> {
        ensure_not_cancelled(cancel)?;
        if !self.is_available() {
            return Err(PortError::new(PortErrorCode::Unavailable));
        }
        let workspace = canonical_utf8_directory(root.as_path())?;
        let deadline = Instant::now() + self.config.timeout;

        let Some(paths) = self.probe_paths(&workspace, cancel, deadline)? else {
            return Ok(RepositoryResolution::not_repository());
        };
        let top_level = paths.top_level;

        let remotes = self.run(&top_level, &["remote"], cancel, deadline)?;
        if !remotes.status.success() {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let names = remote_precedence(parse_terminal_lines(
            &remotes.stdout,
            self.config.max_line_bytes,
            self.config.max_remote_count,
        )?);
        let mut aliases = Vec::new();
        let mut primary = None;

        for name in names {
            ensure_not_cancelled(cancel)?;
            let name_arg = name.as_str();
            let urls = self.run(
                &top_level,
                &["remote", "get-url", "--all", "--", name_arg],
                cancel,
                deadline,
            )?;
            // A remote can disappear between `remote` and `get-url`; isolate
            // that remote rather than losing valid identities from its peers.
            if !urls.status.success() {
                continue;
            }
            let lines = match parse_terminal_lines(
                &urls.stdout,
                self.config.max_line_bytes,
                self.config.max_remote_url_count,
            ) {
                Ok(lines) => lines,
                Err(_) => continue,
            };
            for raw_url in lines {
                let Ok(identity) = RemoteIdentity::normalize(raw_url) else {
                    continue;
                };
                if primary.is_none() {
                    primary = Some(identity.clone());
                }
                aliases.push(identity);
            }
        }

        match primary {
            Some(primary) => {
                let resolution = RepositoryResolution::associated(primary, aliases);
                if resolution.aliases().len() > self.config.max_alias_count {
                    return Err(PortError::new(PortErrorCode::Failed));
                }
                Ok(resolution)
            }
            None => Ok(RepositoryResolution::no_remote()),
        }
    }

    fn probe_paths(
        &self,
        workspace: &Path,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<Option<GitPaths>, PortError> {
        let inside =
            self.run(workspace, &["rev-parse", "--is-inside-work-tree"], cancel, deadline)?;
        if !inside.status.success() {
            return Ok(None);
        }
        let inside_lines = parse_terminal_lines(&inside.stdout, self.config.max_line_bytes, 1)?;
        if inside_lines.as_slice() != ["true"] {
            return Ok(None);
        }

        // Git may report a relative common directory for linked worktrees.
        // Request absolute output and validate both paths before any remote
        // lookup so no provider path identity crosses this adapter.
        let metadata = self.run(
            workspace,
            &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
            cancel,
            deadline,
        )?;
        if !metadata.status.success() {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let metadata_lines = parse_terminal_lines(&metadata.stdout, self.config.max_line_bytes, 2)?;
        if metadata_lines.len() != 2 {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let top_level = canonical_git_path(&metadata_lines[0])?;
        let common_dir = canonical_git_path(&metadata_lines[1])?;
        if !top_level.is_dir() || !common_dir.is_dir() || !workspace.starts_with(&top_level) {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let expected_common_dir = expected_common_dir(&top_level, self.config.max_line_bytes)?;
        if expected_common_dir != common_dir {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        Ok(Some(GitPaths { top_level, common_dir }))
    }

    fn run(
        &self,
        cwd: &Path,
        args: &[&str],
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<ProcessOutput, PortError> {
        ensure_not_cancelled(cancel)?;
        let Some(git_executable) = self.config.git_executable.as_ref() else {
            return Err(PortError::new(PortErrorCode::Unavailable));
        };
        let mut command = self.config.context.command(git_executable);
        command
            .current_dir(cwd)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(map_spawn_error)?;
        let mut cleanup = ChildCleanup::new(child.id());
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
        let output_limit_hit = Arc::new(AtomicBool::new(false));
        let read_failed = Arc::new(AtomicBool::new(false));
        let stdout_reader = match spawn_reader(
            "devhub-git-stdout",
            stdout,
            self.config.stdout_limit_bytes,
            Arc::clone(&output_limit_hit),
            Arc::clone(&read_failed),
        ) {
            Ok(reader) => reader,
            Err(error) => {
                cleanup.terminate(&mut child);
                reap_readers(None, None, Instant::now() + READER_REAP_GRACE);
                return Err(error);
            }
        };
        let stderr_reader = match spawn_reader(
            "devhub-git-stderr",
            stderr,
            self.config.stderr_limit_bytes,
            Arc::clone(&output_limit_hit),
            Arc::clone(&read_failed),
        ) {
            Ok(reader) => reader,
            Err(error) => {
                abort_and_reap(&mut child, &mut cleanup, Some(stdout_reader), None);
                return Err(error);
            }
        };

        let status = loop {
            if cancel.is_cancelled() {
                abort_and_reap(&mut child, &mut cleanup, Some(stdout_reader), Some(stderr_reader));
                return Err(PortError::new(PortErrorCode::Cancelled));
            }
            if Instant::now() >= deadline {
                abort_and_reap(&mut child, &mut cleanup, Some(stdout_reader), Some(stderr_reader));
                return Err(PortError::new(PortErrorCode::TimedOut));
            }
            if output_limit_hit.load(Ordering::Acquire) || read_failed.load(Ordering::Acquire) {
                abort_and_reap(&mut child, &mut cleanup, Some(stdout_reader), Some(stderr_reader));
                return Err(PortError::new(PortErrorCode::Failed));
            }
            let poll = match child.try_wait() {
                Ok(poll) => poll,
                Err(_) => {
                    abort_and_reap(
                        &mut child,
                        &mut cleanup,
                        Some(stdout_reader),
                        Some(stderr_reader),
                    );
                    return Err(PortError::new(PortErrorCode::Failed));
                }
            };
            match poll {
                Some(status) => break status,
                None => thread::sleep(POLL_INTERVAL),
            }
        };

        let (stdout, stderr) =
            join_readers_until(stdout_reader, stderr_reader, &mut child, &mut cleanup, deadline)?;
        if stdout.exceeded || stderr.exceeded {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        Ok(ProcessOutput { status, stdout: stdout.bytes })
    }
}

impl fmt::Debug for GitRepositoryResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("GitRepositoryResolver").field("config", &self.config).finish()
    }
}

impl RepositoryResolver for GitRepositoryResolver {
    fn resolve(
        &self,
        root: WorkspaceRoot,
        cancel: CancellationToken,
    ) -> PortFuture<RepositoryResolution> {
        let resolver = self.clone();
        let state = Arc::new(Mutex::new(RepositoryFutureState { result: None, waker: None }));
        let worker_state = Arc::clone(&state);
        let worker_cancel = cancel.clone();
        let worker =
            thread::Builder::new().name("devhub-git-resolve".to_owned()).spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    resolver.resolve_sync(&root, &worker_cancel)
                }))
                .unwrap_or_else(|_| Err(PortError::new(PortErrorCode::Failed)));
                complete_repository_future(&worker_state, result);
            });
        let worker = match worker {
            Ok(worker) => worker,
            Err(_) => {
                return Box::pin(async { Err(PortError::new(PortErrorCode::Unavailable)) });
            }
        };
        Box::pin(RepositoryFuture {
            state,
            cancel: Some(cancel),
            worker: Some(worker),
            completed: false,
        })
    }
}

struct RepositoryFutureState {
    result: Option<Result<RepositoryResolution, PortError>>,
    waker: Option<Waker>,
}

struct RepositoryFuture {
    state: Arc<Mutex<RepositoryFutureState>>,
    cancel: Option<CancellationToken>,
    worker: Option<JoinHandle<()>>,
    completed: bool,
}

impl Future for RepositoryFuture {
    type Output = Result<RepositoryResolution, PortError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let ready = self.state.lock().ok().and_then(|mut state| {
            if state.result.is_some() {
                state.waker = None;
                state.result.take()
            } else {
                state.waker = Some(context.waker().clone());
                None
            }
        });
        let Some(result) = ready else {
            return Poll::Pending;
        };
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.cancel.take();
        self.completed = true;
        Poll::Ready(result)
    }
}

impl Drop for RepositoryFuture {
    fn drop(&mut self) {
        let finished =
            self.completed || self.state.lock().ok().is_some_and(|state| state.result.is_some());
        if finished {
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            return;
        }
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
        if let Some(worker) = self.worker.take() {
            let _ = thread::Builder::new().name("devhub-git-reaper".to_owned()).spawn(move || {
                let _ = worker.join();
            });
        }
    }
}

fn complete_repository_future(
    state: &Arc<Mutex<RepositoryFutureState>>,
    result: Result<RepositoryResolution, PortError>,
) {
    let waker = state.lock().ok().and_then(|mut state| {
        state.result = Some(result);
        state.waker.take()
    });
    if let Some(waker) = waker {
        waker.wake();
    }
}

struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
}

struct GitPaths {
    top_level: PathBuf,
    #[cfg_attr(not(test), allow(dead_code))]
    common_dir: PathBuf,
}

struct ReaderOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}

const READER_REAP_GRACE: Duration = Duration::from_millis(100);

fn spawn_reader<R>(
    name: &str,
    reader: R,
    limit: usize,
    output_limit_hit: Arc<AtomicBool>,
    read_failed: Arc<AtomicBool>,
) -> Result<JoinHandle<io::Result<ReaderOutput>>, PortError>
where
    R: Read + Send + 'static,
{
    thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let result = read_bounded(reader, limit);
            match &result {
                Ok(output) if output.exceeded => {
                    output_limit_hit.store(true, Ordering::Release);
                }
                Err(_) => {
                    read_failed.store(true, Ordering::Release);
                }
                _ => {}
            }
            result
        })
        .map_err(|_| PortError::new(PortErrorCode::Failed))
}

fn read_bounded(mut reader: impl Read, limit: usize) -> io::Result<ReaderOutput> {
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    let mut bytes_read = 0_usize;
    let mut exceeded = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(read);
        let remaining = limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        if bytes_read > limit {
            exceeded = true;
            break;
        }
    }
    Ok(ReaderOutput { bytes, exceeded })
}

fn join_reader(reader: JoinHandle<io::Result<ReaderOutput>>) -> Result<ReaderOutput, PortError> {
    reader
        .join()
        .map_err(|_| PortError::new(PortErrorCode::Failed))?
        .map_err(|_| PortError::new(PortErrorCode::Failed))
}

fn join_readers_until(
    stdout_reader: JoinHandle<io::Result<ReaderOutput>>,
    stderr_reader: JoinHandle<io::Result<ReaderOutput>>,
    child: &mut Child,
    cleanup: &mut ChildCleanup,
    deadline: Instant,
) -> Result<(ReaderOutput, ReaderOutput), PortError> {
    let mut stdout_reader = Some(stdout_reader);
    let mut stderr_reader = Some(stderr_reader);
    let mut stdout = None;
    let mut stderr = None;
    loop {
        if stdout.is_none() && stdout_reader.as_ref().is_some_and(JoinHandle::is_finished) {
            let result = join_reader(stdout_reader.take().expect("reader handle"));
            match result {
                Ok(result) => stdout = Some(result),
                Err(error) => {
                    cleanup.terminate(child);
                    reap_readers(stdout_reader, stderr_reader, Instant::now() + READER_REAP_GRACE);
                    return Err(error);
                }
            }
        }
        if stderr.is_none() && stderr_reader.as_ref().is_some_and(JoinHandle::is_finished) {
            let result = join_reader(stderr_reader.take().expect("reader handle"));
            match result {
                Ok(result) => stderr = Some(result),
                Err(error) => {
                    cleanup.terminate(child);
                    reap_readers(stdout_reader, stderr_reader, Instant::now() + READER_REAP_GRACE);
                    return Err(error);
                }
            }
        }
        if stdout.is_some() && stderr.is_some() {
            return Ok((
                stdout.take().expect("stdout result"),
                stderr.take().expect("stderr result"),
            ));
        }
        if Instant::now() >= deadline {
            cleanup.terminate(child);
            reap_readers(stdout_reader, stderr_reader, Instant::now() + READER_REAP_GRACE);
            return Err(PortError::new(PortErrorCode::TimedOut));
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn abort_and_reap(
    child: &mut Child,
    cleanup: &mut ChildCleanup,
    stdout_reader: Option<JoinHandle<io::Result<ReaderOutput>>>,
    stderr_reader: Option<JoinHandle<io::Result<ReaderOutput>>>,
) {
    cleanup.terminate(child);
    reap_readers(stdout_reader, stderr_reader, Instant::now() + READER_REAP_GRACE);
}

fn reap_readers(
    stdout_reader: Option<JoinHandle<io::Result<ReaderOutput>>>,
    stderr_reader: Option<JoinHandle<io::Result<ReaderOutput>>>,
    deadline: Instant,
) {
    let readers = [stdout_reader, stderr_reader];
    while readers.iter().flatten().any(|reader| !reader.is_finished()) && Instant::now() < deadline
    {
        thread::sleep(POLL_INTERVAL);
    }
    for reader in readers.into_iter().flatten() {
        if reader.is_finished() {
            let _ = reader.join();
        } else {
            let _ = thread::Builder::new().name("devhub-git-reader-reaper".to_owned()).spawn(
                move || {
                    let _ = reader.join();
                },
            );
        }
    }
}

fn ensure_not_cancelled(cancel: &CancellationToken) -> Result<(), PortError> {
    if cancel.is_cancelled() {
        Err(PortError::new(PortErrorCode::Cancelled))
    } else {
        Ok(())
    }
}

fn map_spawn_error(error: io::Error) -> PortError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => PortErrorCode::Unavailable,
        io::ErrorKind::PermissionDenied => PortErrorCode::Incompatible,
        _ => PortErrorCode::Failed,
    };
    PortError::new(code)
}

fn canonical_utf8_directory(path: &Path) -> Result<PathBuf, PortError> {
    let canonical =
        std::fs::canonicalize(path).map_err(|_| PortError::new(PortErrorCode::Unavailable))?;
    if !canonical.is_dir() || !canonical.is_absolute() || canonical.to_str().is_none() {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    Ok(canonical)
}

fn canonical_git_path(reported: &str) -> Result<PathBuf, PortError> {
    if reported.is_empty() || reported.contains('\0') {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    let reported = Path::new(reported);
    if !reported.is_absolute() {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    let canonical =
        std::fs::canonicalize(reported).map_err(|_| PortError::new(PortErrorCode::Failed))?;
    if !canonical.is_absolute() || canonical.to_str().is_none() {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    Ok(canonical)
}

fn expected_common_dir(top_level: &Path, max_line_bytes: usize) -> Result<PathBuf, PortError> {
    let git_entry = top_level.join(".git");
    let metadata = fs::metadata(&git_entry).map_err(|_| PortError::new(PortErrorCode::Failed))?;
    let git_directory = if metadata.is_dir() {
        canonical_existing_directory(&git_entry)?
    } else if metadata.is_file() {
        let contents = read_bounded_file(&git_entry, max_line_bytes)?;
        let lines = parse_terminal_lines(&contents, max_line_bytes, 1)?;
        let gitdir = lines
            .first()
            .and_then(|line| line.strip_prefix("gitdir: "))
            .filter(|path| !path.is_empty())
            .ok_or_else(|| PortError::new(PortErrorCode::Failed))?;
        let gitdir_path = Path::new(gitdir);
        let gitdir_path = if gitdir_path.is_absolute() {
            gitdir_path.to_path_buf()
        } else {
            top_level.join(gitdir_path)
        };
        canonical_existing_directory(&gitdir_path)?
    } else {
        return Err(PortError::new(PortErrorCode::Failed));
    };

    let commondir_file = git_directory.join("commondir");
    let commondir_metadata = match fs::metadata(&commondir_file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(git_directory),
        Err(_) => return Err(PortError::new(PortErrorCode::Failed)),
    };
    if !commondir_metadata.is_file() {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    let contents = read_bounded_file(&commondir_file, max_line_bytes)?;
    let lines = parse_terminal_lines(&contents, max_line_bytes, 1)?;
    let path = lines
        .first()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| PortError::new(PortErrorCode::Failed))?;
    let path = Path::new(path);
    let path = if path.is_absolute() { path.to_path_buf() } else { git_directory.join(path) };
    canonical_existing_directory(&path)
}

fn canonical_existing_directory(path: &Path) -> Result<PathBuf, PortError> {
    let canonical =
        std::fs::canonicalize(path).map_err(|_| PortError::new(PortErrorCode::Failed))?;
    if !canonical.is_absolute() || !canonical.is_dir() || canonical.to_str().is_none() {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    Ok(canonical)
}

fn read_bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>, PortError> {
    let file = File::open(path).map_err(|_| PortError::new(PortErrorCode::Failed))?;
    let output = read_bounded(file, limit).map_err(|_| PortError::new(PortErrorCode::Failed))?;
    if output.exceeded {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    Ok(output.bytes)
}

/// Parse command output without lossy conversion. Only terminal CR/LF framing
/// is removed; all other whitespace is retained for URL validation.
fn parse_terminal_lines(
    bytes: &[u8],
    max_line_bytes: usize,
    max_lines: usize,
) -> Result<Vec<String>, PortError> {
    let text = std::str::from_utf8(bytes).map_err(|_| PortError::new(PortErrorCode::Failed))?;
    if text.contains('\0') {
        return Err(PortError::new(PortErrorCode::Failed));
    }
    let has_terminal_newline = text.ends_with('\n');
    let mut parsed = Vec::new();
    let mut lines = text.split('\n').peekable();
    while let Some(raw_line) = lines.next() {
        if has_terminal_newline && lines.peek().is_none() && raw_line.is_empty() {
            break;
        }
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.len() > max_line_bytes || parsed.len() == max_lines {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        parsed.push(line.to_owned());
    }
    Ok(parsed)
}

fn remote_precedence(mut names: Vec<String>) -> Vec<String> {
    names.retain(|name| !name.is_empty());
    names.sort();
    names.dedup();
    names.sort_by_key(|name| match name.as_str() {
        "origin" => (0_u8, String::new()),
        "upstream" => (1_u8, String::new()),
        _ => (2_u8, name.clone()),
    });
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::task::Waker;
    use std::time::{SystemTime, UNIX_EPOCH};

    use devhub_app_core::ports::RepositoryResolutionState;
    use devhub_app_core::{OperationId, WorkspaceRoot};

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let stamp =
                SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock").as_nanos();
            let path =
                std::env::temp_dir().join(format!("devhub-{label}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&path).expect("create test directory");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut future = Box::pin(future);
        loop {
            if let Poll::Ready(result) = future.as_mut().poll(&mut context) {
                return result;
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn token(seed: u8) -> CancellationToken {
        let id = format!("00000000-0000-4000-8000-{seed:012x}");
        CancellationToken::new(OperationId::from_uuid(id).expect("test operation ID"))
    }

    fn root(path: &Path) -> WorkspaceRoot {
        WorkspaceRoot::new(fs::canonicalize(path).expect("canonical test root")).expect("root")
    }

    fn git(cwd: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git").current_dir(cwd).args(args).output().expect("git executable")
    }

    fn git_ok(cwd: &Path, args: &[&str]) {
        let output = git(cwd, args);
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(directory: &TestDirectory) {
        git_ok(directory.path(), &["init", "--quiet"]);
        git_ok(directory.path(), &["config", "user.email", "devhub@example.invalid"]);
        git_ok(directory.path(), &["config", "user.name", "DevHub Test"]);
        fs::write(directory.path().join("README"), "test\n").expect("write test file");
        git_ok(directory.path(), &["add", "README"]);
        git_ok(directory.path(), &["commit", "--quiet", "-m", "initial"]);
    }

    fn resolver() -> GitRepositoryResolver {
        GitRepositoryResolver::new(test_config(PathBuf::from("git")))
    }

    fn test_config(path: PathBuf) -> GitRepositoryResolverConfig {
        let home = std::env::current_dir().expect("test current directory");
        let context = RuntimeLaunchContext::new(home, std::env::vars_os().collect())
            .expect("test runtime context");
        let executable = if path == Path::new("git") {
            context.resolve("git").expect("test git executable")
        } else {
            ResolvedExecutable::for_test(path)
        };
        GitRepositoryResolverConfig::new(context, executable)
    }

    fn executable_script(directory: &TestDirectory, name: &str, body: &str) -> PathBuf {
        // This is a test-only executable fixture. Production invokes the
        // configured Git path directly and never invokes a shell.
        let path = directory.path().join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write executable fixture");
        let mut permissions = fs::metadata(&path).expect("fixture metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("make executable fixture");
        path
    }

    #[test]
    fn resolves_normal_repo_from_nested_directory_and_canonical_paths() {
        let directory = TestDirectory::new("nested");
        init_repo(&directory);
        git_ok(directory.path(), &["remote", "add", "origin", "https://GitHub.com/Owner/Repo.git"]);
        let nested = directory.path().join("src").join("nested");
        fs::create_dir_all(&nested).expect("nested directory");
        let resolver = resolver();
        let cancel = token(1);
        let resolution = resolver.resolve_sync(&root(&nested), &cancel).expect("resolve repo");
        assert_eq!(resolution.state(), RepositoryResolutionState::Associated);
        assert_eq!(resolution.primary_remote().unwrap().as_str(), "github.com/owner/repo");
        let paths = resolver
            .probe_paths(
                &fs::canonicalize(&nested).expect("nested canonical"),
                &cancel,
                Instant::now() + Duration::from_secs(5),
            )
            .expect("probe paths")
            .expect("inside worktree");
        assert_eq!(paths.top_level, fs::canonicalize(directory.path()).unwrap());
        assert_eq!(paths.common_dir, fs::canonicalize(directory.path().join(".git")).unwrap());
    }

    #[test]
    fn linked_worktree_has_distinct_root_and_shared_common_dir_and_remote() {
        let directory = TestDirectory::new("worktree");
        init_repo(&directory);
        git_ok(directory.path(), &["remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
        let linked =
            directory.path().with_file_name(format!("{}-linked", directory.path().display()));
        git_ok(
            directory.path(),
            &["worktree", "add", "--quiet", linked.to_str().unwrap(), "-b", "feature"],
        );
        let resolver = resolver();
        let cancel = token(2);
        let main_resolution =
            resolver.resolve_sync(&root(directory.path()), &cancel).expect("main repo");
        let linked_resolution =
            resolver.resolve_sync(&root(&linked), &cancel).expect("linked repo");
        assert_eq!(main_resolution.primary_remote(), linked_resolution.primary_remote());
        let main_paths = resolver
            .probe_paths(
                &fs::canonicalize(directory.path()).unwrap(),
                &cancel,
                Instant::now() + Duration::from_secs(5),
            )
            .expect("main paths")
            .unwrap();
        let linked_paths = resolver
            .probe_paths(
                &fs::canonicalize(&linked).unwrap(),
                &cancel,
                Instant::now() + Duration::from_secs(5),
            )
            .expect("linked paths")
            .unwrap();
        assert_ne!(main_paths.top_level, linked_paths.top_level);
        assert_eq!(main_paths.common_dir, linked_paths.common_dir);
        let _ = fs::remove_dir_all(linked);
    }

    #[test]
    fn remote_precedence_and_multiple_url_deduplication_are_stable() {
        let directory = TestDirectory::new("precedence");
        init_repo(&directory);
        git_ok(directory.path(), &["remote", "add", "zzz", "https://example.com/z/repo.git"]);
        git_ok(
            directory.path(),
            &["remote", "add", "upstream", "https://example.com/upstream/repo.git"],
        );
        git_ok(directory.path(), &["remote", "add", "origin", "https://GitHub.com/Owner/Repo.git"]);
        git_ok(
            directory.path(),
            &["remote", "set-url", "--add", "origin", "git@github.com:owner/repo.git"],
        );
        git_ok(directory.path(), &["remote", "add", "aaa", "https://example.com/a/repo.git"]);
        let resolution =
            resolver().resolve_sync(&root(directory.path()), &token(3)).expect("resolve remotes");
        assert_eq!(resolution.state(), RepositoryResolutionState::Associated);
        assert_eq!(resolution.primary_remote().unwrap().as_str(), "github.com/owner/repo");
        assert_eq!(resolution.aliases().len(), 4);
        assert!(resolution.aliases().iter().any(|alias| alias.as_str() == "example.com/a/repo"));
        assert!(resolution
            .aliases()
            .iter()
            .any(|alias| alias.as_str() == "example.com/upstream/repo"));
        assert!(resolution.aliases().iter().any(|alias| alias.as_str() == "example.com/z/repo"));
    }

    #[test]
    fn invalid_remote_url_isolated_from_valid_remote() {
        let directory = TestDirectory::new("invalid-remote");
        init_repo(&directory);
        git_ok(directory.path(), &["remote", "add", "origin", "not a url"]);
        git_ok(
            directory.path(),
            &["remote", "add", "upstream", "https://example.com/valid/repo.git"],
        );
        let resolution =
            resolver().resolve_sync(&root(directory.path()), &token(4)).expect("resolve remotes");
        assert_eq!(resolution.primary_remote().unwrap().as_str(), "example.com/valid/repo");
    }

    #[test]
    fn duplicate_heavy_remote_output_is_deduped_by_core_before_alias_limit() {
        let workspace = TestDirectory::new("duplicate-remotes");
        fs::create_dir_all(workspace.path().join(".git")).expect("git directory");
        let fake = executable_script(
            &workspace,
            "duplicate-git",
            &format!(
                r#"if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then
printf 'true\n'
elif [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then
printf '%s\n%s\n' "$PWD" "$PWD/.git"
elif [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then
for index in $(seq 1 {}); do printf 'https://example.com/owner/repo.git\n'; done
elif [ "$1" = "remote" ]; then
printf 'origin\n'
fi"#,
                16
            ),
        );
        let mut config = test_config(fake);
        config.max_alias_count = 1;
        let resolver = GitRepositoryResolver::new(config);

        let resolution = resolver
            .resolve_sync(&root(workspace.path()), &token(13))
            .expect("duplicate remote output remains one identity");
        assert_eq!(resolution.state(), RepositoryResolutionState::Associated);
        assert_eq!(resolution.aliases().len(), 1);
        assert_eq!(resolution.primary_remote().unwrap().as_str(), "example.com/owner/repo");
    }

    #[test]
    fn no_remote_and_non_git_states_are_distinct() {
        let repository = TestDirectory::new("no-remote");
        init_repo(&repository);
        let plain = TestDirectory::new("plain");
        let resolver = resolver();
        assert_eq!(
            resolver.resolve_sync(&root(repository.path()), &token(5)).unwrap().state(),
            RepositoryResolutionState::NoRemote
        );
        assert_eq!(
            resolver.resolve_sync(&root(plain.path()), &token(6)).unwrap().state(),
            RepositoryResolutionState::NotRepository
        );
    }

    #[test]
    fn missing_git_executable_is_unavailable() {
        let directory = TestDirectory::new("missing-git");
        let resolver =
            GitRepositoryResolver::new(test_config(directory.path().join("missing-git")));
        let error = resolver.resolve_sync(&root(directory.path()), &token(7)).unwrap_err();
        assert_eq!(error.code(), PortErrorCode::Unavailable);
    }

    #[test]
    fn unrelated_existing_git_metadata_is_rejected_at_the_filesystem_boundary() {
        let workspace = TestDirectory::new("metadata-workspace");
        init_repo(&workspace);
        let unrelated = TestDirectory::new("metadata-unrelated");
        init_repo(&unrelated);
        let fake = executable_script(
            &workspace,
            "fake-git",
            &format!(
                r#"if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then
printf 'true\n'
elif [ "$1" = "rev-parse" ]; then
printf '%s\n%s\n' "{}" "{}"
else
printf '\n'
fi"#,
                unrelated.path().display(),
                unrelated.path().join(".git").display()
            ),
        );
        let resolver = GitRepositoryResolver::new(test_config(fake));
        let error = resolver.resolve_sync(&root(workspace.path()), &token(12)).unwrap_err();
        assert_eq!(error.code(), PortErrorCode::Failed);
    }

    #[test]
    fn parser_is_strict_and_limits_lines() {
        assert_eq!(
            parse_terminal_lines(b"one\r\ntwo\n", 8, 2).unwrap(),
            vec!["one".to_owned(), "two".to_owned()]
        );
        assert!(parse_terminal_lines(b"\xff", 8, 2).is_err());
        assert!(parse_terminal_lines(b"12345\n", 4, 2).is_err());
        assert!(parse_terminal_lines(b"one\ntwo\n", 8, 1).is_err());
        let bounded = read_bounded(Cursor::new(b"abcdef"), 3).expect("bounded output");
        assert!(bounded.exceeded);
        assert_eq!(bounded.bytes, b"abc");
    }

    #[test]
    fn direct_runner_times_out_without_shell() {
        let directory = TestDirectory::new("timeout");
        let resolver = GitRepositoryResolver::new(
            test_config(PathBuf::from("/bin/sleep")).with_timeout(Duration::from_millis(50)),
        );
        let cancel = token(8);
        let result = resolver.run(
            directory.path(),
            &["2"],
            &cancel,
            Instant::now() + Duration::from_millis(50),
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("sleep process unexpectedly completed"),
        };
        assert_eq!(error.code(), PortErrorCode::TimedOut);
    }

    #[test]
    fn successful_async_resolution_does_not_cancel_token() {
        let directory = TestDirectory::new("async-success");
        init_repo(&directory);
        let cancel = token(9);
        let future = resolver().resolve(root(directory.path()), cancel.clone());
        let result = block_on(future).expect("async resolution");
        assert_eq!(result.state(), RepositoryResolutionState::NoRemote);
        assert!(!cancel.is_cancelled());
    }

    #[test]
    fn dropping_in_flight_resolution_cancels_and_returns_promptly() {
        let directory = TestDirectory::new("async-drop");
        let executable = executable_script(&directory, "slow-git", "sleep 30");
        let resolver = GitRepositoryResolver::new(
            test_config(executable).with_timeout(Duration::from_secs(30)),
        );
        let cancel = token(10);
        let future = resolver.resolve(root(directory.path()), cancel.clone());
        thread::sleep(Duration::from_millis(30));
        let started = Instant::now();
        drop(future);
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(cancel.is_cancelled());
        thread::sleep(Duration::from_millis(150));
    }

    #[test]
    fn descendant_holding_pipes_is_killed_as_a_process_group() {
        let directory = TestDirectory::new("process-group");
        let executable = executable_script(&directory, "forking-git", "sleep 30 &\nprintf hold");
        let resolver = GitRepositoryResolver::new(
            test_config(executable).with_timeout(Duration::from_millis(100)),
        );
        let cancel = token(11);
        let started = Instant::now();
        let result = resolver.resolve_sync(&root(directory.path()), &cancel);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(result.unwrap_err().code(), PortErrorCode::TimedOut);
    }

    #[test]
    fn debug_output_redacts_executable_path() {
        let secret = "/private/secret/devhub-git";
        let resolver = GitRepositoryResolver::new(test_config(PathBuf::from(secret)));
        let debug = format!("{resolver:?}");
        assert!(!debug.contains(secret));
    }
}
