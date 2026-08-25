// THROWAWAY feasibility prototype. This is intentionally not production code.

use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    utils::config::BackgroundThrottlingPolicy,
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewBuilder, WebviewUrl,
    Window, WindowEvent, Wry,
};

const CHROME_HEIGHT: f64 = 64.0;
const PREFIX_TIMEOUT: Duration = Duration::from_millis(900);
const TEST_PAGE: &str = include_str!("../test-page.html");

type ChildMap = Arc<Mutex<HashMap<String, Webview<Wry>>>>;

struct PrefixState {
    active_child: String,
    armed_until: Option<Instant>,
}

fn main() {
    let children: ChildMap = Arc::new(Mutex::new(HashMap::new()));
    let hidden = Arc::new(Mutex::new(HashMap::<String, bool>::new()));
    let prefix = Arc::new(Mutex::new(PrefixState {
        active_child: "client-a".to_string(),
        armed_until: None,
    }));

    tauri::Builder::default()
    .menu(|app| build_menu(app))
    .setup({
      let children = children.clone();
      let hidden = hidden.clone();
      move |app| {
        let (test_address, _server_thread) = start_test_server().expect("start loopback test server");
        println!("[THROWAWAY] local external test server: http://{test_address}/");

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
          .unwrap_or_else(|_| env::temp_dir().join("wayfinder-throwaway-data"))
          .join("tauri-openvscode-feasibility");
        std::fs::create_dir_all(&data_root).expect("create throwaway WebView data root");

        let default_a = format!("http://{test_address}/?client=client-a");
        let default_b = format!("http://{test_address}/?client=client-b");
        let url_a = configured_url("WAYFINDER_CLIENT_A_URL", &default_a, "client-a");
        let url_b = configured_url("WAYFINDER_CLIENT_B_URL", &default_b, "client-b");

        let child_a = make_child(
          &window,
          "client-a",
          url_a,
          LogicalPosition::new(0.0, CHROME_HEIGHT),
          child_size,
          data_root.join("client-a"),
          [0x57, 0x46, 0x2d, 0x54, 0x41, 0x2d, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01],
        )?;
        let child_b = make_child(
          &window,
          "client-b",
          url_b,
          LogicalPosition::new(child_size.width, CHROME_HEIGHT),
          child_size,
          data_root.join("client-b"),
          [0x57, 0x46, 0x2d, 0x54, 0x41, 0x2d, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02],
        )?;

        children.lock().unwrap().insert("client-a".to_string(), child_a);
        children.lock().unwrap().insert("client-b".to_string(), child_b);
        hidden.lock().unwrap().insert("client-a".to_string(), false);
        hidden.lock().unwrap().insert("client-b".to_string(), false);
        layout_children(&window, &children);

        let resize_window = window.clone();
        let resize_children = children.clone();
        window.on_window_event(move |event| {
          if matches!(event, WindowEvent::Resized(_)) {
            layout_children(&resize_window, &resize_children);
            println!("[THROWAWAY] resized: child bounds recomputed");
          }
        });

        println!("[THROWAWAY] child-a and child-b attached; child data roots: {}", data_root.display());
        println!("[THROWAWAY] use the Wayfinder menu: Command+1/2 focus, hide/show, Command+Q prefix");
        Ok(())
      }
    })
    .on_menu_event({
      let children = children.clone();
      let hidden = hidden.clone();
      let prefix = prefix.clone();
      move |_app, event| {
        let id = event.id();
        if id == "focus-client-a" {
          focus_child(&children, &prefix, "client-a");
        } else if id == "focus-client-b" {
          focus_child(&children, &prefix, "client-b");
        } else if id == "toggle-client-a" {
          toggle_child(&children, &hidden, "client-a");
        } else if id == "toggle-client-b" {
          toggle_child(&children, &hidden, "client-b");
        } else if id == "prefix-command-q" {
          handle_prefix_q(&children, &prefix);
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running THROWAWAY Tauri feasibility prototype");
}

fn build_menu(app: &AppHandle<Wry>) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let focus_a = MenuItemBuilder::with_id("focus-client-a", "Focus client A")
        .accelerator("Command+1")
        .build(app)?;
    let focus_b = MenuItemBuilder::with_id("focus-client-b", "Focus client B")
        .accelerator("Command+2")
        .build(app)?;
    let toggle_a = MenuItemBuilder::with_id("toggle-client-a", "Hide/show client A").build(app)?;
    let toggle_b = MenuItemBuilder::with_id("toggle-client-b", "Hide/show client B").build(app)?;
    // There is deliberately no Quit menu item or keyboard shortcut in this prototype.
    // Command+Q belongs to the prefix state machine below.
    let prefix_q = MenuItemBuilder::with_id("prefix-command-q", "Command+Q prefix (no quit)")
        .accelerator("Command+Q")
        .build(app)?;
    let wayfinder = SubmenuBuilder::new(app, "Wayfinder THROWAWAY")
        .items(&[&focus_a, &focus_b, &toggle_a, &toggle_b, &prefix_q])
        .build()?;
    MenuBuilder::new(app).item(&wayfinder).build()
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
        .focused(label == "client-a")
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
    if let Some(child) = map.get("client-a") {
        let _ = child.set_bounds(Rect {
            position: LogicalPosition::new(0.0, CHROME_HEIGHT).into(),
            size: LogicalSize::new(width, height).into(),
        });
    }
    if let Some(child) = map.get("client-b") {
        let _ = child.set_bounds(Rect {
            position: LogicalPosition::new(width, CHROME_HEIGHT).into(),
            size: LogicalSize::new(width, height).into(),
        });
    }
}

fn focus_child(children: &ChildMap, prefix: &Arc<Mutex<PrefixState>>, label: &str) {
    if let Some(child) = children.lock().unwrap().get(label).cloned() {
        let _ = child.set_focus();
        prefix.lock().unwrap().active_child = label.to_string();
        println!("[THROWAWAY] active child={label}");
    }
}

fn toggle_child(children: &ChildMap, hidden: &Arc<Mutex<HashMap<String, bool>>>, label: &str) {
    let Some(child) = children.lock().unwrap().get(label).cloned() else {
        return;
    };
    let mut state = hidden.lock().unwrap();
    let is_hidden = state.entry(label.to_string()).or_insert(false);
    *is_hidden = !*is_hidden;
    let result = if *is_hidden {
        child.hide()
    } else {
        child.show()
    };
    println!(
        "[THROWAWAY] {label} {} ({result:?})",
        if *is_hidden { "hidden" } else { "shown" }
    );
}

fn handle_prefix_q(children: &ChildMap, prefix: &Arc<Mutex<PrefixState>>) {
    let (target, forwarded) = {
        let mut state = prefix.lock().unwrap();
        let now = Instant::now();
        let forwarded = state.armed_until.is_some_and(|deadline| deadline >= now);
        let target = state.active_child.clone();
        state.armed_until = if forwarded {
            None
        } else {
            Some(now + PREFIX_TIMEOUT)
        };
        (target, forwarded)
    };

    if forwarded {
        if let Some(child) = children.lock().unwrap().get(&target).cloned() {
            // Centralized shell bridge for the prototype. A production integration should
            // replace this with a native event forwarding hook rather than page-specific JS.
            let _ = child.eval("window.__wayfinderForwardedQ?.()");
            println!("[THROWAWAY] Command+Q twice -> forwarded one Q to {target}");
        }
    } else {
        println!("[THROWAWAY] Command+Q prefix armed for {PREFIX_TIMEOUT:?}");
    }
}

fn start_test_server() -> std::io::Result<(SocketAddr, thread::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let page = Arc::new(TEST_PAGE.as_bytes().to_vec());
    let handle = thread::spawn(move || loop {
        match listener.accept() {
            Ok((stream, _peer)) => {
                let page = page.clone();
                thread::spawn(move || serve_test_connection(stream, page));
            }
            Err(error) => eprintln!("[THROWAWAY] test server accept error: {error}"),
        }
    });
    Ok((address, handle))
}

fn serve_test_connection(mut stream: TcpStream, page: Arc<Vec<u8>>) {
    let mut request = [0_u8; 8192];
    let Ok(read) = stream.read(&mut request) else {
        return;
    };
    let request = String::from_utf8_lossy(&request[..read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    if path.starts_with("/events") {
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

    let (content_type, body): (&str, &[u8]) = if path.starts_with("/heartbeat") {
        ("text/plain; charset=utf-8", b"ok")
    } else {
        ("text/html; charset=utf-8", page.as_slice())
    };
    let header = format!(
    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
    body.len()
  );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}
