/**
 * The Orchestrator screen's left pane as a navigation stack: a page under
 * (the board, the file tree) and one pushed over it (an escalation, a file).
 *
 * Where the stack is: on the page under (`idle`), a page pushed over it
 * (`push`, which is also where it rests), or the page over going back off to
 * the right (`pop`) before it unmounts. The pane's width is the layout's
 * (`.orchestrator-board`) and none of this touches it: only the two layers
 * move, by transform and opacity (`orchestrator.css`, "the stack").
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export type Nav = "idle" | "push" | "pop";

/** How long a push or a pop takes; `orchestrator.css` says the same. */
export const NAV_MS = 220;

/** The person asked for less motion; without `matchMedia`, assume so. */
export function reducedMotion(): boolean {
  return (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Whether focus is where the pane may move it: inside it, or nowhere. */
export function focusIsOurs(pane: HTMLElement | null): boolean {
  const active = document.activeElement;
  return (
    pane !== null &&
    (active === null || active === document.body || pane.contains(active))
  );
}

export interface NavStack<T> {
  /** What is on the page over, kept through a pop so it slides out whole. */
  readonly shown: T | undefined;
  readonly nav: Nav;
  /** What Back last left, for Forward. */
  readonly forward: T | undefined;
  /**
   * The page over was there when the stack mounted (`initial`): it is
   * where the pane was left, so it is shown as it was — no slide in.
   */
  readonly restored: boolean;
  readonly open: (item: T) => void;
  /**
   * Back to the page under. Focus goes back to what opened the page over,
   * or to `returnTo` when another item is the one to land on.
   */
  readonly close: (returnTo?: T) => void;
}

/**
 * One stack. `findReturn` finds, on the page under, the element that opened
 * an item (a card, a row): focus goes back to it on return — but only when
 * focus was in the pane, so nothing is taken from elsewhere. `initial` is
 * what was open over the page under when the pane was last left
 * (`orchestratorMemory.ts`).
 */
export function useNavStack<T>(
  pane: RefObject<HTMLElement | null>,
  findReturn: (item: T) => HTMLElement | null | undefined,
  initial?: T,
): NavStack<T> {
  const [shown, setShown] = useState<T | undefined>(initial);
  const [nav, setNav] = useState<Nav>(initial === undefined ? "idle" : "push");
  const [restored, setRestored] = useState(initial !== undefined);
  const [forward, setForward] = useState<T | undefined>(undefined);
  const popTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const returnTo = useRef<T | undefined>(undefined);
  const find = useRef(findReturn);
  find.current = findReturn;
  const open = useCallback((item: T) => {
    clearTimeout(popTimer.current);
    returnTo.current = undefined;
    setRestored(false);
    setForward(undefined);
    setShown(item);
    setNav("push");
  }, []);
  const close = useCallback(
    (landOn?: T) => {
      if (shown === undefined) return;
      returnTo.current = focusIsOurs(pane.current)
        ? (landOn ?? shown)
        : undefined;
      setForward(shown);
      setRestored(false);
      clearTimeout(popTimer.current);
      if (reducedMotion()) {
        setShown(undefined);
        setNav("idle");
        return;
      }
      setNav("pop");
      popTimer.current = setTimeout(() => {
        setShown(undefined);
        setNav("idle");
      }, NAV_MS);
    },
    [shown, pane],
  );
  useEffect(() => () => clearTimeout(popTimer.current), []);
  // Back on the page under: focus goes to what opened the page over.
  useLayoutEffect(() => {
    if (nav === "push" || returnTo.current === undefined) return;
    const item = returnTo.current;
    returnTo.current = undefined;
    find.current(item)?.focus({ preventScroll: true });
  }, [nav]);
  return { shown, nav, forward, restored, open, close };
}
