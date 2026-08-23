//! Small, provider-free lifecycle primitives used by the native shell.
//!
//! [`LifecycleGate`] is the single ownership seam for the one main Window.
//! It makes close/reopen/quit idempotent and prevents a late `Destroyed` event
//! from closing a newly reconstructed window.  Frame restoration is kept pure
//! so the native adapter can apply it to whatever displays exist at launch.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use devhub_app_core::state::WindowFrame;

const CLOSE_WAIT: Duration = Duration::from_secs(5);
const MIN_VISIBLE_PIXELS: i32 = 64;
const MIN_WINDOW_WIDTH: u32 = 640;
const MIN_WINDOW_HEIGHT: u32 = 420;

/// Process/window lifecycle phase. A closed Window is not a stopped process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Open,
    Closing,
    Closed,
    Quitting,
    Quit,
}

/// Serialized lifecycle transition gate.
///
/// The gate deliberately has no provider knowledge. Callers acquire a
/// transition, perform bounded adapter work, then complete it. A second close
/// or quit becomes a no-op, while a Dock reopen is accepted only after the
/// prior close has committed.
#[derive(Debug, Default)]
pub struct LifecycleGate {
    phase: Mutex<Phase>,
    wake: Condvar,
    generation: AtomicU64,
}

impl LifecycleGate {
    pub fn new() -> Self {
        Self { phase: Mutex::new(Phase::Open), wake: Condvar::new(), generation: AtomicU64::new(0) }
    }

    pub fn phase(&self) -> Phase {
        self.phase.lock().map(|phase| *phase).unwrap_or(Phase::Quitting)
    }

    /// Claims a close from the attached Window. Repeated close notifications
    /// are harmless and never rerun detach/persistence work.
    pub fn begin_close(&self) -> bool {
        let Ok(mut phase) = self.phase.lock() else { return false };
        if *phase != Phase::Open {
            return false;
        }
        *phase = Phase::Closing;
        true
    }

    pub fn finish_close(&self) {
        if let Ok(mut phase) = self.phase.lock() {
            if *phase == Phase::Closing {
                *phase = Phase::Closed;
                self.generation.fetch_add(1, Ordering::AcqRel);
                self.wake.notify_all();
            }
        }
    }

    /// Commits an unexpected native Window destruction (for example a
    /// crash-equivalent AppKit teardown) when no guarded CloseRequested claim
    /// exists. A replacement Window can then be reconstructed by Dock reopen;
    /// a late Destroyed from an older generation is ignored by the caller
    /// whenever the stable label already has a visible replacement.
    pub fn mark_unexpected_destroyed(&self) {
        if let Ok(mut phase) = self.phase.lock() {
            if *phase == Phase::Open {
                *phase = Phase::Closed;
                self.generation.fetch_add(1, Ordering::AcqRel);
                self.wake.notify_all();
            }
        }
    }

    /// Releases a failed native close claim. The parent Window is still
    /// visible, so a subsequent CloseRequested may retry the bounded detach.
    pub fn abort_close(&self) {
        if let Ok(mut phase) = self.phase.lock() {
            if *phase == Phase::Closing {
                *phase = Phase::Open;
                self.wake.notify_all();
            }
        }
    }

    /// Claims Dock reconstruction. There is exactly one accepted reopen for
    /// each committed close, so duplicate activation events cannot create a
    /// second WebView host or subscription set.
    pub fn begin_reopen(&self) -> bool {
        let Ok(mut phase) = self.phase.lock() else { return false };
        if *phase != Phase::Closed {
            return false;
        }
        *phase = Phase::Open;
        // A reopened Window is a new native generation even though the
        // process-owned providers remain alive across the surface detach.
        self.generation.fetch_add(1, Ordering::AcqRel);
        true
    }

    /// Monotonic native-window generation. Any bridge/provider callback that
    /// captured an older generation is stale after a committed close.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Returns a failed reconstruction claim to `Closed` so the next Dock
    /// activation can retry without creating an additional Window.
    pub fn abort_reopen(&self) {
        if let Ok(mut phase) = self.phase.lock() {
            if *phase == Phase::Open {
                *phase = Phase::Closed;
                self.wake.notify_all();
            }
        }
    }

    /// Claims process shutdown. If a close is still finishing, wait only for
    /// the bounded close budget; never recursively re-enter the close path.
    pub fn begin_quit(&self) -> bool {
        let started = Instant::now();
        let Ok(mut phase) = self.phase.lock() else { return false };
        loop {
            match *phase {
                Phase::Quitting | Phase::Quit => return false,
                Phase::Closing if started.elapsed() < CLOSE_WAIT => {
                    let remaining = CLOSE_WAIT.saturating_sub(started.elapsed());
                    let waited = self.wake.wait_timeout(phase, remaining);
                    let Ok((next, _)) = waited else { return false };
                    phase = next;
                }
                Phase::Closing => return false,
                Phase::Open | Phase::Closed => {
                    *phase = Phase::Quitting;
                    return true;
                }
            }
        }
    }

    /// Escalates a close that exceeded its bounded wait into process quit.
    /// Native quit must still stop DevHub-owned resources even if the Window
    /// close worker is stuck; the worker's generation check then prevents it
    /// from issuing a second native close.
    pub fn force_quit_after_close_timeout(&self) -> bool {
        if let Ok(mut phase) = self.phase.lock() {
            if *phase == Phase::Closing {
                *phase = Phase::Quitting;
                self.generation.fetch_add(1, Ordering::AcqRel);
                self.wake.notify_all();
                return true;
            }
        }
        false
    }

    pub fn finish_quit(&self) {
        if let Ok(mut phase) = self.phase.lock() {
            if *phase == Phase::Quitting {
                *phase = Phase::Quit;
                self.wake.notify_all();
            }
        }
    }
}

/// A display work area expressed in the same physical coordinate space as a
/// native Window frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisplayWorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl DisplayWorkArea {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }
}

/// Restores a persisted frame while guaranteeing that a titlebar-sized part
/// remains visible on one of the currently connected displays. If no display
/// information is available, the validated frame is retained and the native
/// window manager chooses the placement.
pub fn safe_restore_frame(frame: WindowFrame, displays: &[DisplayWorkArea]) -> WindowFrame {
    let mut frame = frame.validate().unwrap_or_default();
    frame.width = frame.width.max(MIN_WINDOW_WIDTH);
    frame.height = frame.height.max(MIN_WINDOW_HEIGHT);
    if displays.is_empty() {
        return frame;
    }

    if displays.iter().any(|display| intersects_visible(frame, *display)) {
        return frame;
    }

    let display = displays[0];
    let width = frame.width.min(display.width.max(MIN_WINDOW_WIDTH));
    let height = frame.height.min(display.height.max(MIN_WINDOW_HEIGHT));
    let max_x = display.x.saturating_add(display.width.saturating_sub(width) as i32);
    let max_y = display.y.saturating_add(display.height.saturating_sub(height) as i32);
    frame.width = width;
    frame.height = height;
    frame.x = frame.x.clamp(display.x, max_x);
    frame.y = frame.y.clamp(display.y, max_y);
    frame
}

fn intersects_visible(frame: WindowFrame, display: DisplayWorkArea) -> bool {
    let right = i64::from(frame.x) + i64::from(frame.width);
    let bottom = i64::from(frame.y) + i64::from(frame.height);
    let visible_left = i64::from(frame.x.max(display.x));
    let visible_top = i64::from(frame.y.max(display.y));
    let visible_right = right.min(i64::from(display.x) + i64::from(display.width));
    let visible_bottom = bottom.min(i64::from(display.y) + i64::from(display.height));
    visible_right - visible_left >= i64::from(MIN_VISIBLE_PIXELS)
        && visible_bottom - visible_top >= i64::from(MIN_VISIBLE_PIXELS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(x: i32, y: i32, width: u32, height: u32) -> WindowFrame {
        WindowFrame { x, y, width, height, maximized: false }
    }

    #[test]
    fn close_reopen_and_quit_are_idempotent_and_ordered() {
        let gate = LifecycleGate::new();
        assert_eq!(gate.phase(), Phase::Open);
        assert!(gate.begin_close());
        assert!(!gate.begin_close());
        gate.finish_close();
        assert_eq!(gate.phase(), Phase::Closed);
        assert!(gate.begin_reopen());
        assert_eq!(gate.generation(), 2);
        assert!(!gate.begin_reopen());
        assert!(gate.begin_quit());
        assert!(!gate.begin_quit());
        gate.finish_quit();
        assert_eq!(gate.phase(), Phase::Quit);
    }

    #[test]
    fn destroyed_without_a_close_claim_cannot_finalize_a_new_generation() {
        let gate = LifecycleGate::new();
        gate.finish_close();
        assert_eq!(gate.phase(), Phase::Open);
        assert!(gate.begin_close());
        let generation = gate.generation();
        gate.finish_close();
        assert_eq!(gate.generation(), generation + 1);
        assert_eq!(gate.phase(), Phase::Closed);
        assert!(gate.begin_reopen());
        // A late Destroyed from the prior native Window is harmless once the
        // reopen has committed: finish_close only accepts Closing.
        gate.finish_close();
        assert_eq!(gate.phase(), Phase::Open);
    }

    #[test]
    fn concurrent_close_and_reopen_events_have_one_owner() {
        use std::sync::Arc;
        use std::thread;

        let gate = Arc::new(LifecycleGate::new());
        let close_claims = (0..8)
            .map(|_| {
                let gate = Arc::clone(&gate);
                thread::spawn(move || gate.begin_close())
            })
            .collect::<Vec<_>>();
        let close_count = close_claims
            .into_iter()
            .filter_map(|claim| claim.join().ok())
            .filter(|claim| *claim)
            .count();
        assert_eq!(close_count, 1);
        gate.finish_close();

        let reopen_claims = (0..16)
            .map(|_| {
                let gate = Arc::clone(&gate);
                thread::spawn(move || gate.begin_reopen())
            })
            .collect::<Vec<_>>();
        let reopen_count = reopen_claims
            .into_iter()
            .filter_map(|claim| claim.join().ok())
            .filter(|claim| *claim)
            .count();
        assert_eq!(reopen_count, 1);
        assert_eq!(gate.phase(), Phase::Open);
    }

    #[test]
    fn quit_waits_for_close_destroyed_then_claims_once() {
        use std::sync::Arc;
        use std::thread;
        use std::time::Duration;

        let gate = Arc::new(LifecycleGate::new());
        assert!(gate.begin_close());
        let quitting = Arc::clone(&gate);
        let worker = thread::spawn(move || quitting.begin_quit());
        thread::sleep(Duration::from_millis(10));
        // The close worker has captured the frame and detached its children;
        // the Destroyed event is the only event allowed to commit Closed.
        gate.finish_close();
        assert!(worker.join().expect("quit waiter"));
        assert_eq!(gate.phase(), Phase::Quitting);
        assert!(!gate.begin_quit());
        gate.finish_quit();
        assert_eq!(gate.phase(), Phase::Quit);
    }

    #[test]
    fn unexpected_destroyed_enters_closed_without_terminating_provider_phase() {
        let gate = LifecycleGate::new();
        assert_eq!(gate.generation(), 0);
        gate.mark_unexpected_destroyed();
        assert_eq!(gate.phase(), Phase::Closed);
        assert_eq!(gate.generation(), 1);
        // A stale duplicate event cannot advance another generation.
        gate.mark_unexpected_destroyed();
        assert_eq!(gate.generation(), 1);
        assert!(gate.begin_reopen());
    }

    #[test]
    fn close_timeout_can_escalate_to_quit_without_reentering_close() {
        let gate = LifecycleGate::new();
        assert!(gate.begin_close());
        assert!(gate.force_quit_after_close_timeout());
        assert_eq!(gate.phase(), Phase::Quitting);
        gate.finish_close();
        assert_eq!(gate.phase(), Phase::Quitting);
        gate.finish_quit();
        assert_eq!(gate.phase(), Phase::Quit);
    }

    #[test]
    fn a_frame_on_a_removed_display_is_clamped_to_the_primary_work_area() {
        let restored = safe_restore_frame(
            frame(-4_000, 2_000, 1_200, 800),
            &[DisplayWorkArea::new(0, 0, 1_920, 1_080)],
        );
        assert_eq!(restored.x, 0);
        assert_eq!(restored.y, 280);
        assert_eq!(restored.width, 1_200);
        assert_eq!(restored.height, 800);
    }

    #[test]
    fn a_partially_visible_frame_is_preserved() {
        let original = frame(-20, 100, 1_200, 800);
        assert_eq!(
            safe_restore_frame(original, &[DisplayWorkArea::new(0, 0, 1_920, 1_080)]),
            original
        );
    }
}
