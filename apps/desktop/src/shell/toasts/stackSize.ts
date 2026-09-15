/**
 * How much room the notices take, measured and told to main.
 *
 * This page's view is exactly as big as what it draws, and nothing bigger. The
 * reason is not thrift: a `WebContentsView` is a native view whose hit testing
 * is by rectangle, so every click inside its bounds belongs to it whether or
 * not anything is painted there, and Electron 42 gives a view no way to stand
 * aside (`main/shell/toastsView.ts` records the measurement). A window-sized
 * transparent notice layer is therefore a window-sized hole in the editor.
 *
 * So the page measures, and main places. The measurement is of the stack's
 * *natural* size, which is why the stack is taken out of the flow and given
 * `width: max-content` with a readable maximum: an out-of-flow element sized
 * by its content is not constrained by the viewport it is in, so the answer
 * does not depend on the rectangle main last gave this view. Without that the
 * measurement would be a function of its own last result, and the stack would
 * ratchet itself narrower one notice at a time.
 *
 * Nothing to say is a size of zero, which is how the view leaves the window
 * altogether. It is the one thing this page has to be sure to say: a stack that
 * emptied and did not report it would be an invisible rectangle over the
 * editor's bottom-right corner for the rest of the session.
 */

import { useCallback, useEffect, useRef } from "react";
import { devhub } from "../client";

/** What was last sent, so an identical measurement is not sent again. */
function same(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * A ref for the stack element, which reports its size whenever it changes.
 *
 * `noticeCount` is a dependency because the element itself goes away when
 * there is nothing to draw: a `ResizeObserver` on a detached node reports
 * nothing at all, so "the stack is gone" has to be said by the effect that
 * watched it rather than by the observer that no longer can.
 */
export function useStackSize(
  noticeCount: number,
): (element: HTMLElement | null) => void {
  const element = useRef<HTMLElement | null>(null);
  const sent = useRef({ width: 0, height: 0 });
  const version = useRef(0);

  const report = useCallback((width: number, height: number) => {
    const size = { width: Math.ceil(width), height: Math.ceil(height) };
    if (same(size, sent.current)) return;
    sent.current = size;
    devhub().reportToastsSize(size);
  }, []);

  const measure = useCallback((next: HTMLElement | null) => {
    element.current = next;
    version.current += 1;
  }, []);

  useEffect(() => {
    const node = element.current;
    if (!node || noticeCount === 0) {
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
  }, [noticeCount, report]);

  return measure;
}
