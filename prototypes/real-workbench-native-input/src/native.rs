//! macOS AppKit/CoreGraphics adapter for the real Workbench gate.
//!
//! `CGEventPostToPid` is used only by the finite self smoke. The local monitor
//! consumes the first exact Command-Q and forwards the second by constructing
//! an AppKit `NSEvent` and calling the child WKWebView's native responder. No
//! browser event, JavaScript evaluation, or DOM dispatch occurs here.

#![cfg(target_os = "macos")]

use std::{
    ffi::{c_char, c_void, CStr},
    io::Write,
    process::{Command, Stdio},
    ptr::NonNull,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

use block2::RcBlock;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSResponder, NSView};
use objc2_core_graphics::{CGEvent, CGEventFlags};
use objc2_foundation::{NSPoint, NSString};
use tauri::{AppHandle, Wry};

use crate::{
    router::{self, Decision, KeyStroke},
    Child, HostState,
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

/// Install one application-local KeyDown monitor. AppKit owns the token for
/// this single-window finite harness; the monitor is intentionally process
/// lifetime-scoped so no callback can outlive the child during cleanup.
pub fn install_local_monitor(app: AppHandle<Wry>, child: Child, state: Arc<HostState>) {
    let callback_state = state.clone();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let event_ptr = event.as_ptr();
        let event = unsafe { event.as_ref() };
        let data = NativeKeyData::from_event(event);
        let stroke = data.stroke();
        let decision = {
            let mut router = callback_state.router.lock().unwrap();
            router.route(stroke, Instant::now())
        };

        match decision {
            Decision::PrefixArmed { deadline } => {
                callback_state.record_host(format!(
                    "prefix armed deadline_ms={} key_code={} workbench_received=false",
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis(),
                    data.key_code
                ));
                std::ptr::null_mut()
            }
            Decision::ForwardNativeQ => {
                callback_state.record_host(format!(
                    "forward native key equivalent key=q target=workbench source=AppKit_NSEvent synthetic_js=false workbench_forward_count=1"
                ));
                forward_native_key(&child, data, &callback_state);
                std::ptr::null_mut()
            }
            Decision::Pass { cleared_prefix } => {
                if stroke.command
                    && matches!(
                        data.key_code,
                        router::KEY_P
                            | router::KEY_S
                            | router::KEY_Z
                            | router::KEY_C
                            | router::KEY_V
                            | router::KEY_A
                    )
                {
                    callback_state.record_host(format!(
                        "native monitor pass key_code={} command=true characters={:?}",
                        data.key_code, data.characters
                    ));
                }
                if cleared_prefix {
                    callback_state.record_host(format!(
                        "prefix cleared and native event passed key_code={} command={} workbench_received=true",
                        data.key_code, stroke.command
                    ));
                }
                // Returning the original event preserves AppKit/WKWebView's
                // native shortcut and input-method path.
                event_ptr
            }
        }
    });

    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    if monitor.is_none() {
        state.record_host("ERROR local NSEvent monitor installation failed".to_string());
    } else {
        state.record_host("local NSEvent monitor installed mask=KeyDown".to_string());
    }
    std::mem::forget(monitor);
    let _ = app;
}

/// Make the child NSView the key window's first responder using AppKit only.
pub fn focus_child(app: &AppHandle<Wry>, child: &Child) {
    let Some(webview) = child.lock().unwrap().as_ref().cloned() else {
        return;
    };
    let _ = webview.set_focus();
    let _ = webview.with_webview(|platform| {
        let raw = platform.inner();
        if raw.is_null() {
            return;
        }
        let view: &NSView = unsafe { &*raw.cast::<NSView>() };
        if let Some(window) = view.window() {
            window.makeKeyAndOrderFront(None);
            let responder: &NSResponder = unsafe { &*raw.cast::<NSResponder>() };
            let _ = window.makeFirstResponder(Some(responder));
        }
    });
    let _ = app;
}

/// Run ordinary Workbench shortcut events, then the exact double-Q prefix.
/// This function is finite and owns no background listener or JS observer.
pub fn start_self_injection(app: AppHandle<Wry>, child: Child, state: Arc<HostState>) {
    let focus_app = app.clone();
    let focus_child_ref = child.clone();
    let focus_state = state.clone();
    let _ = app.run_on_main_thread(move || {
        focus_child(&focus_app, &focus_child_ref);
        focus_state.record_host(
            "self injection focused child=workbench via AppKit NSWindow/NSView".to_string(),
        );
    });

    let refocus_scheduler = app.clone();
    let refocus_app = app.clone();
    let refocus_child = child.clone();
    thread::spawn(move || {
        let pid = std::process::id() as _;
        thread::sleep(Duration::from_millis(3_500));

        post_key(
            pid,
            router::KEY_P,
            CGEventFlags::MaskCommand,
            "cmd-p",
            &state,
        );
        thread::sleep(Duration::from_millis(250));
        state.record_host("checkpoint=cmd-p-ui-open screenshot_required=true".to_string());
        thread::sleep(Duration::from_millis(850));

        post_key(
            pid,
            router::KEY_P,
            CGEventFlags::MaskCommand | CGEventFlags::MaskShift,
            "cmd-shift-p",
            &state,
        );
        thread::sleep(Duration::from_millis(250));
        state.record_host("checkpoint=cmd-shift-p-ui-open screenshot_required=true".to_string());
        thread::sleep(Duration::from_millis(850));
        post_key(
            pid,
            router::KEY_ESCAPE,
            CGEventFlags::empty(),
            "escape-close-palette",
            &state,
        );
        thread::sleep(Duration::from_millis(350));

        // The two palettes are real Workbench UI and may leave focus on their
        // native input field after Escape. Re-establish the child NSView as
        // first responder before exercising Monaco's ordinary edit commands.
        let refocus_state = state.clone();
        let _ = refocus_scheduler.run_on_main_thread(move || {
            focus_child(&refocus_app, &refocus_child);
            refocus_state.record_host(
                "self injection refocused child=workbench before editor shortcuts".to_string(),
            );
        });
        thread::sleep(Duration::from_millis(300));

        // The extension selects the fixture through vscode.TextEditor. Cmd-A
        // repeats that selection on Monaco's native editor path immediately
        // before Cmd-C, so the clipboard assertion has no focus ambiguity.
        post_key(
            pid,
            router::KEY_A,
            CGEventFlags::MaskCommand,
            "cmd-a",
            &state,
        );
        thread::sleep(Duration::from_millis(250));

        // The Bridge extension selected the entire fixture document through
        // the public vscode API. Cmd-C must reach Monaco and the clipboard is
        // checked outside the DOM boundary.
        post_key(
            pid,
            router::KEY_C,
            CGEventFlags::MaskCommand,
            "cmd-c",
            &state,
        );
        thread::sleep(Duration::from_millis(350));
        record_clipboard(&state, "after-cmd-c");
        state.record_host("checkpoint=after-cmd-c-public-editor-state".to_string());

        let paste = "native-paste\n";
        if !set_clipboard(paste) {
            state.record_host("clipboard set failed before cmd-v".to_string());
        }
        post_key(
            pid,
            router::KEY_V,
            CGEventFlags::MaskCommand,
            "cmd-v",
            &state,
        );
        thread::sleep(Duration::from_millis(750));
        state.record_host("checkpoint=after-cmd-v-public-editor-state".to_string());

        post_key(
            pid,
            router::KEY_Z,
            CGEventFlags::MaskCommand,
            "cmd-z",
            &state,
        );
        thread::sleep(Duration::from_millis(750));
        state.record_host("checkpoint=after-cmd-z-public-editor-state".to_string());

        if !set_clipboard(paste) {
            state.record_host("clipboard set failed before second cmd-v".to_string());
        }
        post_key(
            pid,
            router::KEY_V,
            CGEventFlags::MaskCommand,
            "cmd-v-again",
            &state,
        );
        thread::sleep(Duration::from_millis(750));
        post_key(
            pid,
            router::KEY_S,
            CGEventFlags::MaskCommand,
            "cmd-s",
            &state,
        );
        thread::sleep(Duration::from_millis(900));
        state.record_host("checkpoint=after-cmd-s-public-save-state".to_string());

        // First Q is consumed by this process and explicitly marked as not
        // delivered. Only the second Q constructs a native child event.
        post_key(
            pid,
            router::KEY_Q,
            CGEventFlags::MaskCommand,
            "double-q-first",
            &state,
        );
        thread::sleep(Duration::from_millis(180));
        post_key(
            pid,
            router::KEY_Q,
            CGEventFlags::MaskCommand,
            "double-q-second-forward",
            &state,
        );
        thread::sleep(Duration::from_millis(1_000));
        state.record_host(
            "self injection complete source=CGEventPostToPid target=real-openvscode-workbench"
                .to_string(),
        );
    });
}

/// Select Japanese Hiragana through TIS on the AppKit main thread, send roman
/// key events through the native input path, and restore the exact previous
/// source before reporting completion.
pub fn start_ime_self_injection(app: AppHandle<Wry>, child: Child, state: Arc<HostState>) {
    let focus_app = app.clone();
    let focus_child_ref = child.clone();
    let focus_state = state.clone();
    let _ = app.run_on_main_thread(move || {
        focus_child(&focus_app, &focus_child_ref);
        focus_state.record_host(
            "ime self injection focused child=workbench via AppKit NSWindow/NSView".to_string(),
        );
    });

    let (select_tx, select_rx) = mpsc::channel();
    let select_state = state.clone();
    let select_scheduled = app
        .run_on_main_thread(move || {
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
                "ime self injection BLOCKED TIS main-thread handoff failed".to_string(),
            );
            return;
        }
        let selection = match select_rx.recv_timeout(Duration::from_secs(5)) {
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

        thread::sleep(Duration::from_millis(3_000));
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
            thread::sleep(Duration::from_millis(110));
        }
        post_key(
            std::process::id() as _,
            36,
            CGEventFlags::empty(),
            "ime-commit-return",
            &state,
        );
        thread::sleep(Duration::from_millis(1_000));

        let (restore_tx, restore_rx) = mpsc::channel();
        let restore_state = state.clone();
        let restore_scheduled = worker_app
            .run_on_main_thread(move || {
                let restored = restore_tis_on_main(selection, &restore_state);
                let _ = restore_tx.send(restored);
            })
            .is_ok();
        if !restore_scheduled
            || !restore_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or(false)
        {
            state.record_host(
                "ime self injection BLOCKED previous TIS source restore failed".to_string(),
            );
            return;
        }
        state.record_host("ime self injection complete composition=nihongo source_restored=true target=real-openvscode-workbench".to_string());
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
        let id = cf_string(unsafe { TISGetInputSourceProperty(source, property_key) });
        let rank = if id.contains("Hiragana") {
            Some(0)
        } else if id.contains("Kotoeri") {
            Some(1)
        } else if id.contains("Japanese") && !id.contains("FullWidthRoman") {
            Some(2)
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
        let status = unsafe { TISSelectInputSource(target) };
        if status == 0 {
            selected = Some(selected_id);
            break;
        }
        state.record_host(format!(
            "ime self injection TIS candidate rejected source_id={selected_id} status={status}"
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
    let current = unsafe { TISCopyCurrentKeyboardInputSource() };
    let current_id =
        cf_string(unsafe { TISGetInputSourceProperty(current, kTISPropertyInputSourceID) });
    if !current.is_null() {
        unsafe { CFRelease(current) };
    }
    unsafe { CFRelease(previous) };
    let restored = status == 0 && current_id == selection.previous_id;
    state.record_host(format!(
        "ime self injection restored TIS source_id={} selected_source_id={} current_source_id={} status={status} restored_match={restored}",
        selection.previous_id, selection.selected_id, current_id
    ));
    restored
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

fn forward_native_key(child: &Child, data: NativeKeyData, state: &Arc<HostState>) {
    let Some(webview) = child.lock().unwrap().as_ref().cloned() else {
        state.record_host("ERROR native Q target child missing".to_string());
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
            return;
        };
        let responder: &NSResponder = unsafe { &*raw.cast::<NSResponder>() };
        responder.keyDown(&native_event);
    });
}

fn set_clipboard(value: &str) -> bool {
    let Ok(mut child) = Command::new("pbcopy").stdin(Stdio::piped()).spawn() else {
        return false;
    };
    let Some(mut stdin) = child.stdin.take() else {
        return false;
    };
    if stdin.write_all(value.as_bytes()).is_err() {
        return false;
    }
    drop(stdin);
    child.wait().map(|status| status.success()).unwrap_or(false)
}

fn record_clipboard(state: &Arc<HostState>, label: &str) {
    let output = Command::new("pbpaste").output();
    let hex = output
        .ok()
        .filter(|result| result.status.success())
        .map(|result| {
            result
                .stdout
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        })
        .unwrap_or_default();
    state.record_host(format!("clipboard label={label} utf8_hex={hex}"));
}
