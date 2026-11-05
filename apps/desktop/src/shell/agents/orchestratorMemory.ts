/**
 * Where the Orchestrator screen's left pane was, for the next time it is
 * shown: the tab, the escalation or file open over it, how far its thread was
 * scrolled, and the answer being written.
 *
 * The left pane unmounts whenever the Orchestrator row is not selected
 * (`AgentsApp`), but this page lives for the session, so a module is enough:
 * coming back — Back (prefix+h), the Sidebar's row, `focus orchestrator` —
 * mounts the pane again, and it reads this. Nothing goes to disk; a restart
 * starts on the board. Only the tab is also kept in `sessionStorage`, so it
 * survives a reload of the page as it did before.
 *
 * Back and Forward stay the selection's (`docs/window-and-pages.md`): the
 * escalation is not a place of its own in the app's history, it is what the
 * Orchestrator place was showing, restored with it.
 */

export type BoardTab = "board" | "files";

const TAB_KEY = "devhub.orchestrator.tab";

/** The thread's scroll, and how many entries it had then. */
export interface ThreadScroll {
  readonly top: number;
  readonly entries: number;
}

export interface OrchestratorMemory {
  tab: BoardTab | undefined;
  /** Whether the Closed lane was shown. */
  history: boolean;
  /** The escalation open over the board, and whether it was closed then. */
  escalation: { readonly id: number; readonly closed: boolean } | undefined;
  /** The file open over the tree, and the folders expanded under it. */
  file: string | undefined;
  expanded: readonly string[];
  /** Per `esc:<id>` or `file:<path>`. */
  readonly scroll: Map<string, ThreadScroll>;
  /** The unsent answer, per escalation. */
  readonly drafts: Map<number, string>;
}

function fresh(): OrchestratorMemory {
  return {
    tab: undefined,
    history: false,
    escalation: undefined,
    file: undefined,
    expanded: [],
    scroll: new Map(),
    drafts: new Map(),
  };
}

export const memory: OrchestratorMemory = fresh();

/** For tests: as a fresh page has it. */
export function forgetOrchestratorMemory(): void {
  Object.assign(memory, fresh());
}

/** The tab chosen in this session. */
export function rememberedTab(): BoardTab {
  if (memory.tab !== undefined) return memory.tab;
  try {
    return window.sessionStorage.getItem(TAB_KEY) === "files"
      ? "files"
      : "board";
  } catch {
    return "board";
  }
}

export function rememberTab(tab: BoardTab): void {
  memory.tab = tab;
  try {
    window.sessionStorage.setItem(TAB_KEY, tab);
  } catch {
    // Remembering across a reload is a convenience.
  }
}
