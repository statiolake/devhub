//! Production EditorHost orchestrator.
//!
//! This is the deep module's public seam: callers ask it to ensure the shared
//! server, mount one semantic surface, update its native bounds/focus, close a
//! Workspace surface, or shut the provider down. Stable ports, tokens,
//! process supervision, registry persistence, and the server address stay
//! inside this implementation.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::runtime::ShutdownSignal;
use devhub_app_core::ports::{
    CancellationToken, EditorHost as EditorHostPort, EditorHostResult, PortError, PortErrorCode,
    PortFuture,
};
use devhub_app_core::WorkspaceId;

#[cfg(test)]
use super::bridge::NoopBridgeInstaller;
use super::bridge::{BridgeInstaller, BridgePackage, SystemBridgeInstaller};
use super::bridge_transport::{
    BridgeEventSink, BridgeTransport, BridgeTransportFactory, NoopBridgeEventSink,
    SystemBridgeTransportFactory,
};
use super::error::{EditorError, EditorErrorCode, EditorResult};
use super::paths::{
    append_lifecycle_log, clear_server_pid, read_server_pid, record_server_pid, EditorPaths,
    LifecycleEvent,
};
use super::port::{PortAllocator, SystemPortAllocator};
use super::process::{
    OrphanReclaimer, ProcessAdapter, ProcessSpec, ProcessSupervisor, SystemOrphanReclaimer,
    SystemProcessAdapter, MAX_RESTARTS,
};
use super::provider::EditorExecutable;
use super::readiness::{ReadinessProbe, SystemReadinessProbe};
use super::registry::SurfaceRegistry;
use super::token::SecretToken;
use super::url::EditorOrigin;

pub struct EditorHostConfig {
    pub home: PathBuf,
    /// DevHub-owned resources, including the verified Bridge VSIX.
    pub resource_dir: Option<PathBuf>,
    event_sink: Option<Arc<dyn BridgeEventSink>>,
    /// Overrides the staged server. Tests point this at a fixture; production
    /// resolves from the app's resources.
    server_executable: Option<PathBuf>,
}

impl EditorHostConfig {
    pub fn new(home: impl Into<PathBuf>, resource_dir: Option<PathBuf>) -> Self {
        Self { home: home.into(), resource_dir, event_sink: None, server_executable: None }
    }

    pub fn with_bridge_event_sink(mut self, sink: Arc<dyn BridgeEventSink>) -> Self {
        self.event_sink = Some(sink);
        self
    }

    pub fn with_server_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.server_executable = Some(path.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EditorSurfaceKey {
    Global,
    Workspace(String),
}

impl EditorSurfaceKey {
    pub fn from_wire(value: &str) -> EditorResult<Self> {
        if value == "global-editor" {
            return Ok(Self::Global);
        }
        let Some(workspace_id) = value.strip_prefix("workspace-editor:") else {
            return Err(EditorError::new(EditorErrorCode::InvalidSurface));
        };
        validate_uuid(workspace_id)?;
        Ok(Self::Workspace(workspace_id.to_owned()))
    }

    pub fn wire_name(&self) -> String {
        match self {
            Self::Global => "global-editor".to_owned(),
            Self::Workspace(id) => format!("workspace-editor:{id}"),
        }
    }
}

/// How the App Shell reaches the running server.
#[derive(Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorRemote {
    pub authority: String,
    /// Authenticates the Workbench's socket. Redacted from `Debug` for the
    /// same reason every other provider secret is.
    pub connection_token: String,
    /// The VS Code release identity the Workbench must agree with.
    pub commit: String,
}

impl std::fmt::Debug for EditorRemote {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EditorRemote")
            .field("authority", &self.authority)
            .field("connection_token", &"<redacted>")
            .field("commit", &self.commit)
            .finish()
    }
}

#[derive(Clone)]
struct Runtime {
    paths: EditorPaths,
    executable: EditorExecutable,
    token: SecretToken,
    /// Absent until the server announces the port it bound. It stays fixed
    /// for the rest of the run, including across a crash restart, because
    /// every Editor frame is already connected to it.
    origin: Option<EditorOrigin>,
    bridge: BridgeTransport,
    bridge_installed: bool,
}

impl Runtime {
    fn origin(&self) -> EditorResult<EditorOrigin> {
        self.origin.ok_or_else(|| EditorError::new(EditorErrorCode::ProcessUnavailable))
    }
}

#[derive(Default)]
struct HostState {
    runtime: Option<Runtime>,
    failed: Option<EditorErrorCode>,
}

pub struct EditorHost {
    config: EditorHostConfig,
    state: Mutex<HostState>,
    process: Mutex<ProcessSupervisor>,
    process_adapter: Arc<dyn ProcessAdapter>,
    readiness: Arc<dyn ReadinessProbe>,
    port_allocator: Arc<dyn PortAllocator>,
    bridge_installer: Option<Arc<dyn BridgeInstaller>>,
    bridge_factory: Arc<dyn BridgeTransportFactory>,
    reclaimer: Arc<dyn OrphanReclaimer>,
}

impl EditorHost {
    pub fn new(config: EditorHostConfig) -> Self {
        Self::with_adapters_and_bridge_installer(
            config,
            Arc::new(SystemProcessAdapter),
            Arc::new(SystemReadinessProbe),
            Arc::new(SystemPortAllocator),
            Arc::new(SystemBridgeInstaller),
            Arc::new(SystemBridgeTransportFactory),
        )
    }

    #[cfg(test)]
    pub(crate) fn with_adapters(
        config: EditorHostConfig,
        process_adapter: Arc<dyn ProcessAdapter>,
        readiness: Arc<dyn ReadinessProbe>,
        port_allocator: Arc<dyn PortAllocator>,
    ) -> Self {
        Self::with_adapters_and_bridge_installer(
            config,
            process_adapter,
            readiness,
            port_allocator,
            Arc::new(NoopBridgeInstaller),
            Arc::new(super::bridge_transport::NoopBridgeTransportFactory),
        )
    }

    fn with_adapters_and_bridge_installer(
        config: EditorHostConfig,
        process_adapter: Arc<dyn ProcessAdapter>,
        readiness: Arc<dyn ReadinessProbe>,
        port_allocator: Arc<dyn PortAllocator>,
        bridge_installer: Arc<dyn BridgeInstaller>,
        bridge_factory: Arc<dyn BridgeTransportFactory>,
    ) -> Self {
        Self {
            config,
            state: Mutex::new(HostState::default()),
            process: Mutex::new(ProcessSupervisor::new(MAX_RESTARTS)),
            process_adapter,
            readiness,
            port_allocator,
            bridge_installer: Some(bridge_installer),
            bridge_factory,
            reclaimer: Arc::new(SystemOrphanReclaimer),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_orphan_reclaimer(mut self, reclaimer: Arc<dyn OrphanReclaimer>) -> Self {
        self.reclaimer = reclaimer;
        self
    }

    /// A read-only host health fact for the Settings recheck seam.
    ///
    /// The server's own readiness is reported by the Bridge sink; this says
    /// only whether the host is holding a server it believes is running.
    pub fn recheck_health(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.runtime.is_some())
    }

    /// Reconcile the managed provider after its Bridge connection disappears.
    ///
    /// The server owns the state that matters — the open documents and their
    /// hot-exit records — and each Editor frame reconnects to it on its own.
    /// So this restarts the server if it needs restarting and stops there;
    /// there are no native children to rebuild around it.
    pub fn recover_after_provider_disconnect(&self) -> EditorResult<()> {
        self.ensure_server()?;
        Ok(())
    }

    /// The directories whose files the browser itself has to load.
    ///
    /// An icon theme's font and images are loaded by the browser, not read
    /// through the connection, so the host has to serve them — and it should
    /// serve exactly these and nothing else. Resolved from where the server
    /// actually is, which differs between a source build and a packaged app
    /// and is not something a static list of paths can name.
    pub fn browser_readable_directories(&self) -> EditorResult<Vec<PathBuf>> {
        let executable = super::provider::BundledServerExecutable::resolve(
            self.config.server_executable.as_deref(),
            self.config.resource_dir.as_deref(),
        )?;
        let server_root = executable
            .path()
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?
            .to_path_buf();
        let paths = EditorPaths::new(&self.config.home);
        Ok(vec![server_root, paths.extensions().to_path_buf()])
    }

    /// Start the server if it is not running, and say how to reach it.
    ///
    /// The Workbench runs in the App Shell's own document and speaks to the
    /// server directly, so this is the whole seam: an authority to open a
    /// socket to, and the token that authenticates it.
    pub fn ensure_remote(&self) -> EditorResult<EditorRemote> {
        self.ensure_server()?;
        let state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let runtime = state
            .runtime
            .as_ref()
            .ok_or_else(|| EditorError::new(EditorErrorCode::ProcessUnavailable))?;
        Ok(EditorRemote {
            authority: runtime.origin()?.authority(),
            connection_token: runtime.token.hex(),
            commit: runtime.executable.commit.clone(),
        })
    }

    pub fn ensure_server(&self) -> EditorResult<EditorHostResult> {
        let prior_runtime = self
            .state
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?
            .runtime
            .clone();
        let process_running = {
            let mut process = self
                .process
                .lock()
                .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
            let running = process.is_running()?;
            if !running {
                process.forget_after_exit();
            }
            running
        };

        if process_running {
            let runtime = prior_runtime
                .as_ref()
                .ok_or_else(|| EditorError::new(EditorErrorCode::ProcessUnavailable))?;
            match self.readiness.wait_ready(
                runtime.origin()?,
                &runtime.token,
                runtime.executable.readiness_timeout(),
            ) {
                Ok(()) => return Ok(EditorHostResult { ready: true }),
                Err(_) => {
                    self.process
                        .lock()
                        .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?
                        .stop()?;
                }
            }
        }

        let mut runtime = if let Some(runtime) = prior_runtime {
            runtime
        } else {
            let executable = EditorExecutable::resolve(
                self.config.server_executable.as_deref(),
                self.config.resource_dir.as_deref(),
            )?;
            let paths = EditorPaths::new(&self.config.home);
            paths.ensure_directories()?;
            append_lifecycle_log(&paths, LifecycleEvent::RuntimePrepared)?;
            // A run that was killed outright leaves its own server behind. It
            // is holding nothing DevHub needs any more, but it is a whole VS
            // Code Server per lost run, so it is stopped rather than collected.
            self.reclaim_orphaned_server(&paths);
            // The Editor origin outlives every server, and so does what the
            // Workbench stored against it.
            let token = SecretToken::issue(paths.token_file())?;
            let bridge_token = SecretToken::issue_ephemeral()?;
            // Opening it writes the file the Bridge extension is pointed at,
            // and its ids are what the Bridge reports each Surface under.
            let registry = SurfaceRegistry::open(paths.root().join("surface-registry.json"))?;
            let expected = registry.core_surface_ids()?;
            let sink: Arc<dyn BridgeEventSink> =
                self.config.event_sink.clone().unwrap_or_else(|| Arc::new(NoopBridgeEventSink));
            let bridge = self.bridge_factory.bind(bridge_token, expected, sink)?;
            Runtime { paths, executable, token, origin: None, bridge, bridge_installed: false }
        };
        if !runtime.bridge_installed {
            let bridge_installer = self
                .bridge_installer
                .as_ref()
                .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
            let package = BridgePackage::resolve(self.config.resource_dir.as_deref())?;
            bridge_installer.install(&package, &runtime.executable, &runtime.paths)?;
            runtime.bridge_installed = true;
        }
        let mut process = self
            .process
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let mut attempt = 0_u8;
        loop {
            if attempt > 0 {
                let delay = match attempt {
                    1 => Duration::from_millis(100),
                    2 => Duration::from_millis(250),
                    _ => Duration::from_secs(1),
                };
                thread::sleep(delay);
            }
            // Rebuilt every attempt: the first start asks for any port, and a
            // restart asks for the one already announced, so surfaces mounted
            // against that origin survive it.
            let spec = self.server_spec(&runtime)?;
            process.spawn(self.process_adapter.as_ref(), &spec)?;
            if let Some(identity) = process.process() {
                append_lifecycle_log(
                    &runtime.paths,
                    LifecycleEvent::ServerStarted { pid: identity.pid() },
                )?;
            }
            let budget = Instant::now() + runtime.executable.readiness_timeout();
            let started = match process.observed_origin_port(budget) {
                Some(port) => {
                    runtime.origin = Some(EditorOrigin::new(port)?);
                    // The surfaces keep their origin; only what stands behind
                    // it moves.
                    if let Some(identity) = process.process() {
                        record_server_pid(&runtime.paths, identity.pid(), port);
                    }
                    self.readiness.wait_ready(
                        runtime.origin()?,
                        &runtime.token,
                        runtime.executable.readiness_timeout(),
                    )
                }
                // A server that never says where it is listening is a server
                // that cannot be reached, which is the same dead end as one
                // that never becomes ready.
                None => Err(EditorError::new(EditorErrorCode::ReadinessTimeout)),
            };
            match started {
                Ok(()) => {
                    process.mark_ready();
                    append_lifecycle_log(&runtime.paths, LifecycleEvent::ServerReady)?;
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
                    state.failed = None;
                    state.runtime = Some(runtime);
                    return Ok(EditorHostResult { ready: true });
                }
                Err(error) => {
                    if let Err(stop_error) = process.stop() {
                        let mut state = self
                            .state
                            .lock()
                            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
                        state.failed = Some(stop_error.code());
                        state.runtime = Some(runtime.clone());
                        return Err(EditorError::from_code(stop_error.code()));
                    }
                    if process.note_failed_start().is_err() {
                        let mut state = self
                            .state
                            .lock()
                            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
                        state.failed = Some(error.code());
                        state.runtime = Some(runtime.clone());
                        return Err(EditorError::from_code(error.code()));
                    }
                    attempt = attempt.saturating_add(1);
                    append_lifecycle_log(
                        &runtime.paths,
                        LifecycleEvent::ServerRestarted { attempt },
                    )?;
                }
            }
        }
    }

    /// Completes a previously deferred typed Bridge request. The transport
    /// rejects handles from an older connection generation.
    pub fn complete_bridge_request(
        &self,
        handle: super::bridge_transport::BridgeRequestHandle,
        result: super::bridge_transport::BridgeRequestResult,
    ) -> EditorResult<()> {
        let state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let runtime = state
            .runtime
            .as_ref()
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        runtime.bridge.complete_bridge_request(handle, result)
    }

    /// Close children first, then stop only the verified process group and
    /// remove the ephemeral token. Durable state and stable origin remain.
    pub fn shutdown(&self) -> EditorResult<()> {
        self.shutdown_until(Instant::now() + Duration::from_secs(5))
    }

    /// Deadline-aware native shutdown used by process quit. Child-WebView
    /// calls are synchronous by WRY contract, while Bridge/listener workers
    /// receive the same absolute deadline and never outlive a bounded join
    /// attempt. A timeout is returned so the caller cannot mark clean state.
    pub fn shutdown_until(&self, deadline: Instant) -> EditorResult<()> {
        // Cleanup is best-effort as one bounded transaction: a child-WebView
        // or Bridge worker failure must not prevent the owned VS Code Server
        // process from receiving its shutdown request. The first error is
        // returned after every independent local resource has been attempted;
        // callers then refuse to mark clean shutdown.
        let mut first_error: Option<EditorError> = None;
        if let Ok(state) = self.state.lock() {
            if let Some(runtime) = state.runtime.as_ref() {
                if let Err(error) = runtime.bridge.stop_until(deadline) {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        } else if first_error.is_none() {
            first_error = Some(EditorError::new(EditorErrorCode::LifecycleConflict));
        }
        if Instant::now() >= deadline && first_error.is_none() {
            first_error = Some(EditorError::new(EditorErrorCode::BridgeUnavailable));
        }
        let official_port = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.runtime.as_ref().and_then(|runtime| runtime.origin));
        let mut process = self
            .process
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let mut process_stopped = match process.stop_until(deadline) {
            Ok(true) => true,
            Ok(false) => {
                if first_error.is_none() {
                    first_error = Some(EditorError::new(EditorErrorCode::ProcessUnavailable));
                }
                false
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
                false
            }
        };
        drop(process);
        if process_stopped {
            if let Some(origin) = official_port {
                while Instant::now() < deadline && !self.port_allocator.is_available(origin.port())
                {
                    thread::sleep(Duration::from_millis(10));
                }
                if !self.port_allocator.is_available(origin.port()) {
                    process_stopped = false;
                    if first_error.is_none() {
                        first_error = Some(EditorError::new(EditorErrorCode::ProcessUnavailable));
                    }
                }
            }
        }
        let mut state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        if process_stopped {
            if let Some(runtime) = state.runtime.take() {
                if let Err(error) = runtime.paths.remove_ephemeral_token() {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
                clear_server_pid(&runtime.paths);
                if let Err(error) =
                    append_lifecycle_log(&runtime.paths, LifecycleEvent::ServerStopped)
                {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        state.failed = None;
        first_error.map_or(Ok(()), Err)
    }

    /// Stop a VS Code Server this app started and never got to stop.
    ///
    /// A run that is force-quit or crashes leaves its server holding the
    /// origin with no `Child` handle left to stop it by, which is the usual
    /// reason the port is occupied at all. The recorded process group is only
    /// signalled once it still claims to be running `serve-web` against
    /// DevHub's own provider directory: a process id outlives its owner, and a
    /// stale record must not be allowed to reach whatever inherited it.
    fn reclaim_orphaned_server(&self, paths: &EditorPaths) -> bool {
        let Some(record) = read_server_pid(paths) else {
            return false;
        };
        let reclaimed = self.reclaimer.reclaim(record.pid, paths.server_data());
        if reclaimed {
            clear_server_pid(paths);
        }
        reclaimed
    }

    fn server_spec(&self, runtime: &Runtime) -> EditorResult<ProcessSpec> {
        let path = |value: &Path| {
            value.to_str().map(str::to_owned).ok_or_else(|| EditorError::new(EditorErrorCode::Io))
        };
        // The staged server is run directly. There is no CLI in front of it to
        // ask which build is current, download one, and only then start —
        // which is what made a launch without a network stall rather than fail.
        let args = vec![
            "--host".to_owned(),
            super::paths::LOOPBACK_HOST.to_owned(),
            "--port".to_owned(),
            // Zero asks the server to find a free port and bind it itself, so
            // nothing can take it between choosing and holding. The port it
            // announces on stdout is read back.
            runtime.origin.map_or(0, EditorOrigin::port).to_string(),
            "--connection-token-file".to_owned(),
            path(runtime.paths.token_file())?,
            "--server-data-dir".to_owned(),
            path(runtime.paths.server_data())?,
            "--extensions-dir".to_owned(),
            // Scoped by the server's release. An extension is built against a
            // VS Code version, so a directory shared across versions is a
            // directory the server rejects most of on every scan — which is
            // what a staged tree inherited from a differently versioned
            // provider actually looks like.
            path(&runtime.paths.extensions().join(&runtime.executable.version))?,
            "--accept-server-license-terms".to_owned(),
            "--disable-telemetry".to_owned(),
        ];
        let registry = path(&runtime.paths.root().join("surface-registry.json"))?;
        let env = vec![
            ("DEVHUB_BRIDGE_SURFACE_REGISTRY".to_owned(), registry),
            ("DEVHUB_BRIDGE_ENDPOINT".to_owned(), runtime.bridge.endpoint().to_owned()),
            ("DEVHUB_BRIDGE_TOKEN".to_owned(), runtime.bridge.token_hex()),
            ("VSCODE_CLI_DATA_DIR".to_owned(), path(runtime.paths.cli_data())?),
        ];
        Ok(ProcessSpec::new(runtime.executable.path().to_path_buf(), args)
            .with_env(env)
            .with_termination_grace(Duration::from_secs(2))
            .with_shutdown_signal(ShutdownSignal::Terminate))
    }
}

impl EditorHostPort for EditorHost {
    fn ensure(&self, cancel: CancellationToken) -> PortFuture<EditorHostResult> {
        let result = if cancel.is_cancelled() {
            Err(PortError::new(PortErrorCode::Cancelled))
        } else {
            self.ensure_server().map_err(|_| PortError::new(PortErrorCode::Unavailable))
        };
        Box::pin(async move { result })
    }

    /// A Workspace's Editor is a frame in the App Shell's document, and it
    /// goes away with the Workspace that owns it. The server keeps running
    /// for the Workspaces that remain, so there is nothing here to close.
    fn close_workspace(
        &self,
        _workspace_id: WorkspaceId,
        cancel: CancellationToken,
    ) -> PortFuture<()> {
        let result = if cancel.is_cancelled() {
            Err(PortError::new(PortErrorCode::Cancelled))
        } else {
            Ok(())
        };
        Box::pin(async move { result })
    }

    fn shutdown(&self, cancel: CancellationToken) -> PortFuture<()> {
        let result = if cancel.is_cancelled() {
            Err(PortError::new(PortErrorCode::Cancelled))
        } else {
            self.shutdown().map_err(|_| PortError::new(PortErrorCode::Unavailable))
        };
        Box::pin(async move { result })
    }
}

fn validate_uuid(value: &str) -> EditorResult<()> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || !bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f')
            }
        })
        || bytes[14] != b'4'
        || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
    {
        return Err(EditorError::new(EditorErrorCode::InvalidSurface));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::super::process::{ManagedProcess, ProcessExit};
    use super::super::readiness::ReadinessProbe;

    struct FakeProcess {
        identity: super::super::process::ProcessIdentity,
        alive: Arc<AtomicBool>,
        terminated: Arc<AtomicUsize>,
        announced: Option<u16>,
    }

    impl ManagedProcess for FakeProcess {
        fn identity(&self) -> super::super::process::ProcessIdentity {
            self.identity.clone()
        }

        fn identity_verified(&self) -> bool {
            true
        }

        fn try_wait(&mut self) -> EditorResult<Option<ProcessExit>> {
            if self.alive.load(Ordering::Acquire) {
                Ok(None)
            } else {
                Ok(Some(ProcessExit { code: Some(0) }))
            }
        }

        fn observed_origin_port(&self, _deadline: Instant) -> Option<u16> {
            self.announced
        }

        fn terminate_until(&mut self, _deadline: Instant) -> EditorResult<bool> {
            self.alive.store(false, Ordering::Release);
            self.terminated.fetch_add(1, Ordering::AcqRel);
            Ok(true)
        }
    }

    /// Stands in for `code serve-web`: honours a requested port, and picks its
    /// own when asked for zero. Every requested port is recorded, because what
    /// DevHub asks for is the whole contract on this side.
    struct FakeProcessAdapter {
        spawns: Arc<AtomicUsize>,
        alive: Arc<AtomicBool>,
        terminated: Arc<AtomicUsize>,
        requested: Arc<Mutex<Vec<u16>>>,
        picks: Arc<Mutex<Vec<u16>>>,
    }

    impl FakeProcessAdapter {
        fn new(
            spawns: Arc<AtomicUsize>,
            alive: Arc<AtomicBool>,
            terminated: Arc<AtomicUsize>,
        ) -> Self {
            Self {
                spawns,
                alive,
                terminated,
                requested: Arc::new(Mutex::new(Vec::new())),
                picks: Arc::new(Mutex::new(vec![54945])),
            }
        }
    }

    fn requested_port(spec: &ProcessSpec) -> u16 {
        let args = spec.args();
        args.iter()
            .position(|argument| argument == "--port")
            .and_then(|index| args.get(index + 1))
            .and_then(|value| value.parse().ok())
            .expect("a --port argument")
    }

    impl ProcessAdapter for FakeProcessAdapter {
        fn spawn(&self, spec: &ProcessSpec) -> EditorResult<Box<dyn ManagedProcess>> {
            self.spawns.fetch_add(1, Ordering::AcqRel);
            self.alive.store(true, Ordering::Release);
            let asked = requested_port(spec);
            self.requested.lock().expect("requested").push(asked);
            let announced = if asked == 0 {
                let mut picks = self.picks.lock().expect("picks");
                Some(if picks.len() > 1 { picks.remove(0) } else { picks[0] })
            } else {
                Some(asked)
            };
            Ok(Box::new(FakeProcess {
                identity: super::super::process::ProcessIdentity::new(
                    100,
                    spec.executable().to_path_buf(),
                ),
                alive: self.alive.clone(),
                terminated: self.terminated.clone(),
                announced,
            }))
        }
    }

    struct ExpiredDeadlineProcess {
        terminated: Arc<AtomicBool>,
    }

    impl ManagedProcess for ExpiredDeadlineProcess {
        fn identity(&self) -> super::super::process::ProcessIdentity {
            super::super::process::ProcessIdentity::new(101, "/pinned/code")
        }

        fn observed_origin_port(&self, _deadline: Instant) -> Option<u16> {
            Some(54945)
        }

        fn identity_verified(&self) -> bool {
            true
        }

        fn try_wait(&mut self) -> EditorResult<Option<ProcessExit>> {
            Ok(None)
        }

        fn terminate_until(&mut self, _deadline: Instant) -> EditorResult<bool> {
            self.terminated.store(true, Ordering::Release);
            Ok(false)
        }
    }

    struct ExpiredDeadlineAdapter {
        terminated: Arc<AtomicBool>,
    }

    impl ProcessAdapter for ExpiredDeadlineAdapter {
        fn spawn(&self, _spec: &ProcessSpec) -> EditorResult<Box<dyn ManagedProcess>> {
            Ok(Box::new(ExpiredDeadlineProcess { terminated: self.terminated.clone() }))
        }
    }

    struct FakeReadiness {
        ready: bool,
        calls: Arc<AtomicUsize>,
    }

    impl ReadinessProbe for FakeReadiness {
        fn wait_ready(
            &self,
            _origin: EditorOrigin,
            _token: &SecretToken,
            _timeout: Duration,
        ) -> EditorResult<()> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            if self.ready {
                Ok(())
            } else {
                Err(EditorError::new(EditorErrorCode::ReadinessTimeout))
            }
        }
    }

    struct FakePorts;

    impl PortAllocator for FakePorts {
        fn is_available(&self, _port: u16) -> bool {
            true
        }
    }

    fn test_root(name: &str) -> PathBuf {
        static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
        let base = fs::canonicalize(std::env::temp_dir()).expect("canonical temp");
        let root = base.join(format!(
            "devhub-editor-host-{name}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test root");
        root
    }

    fn fake_bridge_resource_dir(root: &Path) -> PathBuf {
        let resource = root.join("bridge-resources");
        fs::create_dir_all(&resource).expect("bridge resource dir");
        let bridge = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../extensions/devhub-bridge/build/devhub-bridge-0.1.0.vsix");
        if bridge.is_file() {
            fs::copy(bridge, resource.join("devhub-bridge.vsix")).expect("bridge package");
        }
        resource
    }

    /// The staged server, as a shape rather than a server: the provider only
    /// reads the product configuration beside the binary, and the process
    /// adapter under test never runs it.
    fn fake_official_cli(root: &Path) -> PathBuf {
        super::super::provider::tests::fake_server(root, "987c9597516278c9fcf10d963a0592ce1384ab93")
    }

    fn test_host(
        ready: bool,
    ) -> (EditorHost, Arc<AtomicUsize>, Arc<AtomicUsize>, EditorPaths, PathBuf, Arc<AtomicBool>)
    {
        let root = test_root(if ready { "lifecycle" } else { "failure" });
        let resource = fake_bridge_resource_dir(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let spawns = Arc::new(AtomicUsize::new(0));
        let alive = Arc::new(AtomicBool::new(true));
        let terminated = Arc::new(AtomicUsize::new(0));
        let readiness_calls = Arc::new(AtomicUsize::new(0));
        let host = EditorHost::with_adapters(
            EditorHostConfig::new(&home, Some(resource))
                .with_server_executable(fake_official_cli(&root)),
            Arc::new(FakeProcessAdapter::new(spawns.clone(), alive.clone(), terminated.clone())),
            Arc::new(FakeReadiness { ready, calls: readiness_calls }),
            Arc::new(FakePorts),
        );
        (host, spawns, terminated, EditorPaths::new(&home), root, alive)
    }

    #[test]
    fn official_provider_resolves_without_a_provider_resource_dir() {
        let root = test_root("official-bridge-resource");
        let bridge_resource = fake_bridge_resource_dir(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let host = EditorHost::with_adapters(
            EditorHostConfig::new(&home, Some(bridge_resource))
                .with_server_executable(fake_official_cli(&root)),
            Arc::new(FakeProcessAdapter::new(
                Arc::new(AtomicUsize::new(0)),
                Arc::new(AtomicBool::new(true)),
                Arc::new(AtomicUsize::new(0)),
            )),
            Arc::new(FakeReadiness { ready: true, calls: Arc::new(AtomicUsize::new(0)) }),
            Arc::new(FakePorts),
        );
        host.ensure_server().expect("official provider with app Bridge resource");
        let runtime = host.state.lock().expect("state").runtime.clone().expect("runtime");
        assert!(runtime.executable.path().ends_with("bin/codium-server"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn official_provider_uses_an_app_owned_server_profile() {
        let root = test_root("official-profile");
        let resource = fake_bridge_resource_dir(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let host = EditorHost::with_adapters(
            EditorHostConfig::new(&home, Some(resource))
                .with_server_executable(fake_official_cli(&root)),
            Arc::new(FakeProcessAdapter::new(
                Arc::new(AtomicUsize::new(0)),
                Arc::new(AtomicBool::new(true)),
                Arc::new(AtomicUsize::new(0)),
            )),
            Arc::new(FakeReadiness { ready: true, calls: Arc::new(AtomicUsize::new(0)) }),
            Arc::new(FakePorts),
        );
        host.ensure_server().expect("official provider");
        let runtime = host.state.lock().expect("state").runtime.clone().expect("runtime");
        assert!(runtime.paths.root().ends_with("VisualStudioCode"));
        assert!(runtime.paths.server_data().starts_with(runtime.paths.root()));
        assert!(runtime.paths.extensions().starts_with(runtime.paths.server_data()));
        let spec = host.server_spec(&runtime).expect("official spec");
        assert_eq!(spec.termination_grace(), Duration::from_secs(2));
        assert_eq!(spec.shutdown_signal(), ShutdownSignal::Terminate);
        assert!(spec.args().contains(&"--server-data-dir".to_owned()));
        assert!(spec.args().contains(&"--extensions-dir".to_owned()));
        // Extensions are kept per server release; one built for another
        // version is not an extension this server can load, and a shared
        // directory is one the server rejects most of on every scan.
        assert!(spec
            .args()
            .iter()
            .any(|argument| argument
                .ends_with(&format!("extensions/{}", runtime.executable.version))));
        assert!(spec.args().contains(&"--disable-telemetry".to_owned()));
        // The server is DevHub's to run, so the licence it ships under is
        // accepted by the app that bundled it rather than left to a prompt
        // nobody is there to answer.
        assert!(spec.args().contains(&"--accept-server-license-terms".to_owned()));
        // Every provider path is app-owned: nothing writes into the user's
        // own VS Code profile.
        assert!(!spec.args().contains(&"--user-data-dir".to_owned()));
        assert_eq!(
            spec.env()
                .iter()
                .find(|(key, _)| key == "VSCODE_CLI_DATA_DIR")
                .map(|(_, value)| value.as_str()),
            runtime.paths.cli_data().to_str()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shutdown_attempts_owned_server_after_deadline_expired() {
        let root = test_root("expired-deadline");
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let terminated = Arc::new(AtomicBool::new(false));
        let host = EditorHost::with_adapters(
            EditorHostConfig::new(&home, None),
            Arc::new(ExpiredDeadlineAdapter { terminated: terminated.clone() }),
            Arc::new(FakeReadiness { ready: true, calls: Arc::new(AtomicUsize::new(0)) }),
            Arc::new(FakePorts),
        );
        host.process
            .lock()
            .expect("process")
            .spawn(
                &ExpiredDeadlineAdapter { terminated: terminated.clone() },
                &ProcessSpec::new("/pinned/code", []),
            )
            .expect("owned process");

        let result = host.shutdown_until(Instant::now());
        assert!(result.is_err(), "an incomplete handoff cannot be clean");
        assert!(
            terminated.load(Ordering::Acquire),
            "quit must initiate termination after deadline"
        );
        assert!(host.process.lock().expect("process").process().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn readiness_failure_exhausts_bounded_restart_budget() {
        let (host, spawns, _terminated, _paths, _root, _alive) = test_host(false);
        let error = host.ensure_server().expect_err("readiness failure");
        assert_eq!(error.code(), EditorErrorCode::ReadinessTimeout);
        assert_eq!(spawns.load(Ordering::Acquire), usize::from(MAX_RESTARTS) + 1);
    }

    fn observing_host() -> (EditorHost, Arc<FakeProcessAdapter>, EditorPaths, PathBuf) {
        let root = test_root("observed-origin");
        let resource = fake_bridge_resource_dir(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let adapter = Arc::new(FakeProcessAdapter::new(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(true)),
            Arc::new(AtomicUsize::new(0)),
        ));
        let host = EditorHost::with_adapters(
            EditorHostConfig::new(&home, Some(resource))
                .with_server_executable(fake_official_cli(&root)),
            adapter.clone(),
            Arc::new(FakeReadiness { ready: true, calls: Arc::new(AtomicUsize::new(0)) }),
            Arc::new(FakePorts),
        );
        (host, adapter, EditorPaths::new(&home), root)
    }

    #[test]
    fn the_origin_is_the_port_the_server_says_it_bound() {
        // Asking for zero is what closes the window a chosen-then-requested
        // port leaves open: the server binds the port it picked, and DevHub
        // never holds a number that something else could still take.
        let (host, adapter, paths, _root) = observing_host();
        host.ensure_server().expect("server");

        assert_eq!(*adapter.requested.lock().expect("requested"), vec![0]);
        assert_eq!(
            host.state.lock().expect("state").runtime.as_ref().expect("runtime").origin,
            Some(EditorOrigin::new(54945).expect("origin"))
        );
        // The record follows the announced port, not a number DevHub picked.
        assert_eq!(read_server_pid(&paths).expect("record").port, 54945);

        host.shutdown().expect("shutdown");
    }

    #[test]
    fn a_restart_asks_the_server_for_the_origin_it_already_has() {
        // Within a run the origin is an identity after all: mounted surfaces
        // are addressed at it. Only across runs is it free to change.
        let (host, adapter, _paths, _root) = observing_host();
        host.ensure_server().expect("first server");
        adapter.alive.store(false, Ordering::Release);
        host.ensure_server().expect("restarted server");

        assert_eq!(
            *adapter.requested.lock().expect("requested"),
            vec![0, 54945],
            "a restart must ask for the port the surfaces already point at"
        );
    }

    #[test]
    fn a_server_left_behind_by_a_lost_run_is_stopped_before_a_new_one_starts() {
        // The orphan holds nothing DevHub needs now that the origin is
        // whatever the next server picks — but it is a whole VS Code Server
        // per lost run, and they would otherwise accumulate forever.
        let asked = Arc::new(Mutex::new(Vec::new()));
        let root = test_root("orphan-reclaim");
        let resource = fake_bridge_resource_dir(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let host = EditorHost::with_adapters(
            EditorHostConfig::new(&home, Some(resource))
                .with_server_executable(fake_official_cli(&root)),
            Arc::new(FakeProcessAdapter::new(
                Arc::new(AtomicUsize::new(0)),
                Arc::new(AtomicBool::new(true)),
                Arc::new(AtomicUsize::new(0)),
            )),
            Arc::new(FakeReadiness { ready: true, calls: Arc::new(AtomicUsize::new(0)) }),
            Arc::new(FakePorts),
        )
        .with_orphan_reclaimer(Arc::new(RecordingReclaimer { asked: asked.clone() }));
        let paths = EditorPaths::new(&home);
        paths.ensure_directories().expect("directories");
        record_server_pid(&paths, 4321, 54945);

        host.ensure_server().expect("server");
        assert_eq!(*asked.lock().expect("asked"), vec![4321]);
        // Consumed, so the next launch judges its own leftovers, not this one.
        assert_eq!(read_server_pid(&paths).expect("record").pid, 100);

        host.shutdown().expect("shutdown");
    }

    struct RecordingReclaimer {
        asked: Arc<Mutex<Vec<u32>>>,
    }

    impl OrphanReclaimer for RecordingReclaimer {
        fn reclaim(&self, process_id: u32, _server_data: &Path) -> bool {
            self.asked.lock().expect("asked").push(process_id);
            true
        }
    }

    #[test]
    fn crash_restart_reuses_authenticated_origin_and_token() {
        let (host, spawns, _terminated, paths, _root, alive) = test_host(true);
        host.ensure_server().expect("first server");
        let first_origin =
            host.state.lock().expect("state").runtime.as_ref().expect("runtime").origin;
        let first_bridge_token =
            host.state.lock().expect("state").runtime.as_ref().expect("runtime").bridge.token_hex();
        let first_token = SecretToken::from_file(paths.token_file()).expect("first token");
        assert_ne!(first_bridge_token, first_token.hex());
        assert!(!String::from_utf8_lossy(&fs::read(paths.token_file()).expect("token bytes"))
            .contains(&first_bridge_token));
        alive.store(false, Ordering::Release);
        host.ensure_server().expect("restarted server");
        assert_eq!(
            host.state.lock().expect("state").runtime.as_ref().expect("runtime").origin,
            first_origin
        );
        assert_eq!(SecretToken::from_file(paths.token_file()).expect("second token"), first_token);
        assert_eq!(
            host.state.lock().expect("state").runtime.as_ref().expect("runtime").bridge.token_hex(),
            first_bridge_token
        );
        assert_eq!(spawns.load(Ordering::Acquire), 2);
    }
}
