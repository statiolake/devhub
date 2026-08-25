// THROWAWAY F0.4 real Workbench URL/new-window boundary harness.
// OpenVSCode remains an untouched upstream input. This host only observes and
// cancels navigation/new-window requests at the public Tauri WebviewBuilder
// boundary allowed by ADR 0014.

use std::{
    env,
    io::{Read, Write},
    net::TcpStream,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
};

use tauri::{
    utils::config::BackgroundThrottlingPolicy, webview::NewWindowResponse, LogicalPosition,
    LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let shell = app
                .get_webview_window("main")
                .expect("main shell from tauri.conf.json");
            let window = shell.as_ref().window().clone();
            let workbench_url = env::var("BRIDGE_WORKBENCH_URL")
                .expect("BRIDGE_WORKBENCH_URL must be an authenticated loopback URL");
            let boundary_endpoint = env::var("BRIDGE_BOUNDARY_ENDPOINT")
                .expect("BRIDGE_BOUNDARY_ENDPOINT must be the host harness callback");
            // OpenVSCode performs an authenticated redirect before the real
            // Workbench page is loaded. Allow a small bounded bootstrap
            // budget. After the first real folder request is cancelled, allow
            // exactly one same-URL reload used to prove extension-host
            // restart; subsequent folder navigations remain intercepted.
            let initial = Arc::new(AtomicUsize::new(3));
            let allow_reload = Arc::new(AtomicBool::new(false));
            let scale = window.scale_factor().unwrap_or(1.0);
            let size = window
                .inner_size()
                .expect("window size")
                .to_logical::<f64>(scale);
            let child_size = LogicalSize::new(size.width, (size.height - 72.0).max(200.0));
            let url = tauri::Url::parse(&workbench_url).expect("valid Workbench URL");
            assert_loopback(&url);
            println!(
                "[F0.4-HOST] child_create url={} boundary=host-url-new-window",
                redact_url(&url)
            );

            let navigation_initial = initial.clone();
            let navigation_allow_reload = allow_reload.clone();
            let navigation_endpoint = boundary_endpoint.clone();
            let navigation = move |next: &tauri::Url| {
                let remaining = navigation_initial.load(Ordering::SeqCst);
                println!(
                    "[F0.4-HOST] navigation url={} bootstrap_remaining={remaining}",
                    redact_url(next)
                );
                if remaining > 0 {
                    navigation_initial.fetch_sub(1, Ordering::SeqCst);
                    return true;
                }
                if let Some(path) = folder_path(next) {
                    if navigation_allow_reload.swap(false, Ordering::SeqCst) {
                        println!(
                            "[F0.4-HOST] reload_navigation_allowed path={} action=allow",
                            path
                        );
                        return true;
                    }
                    println!(
                        "[F0.4-HOST] folder_navigation_intercepted path={} action=cancel",
                        path
                    );
                    post_boundary(
                        &navigation_endpoint,
                        "folder_navigation_intercepted",
                        Some(&path),
                        next,
                    );
                    navigation_allow_reload.store(true, Ordering::SeqCst);
                    return false;
                }
                true
            };

            let new_window_endpoint = boundary_endpoint.clone();
            let new_window = move |next: tauri::Url, _features| {
                let path = folder_path(&next);
                println!(
                    "[F0.4-HOST] new_window_intercepted path={} action=deny url={}",
                    path.as_deref().unwrap_or("<global>"),
                    redact_url(&next)
                );
                post_boundary(
                    &new_window_endpoint,
                    "new_window_intercepted",
                    path.as_deref(),
                    &next,
                );
                NewWindowResponse::Deny
            };

            let child = WebviewBuilder::new("workbench", WebviewUrl::External(url))
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .on_navigation(navigation)
                .on_new_window(new_window)
                .on_page_load(|webview, payload| {
                    println!(
                        "[F0.4-HOST] page_load webview={} event={:?} url={}",
                        webview.label(),
                        payload.event(),
                        redact_url(payload.url())
                    );
                });
            window.add_child(child, LogicalPosition::new(0.0, 0.0), child_size)?;
            println!("[F0.4-HOST] ready boundary=public-tauri-webview-callbacks");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running F0.4 host harness");
}

fn assert_loopback(url: &tauri::Url) {
    let host = url.host_str().unwrap_or_default();
    assert!(
        url.scheme() == "http" && (host == "127.0.0.1" || host == "localhost"),
        "Workbench URL must be HTTP loopback, got {}",
        redact_url(url)
    );
}

fn folder_path(url: &tauri::Url) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == "folder" || key == "folder-uri")
        .map(|(_, value)| value.into_owned())
        .filter(|path| path.starts_with('/') && !path.contains('\0'))
}

fn redact_url(url: &tauri::Url) -> String {
    let query = if url.query().is_some() {
        "?<query-redacted>"
    } else {
        ""
    };
    format!(
        "{}://{}{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.path(),
        query
    )
}

fn post_boundary(endpoint: &str, kind: &str, path: Option<&str>, url: &tauri::Url) {
    let Ok(endpoint_url) = tauri::Url::parse(endpoint) else {
        return;
    };
    let Some(host) = endpoint_url.host_str() else {
        return;
    };
    let port = endpoint_url.port_or_known_default().unwrap_or(80);
    let request_path = endpoint_url.path().to_string();
    let body = format!(
        "{{\"kind\":\"{}\",\"path\":{},\"url\":\"{}\"}}",
        kind,
        path.map(|value| format!("\"{}\"", json_escape(value)))
            .unwrap_or_else(|| "null".into()),
        json_escape(&redact_url(url)),
    );
    thread::spawn({
        let host = host.to_string();
        move || {
            let Ok(mut stream) = TcpStream::connect((host.as_str(), port)) else {
                return;
            };
            let request = format!(
                "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                request_path,
                host,
                body.len(),
                body,
            );
            let _ = stream.write_all(request.as_bytes());
            let mut response = [0_u8; 128];
            let _ = stream.read(&mut response);
        }
    });
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
