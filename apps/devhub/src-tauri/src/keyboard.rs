//! Native macOS keyboard routing for the DevHub workbench.
//!
//! The state machine is platform independent and deliberately has no UI or
//! provider dependencies. The macOS adapter is only responsible for turning
//! an AppKit key-down into a scalar [`KeyStroke`] and returning either the
//! original event or no event. In particular, the forwarding path never
//! creates a DOM event or evaluates JavaScript.

use std::time::{Duration, Instant};

use devhub_app_core::SurfaceKey;

/// The product contract is an exact one-second prefix interval.
pub const PREFIX_TIMEOUT: Duration = Duration::from_millis(1_000);

pub const KEY_Q: u16 = 12;
#[cfg(test)]
pub const KEY_W: u16 = 13;
#[cfg(test)]
pub const KEY_M: u16 = 46;
#[cfg(test)]
pub const KEY_H: u16 = 4;
pub const KEY_COMMA: u16 = 43;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyStroke {
    pub key_code: u16,
    pub command: bool,
    pub shift: bool,
    pub option: bool,
    pub control: bool,
    pub is_repeat: bool,
}

impl KeyStroke {
    #[cfg(test)]
    pub const fn command(key_code: u16) -> Self {
        Self {
            key_code,
            command: true,
            shift: false,
            option: false,
            control: false,
            is_repeat: false,
        }
    }

    #[cfg(test)]
    pub const fn plain(key_code: u16) -> Self {
        Self {
            key_code,
            command: false,
            shift: false,
            option: false,
            control: false,
            is_repeat: false,
        }
    }

    fn exact_command(self, key_code: u16) -> bool {
        self.key_code == key_code && self.command && !self.shift && !self.option && !self.control
    }

    fn exact_command_q(self) -> bool {
        self.exact_command(KEY_Q)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostCommand {
    OpenSettings,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouteDecision {
    /// Consume an event that must never reach a Surface (for example a native
    /// autorepeat of Command-Q).
    Consume,
    /// Consume the first exact Command-Q and arm the one-second prefix.
    PrefixArmed { deadline: Instant },
    /// Return the same native event to AppKit. The native surface then handles
    /// it through its normal responder chain exactly once.
    ForwardNativeQ { target: SurfaceKey, focus: SurfaceFocus },
    /// A command owned by the DevHub host, currently only Settings.
    Route(HostCommand),
    /// Preserve the original event, including IME and ordinary shortcuts.
    Pass { cleared_prefix: bool },
}

/// A semantic SurfaceKey bound to its transient native responder and
/// lifecycle generation. The native pointer never crosses the product wire.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SurfaceFocus {
    pub semantic: SurfaceKey,
    /// Root WRY WKWebView responder. An event's first responder may be an
    /// internal WebKit input view; the native adapter proves ancestry rather
    /// than requiring pointer equality with this root.
    pub native_id: usize,
    pub window_identity: usize,
    pub window_number: isize,
    pub generation: u64,
}

impl SurfaceFocus {
    /// Accept an AppKit event only when it belongs to this exact native
    /// responder and lifecycle generation. The semantic key remains part of
    /// the binding so a shared App Shell view can route Agent/Terminal
    /// activities without pretending they have distinct native views.
    pub fn matches_native(
        &self,
        responder_belongs_to_surface: bool,
        window_identity: usize,
        window_number: isize,
        generation: u64,
    ) -> bool {
        self.native_id != 0
            && self.window_identity != 0
            && responder_belongs_to_surface
            && self.window_identity == window_identity
            && self.window_number == window_number
            && self.generation == generation
    }
}

#[derive(Debug, Default)]
pub struct KeyRouter {
    active_focus: Option<SurfaceFocus>,
    armed_until: Option<Instant>,
}

impl KeyRouter {
    #[cfg(test)]
    pub fn new() -> Self {
        Self::default()
    }

    /// A surface or native lifecycle generation change invalidates an armed
    /// prefix. This prevents a late second key from reaching a reconstructed
    /// Window or a different Editor/Agent/Terminal surface.
    pub fn set_active_focus(&mut self, focus: Option<SurfaceFocus>) {
        if self.active_focus != focus {
            self.active_focus = focus;
            self.armed_until = None;
        }
    }

    #[cfg(test)]
    pub fn is_armed_at(&self, now: Instant) -> bool {
        self.armed_until.is_some_and(|deadline| now <= deadline)
    }

    pub fn route(&mut self, stroke: KeyStroke, now: Instant) -> RouteDecision {
        // IME composition remains AppKit/WebKit-owned. This router only
        // consumes the exact native Command-Q prefix (or Command-comma for
        // Settings); every non-command key event, including composition and
        // marked-text commits, is returned to the original responder. It
        // never synthesizes a key event or inspects text input.
        if stroke.is_repeat && stroke.exact_command_q() {
            self.armed_until = None;
            return RouteDecision::Consume;
        }
        if let Some(deadline) = self.armed_until.take() {
            if stroke.exact_command_q() && now <= deadline {
                if let Some(focus) = self.active_focus.clone() {
                    return RouteDecision::ForwardNativeQ { target: focus.semantic.clone(), focus };
                }
                // A second prefix without an established native focus must
                // not leak Command-Q to an arbitrary first responder.
                return RouteDecision::Consume;
            }

            if now <= deadline && stroke.exact_command(KEY_COMMA) {
                return RouteDecision::Route(HostCommand::OpenSettings);
            }
            // Any other second key clears the prefix and continues through
            // AppKit. This is what preserves Command-W/M/H and IME behavior.
            if now <= deadline {
                return RouteDecision::Pass { cleared_prefix: true };
            }
        }

        if stroke.exact_command_q() {
            let deadline = now + PREFIX_TIMEOUT;
            self.armed_until = Some(deadline);
            return RouteDecision::PrefixArmed { deadline };
        }
        if stroke.exact_command(KEY_COMMA) {
            return RouteDecision::Route(HostCommand::OpenSettings);
        }
        RouteDecision::Pass { cleared_prefix: false }
    }
}

/// Process-owned wrapper around the pure router and one local AppKit monitor.
/// The monitor is installed once and lives until the process exits; lifecycle
/// and surface generation are refreshed for every event by the App Shell.
#[derive(Debug, Default)]
pub(crate) struct KeyboardController {
    router: std::sync::Mutex<KeyRouter>,
    installed: std::sync::atomic::AtomicBool,
}

impl KeyboardController {
    pub(crate) fn route(
        &self,
        focus: Option<SurfaceFocus>,
        stroke: KeyStroke,
        now: Instant,
    ) -> RouteDecision {
        let Ok(mut router) = self.router.lock() else {
            return RouteDecision::Pass { cleared_prefix: true };
        };
        router.set_active_focus(focus);
        router.route(stroke, now)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn install<F>(&self, handler: F) -> Result<(), &'static str>
    where
        F: Fn(wry::NativeKeyEvent) -> wry::NativeKeyEventResult + Send + Sync + 'static,
    {
        if self.installed.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Ok(());
        }
        if wry::install_local_key_monitor(handler) {
            Ok(())
        } else {
            self.installed.store(false, std::sync::atomic::Ordering::Release);
            Err("AppKit local keyboard monitor could not be installed")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_q_is_withheld_and_second_q_at_exact_boundary_forwards_once() {
        let start = Instant::now();
        let target = SurfaceKey::GlobalEditor;
        let focus = SurfaceFocus {
            semantic: target.clone(),
            native_id: 10,
            window_identity: 30,
            window_number: 7,
            generation: 7,
        };
        let mut router = KeyRouter::new();
        router.set_active_focus(Some(focus.clone()));
        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), start),
            RouteDecision::PrefixArmed { deadline } if deadline == start + PREFIX_TIMEOUT
        ));
        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), start + PREFIX_TIMEOUT),
            RouteDecision::ForwardNativeQ { target: actual, focus: actual_focus }
                if actual == target && actual_focus == focus
        ));
        assert_eq!(
            router.route(KeyStroke::command(KEY_Q), start + PREFIX_TIMEOUT),
            RouteDecision::PrefixArmed { deadline: start + PREFIX_TIMEOUT + PREFIX_TIMEOUT }
        );
    }

    #[test]
    fn q_after_timeout_starts_a_new_prefix() {
        let start = Instant::now();
        let mut router = KeyRouter::new();
        router.set_active_focus(Some(SurfaceFocus {
            semantic: SurfaceKey::GlobalEditor,
            native_id: 10,
            window_identity: 30,
            window_number: 7,
            generation: 1,
        }));
        let _ = router.route(KeyStroke::command(KEY_Q), start);
        assert!(matches!(
            router
                .route(KeyStroke::command(KEY_Q), start + PREFIX_TIMEOUT + Duration::from_nanos(1)),
            RouteDecision::PrefixArmed { .. }
        ));
    }

    #[test]
    fn unmapped_second_key_clears_but_passes_through() {
        let start = Instant::now();
        let mut router = KeyRouter::new();
        router.set_active_focus(Some(SurfaceFocus {
            semantic: SurfaceKey::GlobalEditor,
            native_id: 10,
            window_identity: 30,
            window_number: 7,
            generation: 1,
        }));
        let _ = router.route(KeyStroke::command(KEY_Q), start);
        assert_eq!(
            router.route(KeyStroke::command(KEY_W), start + Duration::from_millis(1)),
            RouteDecision::Pass { cleared_prefix: true }
        );
        assert!(!router.is_armed_at(start + Duration::from_millis(1)));
    }

    #[test]
    fn settings_is_host_routed_and_standard_mac_commands_pass() {
        let now = Instant::now();
        let mut router = KeyRouter::new();
        router.set_active_focus(Some(SurfaceFocus {
            semantic: SurfaceKey::GlobalTerminal,
            native_id: 20,
            window_identity: 30,
            window_number: 7,
            generation: 1,
        }));
        assert_eq!(
            router.route(KeyStroke::command(KEY_COMMA), now),
            RouteDecision::Route(HostCommand::OpenSettings)
        );
        for key in [KEY_W, KEY_M, KEY_H] {
            assert_eq!(
                router.route(KeyStroke::command(key), now),
                RouteDecision::Pass { cleared_prefix: false }
            );
        }
    }

    #[test]
    fn changing_surface_or_generation_clears_stale_prefix() {
        let now = Instant::now();
        let mut router = KeyRouter::new();
        router.set_active_focus(Some(SurfaceFocus {
            semantic: SurfaceKey::GlobalEditor,
            native_id: 10,
            window_identity: 30,
            window_number: 7,
            generation: 1,
        }));
        let _ = router.route(KeyStroke::command(KEY_Q), now);
        router.set_active_focus(Some(SurfaceFocus {
            semantic: SurfaceKey::GlobalTerminal,
            native_id: 20,
            window_identity: 30,
            window_number: 7,
            generation: 1,
        }));
        assert_eq!(
            router.route(KeyStroke::command(KEY_Q), now + Duration::from_millis(2)),
            RouteDecision::PrefixArmed {
                deadline: now + Duration::from_millis(2) + PREFIX_TIMEOUT
            }
        );
        router.set_active_focus(Some(SurfaceFocus {
            semantic: SurfaceKey::GlobalTerminal,
            native_id: 20,
            window_identity: 30,
            window_number: 7,
            generation: 2,
        }));
        assert!(!router.is_armed_at(now + Duration::from_millis(2)));
    }

    #[test]
    fn ordinary_text_and_ime_paths_are_never_host_commands() {
        let mut router = KeyRouter::new();
        router.set_active_focus(Some(SurfaceFocus {
            semantic: SurfaceKey::GlobalEditor,
            native_id: 10,
            window_identity: 30,
            window_number: 7,
            generation: 1,
        }));
        assert_eq!(
            router.route(KeyStroke::plain(0), Instant::now()),
            RouteDecision::Pass { cleared_prefix: false }
        );
        assert_eq!(
            router.route(
                KeyStroke {
                    key_code: KEY_Q,
                    command: true,
                    shift: true,
                    option: false,
                    control: false,
                    is_repeat: false
                },
                Instant::now()
            ),
            RouteDecision::Pass { cleared_prefix: false }
        );
    }

    #[test]
    fn repeat_q_never_forwards_and_clears_the_prefix() {
        let now = Instant::now();
        let mut router = KeyRouter::new();
        router.set_active_focus(Some(SurfaceFocus {
            semantic: SurfaceKey::GlobalEditor,
            native_id: 10,
            window_identity: 30,
            window_number: 7,
            generation: 1,
        }));
        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), now),
            RouteDecision::PrefixArmed { .. }
        ));
        let repeat = KeyStroke { is_repeat: true, ..KeyStroke::command(KEY_Q) };
        assert_eq!(router.route(repeat, now + Duration::from_millis(10)), RouteDecision::Consume);
        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), now + Duration::from_millis(11)),
            RouteDecision::PrefixArmed { .. }
        ));
    }

    #[test]
    fn native_focus_binding_rejects_wrong_responder_or_generation() {
        let raw_editor = SurfaceFocus {
            semantic: SurfaceKey::GlobalEditor,
            native_id: 101,
            window_identity: 303,
            window_number: 8,
            generation: 4,
        };
        assert!(raw_editor.matches_native(true, 303, 8, 4));
        assert!(!raw_editor.matches_native(false, 303, 8, 4));
        assert!(!raw_editor.matches_native(true, 404, 8, 4));
        assert!(!raw_editor.matches_native(true, 303, 9, 4));
        assert!(!raw_editor.matches_native(true, 303, 8, 5));

        // Agent and terminal activities intentionally share the app-shell
        // responder while retaining distinct semantic destinations.
        let app_shell_agent = SurfaceFocus {
            semantic: SurfaceKey::Agent(
                devhub_app_core::AgentId::from_uuid("00000000-0000-0000-0000-000000000001")
                    .expect("valid test AgentId"),
            ),
            native_id: 202,
            window_identity: 505,
            window_number: 11,
            generation: 4,
        };
        let app_shell_terminal = SurfaceFocus {
            semantic: SurfaceKey::GlobalTerminal,
            native_id: 202,
            window_identity: 505,
            window_number: 11,
            generation: 4,
        };
        assert!(app_shell_agent.matches_native(true, 505, 11, 4));
        assert!(app_shell_terminal.matches_native(true, 505, 11, 4));
        assert_ne!(app_shell_agent.semantic, app_shell_terminal.semantic);
    }

    #[test]
    fn native_adapter_returns_original_event_and_never_constructs_js_events() {
        let source = include_str!("../vendor/wry/src/wkwebview/mod.rs");
        assert!(source.contains("NativeKeyEventResult::Forward | NativeKeyEventResult::Pass"));
        assert!(source.contains("event.as_ptr()"));
        assert!(source.contains("is_repeat: event_ref.isARepeat()"));
        assert!(source.contains("responder_ancestry"));
        assert!(source.contains("superview()"));
        assert!(source.contains("window_identity"));
        assert!(source.contains("window_number: event_ref.windowNumber()"));
        assert!(!source.contains("KeyboardEvent"));
        assert!(!source.contains("keyEventWithType"));
    }
}
