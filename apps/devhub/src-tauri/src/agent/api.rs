//! Minimal bounded JSON API transport for the pinned Herdr session.
//!
//! The transport deliberately has no public provider model. It carries
//! provider JSON only between this module and the Herdr process; callers see
//! only typed adapter results.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
#[cfg(test)]
use std::io::Read;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::contract::required_capabilities;
use super::control::{HerdrTerminalControl, NoopTerminalControl, TerminalControl};
use super::error::{AgentRuntimeError, AgentRuntimeErrorCode, ProviderErrorCategory};

pub(crate) const API_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const SUBSCRIPTION_RETRY: Duration = Duration::from_millis(100);
/// Herdr's `MAX_INITIAL_REQUEST_BYTES` is an inclusive read limit, so the
/// adapter keeps the terminating newline below the exact 1 MiB boundary.
pub(crate) const HERDR_INITIAL_REQUEST_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_API_LINE_BYTES: usize = 512 * 1024;
pub(crate) const MAX_TERMINAL_READ_BYTES: usize = 256 * 1024;

/// Adapter-owned event invalidation state. Herdr events are hints only; the
/// next reconciliation always obtains an authoritative session snapshot.
pub(crate) struct Invalidation {
    pending: AtomicBool,
    disconnected: AtomicBool,
    generation: std::sync::atomic::AtomicU64,
    last_event: Mutex<Option<std::time::Instant>>,
}

impl Default for Invalidation {
    fn default() -> Self {
        Self {
            pending: AtomicBool::new(false),
            disconnected: AtomicBool::new(false),
            generation: std::sync::atomic::AtomicU64::new(0),
            last_event: Mutex::new(None),
        }
    }
}

impl Invalidation {
    pub(crate) fn mark(&self) {
        self.pending.store(true, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut event) = self.last_event.lock() {
            *event = Some(std::time::Instant::now());
        }
    }

    pub(crate) fn mark_disconnected(&self) {
        self.disconnected.store(true, Ordering::Release);
        self.mark();
    }

    pub(crate) fn mark_connected(&self) {
        self.disconnected.store(false, Ordering::Release);
    }

    pub(crate) fn is_disconnected(&self) -> bool {
        self.disconnected.load(Ordering::Acquire)
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(crate) fn pending_wait(&self) -> Option<Duration> {
        if !self.pending.load(Ordering::Acquire) {
            return None;
        }
        let elapsed = self
            .last_event
            .lock()
            .ok()
            .and_then(|event| event.map(|at| at.elapsed()))
            .unwrap_or_default();
        Some(Duration::from_millis(50).saturating_sub(elapsed))
    }

    pub(crate) fn clear_pending(&self) {
        self.pending.store(false, Ordering::Release);
    }
}

/// A persistent subscription worker. Dropping the handle requests shutdown
/// and joins the worker, keeping reconnect threads bounded during bootstrap
/// recovery and test teardown.
pub(crate) struct SubscriptionHandle {
    stop: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

impl SubscriptionHandle {
    #[cfg(test)]
    pub(crate) fn new(stop: Arc<AtomicBool>, thread: thread::JoinHandle<()>) -> Self {
        Self { stop, ready: Arc::new(AtomicBool::new(true)), thread: Mutex::new(Some(thread)) }
    }

    fn with_readiness(
        stop: Arc<AtomicBool>,
        ready: Arc<AtomicBool>,
        thread: thread::JoinHandle<()>,
    ) -> Self {
        Self { stop, ready, thread: Mutex::new(Some(thread)) }
    }

    pub(crate) fn wait_ready(&self, deadline: Instant) -> bool {
        while !self.ready.load(Ordering::Acquire) && Instant::now() < deadline {
            if self.stop.load(Ordering::Acquire) {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        self.ready.load(Ordering::Acquire)
    }

    pub(crate) fn stop(&self) {
        let _ = self.stop_until(Instant::now() + Duration::from_secs(5));
    }

    /// Requests subscription shutdown and waits only until the caller's
    /// lifecycle deadline. Herdr sessions are provider-owned and are never
    /// terminated by this local listener cleanup.
    pub(crate) fn stop_until(&self, deadline: Instant) -> bool {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut thread) = self.thread.lock() {
            let Some(thread_handle) = thread.take() else { return true };
            while !thread_handle.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if thread_handle.is_finished() {
                return thread_handle.join().is_ok();
            }
            // The worker observes `stop` and is intentionally detached at
            // the process deadline rather than blocking app exit.
            drop(thread_handle);
        }
        false
    }
}

impl Drop for SubscriptionHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(thread) = self.thread.get_mut() {
            if let Some(thread) = thread.take() {
                if thread.is_finished() {
                    let _ = thread.join();
                } else {
                    // Never turn a bounded quit into an unbounded Drop join.
                    // The reader has its stop flag and will finish without
                    // owning or terminating provider sessions.
                    drop(thread);
                }
            }
        }
    }
}

/// Provider transport seam. The real implementation speaks Herdr's newline
/// JSON API; tests can use a deterministic in-memory endpoint without
/// exposing provider IDs outside this module.
pub(crate) trait ProviderTransport: Send + Sync {
    fn request(&self, method: &str, params: Value) -> Result<Value, AgentRuntimeError>;
    /// Bounded operation-specific request seam. Implementations may widen a
    /// transport deadline for a provider operation whose server-side
    /// readiness timeout is explicitly larger than the ordinary API budget.
    fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        _timeout: Duration,
    ) -> Result<Value, AgentRuntimeError> {
        self.request(method, params)
    }
    fn check_capabilities(&self) -> Result<(), AgentRuntimeError> {
        Ok(())
    }
    fn open_control(
        &self,
        _terminal_id: &str,
        _takeover: bool,
    ) -> Result<Arc<dyn TerminalControl>, AgentRuntimeError> {
        Ok(Arc::new(NoopTerminalControl))
    }
    fn subscribe(
        &self,
        invalidation: Arc<Invalidation>,
    ) -> Result<SubscriptionHandle, AgentRuntimeError>;
}

#[derive(Clone)]
pub(crate) struct HerdrTransport {
    socket_path: PathBuf,
    timeout: Duration,
}

impl HerdrTransport {
    pub(crate) fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self { socket_path: socket_path.into(), timeout: API_TIMEOUT }
    }

    #[cfg(unix)]
    fn connect(&self) -> Result<std::os::unix::net::UnixStream, AgentRuntimeError> {
        std::os::unix::net::UnixStream::connect(&self.socket_path).map_err(classify_io)
    }

    #[cfg(not(unix))]
    fn connect(&self) -> Result<(), AgentRuntimeError> {
        Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))
    }

    fn request_value(&self, method: &str, params: Value) -> Result<Value, AgentRuntimeError> {
        self.request_value_with_timeout(method, params, self.timeout)
    }

    fn request_value_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, AgentRuntimeError> {
        let request_id = format!("devhub-agent-{method}");
        let request = json!({ "id": request_id, "method": method, "params": params });
        let encoded = serde_json::to_vec(&request)
            .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Internal))?;
        if encoded.len().saturating_add(1) >= HERDR_INITIAL_REQUEST_BYTES {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
        }

        #[cfg(unix)]
        {
            let mut stream = self.connect()?;
            stream.set_read_timeout(Some(timeout)).map_err(classify_io)?;
            stream.set_write_timeout(Some(timeout)).map_err(classify_io)?;
            stream.write_all(&encoded).map_err(classify_io)?;
            stream.write_all(b"\n").map_err(classify_io)?;
            stream.flush().map_err(classify_io)?;
            let line = read_bounded_line(&mut BufReader::new(stream))?;
            parse_response(&line)
        }

        #[cfg(not(unix))]
        {
            let _ = (encoded, method);
            Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))
        }
    }

    fn subscribe_impl(
        &self,
        invalidation: Arc<Invalidation>,
        stop: Arc<AtomicBool>,
        ready: Arc<AtomicBool>,
        subscriptions: Value,
    ) -> Result<(), AgentRuntimeError> {
        let request = json!({
            "id": "devhub-agent-subscribe",
            "method": "events.subscribe",
            "params": { "subscriptions": subscriptions },
        });
        let encoded = serde_json::to_vec(&request)
            .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Internal))?;
        if encoded.len().saturating_add(1) >= HERDR_INITIAL_REQUEST_BYTES {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
        }
        #[cfg(unix)]
        {
            let mut stream = self.connect()?;
            // A short read timeout lets the worker observe `stop` and retry a
            // disconnected server without an unbounded join during teardown.
            stream.set_read_timeout(Some(Duration::from_millis(200))).map_err(classify_io)?;
            stream.set_write_timeout(Some(self.timeout)).map_err(classify_io)?;
            stream.write_all(&encoded).map_err(classify_io)?;
            stream.write_all(b"\n").map_err(classify_io)?;
            stream.flush().map_err(classify_io)?;
            let mut reader = BufReader::new(stream);
            let first = read_bounded_line(&mut reader)?;
            if parse_subscription_started(&first).is_err() {
                return Err(parse_response(&first).err().unwrap_or_else(|| {
                    AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch)
                }));
            }
            invalidation.mark_connected();
            ready.store(true, Ordering::Release);
            loop {
                if stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                match read_bounded_line(&mut reader) {
                    Ok(line) => {
                        if is_event_line(&line) {
                            invalidation.mark();
                        }
                    }
                    Err(error) if is_timeout(error) => continue,
                    Err(error) => return Err(error),
                }
            }
        }

        #[cfg(not(unix))]
        {
            let _ = (invalidation, stop, ready);
            Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))
        }
    }
}

impl ProviderTransport for HerdrTransport {
    fn request(&self, method: &str, params: Value) -> Result<Value, AgentRuntimeError> {
        self.request_value(method, params)
    }

    fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, AgentRuntimeError> {
        self.request_value_with_timeout(method, params, timeout)
    }

    fn check_capabilities(&self) -> Result<(), AgentRuntimeError> {
        let known_contract: BTreeSet<&str> = [
            "session.snapshot",
            "events.subscribe",
            "workspace.create",
            "workspace.list",
            "workspace.close",
            "tab.create",
            "tab.list",
            "pane.create",
            "pane.list",
            "pane.get",
            "pane.close",
            "pane.send_input",
            "agent.start:codex",
            "agent.start:claude",
            "terminal.control",
        ]
        .into_iter()
        .collect();
        if required_capabilities().iter().any(|capability| !known_contract.contains(capability)) {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch));
        }
        let snapshot = self.request_value("session.snapshot", json!({}))?;
        validate_capability_result(snapshot, CapabilityResultKind::SessionSnapshot)?;
        for (method, kind) in [
            ("workspace.list", CapabilityResultKind::WorkspaceList),
            ("tab.list", CapabilityResultKind::TabList),
            ("pane.list", CapabilityResultKind::PaneList),
            ("agent.list", CapabilityResultKind::AgentList),
        ] {
            validate_capability_result(self.request_value(method, json!({}))?, kind)?;
        }
        self.probe_subscription()?;
        self.probe_terminal_control()
    }

    fn open_control(
        &self,
        terminal_id: &str,
        takeover: bool,
    ) -> Result<Arc<dyn TerminalControl>, AgentRuntimeError> {
        HerdrTerminalControl::open(&client_socket_path(&self.socket_path), terminal_id, takeover)
    }

    fn subscribe(
        &self,
        invalidation: Arc<Invalidation>,
    ) -> Result<SubscriptionHandle, AgentRuntimeError> {
        self.subscribe_with_kinds(invalidation, base_subscription_kinds())
    }
}

impl HerdrTransport {
    fn subscribe_with_kinds(
        &self,
        invalidation: Arc<Invalidation>,
        subscriptions: Value,
    ) -> Result<SubscriptionHandle, AgentRuntimeError> {
        let stop = Arc::new(AtomicBool::new(false));
        let ready = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker_ready = Arc::clone(&ready);
        let transport = self.clone();
        let worker = thread::Builder::new()
            .name("devhub-herdr-subscription-base".to_owned())
            .spawn(move || {
                while !worker_stop.load(Ordering::Acquire) {
                    worker_ready.store(false, Ordering::Release);
                    if transport
                        .subscribe_impl(
                            Arc::clone(&invalidation),
                            Arc::clone(&worker_stop),
                            Arc::clone(&worker_ready),
                            subscriptions.clone(),
                        )
                        .is_err()
                    {
                        worker_ready.store(false, Ordering::Release);
                        invalidation.mark_disconnected();
                        thread::sleep(SUBSCRIPTION_RETRY);
                    }
                }
            })
            .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
        Ok(SubscriptionHandle::with_readiness(stop, ready, worker))
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum CapabilityResult {
    SessionSnapshot { snapshot: CapabilitySnapshot },
    WorkspaceList { workspaces: Vec<CapabilityRecord> },
    TabList { tabs: Vec<CapabilityRecord> },
    PaneList { panes: Vec<CapabilityRecord> },
    AgentList { agents: Vec<CapabilityRecord> },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CapabilitySnapshot {
    version: String,
    protocol: u32,
    #[serde(default)]
    focused_workspace_id: Option<String>,
    #[serde(default)]
    focused_tab_id: Option<String>,
    #[serde(default)]
    focused_pane_id: Option<String>,
    workspaces: Vec<CapabilityRecord>,
    tabs: Vec<CapabilityRecord>,
    panes: Vec<CapabilityRecord>,
    layouts: Vec<CapabilityRecord>,
    agents: Vec<CapabilityRecord>,
}

#[derive(Debug, Deserialize)]
struct CapabilityRecord {
    #[serde(flatten)]
    fields: BTreeMap<String, Value>,
}

#[derive(Clone, Copy)]
enum CapabilityResultKind {
    SessionSnapshot,
    WorkspaceList,
    TabList,
    PaneList,
    AgentList,
}

fn validate_capability_result(
    value: Value,
    expected: CapabilityResultKind,
) -> Result<(), AgentRuntimeError> {
    let parsed: CapabilityResult = serde_json::from_value(value)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch))?;
    match (expected, parsed) {
        (CapabilityResultKind::SessionSnapshot, CapabilityResult::SessionSnapshot { snapshot }) => {
            if snapshot.version != super::contract::expected_version()
                || snapshot.protocol != super::contract::expected_protocol()
            {
                return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
            }
            validate_record_ids(&snapshot.workspaces, "workspace_id")?;
            validate_record_ids(&snapshot.tabs, "tab_id")?;
            validate_record_ids(&snapshot.panes, "pane_id")?;
            validate_record_ids(&snapshot.agents, "terminal_id")?;
            let _ = (
                snapshot.focused_workspace_id,
                snapshot.focused_tab_id,
                snapshot.focused_pane_id,
                snapshot.layouts,
            );
            Ok(())
        }
        (CapabilityResultKind::WorkspaceList, CapabilityResult::WorkspaceList { workspaces }) => {
            validate_record_ids(&workspaces, "workspace_id")
        }
        (CapabilityResultKind::TabList, CapabilityResult::TabList { tabs }) => {
            validate_record_ids(&tabs, "tab_id")
        }
        (CapabilityResultKind::PaneList, CapabilityResult::PaneList { panes }) => {
            validate_record_ids(&panes, "pane_id")
        }
        (CapabilityResultKind::AgentList, CapabilityResult::AgentList { agents }) => {
            validate_record_ids(&agents, "terminal_id")
        }
        _ => Err(AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch)),
    }
}

fn validate_record_ids(records: &[CapabilityRecord], key: &str) -> Result<(), AgentRuntimeError> {
    if records
        .iter()
        .any(|record| record.fields.get(key).and_then(Value::as_str).is_none_or(str::is_empty))
    {
        Err(AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch))
    } else {
        Ok(())
    }
}

impl HerdrTransport {
    fn probe_subscription(&self) -> Result<(), AgentRuntimeError> {
        let request = json!({
            "id": "devhub-agent-capability-subscribe",
            "method": "events.subscribe",
            "params": { "subscriptions": base_subscription_kinds() },
        });
        let encoded = serde_json::to_vec(&request)
            .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Internal))?;
        if encoded.len().saturating_add(1) >= HERDR_INITIAL_REQUEST_BYTES {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
        }
        #[cfg(unix)]
        {
            let mut stream = self.connect()?;
            stream.set_read_timeout(Some(self.timeout)).map_err(classify_io)?;
            stream.set_write_timeout(Some(self.timeout)).map_err(classify_io)?;
            stream.write_all(&encoded).map_err(classify_io)?;
            stream.write_all(b"\n").map_err(classify_io)?;
            stream.flush().map_err(classify_io)?;
            let first = read_bounded_line(&mut BufReader::new(stream))?;
            parse_subscription_started(&first)
        }

        #[cfg(not(unix))]
        {
            Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))
        }
    }

    fn probe_terminal_control(&self) -> Result<(), AgentRuntimeError> {
        HerdrTerminalControl::probe(&client_socket_path(&self.socket_path))
    }
}

fn client_socket_path(api_socket: &Path) -> PathBuf {
    let stem = api_socket.file_stem().and_then(|value| value.to_str()).unwrap_or("herdr");
    api_socket.parent().unwrap_or_else(|| Path::new("")).join(format!("{stem}-client.sock"))
}

fn base_subscription_kinds() -> Value {
    Value::Array(vec![
        json!({ "type": "workspace.created" }),
        json!({ "type": "workspace.updated" }),
        json!({ "type": "workspace.closed" }),
        json!({ "type": "tab.created" }),
        json!({ "type": "tab.closed" }),
        json!({ "type": "pane.created" }),
        json!({ "type": "pane.updated" }),
        json!({ "type": "pane.closed" }),
        json!({ "type": "pane.exited" }),
        json!({ "type": "pane.agent_detected" }),
    ])
}

fn parse_subscription_started(line: &[u8]) -> Result<(), AgentRuntimeError> {
    let value: Value = serde_json::from_slice(line)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch))?;
    if value.get("result").and_then(|result| result.get("type")).and_then(Value::as_str)
        == Some("subscription_started")
    {
        Ok(())
    } else {
        Err(AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch))
    }
}

fn is_event_line(line: &[u8]) -> bool {
    serde_json::from_slice::<Value>(line).ok().is_some_and(|value| value.get("event").is_some())
}

fn parse_response(line: &[u8]) -> Result<Value, AgentRuntimeError> {
    let value: Value = serde_json::from_slice(line)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))?;
    if let Some(error) = value.get("error") {
        let code = error.get("code").and_then(Value::as_str).unwrap_or_default();
        return Err(classify_provider_code(code));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))
}

fn classify_provider_code(code: &str) -> AgentRuntimeError {
    let category = match code {
        "agent_name_taken" => ProviderErrorCategory::AgentNameTaken,
        "agent_pane_busy" | "pane_busy" => ProviderErrorCategory::AgentPaneBusy,
        "agent_pane_not_found" | "pane_not_found" => ProviderErrorCategory::AgentPaneNotFound,
        "agent_pane_unavailable" | "pane_unavailable" => {
            ProviderErrorCategory::AgentPaneUnavailable
        }
        "agent_start_input_failed" | "input_failed" => ProviderErrorCategory::AgentStartInputFailed,
        "invalid_request" | "invalid_params" => ProviderErrorCategory::InvalidRequest,
        _ => ProviderErrorCategory::Other,
    };
    let runtime_code = if category == ProviderErrorCategory::AgentPaneNotFound
        || code.contains("not_found")
        || code.contains("not-found")
    {
        AgentRuntimeErrorCode::ProviderNotFound
    } else if code.contains("timeout") {
        AgentRuntimeErrorCode::Timeout
    } else {
        AgentRuntimeErrorCode::ProviderRejected
    };
    AgentRuntimeError::with_provider_category(runtime_code, category)
}

fn classify_io(error: io::Error) -> AgentRuntimeError {
    match error.kind() {
        io::ErrorKind::NotFound
        | io::ErrorKind::ConnectionRefused
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::NotConnected => {
            AgentRuntimeError::new(AgentRuntimeErrorCode::Disconnected)
        }
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => {
            AgentRuntimeError::new(AgentRuntimeErrorCode::Timeout)
        }
        _ => AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable),
    }
}

fn is_timeout(error: AgentRuntimeError) -> bool {
    error.code() == AgentRuntimeErrorCode::Timeout
}

fn read_bounded_line<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, AgentRuntimeError> {
    let mut line = Vec::new();
    let read = reader.read_until(b'\n', &mut line).map_err(classify_io)?;
    if read == 0 {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Disconnected));
    }
    if line.len() > MAX_API_LINE_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    if line.last().is_some_and(|byte| *byte == b'\n') {
        line.pop();
    }
    if line.last().is_some_and(|byte| *byte == b'\r') {
        line.pop();
    }
    Ok(line)
}

/// Derives Herdr's named-session API socket from the startup-frozen launch
/// context. The release CLI uses `~/.config/herdr`; tests may supply a direct
/// endpoint through [`HerdrTransport::new`].
pub(crate) fn session_socket_path(home: &Path, xdg_config_home: Option<&Path>) -> PathBuf {
    let config_home = xdg_config_home
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"));
    config_home.join("herdr").join("sessions").join(super::HERDR_SESSION_NAME).join("herdr.sock")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_uses_absolute_xdg_home_only() {
        let home = Path::new("/tmp/devhub-home");
        assert_eq!(
            session_socket_path(home, Some(Path::new("/tmp/config"))),
            Path::new("/tmp/config/herdr/sessions/devhub-session/herdr.sock")
        );
        assert_eq!(
            session_socket_path(home, Some(Path::new("relative"))),
            Path::new("/tmp/devhub-home/.config/herdr/sessions/devhub-session/herdr.sock")
        );
    }

    #[test]
    fn bounded_line_rejects_large_provider_output() {
        let mut input = std::io::Cursor::new(vec![b'x'; MAX_API_LINE_BYTES + 1]);
        let error = read_bounded_line(&mut input).expect_err("line must be bounded");
        assert_eq!(error.code(), AgentRuntimeErrorCode::BoundedInput);
    }

    #[test]
    fn oversized_api_request_is_rejected_before_socket_connect() {
        let transport = HerdrTransport::new("/no/such/herdr.sock");
        let error = transport
            .request(
                "workspace.create",
                json!({ "payload": "x".repeat(HERDR_INITIAL_REQUEST_BYTES) }),
            )
            .expect_err("request must be rejected before connect");
        assert_eq!(error.code(), AgentRuntimeErrorCode::BoundedInput);
    }

    #[test]
    fn provider_not_found_is_a_stable_cleanup_class() {
        let line = br#"{"id":"x","error":{"code":"pane_not_found","message":"secret"}}"#;
        let error = parse_response(line).expect_err("provider error");
        assert_eq!(error.code(), AgentRuntimeErrorCode::ProviderNotFound);
        assert!(!format!("{error:?}").contains("secret"));
    }

    #[test]
    fn provider_agent_start_codes_are_classified_without_retaining_provider_text() {
        use super::super::error::ProviderErrorCategory;

        for (provider_code, expected) in [
            ("agent_name_taken", ProviderErrorCategory::AgentNameTaken),
            ("agent_pane_busy", ProviderErrorCategory::AgentPaneBusy),
            ("agent_pane_not_found", ProviderErrorCategory::AgentPaneNotFound),
            ("agent_pane_unavailable", ProviderErrorCategory::AgentPaneUnavailable),
            ("agent_start_input_failed", ProviderErrorCategory::AgentStartInputFailed),
            ("invalid_request", ProviderErrorCategory::InvalidRequest),
            ("future_private_code", ProviderErrorCategory::Other),
        ] {
            let line = format!(
                r#"{{"id":"x","error":{{"code":"{provider_code}","message":"private secret"}}}}"#
            );
            let error = parse_response(line.as_bytes()).expect_err("provider error");
            assert_eq!(error.provider_category(), Some(expected));
            assert!(!format!("{error:?}").contains(provider_code));
            assert!(!format!("{error:?}").contains("private secret"));
        }
    }

    #[test]
    fn lifecycle_subscription_covers_structural_and_agent_events() {
        let subscriptions = base_subscription_kinds();
        assert!(subscriptions.to_string().contains("pane.agent_detected"));
        assert!(subscriptions.to_string().contains("pane.updated"));
        assert!(!subscriptions.to_string().contains("pane-live"));
    }

    #[cfg(unix)]
    #[test]
    fn operation_timeout_keeps_default_requests_bounded_but_allows_agent_start_margin() {
        let socket_path = PathBuf::from(format!("/tmp/dh-to-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket_path);
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).expect("bind");
        let worker = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = Vec::new();
                let mut byte = [0_u8; 1];
                while stream.read_exact(&mut byte).is_ok() {
                    request.push(byte[0]);
                    if byte[0] == b'\n' {
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(5_500));
                let _ = stream.write_all(b"{\"result\":{\"ok\":true}}\n");
            }
        });
        let transport = HerdrTransport::new(&socket_path);
        let ordinary = transport.request("ordinary", json!({})).expect_err("default timeout");
        assert_eq!(ordinary.code(), AgentRuntimeErrorCode::Timeout);
        let started = transport
            .request_with_timeout("agent.start", json!({}), Duration::from_secs(7))
            .expect("operation margin");
        assert_eq!(started.get("ok"), Some(&Value::Bool(true)));
        worker.join().expect("server");
        let _ = std::fs::remove_file(socket_path);
    }

    #[test]
    #[ignore = "requires an isolated Herdr 0.8.1 session socket"]
    fn pinned_herdr_transport_checks_all_mutation_prerequisites() {
        let socket = std::env::var_os("DEVHUB_HERDR_API_SOCKET").expect("API socket path");
        let transport = HerdrTransport::new(socket);
        let ping = transport.request("ping", json!({})).expect("ping");
        assert_eq!(ping.get("type").and_then(Value::as_str), Some("pong"));
        assert_eq!(ping.get("version").and_then(Value::as_str), Some("0.8.1"));
        assert_eq!(ping.get("protocol").and_then(Value::as_u64), Some(20));
        transport.check_capabilities().expect("pinned capability probes");
    }
}
