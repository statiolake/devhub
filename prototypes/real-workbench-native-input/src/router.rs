//! AppKit-independent exact Command-Q prefix state machine.
//!
//! The adapter deliberately keeps every ordinary key on AppKit's native path.
//! Only an exact, unmodified Command-Q is withheld for the host prefix.

#![allow(dead_code)]

use std::time::{Duration, Instant};

pub const PREFIX_TIMEOUT: Duration = Duration::from_millis(1_000);

// macOS virtual key codes used by the native adapter.
pub const KEY_Q: u16 = 12;
pub const KEY_W: u16 = 13;
pub const KEY_P: u16 = 35;
pub const KEY_S: u16 = 1;
pub const KEY_Z: u16 = 6;
pub const KEY_A: u16 = 0;
pub const KEY_C: u16 = 8;
pub const KEY_V: u16 = 9;
pub const KEY_ESCAPE: u16 = 53;

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

    pub const fn plain(key_code: u16) -> Self {
        Self {
            key_code,
            command: false,
            shift: false,
            option: false,
            control: false,
        }
    }

    fn exact_command_q(self) -> bool {
        self.key_code == KEY_Q && self.command && !self.shift && !self.option && !self.control
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    PrefixArmed { deadline: Instant },
    ForwardNativeQ,
    Pass { cleared_prefix: bool },
}

#[derive(Debug)]
pub struct KeyRouter {
    armed_until: Option<Instant>,
}

impl KeyRouter {
    pub const fn new() -> Self {
        Self { armed_until: None }
    }

    pub fn is_armed_at(&self, now: Instant) -> bool {
        self.armed_until.is_some_and(|deadline| now <= deadline)
    }

    pub fn route(&mut self, stroke: KeyStroke, now: Instant) -> Decision {
        if let Some(deadline) = self.armed_until.take() {
            if stroke.exact_command_q() && now <= deadline {
                return Decision::ForwardNativeQ;
            }
            if now <= deadline {
                return Decision::Pass {
                    cleared_prefix: true,
                };
            }
        }

        if stroke.exact_command_q() {
            let deadline = now + PREFIX_TIMEOUT;
            self.armed_until = Some(deadline);
            return Decision::PrefixArmed { deadline };
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
    fn first_q_is_withheld_and_second_q_at_deadline_forwards() {
        let start = Instant::now();
        let mut router = KeyRouter::new();
        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), start),
            Decision::PrefixArmed { deadline } if deadline == start + PREFIX_TIMEOUT
        ));
        assert!(matches!(
            router.route(KeyStroke::command(KEY_Q), start + PREFIX_TIMEOUT),
            Decision::ForwardNativeQ
        ));
        assert!(!router.is_armed_at(start + PREFIX_TIMEOUT));
    }

    #[test]
    fn q_after_timeout_starts_a_fresh_prefix() {
        let start = Instant::now();
        let mut router = KeyRouter::new();
        let _ = router.route(KeyStroke::command(KEY_Q), start);
        assert!(matches!(
            router.route(
                KeyStroke::command(KEY_Q),
                start + PREFIX_TIMEOUT + Duration::from_nanos(1)
            ),
            Decision::PrefixArmed { .. }
        ));
    }

    #[test]
    fn ordinary_command_key_clears_prefix_but_passes() {
        let start = Instant::now();
        let mut router = KeyRouter::new();
        let _ = router.route(KeyStroke::command(KEY_Q), start);
        assert_eq!(
            router.route(KeyStroke::command(KEY_P), start + Duration::from_millis(1)),
            Decision::Pass {
                cleared_prefix: true,
            }
        );
    }

    #[test]
    fn modified_q_is_not_reserved() {
        let mut router = KeyRouter::new();
        assert_eq!(
            router.route(
                KeyStroke {
                    key_code: KEY_Q,
                    command: true,
                    shift: true,
                    option: false,
                    control: false,
                },
                Instant::now(),
            ),
            Decision::Pass {
                cleared_prefix: false,
            }
        );
    }
}
