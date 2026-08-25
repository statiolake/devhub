//! THROWAWAY F0.2/F0.3 host for one real authenticated OpenVSCode Workbench.
//!
//! The Workbench page is loaded as an external child WKWebView. No script is
//! injected into it and this host never calls `eval`, DOM dispatch, or a
//! synthetic browser event API. The optional automation is native
//! `CGEventPostToPid`; Workbench state is observed only through the public
//! Bridge extension's loopback diagnostics.

mod router;

#[cfg(target_os = "macos")]
mod native;

use std::{
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    utils::config::BackgroundThrottlingPolicy,
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewBuilder, WebviewUrl,
    WindowEvent, Wry,
};

const CHROME_HEIGHT: f64 = 24.0;
const CHILD_LABEL: &str = "workbench";
const SHARED_DATA_STORE_ID: [u8; 16] = *b"DEVHUB-RWB-INPUT";

type Child = Arc<Mutex<Option<Webview<Wry>>>>;

#[derive(Default)]
pub(crate) struct ObservationStore {
    lines: Mutex<Vec<String>>,
}

impl ObservationStore {
    pub(crate) fn record(&self, message: impl Into<String>) {
        let message = message.into();
        println!("[REAL-WORKBENCH-NATIVE] {message}");
        self.lines.lock().unwrap().push(message);
    }
}

pub(crate) struct HostState {
    pub(crate) router: Mutex<router::KeyRouter>,
    pub(crate) observations: Arc<ObservationStore>,
}

impl HostState {
    fn new(observations: Arc<ObservationStore>) -> Self {
        Self {
            router: Mutex::new(router::KeyRouter::new()),
            observations,
        }
    }

    pub(crate) fn record_host(&self, message: impl Into<String>) {
        self.observations.record(format!("host {}", message.into()));
    }
}

fn main() {
    let child: Child = Arc::new(Mutex::new(None));
    let observations = Arc::new(ObservationStore::default());
    let state = Arc::new(HostState::new(observations.clone()));

    tauri::Builder::default()
        .menu(build_menu)
        .setup({
            let child = child.clone();
            let state = state.clone();
            move |app| {
                let raw_url = env::var("DEVHUB_NATIVE_INPUT_WORKBENCH_URL")
                    .expect("DEVHUB_NATIVE_INPUT_WORKBENCH_URL must be an authenticated URL");
                let url = tauri::Url::parse(&raw_url).expect("valid Workbench URL");
                assert_loopback_url(&url);

                let shell = app
                    .get_webview_window("main")
                    .expect("main shell webview from tauri.conf.json");
                let window = shell.as_ref().window();
                let scale_factor = window.scale_factor().unwrap_or(1.0);
                let physical = window.inner_size().expect("shell inner size");
                let logical = physical.to_logical::<f64>(scale_factor);
                let size = LogicalSize::new(
                    logical.width.max(900.0),
                    (logical.height - CHROME_HEIGHT).max(500.0),
                );

                let data_root = env::var_os("DEVHUB_NATIVE_INPUT_DATA_ROOT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        env::temp_dir().join("devhub-real-workbench-native-input/webkit-data")
                    });
                std::fs::create_dir_all(&data_root).expect("create shared WebKit data root");
                state.record_host(format!(
                    "child_create label={CHILD_LABEL} url={} openvscode_source=upstream_pinned_1.109.5 data_store_id={}",
                    redact_url(&url),
                    hex_id(SHARED_DATA_STORE_ID)
                ));

                let page_state = state.clone();
                let child_builder = WebviewBuilder::new(CHILD_LABEL, WebviewUrl::External(url))
                    .data_directory(data_root)
                    .data_store_identifier(SHARED_DATA_STORE_ID)
                    .background_throttling(BackgroundThrottlingPolicy::Disabled)
                    .focused(true)
                    .devtools(true)
                    .on_page_load(move |webview, payload| {
                        page_state.record_host(format!(
                            "page_load webview={} event={:?} url={}",
                            webview.label(),
                            payload.event(),
                            redact_url(payload.url())
                        ));
                    });
                let webview = window.add_child(
                    child_builder,
                    LogicalPosition::new(0.0, CHROME_HEIGHT),
                    size,
                )?;
                *child.lock().unwrap() = Some(webview);

                let resize_window = window.clone();
                let resize_child = child.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Resized(size) = event {
                        let scale_factor = resize_window.scale_factor().unwrap_or(1.0);
                        let logical = size.to_logical::<f64>(scale_factor);
                        if let Some(webview) = resize_child.lock().unwrap().as_ref() {
                            let _ = webview.set_bounds(Rect {
                                position: LogicalPosition::new(0.0, CHROME_HEIGHT).into(),
                                size: LogicalSize::new(
                                    logical.width.max(900.0),
                                    (logical.height - CHROME_HEIGHT).max(500.0),
                                )
                                .into(),
                            });
                        }
                        println!(
                            "[REAL-WORKBENCH-NATIVE] host native_resize physical={}x{}",
                            size.width, size.height
                        );
                    }
                });

                #[cfg(target_os = "macos")]
                {
                    native::install_local_monitor(app.handle().clone(), child.clone(), state.clone());
                    if env::var("DEVHUB_NATIVE_INPUT_SELF_TEST").as_deref() == Ok("1") {
                        native::start_self_injection(app.handle().clone(), child.clone(), state.clone());
                    }
                    if env::var("DEVHUB_NATIVE_INPUT_IME_TEST").as_deref() == Ok("1") {
                        native::start_ime_self_injection(app.handle().clone(), child.clone(), state.clone());
                    }
                }

                state.record_host(format!(
                    "ready child={CHILD_LABEL} prefix_timeout_ms={} background_throttling=disabled injected_script=false",
                    router::PREFIX_TIMEOUT.as_millis()
                ));
                Ok(())
            }
        })
        .on_menu_event({
            let child = child.clone();
            let state = state.clone();
            move |app, event| match event.id().as_ref() {
                "focus-workbench" => {
                    #[cfg(target_os = "macos")]
                    native::focus_child(app, &child);
                    #[cfg(not(target_os = "macos"))]
                    if let Some(webview) = child.lock().unwrap().as_ref() {
                        let _ = webview.set_focus();
                    }
                    state.record_host("focus child=workbench source=menu".to_string());
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running real Workbench native-input harness");
}

fn build_menu(app: &AppHandle<Wry>) -> tauri::Result<tauri::menu::Menu<Wry>> {
    // A normal macOS responder chain includes the standard Edit menu. The
    // child WKWebView needs these native selectors for Command-C/V/Z to reach
    // Monaco's first responder; omitting the menu makes only Workbench-owned
    // browser shortcuts (P/Shift-P) observable.
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .items(&[&undo, &redo, &separator, &cut, &copy, &paste, &select_all])
        .build()?;
    let focus = MenuItemBuilder::with_id("focus-workbench", "Focus Workbench").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit harness").build(app)?;
    let menu = SubmenuBuilder::new(app, "Native input gate")
        .items(&[&focus, &quit])
        .build()?;
    MenuBuilder::new(app).item(&edit).item(&menu).build()
}

fn assert_loopback_url(url: &tauri::Url) {
    let host = url.host_str().unwrap_or_default();
    assert!(
        url.scheme() == "http" && (host == "127.0.0.1" || host == "localhost"),
        "Workbench URL must be HTTP loopback, got {}",
        redact_url(url)
    );
}

pub(crate) fn redact_url(url: &tauri::Url) -> String {
    let query = if url.query().is_some() {
        "?<query-redacted>"
    } else {
        ""
    };
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    };
    format!("{}://{}{}{}", url.scheme(), host, url.path(), query)
}

fn hex_id(bytes: [u8; 16]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[allow(dead_code)]
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::redact_url;

    #[test]
    fn redacts_authenticated_query() {
        let url = tauri::Url::parse("http://127.0.0.1:1234/?tkn=secret").unwrap();
        assert_eq!(redact_url(&url), "http://127.0.0.1:1234/?<query-redacted>");
    }
}
