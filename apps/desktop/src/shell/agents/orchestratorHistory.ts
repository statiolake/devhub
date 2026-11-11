/**
 * The Orchestrator pane in Back and Forward: the hooks that keep its stack —
 * the board (or the tree) with an escalation (or a file) over it — and the
 * window's history the same thing.
 *
 * The model holds the history (`model/navigationHistory.ts`); an entry on
 * the Orchestrator row is the selection and the pane's view
 * (`model/orchestratorView.ts`). The pane stays the one that draws, and
 * draws first: a click opens the card in the frame it happens and *then*
 * tells the model (`drawn`), so no input waits for a round trip. The other
 * way, the pane follows the model's `seq`, which moves only when the model
 * moved the pane — Back, Forward, a `devhub:escalation` link — so a word the
 * pane sent never comes back to it as an order.
 *
 * What the pane says, and what it means:
 *
 * - the person opens a card or a file (a click, Enter, a link in a thread):
 *   a navigation, one entry;
 * - its own ‹, Esc, or an answer sent: "up to the board" — Back when Back
 *   leads to the board it was opened from, else a navigation to the board
 *   (`AppModel.leaveOrchestratorView`);
 * - an escalation that left the board while it was read, a tab chosen: the
 *   entry on screen written over, as `replaceState` does.
 *
 * And per entry, as a browser keeps scroll and form state per entry, the
 * board's scroll and its folded lanes (`useEntryState`): Back to an entry
 * puts them back as that entry left them; a new entry starts from how the
 * board is now.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import type {
  AppIntent,
  AppOutcome,
  AppSnapshot,
  OrchestratorPlaceWire,
  OrchestratorViewStateWire,
} from "../../ipc/appShell";
import type { NavStack } from "./navStack";
import { memory, rememberedTab, type BoardTab } from "./orchestratorMemory";

type Dispatch = (intent: AppIntent) => Promise<AppOutcome | undefined>;

/** The model's word on the pane, if the snapshot carries one. */
export function modelView(
  snapshot: AppSnapshot | undefined,
): OrchestratorViewStateWire | undefined {
  return snapshot?.orchestratorView;
}

/** The tab a view is on. */
export function tabOfView(view: OrchestratorPlaceWire): BoardTab {
  return view.kind === "file" || view.kind === "files" ? "files" : "board";
}

/** The tab the screen opens on: the model's view's, else the one remembered. */
export function initialTab(snapshot: AppSnapshot | undefined): BoardTab {
  const state = modelView(snapshot);
  return state === undefined ? rememberedTab() : tabOfView(state.view);
}

/** What the pane shows on `tab`, read off its memory. */
export function paneViewOn(tab: BoardTab): OrchestratorPlaceWire {
  if (tab === "files")
    return memory.file === undefined
      ? { kind: "files" }
      : { kind: "file", path: memory.file };
  return memory.escalation === undefined
    ? { kind: "board" }
    : { kind: "escalation", id: memory.escalation.id };
}

/**
 * Call `follow` with the model's view each time the model moves the pane
 * (`seq`), never at mount: a page mounting reads the view itself.
 */
export function useFollowModelView(
  snapshot: AppSnapshot | undefined,
  follow: (state: OrchestratorViewStateWire) => void,
): void {
  const state = modelView(snapshot);
  const seen = useRef(state?.seq);
  const latest = useRef(follow);
  latest.current = follow;
  const seq = state?.seq;
  useEffect(() => {
    if (state === undefined || seq === seen.current) return;
    seen.current = seq;
    latest.current(state);
    // `state` is read at the `seq` it came with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);
}

export interface StackHistory<T> {
  /** The person opened it: a place of its own. */
  readonly open: (item: T) => void;
  /** Its own way back (‹, Esc, an answer): up to the page under. */
  readonly close: (returnTo?: T) => void;
  /** It went from under the pane: the entry on screen is written over. */
  readonly drop: () => void;
}

/**
 * One stack in the history: `viewOf` names an item as a view, `under` is the
 * page under it, and `find` an item by a view of its kind (undefined: it is
 * not there to show, and the pane stays as it is).
 */
export function useStackHistory<T>({
  stack,
  snapshot,
  dispatch,
  viewOf,
  under,
  find,
}: {
  readonly stack: NavStack<T>;
  readonly snapshot: AppSnapshot | undefined;
  readonly dispatch: Dispatch;
  readonly viewOf: (item: T) => OrchestratorPlaceWire;
  readonly under: OrchestratorPlaceWire;
  readonly find: (view: OrchestratorPlaceWire) => T | undefined;
}): StackHistory<T> {
  const live = useRef({ stack, find, viewOf });
  live.current = { stack, find, viewOf };
  const tell = useCallback(
    (intent: AppIntent) => {
      // A pane without a model to tell (a test's) still draws.
      void dispatch(intent).catch(() => undefined);
    },
    [dispatch],
  );
  const open = useCallback(
    (item: T) => {
      live.current.stack.open(item);
      tell({
        type: "show_orchestrator_view",
        view: live.current.viewOf(item),
        reason: "explicit",
        drawn: true,
      });
    },
    [tell],
  );
  const close = useCallback(
    (returnTo?: T) => {
      live.current.stack.close(returnTo);
      tell({ type: "leave_orchestrator_view", drawn: true });
    },
    [tell],
  );
  const drop = useCallback(() => {
    live.current.stack.close();
    tell({ type: "show_orchestrator_view", view: under, drawn: true });
  }, [tell, under]);
  useFollowModelView(snapshot, ({ view, arrived }) => {
    const { stack: now, find: lookUp, viewOf: name } = live.current;
    if (view.kind === under.kind) {
      if (now.nav === "push" && now.shown !== undefined)
        now.close(undefined, arrived === "forward" ? "forward" : undefined);
      return;
    }
    const item = lookUp(view);
    if (item === undefined) return;
    if (
      now.nav === "push" &&
      now.shown !== undefined &&
      JSON.stringify(name(now.shown)) === JSON.stringify(view)
    )
      return;
    now.open(item, arrived === "back" ? "back" : undefined);
  });
  return { open, close, drop };
}

/** How the board looked at one entry. */
interface BoardEntryState {
  readonly top: number;
  readonly folded: { readonly waiting: boolean; readonly closed: boolean };
}

const boardEntries = new Map<number, BoardEntryState>();

/** For tests: as a fresh page has it. */
export function forgetEntryStates(): void {
  boardEntries.clear();
}

/**
 * The board's scroll and folded lanes, per history entry.
 *
 * Written while the entry is on screen, under its id; read back when an
 * entry that has some comes on screen again — Back, Forward, the pane
 * mounting on it. An entry with nothing written yet (a new navigation)
 * takes the board as it is. Only the board's own: an escalation's thread
 * keeps its scroll per escalation (`orchestratorMemory.ts`).
 */
export function useEntryState(
  entry: number | undefined,
  lanes: RefObject<HTMLElement | null>,
  folded: BoardEntryState["folded"],
  setFolded: (folded: BoardEntryState["folded"]) => void,
): void {
  const pendingTop = useRef<number | undefined>(undefined);
  const latestFolded = useRef(folded);
  latestFolded.current = folded;
  // An entry comes on screen: put back what it had, or file what is here.
  useLayoutEffect(() => {
    if (entry === undefined) return;
    const saved = boardEntries.get(entry);
    if (saved === undefined) {
      boardEntries.set(entry, {
        top: lanes.current?.scrollTop ?? 0,
        folded: latestFolded.current,
      });
      return;
    }
    const was = latestFolded.current;
    if (
      saved.folded.waiting !== was.waiting ||
      saved.folded.closed !== was.closed
    ) {
      memory.folded = { ...saved.folded };
      setFolded(saved.folded);
      // Scrolled once the lanes are laid out folded as they were.
      pendingTop.current = saved.top;
      return;
    }
    if (lanes.current) lanes.current.scrollTop = saved.top;
  }, [entry, lanes, setFolded]);
  useLayoutEffect(() => {
    if (pendingTop.current === undefined) return;
    if (lanes.current) lanes.current.scrollTop = pendingTop.current;
    pendingTop.current = undefined;
  }, [folded, lanes]);
  // What changes while it is on screen is written under it.
  useEffect(() => {
    if (entry === undefined) return;
    const saved = boardEntries.get(entry);
    boardEntries.set(entry, { top: saved?.top ?? 0, folded });
  }, [entry, folded]);
  useEffect(() => {
    const element = lanes.current;
    if (!element || entry === undefined) return;
    const onScroll = () => {
      boardEntries.set(entry, {
        top: element.scrollTop,
        folded: latestFolded.current,
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
    };
  }, [entry, lanes]);
}
