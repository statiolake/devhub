/**
 * A readable view cut to a height, as a chat app cuts a long snippet: shown
 * up to `CLIP_HEIGHT`, its last lines fading out, with Show all under it.
 * Opened, it is shown whole, with Show less under it.
 *
 * Closing a long view must not leave the person somewhere else in the
 * conversation: the content below it would move up under them. So the button
 * they pressed is kept where it was on screen — the scroller moves by as
 * much as the button did (`anchoredScrollTop`) — and the next line they read
 * is the view's own end, not an entry further down.
 *
 * Whether a view is long is read from its box: what it holds is text,
 * diffs, checklists and images alike, and only the laid-out height says
 * whether they overflow.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Where the scroller must be for an element that moved from `before` to
 * `after` (its top on screen) to be back where it was.
 */
export function anchoredScrollTop(
  scrollTop: number,
  before: number,
  after: number,
): number {
  return scrollTop + (after - before);
}

export function Clip({ children }: { readonly children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  // The toggle's top on screen as the person closed the view.
  const closing = useRef<number | undefined>(undefined);

  // Long or not, re-read whenever the content's size changes.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) throw new Error("a clipped view was not mounted");
    const measure = () => {
      // Opened, the box is not cut, so it stays long until closed again.
      if (element.dataset.open !== undefined) return;
      setLong(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);

  useLayoutEffect(() => {
    const before = closing.current;
    closing.current = undefined;
    if (open || before === undefined) return;
    const button = toggle.current;
    const scroller = button?.closest<HTMLElement>(".conversation-scroll");
    if (!button || !scroller) return;
    scroller.scrollTop = anchoredScrollTop(
      scroller.scrollTop,
      before,
      button.getBoundingClientRect().top,
    );
  }, [open]);

  return (
    <div
      className="conversation-clip"
      data-long={long || undefined}
      data-open={open || undefined}
    >
      <div
        ref={box}
        className="conversation-clip-box"
        data-open={open || undefined}
      >
        {children}
      </div>
      {long ? (
        <button
          ref={toggle}
          type="button"
          className="conversation-clip-toggle"
          aria-expanded={open}
          onClick={() => {
            if (open)
              closing.current = toggle.current?.getBoundingClientRect().top;
            setOpen(!open);
          }}
        >
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}
