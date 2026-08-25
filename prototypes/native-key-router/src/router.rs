//! The host-only keyboard state machine.
//!
//! This module has no AppKit or WebView dependency so the prefix contract can be
//! tested at exact deadline boundaries on every host. The macOS event monitor is
//! only an adapter around this state machine.

#![allow(dead_code)]

use std::time::{Duration, Instant};

/// The product contract is an exact one-second prefix window.
pub const PREFIX_TIMEOUT: Duration = Duration::from_millis(1_000);

// macOS virtual key codes used by the host adapter and tests.
pub const KEY_Q: u16 = 12;
pub const KEY_W: u16 = 13;
pub const KEY_P: u16 = 35;
pub const KEY_S: u16 = 1;
pub const KEY_Z: u16 = 6;
pub const KEY_C: u16 = 8;
pub const KEY_V: u16 = 9;
pub const KEY_M: u16 = 46;
pub const KEY_H: u16 = 4;
pub const KEY_COMMA: u16 = 43;
pub const KEY_1: u16 = 18;
pub const KEY_2: u16 = 19;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Child {
    A,
    B,
}

impl Child {
    pub const fn label(self) -> &'static str {
        match self {
            Self::A => "child-a",
            Self::B => "child-b",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyStroke {
    pub key_code: u16,
    pub command: bool,
    pub shift: bool,
    pub option: bool,
    pub control: bool,
}

impl KeyStroke {
    pub const fn command(key_code: u16) -> Self {
        Self {
            key_code,
            command: true,
            shift: false,
            option: false,
            control: false,
        }
    }

    pub const fn command_shift(key_code: u16) -> Self {
        Self {
            key_code,
            command: true,
            shift: true,
            option: false,
            control: false,
        }
    }

    pub const fn plain(key_code: u16) -> Self {
        Self {
            key_code,
            command: false,
            shift: false,
            option: false,
            control: false,
        }
    }

    fn command_without_extra_modifiers(self) -> bool {
        self.command && !self.option && !self.control && !self.shift
    }

    fn exact_command_q(self) -> bool {
        self.key_code == KEY_Q && self.command_without_extra_modifiers()
    }

    /// Commands owned by the host even while the Q prefix is armed.
    fn host_command(self) -> Option<HostCommand> {
        if !self.command_without_extra_modifiers() {
            return None;
        }

        match self.key_code {
            KEY_1 => Some(HostCommand::Focus(Child::A)),
            KEY_2 => Some(HostCommand::Focus(Child::B)),
            KEY_COMMA => Some(HostCommand::Settings),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostCommand {
    Focus(Child),
    Settings,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    /// The first exact Command-Q is consumed by the host and arms the prefix.
    PrefixArmed { deadline: Instant },
    /// The second exact Command-Q must be sent as one native event to this child.
    ForwardNativeQ { target: Child },
    /// A defined host command is consumed and routed by the host.
    Route(HostCommand),
    /// The event is allowed to continue through AppKit/WKWebView.
    Pass { cleared_prefix: bool },
}

#[derive(Debug)]
pub struct KeyRouter {
    active_child: Child,
    armed_until: Option<Instant>,
}

impl KeyRouter {
    pub const fn new(active_child: Child) -> Self {
        Self {
            active_child,
            armed_until: None,
        }
    }

    pub const fn active_child(&self) -> Child {
        self.active_child
    }

    pub fn is_armed_at(&self, now: Instant) -> bool {
        self.armed_until.is_some_and(|deadline| now <= deadline)
    }

    pub fn focus(&mut self, child: Child) {
        self.active_child = child;
        // A focus transition starts a new routing context. A stale Q prefix may
        // never forward to a child that is no longer active.
        self.armed_until = None;
    }

    pub fn route(&mut self, stroke: KeyStroke, now: Instant) -> Decision {
        if let Some(deadline) = self.armed_until.take() {
            if stroke.exact_command_q() && now <= deadline {
                return Decision::ForwardNativeQ {
                    target: self.active_child,
                };
            }

            if now <= deadline {
                if let Some(command) = stroke.host_command() {
                    return Decision::Route(command);
                }

                // An unmapped second key (including a normal Workbench
                // shortcut, text input, or Command+M/H) clears the prefix but
                // is not stolen. Returning Pass lets AppKit retain its normal
                // behavior.
                return Decision::Pass {
                    cleared_prefix: true,
                };
            }
            // A timed-out Q is a fresh first press; other timed-out events are
            // handled by the ordinary no-prefix path below.
        }

        if stroke.exact_command_q() {
            let deadline = now + PREFIX_TIMEOUT;
            self.armed_until = Some(deadline);
            return Decision::PrefixArmed { deadline };
        }

        if let Some(command) = stroke.host_command() {
            return Decision::Route(command);
        }

        Decision::Pass {
            cleared_prefix: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_q_is_withheld_and_second_q_at_exact_deadline_forwards() {
        let start = Instant::now();
        let mut router = KeyRouter::new(Child::A);

        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), start),
            Decision::PrefixArmed { deadline } if deadline == start + PREFIX_TIMEOUT
        ));
        assert!(router.is_armed_at(start + Duration::from_millis(999)));
        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), start + PREFIX_TIMEOUT),
            Decision::ForwardNativeQ { target: Child::A }
        ));
        assert!(!router.is_armed_at(start + PREFIX_TIMEOUT));
    }

    #[test]
    fn q_after_timeout_starts_a_new_prefix_instead_of_forwarding() {
        let start = Instant::now();
        let mut router = KeyRouter::new(Child::A);
        let _ = router.route(KeyStroke::command(KEY_Q), start);

        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), start + PREFIX_TIMEOUT + Duration::from_nanos(1)),
            Decision::PrefixArmed { deadline } if deadline == start + PREFIX_TIMEOUT + Duration::from_nanos(1) + PREFIX_TIMEOUT
        ));
    }

    #[test]
    fn unknown_second_key_clears_prefix_but_passes_through() {
        let start = Instant::now();
        let mut router = KeyRouter::new(Child::A);
        let _ = router.route(KeyStroke::command(KEY_Q), start);

        assert_eq!(
            router.route(KeyStroke::command(40), start + Duration::from_millis(20)),
            Decision::Pass {
                cleared_prefix: true
            }
        );
        assert!(!router.is_armed_at(start + Duration::from_millis(20)));
    }

    #[test]
    fn defined_host_commands_route_while_prefix_is_armed() {
        let start = Instant::now();
        let mut router = KeyRouter::new(Child::A);
        let _ = router.route(KeyStroke::command(KEY_Q), start);

        assert_eq!(
            router.route(KeyStroke::command(KEY_2), start + Duration::from_millis(20)),
            Decision::Route(HostCommand::Focus(Child::B))
        );
        router.focus(Child::B);
        assert_eq!(router.active_child(), Child::B);
        assert_eq!(
            router.route(
                KeyStroke::command(KEY_COMMA),
                start + Duration::from_millis(30)
            ),
            Decision::Route(HostCommand::Settings)
        );
    }

    #[test]
    fn focus_clears_stale_prefix_and_forwarding_targets_new_child() {
        let start = Instant::now();
        let mut router = KeyRouter::new(Child::A);
        let _ = router.route(KeyStroke::command(KEY_Q), start);
        router.focus(Child::B);

        assert!(!router.is_armed_at(start + Duration::from_millis(10)));
        let _ = router.route(KeyStroke::command(KEY_Q), start + Duration::from_millis(10));
        assert_eq!(
            router.route(KeyStroke::command(KEY_Q), start + Duration::from_millis(11)),
            Decision::ForwardNativeQ { target: Child::B }
        );
    }

    #[test]
    fn ordinary_command_shortcuts_and_mac_os_commands_pass_through() {
        let start = Instant::now();
        for stroke in [
            KeyStroke::command(KEY_P),
            KeyStroke::command_shift(KEY_P),
            KeyStroke::command(KEY_S),
            KeyStroke::command(KEY_Z),
            KeyStroke::command(KEY_C),
            KeyStroke::command(KEY_V),
            KeyStroke::command(KEY_W),
            KeyStroke::command(KEY_M),
            KeyStroke::command(KEY_H),
        ] {
            let mut router = KeyRouter::new(Child::A);
            assert_eq!(
                router.route(stroke, start),
                Decision::Pass {
                    cleared_prefix: false
                }
            );
        }
    }

    #[test]
    fn ordinary_shortcut_after_prefix_clears_but_is_not_stolen() {
        let start = Instant::now();
        let mut router = KeyRouter::new(Child::A);
        let _ = router.route(KeyStroke::command(KEY_Q), start);

        assert_eq!(
            router.route(KeyStroke::command(KEY_P), start + Duration::from_millis(1)),
            Decision::Pass {
                cleared_prefix: true
            }
        );
    }
}
