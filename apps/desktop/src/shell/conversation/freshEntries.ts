/**
 * Which transcript entries just arrived, so only those animate in.
 *
 * An entry is fresh when it appears after the transcript was first drawn and
 * it is one of a few that arrived together. The transcript as it loads — or
 * reloads, after being emptied, or a history arriving in one go — is drawn as
 * it is, with nothing rising into place. A sent message whose echo replaces
 * its "sending" bubble is the same message, so it does not animate twice.
 *
 * Once the first draw is in, the transcript itself is marked `data-settled`:
 * what appears inside an entry after that (a permission card, a notice) eases
 * in through a `@starting-style` transition, which applies only to elements
 * created after the mark, never to those already there.
 *
 * The mark is a `data-fresh` attribute put on the entry's element once, after
 * it is laid out. React never writes that attribute, so a re-render (every
 * streamed token) leaves it and the animation alone; the animation runs once,
 * when the attribute first applies.
 *
 * It answers how many draws have marked an entry fresh, so following the
 * end can glide to what arrived rather than jump (`followGlide.ts`); call it
 * before `useFollowScroll`, so the count is read after it was taken.
 */

import { useLayoutEffect, useRef, type RefObject } from "react";
import { isChunk } from "./chunkElements";

/** More new entries than this at once is a load, not output arriving. */
export const FRESH_LIMIT = 4;

/** The transcript's drawn children that are entries (or "sending" bubbles), by id. */
function entriesIn(nodes: Iterable<Node>, into: Map<string, HTMLElement>) {
  for (const node of nodes) {
    if (isChunk(node)) entriesIn((node as Element).children, into);
    else if (node instanceof HTMLElement && node.dataset.entryId !== undefined)
      into.set(node.dataset.entryId, node);
  }
}

/**
 * What arrives is read off the transcript's own mutations — its children and
 * its chunks' (`chunkElements.ts`) — so a draw costs what it added, not a walk
 * of every entry: with thousands of entries that walk was a frame's worth of
 * work in a few dozen draws.
 */
export function useFreshEntries(
  content: RefObject<HTMLElement | null>,
  revision: unknown,
): RefObject<number> {
  const arrivals = useRef(0);
  const watch = useRef<
    | {
        readonly observer: MutationObserver;
        /** How many entries are drawn; `undefined` until the first draw. */
        count: number | undefined;
      }
    | undefined
  >(undefined);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new MutationObserver(() => undefined);
    const observe = (target: Node) =>
      observer.observe(target, { childList: true });
    const observeChunks = (parent: Element) => {
      for (const child of parent.children) {
        if (!isChunk(child)) continue;
        observe(child);
        observeChunks(child);
      }
    };
    observe(element);
    observeChunks(element);
    const present = new Map<string, HTMLElement>();
    entriesIn(element.children, present);
    watch.current = {
      observer,
      count: present.size === 0 ? undefined : present.size,
    };
    if (present.size > 0) settle(element);
    return () => {
      observer.disconnect();
      watch.current = undefined;
    };
  }, [content]);
  useLayoutEffect(() => {
    const element = content.current;
    const state = watch.current;
    if (!element || !state) return;
    const records = state.observer.takeRecords();
    if (records.length === 0) return;
    const added = new Map<string, HTMLElement>();
    const removed = new Map<string, HTMLElement>();
    for (const record of records) {
      const observe = (node: Node) => {
        if (!isChunk(node)) return;
        state.observer.observe(node, { childList: true });
        for (const child of (node as Element).children) observe(child);
      };
      for (const node of record.addedNodes) observe(node);
      entriesIn(record.addedNodes, added);
      entriesIn(record.removedNodes, removed);
    }
    // An entry drawn again in the same draw (moved, or drawn anew under its
    // id) is neither new nor gone, nor is one drawn and gone within it.
    const arrived: HTMLElement[] = [];
    let delta = 0;
    for (const [id, node] of added) {
      if (removed.has(id) || !node.isConnected) continue;
      arrived.push(node);
      delta += 1;
    }
    for (const id of removed.keys()) if (!added.has(id)) delta -= 1;
    const before = state.count;
    const count = (before ?? 0) + delta;
    // Nothing drawn yet, or emptied: whatever comes next is a load.
    state.count = count <= 0 ? undefined : count;
    if (state.count === undefined) {
      delete element.dataset.settled;
      return;
    }
    if (before === undefined) {
      settle(element);
      return;
    }
    if (arrived.length === 0 || arrived.length > FRESH_LIMIT) return;
    const echoed = [...removed.keys()].some(
      (id) => id.startsWith("sending:") && !added.has(id),
    );
    let marked = false;
    for (const child of arrived) {
      if (echoed && child.dataset.kind === "user") continue;
      child.dataset.fresh = "";
      marked = true;
    }
    if (marked) arrivals.current += 1;
  }, [content, revision]);
  return arrivals;
}

/**
 * Mark the transcript drawn, once per load. What is there is styled first, so
 * the mark finds it already drawn and none of it starts a transition.
 */
function settle(element: HTMLElement): void {
  if (element.dataset.settled !== undefined) return;
  void element.offsetHeight;
  element.dataset.settled = "";
}

/**
 * Coming back to a pane does not play its arrivals again.
 *
 * A parked pane is `hidden` — `display: none` — and an element that leaves
 * `display: none` starts its CSS animations over and takes its
 * `@starting-style` again: every entry marked fresh rose in once more, and the
 * activity line, a queued message, a request card, each time somebody
 * switched back to the Agent (or back from a maximized subagent). What
 * arrived was seen arriving, or arrived while nobody was looking; neither is
 * news when the pane is shown.
 *
 * So on being shown, before the frame is painted, every finite animation and
 * transition in the pane is run to its end. The ones that repeat (the
 * activity dots, a spinner) are what the pane is doing now, and are left to
 * run. `view` is what else, while shown, hides one part of the pane and shows
 * another (the subagent maximized), so that changing does the same.
 */
export function useNoReplayOnShow(
  root: RefObject<HTMLElement | null>,
  hidden: boolean,
  view: unknown,
): void {
  const previous = useRef<{ hidden: boolean; view: unknown } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { hidden, view };
    if (before === undefined || hidden) return;
    if (!before.hidden && before.view === view) return;
    const element = root.current;
    if (element) settleAnimations(element);
  }, [root, hidden, view]);
}

/** Every finite animation and transition under `root`, at its end. */
export function settleAnimations(root: Element): void {
  // Not in jsdom; and asking computes styles, which is what starts the
  // animations an element leaving `display: none` gets.
  if (typeof root.getAnimations !== "function") return;
  for (const animation of root.getAnimations({ subtree: true })) {
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end !== "number" || !Number.isFinite(end)) continue;
    animation.finish();
  }
}
