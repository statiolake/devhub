/**
 * A landing: a motion already under way eased onto an exact place, in one
 * piece — it leaves at the speed the motion had and arrives at rest, with no
 * stop before it and no second move after it (docs/motion.md, "Scrolling").
 *
 * The path is a cubic Hermite curve from `from` to `to` over `ms`, starting
 * with the motion's own velocity and ending with none. Its starting slope is
 * kept between 1.5 and 3 times the mean speed (`d / ms`): within that the
 * curve only slows down, never speeds up (from 1.5) and never passes its
 * target (up to 3, where it is the ease-out cubic). A motion going faster
 * than that for its distance is let go to 3 times (it slows at once, as its
 * input stopped); one going slower takes the longest allowed and speeds up
 * a little first, as it must to get there.
 *
 * A target that changes mid-way (`retarget`) starts a new curve from where
 * the old one is and at its velocity: position and velocity stay
 * continuous, however often it changes.
 *
 * Pure and framework-free: pixel scrolling of Neovim's windows
 * (`neovim/smoothScroll.ts`) lands on a row with it, and a `gui.document`'s
 * scroll (`neovim/documentMotion.ts`) moves on its curves; anything that
 * scrolls to an exact place after a gesture can.
 */

export interface Landing {
  readonly from: number;
  readonly to: number;
  /** When it starts and how long it takes (ms). */
  readonly start: number;
  readonly ms: number;
  /** The starting slope, in px over the whole curve (velocity × ms). */
  readonly slope: number;
}

export interface LandingOptions {
  /** The shortest landing (ms). */
  readonly minMs?: number;
  /** The longest landing for a distance of `px` (ms). */
  readonly maxMs?: (px: number) => number;
}

/** The shortest landing: three frames, so a short one is still seen eased. */
export const LAND_MIN_MS = 80;

/** A row's worth lands in about 200 ms at most, a long glide in 600. */
export function landMaxMs(px: number): number {
  return Math.min(600, 120 + 6 * px);
}

/** The starting slope over the mean speed the duration is picked for. */
const SLOPE = 2.5;

/**
 * A landing from `from`, moving at `velocity` (px/ms, signed), onto `to`,
 * starting at `now`. A velocity away from `to` counts as none: the curve
 * never goes back.
 */
export function land(
  from: number,
  velocity: number,
  to: number,
  now: number,
  options: LandingOptions = {},
): Landing {
  const d = Math.abs(to - from);
  if (d === 0) return { from, to, start: now, ms: 0, slope: 0 };
  const dir = Math.sign(to - from);
  const v = Math.max(0, velocity * dir);
  const minMs = options.minMs ?? LAND_MIN_MS;
  const maxMs = Math.max(minMs, (options.maxMs ?? landMaxMs)(d));
  const ms = v > 0 ? Math.min(maxMs, Math.max(minMs, (SLOPE * d) / v)) : maxMs;
  const slope = Math.min(3 * d, v * ms);
  return { from, to, start: now, ms, slope: dir * slope };
}

/**
 * A move that starts from rest at its own pace: the ease-out cubic, as a
 * landing (its starting slope three times its mean speed — the fastest that
 * never passes its target). A tick's glide and a key's ease are this.
 */
export function easeOutLanding(
  from: number,
  to: number,
  start: number,
  ms: number,
): Landing {
  return { from, to, start, ms, slope: 3 * (to - from) };
}

/** Where a landing is at `now`, how fast it goes there (px/ms), and whether it is over. */
export function landingAt(
  l: Landing,
  now: number,
): { pos: number; vel: number; done: boolean } {
  const t = l.ms > 0 ? (now - l.start) / l.ms : 1;
  if (t >= 1) return { pos: l.to, vel: 0, done: true };
  const s = Math.max(0, t);
  const d = l.to - l.from;
  const m = l.slope;
  const pos =
    l.from + d * (3 * s * s - 2 * s * s * s) + m * (s - 2 * s * s + s * s * s);
  const vel = (d * (6 * s - 6 * s * s) + m * (1 - 4 * s + 3 * s * s)) / l.ms;
  return { pos, vel, done: false };
}

/** The same landing onto `to` instead, from where and how fast it is at `now`. */
export function retarget(
  l: Landing,
  to: number,
  now: number,
  options?: LandingOptions,
): Landing {
  const { pos, vel } = landingAt(l, now);
  return land(pos, vel, to, now, options);
}

/** Moves every place a landing knows by `d` (the frame it is measured in moved). */
export function moved(l: Landing, d: number): Landing {
  return { ...l, from: l.from + d, to: l.to + d };
}

/**
 * The first multiple of `step` at or past `x` going `dir` (nearest when
 * still): rounding the way a motion goes, never back. Within a millionth of
 * one, it is that one.
 */
export function aheadOf(x: number, step: number, dir: number): number {
  const n = x / step;
  if (dir > 0) return Math.ceil(n - 1e-6) * step;
  if (dir < 0) return Math.floor(n + 1e-6) * step;
  return Math.round(n) * step;
}
