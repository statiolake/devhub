//! THROWAWAY F0.3 Tauri host harness.
//!
//! The production tree is intentionally not referenced by this crate. The host
//! creates two external-origin child WKWebViews and records their observable DOM
//! events over a loopback-only HTTP endpoint. Native keyboard routing lives in
//! `native.rs`; the prefix contract is in `router.rs`.

mod router;

#[cfg(target_os = "macos")]
mod native;

use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use router::Child;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    utils::config::BackgroundThrottlingPolicy,
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewBuilder, WebviewUrl,
    Window, WindowEvent, Wry,
};

const CHROME_HEIGHT: f64 = 84.0;
const CHILD_A: &str = "child-a";
const CHILD_B: &str = "child-b";
const TEST_PAGE: &str = include_str!("../test-page.html");

type ChildMap = Arc<Mutex<HashMap<String, Webview<Wry>>>>;

#[derive(Default)]
pub(crate) struct ObservationStore {
    events: Mutex<Vec<String>>,
}

impl ObservationStore {
    fn record(&self, line: impl Into<String>) {
        let line = line.into();
        println!("[F0.3] {line}");
        self.events.lock().unwrap().push(to_ndjson(&line));
    }

    fn snapshot_ndjson(&self) -> String {
        let events = self.events.lock().unwrap();
        if events.is_empty() {
            String::new()
        } else {
            format!("{}\n", events.join("\n"))
        }
    }
}

fn to_ndjson(line: &str) -> String {
    if let Some(child_json) = line.strip_prefix("child ") {
        return child_json.to_string();
    }

    let (source, message) = line.split_once(' ').unwrap_or(("host", line));
    format!(
        "{{\"source\":{source},\"message\":{message}}}",
        source = quote_json(source),
        message = quote_json(message),
    )
}

fn quote_json(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(quoted, "\\u{:04x}", character as u32);
            }
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

pub(crate) struct HostState {
    pub(crate) router: Mutex<router::KeyRouter>,
    observations: Arc<ObservationStore>,
}

impl HostState {
    fn new(observations: Arc<ObservationStore>) -> Self {
        Self {
            router: Mutex::new(router::KeyRouter::new(Child::A)),
            observations,
        }
    }

    pub(crate) fn record_host(&self, line: String) {
        self.observations.record(format!("host {line}"));
    }
}

fn main() {
    let children: ChildMap = Arc::new(Mutex::new(HashMap::new()));
    let hidden = Arc::new(Mutex::new(HashMap::<String, bool>::new()));
    let observations = Arc::new(ObservationStore::default());
    let state = Arc::new(HostState::new(observations.clone()));

    tauri::Builder::default()
        .menu(build_menu)
        .setup({
            let children = children.clone();
            let hidden = hidden.clone();
            let state = state.clone();
            let observations = observations.clone();
            move |app| {
                let (test_address, _server_thread) =
                    start_test_server(observations.clone()).expect("start loopback test server");
                println!(
                    "[F0.3] OBSERVATION_URL=http://{test_address}/observations.ndjson"
                );
                println!("[F0.3] test page URL=http://{test_address}/");

                let shell = app
                    .get_webview_window("main")
                    .expect("main shell webview from tauri.conf.json");
                let window = shell.as_ref().window();
                let scale_factor = window.scale_factor().unwrap_or(1.0);
                let physical_size = window.inner_size().expect("shell inner size");
                let logical_size = physical_size.to_logical::<f64>(scale_factor);
                let child_size = LogicalSize::new(
                    (logical_size.width / 2.0).max(100.0),
                    (logical_size.height - CHROME_HEIGHT).max(100.0),
                );

                let data_root = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| env::temp_dir().join("devhub-native-key-router"))
                    .join("native-key-router");
                std::fs::create_dir_all(&data_root).expect("create child data root");

                let default_a = format!("http://{test_address}/?client=child-a");
                let default_b = format!("http://{test_address}/?client=child-b");
                let url_a = configured_url(
                    "DEVHUB_NATIVE_KEY_ROUTER_CLIENT_A_URL",
                    &default_a,
                    "child-a",
                );
                let url_b = configured_url(
                    "DEVHUB_NATIVE_KEY_ROUTER_CLIENT_B_URL",
                    &default_b,
                    "child-b",
                );

                let child_a = make_child(
                    &window,
                    CHILD_A,
                    url_a,
                    LogicalPosition::new(0.0, CHROME_HEIGHT),
                    child_size,
                    data_root.join(CHILD_A),
                    [
                        0x4e, 0x4b, 0x52, 0x2d, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                        0x00, 0x00, 0x00, 0x00, 0x01,
                    ],
                )?;
                let child_b = make_child(
                    &window,
                    CHILD_B,
                    url_b,
                    LogicalPosition::new(child_size.width, CHROME_HEIGHT),
                    child_size,
                    data_root.join(CHILD_B),
                    [
                        0x4e, 0x4b, 0x52, 0x2d, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                        0x00, 0x00, 0x00, 0x00, 0x02,
                    ],
                )?;

                children.lock().unwrap().insert(CHILD_A.to_string(), child_a);
                children.lock().unwrap().insert(CHILD_B.to_string(), child_b);
                hidden.lock().unwrap().insert(CHILD_A.to_string(), false);
                hidden.lock().unwrap().insert(CHILD_B.to_string(), false);
                layout_children(&window, &children);

                let resize_window = window.clone();
                let resize_children = children.clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Resized(_)) {
                        layout_children(&resize_window, &resize_children);
                    }
                });

                #[cfg(target_os = "macos")]
                native::install_local_monitor(app.handle().clone(), state.clone());

                #[cfg(target_os = "macos")]
                if env::var("DEVHUB_NATIVE_KEY_ROUTER_SELF_TEST").as_deref() == Ok("1") {
                    native::start_self_injection(app.handle().clone(), state.clone());
                }

                #[cfg(target_os = "macos")]
                if env::var("DEVHUB_NATIVE_KEY_ROUTER_IME_TEST").as_deref() == Ok("1") {
                    native::start_ime_self_injection(app.handle().clone(), state.clone());
                }

                state.record_host(format!(
                    "ready children={} {} prefix_timeout_ms={} wry_patch=child_q_only",
                    CHILD_A,
                    CHILD_B,
                    router::PREFIX_TIMEOUT.as_millis()
                ));
                println!(
                    "[F0.3] Use Command+1/2 to focus, Command+Q twice within 1000ms to forward native Q"
                );
                Ok(())
            }
        })
        .on_menu_event({
            let children = children.clone();
            let hidden = hidden.clone();
            let state = state.clone();
            move |app, event| {
                match event.id().as_ref() {
                    "focus-a" => focus_child(app, &state, Child::A),
                    "focus-b" => focus_child(app, &state, Child::B),
                    "hide-a" => toggle_child(&children, &hidden, CHILD_A, false),
                    "hide-b" => toggle_child(&children, &hidden, CHILD_B, false),
                    "show-a" => toggle_child(&children, &hidden, CHILD_A, true),
                    "show-b" => toggle_child(&children, &hidden, CHILD_B, true),
                    "settings" => state.record_host("route host command=settings menu".to_string()),
                    "observations" => println!(
                        "[F0.3] observations endpoint is printed at startup; use curl without credentials"
                    ),
                    "quit" => app.exit(0),
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running F0.3 native key router prototype");
}

fn build_menu(app: &AppHandle<Wry>) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let focus_a = MenuItemBuilder::with_id("focus-a", "Focus child A")
        .accelerator("Command+1")
        .build(app)?;
    let focus_b = MenuItemBuilder::with_id("focus-b", "Focus child B")
        .accelerator("Command+2")
        .build(app)?;
    let hide_a = MenuItemBuilder::with_id("hide-a", "Hide child A").build(app)?;
    let hide_b = MenuItemBuilder::with_id("hide-b", "Hide child B").build(app)?;
    let show_a = MenuItemBuilder::with_id("show-a", "Show child A").build(app)?;
    let show_b = MenuItemBuilder::with_id("show-b", "Show child B").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Route Settings")
        .accelerator("Command+,")
        .build(app)?;
    let observations =
        MenuItemBuilder::with_id("observations", "Print observation endpoint").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let harness = SubmenuBuilder::new(app, "F0.3 Native Key Router")
        .items(&[
            &focus_a,
            &focus_b,
            &hide_a,
            &hide_b,
            &show_a,
            &show_b,
            &settings,
            &observations,
            &quit,
        ])
        .build()?;
    MenuBuilder::new(app).item(&harness).build()
}

fn configured_url(name: &str, default: &str, client: &str) -> tauri::Url {
    let raw = env::var(name).unwrap_or_else(|_| default.to_string());
    let mut url = tauri::Url::parse(&raw).unwrap_or_else(|error| {
        panic!("invalid {name}={raw:?}: {error}");
    });
    url.query_pairs_mut().append_pair("client", client);
    url
}

fn make_child(
    window: &Window<Wry>,
    label: &str,
    url: tauri::Url,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
    data_directory: PathBuf,
    data_store_identifier: [u8; 16],
) -> tauri::Result<Webview<Wry>> {
    std::fs::create_dir_all(&data_directory).expect("create child WebView data directory");
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .data_directory(data_directory)
        .data_store_identifier(data_store_identifier)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .focused(label == CHILD_A)
        .devtools(true);
    window.add_child(builder, position, size)
}

fn layout_children(window: &Window<Wry>, children: &ChildMap) {
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let Ok(physical_size) = window.inner_size() else {
        return;
    };
    let size = physical_size.to_logical::<f64>(scale_factor);
    let width = (size.width / 2.0).max(100.0);
    let height = (size.height - CHROME_HEIGHT).max(100.0);
    let map = children.lock().unwrap();
    for (label, x) in [(CHILD_A, 0.0), (CHILD_B, width)] {
        if let Some(child) = map.get(label) {
            let _ = child.set_bounds(Rect {
                position: LogicalPosition::new(x, CHROME_HEIGHT).into(),
                size: LogicalSize::new(width, height).into(),
            });
        }
    }
}

fn focus_child(app: &AppHandle<Wry>, state: &Arc<HostState>, child: Child) {
    {
        let mut router = state.router.lock().unwrap();
        router.focus(child);
    }
    #[cfg(target_os = "macos")]
    native::focus_child(app, child);
    #[cfg(not(target_os = "macos"))]
    if let Some(webview) = app.get_webview(child.label()) {
        let _ = webview.set_focus();
    }
    state.record_host(format!("focus active_child={}", child.label()));
}

fn toggle_child(
    children: &ChildMap,
    hidden: &Arc<Mutex<HashMap<String, bool>>>,
    label: &str,
    show: bool,
) {
    let Some(child) = children.lock().unwrap().get(label).cloned() else {
        return;
    };
    let mut state = hidden.lock().unwrap();
    state.insert(label.to_string(), !show);
    let result = if show { child.show() } else { child.hide() };
    println!(
        "[F0.3] {label} {} ({result:?})",
        if show { "shown" } else { "hidden" }
    );
}

fn start_test_server(
    observations: Arc<ObservationStore>,
) -> std::io::Result<(SocketAddr, thread::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let page = Arc::new(TEST_PAGE.as_bytes().to_vec());
    let handle = thread::spawn(move || loop {
        match listener.accept() {
            Ok((stream, _peer)) => {
                let page = page.clone();
                let observations = observations.clone();
                thread::spawn(move || serve_connection(stream, page, observations));
            }
            Err(error) => eprintln!("[F0.3] test server accept error: {error}"),
        }
    });
    Ok((address, handle))
}

fn serve_connection(
    mut stream: TcpStream,
    page: Arc<Vec<u8>>,
    observations: Arc<ObservationStore>,
) {
    let mut request = Vec::with_capacity(8192);
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let Ok(read) = stream.read(&mut chunk) else {
            return;
        };
        if read == 0 {
            return;
        }
        request.extend_from_slice(&chunk[..read]);
        if let Some(index) = request.windows(4).position(|value| value == b"\r\n\r\n") {
            break index + 4;
        }
        if request.len() > 1_048_576 {
            return;
        }
    };

    let header = String::from_utf8_lossy(&request[..header_end]).into_owned();
    let request_line = header.lines().next().unwrap_or_default();
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/");
    let method = request_line.split_whitespace().next().unwrap_or_default();
    let content_length = header
        .lines()
        .find_map(|line| {
            line.strip_prefix("Content-Length:")
                .or_else(|| line.strip_prefix("content-length:"))
        })
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    while request.len() < header_end + content_length {
        let Ok(read) = stream.read(&mut chunk) else {
            return;
        };
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
    }
    let body = &request[header_end..request.len().min(header_end + content_length)];

    if method == "POST" && path == "/observe" {
        observations.record(format!("child {}", String::from_utf8_lossy(body)));
        write_response(
            &mut stream,
            "204 No Content",
            "text/plain; charset=utf-8",
            b"",
        );
        return;
    }
    if method == "GET" && path == "/observations.ndjson" {
        let body = observations.snapshot_ndjson();
        write_response(
            &mut stream,
            "200 OK",
            "application/x-ndjson; charset=utf-8",
            body.as_bytes(),
        );
        return;
    }
    if method == "GET" && path == "/heartbeat" {
        write_response(&mut stream, "200 OK", "text/plain; charset=utf-8", b"ok");
        return;
    }
    if method == "GET" && path == "/events" {
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
        );
        loop {
            let seconds = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_secs())
                .unwrap_or_default();
            let event = format!("data: {seconds}\n\n");
            if stream.write_all(event.as_bytes()).is_err() || stream.flush().is_err() {
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }
        return;
    }

    write_response(
        &mut stream,
        "200 OK",
        "text/html; charset=utf-8",
        page.as_slice(),
    );
}

fn write_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}

#[cfg(test)]
mod tests {
    use super::to_ndjson;

    #[test]
    fn observations_are_valid_ndjson_lines() {
        assert_eq!(
            to_ndjson(r#"child {"kind":"ready"}"#),
            r#"{"kind":"ready"}"#
        );
        assert_eq!(
            to_ndjson("host prefix armed timeout_ms=1000"),
            r#"{"source":"host","message":"prefix armed timeout_ms=1000"}"#
        );
    }
}
