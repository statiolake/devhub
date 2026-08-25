//! macOS AppKit adapter for the host key router.
//!
//! The important boundary is `forward_native_key`: it creates an AppKit
//! `NSEvent` and invokes `NSResponder::keyDown` on the selected WKWebView. It
//! never calls `eval`, `dispatchEvent`, or constructs a DOM `KeyboardEvent`.

#![cfg(target_os = "macos")]

use std::{
    ffi::{c_char, c_void, CStr},
    ptr::NonNull,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

use block2::RcBlock;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSResponder, NSView};
use objc2_core_graphics::{CGEvent, CGEventFlags};
use objc2_foundation::{NSPoint, NSString};
use tauri::{AppHandle, Manager, Wry};

use crate::{
    router::{Child, Decision, HostCommand, KeyStroke},
    HostState,
};

const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentKeyboardInputSource() -> *const c_void;
    fn TISCreateInputSourceList(
        properties: *const c_void,
        include_all_installed: bool,
    ) -> *const c_void;
    fn TISGetInputSourceProperty(
        input_source: *const c_void,
        property_key: *const c_void,
    ) -> *const c_void;
    fn TISSelectInputSource(input_source: *const c_void) -> i32;
    static kTISPropertyInputSourceID: *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    fn CFRelease(value: *const c_void);
    fn CFStringGetCString(
        string: *const c_void,
        buffer: *mut c_char,
        buffer_size: isize,
        encoding: u32,
    ) -> bool;
}

/// A copy of the native event's scalar/string fields that can safely cross the
/// `with_webview` callback boundary. The original NSEvent is only borrowed by
/// AppKit while the local monitor callback is running.
#[derive(Clone, Debug)]
struct NativeKeyData {
    key_code: u16,
    modifier_flags: usize,
    timestamp: f64,
    window_number: isize,
    location_x: f64,
    location_y: f64,
    characters: String,
    characters_ignoring_modifiers: String,
    is_repeat: bool,
}

impl NativeKeyData {
    fn from_event(event: &NSEvent) -> Self {
        let characters = event
            .characters()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let characters_ignoring_modifiers = event
            .charactersIgnoringModifiers()
            .map(|value| value.to_string())
            .unwrap_or_else(|| characters.clone());
        let location = event.locationInWindow();

        Self {
            key_code: event.keyCode(),
            modifier_flags: event.modifierFlags().bits(),
            timestamp: event.timestamp(),
            window_number: event.windowNumber(),
            location_x: location.x,
            location_y: location.y,
            characters,
            characters_ignoring_modifiers,
            is_repeat: event.isARepeat(),
        }
    }

    fn stroke(&self) -> KeyStroke {
        let flags = NSEventModifierFlags::from_bits_retain(self.modifier_flags);
        KeyStroke {
            key_code: self.key_code,
            command: flags.contains(NSEventModifierFlags::Command),
            shift: flags.contains(NSEventModifierFlags::Shift),
            option: flags.contains(NSEventModifierFlags::Option),
            control: flags.contains(NSEventModifierFlags::Control),
        }
    }
}

/// Install one application-local monitor. AppKit retains the monitor token;
/// this prototype intentionally keeps it for process lifetime because the
/// harness has one main window and exits as a whole.
pub fn install_local_monitor(app: AppHandle<Wry>, state: Arc<HostState>) {
    let state_for_block = state.clone();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let event_ptr = event.as_ptr();
        let event = unsafe { event.as_ref() };
        let data = NativeKeyData::from_event(event);
        let stroke = data.stroke();
        let now = Instant::now();
        let decision = {
            let mut router = state_for_block.router.lock().unwrap();
            router.route(stroke, now)
        };

        match decision {
            Decision::PrefixArmed { .. } => {
                state_for_block.record_host(format!(
                    "prefix armed timeout_ms={} key_code={}",
                    crate::router::PREFIX_TIMEOUT.as_millis(),
                    data.key_code
                ));
                std::ptr::null_mut()
            }
            Decision::ForwardNativeQ { target } => {
                state_for_block.record_host(format!(
                    "forward native key equivalent key=q target={} key_code={} synthetic_js=false",
                    target.label(),
                    data.key_code
                ));
                forward_native_key(&app, target, data);
                std::ptr::null_mut()
            }
            Decision::Route(command) => {
                route_host_command(&app, &state_for_block, command);
                std::ptr::null_mut()
            }
            Decision::Pass { cleared_prefix } => {
                if cleared_prefix {
                    state_for_block.record_host(format!(
                        "prefix cleared and native event passed key_code={} command={}",
                        data.key_code, stroke.command
                    ));
                }
                // Returning the original pointer preserves the event's native
                // AppKit path, including IME and ordinary Workbench shortcuts.
                event_ptr
            }
        }
    });

    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    if monitor.is_none() {
        state.record_host("ERROR local NSEvent monitor installation failed".to_string());
    }
    // AppKit owns the monitor after registration. Keep the token alive anyway:
    // dropping it would make cleanup semantics ambiguous for this throwaway
    // harness, and process exit releases it.
    std::mem::forget(monitor);
}

fn route_host_command(app: &AppHandle<Wry>, state: &Arc<HostState>, command: HostCommand) {
    match command {
        HostCommand::Focus(child) => {
            {
                let mut router = state.router.lock().unwrap();
                router.focus(child);
            }
            focus_child(app, child);
            state.record_host(format!("route host command=focus target={}", child.label()));
        }
        HostCommand::Settings => {
            // The prototype has no product Settings window. The route is still
            // observable and deliberately consumed while a Q prefix is armed.
            state.record_host("route host command=settings".to_string());
        }
    }
}

pub fn focus_child(app: &AppHandle<Wry>, child: Child) {
    if let Some(webview) = app.get_webview(child.label()) {
        let _ = webview.set_focus();
        let _ = webview.with_webview(|platform| {
            let raw = platform.inner();
            if raw.is_null() {
                return;
            }

            // Keep focus inside AppKit rather than asking Accessibility to find
            // or raise a window. The child view is the active responder of its
            // own native NSWindow before the CGEvent self-injection begins.
            let view: &NSView = unsafe { &*raw.cast::<NSView>() };
            if let Some(window) = view.window() {
                window.makeKeyAndOrderFront(None);
                let responder: &NSResponder = unsafe { &*raw.cast::<NSResponder>() };
                let _ = window.makeFirstResponder(Some(responder));
            }
        });
    }
}

/// Start a bounded, self-targeted CoreGraphics smoke sequence. This path does
/// not enumerate windows through AX and does not create DOM events. It is only
/// enabled by `DEVHUB_NATIVE_KEY_ROUTER_SELF_TEST=1` so an ordinary prototype
/// launch remains passive.
pub fn start_self_injection(app: AppHandle<Wry>, state: Arc<HostState>) {
    let focus_app = app.clone();
    let focus_state = state.clone();
    let _ = app.run_on_main_thread(move || {
        focus_child(&focus_app, Child::A);
        focus_state
            .record_host("self injection focused child-a via AppKit NSWindow/NSView".to_string());
    });

    thread::spawn(move || {
        let pid = std::process::id() as _;
        thread::sleep(Duration::from_millis(800));

        for (key_code, flags, label) in [
            (crate::router::KEY_P, CGEventFlags::MaskCommand, "cmd-p"),
            (
                crate::router::KEY_P,
                CGEventFlags::MaskCommand | CGEventFlags::MaskShift,
                "cmd-shift-p",
            ),
            (crate::router::KEY_S, CGEventFlags::MaskCommand, "cmd-s"),
            (crate::router::KEY_Z, CGEventFlags::MaskCommand, "cmd-z"),
            (crate::router::KEY_C, CGEventFlags::MaskCommand, "cmd-c"),
            (crate::router::KEY_V, CGEventFlags::MaskCommand, "cmd-v"),
        ] {
            post_key(pid, key_code, flags, label, &state);
            thread::sleep(Duration::from_millis(90));
        }

        // Prefix clear by an unmapped key, then a defined Settings route.
        post_key(
            pid,
            crate::router::KEY_Q,
            CGEventFlags::MaskCommand,
            "prefix-first-q",
            &state,
        );
        post_key(
            pid,
            40,
            CGEventFlags::MaskCommand,
            "prefix-unknown-command-k",
            &state,
        );
        post_key(
            pid,
            crate::router::KEY_Q,
            CGEventFlags::MaskCommand,
            "prefix-first-q-settings",
            &state,
        );
        post_key(
            pid,
            crate::router::KEY_COMMA,
            CGEventFlags::MaskCommand,
            "prefix-command-comma-settings",
            &state,
        );

        // Focus B while a prefix is armed; the stale prefix must not forward.
        post_key(
            pid,
            crate::router::KEY_Q,
            CGEventFlags::MaskCommand,
            "prefix-first-q-focus-b",
            &state,
        );
        post_key(
            pid,
            crate::router::KEY_2,
            CGEventFlags::MaskCommand,
            "prefix-command-2-focus-b",
            &state,
        );
        thread::sleep(Duration::from_millis(250));

        // Exact double-Q reaches the active B child through the host's native
        // forwarding path. This is one CGEvent pair, not a DOM dispatch.
        post_key(
            pid,
            crate::router::KEY_Q,
            CGEventFlags::MaskCommand,
            "double-q-first",
            &state,
        );
        thread::sleep(Duration::from_millis(180));
        post_key(
            pid,
            crate::router::KEY_Q,
            CGEventFlags::MaskCommand,
            "double-q-second-forward",
            &state,
        );

        // A delayed second Q is a fresh prefix, not a forward. A final K clears
        // that fresh state so the observable run ends in an unarmed state.
        post_key(
            pid,
            crate::router::KEY_Q,
            CGEventFlags::MaskCommand,
            "timeout-first-q",
            &state,
        );
        thread::sleep(Duration::from_millis(1_150));
        post_key(
            pid,
            crate::router::KEY_Q,
            CGEventFlags::MaskCommand,
            "timeout-second-q-fresh-prefix",
            &state,
        );
        post_key(
            pid,
            40,
            CGEventFlags::MaskCommand,
            "timeout-clear-command-k",
            &state,
        );
        state.record_host("self injection complete source=CGEventPostToPid".to_string());
    });
}

/// Start the optional Japanese IME smoke. TIS is used only to select a
/// Hiragana/Kotoeri input source; the original source is retained and restored
/// before this finite sequence reports completion. If the Carbon API cannot
/// enumerate/select a Japanese source, the run records BLOCKED and sends no
/// text events.
pub fn start_ime_self_injection(app: AppHandle<Wry>, state: Arc<HostState>) {
    let focus_app = app.clone();
    let focus_state = state.clone();
    let _ = app.run_on_main_thread(move || {
        focus_child(&focus_app, Child::A);
        focus_state.record_host(
            "ime self injection focused child-a via AppKit NSWindow/NSView".to_string(),
        );
    });

    let (select_tx, select_rx) = mpsc::channel();
    let select_state = state.clone();
    let select_scheduled = app
        .run_on_main_thread(move || {
            // TIS APIs are deliberately called on the Tauri/AppKit main
            // thread. If the worker has already timed out, restore immediately
            // here rather than leaking a changed input source.
            let result = select_tis_on_main(&select_state);
            if let Err(mpsc::SendError(result)) = select_tx.send(result) {
                if let TisSelectionResult::Selected(selection) = result {
                    let _ = restore_tis_on_main(selection, &select_state);
                }
            }
        })
        .is_ok();

    let worker_app = app.clone();
    thread::spawn(move || {
        if !select_scheduled {
            state.record_host(
                "ime self injection BLOCKED TIS select main-thread handoff failed".to_string(),
            );
            return;
        }

        let selection = match select_rx.recv_timeout(Duration::from_secs(4)) {
            Ok(TisSelectionResult::Selected(selection)) => selection,
            Ok(TisSelectionResult::Blocked(reason)) => {
                state.record_host(format!("ime self injection BLOCKED {reason}"));
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                state.record_host(
                    "ime self injection BLOCKED TIS select main-thread timeout".to_string(),
                );
                return;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                state.record_host(
                    "ime self injection BLOCKED TIS select handoff disconnected".to_string(),
                );
                return;
            }
        };

        // TIS selection can complete before the external observer has finished
        // navigation/autofocus. Let both child pages reach ready/focusin before
        // the first roman key so the composition transcript covers all keys.
        thread::sleep(Duration::from_millis(800));

        // The textarea has autofocus in the observer page. These are ordinary
        // unmodified roman key events; AppKit's selected input source owns the
        // composition/commit path.
        for (key_code, label) in [
            (45, "ime-n"),
            (34, "ime-i"),
            (4, "ime-h"),
            (31, "ime-o"),
            (45, "ime-n"),
            (5, "ime-g"),
            (31, "ime-o"),
        ] {
            post_key(
                std::process::id() as _,
                key_code,
                CGEventFlags::empty(),
                label,
                &state,
            );
            thread::sleep(Duration::from_millis(90));
        }
        post_key(
            std::process::id() as _,
            36,
            CGEventFlags::empty(),
            "ime-commit-return",
            &state,
        );
        thread::sleep(Duration::from_millis(700));

        let (restore_tx, restore_rx) = mpsc::channel();
        let restore_state = state.clone();
        let restore_scheduled = worker_app
            .run_on_main_thread(move || {
                let restored = restore_tis_on_main(selection, &restore_state);
                let _ = restore_tx.send(restored);
            })
            .is_ok();
        if !restore_scheduled {
            state.record_host(
                "ime self injection BLOCKED TIS restore main-thread handoff failed".to_string(),
            );
            return;
        }
        let restored = restore_rx
            .recv_timeout(Duration::from_secs(4))
            .unwrap_or(false);
        if !restored {
            state.record_host(
                "ime self injection BLOCKED previous TIS source restore failed".to_string(),
            );
            return;
        }
        state.record_host(
            "ime self injection complete composition=nihongo source_restored=true".to_string(),
        );
    });
}

enum TisSelectionResult {
    Selected(TisSelection),
    Blocked(String),
}

struct TisSelection {
    previous: usize,
    previous_id: String,
    selected_id: String,
}

fn select_tis_on_main(state: &Arc<HostState>) -> TisSelectionResult {
    state.record_host("ime self injection querying TIS on main thread".to_string());
    let previous = unsafe { TISCopyCurrentKeyboardInputSource() };
    if previous.is_null() {
        return TisSelectionResult::Blocked("TIS current source unavailable".to_string());
    }

    let property_key = unsafe { kTISPropertyInputSourceID };
    let previous_id = cf_string(unsafe { TISGetInputSourceProperty(previous, property_key) });
    let sources = unsafe { TISCreateInputSourceList(std::ptr::null(), true) };
    if sources.is_null() {
        unsafe { CFRelease(previous) };
        return TisSelectionResult::Blocked("TIS source list unavailable".to_string());
    }

    let count = unsafe { CFArrayGetCount(sources) };
    let mut candidates = Vec::new();
    for index in 0..count {
        let source = unsafe { CFArrayGetValueAtIndex(sources, index) };
        if source.is_null() {
            continue;
        }
        let property = unsafe { TISGetInputSourceProperty(source, property_key) };
        let id = cf_string(property);
        let rank = if id.contains("Hiragana") {
            Some(0)
        } else if id.contains("Kotoeri") {
            Some(1)
        } else if id.contains("Japanese") && !id.contains("FullWidthRoman") {
            Some(2)
        } else if id.contains("Japanese") {
            Some(3)
        } else {
            None
        };
        if let Some(rank) = rank {
            candidates.push((rank, source, id));
        }
    }
    candidates.sort_by_key(|(rank, _, _)| *rank);
    let candidate_ids = candidates
        .iter()
        .map(|(_, _, id)| id.as_str())
        .collect::<Vec<_>>()
        .join(",");
    state.record_host(format!(
        "ime self injection TIS candidates count={} ids={candidate_ids}",
        candidates.len()
    ));

    if candidates.is_empty() {
        unsafe {
            CFRelease(sources);
            CFRelease(previous);
        }
        return TisSelectionResult::Blocked(format!(
            "no Japanese TIS source id candidates count={count}"
        ));
    }

    let mut selected = None;
    for (_, target, selected_id) in candidates {
        let result = unsafe { TISSelectInputSource(target) };
        if result == 0 {
            selected = Some(selected_id);
            break;
        }
        state.record_host(format!(
            "ime self injection TIS candidate rejected source_id={selected_id} status={result}"
        ));
    }
    unsafe { CFRelease(sources) };
    let Some(selected_id) = selected else {
        unsafe { CFRelease(previous) };
        return TisSelectionResult::Blocked(format!(
            "TIS select failed candidates={candidate_ids}"
        ));
    };
    state.record_host(format!(
        "ime self injection selected TIS source_id={selected_id} previous_source_id={previous_id} candidates={count}"
    ));
    TisSelectionResult::Selected(TisSelection {
        previous: previous as usize,
        previous_id,
        selected_id,
    })
}

fn restore_tis_on_main(selection: TisSelection, state: &Arc<HostState>) -> bool {
    let previous = selection.previous as *const c_void;
    let status = unsafe { TISSelectInputSource(previous) };
    unsafe { CFRelease(previous) };
    state.record_host(format!(
        "ime self injection restored TIS source_id={} selected_source_id={} status={status}",
        selection.previous_id, selection.selected_id
    ));
    status == 0
}

fn cf_string(value: *const c_void) -> String {
    if value.is_null() {
        return String::new();
    }
    let mut buffer = [0 as c_char; 256];
    let ok = unsafe {
        CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            CF_STRING_ENCODING_UTF8,
        )
    };
    if !ok {
        return String::new();
    }
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

fn post_key(pid: i32, key_code: u16, flags: CGEventFlags, label: &str, state: &Arc<HostState>) {
    let Some(down) = CGEvent::new_keyboard_event(None, key_code, true) else {
        state.record_host(format!("self injection failed create key={label}"));
        return;
    };
    CGEvent::set_flags(Some(&down), flags);
    CGEvent::post_to_pid(pid, Some(&down));

    let Some(up) = CGEvent::new_keyboard_event(None, key_code, false) else {
        state.record_host(format!("self injection failed create keyup={label}"));
        return;
    };
    CGEvent::set_flags(Some(&up), flags);
    CGEvent::post_to_pid(pid, Some(&up));
    state.record_host(format!(
        "self injection posted source=CGEventPostToPid key={label} pid={pid}"
    ));
}

fn forward_native_key(app: &AppHandle<Wry>, child: Child, data: NativeKeyData) {
    let Some(webview) = app.get_webview(child.label()) else {
        eprintln!(
            "[F0.3] cannot forward native key: missing {}",
            child.label()
        );
        return;
    };

    let _ = webview.with_webview(move |platform| {
        let raw = platform.inner();
        if raw.is_null() {
            return;
        }

        let flags = NSEventModifierFlags::from_bits_retain(data.modifier_flags);
        let characters = if data.characters.is_empty() {
            NSString::from_str("q")
        } else {
            NSString::from_str(&data.characters)
        };
        let characters_ignoring_modifiers = if data.characters_ignoring_modifiers.is_empty() {
            NSString::from_str("q")
        } else {
            NSString::from_str(&data.characters_ignoring_modifiers)
        };
        let Some(native_event) = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            NSEventType::KeyDown,
            NSPoint::new(data.location_x, data.location_y),
            flags,
            data.timestamp,
            data.window_number,
            None,
            &characters,
            &characters_ignoring_modifiers,
            data.is_repeat,
            data.key_code,
        ) else {
            eprintln!("[F0.3] AppKit refused to create forwarded NSEvent");
            return;
        };

        // `inner()` is the WRY-owned WKWebView retained by the child. Calling
        // its inherited NSResponder method is the native delivery boundary.
        let responder: &NSResponder = unsafe { &*raw.cast::<NSResponder>() };
        responder.keyDown(&native_event);

    });
}
