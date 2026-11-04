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
 *
 * # Why the number is rounded up, and re-taken on every change
 *
 * A view that is a fraction of a pixel smaller than its box is a box that
 * overflows its own document, and a document that overflows shows a
 * scrollbar — which is what a Sidebar hover showed. So the box's border box is
 * read exactly (`getBoundingClientRect`, fractions and all) and rounded *up* to
 * the next whole device pixel; main scales that by the zoom and rounds up
 * again to a whole window pixel (`TooltipView.setSize`). Rounding to the
 * nearest, anywhere on that path, is a box half a pixel too big for its view.
 *
 * And it is taken again whenever the box could have changed: a
 * `ResizeObserver` on the box (fonts landing, glyphs laid out, a wrap moving),
 * a `MutationObserver` on everything in it (the copy button's check, a link's
 * state, new words), and once the document's fonts are ready. The report
 * itself is deduplicated, so re-measuring costs one read.
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
 * A length, up to the next whole device pixel, in CSS pixels.
 *
 * The forgiveness is for float noise: a box that is 220 CSS pixels at a
 * ratio of 1.1 reads back as 220.00000003, which is not a reason to be a
 * pixel bigger than it.
 */
export function upToDevicePixel(length: number, ratio: number): number {
  const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  if (!(length > 0)) return 0;
  return Math.ceil(length * scale - 1e-3) / scale;
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
 * It is `unknown` rather than the content itself because this hook has no
 * business reading it: what it needs is a value that changes when the box
 * does, and the page has one — the content it just rendered.
 */
export function useTooltipSize(
  /** What is being drawn. Its identity is what says the box is a new size. */
  drawn: unknown,
): (element: HTMLElement | null) => void {
  const element = useRef<HTMLElement | null>(null);
  const sent = useRef({ width: 0, height: 0 });

  const report = useCallback((width: number, height: number) => {
    const ratio = window.devicePixelRatio;
    const size = {
      width: upToDevicePixel(width, ratio),
      height: upToDevicePixel(height, ratio),
    };
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
    let live = true;
    const take = () => {
      if (!live || !node.isConnected) return;
      // Content taller than the room main gave the box is cut at its edge
      // under a fade (`tooltipPage.css`). Written only when it changes: this
      // attribute is inside what the mutation observer below watches.
      const capped = node.scrollHeight > node.clientHeight + 1;
      if (node.hasAttribute("data-capped") !== capped) {
        node.toggleAttribute("data-capped", capped);
      }
      const box = node.getBoundingClientRect();
      report(box.width, box.height);
    };
    const resized = new ResizeObserver(take);
    resized.observe(node);
    // A change inside the box that does not move its border box is still
    // re-measured: whether it moved is the measurement's to say.
    const changed = new MutationObserver(take);
    changed.observe(node, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    // Fonts that arrive after the first layout re-wrap the words.
    void document.fonts?.ready.then(take);
    take();
    return () => {
      live = false;
      resized.disconnect();
      changed.disconnect();
    };
  }, [drawn, report]);

  return measure;
}
