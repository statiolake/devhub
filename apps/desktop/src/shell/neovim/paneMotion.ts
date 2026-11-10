/**
 * Pane motion (`docs/pane-motion.md`): how panes move between the layout on
 * screen and the one tmux or Neovim just committed. Pure: the surfaces own
 * the elements (`GridPainter.motionGroup`) and the clock.
 *
 * A transition is one clock and a track per pane, matched by identity. A
 * track interpolates the pane's clip (its four edges), the origin of its
 * content (where its grid's first cell is drawn) and its opacity, each
 * snapped to device pixels every frame, and ends on its resting placement
 * exactly: once a track's time is up it answers `to` itself, never a value
 * of the curve.
 */

/** A cubic Bézier easing, as CSS's `cubic-bezier()`: monotone in [0, 1]. */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (s: number) => ((ax * s + bx) * s + cx) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const y = (s: number) => ((ay * s + by) * s + cy) * s;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton, then bisection where the slope is flat.
    let s = t;
    for (let i = 0; i < 8; i += 1) {
      const err = x(s) - t;
      if (Math.abs(err) < 1e-7) return y(s);
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 40; i += 1) {
      const v = x(s);
      if (Math.abs(v - t) < 1e-7) break;
      if (v < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return y(s);
  };
}

/**
 * WinUI's point to point (Windows 11, "Timing and easing"): leaves at
 * moderate speed and brakes hard onto its end, with no overshoot.
 */
export const POINT_TO_POINT = cubicBezier(0.55, 0.55, 0, 1);

/** WinUI's durations: `ControlFast` and `ControlNormal`, `ControlFaster`. */
export const PANE_MS = { structural: 167, zoom: 250, step: 83 } as const;

/**
 * WinUI's horizontal slide (`SlideNavigationTransitionInfo`, `FromRight`
 * and `FromLeft`, in `microsoft-ui-xaml` `ThemeTransitions.cpp`): the page
 * going away travels 150 px on (0.7, 0, 1, 0.5) in 150 ms, the page
 * arriving comes 200 px on (0.1, 0.9, 0.2, 1) in 300 ms. WinUI plays them
 * one after the other; here they run at once, the arriving window opaque
 * over the leaving one, so the new window is on screen from the first
 * frame (what is typed shows where it stays) and nothing is drawn twice.
 */
export const SLIDE = {
  exitMs: 150,
  exitOffset: 150,
  exitCurve: cubicBezier(0.7, 0, 1, 0.5),
  enterMs: 300,
  enterOffset: 200,
  enterCurve: cubicBezier(0.1, 0.9, 0.2, 1),
} as const;

/** A zoom's other panes travel this much of the zoomed pane's edge travel. */
export const RECEDE = 0.3;

/** A pane's clip, in CSS pixels of the surface. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Where a pane is drawn: its clip, the origin of its content (its grid's
 * first cell, in CSS pixels of the surface) and its opacity.
 */
export interface Place {
  readonly rect: Rect;
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
}

export type Role = "keep" | "new" | "gone";

export interface Track<K> {
  readonly key: K;
  readonly role: Role;
  readonly from: Place;
  readonly to: Place;
  readonly ms: number;
  readonly curve: (t: number) => number;
  /** How it stacks among the moving panes: higher is drawn over lower. */
  readonly layer: number;
}

const snapTo = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

export class Transition<K> {
  readonly tracks: ReadonlyMap<K, Track<K>>;

  constructor(
    readonly t0: number,
    tracks: readonly Track<K>[],
  ) {
    this.tracks = new Map(tracks.map((t) => [t.key, t]));
  }

  /** When the last track is at rest. */
  get end(): number {
    let ms = 0;
    for (const t of this.tracks.values()) ms = Math.max(ms, t.ms);
    return this.t0 + ms;
  }

  done(now: number): boolean {
    return now >= this.end;
  }

  /**
   * Each pane's place at `now`, every edge and origin on device pixels. A
   * track whose time is up answers its `to`, as given.
   */
  at(now: number, dpr: number): Map<K, Place> {
    const out = new Map<K, Place>();
    for (const track of this.tracks.values())
      out.set(track.key, placeAt(track, now - this.t0, dpr));
    return out;
  }
}

/** One track's place `elapsed` ms in. */
export function placeAt<K>(
  track: Track<K>,
  elapsed: number,
  dpr: number,
): Place {
  if (track.ms <= 0 || elapsed >= track.ms) return track.to;
  const p = track.curve(Math.max(0, elapsed / track.ms));
  const { from, to } = track;
  const mix = (a: number, b: number) => snapTo(a + (b - a) * p, dpr);
  return {
    rect: {
      left: mix(from.rect.left, to.rect.left),
      top: mix(from.rect.top, to.rect.top),
      right: mix(from.rect.right, to.rect.right),
      bottom: mix(from.rect.bottom, to.rect.bottom),
    },
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    opacity: from.opacity + (to.opacity - from.opacity) * p,
  };
}

/** `place` moved by (dx, dy), clip and content together. */
export function shifted(place: Place, dx: number, dy: number): Place {
  return {
    rect: {
      left: place.rect.left + dx,
      top: place.rect.top + dy,
      right: place.rect.right + dx,
      bottom: place.rect.bottom + dy,
    },
    x: place.x + dx,
    y: place.y + dy,
    opacity: place.opacity,
  };
}

/**
 * How many rows a pane's content moved up between two pictures of it:
 * `d` such that the old picture's row `r` is the new one's row `r - d`
 * (a shell's prompt kept at the foot as the pane gets shorter: `d > 0`).
 * Rows are compared as text, trailing blanks dropped, over the columns both
 * have; a row that is blank or shows up more than once in either picture
 * says nothing. The shift most rows agree on wins, the smaller one on a tie;
 * none agreeing is 0: the content stays glued to the pane's top.
 */
export function rowShift(
  before: readonly string[],
  after: readonly string[],
): number {
  const width = Math.min(
    Math.max(0, ...before.map((r) => r.length)),
    Math.max(0, ...after.map((r) => r.length)),
  );
  const key = (row: string) => row.slice(0, width).trimEnd();
  const counts = (rows: readonly string[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r);
      if (k !== "") m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const a = counts(before);
  const b = counts(after);
  const where = new Map<string, number>();
  after.forEach((r, i) => {
    const k = key(r);
    if (b.get(k) === 1) where.set(k, i);
  });
  const votes = new Map<number, number>();
  before.forEach((r, i) => {
    const k = key(r);
    if (k === "" || a.get(k) !== 1) return;
    const j = where.get(k);
    if (j === undefined) return;
    votes.set(i - j, (votes.get(i - j) ?? 0) + 1);
  });
  let best = 0;
  let score = 0;
  for (const [d, n] of votes) {
    if (n > score || (n === score && Math.abs(d) < Math.abs(best))) {
      best = d;
      score = n;
    }
  }
  return best;
}

/** What changed between two layouts, which says how they move. */
export type Change =
  | { readonly kind: "structural" }
  | { readonly kind: "step" }
  | { readonly kind: "zoom"; readonly pane: number; readonly zoomIn: boolean }
  | { readonly kind: "switch"; readonly forward: boolean };

export interface PlanPane<K> {
  readonly key: K;
  /** Its resting place in the committed layout. */
  readonly rest: Place;
  /** Above the other keep panes (the active one, whose outline is over). */
  readonly top?: boolean;
}

/**
 * The tracks from what is on screen to what was committed.
 * - `shown`: each pane's place in the last frame drawn (a resting one, or
 *   mid-way through a transition), the panes on screen now.
 * - `next`: the committed layout's panes at rest.
 * - `anchor`: for a pane in both, where its content's origin is to start
 *   from (the old origin, plus the rows its content moved, `rowShift`); by
 *   default its origin as shown.
 */
export function plan<K>(opts: {
  readonly now: number;
  readonly change: Change;
  readonly shown: ReadonlyMap<K, Place>;
  readonly next: readonly PlanPane<K>[];
  readonly anchor?: (key: K, shown: Place) => { x: number; y: number };
  readonly zoomed?: K;
}): Transition<K> {
  const { change, shown, next } = opts;
  const tracks: Track<K>[] = [];
  const nextKeys = new Set(next.map((p) => p.key));
  if (change.kind === "switch") {
    // The window going away slides on and fades under the one arriving.
    const sign = change.forward ? -1 : 1;
    for (const [key, place] of shown) {
      if (nextKeys.has(key)) continue;
      tracks.push({
        key,
        role: "gone",
        from: place,
        to: { ...shifted(place, sign * SLIDE.exitOffset, 0), opacity: 0 },
        ms: SLIDE.exitMs,
        curve: SLIDE.exitCurve,
        layer: 1,
      });
    }
    for (const pane of next) {
      tracks.push({
        key: pane.key,
        role: "new",
        from: shifted(pane.rest, -sign * SLIDE.enterOffset, 0),
        to: pane.rest,
        ms: SLIDE.enterMs,
        curve: SLIDE.enterCurve,
        layer: 2,
      });
    }
    return new Transition(opts.now, tracks);
  }
  const ms =
    change.kind === "zoom"
      ? PANE_MS.zoom
      : change.kind === "step"
        ? PANE_MS.step
        : PANE_MS.structural;
  const curve = POINT_TO_POINT;
  // A zoom's other panes recede from the zoomed one (`recede`).
  const zoomedFrom =
    opts.zoomed !== undefined ? shown.get(opts.zoomed) : undefined;
  const zoomedTo =
    opts.zoomed !== undefined
      ? next.find((p) => p.key === opts.zoomed)?.rest
      : undefined;
  for (const pane of next) {
    const was = shown.get(pane.key);
    if (was !== undefined) {
      const origin = opts.anchor?.(pane.key, was) ?? { x: was.x, y: was.y };
      tracks.push({
        key: pane.key,
        role: "keep",
        from: {
          rect: was.rect,
          x: origin.x,
          y: origin.y,
          opacity: was.opacity,
        },
        to: pane.rest,
        ms,
        curve,
        layer: pane.top === true ? 4 : 3,
      });
    } else {
      // Uncovered in place; coming back from a zoom, it comes back in.
      const away =
        change.kind === "zoom" && !change.zoomIn && zoomedFrom && zoomedTo
          ? recede(pane.rest.rect, zoomedTo.rect, zoomedFrom.rect)
          : undefined;
      tracks.push({
        key: pane.key,
        role: "new",
        from:
          away === undefined
            ? pane.rest
            : { ...shifted(pane.rest, away.dx, away.dy), opacity: 0 },
        to: pane.rest,
        ms,
        curve,
        layer: 2,
      });
    }
  }
  for (const [key, place] of shown) {
    if (nextKeys.has(key)) continue;
    // Covered where it was; a zoom's others recede as they are covered.
    const away =
      change.kind === "zoom" && change.zoomIn && zoomedFrom && zoomedTo
        ? recede(place.rect, zoomedFrom.rect, zoomedTo.rect)
        : undefined;
    tracks.push({
      key,
      role: "gone",
      from: place,
      to:
        away === undefined
          ? place
          : { ...shifted(place, away.dx, away.dy), opacity: 0 },
      ms,
      curve,
      layer: 1,
    });
  }
  return new Transition(opts.now, tracks);
}

/**
 * How far a pane beside a zoomed one is pushed away as the zoomed pane
 * grows from `small` to `large`: on each axis it lies across the zoomed
 * pane's edge from, `RECEDE` of that edge's travel, away from it.
 */
export function recede(
  pane: Rect,
  small: Rect,
  large: Rect,
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (pane.left >= small.right) dx = (large.right - small.right) * RECEDE;
  else if (pane.right <= small.left) dx = (large.left - small.left) * RECEDE;
  if (pane.top >= small.bottom) dy = (large.bottom - small.bottom) * RECEDE;
  else if (pane.bottom <= small.top) dy = (large.top - small.top) * RECEDE;
  return { dx, dy };
}

/**
 * Whether a switch from window (or tab) `from` to `to` goes forward — the
 * one arriving slides in from the right — by where they are in the order
 * the tab bar shows: `to` after `from`. The order after the switch is
 * asked first (a window just opened is only in it, wherever it was put:
 * `new-window -a`, `-b`, an index, `:tabnew`, `:0tabnew`), then the order
 * before it (a window just closed is only in that one: the window that
 * takes its place comes from the side it was on). Neither knowing both,
 * forward.
 */
export function switchesForward<K>(
  from: K | undefined,
  to: K | undefined,
  before: readonly K[],
  after: readonly K[],
): boolean {
  for (const order of [after, before]) {
    const a = from === undefined ? -1 : order.indexOf(from);
    const b = to === undefined ? -1 : order.indexOf(to);
    if (a >= 0 && b >= 0) return b > a;
  }
  return true;
}

/**
 * What a layout change is, from the panes' rectangles in cells before and
 * after (`a`, `b`, by key): a step when the same panes are there and no
 * edge moved more than `stepCells`; else structural. Zooms and window
 * switches are said by the caller, who knows them from tmux's flags.
 */
export function classify<K>(
  a: ReadonlyMap<K, CellRect>,
  b: ReadonlyMap<K, CellRect>,
  stepCells = 5,
): "structural" | "step" | "same" {
  if (a.size !== b.size) return "structural";
  let moved = 0;
  for (const [key, r] of a) {
    const s = b.get(key);
    if (s === undefined) return "structural";
    moved = Math.max(
      moved,
      Math.abs(r.x - s.x),
      Math.abs(r.y - s.y),
      Math.abs(r.x + r.width - s.x - s.width),
      Math.abs(r.y + r.height - s.y - s.height),
    );
  }
  if (moved === 0) return "same";
  return moved <= stepCells ? "step" : "structural";
}

export interface CellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What `placeGroup` writes to: a painter's motion group's elements. */
export interface GroupElements {
  readonly outer: HTMLElement;
  readonly clipA: HTMLElement;
  readonly clipB: HTMLElement;
  readonly content: HTMLElement;
}

/**
 * A moving pane's group at `place`, as transforms and opacity only: the
 * outer clip to its left and top edges, the inner one to its right and
 * bottom (both the surface's `size`), its ground filling what they cut (the
 * inner clip's box, cut by the outer, is exactly the rectangle), and its
 * content moved from where it is laid out (`laid`, its grid's first cell
 * at rest) to `place`'s origin.
 */
export function placeGroup(
  group: GroupElements,
  place: Place,
  layer: number,
  laid: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  ground: string,
): void {
  const { left: L, top: T, right: R, bottom: B } = place.rect;
  const { width: W, height: H } = size;
  group.outer.style.zIndex = String(layer);
  group.outer.style.opacity = place.opacity >= 1 ? "" : String(place.opacity);
  group.clipA.style.transform = `translate(${String(L)}px, ${String(T)}px)`;
  group.clipB.style.transform = `translate(${String(R - L - W)}px, ${String(B - T - H)}px)`;
  group.clipB.style.background = ground;
  const dx = place.x - laid.x;
  const dy = place.y - laid.y;
  group.content.style.transform = `translate(${String(W - R + dx)}px, ${String(H - B + dy)}px)`;
}

/** Reduce Motion: every transition is placed at once. */
export function reducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
