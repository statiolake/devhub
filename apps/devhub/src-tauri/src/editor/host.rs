//! Production EditorHost orchestrator.
//!
//! This is the deep module's public seam: callers ask it to ensure the shared
//! server, mount one semantic surface, update its native bounds/focus, close a
//! Workspace surface, or shut the provider down. Stable ports, tokens,
//! process supervision, registry persistence, URL authentication, and child
//! WebView policy stay inside this implementation.

use std::collections::HashMap;
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
use super::registry::{SurfaceRegistry, SurfaceRegistryEntry};
use super::token::SecretToken;
use super::url::{
    folder_url, folderless_url, navigation_decision, AuthenticatedUrl, EditorOrigin,
    NavigationDecision,
};
use super::webview::{EditorBounds, EditorWebView, WebViewHost};

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

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSurfaceSnapshot {
    pub key: String,
    pub visible: bool,
    pub mounted: bool,
    pub bounds: EditorBounds,
}

#[derive(Clone)]
struct Runtime {
    paths: EditorPaths,
    executable: EditorExecutable,
    token: SecretToken,
    /// Absent until the server announces the port it bound. It stays fixed for
    /// the rest of the run, including across a crash restart, because mounted
    /// surfaces are addressed at it.
    origin: Option<EditorOrigin>,
    registry: SurfaceRegistry,
    bridge: BridgeTransport,
    bridge_installed: bool,
}

struct SurfaceRecord {
    key: EditorSurfaceKey,
    registry: SurfaceRegistryEntry,
    root: Option<PathBuf>,
    url: AuthenticatedUrl,
    bounds: EditorBounds,
    visible: bool,
    webview: Option<Box<dyn EditorWebView>>,
}

/// Whether a mount is the Surface the user is switching to, or one being
/// prepared behind the Activity that is on screen.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Activation {
    Select,
    Warm,
}

impl Runtime {
    fn origin(&self) -> EditorResult<EditorOrigin> {
        self.origin.ok_or_else(|| EditorError::new(EditorErrorCode::ProcessUnavailable))
    }
}

#[derive(Default)]
struct HostState {
    runtime: Option<Runtime>,
    surfaces: HashMap<EditorSurfaceKey, SurfaceRecord>,
    active: Option<EditorSurfaceKey>,
    window_attached: bool,
    failed: Option<EditorErrorCode>,
}

pub struct EditorHost {
    config: EditorHostConfig,
    state: Mutex<HostState>,
    process: Mutex<ProcessSupervisor>,
    process_adapter: Arc<dyn ProcessAdapter>,
    readiness: Arc<dyn ReadinessProbe>,
    port_allocator: Arc<dyn PortAllocator>,
    webviews: Mutex<Option<Arc<dyn WebViewHost>>>,
    bridge_installer: Option<Arc<dyn BridgeInstaller>>,
    bridge_factory: Arc<dyn BridgeTransportFactory>,
    reclaimer: Arc<dyn OrphanReclaimer>,
    /// Serves the fixed Editor origin. Every surface shares it, because they
    /// are one origin and therefore one browser session.
    proxy: Arc<super::proxy::EditorProxy>,
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
            webviews: Mutex::new(None),
            bridge_installer: Some(bridge_installer),
            bridge_factory,
            reclaimer: Arc::new(SystemOrphanReclaimer),
            proxy: Arc::new(super::proxy::EditorProxy::new()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_orphan_reclaimer(mut self, reclaimer: Arc<dyn OrphanReclaimer>) -> Self {
        self.reclaimer = reclaimer;
        self
    }

    pub fn attach_webview_host(&self, host: Arc<dyn WebViewHost>) -> EditorResult<()> {
        let mut webviews = self
            .webviews
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let already_attached = self
            .state
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?
            .window_attached;
        if webviews.is_some() && already_attached {
            return Err(EditorError::new(EditorErrorCode::LifecycleConflict));
        }
        *webviews = Some(host);
        self.state
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?
            .window_attached = true;
        Ok(())
    }

    /// Reports whether a live native Window host is attached. The native
    /// shell uses this to retry a startup/Dock reconstruction after a missing
    /// WRY/Workbench resource becomes available, without rebuilding an
    /// already-attached host or duplicating child WebViews.
    pub fn window_attached(&self) -> bool {
        self.state.lock().map(|state| state.window_attached).unwrap_or(false)
    }

    /// A read-only host health fact for the Settings recheck seam. VS Code Server
    /// readiness itself is reported by the Bridge sink; this verifies that
    /// the native host is still attached without mutating editor state.
    pub fn recheck_health(&self) -> bool {
        self.window_attached()
    }

    /// Reconcile the managed provider after its Bridge connection disappears.
    /// The stable port, token, registry, and mounted WebViews remain owned by
    /// this host; only the supervisor decides whether the child is still
    /// usable and, when needed, restarts that exact process identity.
    pub fn recover_after_provider_disconnect(&self) -> EditorResult<()> {
        self.ensure_server()?;
        let (surfaces, active) = {
            let state = self
                .state
                .lock()
                .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
            (
                state
                    .surfaces
                    .values()
                    .map(|record| (record.key.clone(), record.root.clone(), record.bounds))
                    .collect::<Vec<_>>(),
                state.active.clone(),
            )
        };
        if surfaces.is_empty() {
            return Ok(());
        }
        // A dead server leaves existing WKWebViews on a network-error page;
        // the extension cannot reconnect from that document. Recreate the
        // already-owned child views through this host's registry instead of
        // introducing a second UI/provider projection.
        self.close_window()?;
        for (key, root, bounds) in surfaces {
            self.ensure_surface(key, root, bounds)?;
        }
        self.hide_surfaces()?;
        if let Some(active) = active {
            let (root, bounds) = {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
                let record = state
                    .surfaces
                    .get(&active)
                    .ok_or_else(|| EditorError::new(EditorErrorCode::InvalidSurface))?;
                (record.root.clone(), record.bounds)
            };
            self.ensure_surface(active, root, bounds)?;
        }
        Ok(())
    }

    pub fn navigation_decision(
        &self,
        key: &EditorSurfaceKey,
        candidate: &str,
    ) -> NavigationDecision {
        let Ok(state) = self.state.lock() else { return NavigationDecision::Reject };
        let Some(record) = state.surfaces.get(key) else { return NavigationDecision::Reject };
        navigation_decision(&record.url, candidate)
    }

    pub fn detach_webview_host(&self) -> EditorResult<()> {
        self.close_window()?;
        *self
            .webviews
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))? = None;
        Ok(())
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
            if let Ok(origin) = runtime.origin() {
                self.proxy.set_upstream(origin.port(), &runtime.token.hex());
            }
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
            self.proxy.restore(paths.web_session_file());
            let token = SecretToken::issue(paths.token_file())?;
            let bridge_token = SecretToken::issue_ephemeral()?;
            let registry = SurfaceRegistry::open(paths.root().join("surface-registry.json"))?;
            let expected = registry.core_surface_ids()?;
            let sink: Arc<dyn BridgeEventSink> =
                self.config.event_sink.clone().unwrap_or_else(|| Arc::new(NoopBridgeEventSink));
            let bridge = self.bridge_factory.bind(bridge_token, expected, sink)?;
            Runtime {
                paths,
                executable,
                token,
                origin: None,
                registry,
                bridge,
                bridge_installed: false,
            }
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
                    self.proxy.set_upstream(port, &runtime.token.hex());
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

    pub fn ensure_surface(
        &self,
        key: EditorSurfaceKey,
        root: Option<PathBuf>,
        bounds: EditorBounds,
    ) -> EditorResult<EditorSurfaceSnapshot> {
        self.mount_surface(key, root, bounds, Activation::Select)
    }

    /// Mount a surface without selecting it.
    ///
    /// A Workbench takes visibly longer to boot than it takes to reveal, so
    /// the wait belongs where the user is not watching: selecting a Workspace
    /// warms its Editor even while another Activity is on screen. Nothing is
    /// shown, nothing takes focus, and no other surface's visibility moves —
    /// switching to the Editor afterwards is the same `show` a second visit
    /// already was.
    pub fn warm_surface(
        &self,
        key: EditorSurfaceKey,
        root: Option<PathBuf>,
        bounds: EditorBounds,
    ) -> EditorResult<EditorSurfaceSnapshot> {
        self.mount_surface(key, root, bounds, Activation::Warm)
    }

    fn mount_surface(
        &self,
        key: EditorSurfaceKey,
        root: Option<PathBuf>,
        bounds: EditorBounds,
        activation: Activation,
    ) -> EditorResult<EditorSurfaceSnapshot> {
        if !bounds.is_valid() {
            return Err(EditorError::new(EditorErrorCode::WebViewUnavailable));
        }
        // Asked for before the server, because without somewhere to mount a
        // surface there is nothing worth starting one for. Booting first meant
        // a mount that could never succeed still prepared the provider
        // directory and spawned a server — which, now that warming happens on
        // a thread of its own, could outlive whatever asked for it.
        let webview_host = self
            .webviews
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?
            .clone()
            .ok_or_else(|| EditorError::new(EditorErrorCode::WebViewUnavailable))?;
        self.ensure_server()?;
        let mut state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let (registry_entry, url, root, paths) = {
            let runtime = state
                .runtime
                .as_mut()
                .ok_or_else(|| EditorError::new(EditorErrorCode::ProcessUnavailable))?;
            let value = match &key {
                EditorSurfaceKey::Global => {
                    let entry = runtime.registry.global()?;
                    let url = folderless_url(&runtime.token);
                    (entry, url, None)
                }
                EditorSurfaceKey::Workspace(workspace_id) => {
                    let root = root
                        .ok_or_else(|| EditorError::new(EditorErrorCode::InvalidWorkspaceRoot))?;
                    let root = std::fs::canonicalize(root)
                        .map_err(|_| EditorError::new(EditorErrorCode::InvalidWorkspaceRoot))?;
                    let entry = runtime.registry.workspace(workspace_id.clone(), &root)?;
                    let url = folder_url(&runtime.token, &root)?;
                    (entry, url, Some(root))
                }
            };
            runtime.bridge.set_expected(runtime.registry.core_surface_ids()?);
            (value.0, value.1, value.2, runtime.paths.clone())
        };
        let label = surface_label(&key);
        let needs_mount = match state.surfaces.get(&key) {
            Some(record) => {
                if record.registry.surface_id != registry_entry.surface_id || record.root != root {
                    return Err(EditorError::new(EditorErrorCode::LifecycleConflict));
                }
                record.webview.is_none()
            }
            None => true,
        };
        if needs_mount {
            let spec = super::webview::WebViewSpec {
                label: label.clone(),
                url: url.clone(),
                proxy: Arc::clone(&self.proxy),
                bounds,
                data_directory: paths.webkit_data().to_path_buf(),
                data_store_identifier: super::paths::WEBKIT_DATA_STORE_ID,
                // A warmed child must not take the keyboard: the user is
                // typing into whatever Activity is actually on screen.
                focused: activation == Activation::Select,
            };
            let webview = webview_host.create(&spec)?;
            if let Some(record) = state.surfaces.get_mut(&key) {
                record.webview = Some(webview);
                record.bounds = bounds;
                record.visible = false;
            } else {
                state.surfaces.insert(
                    key.clone(),
                    SurfaceRecord {
                        key: key.clone(),
                        registry: registry_entry,
                        root,
                        url,
                        bounds,
                        visible: false,
                        webview: Some(webview),
                    },
                );
            }
            append_lifecycle_log(
                &paths,
                LifecycleEvent::WebViewsCreated { count: state.surfaces.len() as u16 },
            )?;
        }
        match activation {
            Activation::Select => {
                for (candidate, record) in &mut state.surfaces {
                    let selected = candidate == &key;
                    if let Some(webview) = record.webview.as_ref() {
                        webview.set_bounds(bounds)?;
                        if selected {
                            webview.show()?;
                            webview.focus()?;
                        } else {
                            webview.hide()?;
                        }
                    }
                    record.visible = selected;
                    record.bounds = bounds;
                }
                state.active = Some(key.clone());
            }
            Activation::Warm => {
                // Only the warmed record moves. Touching the others would let
                // a background mount steal the visible surface out from under
                // whatever Activity the user is actually looking at.
                if let Some(record) = state.surfaces.get_mut(&key) {
                    if let Some(webview) = record.webview.as_ref() {
                        webview.set_bounds(bounds)?;
                        webview.hide()?;
                    }
                    record.visible = false;
                    record.bounds = bounds;
                }
            }
        }
        Ok(snapshot_for(&state.surfaces[&key]))
    }

    pub fn set_layout(&self, bounds: EditorBounds) -> EditorResult<()> {
        if !bounds.is_valid() {
            return Err(EditorError::new(EditorErrorCode::WebViewUnavailable));
        }
        let mut state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        for record in state.surfaces.values_mut() {
            if let Some(webview) = record.webview.as_ref() {
                webview.set_bounds(bounds)?;
            }
            record.bounds = bounds;
        }
        Ok(())
    }

    pub fn focus_surface(&self, key: &EditorSurfaceKey) -> EditorResult<()> {
        let state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let record = state
            .surfaces
            .get(key)
            .ok_or_else(|| EditorError::new(EditorErrorCode::WebViewUnavailable))?;
        record
            .webview
            .as_ref()
            .ok_or_else(|| EditorError::new(EditorErrorCode::WebViewUnavailable))?
            .focus()
    }

    /// Returns the transient native responder token of the currently visible
    /// raw Editor child. This is consumed only by the host key router.
    pub fn active_native_focus_identity(&self) -> Option<super::webview::NativeFocusIdentity> {
        let state = self.state.lock().ok()?;
        let key = state.active.as_ref()?;
        state.surfaces.get(key)?.webview.as_ref()?.native_focus_identity()
    }

    /// Hides every mounted child while retaining each semantic surface
    /// record. This is used when the restored Activity is Agent or Terminal:
    /// Editor WebViews are reconstructed once, but no editor child is allowed
    /// to cover the active App Shell surface.
    pub fn hide_surfaces(&self) -> EditorResult<()> {
        let mut state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        for record in state.surfaces.values_mut() {
            // Every visibility call is a blocking round-trip to the main
            // thread, and warming keeps one record per visited Workspace. This
            // runs on every dispatch that is not about the Editor, so hiding
            // what is already hidden would charge each of those dispatches for
            // the Workspaces the user has collected.
            if !record.visible {
                continue;
            }
            if let Some(webview) = record.webview.as_ref() {
                webview.hide()?;
            }
            record.visible = false;
        }
        state.active = None;
        Ok(())
    }

    /// Whether this surface already holds a child WebView.
    ///
    /// Answered without waiting for the host lock: the only caller is the
    /// decision to warm, warming is an optimization, and a host that is busy
    /// mounting something is a host that should not be handed more work.
    pub fn surface_is_mounted(&self, key: &EditorSurfaceKey) -> bool {
        self.state
            .try_lock()
            .map(|state| state.surfaces.get(key).is_some_and(|record| record.webview.is_some()))
            .unwrap_or(true)
    }

    pub fn request_bridge_snapshot(&self, key: &EditorSurfaceKey) -> EditorResult<()> {
        let state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let runtime = state
            .runtime
            .as_ref()
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let record = state
            .surfaces
            .get(key)
            .ok_or_else(|| EditorError::new(EditorErrorCode::InvalidSurface))?;
        let surface_id = devhub_app_core::bridge::Uuid::parse(record.registry.surface_id.clone())
            .map_err(|_| EditorError::new(EditorErrorCode::InvalidSurface))?;
        runtime
            .bridge
            .request_snapshot(&super::bridge_transport::BridgeSurfaceId::from_uuid(surface_id))
    }

    /// Ask the Bridge extension to focus the Workbench represented by a
    /// surface. The child WebView remains the owner of native focus.
    pub fn request_bridge_focus(&self, key: &EditorSurfaceKey) -> EditorResult<()> {
        let state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let runtime = state
            .runtime
            .as_ref()
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let record = state
            .surfaces
            .get(key)
            .ok_or_else(|| EditorError::new(EditorErrorCode::InvalidSurface))?;
        let surface_id = devhub_app_core::bridge::Uuid::parse(record.registry.surface_id.clone())
            .map_err(|_| EditorError::new(EditorErrorCode::InvalidSurface))?;
        runtime
            .bridge
            .request_focus(&super::bridge_transport::BridgeSurfaceId::from_uuid(surface_id))
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

    /// Close the native child WebViews but deliberately retain the server,
    /// token, registry, and provider profile for Dock reconstruction.
    pub fn close_window(&self) -> EditorResult<()> {
        self.close_window_until(Instant::now() + Duration::from_secs(5))
    }

    fn close_window_until(&self, deadline: Instant) -> EditorResult<()> {
        let mut state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let mut destroyed = 0_u16;
        let mut first_error = None;
        for record in state.surfaces.values_mut() {
            if let Some(webview) = record.webview.take() {
                let close_result = if Instant::now() < deadline {
                    webview.close_until(deadline)
                } else {
                    Err(EditorError::new(EditorErrorCode::WebViewUnavailable))
                };
                match close_result {
                    Ok(()) => destroyed = destroyed.saturating_add(1),
                    Err(error) => {
                        record.webview = Some(webview);
                        if first_error.is_none() {
                            first_error = Some(error);
                        }
                    }
                }
            }
            record.visible = false;
        }
        state.active = None;
        state.window_attached = false;
        if let Some(runtime) = state.runtime.as_ref() {
            append_lifecycle_log(
                &runtime.paths,
                LifecycleEvent::WebViewsDestroyed { count: destroyed },
            )?;
        }
        first_error.map_or(Ok(()), Err)
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
        let close_result = self.close_window_until(deadline);
        let mut first_error = close_result.err();
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
        state.window_attached = false;
        drop(state);
        *self
            .webviews
            .lock()
            .map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))? = None;
        first_error.map_or(Ok(()), Err)
    }

    pub fn close_workspace_surface(&self, workspace_id: &str) -> EditorResult<()> {
        validate_uuid(workspace_id)?;
        let key = EditorSurfaceKey::Workspace(workspace_id.to_owned());
        let mut state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        if let Some(mut record) = state.surfaces.remove(&key) {
            if let Some(webview) = record.webview.take() {
                if let Err(error) = webview.close() {
                    record.webview = Some(webview);
                    state.surfaces.insert(key.clone(), record);
                    return Err(error);
                }
            }
            if let Some(runtime) = state.runtime.as_mut() {
                if let Err(error) = runtime.registry.remove_workspace(workspace_id) {
                    // The native child has already closed, but preserving the
                    // record lets Dock reconstruction remount it if the
                    // durable registry write failed.
                    state.surfaces.insert(key.clone(), record);
                    return Err(error);
                }
                runtime.bridge.set_expected(runtime.registry.core_surface_ids()?);
                append_lifecycle_log(&runtime.paths, LifecycleEvent::WorkspaceClosed)?;
            }
            if state.active.as_ref() == Some(&key) {
                state.active = None;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    /// Return one immutable projection of every host-owned Editor Surface.
    ///
    /// This observation seam deliberately does not call into WebView
    /// implementations. Process-only continuity checks can therefore verify
    /// mounted identity from a background thread without show/focus/hide or
    /// main-thread dispatch.
    pub(crate) fn surface_inventory(&self) -> EditorResult<Vec<EditorSurfaceSnapshot>> {
        let state =
            self.state.lock().map_err(|_| EditorError::new(EditorErrorCode::LifecycleConflict))?;
        let mut inventory = state.surfaces.values().map(snapshot_for).collect::<Vec<_>>();
        inventory.sort_by(|left, right| left.key.cmp(&right.key));
        Ok(inventory)
    }

    pub fn snapshot(&self, key: &EditorSurfaceKey) -> Option<EditorSurfaceSnapshot> {
        self.state.lock().ok()?.surfaces.get(key).map(snapshot_for)
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

    fn close_workspace(
        &self,
        workspace_id: WorkspaceId,
        cancel: CancellationToken,
    ) -> PortFuture<()> {
        let workspace_id = workspace_id.to_string();
        let result = if cancel.is_cancelled() {
            Err(PortError::new(PortErrorCode::Cancelled))
        } else {
            self.close_workspace_surface(&workspace_id)
                .map_err(|_| PortError::new(PortErrorCode::Unavailable))
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

fn snapshot_for(record: &SurfaceRecord) -> EditorSurfaceSnapshot {
    EditorSurfaceSnapshot {
        key: record.key.wire_name(),
        visible: record.visible,
        mounted: record.webview.is_some(),
        bounds: record.bounds,
    }
}

fn surface_label(key: &EditorSurfaceKey) -> String {
    match key {
        EditorSurfaceKey::Global => "devhub-editor-global".to_owned(),
        EditorSurfaceKey::Workspace(id) => format!("devhub-editor-{id}"),
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
    use super::super::webview::tests::FakeWebViewHost;

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
    fn lifecycle_shares_store_switches_without_recreate_and_reconstructs_children() {
        let (host, spawns, terminated, paths, root, _alive) = test_host(true);
        let webviews = Arc::new(FakeWebViewHost::default());
        host.attach_webview_host(webviews.clone()).expect("attach");
        let global = EditorSurfaceKey::Global;
        let workspace_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&workspace_root).expect("workspace");
        let workspace = EditorSurfaceKey::Workspace(workspace_id.to_owned());
        let bounds = EditorBounds::new(24.0, 72.0, 800.0, 600.0);

        host.ensure_surface(global.clone(), None, bounds).expect("global");
        host.ensure_surface(workspace.clone(), Some(workspace_root.clone()), bounds)
            .expect("workspace");
        assert_eq!(spawns.load(Ordering::Acquire), 1);
        assert_eq!(webviews.created.lock().expect("created").len(), 2);
        let created = webviews.created.lock().expect("created");
        assert_eq!(created[0].data_directory, created[1].data_directory);
        assert_eq!(created[0].data_store_identifier, created[1].data_store_identifier);
        drop(created);

        let action_count = webviews.actions.lock().expect("actions").len();
        let inventory = host.surface_inventory().expect("read-only inventory");
        assert_eq!(inventory.len(), 2);
        assert_eq!(inventory[0].key, "global-editor");
        assert_eq!(inventory[1].key, format!("workspace-editor:{workspace_id}"));
        assert!(inventory.iter().all(|surface| surface.mounted));
        assert_eq!(
            webviews.actions.lock().expect("actions").len(),
            action_count,
            "read-only inventory must not show, focus, hide, or resize a WebView"
        );

        host.ensure_surface(global.clone(), None, bounds).expect("switch global");
        assert_eq!(webviews.created.lock().expect("created").len(), 2);
        assert!(webviews
            .actions
            .lock()
            .expect("actions")
            .iter()
            .any(|action| action == "hide:devhub-editor-global"));

        let registry_before =
            fs::read_to_string(paths.root().join("surface-registry.json")).expect("registry");
        host.close_window().expect("close window");
        assert_eq!(
            webviews
                .actions
                .lock()
                .expect("actions")
                .iter()
                .filter(|action| action.starts_with("close:"))
                .count(),
            2
        );
        assert!(!host.snapshot(&global).expect("global snapshot").mounted);
        assert_eq!(
            terminated.load(Ordering::Acquire),
            0,
            "Window Close must not stop VS Code Server"
        );
        host.attach_webview_host(webviews.clone()).expect("reattach");
        host.ensure_surface(global.clone(), None, bounds).expect("reconstruct global");
        assert_eq!(webviews.created.lock().expect("created").len(), 3);
        let registry_after =
            fs::read_to_string(paths.root().join("surface-registry.json")).expect("registry");
        let before: serde_json::Value =
            serde_json::from_str(&registry_before).expect("before json");
        let after: serde_json::Value = serde_json::from_str(&registry_after).expect("after json");
        assert_eq!(before["surfaces"][0]["surface_id"], after["surfaces"][0]["surface_id"]);

        host.close_workspace_surface(workspace_id).expect("close workspace");
        assert!(host.snapshot(&workspace).is_none());
        assert!(host.snapshot(&global).is_some());
        host.shutdown().expect("shutdown");
        assert_eq!(terminated.load(Ordering::Acquire), 1);
        assert!(!paths.token_file().exists());
    }

    #[test]
    fn a_surface_with_nowhere_to_mount_starts_no_server() {
        // Warming runs on a thread of its own, so work it does after whatever
        // asked for it has gone is work nobody is waiting on — and preparing
        // the provider directory is work that touches the filesystem. A mount
        // that cannot succeed should not reach that far.
        let (host, spawns, _terminated, paths, _root, _alive) = test_host(true);
        assert_eq!(
            host.warm_surface(
                EditorSurfaceKey::Global,
                None,
                EditorBounds::new(0.0, 0.0, 8.0, 8.0)
            )
            .expect_err("no webview host")
            .code(),
            EditorErrorCode::WebViewUnavailable
        );
        assert_eq!(spawns.load(Ordering::Acquire), 0, "no server for a surface with no window");
        assert!(!paths.root().exists(), "no provider directory either");
    }

    #[test]
    fn warming_a_surface_mounts_it_without_taking_the_visible_one() {
        let (host, _spawns, _terminated, _paths, root, _alive) = test_host(true);
        let webviews = Arc::new(FakeWebViewHost::default());
        host.attach_webview_host(webviews.clone()).expect("attach");
        let global = EditorSurfaceKey::Global;
        let workspace_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&workspace_root).expect("workspace");
        let workspace = EditorSurfaceKey::Workspace(workspace_id.to_owned());
        let bounds = EditorBounds::new(24.0, 72.0, 800.0, 600.0);

        host.ensure_surface(global.clone(), None, bounds).expect("global");
        webviews.actions.lock().expect("actions").clear();

        // A Workbench boots visibly slower than it reveals, so the wait is
        // taken while another Activity is on screen.
        host.warm_surface(workspace.clone(), Some(workspace_root.clone()), bounds).expect("warm");
        assert_eq!(webviews.created.lock().expect("created").len(), 2);
        assert!(host.snapshot(&workspace).expect("warmed snapshot").mounted);

        let actions = webviews.actions.lock().expect("actions").clone();
        assert!(
            actions.iter().any(|action| action == &format!("hide:devhub-editor-{workspace_id}")),
            "a warmed child must be hidden, not shown: {actions:?}"
        );
        assert!(
            !actions.iter().any(|action| action.starts_with("show:")),
            "warming must not reveal anything: {actions:?}"
        );
        assert!(
            !actions.iter().any(|action| action.starts_with("focus:")),
            "warming must not take the keyboard from the Activity on screen: {actions:?}"
        );
        assert!(
            !actions.iter().any(|action| action == "hide:devhub-editor-global"),
            "warming must leave every other surface's visibility alone: {actions:?}"
        );
        assert!(host.snapshot(&global).expect("global snapshot").mounted);

        // Selecting it afterwards is the reveal the warm mount paid for.
        webviews.actions.lock().expect("actions").clear();
        host.ensure_surface(workspace.clone(), Some(workspace_root), bounds)
            .expect("select warmed");
        assert_eq!(webviews.created.lock().expect("created").len(), 2);

        host.shutdown().expect("shutdown");
    }

    #[test]
    fn hiding_surfaces_touches_only_the_one_that_was_visible() {
        // Every visibility call is a blocking round-trip to the main thread and
        // this runs on each dispatch that is not about the Editor. Warming
        // keeps one record per visited Workspace, so re-hiding what is already
        // hidden would charge those dispatches for the whole collection.
        let (host, _spawns, _terminated, _paths, root, _alive) = test_host(true);
        let webviews = Arc::new(FakeWebViewHost::default());
        host.attach_webview_host(webviews.clone()).expect("attach");
        let workspace_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&workspace_root).expect("workspace");
        let workspace = EditorSurfaceKey::Workspace(workspace_id.to_owned());
        let bounds = EditorBounds::new(24.0, 72.0, 800.0, 600.0);

        host.warm_surface(workspace, Some(workspace_root), bounds).expect("warm");
        host.ensure_surface(EditorSurfaceKey::Global, None, bounds).expect("global");
        webviews.actions.lock().expect("actions").clear();

        host.hide_surfaces().expect("hide");
        let actions = webviews.actions.lock().expect("actions").clone();
        assert_eq!(
            actions,
            vec!["hide:devhub-editor-global".to_owned()],
            "only the visible surface had anything to hide: {actions:?}"
        );

        // Nothing is visible now, so a second pass has no work at all.
        webviews.actions.lock().expect("actions").clear();
        host.hide_surfaces().expect("hide again");
        assert!(
            webviews.actions.lock().expect("actions").is_empty(),
            "hiding an already hidden set must cost nothing"
        );

        host.shutdown().expect("shutdown");
    }

    #[test]
    fn a_mounted_surface_reports_itself_so_warming_is_not_repeated() {
        let (host, _spawns, _terminated, _paths, root, _alive) = test_host(true);
        let webviews = Arc::new(FakeWebViewHost::default());
        host.attach_webview_host(webviews.clone()).expect("attach");
        let workspace_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&workspace_root).expect("workspace");
        let workspace = EditorSurfaceKey::Workspace(workspace_id.to_owned());
        let bounds = EditorBounds::new(24.0, 72.0, 800.0, 600.0);

        assert!(!host.surface_is_mounted(&workspace));
        host.warm_surface(workspace.clone(), Some(workspace_root), bounds).expect("warm");
        assert!(host.surface_is_mounted(&workspace));
        assert!(!host.surface_is_mounted(&EditorSurfaceKey::Global));

        host.shutdown().expect("shutdown");
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

    #[test]
    fn workspace_close_registry_failure_keeps_unmounted_identity_for_retry() {
        let (host, _spawns, _terminated, paths, root, _alive) = test_host(true);
        let webviews = Arc::new(FakeWebViewHost::default());
        host.attach_webview_host(webviews).expect("attach");
        let workspace_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let workspace_root = root.join("retry-workspace");
        fs::create_dir_all(&workspace_root).expect("workspace");
        let key = EditorSurfaceKey::Workspace(workspace_id.to_owned());
        let bounds = EditorBounds::new(0.0, 0.0, 320.0, 240.0);
        host.ensure_surface(key.clone(), Some(workspace_root), bounds).expect("mount");

        let registry_path = paths.root().join("surface-registry.json");
        fs::remove_file(&registry_path).expect("remove registry file");
        fs::create_dir(&registry_path).expect("block registry replacement");
        assert_eq!(
            host.close_workspace_surface(workspace_id).expect_err("registry failure").code(),
            EditorErrorCode::Io
        );
        assert!(!host.snapshot(&key).expect("retained identity").mounted);

        fs::remove_dir(&registry_path).expect("unblock registry replacement");
        host.close_workspace_surface(workspace_id).expect("retry close");
        assert!(host.snapshot(&key).is_none());
        host.shutdown().expect("shutdown");
    }
}
