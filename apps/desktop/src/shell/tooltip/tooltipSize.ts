/**
 * How big the tooltip is, measured and told to main.
 *
 * The same bargain the notices keep, and it is worth restating because it is
 * the reason this page exists in the shape it does. A `WebContentsView` is a
 * native view whose hit testing is by rectangle: every click inside its bounds
 * belongs to it whether or not anything is painted there, and Electron 42
 * gives a view no way to stand aside (`main/shell/toastsView.ts` records the
 * measurement). So this view is exactly as big as the box it draws, and this
 * is the page saying how big that is.
 *
 * What main cannot work out for itself is precisely this number: how tall a
 * sentence is depends on where it wraps, which depends on the font the theme
 * is wearing and on the maximum width in `tooltipPage.css`. Everything *else*
 * about the placement — which side of the row, whether it flips, whether it is
 * clamped — main decides, because those depend on the window and this page
 * cannot see the window.
 *
 * Nothing to say is a size of zero, and it is the one thing this page has to
 * be sure to say: a tooltip that went down and did not report it would be an
 * invisible rectangle over the editor for the rest of the session.
 */

import { useCallback, useEffect, useRef } from "react";
import { devhub } from "./client";

function same(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * A ref for the tooltip's box, which reports its size whenever it changes.
 *
 * `drawn` is a dependency because the element itself goes away when there is
 * nothing to draw: a `ResizeObserver` on a detached node reports nothing at
 * all, so "the tooltip is gone" has to be said by the effect that watched it
 * rather than by the observer that no longer can. It is also the thing that
 * *changes* the size — a different row is a different sentence — so
 * re-measuring on it is not an optimisation, it is the measurement.
 *
 * It is `unknown` rather than the lines themselves because this hook has no
 * business reading them: what it needs is a value that changes when the box
 * does, and the page has one — the array it just rendered.
 */
export function useTooltipSize(
  /** What is being drawn. Its identity is what says the box is a new size. */
  drawn: unknown,
): (element: HTMLElement | null) => void {
  const element = useRef<HTMLElement | null>(null);
  const sent = useRef({ width: 0, height: 0 });

  const report = useCallback((width: number, height: number) => {
    const size = { width: Math.ceil(width), height: Math.ceil(height) };
    if (same(size, sent.current)) return;
    sent.current = size;
    devhub().reportTooltipSize(size);
  }, []);

  const measure = useCallback((next: HTMLElement | null) => {
    element.current = next;
  }, []);

  useEffect(() => {
    const node = element.current;
    if (!node || drawn === undefined) {
      report(0, 0);
      return;
    }
    const observer = new ResizeObserver(() => {
      const box = node.getBoundingClientRect();
      report(box.width, box.height);
    });
    observer.observe(node);
    const box = node.getBoundingClientRect();
    report(box.width, box.height);
    return () => {
      observer.disconnect();
    };
  }, [drawn, report]);

  return measure;
}
