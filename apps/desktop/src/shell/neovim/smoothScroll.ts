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
 * needed. When the wheel stops, Neovim is brought to the next whole line
 * the way the display was going (never back) and the display
 * eases onto it: at rest, what is shown is Neovim's grid, exactly.
 *
 * A gesture that moved by its pixels *lands* (`../landing.ts`) instead of
 * stopping and then settling: once its input ends (`LAND_GAP_MS` without an
 * event), or while a flick's momentum dies away (under `LAND_SPEED`, from
 * three times that), the row it will rest on is worked out — the next one
 * the way it goes, past what the momentum still has to come — Neovim is
 * asked for exactly that row, and the display eases onto it from the speed
 * it has, in one motion. Neovim's answer is where it lands: a wrapped line
 * Neovim can only rest at the start of, or the buffer's end, moves the
 * landing on, still in the one motion.
 *
 * Neovim scrolling by itself (`<C-d>`, `zz`, `j` past the edge, a search)
 * is the same shift: the ghost holds the old view and the display eases
 * from it to the new one in `EASE_MS`, without waiting for anything — the
 * keys and Neovim's state are not held back by a frame.
 *
 * This file is the arithmetic, pure and unit-tested; the painter keeps the
 * ghosts and draws, the editor sends the requests.
 */

import {
  aheadOf,
  land,
  landingAt,
  moved,
  retarget,
  type Landing,
} from "../landing";
import { TICK_GAP_MS } from "./wheelLines";

/** How long the display takes to ease onto Neovim's `topline`. */
export const EASE_MS = 90;

/** A frame, at 60 Hz. */
const FRAME_MS = 16;

/**
 * How long a wheel tick's line takes to glide in (`wheeled` with a row
 * height), and a tmux pane's copy-mode shift (`GridPainter.setShiftedGrids`):
 * VS Code's smooth wheel scroll is 125 ms. On the ease-out cubic it is half
 * way in 25 ms and 90% in 65, so a tick answers in the frame it lands in
 * and settles without a visible stop.
 */
export const GLIDE_MS = 120;

/** How long after the last wheel event the display settles. */
export const WHEEL_IDLE_MS = 110;

/**
 * How long without a wheel event a gesture moving by its pixels has ended
 * and lands: longer than a trackpad's events are apart (8–17 ms, a frame or
 * two when the page is busy and they come together), shorter than a pause.
 */
export const LAND_GAP_MS = 40;

/**
 * A flick's momentum dying away lands from this speed (px/ms, 5 px a frame)
 * — when it went three times as fast — while its last events still come:
 * on the row past where they will take it.
 */
export const LAND_SPEED = 0.3;

/** Under this (px) an event during a momentum's landing is its momentum, however late. */
const TAIL_PX = 3;

/** How long a flick's momentum is taken to last, at most and at least (ms). */
const TAIL_MS = { lo: 60, hi: 400 };

/**
 * How long a request Neovim answered may stay unseen before another may
 * go: Neovim's own wheel (sent outside Normal mode) does not always scroll
 * (the first turn in a terminal leaves Terminal mode), and says nothing
 * when it does not. Until its answer comes, a request is never given up:
 * a busy Neovim (a file just opened) would otherwise be sent one request
 * after another and scroll by all of them.
 */
const REQUEST_TIMEOUT_MS = 60;

/** A scroll Neovim says it made shows in its next redraw; this is ample. */
const SCROLLED_TIMEOUT_MS = 500;

/** One window's display, in pixels from Neovim's `topline` (down positive). */
export interface ScrollView {
  /** Where the display is. */
  off: number;
  /** Where the wheel wants it. */
  want: number;
  /** The ghost's position, when there is one. */
  ghost: number | undefined;
  /**
   * The direction of the request in flight (0: none), when it went, and
   * when to give up on seeing it (from its answer).
   */
  pending: number;
  pendingAt: number;
  deadline: number;
  /** A direction Neovim did not scroll in when asked (the buffer's end). */
  stuck: number;
  /** The last wheel event: its time and direction. */
  wheelAt: number;
  dir: number;
  /** The ease onto `topline`: from where, since when, how long. */
  ease: { from: number; start: number } | undefined;
  easeMs: number;
  /**
   * A tick's glide to the line it asked for: from where the display was,
   * since when; it ends on wherever `want` is then.
   */
  glide: { readonly from: number; start: number } | undefined;
  /** Pixels a tick moved ahead of the wheel, which its next pixels pay. */
  credit: number;
  /** The settling line request has been made for this rest. */
  settled: boolean;
  /** How long Neovim takes to answer a request with its scroll (ms). */
  rtt: number;
  /** How fast the wheel goes (px/ms, smoothed). */
  speed: number;
  /**
   * The furthest the display went each way in this gesture, as `off` is
   * measured: where the wheel would have pushed the cursor to (`SCROLL_LUA`).
   */
  reach: { lo: number; hi: number };
  /**
   * The landing under way (`../landing.ts`): its curve; whether it is a
   * flick's momentum, which may carry it further; the place Neovim was
   * asked to be at for it (undefined: not yet) and whether that answer is
   * awaited.
   */
  land:
    | { curve: Landing; momentum: boolean; asked?: number; asking: boolean }
    | undefined;
  /** The gesture has landed: nothing more is asked of Neovim for it. */
  landed: boolean;
  /** The wheel's fastest in this gesture (`speed`), and when. */
  peak: { speed: number; at: number };
  /** Reduce Motion: the wheel's own movement only, no landing. */
  calm: boolean;
  /** How fast the display moves (px/ms, smoothed over frames), from where it was last frame. */
  vel: number;
  seen: { off: number; at: number } | undefined;
}

export function newScrollView(): ScrollView {
  return {
    off: 0,
    want: 0,
    ghost: undefined,
    pending: 0,
    pendingAt: 0,
    deadline: Infinity,
    stuck: 0,
    wheelAt: -Infinity,
    dir: 0,
    ease: undefined,
    easeMs: EASE_MS,
    glide: undefined,
    credit: 0,
    settled: false,
    rtt: 30,
    speed: 0,
    reach: { lo: 0, hi: 0 },
    land: undefined,
    landed: false,
    peak: { speed: 0, at: 0 },
    calm: false,
    vel: 0,
    seen: undefined,
  };
}

/** Whether a view shows anything but Neovim's grid as it is. */
export function isActive(view: ScrollView): boolean {
  return (
    view.off !== 0 ||
    view.want !== 0 ||
    view.ghost !== undefined ||
    view.pending !== 0 ||
    view.land !== undefined
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
  if (view.glide) view.glide = { ...view.glide, from: view.glide.from - d };
  view.reach = { lo: view.reach.lo - d, hi: view.reach.hi - d };
  if (view.seen) view.seen = { ...view.seen, off: view.seen.off - d };
  const landing = view.land;
  if (landing && led) {
    landing.curve = moved(landing.curve, -d);
    if (landing.asked !== undefined) landing.asked -= d;
    if (landing.asking && Math.sign(rows) === view.pending) {
      // Neovim is where it could be: past the row on a wrapped line, short
      // of it at the buffer's end. The landing goes on to there.
      landing.asking = false;
      landing.asked = 0;
      if (landing.curve.to !== 0)
        landing.curve = retarget(landing.curve, 0, now);
    }
  } else if (landing) {
    view.land = undefined;
  }
  if (!led) {
    // Started a frame ago: the first frame drawn already shows the move,
    // so a key's scroll is seen as soon as it would be without easing.
    view.settled = true;
    view.ease = { from: view.off, start: now - FRAME_MS };
    view.easeMs = EASE_MS;
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
    view.glide = undefined;
    view.land = undefined;
  }
}

/**
 * The wheel moved `dy` pixels (down positive). With `rowHeight`, a tick —
 * the first event after a pause of `TICK_GAP_MS`, or the first the other
 * way (`wheelLines.ts`) — moves the display at least to the next line past
 * where it was going, gliding there in `GLIDE_MS` (at once when `glide` is
 * false: Reduce Motion); the pixels after it pay that line back before the
 * display moves on, so a swipe goes by its pixels, under the finger.
 */
export function wheeled(
  view: ScrollView,
  dy: number,
  now: number,
  rowHeight?: number,
  glide = true,
): void {
  if (dy === 0) return;
  const dt = now - view.wheelAt;
  const fresh = dt > WHEEL_IDLE_MS;
  // A landing takes its last small events late (a busy page) as the
  // gesture still, not a tick: a notch is a few pixels or more.
  const tail =
    (view.land?.momentum === true || view.landed) &&
    Math.sign(dy) === view.dir &&
    Math.abs(dy) < TAIL_PX &&
    dt <= WHEEL_IDLE_MS;
  const tick =
    rowHeight !== undefined &&
    rowHeight > 0 &&
    !tail &&
    (dt > TICK_GAP_MS || Math.sign(dy) !== view.dir);
  const same = !fresh && Math.sign(dy) === view.dir;
  if (tick || !same) view.credit = 0;
  if (fresh) view.reach = { lo: view.off, hi: view.off };
  // A gesture's first event came a frame after it began, as far as is known.
  const speed = Math.abs(dy) / Math.max(8, fresh ? FRAME_MS : dt);
  view.speed = same ? 0.5 * view.speed + 0.5 * speed : speed;
  if (!same || view.speed > view.peak.speed)
    view.peak = { speed: view.speed, at: now };
  view.wheelAt = now;
  view.dir = Math.sign(dy);
  view.calm = !glide;
  const landed = view.landed && same && !tick;
  view.landed = false;
  if (view.land) {
    // A flick's momentum still coming: the landing goes on (`step` takes
    // it further if it must). Anything else — a new push, a tick, the other
    // way — takes over from where the display is.
    if (same && !tick && view.land.momentum && speed < 1.5 * LAND_SPEED) {
      view.want += dy;
      return;
    }
    view.land = undefined;
    if (same && !tick) owe(view);
    else view.want = view.off;
  }
  let move = dy;
  if (!tick && view.credit > 0) {
    const paid = Math.min(view.credit, Math.abs(move));
    view.credit -= paid;
    move -= view.dir * paid;
  }
  // The last of a flick's momentum, after it landed past where it takes
  // the wheel: it stays landed, nothing to ask.
  if (landed && move === 0) {
    view.landed = true;
    return;
  }
  if (tick && rowHeight !== undefined) {
    // A tick ends on a whole line: the nearest to where its pixels go, and
    // at least one past the line the display was on, or going to. What it
    // went past its pixels is paid by the next ones; what it fell short,
    // less than half a line, is let go (at rest it would be too).
    const line = Math.round(view.want / rowHeight);
    const to = view.want + move;
    const near = Math.round(to / rowHeight);
    const n =
      view.dir > 0 ? Math.max(near, line + 1) : Math.min(near, line - 1);
    view.credit = Math.max(0, view.dir * (n * rowHeight - to));
    move = n * rowHeight - view.want;
    view.glide = glide ? { from: view.off, start: now } : undefined;
  }
  view.want += move;
  view.ease = undefined;
  view.settled = false;
  // Neovim cannot go further that way: the wheel's surplus is dropped, so
  // turning back answers at once.
  if (view.stuck === view.dir) {
    const { lo, hi } = coverage(view);
    view.want = Math.min(hi, Math.max(lo, view.want));
  }
}

/**
 * Where a landing left the display ahead of the wheel: the wheel's pixels
 * pay that first (`credit`), as a tick's line ahead is paid, so the display
 * never goes back and does not set off again for pixels it already went.
 */
function owe(view: ScrollView): void {
  view.credit = Math.max(view.credit, view.dir * (view.off - view.want));
  view.want = view.off;
}

/**
 * A request answered (`SCROLL_LUA`'s code): 1 scrolled (its redraw is on
 * the way), 0 could not (an end of the buffer), 2 Neovim's own wheel sent
 * (it may not scroll), -1 nothing sent (a settling request Neovim cannot
 * take: the display eases where it is).
 */
export function replied(view: ScrollView, code: number, now: number): void {
  if (view.pending === 0) return;
  const landing = view.land;
  if (landing?.asking && code !== 1 && code !== 2) {
    // Neovim could not go where the landing was going (the buffer's end, or
    // not in Normal mode): it lands where Neovim is.
    landing.asking = false;
    landing.asked = 0;
    if (landing.curve.to !== 0) landing.curve = retarget(landing.curve, 0, now);
  }
  if (code === 1) {
    view.deadline = now + SCROLLED_TIMEOUT_MS;
    return;
  }
  if (code === 2) {
    view.deadline = now + REQUEST_TIMEOUT_MS;
    return;
  }
  if (code === -1) {
    view.pending = 0;
    return;
  }
  view.stuck = view.pending;
  view.pending = 0;
  const { lo, hi } = coverage(view);
  view.want = Math.min(hi, Math.max(lo, view.want));
}

/** What a frame asks of Neovim: rows to scroll, ahead or back to rest. */
export interface ScrollRequest {
  readonly rows: number;
  /** A settling request: only if Neovim can scroll by exactly that. */
  readonly exact: boolean;
  /** A settling request's way the display was going (`restLines`). */
  readonly toward?: number;
}

/** The ease every scroll here lands with (ease-out cubic): `documentMotion.ts` too. */
export function easeOut(t: number): number {
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
  const request = advance(view, now, rowHeight, textRows, dpr);
  if (view.seen && now > view.seen.at) {
    const v = (view.off - view.seen.off) / (now - view.seen.at);
    view.vel = 0.5 * view.vel + 0.5 * v;
  }
  view.seen = { off: view.off, at: now };
  return request;
}

/** How much further a flick's momentum is to take the wheel (px), from how it has died away so far. */
function tailOf(view: ScrollView): number {
  const { speed, at } = view.peak;
  if (view.speed <= 0 || speed <= view.speed) return 0;
  const tau = (view.wheelAt - at) / Math.log(speed / view.speed);
  return view.speed * Math.min(TAIL_MS.hi, Math.max(TAIL_MS.lo, tau));
}

/**
 * The row a landing rests on: the next one the way the display goes past
 * the wheel (and what its momentum has to come), never behind the display;
 * at an end Neovim cannot go past, its line.
 */
function landingRow(
  view: ScrollView,
  rowHeight: number,
  momentum: boolean,
): number {
  const dir = view.dir;
  const wheel = view.want + dir * ((momentum ? tailOf(view) : 0) - view.credit);
  let to = aheadOf(
    dir > 0 ? Math.max(wheel, view.off) : Math.min(wheel, view.off),
    rowHeight,
    dir,
  );
  if (view.stuck === dir && dir * to > 0) to = 0;
  return dir * (to - view.off) < 0 ? view.off : to;
}

/** Whether the gesture lands now (`LAND_GAP_MS`, `LAND_SPEED`), and how. */
function landsNow(view: ScrollView, now: number): boolean | undefined {
  if (
    view.land ||
    view.landed ||
    view.settled ||
    view.calm ||
    view.glide ||
    view.ease ||
    view.dir === 0
  )
    return undefined;
  if (now - view.wheelAt >= LAND_GAP_MS) return false;
  if (view.speed < LAND_SPEED && view.peak.speed >= 3 * LAND_SPEED) return true;
  return undefined;
}

/** A frame of a landing (`ScrollView.land`). */
function landFrame(
  view: ScrollView,
  now: number,
  rowHeight: number,
  snap: (v: number) => number,
): ScrollRequest | undefined {
  const landing = view.land;
  if (!landing) return undefined;
  const { lo, hi } = coverage(view);
  if (landing.asking && view.pending === 0) {
    // Its answer never showed: it lands where Neovim is.
    landing.asking = false;
    landing.asked = 0;
    if (landing.curve.to !== 0) landing.curve = retarget(landing.curve, 0, now);
  }
  if (landing.momentum && !landing.asking) {
    // The momentum went on further than was thought: it lands further on.
    const to = landingRow(view, rowHeight, true);
    if (view.dir * (to - landing.curve.to) > 0) {
      landing.curve = retarget(landing.curve, to, now);
      landing.asked = undefined;
    }
  }
  let at = landingAt(landing.curve, now);
  const pos = Math.min(hi, Math.max(lo, at.pos));
  if (pos !== at.pos) {
    // Past what Neovim has drawn yet (a slow link): the display waits at
    // its edge, and the landing goes on from there, from rest, once the
    // rows come — it does not run out meanwhile.
    landing.curve = land(pos, 0, landing.curve.to, now);
    at = { pos, vel: 0, done: false };
  }
  view.off = at.done ? pos : snap(pos);
  view.reach = {
    lo: Math.min(view.reach.lo, view.off),
    hi: Math.max(view.reach.hi, view.off),
  };
  if (view.pending !== 0) return undefined;
  if (landing.asked === undefined) {
    // Neovim to the row the display lands on, as the settling request does
    // (only exactly, the way the display goes).
    landing.asked = landing.curve.to;
    const rows = Math.round(landing.curve.to / rowHeight);
    if (rows !== 0) {
      landing.asking = true;
      return { ...ask(view, rows, now), exact: true, toward: view.dir };
    }
  }
  if (!at.done) return undefined;
  view.land = undefined;
  view.landed = true;
  owe(view);
  if (Math.abs(view.off) < 0.5) {
    view.off = 0;
    view.want = 0;
    view.ghost = undefined;
  }
  return undefined;
}

function advance(
  view: ScrollView,
  now: number,
  rowHeight: number,
  textRows: number,
  dpr: number,
): ScrollRequest | undefined {
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  if (view.pending !== 0 && now > view.deadline) view.pending = 0;
  const { lo, hi } = coverage(view);
  // Still catching up with a flick that went past what Neovim has drawn.
  const behind = view.stuck !== view.dir && (view.want < lo || view.want > hi);
  if (view.glide && now - view.glide.start >= GLIDE_MS) view.glide = undefined;
  const momentum = landsNow(view, now);
  if (momentum !== undefined) {
    view.settled = true;
    // From the frame before, where the display is: this frame already
    // moves on, at the speed it had.
    view.land = {
      curve: land(
        view.off,
        view.vel,
        landingRow(view, rowHeight, momentum),
        Math.min(now, Math.max(now - FRAME_MS, view.seen?.at ?? now)),
      ),
      momentum,
      asking: false,
    };
  }
  if (view.land) return landFrame(view, now, rowHeight, snap);
  if (
    !view.landed &&
    (now - view.wheelAt < WHEEL_IDLE_MS || behind || view.glide)
  ) {
    const to = Math.min(hi, Math.max(lo, view.want));
    // A glide starts with the first frame that can move: until Neovim has
    // drawn the rows it goes to, it has not begun (not jumped into later).
    if (view.glide && to === view.glide.from && view.pending !== 0)
      view.glide.start = now;
    // A tick glides to its line; a swipe's pixels are followed as they come.
    // Never outside what the canvas and the ghost cover: a glide that began
    // before Neovim scrolled (its start moved with the scroll) would pass
    // through rows neither has, and show the window's background there.
    const glided = view.glide
      ? view.glide.from +
        (to - view.glide.from) * easeOut((now - view.glide.start) / GLIDE_MS)
      : to;
    const off = snap(Math.min(hi, Math.max(lo, glided)));
    // Never back while the wheel goes on: a landing's request answered
    // after the wheel took over (Neovim brought back behind the display)
    // narrows what is drawn ahead; the display waits where it is, which the
    // ghost covers, until the rows come.
    const on = view.dir * (view.want - view.off) >= 0;
    view.off = on && view.dir * (off - view.off) < 0 ? view.off : off;
    view.reach = {
      lo: Math.min(view.reach.lo, view.off),
      hi: Math.max(view.reach.hi, view.off),
    };
    if (view.pending !== 0 || view.stuck === view.dir) return undefined;
    // Keep Neovim ahead of where the wheel wants the display: a line, or
    // twice as far as the wheel goes while Neovim answers and the frame
    // that draws it, whichever is more (a flick slows down, it does not
    // speed up: twice is room for the round trip's jitter); by less than a
    // window at a time (so the ghost and the canvas meet).
    // A tick's glide goes to a line it knows: Neovim is asked for that
    // line and no further, or it would be led past the window and the
    // display would jump to it.
    const lead = view.glide
      ? 0
      : Math.max(rowHeight, view.speed * (view.rtt + FRAME_MS) * 2);
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
  // At rest: Neovim to the next whole line the way the display was going
  // (`restLines`), then the display onto it — on, never back.
  const lines = restLines(view.off, rowHeight, view.dir);
  if (lines !== 0 && !view.settled) {
    view.settled = true;
    view.want = view.off;
    return { ...ask(view, lines, now), exact: true, toward: view.dir };
  }
  view.want = 0;
  if (view.off === 0) {
    view.ghost = undefined;
    view.ease = undefined;
    return undefined;
  }
  view.ease ??= { from: view.off, start: now };
  const t = Math.min(1, (now - view.ease.start) / view.easeMs);
  view.off = t >= 1 ? 0 : snap(view.ease.from * (1 - easeOut(t)));
  if (view.off === 0) {
    view.ghost = undefined;
    view.ease = undefined;
  }
  return undefined;
}

/**
 * The lines Neovim is brought at rest, for a display `off` pixels from its
 * line that was moving `dir`: the next whole line that way, so the display
 * eases on to it and never back. Settled on the nearest line, a wheel that
 * stopped past one by less than half a line went back to it (7 px back at
 * the end of a fast burst, in the stability suite's motion checks). Less
 * than a pixel is the line it is on.
 */
export function restLines(off: number, rowHeight: number, dir: number): number {
  if (Math.abs(off) < 1) return 0;
  if (dir > 0) return Math.ceil(off / rowHeight - 1e-9);
  if (dir < 0) return Math.floor(off / rowHeight + 1e-9);
  return Math.round(off / rowHeight);
}

function ask(view: ScrollView, rows: number, now: number): ScrollRequest {
  view.pending = Math.sign(rows);
  view.pendingAt = now;
  view.deadline = Infinity;
  return { rows, exact: false };
}

/**
 * Asks Neovim to scroll window `win` by `n` screen rows (down positive):
 * in Normal mode, by `<C-e>`/`<C-y>` in the window, as the wheel scrolls
 * it, current window unchanged — one at a time, until the view moved that
 * many rows (`nvim_win_text_height`: a wrapped line moves by all its rows
 * at once, unless 'smoothscroll'; filler and virtual lines a row each);
 * only as near as whole lines allow when `exact_only` (the settling
 * request: Neovim to the line nearest the display). Anywhere else —
 * Insert, Visual, a terminal, a mapped wheel, `mouse` off — Neovim's own
 * wheel at the pointer, unless only the settling request would go. Answers
 * `{ code, bound }`: code 1 (scrolled), 0 (could not: an end of the
 * buffer), 2 (the wheel was sent; its scroll shows in the redraw) or -1
 * (nothing sent); bound, the other windows `scrollbind` moves with it.
 *
 * The cursor ends where Neovim's own wheel leaves it: on its line, unless
 * the view left it behind (then the nearest line in view, `scrolloff`
 * kept), and once pushed it stays pushed. Neovim is led past the display,
 * so its view pushes the cursor further than the display went: the cursor
 * the wheel alone would leave is kept here, pushed by the furthest the
 * display went each way (`lo`, `hi`: from Neovim's view, in rows) as each
 * request comes, and put back at every exact request (the settling one).
 */
export const SCROLL_LUA = `
local win, n, grid, row, col, exact_only, lo, hi, toward = ...
local m = vim.api.nvim_get_mode()
local bound = {}
if vim.api.nvim_win_is_valid(win) and vim.wo[win].scrollbind then
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(vim.api.nvim_win_get_tabpage(win))) do
    if w ~= win and vim.wo[w].scrollbind then table.insert(bound, w) end
  end
end
local key = n > 0 and '<ScrollWheelDown>' or '<ScrollWheelUp>'
if m.mode == 'n' and not m.blocking and vim.o.mouse ~= ''
  and vim.api.nvim_win_is_valid(win) and vim.fn.maparg(key, 'n') == '' then
  local G = package.loaded['devhub_gui'] or {}
  G._wheel = G._wheel or {}
  local changed = false
  vim.api.nvim_win_call(win, function()
    local a = vim.fn.winsaveview()
    local kept = G._wheel[win]
    if not kept or kept.lnum ~= a.lnum or kept.col ~= a.col then
      kept = { line = a.lnum, curswant = a.curswant }
    end
    local last = vim.fn.line('$')
    local so = vim.wo.scrolloff >= 0 and vim.wo.scrolloff or vim.o.scrolloff
    -- The cursor kept within a view from top to bottom, as the wheel does.
    local function within(top, bottom)
      top, bottom = math.max(1, top), math.min(last, bottom)
      local lo = top == 1 and 1 or math.min(bottom, top + so)
      local hi = bottom == last and bottom or math.max(lo, bottom - so)
      return math.max(lo, math.min(hi, kept.line))
    end
    -- Rows of lines from..to, their fill included.
    local function height(from, to)
      if to < from then return 0 end
      return vim.api.nvim_win_text_height(0, { start_row = from - 1, end_row = to - 1 }).all
    end
    -- How far down a view's top is in its topline's block: the fill not
    -- shown, and the rows 'smoothscroll' skipped.
    local function into(v)
      local own = vim.api.nvim_win_text_height(0, { start_row = v.topline - 1, end_row = v.topline - 1 })
      local skipped = 0
      if (v.skipcol or 0) > 0 then
        skipped = own.all - own.fill - vim.api.nvim_win_text_height(0,
          { start_row = v.topline - 1, end_row = v.topline - 1, start_vcol = v.skipcol }).all
      end
      return own.fill - v.topfill + skipped
    end
    local function moved(from, to)
      if from.topline == to.topline then return into(to) - into(from) end
      local sign = 1
      if to.topline < from.topline then from, to, sign = to, from, -1 end
      return sign * (height(from.topline, to.topline - 1) + into(to) - into(from))
    end
    -- The line at row r from the top of view v (a wrapped line, a fold, a
    -- filler row: as many rows as they take).
    local function line_at(v, r)
      local l, acc = v.topline, -into(v)
      for _ = 1, 1000 do
        if r >= 0 then
          local h = height(l, l)
          if acc + h > r or l >= last then return l end
          acc, l = acc + h, l + 1
        else
          if l <= 1 then return 1 end
          l = l - 1
          acc = acc - height(l, l)
          if acc <= r then return l end
        end
      end
      return l
    end
    -- The lines the display showed at least partly, the furthest it went
    -- each way (a line half in view does not push: where it rests decides).
    kept.line = within(line_at(a, math.floor(hi or 0)),
      line_at(a, vim.api.nvim_win_get_height(0) - 1 + math.ceil(lo or 0)))
    -- A line taller than the window would go by all its rows at once:
    -- 'smoothscroll' (a row at a time, skipcol) while the view is in one.
    -- The person's own value (off) comes back once the view is out of it
    -- (here, or on WinScrolled), before the buffer leaves the window (or
    -- the window is left for another buffer: Neovim keeps a window's
    -- options with the buffer), and in a window split from this one.
    G._sms = G._sms or {}
    local function own_rows(l)
      local h = vim.api.nvim_win_text_height(0, { start_row = l - 1, end_row = l - 1 })
      return h.all - h.fill
    end
    local function restore()
      G._sms[win] = nil
      pcall(vim.api.nvim_del_augroup_by_name, 'devhub_smoothscroll_' .. win)
      if vim.api.nvim_win_is_valid(win) then
        vim.api.nvim_win_call(win, function() vim.cmd('noautocmd setlocal nosmoothscroll') end)
      end
    end
    local function smooth_if_tall(v)
      local edge = (n > 0 or (v.skipcol or 0) > 0) and v.topline or v.topline - 1
      if G._sms[win] or not vim.wo.wrap or vim.wo.smoothscroll
        or edge < 1 or own_rows(edge) < vim.api.nvim_win_get_height(0) - 1 then
        return
      end
      G._sms[win] = true
      vim.cmd('noautocmd setlocal smoothscroll')
      local group = vim.api.nvim_create_augroup('devhub_smoothscroll_' .. win, { clear = true })
      vim.api.nvim_create_autocmd('WinScrolled', { group = group, pattern = tostring(win),
        callback = function()
          if not vim.api.nvim_win_is_valid(win)
            or vim.api.nvim_win_call(win, function() return vim.fn.winsaveview().skipcol end) == 0 then
            restore()
          end
        end })
      vim.api.nvim_create_autocmd('BufLeave', { group = group, callback = function()
        if vim.api.nvim_get_current_win() == win then restore() end
      end })
      vim.api.nvim_create_autocmd('WinNew', { group = group, callback = function()
        if vim.fn.win_getid(vim.fn.winnr('#')) == win then
          vim.cmd('noautocmd setlocal nosmoothscroll')
        end
      end })
      vim.api.nvim_create_autocmd('WinClosed', { group = group, pattern = tostring(win),
        callback = function() G._sms[win] = nil; pcall(vim.api.nvim_del_augroup_by_name, 'devhub_smoothscroll_' .. win) end })
    end
    local step = n > 0 and '\\5' or '\\25'
    local rows, done, view = math.abs(n), 0, a
    for _ = 1, 400 do
      if done >= rows then break end
      smooth_if_tall(view)
      vim.cmd('normal! ' .. step)
      local v = vim.fn.winsaveview()
      local d = math.abs(moved(view, v))
      if d == 0 then break end
      if exact_only and done + d > rows then
        -- Past the display. Asked back against the way the display was
        -- going (\`toward\`), never past it: the display would have to go
        -- back to meet it. With it, past is where the display goes on to.
        -- Neither way, the nearer.
        local back
        if toward and toward ~= 0 then back = (n > 0) ~= (toward > 0)
        else back = done + d - rows > rows - done end
        if back then
          vim.cmd('normal! ' .. (n > 0 and '\\25' or '\\5'))
          break
        end
      end
      done, view = done + d, v
    end
    local b = vim.fn.winsaveview()
    if G._sms[win] and (b.skipcol or 0) == 0 then restore() end
    changed = a.topline ~= b.topline or a.topfill ~= b.topfill
      or (a.skipcol or 0) ~= (b.skipcol or 0)
    if exact_only then
      local want = within(vim.fn.line('w0'), vim.fn.line('w$'))
      kept.line = want
      if want ~= b.lnum and vim.fn.foldclosed(want) == -1 then
        vim.fn.cursor(want, 1)
        if kept.curswant == vim.v.maxcol then vim.cmd('normal! $')
        elseif kept.curswant > 0 then vim.cmd('normal! ' .. (kept.curswant + 1) .. '|') end
      end
    end
    local c = vim.fn.winsaveview()
    G._wheel[win] = { line = kept.line, curswant = kept.curswant, lnum = c.lnum, col = c.col }
  end)
  return { changed and 1 or 0, bound }
end
if exact_only then return { -1, bound } end
vim.api.nvim_input_mouse('wheel', n > 0 and 'down' or 'up', '', grid, row, col)
return { 2, bound }
`;
