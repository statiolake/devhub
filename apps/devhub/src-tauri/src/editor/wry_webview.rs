//! Raw WRY child-WebView adapter.
//!
//! The Tauri window is used only as a raw parent handle. WRY owns the child
//! view and its callbacks, so this path does not enter Tauri's webview
//! manager, IPC protocol, plugin store, or Tauri bootstrap pipeline.

use super::super::error::{EditorError, EditorErrorCode, EditorResult};
use super::super::proxy::EditorProxy;
use super::super::url::{
    navigation_decision, navigation_request, AuthenticatedUrl, NavigationDecision, EDITOR_SCHEME,
};
use super::{
    EditorBounds, EditorWebView, NativeFocusIdentity, NavigationRouter, WebViewHost, WebViewSpec,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const MAIN_THREAD_CALL_TIMEOUT: Duration = Duration::from_secs(8);

// WRY's WebView is explicitly main-thread-only on macOS. Keeping the native
// object in a thread-local registry lets the public host seam remain Send while
// every operation and Drop of the actual WebView stays on the UI thread.
thread_local! {
    static CHILDREN: RefCell<HashMap<u64, wry::WebView>> = RefCell::new(HashMap::new());
}

static NEXT_CHILD_ID: AtomicU64 = AtomicU64::new(1);

struct PendingWebView {
    label: String,
    url: AuthenticatedUrl,
    proxy: Arc<EditorProxy>,
    bounds: EditorBounds,
    data_store_identifier: [u8; 16],
    focused: bool,
    router: Arc<dyn NavigationRouter>,
}

/// Native child-view host backed directly by WRY.
pub struct WryWebViewHost {
    window: tauri::Window<tauri::Wry>,
    router: Arc<dyn NavigationRouter>,
}

impl WryWebViewHost {
    pub fn new(window: tauri::Window<tauri::Wry>, router: Arc<dyn NavigationRouter>) -> Self {
        Self { window, router }
    }
}

impl WebViewHost for WryWebViewHost {
    fn create(&self, spec: &WebViewSpec) -> EditorResult<Box<dyn EditorWebView>> {
        if !spec.bounds.is_valid() {
            return Err(EditorError::new(EditorErrorCode::WebViewUnavailable));
        }

        let (id, native_focus_identity) = create_on_main_thread(
            &self.window,
            PendingWebView {
                label: spec.label.clone(),
                url: spec.url.clone(),
                proxy: Arc::clone(&spec.proxy),
                bounds: spec.bounds,
                data_store_identifier: spec.data_store_identifier,
                focused: spec.focused,
                router: self.router.clone(),
            },
        )?;
        Ok(Box::new(RawWryEditorWebView {
            window: self.window.clone(),
            id,
            native_focus_identity,
            closed: std::sync::atomic::AtomicBool::new(false),
        }))
    }
}

fn create_on_main_thread(
    window: &tauri::Window<tauri::Wry>,
    pending: PendingWebView,
) -> EditorResult<(u64, NativeFocusIdentity)> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let state = Arc::new(DispatchState::<(u64, NativeFocusIdentity)>::default());
    let callback_state = Arc::clone(&state);
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            let result = {
                let mut state = callback_state.state.lock().expect("webview dispatch state");
                if state.cancelled {
                    Err(EditorError::new(EditorErrorCode::WebViewUnavailable))
                } else {
                    let result = build_native_child(&parent, pending);
                    state.result = Some(result.clone());
                    result
                }
            };
            let _ = sender.send(result);
        })
        .map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable))?;
    wait_for_dispatch(&state, receiver)
}

/// Replay one custom-scheme request against the loopback server.
fn serve(
    proxy: &EditorProxy,
    request: wry::http::Request<Vec<u8>>,
) -> wry::http::Response<std::borrow::Cow<'static, [u8]>> {
    let target = request
        .uri()
        .path_and_query()
        .map_or_else(|| "/".to_owned(), std::string::ToString::to_string);
    let headers = request
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect::<Vec<_>>();
    let method = request.method().as_str().to_owned();
    let Some(response) = proxy.request(&method, &target, &headers, request.body()) else {
        // The server is not answering. A status is the only thing that can be
        // said here; the App Shell owns every message the user reads.
        return wry::http::Response::builder()
            .status(502)
            .body(std::borrow::Cow::Owned(Vec::new()))
            .expect("static response");
    };
    let mut builder = wry::http::Response::builder().status(response.status);
    for (name, value) in &response.headers {
        builder = builder.header(name, value);
    }
    builder.body(std::borrow::Cow::Owned(response.body)).unwrap_or_else(|_| {
        wry::http::Response::builder()
            .status(502)
            .body(std::borrow::Cow::Owned(Vec::new()))
            .expect("static response")
    })
}

fn build_native_child(
    parent: &tauri::Window<tauri::Wry>,
    pending: PendingWebView,
) -> EditorResult<(u64, NativeFocusIdentity)> {
    let PendingWebView { label, url, proxy, bounds, data_store_identifier, focused, router } =
        pending;
    let _ = data_store_identifier;
    let native_bounds = wry::Rect {
        position: wry::dpi::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: wry::dpi::LogicalSize::new(bounds.width, bounds.height).into(),
    };
    let router_navigation = router.clone();
    let router_window = router;
    let surface_navigation = label.clone();
    let surface_window = label.clone();
    let initial_url_navigation = url.clone();
    let initial_url_window = url.clone();

    // Everything the Workbench asks its own origin for is replayed against
    // whatever port the server bound. The page never learns that port, so it
    // can change underneath without the origin — and the browser storage keyed
    // to it — changing at all.
    let protocol_proxy = Arc::clone(&proxy);
    let mut builder = wry::WebViewBuilder::new()
        .with_id(label.as_str())
        .with_custom_protocol(EDITOR_SCHEME.to_owned(), move |_id, request| {
            serve(&protocol_proxy, request)
        })
        .with_url(url.as_str())
        .with_bounds(native_bounds)
        .with_visible(true)
        .with_devtools(false)
        .with_background_throttling(wry::BackgroundThrottlingPolicy::Disabled)
        .with_navigation_handler(move |candidate| {
            match navigation_decision(&initial_url_navigation, &candidate) {
                NavigationDecision::AllowSameSurface => true,
                NavigationDecision::RouteWorkspace => {
                    if let Some(request) = navigation_request(&candidate) {
                        let _ = router_navigation.route_workspace(&surface_navigation, &request);
                    }
                    false
                }
                NavigationDecision::OpenExternal => {
                    if let Some(request) = navigation_request(&candidate) {
                        let _ = router_navigation.open_external(&request);
                    }
                    false
                }
                NavigationDecision::Reject => false,
            }
        })
        .with_new_window_req_handler(move |candidate, _features| {
            match navigation_decision(&initial_url_window, &candidate) {
                NavigationDecision::OpenExternal => {
                    if let Some(request) = navigation_request(&candidate) {
                        let _ = router_window.open_external(&request);
                    }
                }
                NavigationDecision::RouteWorkspace => {
                    if let Some(request) = navigation_request(&candidate) {
                        let _ = router_window.route_workspace(&surface_window, &request);
                    }
                }
                NavigationDecision::AllowSameSurface | NavigationDecision::Reject => {}
            }
            wry::NewWindowResponse::Deny
        });

    // WKWebView has no filesystem data-directory builder API. Its
    // application-scoped identifier is the persistent profile boundary;
    // EditorHost supplies the same app-owned identifier to every surface.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use wry::WebViewBuilderExtDarwin;
        builder = builder
            .with_data_store_identifier(data_store_identifier)
            .with_allow_link_preview(false);
    }

    let child = builder
        .build_as_child(parent)
        .map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable))?;
    // WRY documents `with_focused` as unsupported on macOS. Apply the
    // semantic focus request after construction while still on the UI thread.
    if focused {
        child.focus().map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable))?;
    }
    let id = NEXT_CHILD_ID
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current != u64::MAX).then_some(current + 1)
        })
        .map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable))?;
    let native_focus_identity = NativeFocusIdentity {
        responder_root: child.native_focus_identity(),
        window: child.native_window_identity(),
        window_number: child.native_window_number(),
    };
    CHILDREN.with(|children| {
        children.borrow_mut().insert(id, child);
    });
    Ok((id, native_focus_identity))
}

enum NativeCommand {
    Hide,
    Show,
    SetBounds(EditorBounds),
    Focus,
    Close,
}

fn dispatch(
    window: &tauri::Window<tauri::Wry>,
    id: u64,
    command: NativeCommand,
) -> EditorResult<()> {
    dispatch_until(window, id, command, Instant::now() + MAIN_THREAD_CALL_TIMEOUT)
}

fn dispatch_until(
    window: &tauri::Window<tauri::Wry>,
    id: u64,
    command: NativeCommand,
    deadline: Instant,
) -> EditorResult<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let state = Arc::new(DispatchState::<()>::default());
    let callback_state = Arc::clone(&state);
    window
        .run_on_main_thread(move || {
            let result = {
                let mut state = callback_state.state.lock().expect("webview dispatch state");
                if state.cancelled {
                    Err(EditorError::new(EditorErrorCode::WebViewUnavailable))
                } else {
                    let result = CHILDREN.with(|children| {
                        let mut children = children.borrow_mut();
                        let Some(child) = children.get_mut(&id) else {
                            return Err(EditorError::new(EditorErrorCode::WebViewUnavailable));
                        };
                        match command {
                            NativeCommand::Hide => child
                                .set_visible(false)
                                .map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable)),
                            NativeCommand::Show => child
                                .set_visible(true)
                                .map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable)),
                            NativeCommand::SetBounds(bounds) => child
                                .set_bounds(wry::Rect {
                                    position: wry::dpi::LogicalPosition::new(bounds.x, bounds.y)
                                        .into(),
                                    size: wry::dpi::LogicalSize::new(bounds.width, bounds.height)
                                        .into(),
                                })
                                .map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable)),
                            NativeCommand::Focus => child
                                .focus()
                                .map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable)),
                            NativeCommand::Close => {
                                let child = children.remove(&id).ok_or_else(|| {
                                    EditorError::new(EditorErrorCode::WebViewUnavailable)
                                })?;
                                drop(child);
                                Ok(())
                            }
                        }
                    });
                    state.result = Some(result.clone());
                    result
                }
            };
            let _ = sender.send(result);
        })
        .map_err(|_| EditorError::new(EditorErrorCode::WebViewUnavailable))?;
    wait_for_dispatch_with_timeout(
        &state,
        receiver,
        deadline.saturating_duration_since(Instant::now()),
    )
}

struct DispatchState<T> {
    state: Mutex<DispatchResult<T>>,
}

impl<T> Default for DispatchState<T> {
    fn default() -> Self {
        Self { state: Mutex::new(DispatchResult::default()) }
    }
}

struct DispatchResult<T> {
    cancelled: bool,
    result: Option<EditorResult<T>>,
}

impl<T> Default for DispatchResult<T> {
    fn default() -> Self {
        Self { cancelled: false, result: None }
    }
}

fn wait_for_dispatch<T: Clone>(
    state: &Arc<DispatchState<T>>,
    receiver: mpsc::Receiver<EditorResult<T>>,
) -> EditorResult<T> {
    wait_for_dispatch_with_timeout(state, receiver, MAIN_THREAD_CALL_TIMEOUT)
}

fn wait_for_dispatch_with_timeout<T: Clone>(
    state: &Arc<DispatchState<T>>,
    receiver: mpsc::Receiver<EditorResult<T>>,
    timeout: Duration,
) -> EditorResult<T> {
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            // Serialize timeout cancellation with the UI callback. If the
            // callback has begun, this waits for its acknowledgement and
            // returns the actual result; if it has not begun, it marks the
            // operation cancelled before it can mutate the native registry.
            let mut dispatch = state.state.lock().expect("webview dispatch state");
            if let Some(result) = dispatch.result.clone() {
                result
            } else {
                dispatch.cancelled = true;
                Err(EditorError::new(EditorErrorCode::WebViewUnavailable))
            }
        }
    }
}

struct RawWryEditorWebView {
    window: tauri::Window<tauri::Wry>,
    id: u64,
    native_focus_identity: NativeFocusIdentity,
    closed: std::sync::atomic::AtomicBool,
}

impl EditorWebView for RawWryEditorWebView {
    fn native_focus_identity(&self) -> Option<NativeFocusIdentity> {
        Some(self.native_focus_identity)
    }

    fn hide(&self) -> EditorResult<()> {
        dispatch(&self.window, self.id, NativeCommand::Hide)
    }

    fn show(&self) -> EditorResult<()> {
        dispatch(&self.window, self.id, NativeCommand::Show)
    }

    fn set_bounds(&self, bounds: EditorBounds) -> EditorResult<()> {
        if !bounds.is_valid() {
            return Err(EditorError::new(EditorErrorCode::WebViewUnavailable));
        }
        dispatch(&self.window, self.id, NativeCommand::SetBounds(bounds))
    }

    fn focus(&self) -> EditorResult<()> {
        dispatch(&self.window, self.id, NativeCommand::Focus)
    }

    fn close(&self) -> EditorResult<()> {
        self.close_until(Instant::now() + MAIN_THREAD_CALL_TIMEOUT)
    }

    fn close_until(&self, deadline: Instant) -> EditorResult<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        match dispatch_until(&self.window, self.id, NativeCommand::Close, deadline) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.closed.store(false, Ordering::Release);
                Err(error)
            }
        }
    }
}

impl Drop for RawWryEditorWebView {
    fn drop(&mut self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        // EditorHost performs an explicit, synchronous close so failures are
        // visible. This asynchronous fallback prevents an accidentally
        // dropped proxy from retaining a native child indefinitely; if the
        // event loop is already gone, the parent-window teardown owns the
        // remaining native resources.
        let window = self.window.clone();
        let id = self.id;
        let _ = window.run_on_main_thread(move || {
            CHILDREN.with(|children| {
                children.borrow_mut().remove(&id);
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_cancellation_is_observed_before_late_native_mutation() {
        let state = Arc::new(DispatchState::<u64>::default());
        {
            let mut dispatch = state.state.lock().expect("dispatch state");
            dispatch.cancelled = true;
        }
        let dispatch = state.state.lock().expect("dispatch state");
        assert!(dispatch.cancelled);
        assert!(dispatch.result.is_none());
    }

    #[test]
    fn completed_main_thread_operation_wins_the_timeout_race() {
        let state = Arc::new(DispatchState::<u64>::default());
        {
            let mut dispatch = state.state.lock().expect("dispatch state");
            dispatch.result = Some(Ok(42));
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.send(Ok(42)).expect("ack");
        assert_eq!(wait_for_dispatch(&state, receiver).expect("result"), 42);
        assert!(!state.state.lock().expect("dispatch state").cancelled);
    }
}
