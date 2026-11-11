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
 * An escalation or a file open here is a place of its own in Back and
 * Forward (`orchestratorHistory.ts`, `docs/window-and-pages.md`): the model
 * keeps which one each entry showed, and this memory is what the pane draws
 * from when no snapshot says otherwise.
 */

import type { OrchestratorViewWire } from "../../ipc/contract";
import { devhub } from "./client";

export type BoardTab = "board" | "files";

const TAB_KEY = "devhub.orchestrator.tab";

/** The thread's scroll, and how many entries it had then. */
export interface ThreadScroll {
  readonly top: number;
  readonly entries: number;
}

export interface OrchestratorMemory {
  tab: BoardTab | undefined;
  /** The lanes folded shut: 待機中 and 完了 fold, and both start shut. */
  folded: { waiting: boolean; closed: boolean };
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
    folded: { waiting: true, closed: true },
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
  reported = undefined;
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

/**
 * What the left pane shows now, by id or path: the tab's page, and what is
 * open over it. Read off this memory, which every move updates.
 */
export function orchestratorView(): OrchestratorViewWire {
  if (rememberedTab() === "files")
    return memory.file === undefined
      ? { kind: "board" }
      : { kind: "file", path: memory.file };
  return memory.escalation === undefined
    ? { kind: "board" }
    : { kind: "escalation", id: memory.escalation.id };
}

let reported: string | undefined;

/**
 * Tell main what the pane shows, so the window's title follows
 * (`main/shell/shellTitle.ts`) — once per change: open, Back, Forward, a tab;
 * and `again` when the screen comes back, as it was left.
 */
export function reportOrchestratorView(again = false): void {
  const view = orchestratorView();
  const key = JSON.stringify(view);
  if (key === reported && !again) return;
  const bridge = devhub();
  if (typeof bridge.reportOrchestratorView !== "function") return;
  reported = key;
  bridge.reportOrchestratorView(view);
}
