//! Ignored end-to-end coverage for the real Herdr 0.8.1 adapter.
//!
//! The runner in `scripts/check-herdr-081-adapter-integration.sh` supplies an
//! isolated HOME/XDG tree, a real headless Herdr session, and deterministic
//! `codex`/`claude` executables.  Keeping this test next to the adapter lets it
//! exercise the same private transport/control boundary as production code;
//! it is ignored because it needs that externally managed session.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::task::{Context, Poll};
use std::thread;
use std::time::{Duration, Instant};

use devhub_app_core::ports::{
    AgentRuntime, CancellationToken, PortError, PortErrorCode, PortFuture,
};
use devhub_app_core::{
    AgentId, AgentProfile, AgentProfileId, AgentProfileKind, AgentReconciliation, AgentStatus,
    OperationId, RuntimeHealth, WorkspaceId, WorkspaceRoot,
};

use super::runtime::HerdrAgentRuntime;
use super::surface::AgentSurface;

const SESSION_NAME: &str = "devhub-session";
const API_SOCKET_ENV: &str = "DEVHUB_HERDR_API_SOCKET";
const CLIENT_SOCKET_ENV: &str = "DEVHUB_HERDR_CLIENT_SOCKET";
const WORKSPACE_ENV: &str = "DEVHUB_HERDR_WORKSPACE_ROOT";
const SERVER_PID_ENV: &str = "DEVHUB_HERDR_SERVER_PID";
const ADAPTER_PID_FILE_ENV: &str = "DEVHUB_HERDR_ADAPTER_PID_FILE";
const TRACE_ENV: &str = "DEVHUB_HERDR_TRACE_FILE";
const HOME_ENV: &str = "DEVHUB_HERDR_HOME";
const PID_DIR_ENV: &str = "DEVHUB_HERDR_PID_DIR";
const AGENT_PATH_ENV: &str = "DEVHUB_HERDR_AGENT_PATH";
const HERDR_BIN_ENV: &str = "DEVHUB_HERDR_BIN";
const API_TIMEOUT: Duration = Duration::from_secs(10);

const CODEX_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CODEX_WORKSPACE_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLAUDE_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLAUDE_WORKSPACE_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

fn required_path(name: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| panic!("{name} must be an absolute path"))
}

fn token(sequence: u32) -> CancellationToken {
    let operation = format!("{sequence:08x}-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    CancellationToken::new(OperationId::from_uuid(operation).expect("operation UUID"))
}

fn drive<T>(future: PortFuture<T>) -> Result<T, PortError> {
    let mut future = future;
    let waker = std::task::Waker::noop();
    let mut context = Context::from_waker(waker);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(result) => return result,
            Poll::Pending => thread::sleep(Duration::from_millis(5)),
        }
    }
}

fn profile(
    id: &str,
    display_name: &str,
    kind: AgentProfileKind,
    args: &[&str],
    trace: &Path,
) -> AgentProfile {
    let mut env = BTreeMap::new();
    env.insert("DEVHUB_HERDR_HARNESS".to_owned(), "1".to_owned());
    let kind_name = match kind {
        AgentProfileKind::Codex => "codex",
        AgentProfileKind::Claude => "claude",
    };
    env.insert("DEVHUB_HERDR_HARNESS_KIND".to_owned(), kind_name.to_owned());
    // Herdr 0.8.1 uses this process-environment hint on macOS when a test
    // executable is a deterministic wrapper rather than the real provider.
    env.insert("HERDR_AGENT".to_owned(), kind_name.to_owned());
    env.insert("DEVHUB_HERDR_TRACE_FILE".to_owned(), trace.to_string_lossy().into_owned());
    let pid_dir = required_path(PID_DIR_ENV);
    env.insert("DEVHUB_HERDR_PID_DIR".to_owned(), pid_dir.to_string_lossy().into_owned());
    let agent_path = std::env::var(AGENT_PATH_ENV).expect("dummy agent PATH");
    env.insert("PATH".to_owned(), agent_path);
    AgentProfile::new(
        AgentProfileId::from_slug(id).expect("profile id"),
        display_name,
        kind,
        args.iter().map(|arg| (*arg).to_owned()).collect(),
        env,
    )
    .expect("profile")
}

fn wait_for_trace(trace: &Path, needle: &str) {
    let deadline = Instant::now() + API_TIMEOUT;
    loop {
        let content = fs::read_to_string(trace).unwrap_or_default();
        if content.contains(needle) {
            return;
        }
        assert!(Instant::now() < deadline, "dummy agent did not emit {needle}");
        thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for_active(
    runtime: &HerdrAgentRuntime,
    agent_id: &AgentId,
    sequence: &mut u32,
) -> AgentReconciliation {
    let deadline = Instant::now() + API_TIMEOUT;
    loop {
        let result = drive(runtime.reconcile(token(*sequence)));
        *sequence = sequence.saturating_add(1);
        if let Ok(reconciliation) = result {
            if let Some(observation) =
                reconciliation.observations().iter().find(|item| item.agent_id() == agent_id)
            {
                if observation.runtime_health() == RuntimeHealth::Healthy
                    && observation.status() != AgentStatus::Error
                {
                    return reconciliation;
                }
            }
        }
        assert!(Instant::now() < deadline, "agent did not become observable");
        thread::sleep(Duration::from_millis(100));
    }
}

fn wait_for_exit(
    runtime: &HerdrAgentRuntime,
    agent_id: &AgentId,
    sequence: &mut u32,
) -> AgentReconciliation {
    let deadline = Instant::now() + API_TIMEOUT;
    loop {
        if let Ok(reconciliation) = drive(runtime.reconcile(token(*sequence))) {
            *sequence = sequence.saturating_add(1);
            if reconciliation.exited().iter().any(|id| id == agent_id) {
                return reconciliation;
            }
        } else {
            *sequence = sequence.saturating_add(1);
        }
        assert!(Instant::now() < deadline, "agent did not naturally exit");
        thread::sleep(Duration::from_millis(100));
    }
}

fn attach_with_retry(
    runtime: &HerdrAgentRuntime,
    agent_id: AgentId,
    surface_key: &str,
    takeover: bool,
    sequence: &mut u32,
) -> AgentSurface {
    let deadline = Instant::now() + API_TIMEOUT;
    loop {
        match drive(runtime.attach_surface(
            agent_id.clone(),
            surface_key.to_owned(),
            takeover,
            token(*sequence),
        )) {
            Ok(surface) => return surface,
            Err(error) if error.code() == PortErrorCode::Conflict => {}
            Err(error) => panic!("surface attach failed with {:?}", error.code()),
        }
        *sequence = sequence.saturating_add(1);
        assert!(Instant::now() < deadline, "surface attach did not become available");
        thread::sleep(Duration::from_millis(100));
    }
}

fn socket_is_reachable(path: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}

fn wait_for_socket_disconnect(path: &Path) {
    let deadline = Instant::now() + API_TIMEOUT;
    while socket_is_reachable(path) {
        assert!(Instant::now() < deadline, "Herdr socket stayed reachable after crash");
        thread::sleep(Duration::from_millis(50));
    }
}

fn kill_server(pid: u32) {
    let status = Command::new("/bin/kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .expect("kill provider server");
    assert!(status.success(), "failed to crash isolated Herdr server");
}

fn adapter_server_pid(herdr: &Path) -> Option<u32> {
    let output = Command::new("/bin/ps").args(["-axo", "pid=,ppid=,command="]).output().ok()?;
    let parent = std::process::id().to_string();
    let binary = fs::canonicalize(herdr).ok()?;
    output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter_map(|line| std::str::from_utf8(line).ok())
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let ppid = fields.next()?;
            let executable = fields.next()?;
            let executable_matches =
                fs::canonicalize(executable).map(|path| path == binary).unwrap_or(false);
            let fixed_server_args = fields.next() == Some("--session")
                && fields.next() == Some(SESSION_NAME)
                && fields.next() == Some("server")
                && fields.next().is_none();
            (ppid == parent && executable_matches && fixed_server_args).then_some(pid)
        })
        .next()
}

fn record_adapter_server_pid(herdr: &Path) {
    let Some(path) = std::env::var_os(ADAPTER_PID_FILE_ENV).map(PathBuf::from) else {
        return;
    };
    let deadline = Instant::now() + API_TIMEOUT;
    let pid = loop {
        if let Some(pid) = adapter_server_pid(herdr) {
            break pid;
        }
        assert!(Instant::now() < deadline, "adapter restart server child");
        thread::sleep(Duration::from_millis(50));
    };
    fs::write(path, pid.to_string()).expect("record adapter server child");
}

#[test]
#[ignore = "requires the isolated real Herdr 0.8.1 runner"]
fn real_herdr_agent_runtime_lifecycle() {
    let herdr = required_path(HERDR_BIN_ENV);
    let api_socket = required_path(API_SOCKET_ENV);
    let client_socket = required_path(CLIENT_SOCKET_ENV);
    let workspace_path = required_path(WORKSPACE_ENV);
    let trace = required_path(TRACE_ENV);
    let home = required_path(HOME_ENV);
    let xdg_config = required_path("XDG_CONFIG_HOME");
    let expected_api =
        xdg_config.join("herdr").join("sessions").join(SESSION_NAME).join("herdr.sock");
    let expected_client = expected_api.with_file_name("herdr-client.sock");
    assert_eq!(api_socket, expected_api, "runner must expose Herdr's source-defined API socket");
    assert_eq!(client_socket, expected_client);
    assert!(workspace_path.is_dir(), "workspace root must exist");

    // The runner keeps Cargo's HOME on the host cache while the adapter test
    // itself must launch every replacement Herdr process inside this
    // isolated home.
    std::env::set_var("HOME", &home);
    let journal = home.join("devhub-agent-runtime-journal.json");
    let runtime =
        HerdrAgentRuntime::from_environment_with_journal(&home, herdr.to_string_lossy(), &journal)
            .expect("adapter construction");
    let mut sequence = 1_u32;
    assert!(drive(runtime.bootstrap(token(sequence))).expect("adapter bootstrap").is_ready());
    sequence += 1;

    let codex_id = CODEX_ID.parse::<AgentId>().expect("codex id");
    let codex_workspace = CODEX_WORKSPACE_ID.parse::<WorkspaceId>().expect("codex workspace id");
    let codex_root = WorkspaceRoot::new(&workspace_path).expect("codex workspace root");
    let codex_profile = profile(
        "codex-real",
        "Real Herdr Codex",
        AgentProfileKind::Codex,
        &["--deterministic", "--a3_6-codex"],
        &trace,
    );
    let receipt = drive(runtime.launch_for_workspace(
        codex_workspace,
        codex_root,
        codex_id.clone(),
        codex_profile,
        token(sequence),
    ))
    .expect("codex launch");
    assert_eq!(receipt.agent_id, codex_id);
    sequence += 1;
    wait_for_trace(&trace, "kind=codex args=--deterministic --a3_6-codex");
    let _ = wait_for_active(&runtime, &codex_id, &mut sequence);

    let first =
        attach_with_retry(&runtime, codex_id.clone(), "codex-surface-a", false, &mut sequence);
    let recent = first.read_recent().expect("codex terminal output");
    assert!(
        recent
            .windows(b"DEVHUB_HERDR_CODEX_READY".len())
            .any(|window| window == b"DEVHUB_HERDR_CODEX_READY"),
        "unexpected deterministic terminal output"
    );
    let live_owner = match drive(runtime.attach_surface(
        codex_id.clone(),
        "codex-surface-b".to_owned(),
        true,
        token(sequence),
    )) {
        Ok(_) => panic!("live surface must own terminal control"),
        Err(error) => error,
    };
    assert_eq!(live_owner.code(), PortErrorCode::Conflict);
    sequence += 1;
    first.detach();
    let takeover =
        attach_with_retry(&runtime, codex_id.clone(), "codex-surface-b", true, &mut sequence);
    takeover.send_text("DEVHUB_HERDR_HARNESS_EXIT\n").expect("natural exit input");
    let _ = wait_for_exit(&runtime, &codex_id, &mut sequence);
    takeover.detach();
    let _ = drive(runtime.reconcile(token(sequence))).expect("post-exit cleanup retry");
    sequence += 1;

    let server_pid = std::env::var(SERVER_PID_ENV)
        .expect("runner server PID")
        .parse::<u32>()
        .expect("runner server PID value");
    kill_server(server_pid);
    wait_for_socket_disconnect(&api_socket);
    let reconnected = {
        let deadline = Instant::now() + API_TIMEOUT;
        loop {
            match drive(runtime.reconcile(token(sequence))) {
                Ok(reconciliation) if runtime.health().is_ready() => break reconciliation,
                Ok(_) | Err(_) => {
                    sequence = sequence.saturating_add(1);
                    assert!(Instant::now() < deadline, "adapter did not reconnect Herdr");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    };
    assert!(reconnected.observations().is_empty());
    record_adapter_server_pid(&herdr);

    let claude_id = CLAUDE_ID.parse::<AgentId>().expect("claude id");
    let claude_workspace = CLAUDE_WORKSPACE_ID.parse::<WorkspaceId>().expect("claude workspace id");
    let claude_root = WorkspaceRoot::new(&workspace_path).expect("claude workspace root");
    let claude_profile = profile(
        "claude-real",
        "Real Herdr Claude",
        AgentProfileKind::Claude,
        &["--deterministic", "--a3_6-claude"],
        &trace,
    );
    let claude_receipt = drive(runtime.launch_for_workspace(
        claude_workspace,
        claude_root,
        claude_id.clone(),
        claude_profile,
        token(sequence),
    ))
    .expect("claude launch");
    assert_eq!(claude_receipt.agent_id, claude_id);
    sequence += 1;
    wait_for_trace(&trace, "kind=claude args=--deterministic --a3_6-claude");
    let _ = wait_for_active(&runtime, &claude_id, &mut sequence);
    drive(runtime.terminate(claude_id.clone(), token(sequence))).expect("explicit claude close");
    sequence += 1;
    let closed = drive(runtime.reconcile(token(sequence))).expect("claude close reconciliation");
    assert!(!closed.observations().iter().any(|item| item.agent_id() == &claude_id));

    let mut trace_content = String::new();
    fs::File::open(trace)
        .expect("trace file")
        .read_to_string(&mut trace_content)
        .expect("read trace file");
    assert!(trace_content.contains("kind=codex args=--deterministic --a3_6-codex"));
    assert!(trace_content.contains("kind=claude args=--deterministic --a3_6-claude"));
}
