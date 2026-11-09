/**
 * Things that change place glide there: FLIP measured against the committed
 * layout (docs/motion.md).
 *
 * After each commit `revision` names, every element under `container` that
 * `selector` finds is measured where the layout put it — its place in the
 * container's content, so a scroll is not a move, and with the transform it
 * is gliding on taken off, so a glide is not mistaken for the layout — and
 * one that was somewhere else is put back there by a transform and let go to
 * its place. Where it was is where it was *seen*: its place after the commit
 * before, plus how far a glide still running had it then. A change that
 * arrives mid-glide therefore starts the next glide from exactly where the
 * element is drawn, and every glide ends exactly on the layout: nothing
 * jumps at either end, and nothing moves twice to one change.
 *
 * What arrives (a key not seen before, after the first commit) rises in
 * where it is; what leaves is gone. Under Reduce Motion nothing glides and
 * nothing rises. Keys are the element's identity across commits, so an
 * element drawn anew (a card that changed lanes) glides from where its
 * predecessor was.
 *
 * Only transform and opacity are animated, and only on the elements named:
 * name the leaves (a card, a heading), not what contains them, or a child
 * would glide twice — its own and its parent's.
 */

import { useLayoutEffect, useRef, type RefObject } from "react";

/** How long a glide takes, and its easing: `--motion-slow`, standard. */
export const GLIDE_MS = 240;
const GLIDE_EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** What arrives: `--motion-base`, rising `--motion-rise`, entering. */
const ARRIVE_MS = 180;
const ARRIVE_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const ARRIVE_RISE_PX = 6;

/** Closer than this is the same place: sub-pixel rounding, not a move. */
const STILL_PX = 0.5;

interface Place {
  readonly x: number;
  readonly y: number;
}

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** How far the element's transform has it translated now. */
function translation(element: HTMLElement): Place {
  const transform = getComputedStyle(element).transform;
  if (transform === "" || transform === "none") return { x: 0, y: 0 };
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.m41, y: matrix.m42 };
}

/** Where the layout put `element` in `container`'s content. */
function placeOf(
  element: HTMLElement,
  container: HTMLElement,
  box: DOMRect,
): Place {
  const rect = element.getBoundingClientRect();
  const moved = translation(element);
  return {
    x: rect.left - moved.x - box.left + container.scrollLeft,
    y: rect.top - moved.y - box.top + container.scrollTop,
  };
}

export function useGlide(
  container: RefObject<HTMLElement | null>,
  selector: string,
  keyOf: (element: HTMLElement) => string | undefined,
  revision: unknown,
): void {
  const places = useRef<Map<string, Place> | undefined>(undefined);
  const glides = useRef(new WeakMap<HTMLElement, Animation>());
  const keyOfNow = useRef(keyOf);
  keyOfNow.current = keyOf;

  // Measured again whenever the container's box changes (a resize reflows
  // without a commit), so a glide never starts from a stale place.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (places.current === undefined) return;
      places.current = measure(element, selector, keyOfNow.current);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, selector]);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const before = places.current;
    const box = element.getBoundingClientRect();
    const now = new Map<string, Place>();
    const still = reducedMotion() || typeof element.animate !== "function";
    for (const item of element.querySelectorAll<HTMLElement>(selector)) {
      const key = keyOfNow.current(item);
      if (key === undefined) continue;
      const place = placeOf(item, element, box);
      const track = (animation: Animation) => {
        glides.current.set(item, animation);
        animation.onfinish = () => {
          if (glides.current.get(item) === animation)
            glides.current.delete(item);
        };
      };
      now.set(key, place);
      if (before === undefined || still) continue;
      const was = before.get(key);
      if (was === undefined) {
        const arrival = item.animate(
          [
            { opacity: 0, transform: `translateY(${ARRIVE_RISE_PX}px)` },
            { opacity: 1, transform: "none" },
          ],
          { duration: ARRIVE_MS, easing: ARRIVE_EASING },
        );
        track(arrival);
        continue;
      }
      // Where it is drawn now: its last place, and the glide it is on.
      const running = glides.current.get(item);
      const offset = running ? translation(item) : { x: 0, y: 0 };
      const dx = was.x + offset.x - place.x;
      const dy = was.y + offset.y - place.y;
      running?.cancel();
      glides.current.delete(item);
      if (Math.abs(dx) < STILL_PX && Math.abs(dy) < STILL_PX) continue;
      const glide = item.animate(
        [
          { transform: `translate(${String(dx)}px, ${String(dy)}px)` },
          { transform: "none" },
        ],
        { duration: GLIDE_MS, easing: GLIDE_EASING },
      );
      track(glide);
    }
    places.current = now;
  }, [container, selector, revision]);
}

function measure(
  element: HTMLElement,
  selector: string,
  keyOf: (element: HTMLElement) => string | undefined,
): Map<string, Place> {
  const box = element.getBoundingClientRect();
  const now = new Map<string, Place>();
  for (const item of element.querySelectorAll<HTMLElement>(selector)) {
    const key = keyOf(item);
    if (key !== undefined) now.set(key, placeOf(item, element, box));
  }
  return now;
}
