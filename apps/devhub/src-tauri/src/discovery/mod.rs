//! Workspace discovery is the native owner of source traversal, cancellation,
//! deduplication, and picker projection.
//!
//! The core port exposes only provider-free configuration values, domain
//! candidates, and an object-safe event sink. Filesystem/process details stay
//! in this module so callers cannot reproduce source ordering or error rules.

use std::collections::BTreeSet;
use std::fs::{self, DirEntry, Metadata};
use std::future::Future;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::thread::JoinHandle;

mod command;

use devhub_app_core::config::{
    CommandSource, Config, FilesystemSource, WorkspaceKind, WorkspaceSource,
};
use devhub_app_core::domain::{DisplayPath, WorkspaceRoot};
use devhub_app_core::ports::{
    CancellationToken, PortError, PortErrorCode, PortFuture, WorkspaceDiscovery as DiscoveryPort,
    WorkspaceDiscoveryErrorCode, WorkspaceDiscoveryEvent, WorkspaceDiscoveryEventKind,
    WorkspaceDiscoverySink, WorkspaceDiscoverySummary, WorkspaceSearchProjection,
};

const MAX_CANDIDATES: u32 = 10_000;
const MAX_EVENTS: u32 = 20_000;
const MAX_PROJECTION_BYTES: usize = 8 * 1024;
const MAX_DEPTH: u8 = 16;

#[derive(Debug, Clone, Copy)]
pub struct DiscoveryLimits {
    pub max_candidates: u32,
    pub max_events: u32,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self { max_candidates: MAX_CANDIDATES, max_events: MAX_EVENTS }
    }
}

/// The configured native discovery engine. Traversal and command execution
/// are added here without changing the provider-free port contract.
#[derive(Clone)]
pub struct DiscoveryEngine {
    sources: Vec<WorkspaceSource>,
    home: PathBuf,
    limits: DiscoveryLimits,
}

impl DiscoveryEngine {
    pub fn new(config: &Config, home: impl Into<PathBuf>) -> Self {
        Self::with_limits(config, home, DiscoveryLimits::default())
    }

    pub fn with_limits(config: &Config, home: impl Into<PathBuf>, limits: DiscoveryLimits) -> Self {
        Self {
            sources: config.workspace_sources.clone(),
            home: home.into(),
            limits: DiscoveryLimits {
                max_candidates: limits.max_candidates.max(1),
                max_events: limits.max_events.max(1),
            },
        }
    }

    pub fn scan(
        &self,
        cancel: &CancellationToken,
        sink: &dyn WorkspaceDiscoverySink,
    ) -> WorkspaceDiscoverySummary {
        let mut state = ScanState {
            sink,
            operation_id: cancel.operation_id().clone(),
            limits: self.limits,
            seen: BTreeSet::new(),
            summary: WorkspaceDiscoverySummary::default(),
            event_count: 0,
            next_sequence: 0,
            stop_requested: false,
        };
        // Sources run sequentially by configured order. This keeps first-source
        // ownership deterministic: a command's candidates are only eligible
        // after the process exits successfully, and later sources cannot race
        // the global canonical dedupe ledger.
        for source in &self.sources {
            let mut run = SourceRun::default();
            state.summary.source_count = state.summary.source_count.saturating_add(1);
            if cancel.is_cancelled() {
                state.cancelled(source.id(), cancel);
                state.finish(source.id(), &run);
                break;
            }
            let cancelled = match source {
                WorkspaceSource::Filesystem(filesystem) => {
                    self.scan_filesystem(filesystem, cancel, &mut state, &mut run)
                }
                WorkspaceSource::Command(command) => {
                    self.scan_command(command, cancel, &mut state, &mut run)
                }
            };
            if cancelled || cancel.is_cancelled() {
                state.cancelled(source.id(), cancel);
                state.finish(source.id(), &run);
                break;
            }
            state.finish(source.id(), &run);
            if state.stop_requested {
                break;
            }
        }
        state.summary
    }

    fn scan_filesystem(
        &self,
        source: &FilesystemSource,
        cancel: &CancellationToken,
        state: &mut ScanState<'_>,
        run: &mut SourceRun,
    ) -> bool {
        let selected_root = match expand_source_path(&source.path, &self.home) {
            Some(path) if path.is_absolute() => path,
            _ => {
                state.error(&source.id, run, WorkspaceDiscoveryErrorCode::InvalidCandidate);
                return false;
            }
        };
        if !is_utf8_path(&selected_root) {
            state.error(&source.id, run, WorkspaceDiscoveryErrorCode::InvalidUtf8);
            return false;
        }
        let metadata = match fs::metadata(&selected_root) {
            Ok(metadata) if metadata.is_dir() => metadata,
            Ok(_) => {
                state.error(&source.id, run, WorkspaceDiscoveryErrorCode::SourceUnavailable);
                return false;
            }
            Err(error) => {
                state.error(&source.id, run, io_error_code(&error));
                return false;
            }
        };
        let canonical_root = match fs::canonicalize(&selected_root) {
            Ok(path) if is_utf8_path(&path) => path,
            Ok(_) => {
                state.error(&source.id, run, WorkspaceDiscoveryErrorCode::InvalidUtf8);
                return false;
            }
            Err(error) => {
                state.error(&source.id, run, io_error_code(&error));
                return false;
            }
        };
        // A real directory can be reachable through a bind mount or another
        // filesystem alias even without following a symlink. Keep recursion
        // bounded by canonical directory identity as well as by max_depth.
        run.visited_directories.insert(canonical_root.clone());
        let max_depth = source.max_depth.unwrap_or(source.min_depth).min(MAX_DEPTH);
        if source.max_depth.unwrap_or(source.min_depth) > MAX_DEPTH {
            state.mark_truncated();
        }
        let mut context = WalkContext { source_id: &source.id, source, cancel, state, run };
        if self.consider_filesystem_path(
            &selected_root,
            &canonical_root,
            &metadata,
            0,
            &mut context,
        ) {
            return true;
        }
        self.walk_filesystem(&selected_root, 0, max_depth, &mut context)
    }

    fn scan_command(
        &self,
        source: &CommandSource,
        cancel: &CancellationToken,
        state: &mut ScanState<'_>,
        run: &mut SourceRun,
    ) -> bool {
        let command_run = command::run_command_source(source, &self.home, cancel);
        run.stderr_bytes = u32::try_from(command_run.stderr_bytes).unwrap_or(u32::MAX);
        match command_run.outcome {
            command::CommandOutcome::Cancelled => return true,
            command::CommandOutcome::Unavailable => {
                state.error(&source.id, run, WorkspaceDiscoveryErrorCode::CommandUnavailable);
                return false;
            }
            command::CommandOutcome::Failed => {
                state.error(&source.id, run, WorkspaceDiscoveryErrorCode::CommandFailed);
                return false;
            }
            command::CommandOutcome::TimedOut => {
                state.error(&source.id, run, WorkspaceDiscoveryErrorCode::CommandTimedOut);
                return false;
            }
            command::CommandOutcome::OutputLimit => {
                state.mark_truncated();
                state.error(&source.id, run, WorkspaceDiscoveryErrorCode::OutputLimit);
                return false;
            }
            command::CommandOutcome::Completed => {}
        }
        for record in command_run.records {
            if cancel.is_cancelled() {
                return true;
            }
            match record {
                command::CommandRecord::Candidate(candidate) => {
                    state.candidate(
                        &source.id,
                        &candidate.selected_path,
                        &candidate.canonical_path,
                        run,
                    );
                    if state.stop_requested {
                        return false;
                    }
                }
                command::CommandRecord::Error(code) => state.error(&source.id, run, code),
            }
            if state.stop_requested {
                return false;
            }
        }
        false
    }

    fn walk_filesystem(
        &self,
        selected_path: &Path,
        depth: u8,
        max_depth: u8,
        context: &mut WalkContext<'_, '_>,
    ) -> bool {
        if depth >= max_depth || context.cancel.is_cancelled() || context.state.stop_requested {
            return context.cancel.is_cancelled();
        }
        let read_dir = match fs::read_dir(selected_path) {
            Ok(entries) => entries,
            Err(error) => {
                context.state.error(context.source_id, context.run, io_error_code(&error));
                return false;
            }
        };
        let mut entries = Vec::new();
        for entry in read_dir {
            if context.cancel.is_cancelled() || context.state.stop_requested {
                return context.cancel.is_cancelled();
            }
            match entry {
                Ok(entry) => entries.push(entry),
                Err(error) => {
                    context.state.error(context.source_id, context.run, io_error_code(&error))
                }
            }
        }
        entries.sort_by_key(DirEntry::path);
        for entry in entries {
            if context.cancel.is_cancelled() || context.state.stop_requested {
                return context.cancel.is_cancelled();
            }
            let name = entry.file_name();
            let name = match name.to_str() {
                Some(name) => name,
                None => {
                    context.state.error(
                        context.source_id,
                        context.run,
                        WorkspaceDiscoveryErrorCode::InvalidUtf8,
                    );
                    continue;
                }
            };
            if (!context.source.include_hidden && name.starts_with('.'))
                || context.source.exclude_names.iter().any(|excluded| excluded == name)
            {
                continue;
            }
            let child_selected = entry.path();
            let metadata = match fs::metadata(&child_selected) {
                Ok(metadata) if metadata.is_dir() => metadata,
                Ok(_) => continue,
                Err(error) => {
                    context.state.error(context.source_id, context.run, io_error_code(&error));
                    continue;
                }
            };
            let canonical = match fs::canonicalize(&child_selected) {
                Ok(path) if is_utf8_path(&path) => path,
                Ok(_) => {
                    context.state.error(
                        context.source_id,
                        context.run,
                        WorkspaceDiscoveryErrorCode::InvalidUtf8,
                    );
                    continue;
                }
                Err(error) => {
                    context.state.error(context.source_id, context.run, io_error_code(&error));
                    continue;
                }
            };
            if self.consider_filesystem_path(
                &child_selected,
                &canonical,
                &metadata,
                depth.saturating_add(1),
                context,
            ) {
                return true;
            }
            // Never follow symlink directories. They may still be emitted as
            // candidates above, and canonical identity dedupes aliases.
            let is_symlink = match classify_file_type(entry.file_type()) {
                Ok(is_symlink) => is_symlink,
                Err(code) => {
                    context.state.error(context.source_id, context.run, code);
                    continue;
                }
            };
            if !is_symlink
                && context.run.visited_directories.insert(canonical.clone())
                && self.walk_filesystem(
                    &child_selected,
                    depth.saturating_add(1),
                    max_depth,
                    context,
                )
            {
                return true;
            }
        }
        context.cancel.is_cancelled()
    }

    fn consider_filesystem_path(
        &self,
        selected_path: &Path,
        canonical_path: &Path,
        metadata: &Metadata,
        depth: u8,
        context: &mut WalkContext<'_, '_>,
    ) -> bool {
        if context.cancel.is_cancelled() || context.state.stop_requested {
            return context.cancel.is_cancelled();
        }
        let min_depth = context.source.min_depth.min(MAX_DEPTH);
        if depth < min_depth
            || !matches_workspace_kind(
                context.source,
                selected_path,
                metadata,
                context.state,
                context.run,
            )
        {
            return false;
        }
        context.state.candidate(context.source_id, selected_path, canonical_path, context.run);
        context.state.stop_requested
    }
}

struct DiscoveryFutureState {
    result: Mutex<Option<Result<WorkspaceDiscoverySummary, PortError>>>,
    waker: Mutex<Option<Waker>>,
    completed: AtomicBool,
}

struct DiscoveryFuture {
    state: Arc<DiscoveryFutureState>,
    cancel: CancellationToken,
    worker: Option<JoinHandle<()>>,
}

impl Drop for DiscoveryFuture {
    fn drop(&mut self) {
        let completed = self.state.completed.load(Ordering::Acquire);
        if !completed {
            self.cancel.cancel();
        }
        if let Some(worker) = self.worker.take() {
            if completed {
                // Completion is published immediately before the worker
                // returns, so this join is bounded to the worker epilogue.
                let _ = worker.join();
            } else {
                // Do not block the UI/dropper on an in-flight OS filesystem
                // call. The worker observes the shared token at every
                // traversal boundary; this reaper joins it once cooperative
                // cancellation reaches a safe point instead of detaching the
                // worker itself.
                let _ = std::thread::Builder::new()
                    .name("devhub-discovery-reaper".to_owned())
                    .spawn(move || {
                        let _ = worker.join();
                    });
                // If the OS refuses the reaper allocation, the worker handle
                // is dropped by `spawn`'s error path rather than blocking the
                // caller. The worker still owns only the shared cancellation
                // token and has no product-side mutation authority.
            }
        }
    }
}

impl DiscoveryFutureState {
    fn complete(&self, result: Result<WorkspaceDiscoverySummary, PortError>) {
        if let Ok(mut slot) = self.result.lock() {
            *slot = Some(result);
        }
        self.completed.store(true, Ordering::Release);
        if let Ok(mut slot) = self.waker.lock() {
            if let Some(waker) = slot.take() {
                waker.wake();
            }
        }
    }
}

impl Future for DiscoveryFuture {
    type Output = Result<WorkspaceDiscoverySummary, PortError>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        if let Ok(mut slot) = self.state.result.lock() {
            if let Some(result) = slot.take() {
                return Poll::Ready(result);
            }
        }
        if let Ok(mut slot) = self.state.waker.lock() {
            *slot = Some(context.waker().clone());
        }
        if let Ok(mut slot) = self.state.result.lock() {
            if let Some(result) = slot.take() {
                return Poll::Ready(result);
            }
        }
        Poll::Pending
    }
}

impl DiscoveryPort for DiscoveryEngine {
    fn discover(
        &self,
        cancel: CancellationToken,
        sink: Arc<dyn WorkspaceDiscoverySink>,
    ) -> PortFuture<WorkspaceDiscoverySummary> {
        let engine = self.clone();
        let worker_cancel = cancel.child();
        let state = Arc::new(DiscoveryFutureState {
            result: Mutex::new(None),
            waker: Mutex::new(None),
            completed: AtomicBool::new(false),
        });
        let worker_state = Arc::clone(&state);
        let spawned = std::thread::Builder::new()
            .name("devhub-workspace-discovery".to_owned())
            .spawn(move || {
                let result =
                    catch_unwind(AssertUnwindSafe(|| engine.scan(&worker_cancel, sink.as_ref())))
                        .map_err(|_| PortError::new(PortErrorCode::Failed));
                worker_state.complete(result);
            });
        let worker = match spawned {
            Ok(worker) => Some(worker),
            Err(_) => {
                state.complete(Err(PortError::new(PortErrorCode::Unavailable)));
                None
            }
        };
        Box::pin(DiscoveryFuture { state, cancel, worker })
    }
}

#[derive(Default)]
struct SourceRun {
    candidates: u32,
    errors: u32,
    stderr_bytes: u32,
    visited_directories: BTreeSet<PathBuf>,
}

struct ScanState<'a> {
    sink: &'a dyn WorkspaceDiscoverySink,
    operation_id: devhub_app_core::application::OperationId,
    limits: DiscoveryLimits,
    seen: BTreeSet<PathBuf>,
    summary: WorkspaceDiscoverySummary,
    event_count: u32,
    next_sequence: u64,
    stop_requested: bool,
}

struct WalkContext<'a, 'sink> {
    source_id: &'a str,
    source: &'a FilesystemSource,
    cancel: &'a CancellationToken,
    state: &'a mut ScanState<'sink>,
    run: &'a mut SourceRun,
}

impl ScanState<'_> {
    fn envelope(&mut self, kind: WorkspaceDiscoveryEventKind) -> WorkspaceDiscoveryEvent {
        self.next_sequence =
            self.next_sequence.checked_add(1).expect("discovery event sequence exhausted");
        WorkspaceDiscoveryEvent {
            operation_id: self.operation_id.clone(),
            sequence: self.next_sequence,
            kind,
        }
    }

    fn emit(&mut self, kind: WorkspaceDiscoveryEventKind) -> bool {
        if self.event_count >= self.limits.max_events {
            self.stop_requested = true;
            self.summary.truncated = true;
            return false;
        }
        self.event_count = self.event_count.saturating_add(1);
        self.sink.emit(self.envelope(kind));
        true
    }

    fn emit_terminal(&mut self, kind: WorkspaceDiscoveryEventKind) {
        // SourceCompleted/Cancelled are terminal bookkeeping events. They
        // are always emitted even when the regular candidate/error budget is
        // exhausted, so a consumer can close every source deterministically.
        self.sink.emit(self.envelope(kind));
    }

    fn mark_truncated(&mut self) {
        self.summary.truncated = true;
    }

    fn error(&mut self, source_id: &str, run: &mut SourceRun, code: WorkspaceDiscoveryErrorCode) {
        run.errors = run.errors.saturating_add(1);
        self.summary.error_count = self.summary.error_count.saturating_add(1);
        let _ = self.emit(WorkspaceDiscoveryEventKind::SourceError {
            source_id: source_id.to_owned(),
            code,
            count: 1,
        });
    }

    fn candidate(
        &mut self,
        source_id: &str,
        selected_path: &Path,
        canonical_path: &Path,
        run: &mut SourceRun,
    ) {
        if !self.seen.insert(canonical_path.to_path_buf()) {
            return;
        }
        if self.summary.candidate_count >= self.limits.max_candidates {
            self.stop_requested = true;
            self.summary.truncated = true;
            self.error(source_id, run, WorkspaceDiscoveryErrorCode::CandidateLimit);
            return;
        }
        let (selected_text, canonical_text) =
            match (selected_path.to_str(), canonical_path.to_str()) {
                (Some(selected), Some(canonical)) => (selected, canonical),
                _ => {
                    self.error(source_id, run, WorkspaceDiscoveryErrorCode::InvalidUtf8);
                    return;
                }
            };
        let projection = match make_projection(selected_text, canonical_text) {
            Ok(projection) => projection,
            Err(ProjectionError::OutputLimit) => {
                self.error(source_id, run, WorkspaceDiscoveryErrorCode::OutputLimit);
                self.summary.truncated = true;
                return;
            }
            Err(ProjectionError::InvalidCandidate) => {
                self.error(source_id, run, WorkspaceDiscoveryErrorCode::InvalidCandidate);
                return;
            }
        };
        let root = match WorkspaceRoot::new(canonical_path.to_path_buf()) {
            Ok(root) => root,
            Err(_) => {
                self.error(source_id, run, WorkspaceDiscoveryErrorCode::InvalidCandidate);
                return;
            }
        };
        let selected = match DisplayPath::new(selected_path.to_path_buf()) {
            Ok(selected) => selected,
            Err(_) => {
                self.error(source_id, run, WorkspaceDiscoveryErrorCode::InvalidCandidate);
                return;
            }
        };
        if self.emit(WorkspaceDiscoveryEventKind::Candidate {
            source_id: source_id.to_owned(),
            candidate: devhub_app_core::ports::WorkspaceCandidate { root, selected_path: selected },
            projection,
        }) {
            run.candidates = run.candidates.saturating_add(1);
            self.summary.candidate_count = self.summary.candidate_count.saturating_add(1);
        }
    }

    fn finish(&mut self, source_id: &str, run: &SourceRun) {
        self.summary.stderr_bytes = self.summary.stderr_bytes.saturating_add(run.stderr_bytes);
        self.emit_terminal(WorkspaceDiscoveryEventKind::SourceCompleted {
            source_id: source_id.to_owned(),
            candidate_count: run.candidates,
            error_count: run.errors,
            stderr_bytes: run.stderr_bytes,
        });
    }

    fn cancelled(&mut self, source_id: &str, cancel: &CancellationToken) {
        if cancel.is_cancelled() {
            self.summary.cancelled = true;
            self.emit_terminal(WorkspaceDiscoveryEventKind::Cancelled {
                source_id: Some(source_id.to_owned()),
            });
        }
    }
}

fn expand_source_path(raw: &str, home: &Path) -> Option<PathBuf> {
    if raw == "~" {
        return Some(home.to_path_buf());
    }
    raw.strip_prefix("~/").map(|suffix| home.join(suffix)).or_else(|| Some(PathBuf::from(raw)))
}

fn is_utf8_path(path: &Path) -> bool {
    path.to_str().is_some()
}

fn io_error_code(error: &io::Error) -> WorkspaceDiscoveryErrorCode {
    match error.kind() {
        io::ErrorKind::NotFound => WorkspaceDiscoveryErrorCode::SourceUnavailable,
        io::ErrorKind::PermissionDenied => WorkspaceDiscoveryErrorCode::PermissionDenied,
        _ => WorkspaceDiscoveryErrorCode::Io,
    }
}

fn classify_file_type(
    result: io::Result<fs::FileType>,
) -> Result<bool, WorkspaceDiscoveryErrorCode> {
    result.map(|file_type| file_type.is_symlink()).map_err(|error| io_error_code(&error))
}

fn matches_workspace_kind(
    source: &FilesystemSource,
    path: &Path,
    metadata: &Metadata,
    state: &mut ScanState<'_>,
    run: &mut SourceRun,
) -> bool {
    if source.kinds.iter().any(|kind| matches!(kind, WorkspaceKind::Directory)) {
        return metadata.is_dir();
    }
    let git_path = path.join(".git");
    let git_metadata = match fs::metadata(git_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            state.error(&source.id, run, io_error_code(&error));
            None
        }
    };
    source.kinds.iter().any(|kind| match kind {
        WorkspaceKind::GitRepository => git_metadata.as_ref().is_some_and(Metadata::is_dir),
        WorkspaceKind::GitWorktree => git_metadata.as_ref().is_some_and(Metadata::is_file),
        WorkspaceKind::Directory => false,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectionError {
    InvalidCandidate,
    OutputLimit,
}

fn make_projection(
    selected: &str,
    canonical: &str,
) -> Result<WorkspaceSearchProjection, ProjectionError> {
    let label = Path::new(selected)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .or_else(|| Path::new(canonical).file_name().and_then(|value| value.to_str()))
        .ok_or(ProjectionError::InvalidCandidate)?
        .to_owned();
    if selected.len() > MAX_PROJECTION_BYTES || canonical.len() > MAX_PROJECTION_BYTES {
        return Err(ProjectionError::OutputLimit);
    }
    Ok(WorkspaceSearchProjection {
        label: label.clone(),
        search_text: format!("{label} {selected}"),
        tie_break: canonical.to_owned(),
    })
}

/// The result of matching one picker projection.  Scores are intentionally
/// plain values so a UI can sort them without importing filesystem details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FuzzyMatch {
    pub score: u32,
    pub basename_priority: bool,
}

/// Performs a case-insensitive subsequence match against the stable picker
/// projection.  A basename match always outranks a path-only match; within a
/// tier, earlier and tighter subsequences receive the higher score.
pub fn fuzzy_match(query: &str, projection: &WorkspaceSearchProjection) -> Option<FuzzyMatch> {
    let query = query.trim();
    if query.is_empty() {
        return Some(FuzzyMatch { score: 0, basename_priority: false });
    }
    if let Some(score) = subsequence_score(query, &projection.label) {
        return Some(FuzzyMatch { score, basename_priority: true });
    }
    subsequence_score(query, &projection.search_text)
        .map(|score| FuzzyMatch { score, basename_priority: false })
}

/// Returns projections in deterministic picker order.  Matching candidates
/// precede non-matches, basename matches precede path-only matches, and the
/// canonical tie-break string is the final stable ordering key.
pub fn rank_search<'a, I>(query: &str, projections: I) -> Vec<&'a WorkspaceSearchProjection>
where
    I: IntoIterator<Item = &'a WorkspaceSearchProjection>,
{
    let mut ranked = projections
        .into_iter()
        .enumerate()
        .filter_map(|(index, projection)| {
            fuzzy_match(query, projection).map(|matched| (index, matched, projection))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|(left_index, left_match, left), (right_index, right_match, right)| {
        right_match
            .basename_priority
            .cmp(&left_match.basename_priority)
            .then_with(|| right_match.score.cmp(&left_match.score))
            .then_with(|| left.tie_break.cmp(&right.tie_break))
            .then_with(|| left_index.cmp(right_index))
    });
    ranked.into_iter().map(|(_, _, projection)| projection).collect()
}

fn subsequence_score(query: &str, haystack: &str) -> Option<u32> {
    let query = query.chars().flat_map(char::to_lowercase).collect::<Vec<_>>();
    if query.is_empty() {
        return Some(0);
    }
    let haystack = haystack.chars().flat_map(char::to_lowercase).collect::<Vec<_>>();
    let mut query_index = 0;
    let mut first = None;
    let mut last = 0;
    let mut gaps = 0_u32;
    for (index, character) in haystack.iter().enumerate() {
        if query_index < query.len() && *character == query[query_index] {
            first.get_or_insert(index);
            if query_index > 0 {
                gaps = gaps.saturating_add(index.saturating_sub(last + 1) as u32);
            }
            last = index;
            query_index += 1;
            if query_index == query.len() {
                break;
            }
        }
    }
    if query_index != query.len() {
        return None;
    }
    let span = last.saturating_sub(first.unwrap_or(last)) as u32;
    let exact_or_prefix_bonus: u32 = if haystack == query {
        2_000_000
    } else if haystack.starts_with(&query) {
        1_000_000
    } else {
        0
    };
    let remainder_penalty = haystack.len().saturating_sub(query.len()) as u32;
    Some(
        exact_or_prefix_bonus.saturating_add(
            100_000_u32.saturating_sub(
                span.saturating_mul(100)
                    .saturating_add(gaps.saturating_mul(10))
                    .saturating_add(remainder_penalty),
            ),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use devhub_app_core::config::Config;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TempTree {
        path: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("devhub-discovery-{label}-{}-{sequence}", std::process::id()));
            fs::create_dir_all(&path).expect("create discovery temp tree");
            Self { path }
        }

        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    struct CollectSink {
        events: Mutex<Vec<WorkspaceDiscoveryEvent>>,
        cancel_after_candidate: Option<CancellationToken>,
    }

    impl CollectSink {
        fn new(cancel_after_candidate: Option<CancellationToken>) -> Self {
            Self { events: Mutex::new(Vec::new()), cancel_after_candidate }
        }

        fn envelopes(&self) -> Vec<WorkspaceDiscoveryEvent> {
            self.events.lock().expect("event lock").clone()
        }

        fn events(&self) -> Vec<WorkspaceDiscoveryEventKind> {
            self.envelopes().into_iter().map(|event| event.kind).collect()
        }
    }

    impl WorkspaceDiscoverySink for CollectSink {
        fn emit(&self, event: WorkspaceDiscoveryEvent) {
            let candidate = matches!(event.kind, WorkspaceDiscoveryEventKind::Candidate { .. });
            self.events.lock().expect("event lock").push(event);
            if candidate {
                if let Some(cancel) = &self.cancel_after_candidate {
                    cancel.cancel();
                }
            }
        }
    }

    struct PanicSink;

    impl WorkspaceDiscoverySink for PanicSink {
        fn emit(&self, _event: WorkspaceDiscoveryEvent) {
            panic!("test sink panic");
        }
    }

    fn filesystem_source(
        id: &str,
        path: &Path,
        min_depth: u8,
        max_depth: Option<u8>,
        kinds: Vec<WorkspaceKind>,
    ) -> WorkspaceSource {
        WorkspaceSource::Filesystem(FilesystemSource {
            id: id.to_owned(),
            path: path.to_string_lossy().into_owned(),
            min_depth,
            max_depth,
            kinds,
            include_hidden: false,
            exclude_names: vec![".git".to_owned(), "node_modules".to_owned()],
        })
    }

    fn command_source(id: &str, command: Vec<String>, timeout_ms: u32) -> WorkspaceSource {
        WorkspaceSource::Command(CommandSource { id: id.to_owned(), command, timeout_ms })
    }

    fn config(sources: Vec<WorkspaceSource>) -> Config {
        Config { workspace_sources: sources, ..Config::default() }
    }

    fn scan(
        config: Config,
        home: &Path,
    ) -> (WorkspaceDiscoverySummary, Vec<WorkspaceDiscoveryEventKind>) {
        let engine = DiscoveryEngine::new(&config, home);
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000001",
            )
            .expect("test operation ID"),
        );
        let sink = CollectSink::new(None);
        let summary = engine.scan(&cancel, &sink);
        (summary, sink.events())
    }

    #[test]
    fn traverses_depth_first_with_min_max_and_global_dedupe() {
        let tree = TempTree::new("order");
        for path in [tree.child("a/deep"), tree.child("b"), tree.child("z")] {
            fs::create_dir_all(path).expect("create directory");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(tree.child("a"), tree.child("alias"))
            .expect("create directory alias");

        let source =
            filesystem_source("first", &tree.path, 1, Some(2), vec![WorkspaceKind::Directory]);
        let (summary, events) = scan(config(vec![source]), &tree.path);
        let candidates = events
            .into_iter()
            .filter_map(|event| match event {
                WorkspaceDiscoveryEventKind::Candidate { candidate, .. } => {
                    Some(candidate.selected_path.as_path().to_path_buf())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(summary.candidate_count as usize, candidates.len());
        assert_eq!(candidates[0], tree.child("a"));
        assert_eq!(candidates[1], tree.child("a/deep"));
        assert!(candidates.contains(&tree.child("b")));
        assert!(candidates.contains(&tree.child("z")));
        #[cfg(unix)]
        assert!(!candidates.iter().any(|path| path.ends_with("alias")));
    }

    #[test]
    fn hidden_and_exact_excluded_names_prune_only_their_subtrees() {
        let tree = TempTree::new("exclude");
        fs::create_dir_all(tree.child("visible/child")).expect("create visible tree");
        fs::create_dir_all(tree.child("skip/nested")).expect("create excluded tree");
        fs::create_dir_all(tree.child(".hidden/nested")).expect("create hidden tree");
        let mut source =
            filesystem_source("source", &tree.path, 1, Some(2), vec![WorkspaceKind::Directory]);
        if let WorkspaceSource::Filesystem(source) = &mut source {
            source.exclude_names = vec!["skip".to_owned()];
        }
        let (_, events) = scan(config(vec![source]), &tree.path);
        let candidates = events
            .into_iter()
            .filter_map(|event| match event {
                WorkspaceDiscoveryEventKind::Candidate { candidate, .. } => {
                    Some(candidate.selected_path.as_path().to_path_buf())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(candidates.contains(&tree.child("visible")));
        assert!(candidates.contains(&tree.child("visible/child")));
        assert!(!candidates.iter().any(|path| path.ends_with("skip")));
        assert!(!candidates.iter().any(|path| path.ends_with(".hidden")));
        assert!(!candidates.iter().any(|path| path.ends_with("nested"))); // neither pruned subtree
    }

    #[test]
    fn configured_hidden_root_is_allowed_and_git_kinds_retain_nested_matches() {
        let tree = TempTree::new("git");
        let hidden_root = tree.child(".projects");
        let normal = hidden_root.join("normal");
        let nested = normal.join("nested");
        let worktree = hidden_root.join("linked");
        fs::create_dir_all(normal.join(".git")).expect("normal git metadata");
        fs::create_dir_all(nested.join(".git")).expect("nested git metadata");
        fs::create_dir_all(&worktree).expect("worktree");
        fs::write(worktree.join(".git"), "gitdir: ../normal/.git/worktrees/linked\n")
            .expect("linked worktree metadata");
        let source = filesystem_source(
            "git",
            &hidden_root,
            1,
            Some(3),
            vec![WorkspaceKind::GitRepository, WorkspaceKind::GitWorktree],
        );
        let (_, events) = scan(config(vec![source]), &tree.path);
        let candidates = events
            .into_iter()
            .filter_map(|event| match event {
                WorkspaceDiscoveryEventKind::Candidate { candidate, .. } => {
                    Some(candidate.selected_path.as_path().to_path_buf())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(candidates.contains(&normal));
        assert!(candidates.contains(&nested));
        assert!(candidates.contains(&worktree));
    }

    #[test]
    fn source_errors_are_isolated_and_leading_tilde_uses_injected_home() {
        let tree = TempTree::new("sources");
        let home = tree.child("home");
        fs::create_dir_all(home.join("dev/project")).expect("create injected home tree");
        let missing = filesystem_source(
            "missing",
            &tree.child("does-not-exist"),
            0,
            Some(0),
            vec![WorkspaceKind::Directory],
        );
        let mut tilde = filesystem_source(
            "tilde",
            Path::new("/placeholder"),
            1,
            Some(1),
            vec![WorkspaceKind::Directory],
        );
        if let WorkspaceSource::Filesystem(source) = &mut tilde {
            source.path = "~/dev".to_owned();
        }
        let (summary, events) = scan(config(vec![missing, tilde]), &home);
        assert_eq!(summary.source_count, 2);
        assert!(summary.error_count >= 1);
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceError { source_id, code: WorkspaceDiscoveryErrorCode::SourceUnavailable, .. }
                if source_id == "missing"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::Candidate { source_id, candidate, .. }
                if source_id == "tilde" && candidate.selected_path.as_path() == home.join("dev/project")
        )));
    }

    #[test]
    fn first_configured_source_owns_cross_source_canonical_duplicates() {
        let tree = TempTree::new("source-order");
        let project = tree.child("project");
        fs::create_dir_all(&project).expect("create duplicate project");
        let first =
            filesystem_source("first", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let second =
            filesystem_source("second", &project, 0, Some(0), vec![WorkspaceKind::Directory]);
        let (_, events) = scan(config(vec![first, second]), &tree.path);
        let candidates = events
            .into_iter()
            .filter_map(|event| match event {
                WorkspaceDiscoveryEventKind::Candidate { source_id, candidate, .. } => {
                    Some((source_id, candidate.root.as_path().to_path_buf()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(candidates, vec![("first".to_owned(), fs::canonicalize(project).unwrap())]);
    }

    #[test]
    fn command_candidates_use_global_dedupe_and_first_source_ownership() {
        let tree = TempTree::new("command-dedupe");
        let project = tree.child("project");
        fs::create_dir_all(&project).expect("create command project");
        let output = format!("{}\n", project.display());
        let command = command_source(
            "command",
            vec!["/usr/bin/printf".to_owned(), "%s".to_owned(), output],
            2_000,
        );
        let filesystem =
            filesystem_source("filesystem", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let (summary, events) = scan(config(vec![command, filesystem]), &tree.path);
        let candidates = events
            .iter()
            .filter_map(|event| match event {
                WorkspaceDiscoveryEventKind::Candidate { source_id, .. } => {
                    Some(source_id.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(candidates, vec!["command"]);
        assert_eq!(summary.candidate_count, 1);
        assert_eq!(summary.stderr_bytes, 0);
    }

    #[test]
    fn command_valid_and_invalid_lines_are_streamed_as_candidates_and_errors() {
        let tree = TempTree::new("command-lines");
        let valid = tree.child("valid");
        fs::create_dir_all(&valid).expect("create valid command path");
        let output =
            format!("{}\nrelative\n{}\n", valid.display(), tree.child("missing").display());
        let command = command_source(
            "command",
            vec!["/usr/bin/printf".to_owned(), "%s".to_owned(), output],
            2_000,
        );
        let (summary, events) = scan(config(vec![command]), &tree.path);
        assert_eq!(summary.candidate_count, 1);
        assert_eq!(summary.error_count, 2);
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceCompleted {
                source_id,
                candidate_count: 1,
                error_count: 2,
                stderr_bytes: 0,
            } if source_id == "command"
        )));
    }

    #[test]
    fn command_failures_are_isolated_and_later_sources_continue() {
        let tree = TempTree::new("command-isolation");
        let valid = tree.child("valid");
        fs::create_dir_all(&valid).expect("create healthy command path");
        let healthy_output = format!("{}\n", valid.display());
        let sources = vec![
            command_source("missing", vec!["/devhub/not-an-executable".to_owned()], 2_000),
            command_source("failed", vec!["/usr/bin/false".to_owned()], 2_000),
            command_source("timed-out", vec!["/bin/sleep".to_owned(), "30".to_owned()], 100),
            command_source(
                "healthy",
                vec!["/usr/bin/printf".to_owned(), "%s".to_owned(), healthy_output],
                2_000,
            ),
        ];
        let (summary, events) = scan(config(sources), &tree.path);
        assert_eq!(summary.candidate_count, 1);
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceError {
                source_id,
                code: WorkspaceDiscoveryErrorCode::CommandUnavailable,
                ..
            } if source_id == "missing"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceError {
                source_id,
                code: WorkspaceDiscoveryErrorCode::CommandFailed,
                ..
            } if source_id == "failed"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceError {
                source_id,
                code: WorkspaceDiscoveryErrorCode::CommandTimedOut,
                ..
            } if source_id == "timed-out"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::Candidate { source_id, .. } if source_id == "healthy"
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    WorkspaceDiscoveryEventKind::SourceCompleted { .. }
                ))
                .count(),
            4
        );
    }

    #[test]
    fn command_output_limit_is_truncated_and_still_completes_source() {
        let tree = TempTree::new("command-output-limit");
        let command = command_source("command", vec!["/usr/bin/yes".to_owned()], 2_000);
        let (summary, events) = scan(config(vec![command]), &tree.path);
        assert!(summary.truncated);
        assert!(!summary.cancelled);
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceError {
                source_id,
                code: WorkspaceDiscoveryErrorCode::OutputLimit,
                ..
            } if source_id == "command"
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    WorkspaceDiscoveryEventKind::SourceCompleted { .. }
                ))
                .count(),
            1
        );
        assert!(!events
            .iter()
            .any(|event| matches!(event, WorkspaceDiscoveryEventKind::Cancelled { .. })));
    }

    #[test]
    fn command_cancellation_reaps_child_and_emits_one_cancel_and_completion() {
        let tree = TempTree::new("command-cancel");
        let command =
            command_source("command", vec!["/bin/sleep".to_owned(), "30".to_owned()], 30_000);
        let engine = DiscoveryEngine::new(&config(vec![command]), &tree.path);
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000010",
            )
            .expect("test operation ID"),
        );
        let worker_cancel = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            worker_cancel.cancel();
        });
        let sink = Arc::new(CollectSink::new(None));
        let summary = block_on(engine.discover(cancel.clone(), sink.clone())).expect("discover");
        canceller.join().expect("canceller");
        assert!(summary.cancelled);
        assert_eq!(
            sink.events()
                .iter()
                .filter(|event| matches!(event, WorkspaceDiscoveryEventKind::Cancelled { .. }))
                .count(),
            1
        );
        assert_eq!(
            sink.events()
                .iter()
                .filter(|event| matches!(
                    event,
                    WorkspaceDiscoveryEventKind::SourceCompleted { .. }
                ))
                .count(),
            1
        );
        assert!(!sink
            .events()
            .iter()
            .any(|event| matches!(event, WorkspaceDiscoveryEventKind::SourceError { .. })));
    }

    #[test]
    fn command_stderr_is_counted_without_exposing_content() {
        let tree = TempTree::new("command-stderr");
        let secret_path = "/definitely/secret-devhub-path";
        let command =
            command_source("command", vec!["/bin/ls".to_owned(), secret_path.to_owned()], 2_000);
        let (_, events) = scan(config(vec![command]), &tree.path);
        let debug = format!("{events:?}");
        assert!(!debug.contains(secret_path));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceCompleted {
                source_id,
                stderr_bytes,
                ..
            } if source_id == "command" && *stderr_bytes > 0
        )));
    }

    #[test]
    fn candidate_and_event_debug_redact_selected_and_canonical_paths() {
        let tree = TempTree::new("debug-redaction");
        let project = tree.child("private-project");
        fs::create_dir_all(&project).expect("create project");
        let source =
            filesystem_source("source", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let engine = DiscoveryEngine::new(&config(vec![source]), &tree.path);
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000021",
            )
            .expect("test operation ID"),
        );
        let sink = CollectSink::new(None);
        engine.scan(&cancel, &sink);
        let envelopes = sink.envelopes();
        let candidate = envelopes
            .iter()
            .find(|event| matches!(event.kind, WorkspaceDiscoveryEventKind::Candidate { .. }))
            .expect("candidate event");
        let debug = format!("{candidate:?}");
        assert!(!debug.contains(&project.to_string_lossy().to_string()));
        assert!(!debug.contains(&fs::canonicalize(&project).unwrap().to_string_lossy().to_string()));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn scan_event_envelope_scopes_operation_and_sequences_for_replacement() {
        let tree = TempTree::new("event-envelope");
        fs::create_dir_all(tree.child("project")).expect("create project");
        let source =
            filesystem_source("source", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let engine = DiscoveryEngine::new(&config(vec![source]), &tree.path);
        let old_operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000022",
        )
        .expect("old operation ID");
        let new_operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000023",
        )
        .expect("new operation ID");
        let old_cancel = CancellationToken::new(old_operation.clone());
        let new_cancel = CancellationToken::new(new_operation.clone());
        let old_sink = CollectSink::new(None);
        let new_sink = CollectSink::new(None);
        engine.scan(&old_cancel, &old_sink);
        engine.scan(&new_cancel, &new_sink);
        let old_events = old_sink.envelopes();
        let new_events = new_sink.envelopes();
        assert!(!old_events.is_empty());
        assert!(!new_events.is_empty());
        assert!(old_events.iter().all(|event| event.operation_id == old_operation));
        assert!(new_events.iter().all(|event| event.operation_id == new_operation));
        assert_eq!(
            old_events.iter().map(|event| event.sequence).collect::<Vec<_>>(),
            (1..=old_events.len() as u64).collect::<Vec<_>>()
        );
        assert_eq!(
            new_events.iter().map(|event| event.sequence).collect::<Vec<_>>(),
            (1..=new_events.len() as u64).collect::<Vec<_>>()
        );

        // A host retaining the new operation can reject a late event from the
        // cooperatively-cancelled old scan without inspecting provider data.
        let late_old = old_events.last().expect("old terminal event");
        let new_last_sequence = new_events.last().expect("new terminal event").sequence;
        let accepts_new_event = |event: &WorkspaceDiscoveryEvent| {
            event.operation_id == new_operation && event.sequence > new_last_sequence
        };
        assert!(!accepts_new_event(late_old));
    }

    #[test]
    fn cancellation_is_observed_between_candidates() {
        let tree = TempTree::new("cancel");
        for name in ["a", "b", "c"] {
            fs::create_dir_all(tree.child(name)).expect("create cancellation directory");
        }
        let source =
            filesystem_source("source", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let engine = DiscoveryEngine::new(&config(vec![source]), &tree.path);
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000002",
            )
            .expect("test operation ID"),
        );
        let sink = CollectSink::new(Some(cancel.clone()));
        let summary = engine.scan(&cancel, &sink);
        assert!(summary.cancelled);
        assert!(!summary.truncated);
        assert!(sink
            .events()
            .iter()
            .any(|event| matches!(event, WorkspaceDiscoveryEventKind::Cancelled { .. })));
        assert_eq!(summary.candidate_count, 1);
    }

    #[test]
    fn limits_truncate_without_cancel_event_and_terminal_completion_is_preserved() {
        let tree = TempTree::new("event-limit");
        fs::create_dir_all(tree.child("a")).expect("create first directory");
        fs::create_dir_all(tree.child("b")).expect("create second directory");
        let source =
            filesystem_source("source", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let engine = DiscoveryEngine::with_limits(
            &config(vec![source]),
            &tree.path,
            DiscoveryLimits { max_candidates: 10, max_events: 1 },
        );
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000005",
            )
            .expect("test operation ID"),
        );
        let sink = CollectSink::new(None);
        let summary = engine.scan(&cancel, &sink);
        let events = sink.events();
        assert!(summary.truncated);
        assert!(!summary.cancelled);
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceCompleted { source_id, .. } if source_id == "source"
        )));
        assert!(!events
            .iter()
            .any(|event| matches!(event, WorkspaceDiscoveryEventKind::Cancelled { .. })));
    }

    #[test]
    fn candidate_limit_is_distinct_and_marks_truncation() {
        let tree = TempTree::new("candidate-limit");
        fs::create_dir_all(tree.child("a")).expect("create first directory");
        fs::create_dir_all(tree.child("b")).expect("create second directory");
        let source =
            filesystem_source("source", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let engine = DiscoveryEngine::with_limits(
            &config(vec![source]),
            &tree.path,
            DiscoveryLimits { max_candidates: 1, max_events: 20 },
        );
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000006",
            )
            .expect("test operation ID"),
        );
        let sink = CollectSink::new(None);
        let summary = engine.scan(&cancel, &sink);
        assert!(summary.truncated);
        assert!(!summary.cancelled);
        assert!(sink.events().iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceError {
                code: WorkspaceDiscoveryErrorCode::CandidateLimit,
                ..
            }
        )));
        assert_eq!(
            sink.events()
                .iter()
                .filter(|event| matches!(
                    event,
                    WorkspaceDiscoveryEventKind::SourceError {
                        code: WorkspaceDiscoveryErrorCode::CandidateLimit,
                        ..
                    }
                ))
                .count(),
            1
        );
        assert!(sink
            .events()
            .iter()
            .any(|event| matches!(event, WorkspaceDiscoveryEventKind::SourceCompleted { .. })));
    }

    #[test]
    fn source_local_visited_state_allows_later_depth_rules() {
        let tree = TempTree::new("source-depth");
        fs::create_dir_all(tree.child("a/deep")).expect("create nested directory");
        let shallow =
            filesystem_source("shallow", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let deep =
            filesystem_source("deep", &tree.path, 2, Some(2), vec![WorkspaceKind::Directory]);
        let (_, events) = scan(config(vec![shallow, deep]), &tree.path);
        assert!(events.iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::Candidate { source_id, candidate, .. }
                if source_id == "deep" && candidate.selected_path.as_path() == tree.child("a/deep")
        )));
    }

    #[test]
    fn oversized_projection_reports_output_limit_without_event_error() {
        let sink = CollectSink::new(None);
        let mut state = ScanState {
            sink: &sink,
            operation_id: devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000020",
            )
            .expect("test operation ID"),
            limits: DiscoveryLimits::default(),
            seen: BTreeSet::new(),
            summary: WorkspaceDiscoverySummary::default(),
            event_count: 0,
            next_sequence: 0,
            stop_requested: false,
        };
        let mut run = SourceRun::default();
        let long_path = PathBuf::from(format!("/{}", "a".repeat(MAX_PROJECTION_BYTES + 1)));
        state.candidate("source", &long_path, &long_path, &mut run);
        assert!(state.summary.truncated);
        assert!(sink.events().iter().any(|event| matches!(
            event,
            WorkspaceDiscoveryEventKind::SourceError {
                code: WorkspaceDiscoveryErrorCode::OutputLimit,
                ..
            }
        )));
    }

    #[test]
    fn file_type_errors_are_mapped_to_content_free_diagnostics() {
        let error =
            classify_file_type(Err(io::Error::new(io::ErrorKind::PermissionDenied, "secret")))
                .expect_err("file type failure");
        assert_eq!(error, WorkspaceDiscoveryErrorCode::PermissionDenied);
    }

    #[cfg(unix)]
    #[test]
    fn root_symlink_preserves_first_selected_alias_and_dedupes_later_root() {
        let tree = TempTree::new("root-alias");
        let real = tree.child("real");
        let link = tree.child("link");
        fs::create_dir_all(real.join("project")).expect("create real project");
        std::os::unix::fs::symlink(&real, &link).expect("create root alias");
        let first = filesystem_source("alias", &link, 1, Some(1), vec![WorkspaceKind::Directory]);
        let second = filesystem_source("real", &real, 1, Some(1), vec![WorkspaceKind::Directory]);
        let (_, events) = scan(config(vec![first, second]), &tree.path);
        let candidates = events
            .into_iter()
            .filter_map(|event| match event {
                WorkspaceDiscoveryEventKind::Candidate { source_id, candidate, .. } => {
                    Some((source_id, candidate.selected_path.as_path().to_path_buf()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(candidates, vec![("alias".to_owned(), link.join("project"))]);
    }

    #[test]
    fn cancellation_tokens_require_shared_identity_for_equality() {
        let operation = devhub_app_core::application::OperationId::from_uuid(
            "00000000-0000-4000-8000-000000000007",
        )
        .expect("test operation ID");
        let first = CancellationToken::new(operation.clone());
        let independent = CancellationToken::new(operation);
        let child = first.child();
        assert_ne!(first, independent);
        assert_eq!(first, child);
        child.cancel();
        assert!(first.is_cancelled());
        assert!(!independent.is_cancelled());
    }

    #[test]
    fn discovery_worker_converts_sink_panics_to_failed_port_error() {
        let tree = TempTree::new("panic");
        let source =
            filesystem_source("source", &tree.path, 0, Some(0), vec![WorkspaceKind::Directory]);
        let engine: Arc<dyn DiscoveryPort> =
            Arc::new(DiscoveryEngine::new(&config(vec![source]), &tree.path));
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000008",
            )
            .expect("test operation ID"),
        );
        let error =
            block_on(engine.discover(cancel, Arc::new(PanicSink))).expect_err("panic error");
        assert_eq!(error.code(), PortErrorCode::Failed);
    }

    #[test]
    fn dropping_discovery_cancels_promptly_without_joining_on_caller_thread() {
        let tree = TempTree::new("drop");
        for index in 0..100 {
            fs::create_dir_all(tree.child(&format!("project-{index:03}")))
                .expect("create drop test directory");
        }
        let source =
            filesystem_source("source", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let engine = DiscoveryEngine::new(&config(vec![source]), &tree.path);
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000009",
            )
            .expect("test operation ID"),
        );
        let future = engine.discover(cancel.clone(), Arc::new(CollectSink::new(None)));
        let started = std::time::Instant::now();
        drop(future);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(cancel.is_cancelled());
    }

    #[test]
    fn non_utf8_entries_are_rejected_without_lossy_paths_and_limits_are_bounded() {
        let tree = TempTree::new("limits");
        #[cfg(unix)]
        let non_utf8_created = {
            use std::os::unix::ffi::OsStringExt;
            fs::create_dir(tree.path.join(std::ffi::OsString::from_vec(vec![0xff, b'x']))).is_ok()
        };
        #[cfg(not(unix))]
        let non_utf8_created = false;
        fs::create_dir_all(tree.child("valid")).expect("create valid directory");
        let source =
            filesystem_source("source", &tree.path, 1, Some(1), vec![WorkspaceKind::Directory]);
        let engine = DiscoveryEngine::with_limits(
            &config(vec![source]),
            &tree.path,
            DiscoveryLimits { max_candidates: 1, max_events: 32 },
        );
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000003",
            )
            .expect("test operation ID"),
        );
        let sink = CollectSink::new(None);
        let summary = engine.scan(&cancel, &sink);
        if non_utf8_created {
            assert!(sink.events().iter().any(|event| matches!(
                event,
                WorkspaceDiscoveryEventKind::SourceError {
                    code: WorkspaceDiscoveryErrorCode::InvalidUtf8,
                    ..
                }
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let invalid = PathBuf::from(std::ffi::OsString::from_vec(vec![b'/', 0xff]));
            assert!(!is_utf8_path(&invalid));
            assert!(DisplayPath::new(invalid).is_err());
        }
        assert!(summary.candidate_count <= 1);
    }

    #[test]
    fn fuzzy_matching_prioritizes_basename_and_tie_breaks_canonically() {
        let first = make_projection("/dev/zeta/app", "/dev/zeta/app").expect("projection");
        let second = make_projection("/dev/alpha/app", "/dev/alpha/app").expect("projection");
        let longer = make_projection("/dev/alpha/application", "/dev/alpha/application")
            .expect("projection");
        let path_only =
            make_projection("/dev/alpha/app-suite/project", "/dev/alpha/app-suite/project")
                .expect("projection");
        let projections = [first, second, longer, path_only];
        let ranked = rank_search("app", projections.iter());
        assert_eq!(ranked[0].tie_break, "/dev/alpha/app");
        assert_eq!(ranked[1].tie_break, "/dev/zeta/app");
        assert_eq!(ranked[2].tie_break, "/dev/alpha/application");
        assert!(
            fuzzy_match("AP", &projections[0]).expect("case-insensitive match").basename_priority
        );
        assert!(fuzzy_match("zz", &projections[0]).is_none());
        let debug = format!("{:?}", projections[0]);
        assert!(!debug.contains("/dev/zeta"));
        assert!(debug.contains("redacted"));
    }

    #[test]
    fn discovery_trait_is_object_safe_and_returns_summary() {
        let tree = TempTree::new("trait");
        let source =
            filesystem_source("source", &tree.path, 0, Some(0), vec![WorkspaceKind::Directory]);
        let engine: Arc<dyn DiscoveryPort> =
            Arc::new(DiscoveryEngine::new(&config(vec![source]), &tree.path));
        let cancel = CancellationToken::new(
            devhub_app_core::application::OperationId::from_uuid(
                "00000000-0000-4000-8000-000000000004",
            )
            .expect("test operation ID"),
        );
        let sink = Arc::new(CollectSink::new(None));
        let summary = block_on(engine.discover(cancel.clone(), sink)).expect("discover");
        assert_eq!(summary.candidate_count, 1);
        assert!(!cancel.is_cancelled());
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, Waker};

        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut future = std::pin::pin!(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(output) => return output,
                Poll::Pending => std::thread::sleep(std::time::Duration::from_millis(1)),
            }
        }
    }
}
