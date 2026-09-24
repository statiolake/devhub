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
  /** Whether new output will be followed. */
  readonly following: boolean;
  /** Whether output arrived while the person was reading above it. */
  readonly unseen: boolean;
  /** Scroll to the end, which resumes following. */
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

  // The person's scrolls, and the resizes nobody made.
  useLayoutEffect(() => {
    const element = scroller.current;
    const inner = content.current;
    if (!element || !inner) {
      throw new Error("the conversation's scroller was not mounted");
    }
    const onScroll = () => {
      if (element.clientHeight === 0) return;
      const atBottom = isAtBottom(element);
      followingNow.current = atBottom;
      anchor.current = atBottom ? undefined : anchorOf(element, inner);
      setFollowing(atBottom);
      if (atBottom) setUnseen(false);
    };
    const onResize = () => {
      if (element.clientHeight === 0) return;
      if (followingNow.current) toBottom();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onResize);
    observer.observe(element);
    observer.observe(inner);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [scroller, content, toBottom]);

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
    followingNow.current = true;
    anchor.current = undefined;
    setFollowing(true);
    setUnseen(false);
    toBottom();
  }, [toBottom]);

  return { following, unseen, jumpToLatest };
}
