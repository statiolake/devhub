/**
 * Pixel scrolling of a window, as VS Code and Zed scroll: the content
 * follows the trackpad pixel for pixel, while Neovim keeps `topline` a
 * whole line, its own, in its own grid.
 *
 * How: Neovim is led by a line. The window shows a *display position*
 * `off` pixels from Neovim's `topline` (negative: above it). Each time
 * Neovim scrolls its grid, what was on screen is kept as a *ghost* (an
 * image of the window's text area, `GridPainter`'s); the canvas, now
 * Neovim's new rows, and the ghost are drawn shifted by `off`, clipped to
 * the text area, and between them cover every row the display can be on.
 * A wheel moving the display past what they cover asks Neovim for one more
 * line ahead (`ScrollRequest`), so the next rows are there before they are
 * needed. When the wheel stops, Neovim is brought to the nearest line
 * (a line back, when it is ahead by more than half a line) and the display
 * eases onto it: at rest, what is shown is Neovim's grid, exactly.
 *
 * Neovim scrolling by itself (`<C-d>`, `zz`, `j` past the edge, a search)
 * is the same shift: the ghost holds the old view and the display eases
 * from it to the new one in `EASE_MS`, without waiting for anything — the
 * keys and Neovim's state are not held back by a frame.
 *
 * This file is the arithmetic, pure and unit-tested; the painter keeps the
 * ghosts and draws, the editor sends the requests.
 */

/** How long the display takes to ease onto Neovim's `topline`. */
export const EASE_MS = 90;

/** A frame, at 60 Hz. */
const FRAME_MS = 16;

/** How long after the last wheel event the display settles. */
export const WHEEL_IDLE_MS = 110;

/** How long a request that Neovim scrolls by its own wheel may stay unseen. */
const REQUEST_TIMEOUT_MS = 250;

/** One window's display, in pixels from Neovim's `topline` (down positive). */
export interface ScrollView {
  /** Where the display is. */
  off: number;
  /** Where the wheel wants it. */
  want: number;
  /** The ghost's position, when there is one. */
  ghost: number | undefined;
  /** The direction of the request in flight (0: none), and when it went. */
  pending: number;
  pendingAt: number;
  /** A direction Neovim did not scroll in when asked (the buffer's end). */
  stuck: number;
  /** The last wheel event: its time and direction. */
  wheelAt: number;
  dir: number;
  /** The ease onto `topline`: from where, since when. */
  ease: { from: number; start: number } | undefined;
  /** The settling line request has been made for this rest. */
  settled: boolean;
  /** How long Neovim takes to answer a request with its scroll (ms). */
  rtt: number;
  /** How fast the wheel goes (px/ms, smoothed). */
  speed: number;
}

export function newScrollView(): ScrollView {
  return {
    off: 0,
    want: 0,
    ghost: undefined,
    pending: 0,
    pendingAt: 0,
    stuck: 0,
    wheelAt: -Infinity,
    dir: 0,
    ease: undefined,
    settled: false,
    rtt: 30,
    speed: 0,
  };
}

/** Whether a view shows anything but Neovim's grid as it is. */
export function isActive(view: ScrollView): boolean {
  return (
    view.off !== 0 ||
    view.want !== 0 ||
    view.ghost !== undefined ||
    view.pending !== 0
  );
}

/** The display positions the canvas and the ghost cover together. */
export function coverage(view: ScrollView): { lo: number; hi: number } {
  const g = view.ghost ?? 0;
  return { lo: Math.min(0, g), hi: Math.max(0, g) };
}

/**
 * Neovim scrolled the window `rows` screen rows (`win_viewport`'s
 * `scroll_delta`; down positive). The caller has just taken a ghost of the
 * display as it is (at `off`, before this); everything is now measured
 * from the new `topline`. A shift as tall as the text area leaves nothing
 * to ease through: the display jumps, as Neovim did.
 */
export function shifted(
  view: ScrollView,
  rows: number,
  rowHeight: number,
  textHeight: number,
  now: number,
): void {
  const d = rows * rowHeight;
  // The wheel's (or a settling request's) own doing, or Neovim's alone:
  // a key's scroll is not taken back, the display eases onto it.
  const led = view.pending !== 0 || now - view.wheelAt < WHEEL_IDLE_MS;
  view.ghost = view.off - d;
  view.off -= d;
  view.want -= d;
  if (!led) {
    // Started a frame ago: the first frame drawn already shows the move,
    // so a key's scroll is seen as soon as it would be without easing.
    view.settled = true;
    view.ease = { from: view.off, start: now - FRAME_MS };
  } else if (view.ease) {
    view.ease = { from: view.off, start: now };
  }
  if (view.pending !== 0 && Math.sign(rows) === view.pending) {
    view.rtt = 0.7 * view.rtt + 0.3 * Math.min(200, now - view.pendingAt);
    view.pending = 0;
  }
  view.stuck = 0;
  if (Math.abs(view.off) >= textHeight) {
    view.off = 0;
    view.want = 0;
    view.ghost = undefined;
    view.ease = undefined;
  }
}

/** The wheel moved `dy` pixels (down positive). */
export function wheeled(view: ScrollView, dy: number, now: number): void {
  if (dy === 0) return;
  const dt = now - view.wheelAt;
  const speed = Math.abs(dy) / Math.max(8, dt);
  view.speed =
    dt > WHEEL_IDLE_MS || Math.sign(dy) !== view.dir
      ? speed
      : 0.7 * view.speed + 0.3 * speed;
  view.wheelAt = now;
  view.dir = Math.sign(dy);
  view.want += dy;
  view.ease = undefined;
  view.settled = false;
  // Neovim cannot go further that way: the wheel's surplus is dropped, so
  // turning back answers at once.
  if (view.stuck === view.dir) {
    const { lo, hi } = coverage(view);
    view.want = Math.min(hi, Math.max(lo, view.want));
  }
}

/** A request answered: Neovim did (`true`) or did not scroll. */
export function answered(view: ScrollView, scrolled: boolean): void {
  if (scrolled || view.pending === 0) return;
  view.stuck = view.pending;
  view.pending = 0;
  const { lo, hi } = coverage(view);
  view.want = Math.min(hi, Math.max(lo, view.want));
}

/** What a frame asks of Neovim: lines to scroll, ahead or back to rest. */
export interface ScrollRequest {
  readonly lines: number;
  /** A settling request: only if Neovim can scroll by exactly that. */
  readonly exact: boolean;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * One frame: where the display is now, and what to ask Neovim. The display
 * is snapped to device pixels (`dpr`), so text stays crisp.
 */
export function step(
  view: ScrollView,
  now: number,
  rowHeight: number,
  textRows: number,
  dpr: number,
): ScrollRequest | undefined {
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  if (view.pending !== 0 && now - view.pendingAt > REQUEST_TIMEOUT_MS) {
    answered(view, false);
  }
  const { lo, hi } = coverage(view);
  // Still catching up with a flick that went past what Neovim has drawn.
  const behind = view.stuck !== view.dir && (view.want < lo || view.want > hi);
  if (now - view.wheelAt < WHEEL_IDLE_MS || behind) {
    view.off = snap(Math.min(hi, Math.max(lo, view.want)));
    if (view.pending !== 0 || view.stuck === view.dir) return undefined;
    // Keep Neovim ahead of where the wheel wants the display: a line, or
    // as far as the wheel goes while Neovim answers, whichever is more; by
    // less than a window at a time (so the ghost and the canvas meet).
    const lead = Math.max(rowHeight, view.speed * view.rtt * 1.5);
    const most = Math.max(1, textRows - 2);
    if (view.dir > 0 && view.want > -lead) {
      const lines = Math.ceil((view.want + lead) / rowHeight);
      return ask(view, Math.min(most, Math.max(1, lines)), now);
    }
    if (view.dir < 0 && view.want < lead) {
      const lines = Math.ceil((lead - view.want) / rowHeight);
      return ask(view, -Math.min(most, Math.max(1, lines)), now);
    }
    return undefined;
  }
  if (view.pending !== 0) return undefined;
  // At rest: Neovim to the nearest line first, then the display onto it.
  const lines = Math.round(view.off / rowHeight);
  if (lines !== 0 && !view.settled) {
    view.settled = true;
    view.want = view.off;
    return { ...ask(view, lines, now), exact: true };
  }
  view.want = 0;
  if (view.off === 0) {
    view.ghost = undefined;
    view.ease = undefined;
    return undefined;
  }
  view.ease ??= { from: view.off, start: now };
  const t = Math.min(1, (now - view.ease.start) / EASE_MS);
  view.off = t >= 1 ? 0 : snap(view.ease.from * (1 - easeOut(t)));
  if (view.off === 0) {
    view.ghost = undefined;
    view.ease = undefined;
  }
  return undefined;
}

function ask(view: ScrollView, lines: number, now: number): ScrollRequest {
  view.pending = Math.sign(lines);
  view.pendingAt = now;
  return { lines, exact: false };
}

/** A settling request Neovim could not take exactly: ease where it is. */
export function inexact(view: ScrollView): void {
  view.pending = 0;
}

/**
 * Asks Neovim to scroll window `win` by `n` lines (down positive): in
 * Normal mode, exactly that (`<C-e>`/`<C-y>` in the window, as the wheel
 * scrolls it, current window unchanged); anywhere else — Insert, Visual,
 * a terminal, a mapped wheel, `mouse` off — Neovim's own wheel at the
 * pointer, unless only an exact scroll will do. Answers 1 (scrolled), 0
 * (could not: an end of the buffer), 2 (the wheel was sent; its scroll
 * shows in the redraw) or -1 (not exact, nothing sent).
 */
export const SCROLL_LUA = `
local win, n, grid, row, col, exact_only = ...
local m = vim.api.nvim_get_mode()
local key = n > 0 and '<ScrollWheelDown>' or '<ScrollWheelUp>'
if m.mode == 'n' and not m.blocking and vim.o.mouse ~= ''
  and vim.api.nvim_win_is_valid(win) and vim.fn.maparg(key, 'n') == '' then
  local changed = false
  vim.api.nvim_win_call(win, function()
    local a = vim.fn.winsaveview()
    vim.cmd('normal! ' .. math.abs(n) .. (n > 0 and '\\5' or '\\25'))
    local b = vim.fn.winsaveview()
    changed = a.topline ~= b.topline or a.topfill ~= b.topfill
      or (a.skipcol or 0) ~= (b.skipcol or 0)
  end)
  return changed and 1 or 0
end
if exact_only then return -1 end
vim.api.nvim_input_mouse('wheel', n > 0 and 'down' or 'up', '', grid, row, col)
return 2
`;
