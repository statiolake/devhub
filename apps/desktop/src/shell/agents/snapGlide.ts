/**
 * How the Smart Buttons box goes onto the composer's edge mid-drag, and how it
 * comes off it.
 *
 * While the box is carried freely it is exactly under the pointer: its place
 * (`right`/`bottom`) follows every move and nothing eases it. Only the two
 * moments its place jumps are animated — entering the snap range, where the
 * place jumps onto the edge, and pulling out past it, where the place jumps
 * back under the pointer. At each the box is drawn where it was a frame
 * before, by a `transform` that makes up the jump, and that offset is then
 * let go of:
 *
 * - **onto the edge** (`data-snapping="in"`): a short decelerating glide,
 *   `SNAP_IN_MS`, so it slides in and sticks;
 * - **off the edge** (`data-snapping="out"`): a spring with a little
 *   overshoot (`SNAP_OUT_SPRING`), so it catches up with the pointer
 *   elastically — the pointer keeps moving meanwhile, the place follows it
 *   one to one, and only the offset springs back to nothing.
 *
 * The place itself is never animated, so nothing is laid out again for the
 * motion; only the box's transform changes from frame to frame. Under Reduce
 * Motion there is no offset: the box is where its place says, at once.
 *
 * It reads the box as drawn — its `right`/`bottom`, and `data-dragging` /
 * `data-anchored` — after each render, so it is told nothing and adds no
 * render of its own.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** How long the glide onto the edge takes. */
export const SNAP_IN_MS = 180;

/**
 * The spring off the edge, per unit mass: about 12% overshoot, at rest in
 * about a third of a second.
 */
export const SNAP_OUT_SPRING = { stiffness: 380, damping: 22 } as const;

/** Under this offset (px) and speed (px/s) the spring is at rest. */
const REST = { offset: 0.5, speed: 8 } as const;

/** The longest frame a step takes, so a stalled tab does not fling the box. */
const MAX_STEP_S = 1 / 30;

export interface Offset {
  readonly x: number;
  readonly y: number;
}

/** Decelerating: fast at first, at rest at the end. */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1);
  return 1 - (1 - clamped) ** 3;
}

/** One step of the spring pulling `offset` to nothing; `dt` in seconds. */
export function springStep(
  offset: Offset,
  velocity: Offset,
  dt: number,
): { readonly offset: Offset; readonly velocity: Offset } {
  const step = Math.min(dt, MAX_STEP_S);
  const { stiffness, damping } = SNAP_OUT_SPRING;
  const vx = velocity.x + (-stiffness * offset.x - damping * velocity.x) * step;
  const vy = velocity.y + (-stiffness * offset.y - damping * velocity.y) * step;
  return {
    offset: { x: offset.x + vx * step, y: offset.y + vy * step },
    velocity: { x: vx, y: vy },
  };
}

/** Whether the spring has come to rest. */
export function springAtRest(offset: Offset, velocity: Offset): boolean {
  return (
    Math.hypot(offset.x, offset.y) < REST.offset &&
    Math.hypot(velocity.x, velocity.y) < REST.speed
  );
}

type Motion =
  | {
      readonly kind: "in";
      readonly from: Offset;
      readonly start: number;
    }
  | {
      readonly kind: "out";
      offset: Offset;
      velocity: Offset;
      last: number;
    };

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** "on" snapped mid-drag, "off" carried freely, `undefined` not carried. */
function snapOf(element: HTMLElement): "on" | "off" | undefined {
  if (element.dataset.dragging === undefined) return undefined;
  return element.dataset.anchored === undefined ? "off" : "on";
}

export function useSnapGlide(own: RefObject<HTMLElement | null>): void {
  const before = useRef<
    | {
        readonly element: HTMLElement;
        readonly right: number;
        readonly bottom: number;
        readonly snap: "on" | "off" | undefined;
      }
    | undefined
  >(undefined);
  const motion = useRef<Motion | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);

  /** Where the box is drawn from its place now (in `right`/`bottom` terms). */
  const current = (now: number): Offset => {
    const each = motion.current;
    if (each === undefined) return { x: 0, y: 0 };
    if (each.kind === "out") return each.offset;
    const left = 1 - easeOutCubic((now - each.start) / SNAP_IN_MS);
    return { x: each.from.x * left, y: each.from.y * left };
  };

  const draw = (element: HTMLElement, offset: Offset) => {
    // `right` grows leftwards and `bottom` upwards: the box drawn `offset`
    // further along them is moved the other way on screen.
    element.style.transform =
      offset.x === 0 && offset.y === 0
        ? ""
        : `translate(${String(-offset.x)}px, ${String(-offset.y)}px)`;
  };

  const stop = (element: HTMLElement | undefined) => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    motion.current = undefined;
    if (element) {
      draw(element, { x: 0, y: 0 });
      delete element.dataset.snapping;
    }
  };

  const tick = (element: HTMLElement) => (now: number) => {
    const each = motion.current;
    if (each === undefined) return;
    if (each.kind === "in") {
      if (now - each.start >= SNAP_IN_MS) {
        stop(element);
        return;
      }
      draw(element, current(now));
    } else {
      const next = springStep(
        each.offset,
        each.velocity,
        (now - each.last) / 1000,
      );
      each.offset = next.offset;
      each.velocity = next.velocity;
      each.last = now;
      if (springAtRest(each.offset, each.velocity)) {
        stop(element);
        return;
      }
      draw(element, each.offset);
    }
    frame.current = requestAnimationFrame(tick(element));
  };

  useLayoutEffect(() => {
    const element = own.current;
    const previous = before.current;
    if (!element) {
      before.current = undefined;
      stop(undefined);
      return;
    }
    const right = parseFloat(element.style.right) || 0;
    const bottom = parseFloat(element.style.bottom) || 0;
    const snap = snapOf(element);
    before.current = { element, right, bottom, snap };
    if (
      previous === undefined ||
      previous.element !== element ||
      snap === undefined ||
      previous.snap === undefined ||
      previous.snap === snap ||
      reducedMotion()
    ) {
      return;
    }
    // The place jumped onto the edge or off it: drawn where it was, then let go.
    const now = performance.now();
    const was = current(now);
    const from = {
      x: was.x + previous.right - right,
      y: was.y + previous.bottom - bottom,
    };
    motion.current =
      snap === "on"
        ? { kind: "in", from, start: now }
        : {
            kind: "out",
            offset: from,
            velocity: { x: 0, y: 0 },
            last: now,
          };
    element.dataset.snapping = snap === "on" ? "in" : "out";
    draw(element, from);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(tick(element));
  });

  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );
}
