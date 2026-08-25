// THROWAWAY Wave 0 real OpenVSCode Workbench host.
//
// This is an isolated native harness, not production code. It intentionally
// keeps all host logic in this prototype directory and never modifies the
// pinned OpenVSCode source tree.

use std::{
    collections::HashMap,
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    utils::config::BackgroundThrottlingPolicy,
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewBuilder, WebviewUrl,
    WebviewWindow, Window, WindowEvent, Wry,
};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSResponder, NSView, NSWindow};

const CHROME_HEIGHT: f64 = 72.0;
const SHARED_DATA_STORE_ID: [u8; 16] = *b"DEVHUB-WB-STORE1";

type ChildMap = Arc<Mutex<HashMap<String, Webview<Wry>>>>;

#[derive(Clone, Copy)]
struct SurfaceSpec {
    label: &'static str,
    env_name: &'static str,
    display_name: &'static str,
}

const SURFACES: [SurfaceSpec; 3] = [
    SurfaceSpec {
        label: "global",
        env_name: "REAL_WORKBENCH_GLOBAL_URL",
        display_name: "Global (?ew=true)",
    },
    SurfaceSpec {
        label: "folder-one",
        env_name: "REAL_WORKBENCH_FOLDER_ONE_URL",
        display_name: "Folder 1",
    },
    SurfaceSpec {
        label: "folder-two",
        env_name: "REAL_WORKBENCH_FOLDER_TWO_URL",
        display_name: "Folder 2",
    },
];

fn main() {
    let children: ChildMap = Arc::new(Mutex::new(HashMap::new()));
    let hidden = Arc::new(Mutex::new(HashMap::<String, bool>::new()));
    let active = Arc::new(Mutex::new("global".to_string()));
    let active_for_setup = active.clone();

    tauri::Builder::default()
        .menu(build_menu)
        .setup({
            let children = children.clone();
            let hidden = hidden.clone();
            move |app| {
                let shell = app
                    .get_webview_window("main")
                    .expect("main shell webview from tauri.conf.json");
                let window = shell.as_ref().window();
                let scale_factor = window.scale_factor().unwrap_or(1.0);
                let physical_size = window.inner_size().expect("shell inner size");
                let logical_size = physical_size.to_logical::<f64>(scale_factor);
                let child_width = (logical_size.width / 3.0).max(260.0);
                let child_height = (logical_size.height - CHROME_HEIGHT).max(200.0);

                let data_root = env::var_os("REAL_WORKBENCH_SHARED_DATA_ROOT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        PathBuf::from("/private/tmp/real-workbench-host/shared-webkit-data")
                    });
                fs::create_dir_all(&data_root).expect("create shared WebKit data root");
                println!(
                    "[REAL-WORKBENCH-THROWAWAY] shared_data_root={} shared_data_store_id={}",
                    data_root.display(),
                    hex_id(SHARED_DATA_STORE_ID)
                );

                for (index, spec) in SURFACES.iter().enumerate() {
                    let raw_url = env::var(spec.env_name).unwrap_or_else(|_| {
                        panic!(
                            "missing {} (expected authenticated loopback URL for {})",
                            spec.env_name, spec.display_name
                        )
                    });
                    let url = tauri::Url::parse(&raw_url).unwrap_or_else(|error| {
                        panic!("invalid {} URL: {error}", spec.env_name)
                    });
                    assert_loopback_url(&url, spec.env_name);
                    println!(
                        "[REAL-WORKBENCH-THROWAWAY] surface={} url={} data_store_id={}",
                        spec.label,
                        redact_url(url.as_str()),
                        hex_id(SHARED_DATA_STORE_ID)
                    );

                    let position = LogicalPosition::new(child_width * index as f64, CHROME_HEIGHT);
                    let child = make_child(
                        &window,
                        *spec,
                        url,
                        position,
                        LogicalSize::new(child_width, child_height),
                        data_root.clone(),
                    )?;
                    children.lock().unwrap().insert(spec.label.to_string(), child);
                    hidden.lock().unwrap().insert(spec.label.to_string(), false);
                }

                layout_children(&window, &children, &hidden);
                print_host_state(
                    "initial",
                    &shell,
                    &window,
                    &children,
                    &hidden,
                    &active_for_setup,
                );
                if let Ok(label) = env::var("REAL_WORKBENCH_AUTO_HIDE_LABEL") {
                    if let Some(child) = children.lock().unwrap().get(&label).cloned() {
                        let result = child.hide();
                        hidden.lock().unwrap().insert(label.clone(), true);
                        println!(
                            "[REAL-WORKBENCH-THROWAWAY] auto_hide surface={} result={result:?}",
                            label
                        );
                    } else {
                        eprintln!(
                            "[REAL-WORKBENCH-THROWAWAY] auto_hide unknown surface={label}"
                        );
                    }
                }
                let resize_window = window.clone();
                let resize_children = children.clone();
                let resize_hidden = hidden.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Resized(size) = event {
                        println!(
                            "[REAL-WORKBENCH-THROWAWAY] native_resize physical={}x{}",
                            size.width, size.height
                        );
                        layout_children(&resize_window, &resize_children, &resize_hidden);
                    }
                    if let WindowEvent::Destroyed = event {
                        println!(
                            "[REAL-WORKBENCH-THROWAWAY] host_window_destroyed unix_ms={}",
                            now_ms()
                        );
                    }
                    if let WindowEvent::CloseRequested { .. } = event {
                        println!(
                            "[REAL-WORKBENCH-THROWAWAY] host_window_close_requested unix_ms={}",
                            now_ms()
                        );
                    }
                });

                install_close_control(&window);
                install_action_control(
                    &shell,
                    &window,
                    &children,
                    &hidden,
                    &active_for_setup,
                );

                println!(
                    "[REAL-WORKBENCH-THROWAWAY] attached surfaces=global,folder-one,folder-two"
                );
                println!(
                    "[REAL-WORKBENCH-THROWAWAY] menu=focus/hide-show/resize; no child Tauri capabilities"
                );
                Ok(())
            }
        })
        .on_menu_event({
            let children = children.clone();
            let hidden = hidden.clone();
            let active = active.clone();
            move |app, event| {
                let id = event.id();
                if let Some(label) = id.0.strip_prefix("focus-") {
                    focus_child(&children, &active, label);
                } else if let Some(label) = id.0.strip_prefix("toggle-") {
                    toggle_child(&children, &hidden, label);
                } else if id == "resize-narrow" {
                    resize_window(app, 1280.0, 820.0);
                } else if id == "resize-wide" {
                    resize_window(app, 1760.0, 1080.0);
                } else if id == "print-state" {
                    print_state(&children, &hidden, &active);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running THROWAWAY real Workbench host");
}

fn install_close_control(window: &Window<Wry>) {
    let Some(path) = env::var_os("REAL_WORKBENCH_CLOSE_CONTROL_FILE").map(PathBuf::from) else {
        return;
    };
    println!(
        "[REAL-WORKBENCH-THROWAWAY] close_control=file:{}",
        path.display()
    );
    let watcher = window.clone();
    thread::spawn(move || {
        while !path.exists() {
            thread::sleep(Duration::from_millis(50));
        }
        println!(
            "[REAL-WORKBENCH-THROWAWAY] close_control_requested unix_ms={}",
            now_ms()
        );
        let target = watcher.clone();
        let result = watcher.run_on_main_thread(move || {
            let close_result = target.close();
            println!("[REAL-WORKBENCH-THROWAWAY] native_window_close result={close_result:?}");
        });
        println!("[REAL-WORKBENCH-THROWAWAY] close_control_dispatch result={result:?}");
    });
}

// The lifecycle audit is driven by a finite file protocol so the runner can
// retain an auditable order without injecting JavaScript or synthetic DOM
// events into any OpenVSCode child.
fn install_action_control(
    shell: &WebviewWindow<Wry>,
    window: &Window<Wry>,
    children: &ChildMap,
    hidden: &Arc<Mutex<HashMap<String, bool>>>,
    active: &Arc<Mutex<String>>,
) {
    let Some(path) = env::var_os("REAL_WORKBENCH_ACTION_CONTROL_FILE").map(PathBuf::from) else {
        return;
    };
    println!(
        "[REAL-WORKBENCH-THROWAWAY] action_control=file:{}",
        path.display()
    );
    let dispatcher = window.clone();
    let shell = shell.clone();
    let children = children.clone();
    let hidden = hidden.clone();
    let active = active.clone();
    thread::spawn(move || {
        let mut processed = 0usize;
        loop {
            if let Ok(content) = fs::read_to_string(&path) {
                let commands = content.lines().map(str::trim).collect::<Vec<_>>();
                while processed < commands.len() {
                    let command = commands[processed].to_string();
                    processed += 1;
                    let shell = shell.clone();
                    let window = dispatcher.clone();
                    let children = children.clone();
                    let hidden = hidden.clone();
                    let active = active.clone();
                    let _ = dispatcher.run_on_main_thread(move || {
                        apply_action(&command, &shell, &window, &children, &hidden, &active);
                    });
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    });
}

fn apply_action(
    command: &str,
    shell: &WebviewWindow<Wry>,
    window: &Window<Wry>,
    children: &ChildMap,
    hidden: &Arc<Mutex<HashMap<String, bool>>>,
    active: &Arc<Mutex<String>>,
) {
    let mut parts = command.split_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some("snapshot"), Some(phase), None) => {
            print_host_state(phase, shell, window, children, hidden, active);
        }
        (Some(action @ ("hide" | "show")), Some(label), None) => {
            let Some(child) = children.lock().unwrap().get(label).cloned() else {
                println!(
                    "[REAL-WORKBENCH-THROWAWAY] visibility_transition surface={} action={} result=unknown_surface",
                    label, action
                );
                return;
            };
            let result = if action == "hide" {
                child.hide()
            } else {
                child.show()
            };
            hidden
                .lock()
                .unwrap()
                .insert(label.to_string(), action == "hide");
            let native_visible = native_view_visible(&child);
            println!(
                "[REAL-WORKBENCH-THROWAWAY] visibility_transition surface={} action={} result={result:?} native_visible={native_visible:?}",
                label, action
            );
        }
        (Some("focus"), Some(label), None) => {
            let Some(child) = children.lock().unwrap().get(label).cloned() else {
                println!(
                    "[REAL-WORKBENCH-THROWAWAY] focus_audit selected={} result=unknown_surface",
                    label
                );
                return;
            };
            let window_result = window.set_focus();
            let child_result = child.set_focus();
            let (key_window, first_responder_present, first_responder_selected) =
                native_focus_restore(&child);
            *active.lock().unwrap() = label.to_string();
            let window_focused = window.is_focused().unwrap_or(false);
            println!(
                "[REAL-WORKBENCH-THROWAWAY] focus_audit selected={} window_result={window_result:?} child_result={child_result:?} window_focused={} key_window={} first_responder_present={} first_responder_selected={}",
                label,
                window_focused,
                key_window,
                first_responder_present,
                first_responder_selected
            );
        }
        (Some("resize-user-like"), Some(width), Some(height)) => {
            let Ok(width) = width.parse::<f64>() else {
                return;
            };
            let Ok(height) = height.parse::<f64>() else {
                return;
            };
            println!(
                "[REAL-WORKBENCH-THROWAWAY] user_like_resize_requested logical={}x{}",
                width, height
            );
            let result = shell.set_size(LogicalSize::new(width, height));
            println!(
                "[REAL-WORKBENCH-THROWAWAY] resize_window logical={}x{} result={result:?}",
                width, height
            );
        }
        _ => println!(
            "[REAL-WORKBENCH-THROWAWAY] action_control_unknown command={}",
            command
        ),
    }
}

fn print_host_state(
    phase: &str,
    shell: &WebviewWindow<Wry>,
    window: &Window<Wry>,
    children: &ChildMap,
    hidden: &Arc<Mutex<HashMap<String, bool>>>,
    active: &Arc<Mutex<String>>,
) {
    let visible = shell.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    let (key_window, first_responder_present) = native_shell_focus(shell);
    let size = window.inner_size().ok();
    println!(
        "[REAL-WORKBENCH-THROWAWAY] host_state phase={} visible={} dimensions={}x{} window_focused={} key_window={} first_responder_present={} active={}",
        phase,
        visible,
        size.map(|value| value.width.to_string()).unwrap_or_else(|| "unknown".into()),
        size.map(|value| value.height.to_string()).unwrap_or_else(|| "unknown".into()),
        focused,
        key_window,
        first_responder_present,
        active.lock().unwrap(),
    );
    let children = children.lock().unwrap();
    let hidden = hidden.lock().unwrap();
    for label in ["global", "folder-one", "folder-two"] {
        if let Some(child) = children.get(label) {
            println!(
                "[REAL-WORKBENCH-THROWAWAY] host_child_state phase={} surface={} visible={} hidden={} url={:?} bounds={:?}",
                phase,
                label,
                native_view_visible(child).unwrap_or(!hidden.get(label).copied().unwrap_or(false)),
                hidden.get(label).copied().unwrap_or(false),
                child.url().map(|url| redact_url(url.as_str())),
                child.bounds(),
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn native_shell_focus(shell: &WebviewWindow<Wry>) -> (bool, bool) {
    let state = Arc::new(Mutex::new((false, false)));
    let state_for_callback = state.clone();
    let _ = shell.with_webview(move |webview| unsafe {
        let window: &NSWindow = &*webview.ns_window().cast();
        *state_for_callback.lock().unwrap() =
            (window.isKeyWindow(), window.firstResponder().is_some());
    });
    let value = *state.lock().unwrap();
    value
}

#[cfg(not(target_os = "macos"))]
fn native_shell_focus(_shell: &WebviewWindow<Wry>) -> (bool, bool) {
    (false, false)
}

#[cfg(target_os = "macos")]
fn native_view_visible(child: &Webview<Wry>) -> Option<bool> {
    let result = Arc::new(Mutex::new(None));
    let result_for_callback = result.clone();
    let _ = child.with_webview(move |webview| unsafe {
        let view: &NSView = &*webview.inner().cast();
        *result_for_callback.lock().unwrap() = Some(!view.isHiddenOrHasHiddenAncestor());
    });
    let value = *result.lock().unwrap();
    value
}

#[cfg(not(target_os = "macos"))]
fn native_view_visible(_child: &Webview<Wry>) -> Option<bool> {
    None
}

#[cfg(target_os = "macos")]
fn native_focus_restore(child: &Webview<Wry>) -> (bool, bool, bool) {
    let state = Arc::new(Mutex::new((false, false, false)));
    let state_for_callback = state.clone();
    let _ = child.with_webview(move |webview| unsafe {
        let window: &NSWindow = &*webview.ns_window().cast();
        let view: &NSView = &*webview.inner().cast();
        window.makeKeyWindow();
        let responder: &NSResponder = &*(view as *const NSView as *const NSResponder);
        let selected = window.makeFirstResponder(Some(responder));
        let first = window.firstResponder();
        let first_ptr = first
            .as_ref()
            .map(|value| value.as_ref() as *const NSResponder as usize);
        let view_ptr = view as *const NSView as usize;
        *state_for_callback.lock().unwrap() = (
            window.isKeyWindow(),
            first.is_some(),
            selected && first_ptr == Some(view_ptr),
        );
    });
    let value = *state.lock().unwrap();
    value
}

#[cfg(not(target_os = "macos"))]
fn native_focus_restore(_child: &Webview<Wry>) -> (bool, bool, bool) {
    (false, false, false)
}

fn build_menu(app: &AppHandle<Wry>) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let focus_global = MenuItemBuilder::with_id("focus-global", "Focus Global")
        .accelerator("Command+1")
        .build(app)?;
    let focus_one = MenuItemBuilder::with_id("focus-folder-one", "Focus Folder 1")
        .accelerator("Command+2")
        .build(app)?;
    let focus_two = MenuItemBuilder::with_id("focus-folder-two", "Focus Folder 2")
        .accelerator("Command+3")
        .build(app)?;
    let hide_global = MenuItemBuilder::with_id("toggle-global", "Hide/show Global").build(app)?;
    let hide_one =
        MenuItemBuilder::with_id("toggle-folder-one", "Hide/show Folder 1").build(app)?;
    let hide_two =
        MenuItemBuilder::with_id("toggle-folder-two", "Hide/show Folder 2").build(app)?;
    let resize_narrow =
        MenuItemBuilder::with_id("resize-narrow", "Resize narrow fixture").build(app)?;
    let resize_wide = MenuItemBuilder::with_id("resize-wide", "Resize wide fixture").build(app)?;
    let print_state = MenuItemBuilder::with_id("print-state", "Print host state").build(app)?;
    let host = SubmenuBuilder::new(app, "Real Workbench THROWAWAY")
        .items(&[
            &focus_global,
            &focus_one,
            &focus_two,
            &hide_global,
            &hide_one,
            &hide_two,
            &resize_narrow,
            &resize_wide,
            &print_state,
        ])
        .build()?;
    MenuBuilder::new(app).item(&host).build()
}

fn make_child(
    window: &Window<Wry>,
    spec: SurfaceSpec,
    url: tauri::Url,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
    shared_data_root: PathBuf,
) -> tauri::Result<Webview<Wry>> {
    let label = spec.label.to_string();
    let page_label = label.clone();
    let started_url = url.clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        // All three children intentionally use one stable WebKit data root and
        // one stable identifier. Folder identity is a URL/workbench concern.
        .data_directory(shared_data_root)
        .data_store_identifier(SHARED_DATA_STORE_ID)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .focused(spec.label == "global")
        .devtools(true)
        .on_page_load(move |webview, payload| {
            println!(
                "[REAL-WORKBENCH-THROWAWAY] page_load surface={} webview={} event={:?} url={}",
                page_label,
                webview.label(),
                payload.event(),
                redact_url(payload.url().as_str())
            );
        });
    println!(
        "[REAL-WORKBENCH-THROWAWAY] child_create surface={} initial_url={} shared_store={}",
        spec.label,
        redact_url(started_url.as_str()),
        hex_id(SHARED_DATA_STORE_ID)
    );
    window.add_child(builder, position, size)
}

fn layout_children(
    window: &Window<Wry>,
    children: &ChildMap,
    hidden: &Arc<Mutex<HashMap<String, bool>>>,
) {
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let Ok(physical_size) = window.inner_size() else {
        return;
    };
    let size = physical_size.to_logical::<f64>(scale_factor);
    let width = (size.width / 3.0).max(260.0);
    let height = (size.height - CHROME_HEIGHT).max(200.0);
    let children = children.lock().unwrap();
    let hidden = hidden.lock().unwrap();
    for (index, label) in ["global", "folder-one", "folder-two"].iter().enumerate() {
        if let Some(child) = children.get(*label) {
            let _ = child.set_bounds(Rect {
                position: LogicalPosition::new(width * index as f64, CHROME_HEIGHT).into(),
                size: LogicalSize::new(width, height).into(),
            });
            println!(
                "[REAL-WORKBENCH-THROWAWAY] set_bounds surface={} x={} y={} w={} h={} hidden={}",
                label,
                width * index as f64,
                CHROME_HEIGHT,
                width,
                height,
                hidden.get(*label).copied().unwrap_or(false)
            );
        }
    }
}

fn focus_child(children: &ChildMap, active: &Arc<Mutex<String>>, label: &str) {
    if let Some(child) = children.lock().unwrap().get(label).cloned() {
        let result = child.set_focus();
        *active.lock().unwrap() = label.to_string();
        println!(
            "[REAL-WORKBENCH-THROWAWAY] focus surface={} result={result:?}",
            label
        );
    }
}

fn toggle_child(children: &ChildMap, hidden: &Arc<Mutex<HashMap<String, bool>>>, label: &str) {
    let Some(child) = children.lock().unwrap().get(label).cloned() else {
        return;
    };
    let mut hidden = hidden.lock().unwrap();
    let state = hidden.entry(label.to_string()).or_insert(false);
    *state = !*state;
    let result = if *state { child.hide() } else { child.show() };
    println!(
        "[REAL-WORKBENCH-THROWAWAY] visibility surface={} state={} result={result:?}",
        label,
        if *state { "hidden" } else { "shown" }
    );
}

fn resize_window(app: &AppHandle<Wry>, width: f64, height: f64) {
    if let Some(shell) = app.get_webview_window("main") {
        let result = shell.set_size(LogicalSize::new(width, height));
        println!(
            "[REAL-WORKBENCH-THROWAWAY] resize_window logical={}x{} result={result:?}",
            width, height
        );
    }
}

fn print_state(
    children: &ChildMap,
    hidden: &Arc<Mutex<HashMap<String, bool>>>,
    active: &Arc<Mutex<String>>,
) {
    let children = children.lock().unwrap();
    let hidden = hidden.lock().unwrap();
    println!(
        "[REAL-WORKBENCH-THROWAWAY] state active={} labels={:?} hidden={:?}",
        active.lock().unwrap(),
        children.keys().collect::<Vec<_>>(),
        hidden
    );
    for (label, child) in children.iter() {
        println!(
            "[REAL-WORKBENCH-THROWAWAY] state surface={} url={:?} bounds={:?}",
            label,
            child.url().map(|url| redact_url(url.as_str())),
            child.bounds()
        );
    }
}

fn assert_loopback_url(url: &tauri::Url, env_name: &str) {
    let host = url.host_str().unwrap_or_default();
    assert!(
        url.scheme() == "http" && (host == "127.0.0.1" || host == "localhost"),
        "{env_name} must be an authenticated HTTP loopback URL, got {}",
        redact_url(url.as_str())
    );
}

fn redact_url(url: &str) -> String {
    url.split_once('?')
        .map(|(base, _)| format!("{base}?<query-redacted>"))
        .unwrap_or_else(|| url.to_string())
}

fn hex_id(bytes: [u8; 16]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}
