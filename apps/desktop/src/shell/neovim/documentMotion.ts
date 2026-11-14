/**
 * A `gui.document`'s scroll in motion: the arithmetic, pure (the page draws
 * it, `DocumentPane.tsx`). It moves as a Neovim window does
 * (`smoothScroll.ts`), with its timings and its ease:
 *
 * - A key's scroll, and a line the drawing follows (the editor's top, a
 *   search in its window), eases from where the drawing is shown to where
 *   it goes in `EASE_MS`. A new one mid-way starts from where the drawing is
 *   then: it turns without a jump. One further than a screen slides in its
 *   last screen only, as Neovim's ghost would.
 * - The wheel is pixel for pixel. A tick — the first event after a pause of
 *   `TICK_GAP_MS`, or the first the other way (`wheelLines.ts`) — moves at
 *   least a line, gliding there in `GLIDE_MS`, as does an event of a line or
 *   more (a mouse's notch), from where the drawing is shown; the pixels
 *   after a tick pay its line back before the drawing moves on, and while
 *   a glide is on a swipe's few pixels move where it ends, not where it is.
 * - Reduce Motion: everything is placed at once.
 *
 * Each move says who made it (`cause`): the page (a key in its window, the
 * wheel), which the source follows, or a line the page itself follows,
 * which is told to its window but never back to the source — so neither
 * side chases the other's frames.
 */

import { EASE_MS, GLIDE_MS, easeOut } from "./smoothScroll";
import { TICK_GAP_MS } from "./wheelLines";

/**
 * Who moved the drawing: the person in it ("page": a key in its window, the
 * wheel, a link to a heading), or something it follows ("follow": the
 * source's top, `scroll_to`; "neovim": its own window moved by Neovim).
 */
export type MotionCause = "page" | "follow" | "neovim";

export interface DocumentMotion {
  /** Where the drawing is shown, in pixels from its top. */
  top: number;
  /** Where it is going. */
  to: number;
  /** The move in flight: from where, since when, how long; a glide's end is `to`. */
  anim:
    | {
        readonly from: number;
        readonly start: number;
        readonly ms: number;
        readonly glide: boolean;
      }
    | undefined;
  cause: MotionCause;
  /** The last wheel event: its time and direction. */
  wheelAt: number;
  dir: number;
  /** Pixels a tick moved ahead of the wheel, which its next pixels pay. */
  credit: number;
}

export function newMotion(top = 0): DocumentMotion {
  return {
    top,
    to: top,
    anim: undefined,
    cause: "page",
    wheelAt: -Infinity,
    dir: 0,
    credit: 0,
  };
}

function clamp(y: number, max: number): number {
  return Math.min(Math.max(0, max), Math.max(0, y));
}

/** Where the drawing is shown at `now` (nothing changed). */
export function shownAt(m: DocumentMotion, now: number): number {
  const a = m.anim;
  if (!a) return m.to;
  if (a.ms <= 0) return m.to;
  const t = (now - a.start) / a.ms;
  if (t >= 1) return m.to;
  return a.from + (m.to - a.from) * easeOut(Math.max(0, t));
}

/** Whether it is still moving. */
export function moving(m: DocumentMotion): boolean {
  return m.anim !== undefined;
}

/**
 * Ease to `to` (clamped to `max`): a key's scroll or a followed line. From
 * where it is shown now; at once without `animate` (Reduce Motion).
 */
export function easeTo(
  m: DocumentMotion,
  to: number,
  now: number,
  viewport: number,
  max: number,
  cause: MotionCause,
  animate = true,
): void {
  const from = shownAt(m, now);
  m.to = clamp(to, max);
  m.cause = cause;
  m.credit = 0;
  if (!animate || Math.abs(m.to - from) < 0.5) {
    m.top = m.to;
    m.anim = undefined;
    return;
  }
  const d = m.to - from;
  const start =
    Math.abs(d) > viewport && viewport > 0
      ? m.to - Math.sign(d) * viewport
      : from;
  m.top = start;
  m.anim = { from: start, start: now, ms: EASE_MS, glide: false };
}

/**
 * The wheel moved `dy` pixels (down positive), `line` pixels a line: see
 * the file's comment.
 */
export function wheelBy(
  m: DocumentMotion,
  dy: number,
  now: number,
  line: number,
  max: number,
  animate = true,
): void {
  if (dy === 0) return;
  const dir = Math.sign(dy);
  const tick = dir !== m.dir || now - m.wheelAt > TICK_GAP_MS;
  m.wheelAt = now;
  m.dir = dir;
  let px = dy;
  if (tick) {
    m.credit = 0;
    if (Math.abs(dy) < line) {
      px = dir * line;
      m.credit = px - dy;
    }
  } else if (m.credit !== 0 && Math.sign(m.credit) === dir) {
    const pay = Math.min(Math.abs(dy), Math.abs(m.credit));
    px = dy - dir * pay;
    m.credit -= dir * pay;
  }
  const from = shownAt(m, now);
  const base = m.anim ? m.to : from;
  m.to = clamp(base + px, max);
  m.cause = "page";
  if (!animate) {
    m.top = m.to;
    m.anim = undefined;
    return;
  }
  // A tick, a notch's worth (a mouse's 120 px), or a key's ease in flight:
  // a glide there, from where it is shown — a new one mid-way turns without
  // a jump. A swipe's few pixels while a glide is on move where it ends.
  if (tick || Math.abs(px) >= line || (m.anim && !m.anim.glide)) {
    m.top = from;
    m.anim = { from, start: now, ms: GLIDE_MS, glide: true };
    return;
  }
  if (m.anim) return;
  // Within a swipe: under the finger.
  m.top = m.to;
}

/** One frame: where the drawing is shown now; true while it still moves. */
export function frame(m: DocumentMotion, now: number): boolean {
  m.top = shownAt(m, now);
  const a = m.anim;
  if (a && (a.ms <= 0 || now - a.start >= a.ms)) m.anim = undefined;
  return m.anim !== undefined;
}

/**
 * Something else moved the drawing (its scroll bar dragged, the page's own
 * find): it is there, nothing in flight.
 */
export function movedTo(m: DocumentMotion, top: number): void {
  m.top = top;
  m.to = top;
  m.anim = undefined;
  m.credit = 0;
  m.cause = "page";
}

/** The drawing grew or shrank: what is in flight ends inside it. */
export function bounded(m: DocumentMotion, max: number): void {
  m.to = clamp(m.to, max);
  m.top = clamp(m.top, max);
}
