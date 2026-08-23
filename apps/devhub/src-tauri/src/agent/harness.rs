//! Self-contained wire-level Herdr 0.8.1 harness.
//!
//! This is intentionally a test server, not a production fallback. It
//! implements the pinned JSON and protocol-20 control messages on isolated
//! Unix sockets so lifecycle tests exercise the real `HerdrTransport` and
//! `HerdrTerminalControl` without invoking a user's configured agent.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use devhub_app_core::ports::{AgentRuntime, CancellationToken, PortError, PortFuture};
use devhub_app_core::{
    AgentId, AgentProfile, AgentProfileId, AgentProfileKind, AgentStatus, OperationId,
    RuntimeHealth, WorkspaceId, WorkspaceRoot,
};

use super::api::{HerdrTransport, ProviderTransport};
use super::runtime::HerdrAgentRuntime;
use crate::runtime::RuntimeLaunchContext;

const VERSION: &str = "0.8.1";
const PROTOCOL: u32 = 20;
const AGENT_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const API_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Default)]
struct HarnessState {
    workspace_live: bool,
    pane_live: bool,
    agent_live: bool,
    agent_status: &'static str,
    fail_pane_close: bool,
    drop_subscriptions: bool,
    control_owner: bool,
    started_name: Option<String>,
    started_kind: Option<String>,
    started_args: Vec<String>,
    workspace_cwd: Option<String>,
}

struct Herdr081Harness {
    root: PathBuf,
    api_socket: PathBuf,
    client_socket: PathBuf,
    state: Arc<Mutex<HarnessState>>,
    stop: Arc<AtomicBool>,
    handlers: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
    api_thread: Option<thread::JoinHandle<()>>,
    client_thread: Option<thread::JoinHandle<()>>,
}

impl Herdr081Harness {
    fn new() -> Self {
        // Keep the wire harness on a short, writable path. On macOS,
        // canonicalizing `temp_dir()` can resolve into a protected
        // `/private/var/folders` path in a sandbox, and the provider socket
        // path has a small Unix-domain limit.
        let base = PathBuf::from("/tmp");
        let nonce =
            SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_nanos());
        let root = (0..100)
            .find_map(|attempt| {
                let candidate =
                    base.join(format!("dhh-{}-{}-{attempt}", std::process::id(), nonce));
                match std::fs::create_dir(&candidate) {
                    Ok(()) => Some(candidate),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => None,
                    Err(error) => panic!("harness directory: {error}"),
                }
            })
            .expect("unique harness directory");
        // Resolve only the newly-created private root. macOS exposes `/tmp`
        // as a symlink, while the production journal intentionally rejects
        // symlinked ancestors; canonicalizing this isolated directory keeps
        // that safety invariant intact without using an ambient path.
        let root = std::fs::canonicalize(root).expect("canonical harness directory");
        let api_socket = root.join("herdr.sock");
        let client_socket = root.join("herdr-client.sock");
        let api_listener = UnixListener::bind(&api_socket).expect("api socket");
        let client_listener = UnixListener::bind(&client_socket).expect("client socket");
        api_listener.set_nonblocking(true).expect("api nonblocking");
        client_listener.set_nonblocking(true).expect("client nonblocking");
        let state = Arc::new(Mutex::new(HarnessState {
            agent_status: "working",
            ..HarnessState::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let handlers = Arc::new(Mutex::new(Vec::new()));
        let api_thread = Some(spawn_listener(
            api_listener,
            Arc::clone(&state),
            Arc::clone(&stop),
            Arc::clone(&handlers),
            false,
        ));
        let client_thread = Some(spawn_listener(
            client_listener,
            Arc::clone(&state),
            Arc::clone(&stop),
            Arc::clone(&handlers),
            true,
        ));
        Self { root, api_socket, client_socket, state, stop, handlers, api_thread, client_thread }
    }

    fn transport(&self) -> HerdrTransport {
        HerdrTransport::new(&self.api_socket)
    }

    fn set_natural_exit(&self) {
        let mut state = self.state.lock().expect("harness state");
        state.agent_live = false;
        state.agent_status = "done";
    }

    fn set_transient_missing_agent(&self) {
        let mut state = self.state.lock().expect("harness state");
        state.agent_live = false;
        state.agent_status = "working";
    }

    fn restore_agent(&self) {
        let mut state = self.state.lock().expect("harness state");
        state.agent_live = true;
        state.agent_status = "working";
    }

    fn set_cleanup_failure(&self, failed: bool) {
        self.state.lock().expect("harness state").fail_pane_close = failed;
    }

    fn drop_subscriptions(&self, drop_subscriptions: bool) {
        self.state.lock().expect("harness state").drop_subscriptions = drop_subscriptions;
    }

    fn launch_observed(&self) -> (String, String, Vec<String>, String) {
        let state = self.state.lock().expect("harness state");
        (
            state.started_name.clone().expect("agent name"),
            state.started_kind.clone().expect("agent kind"),
            state.started_args.clone(),
            state.workspace_cwd.clone().expect("workspace cwd"),
        )
    }
}

impl Drop for Herdr081Harness {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = std::fs::remove_file(&self.api_socket);
        let _ = std::fs::remove_file(&self.client_socket);
        if let Some(thread) = self.api_thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.client_thread.take() {
            let _ = thread.join();
        }
        if let Ok(mut handlers) = self.handlers.lock() {
            for handler in handlers.drain(..) {
                let _ = handler.join();
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn spawn_listener(
    listener: UnixListener,
    state: Arc<Mutex<HarnessState>>,
    stop: Arc<AtomicBool>,
    handlers: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
    control: bool,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let state = Arc::clone(&state);
                    let stop = Arc::clone(&stop);
                    let handler = thread::spawn(move || {
                        if control {
                            serve_control(stream, state, stop);
                        } else {
                            serve_api(stream, state, stop);
                        }
                    });
                    if let Ok(mut handlers) = handlers.lock() {
                        handlers.push(handler);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(_) => break,
            }
        }
    })
}

fn serve_api(stream: UnixStream, state: Arc<Mutex<HarnessState>>, stop: Arc<AtomicBool>) {
    let _ = stream.set_read_timeout(Some(API_TIMEOUT));
    let writer = stream.try_clone().ok();
    let Some(mut writer) = writer else { return };
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let Ok(request) = serde_json::from_str::<Value>(&line) else { return };
    let id = request.get("id").cloned().unwrap_or_else(|| json!("harness"));
    let method = request.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    if method == "events.subscribe" {
        let _ = write_json(
            &mut writer,
            &json!({
                "id": id,
                "result": { "type": "subscription_started" },
            }),
        );
        loop {
            if stop.load(Ordering::Acquire)
                || state.lock().map(|state| state.drop_subscriptions).unwrap_or(true)
            {
                return;
            }
            let mut ignored = String::new();
            match reader.read_line(&mut ignored) {
                Ok(0) => return,
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue;
                }
                Err(_) => return,
            }
        }
    }
    if method == "pane.close" && state.lock().map(|state| state.fail_pane_close).unwrap_or(false) {
        let _ = write_json(
            &mut writer,
            &json!({
                "id": id,
                "error": { "code": "provider_error", "message": "cleanup failure" },
            }),
        );
        return;
    }
    let result = api_result(method, &params, &state);
    let _ = write_json(&mut writer, &json!({ "id": id, "result": result }));
}

fn api_result(method: &str, params: &Value, state: &Arc<Mutex<HarnessState>>) -> Value {
    match method {
        "ping" => json!({
            "type": "pong",
            "version": VERSION,
            "protocol": PROTOCOL,
            "capabilities": { "terminal_control": true },
        }),
        "session.snapshot" => session_snapshot(state),
        "workspace.list" => {
            let live = state.lock().map(|state| state.workspace_live).unwrap_or(false);
            json!({ "type": "workspace_list", "workspaces": if live {
                vec![json!({ "workspace_id": "provider-workspace" })]
            } else { Vec::new() } })
        }
        "tab.list" => {
            let live = state.lock().map(|state| state.pane_live).unwrap_or(false);
            json!({ "type": "tab_list", "tabs": if live {
                vec![json!({ "tab_id": "provider-tab" })]
            } else { Vec::new() } })
        }
        "pane.list" => {
            let live = state.lock().map(|state| state.pane_live).unwrap_or(false);
            json!({ "type": "pane_list", "panes": if live {
                vec![json!({ "pane_id": "provider-pane" })]
            } else { Vec::new() } })
        }
        "agent.list" => {
            let live = state.lock().map(|state| state.agent_live).unwrap_or(false);
            json!({ "type": "agent_list", "agents": if live {
                vec![json!({ "terminal_id": "provider-terminal" })]
            } else { Vec::new() } })
        }
        "workspace.create" => {
            let mut state = state.lock().expect("harness state");
            state.workspace_live = true;
            state.pane_live = true;
            state.agent_live = false;
            state.workspace_cwd = params.get("cwd").and_then(Value::as_str).map(str::to_owned);
            json!({
                "type": "workspace_created",
                "workspace": { "workspace_id": "provider-workspace" },
                "tab": { "tab_id": "provider-tab" },
                "root_pane": {
                    "pane_id": "provider-pane",
                    "terminal_id": "provider-terminal"
                }
            })
        }
        "agent.start" => {
            let mut state = state.lock().expect("harness state");
            state.agent_live = true;
            state.agent_status = "working";
            state.started_name = params.get("name").and_then(Value::as_str).map(str::to_owned);
            state.started_kind = params.get("kind").and_then(Value::as_str).map(str::to_owned);
            state.started_args = params
                .get("args")
                .and_then(Value::as_array)
                .map(|args| args.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            json!({
                "type": "agent_started",
                "agent": { "terminal_id": "provider-terminal" },
                "argv": state.started_args,
            })
        }
        "pane.close" => {
            let mut state = state.lock().expect("harness state");
            state.pane_live = false;
            state.agent_live = false;
            json!({ "type": "pane_info", "pane": { "pane_id": "provider-pane" } })
        }
        "workspace.close" => {
            state.lock().expect("harness state").workspace_live = false;
            json!({ "type": "workspace_info", "workspace": { "workspace_id": "provider-workspace" } })
        }
        _ => json!({ "type": "ok" }),
    }
}

fn session_snapshot(state: &Arc<Mutex<HarnessState>>) -> Value {
    let state = state.lock().expect("harness state");
    let workspaces = if state.workspace_live {
        vec![json!({
            "workspace_id": "provider-workspace",
            "label": format!("devhub-agent-{AGENT_ID}"),
        })]
    } else {
        Vec::new()
    };
    let panes = if state.pane_live {
        vec![json!({
            "pane_id": "provider-pane",
            "terminal_id": "provider-terminal",
            "workspace_id": "provider-workspace",
            "tab_id": "provider-tab",
            "agent": state.agent_live.then_some("codex"),
            "agent_status": state.agent_status,
        })]
    } else {
        Vec::new()
    };
    json!({
        "type": "session_snapshot",
        "snapshot": {
            "version": VERSION,
            "protocol": PROTOCOL,
            "focused_workspace_id": Value::Null,
            "focused_tab_id": Value::Null,
            "focused_pane_id": Value::Null,
            "workspaces": workspaces,
            "tabs": Vec::<Value>::new(),
            "panes": panes,
            "layouts": Vec::<Value>::new(),
            "agents": Vec::<Value>::new(),
        }
    })
}

fn write_json(writer: &mut UnixStream, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn serve_control(mut stream: UnixStream, state: Arc<Mutex<HarnessState>>, _stop: Arc<AtomicBool>) {
    let Ok(hello) = read_frame(&mut stream) else { return };
    if read_varint(&hello, &mut 0).ok() != Some(0) {
        return;
    }
    if write_frame(&mut stream, &welcome_frame()).is_err() {
        return;
    }
    loop {
        let Ok(frame) = read_frame(&mut stream) else { return };
        let mut offset = 0;
        let Ok(tag) = read_varint(&frame, &mut offset) else { return };
        match tag {
            4 => {
                state.lock().expect("harness state").control_owner = false;
                return;
            }
            9 => {
                let _ = read_string(&frame, &mut offset);
                let takeover = frame.get(offset).copied().unwrap_or(0) == 1;
                let mut state = state.lock().expect("harness state");
                if state.control_owner && !takeover {
                    let _ = write_frame(&mut stream, &shutdown_frame());
                    return;
                }
                state.control_owner = true;
                drop(state);
                let _ = write_frame(&mut stream, &terminal_frame());
            }
            1 => {}
            _ => return,
        }
    }
}

fn welcome_frame() -> Vec<u8> {
    let mut payload = vec![0];
    push_varint(&mut payload, u64::from(PROTOCOL));
    push_varint(&mut payload, 1);
    payload.push(0);
    payload
}

fn terminal_frame() -> Vec<u8> {
    let mut payload = vec![2];
    push_varint(&mut payload, 1);
    push_varint(&mut payload, 80);
    push_varint(&mut payload, 24);
    payload.push(1);
    push_bytes(&mut payload, b"herdr-harness\n");
    payload
}

fn shutdown_frame() -> Vec<u8> {
    vec![4, 0]
}

fn write_frame(stream: &mut UnixStream, payload: &[u8]) -> io::Result<()> {
    stream.write_all(&(payload.len() as u32).to_le_bytes())?;
    stream.write_all(payload)?;
    stream.flush()
}

fn read_frame(stream: &mut UnixStream) -> io::Result<Vec<u8>> {
    let mut length = [0; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > 2 * 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bounded frame"));
    }
    let mut payload = vec![0; length];
    stream.read_exact(&mut payload)?;
    Ok(payload)
}

fn read_varint(frame: &[u8], offset: &mut usize) -> io::Result<u64> {
    let marker = *frame
        .get(*offset)
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "varint"))?;
    *offset += 1;
    match marker {
        value @ 0..=250 => Ok(u64::from(value)),
        251 => {
            let bytes = frame
                .get(*offset..*offset + 2)
                .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "varint"))?;
            *offset += 2;
            Ok(u64::from(u16::from_le_bytes([bytes[0], bytes[1]])))
        }
        252 => {
            let bytes = frame
                .get(*offset..*offset + 4)
                .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "varint"))?;
            *offset += 4;
            Ok(u64::from(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        }
        253 => {
            let bytes = frame
                .get(*offset..*offset + 8)
                .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "varint"))?;
            *offset += 8;
            Ok(u64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ]))
        }
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, "varint")),
    }
}

fn read_string(frame: &[u8], offset: &mut usize) -> io::Result<String> {
    let length = usize::try_from(read_varint(frame, offset)?).unwrap_or(usize::MAX);
    let bytes = frame
        .get(*offset..*offset + length)
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "string"))?;
    *offset += length;
    String::from_utf8(bytes.to_vec())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "utf8"))
}

fn push_varint(payload: &mut Vec<u8>, value: u64) {
    if value < 251 {
        payload.push(value as u8);
    } else if value <= u64::from(u16::MAX) {
        payload.push(251);
        payload.extend_from_slice(&(value as u16).to_le_bytes());
    } else if value <= u64::from(u32::MAX) {
        payload.push(252);
        payload.extend_from_slice(&(value as u32).to_le_bytes());
    } else {
        payload.push(253);
        payload.extend_from_slice(&value.to_le_bytes());
    }
}

fn push_bytes(payload: &mut Vec<u8>, value: &[u8]) {
    push_varint(payload, value.len() as u64);
    payload.extend_from_slice(value);
}

fn token(seed: u8) -> CancellationToken {
    let mut id = *b"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    id[0] = b"abcdef0123456789"[usize::from(seed) % 16];
    CancellationToken::new(
        OperationId::from_uuid(String::from_utf8(id.to_vec()).expect("operation id"))
            .expect("operation"),
    )
}

fn drive<T>(future: PortFuture<T>) -> Result<T, PortError> {
    let mut future = future;
    let waker = std::task::Waker::noop();
    let mut context = std::task::Context::from_waker(waker);
    loop {
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(result) => return result,
            std::task::Poll::Pending => thread::sleep(Duration::from_millis(2)),
        }
    }
}

fn profile() -> AgentProfile {
    let mut env = BTreeMap::new();
    env.insert("DEVHUB_HARNESS".to_owned(), "1".to_owned());
    AgentProfile::new(
        AgentProfileId::from_slug("codex").expect("profile id"),
        "User-facing Codex",
        AgentProfileKind::Codex,
        vec!["--deterministic".to_owned()],
        env,
    )
    .expect("profile")
}

#[test]
fn pinned_herdr_081_harness_covers_launch_status_exit_reconnect_surface_and_retry() {
    let harness = Herdr081Harness::new();
    let home = harness.root.join("home");
    std::fs::create_dir_all(&home).expect("home");
    let context =
        RuntimeLaunchContext::new(home, std::env::vars_os().collect()).expect("launch context");
    let transport = Arc::new(harness.transport());
    let runtime = HerdrAgentRuntime::with_transport_and_journal(
        context,
        Arc::clone(&transport) as Arc<dyn ProviderTransport>,
        harness.root.join("agent-runtime-journal.json"),
    );
    let agent_id = AGENT_ID.parse::<AgentId>().expect("agent id");
    let workspace_id = WORKSPACE_ID.parse::<WorkspaceId>().expect("workspace id");
    let root = WorkspaceRoot::new("/tmp/devhub-herdr-harness").expect("workspace root");
    runtime
        .register_agent_workspace(agent_id.clone(), workspace_id.clone(), root.clone())
        .expect("registration");
    assert!(drive(runtime.bootstrap(token(0))).expect("bootstrap").is_ready());

    let receipt = drive(runtime.launch_for_workspace(
        workspace_id,
        root,
        agent_id.clone(),
        profile(),
        token(1),
    ))
    .expect("launch");
    assert_eq!(receipt.agent_id, agent_id);
    let (name, kind, args, cwd) = harness.launch_observed();
    assert!(name.len() <= 32 && name.starts_with('a'));
    assert_eq!(kind, "codex");
    assert_eq!(args, vec!["--deterministic"]);
    assert_eq!(cwd, "/tmp/devhub-herdr-harness");

    // Agent detection is asynchronous in Herdr. A pane with a live terminal
    // and a non-terminal status must remain observable even if its agent
    // label is absent for one authoritative snapshot.
    harness.set_transient_missing_agent();

    let direct_control = transport
        .open_control("provider-terminal", false)
        .unwrap_or_else(|error| panic!("wire control open: {error:?}"));
    direct_control.detach();
    thread::sleep(Duration::from_millis(10));

    let observation = drive(runtime.reconcile(token(2))).expect("status reconcile");
    assert_eq!(observation.observations()[0].status(), AgentStatus::Working);
    assert_eq!(observation.observations()[0].runtime_health(), RuntimeHealth::Healthy);
    assert!(observation.exited().is_empty());
    harness.restore_agent();

    let first_surface =
        drive(runtime.attach_surface(agent_id.clone(), "surface-a".to_owned(), false, token(3)))
            .expect("surface attach");
    assert!(first_surface.read_recent().expect("terminal frame").contains("herdr-harness"));
    assert!(drive(runtime.attach_surface(
        agent_id.clone(),
        "surface-a".to_owned(),
        true,
        token(4),
    ))
    .is_err());
    first_surface.detach();
    let second_surface =
        drive(runtime.attach_surface(agent_id.clone(), "surface-b".to_owned(), true, token(5)))
            .expect("conditional takeover after detach");
    second_surface.detach();

    harness.drop_subscriptions(true);
    thread::sleep(Duration::from_millis(250));
    harness.drop_subscriptions(false);
    let _ = drive(runtime.reconcile(token(6))).expect("reconnect reconcile");

    harness.set_natural_exit();
    harness.set_cleanup_failure(true);
    let exited = drive(runtime.reconcile(token(7))).expect("natural exit reconcile");
    assert_eq!(exited.exited(), std::slice::from_ref(&agent_id));
    harness.set_cleanup_failure(false);
    thread::sleep(Duration::from_millis(250));
    let _ = drive(runtime.reconcile(token(8))).expect("tombstone retry");
}

#[test]
fn missing_agent_identity_is_observable_before_confirmation_and_exit_after_confirmation() {
    let harness = Herdr081Harness::new();
    let home = harness.root.join("home");
    std::fs::create_dir_all(&home).expect("home");
    let context =
        RuntimeLaunchContext::new(home, std::env::vars_os().collect()).expect("launch context");
    let transport = Arc::new(harness.transport());
    let runtime = HerdrAgentRuntime::with_transport_and_journal(
        context,
        Arc::clone(&transport) as Arc<dyn ProviderTransport>,
        harness.root.join("agent-runtime-journal.json"),
    );
    let agent_id = AGENT_ID.parse::<AgentId>().expect("agent id");
    let workspace_id = WORKSPACE_ID.parse::<WorkspaceId>().expect("workspace id");
    let root = WorkspaceRoot::new("/tmp/devhub-herdr-startup-missing").expect("workspace root");
    runtime
        .register_agent_workspace(agent_id.clone(), workspace_id.clone(), root.clone())
        .expect("registration");
    assert!(drive(runtime.bootstrap(token(9))).expect("bootstrap").is_ready());
    drive(runtime.launch_for_workspace(workspace_id, root, agent_id.clone(), profile(), token(10)))
        .expect("launch");

    // The first authoritative snapshot can have a live pane but no detected
    // agent identity while Herdr is still settling the managed process.
    harness.set_transient_missing_agent();
    let startup = drive(runtime.reconcile(token(11))).expect("startup reconcile");
    assert!(startup.exited().is_empty());
    assert_eq!(startup.observations().len(), 1);

    // Once a snapshot confirms the agent, the same missing identity means
    // that the agent exited even though Herdr kept the pane alive.
    harness.restore_agent();
    let confirmed = drive(runtime.reconcile(token(12))).expect("confirmation reconcile");
    assert!(confirmed.exited().is_empty());
    harness.set_transient_missing_agent();
    let exited = drive(runtime.reconcile(token(13))).expect("post-confirmation reconcile");
    assert_eq!(exited.exited(), std::slice::from_ref(&agent_id));
}
