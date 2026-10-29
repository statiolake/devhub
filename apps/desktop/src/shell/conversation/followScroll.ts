/**
 * Following the newest output, and only while the person is there.
 *
 * The rule is one sentence: the transcript follows new output while it is
 * scrolled to the bottom, and stays exactly where it is otherwise. "At the
 * bottom" is re-read from the scroller on every scroll the person makes, so
 * scrolling up is what stops following and scrolling back down is what
 * resumes it — there is no mode to toggle and no timer.
 *
 * What moves the content without the person scrolling — output arriving, the
 * pane being resized, an off-screen entry being laid out for the first time
 * (`content-visibility`) — changes nothing about that answer: a following
 * transcript is put back at the bottom, and one that is not is held in place
 * by the browser's own scroll anchoring (`overflow-anchor`), which is what
 * keeps the entry being read still under a reflow.
 *
 * Only the person leaves the end. Content moves the scroll position without
 * anybody scrolling, and in both directions: what shrinks at the end (a
 * "sending" bubble replaced by its echo, the composer emptied by a send, an
 * entry drawn smaller than the room `content-visibility` kept for it) clamps
 * the position up, and a scroll event is read a frame after the layout it
 * came from — by which time something else may have grown that nothing has
 * followed yet (the Smart Buttons' reserve under the last line, a diagram, a
 * picture, a cut message's Show all). Read as a direction, that was "the
 * person scrolled up, away from the end", and the transcript stopped
 * following on every send. So a scroll leaves the end only while the person
 * is scrolling: a wheel or trackpad turned up, a key that scrolls, a press on
 * the scroller (its scrollbar, a drag selection running past an edge), a
 * touch — or code that moves the view on the person's behalf (find, a
 * reveal) saying so with `markScrollIntent`. Any other scroll of a following
 * transcript is put back at the end.
 *
 * Growth is followed by watching the transcript's border box, padding
 * included (the Smart Buttons' reserve is padding), and the scroller's own
 * box. While following, scroll anchoring is off (`data-following`): the end
 * is the anchor then, and the browser holding some line still would only pull
 * against it.
 *
 * A hidden surface (a parked Agent in the pool) has no box, so nothing it
 * reports means anything: its scrolls and resizes are ignored, and where it
 * was is put back when it is shown again — by entry, not by pixel, because the
 * pane may have been resized while it was parked.
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** How close to the end still counts as the end: sub-pixel scroll positions. */
export const BOTTOM_SLACK_PX = 2;

/**
 * How long after the person's last wheel turn, key or touch a scroll is still
 * theirs: a smooth scroll or a trackpad's momentum runs on after its input.
 * Each scroll that arrives in the window extends it.
 */
export const INTENT_MS = 250;

/** What `markScrollIntent` sends the scroller. */
export const SCROLL_INTENT_EVENT = "devhub-scroll-intent";

/**
 * Code is about to move `scroller` for the person (find's next match, a
 * request revealed): the move is theirs, and leaves the end if it goes away
 * from it.
 */
export function markScrollIntent(scroller: Element): void {
  scroller.dispatchEvent(new Event(SCROLL_INTENT_EVENT));
}

/** Keys that scroll a view, when the keyboard is not in a field. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement)
  );
}

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function isAtBottom(metrics: ScrollMetrics): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <=
    BOTTOM_SLACK_PX
  );
}

/** Where a person was reading: an entry, and how far into it the top edge was. */
interface Anchor {
  readonly entry: string;
  readonly offset: number;
}

/**
 * The first top-level entry whose bottom is below the scroller's top edge.
 * Entries are in document order, so their offsets ascend: a binary search.
 */
function anchorOf(
  scroller: HTMLElement,
  content: HTMLElement,
): Anchor | undefined {
  const entries = content.children;
  const top = scroller.scrollTop;
  let low = 0;
  let high = entries.length - 1;
  let found: HTMLElement | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const element = entries[middle] as HTMLElement;
    if (element.offsetTop + element.offsetHeight > top) {
      found = element;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  const entry = found?.dataset.entryId;
  if (!found || entry === undefined) return undefined;
  return { entry, offset: top - found.offsetTop };
}

function restore(
  scroller: HTMLElement,
  content: HTMLElement,
  anchor: Anchor,
): void {
  for (const element of content.children) {
    if ((element as HTMLElement).dataset.entryId === anchor.entry) {
      scroller.scrollTop = (element as HTMLElement).offsetTop + anchor.offset;
      return;
    }
  }
}

export interface FollowScroll {
  /**
   * Whether new output will be followed: the transcript is at its end. When it
   * is not, the surface offers the way back down (`jumpToLatest`).
   */
  readonly following: boolean;
  /** Whether output arrived since the transcript stopped following. */
  readonly unseen: boolean;
  /** Scroll to the end, which resumes following. Sending a message does this. */
  readonly jumpToLatest: () => void;
}

export function useFollowScroll({
  scroller,
  content,
  hidden,
  revision,
}: {
  readonly scroller: RefObject<HTMLElement | null>;
  readonly content: RefObject<HTMLElement | null>;
  readonly hidden: boolean;
  /** Changes whenever the transcript does: new output to follow, or to flag. */
  readonly revision: unknown;
}): FollowScroll {
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(false);
  // Read by the observers without re-subscribing them on every change.
  const followingNow = useRef(true);
  const anchor = useRef<Anchor | undefined>(undefined);

  const toBottom = useCallback(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [scroller]);

  const setFollowingNow = useCallback(
    (value: boolean) => {
      followingNow.current = value;
      scroller.current?.toggleAttribute("data-following", value);
    },
    [scroller],
  );

  // The person's scrolls, and the resizes nobody made.
  useLayoutEffect(() => {
    const element = scroller.current;
    const inner = content.current;
    if (!element || !inner) {
      throw new Error("the conversation's scroller was not mounted");
    }
    element.toggleAttribute("data-following", followingNow.current);
    /** Until when a scroll is the person's; a press holds it open. */
    let intentUntil = -Infinity;
    let pressed = false;
    const intends = (ms = INTENT_MS) => {
      intentUntil = Math.max(intentUntil, performance.now() + ms);
    };
    const intending = () => pressed || performance.now() < intentUntil;
    const onScroll = () => {
      if (element.clientHeight === 0) return;
      const atBottom = isAtBottom(element);
      if (followingNow.current && !intending()) {
        if (!atBottom) toBottom();
        return;
      }
      // A smooth scroll or momentum still running is still theirs.
      if (intending()) intends(INTENT_MS / 2);
      setFollowingNow(atBottom);
      anchor.current = atBottom ? undefined : anchorOf(element, inner);
      setFollowing(atBottom);
      if (atBottom) setUnseen(false);
    };
    const onResize = () => {
      if (element.clientHeight === 0) return;
      if (followingNow.current) toBottom();
    };
    // A wheel turned down at the end cannot leave it: only up is intent.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 || !followingNow.current) intends();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key) || isEditable(event.target)) return;
      const target = event.target;
      const here =
        target === document.body ||
        target === document.documentElement ||
        (target instanceof Node && element.contains(target));
      if (here) intends(INTENT_MS * 2);
    };
    // A press on the scroller's own box is its scrollbar (or the margin
    // beside the column): held, whatever scrolls is the drag. A press on the
    // words is a selection, which scrolls only once dragged past an edge.
    let pressing = false;
    const onPress = (event: Event) => {
      pressing = true;
      pressed = event.target === element;
    };
    // A finger on the scroller scrolls it, wherever it is put down.
    const onTouch = () => {
      pressing = true;
      pressed = true;
    };
    const onDrag = (event: PointerEvent) => {
      if (!pressing || pressed) return;
      const box = element.getBoundingClientRect();
      if (event.clientY < box.top || event.clientY > box.bottom) intends();
    };
    const onRelease = () => {
      if (!pressing) return;
      if (pressed) intends();
      pressing = false;
      pressed = false;
    };
    const onIntent = () => intends();
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("pointerdown", onPress);
    element.addEventListener("touchstart", onTouch, { passive: true });
    element.addEventListener(SCROLL_INTENT_EVENT, onIntent);
    window.addEventListener("pointermove", onDrag, { passive: true });
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("pointercancel", onRelease);
    window.addEventListener("touchend", onRelease);
    document.addEventListener("keydown", onKey, true);
    const observer = new ResizeObserver(onResize);
    observer.observe(element);
    // The border box: the Smart Buttons' reserve is padding.
    observer.observe(inner, { box: "border-box" });
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPress);
      element.removeEventListener("touchstart", onTouch);
      element.removeEventListener(SCROLL_INTENT_EVENT, onIntent);
      window.removeEventListener("pointermove", onDrag);
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("pointercancel", onRelease);
      window.removeEventListener("touchend", onRelease);
      document.removeEventListener("keydown", onKey, true);
      observer.disconnect();
    };
  }, [scroller, content, toBottom, setFollowingNow]);

  // New output, and being shown again. Either way a following transcript goes
  // to the end. Otherwise new output is flagged, and a surface coming back
  // from the pool is put back on the entry it was showing.
  const seenRevision = useRef(revision);
  const wasHidden = useRef(hidden);
  useLayoutEffect(() => {
    if (hidden) {
      wasHidden.current = true;
      return;
    }
    const element = scroller.current;
    const inner = content.current;
    if (!element || !inner) {
      throw new Error("the conversation's scroller was not mounted");
    }
    const arrived = seenRevision.current !== revision;
    const shown = wasHidden.current;
    seenRevision.current = revision;
    wasHidden.current = false;
    if (followingNow.current) {
      toBottom();
      return;
    }
    if (shown && anchor.current) restore(element, inner, anchor.current);
    if (arrived) setUnseen(true);
  }, [revision, hidden, scroller, content, toBottom]);

  const jumpToLatest = useCallback(() => {
    setFollowingNow(true);
    anchor.current = undefined;
    setFollowing(true);
    setUnseen(false);
    toBottom();
  }, [toBottom, setFollowingNow]);

  return { following, unseen, jumpToLatest };
}
