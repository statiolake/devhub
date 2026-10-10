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
 */

import { useLayoutEffect, useRef, type RefObject } from "react";

/** More new entries than this at once is a load, not output arriving. */
export const FRESH_LIMIT = 4;

export function useFreshEntries(
  content: RefObject<HTMLElement | null>,
  revision: unknown,
): void {
  const known = useRef<Set<string> | undefined>(undefined);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const present = new Map<string, HTMLElement>();
    for (const child of element.children) {
      const id = (child as HTMLElement).dataset.entryId;
      if (id !== undefined) present.set(id, child as HTMLElement);
    }
    const before = known.current;
    // Nothing drawn yet, or emptied: whatever comes next is a load.
    known.current = present.size === 0 ? undefined : new Set(present.keys());
    if (known.current === undefined) delete element.dataset.settled;
    else if (element.dataset.settled === undefined) {
      // Style what is there first, so the mark finds it already drawn and
      // none of it starts a transition. Once per load.
      void element.offsetHeight;
      element.dataset.settled = "";
    }
    if (before === undefined) return;
    const arrived = [...present].filter(([id]) => !before.has(id));
    if (arrived.length === 0 || arrived.length > FRESH_LIMIT) return;
    const echoed = [...before].some(
      (id) => id.startsWith("sending:") && !present.has(id),
    );
    for (const [, child] of arrived) {
      if (echoed && child.dataset.kind === "user") continue;
      child.dataset.fresh = "";
    }
  }, [content, revision]);
}
