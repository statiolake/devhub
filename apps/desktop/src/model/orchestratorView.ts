/**
 * What the Orchestrator screen's left pane shows, as part of a place in Back
 * and Forward.
 *
 * The Orchestrator row is one selection, but the pane on it is a small stack
 * of its own — the board with a task pushed over it, or the Terminal tab
 * beside them — and opening a task is going somewhere, the
 * way following a link is. So a history entry on the Orchestrator row is the
 * selection *and* this view (`AppModel`), and Back from a task is the
 * board it was opened from.
 *
 * Only identity is here: which task, or the Terminal tab. How the place
 * looked —
 * the board's scroll, its folded lanes, the tab — is per entry and kept by
 * the page (`shell/agents/orchestratorHistory.ts`), as a browser keeps scroll
 * per entry rather than in the URL.
 *
 * Pure: no DOM, no Node.
 */

import type { OrchestratorPlaceWire } from "../ipc/appShell.js";

export type OrchestratorView = OrchestratorPlaceWire;

export const BOARD_VIEW: OrchestratorView = { kind: "board" };

export const TERMINAL_VIEW: OrchestratorView = { kind: "terminal" };

export function sameOrchestratorView(
  left: OrchestratorView,
  right: OrchestratorView,
): boolean {
  switch (left.kind) {
    case "board":
    case "terminal":
      return right.kind === left.kind;
    case "task":
      return right.kind === "task" && right.id === left.id;
  }
}

/**
 * The page under a view pushed over one: the board under a task. A page
 * under (the board, the Terminal tab) is its own parent.
 */
export function parentView(view: OrchestratorView): OrchestratorView {
  return view.kind === "task" ? BOARD_VIEW : view;
}

/** A page's word for a view, checked; anything else is nothing. */
export function orchestratorPlace(
  value: unknown,
): OrchestratorView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const view = value as Record<string, unknown>;
  switch (view["kind"]) {
    case "board":
      return BOARD_VIEW;
    case "terminal":
      return TERMINAL_VIEW;
    case "task":
      return typeof view["id"] === "number" &&
        Number.isSafeInteger(view["id"]) &&
        view["id"] > 0
        ? { kind: "task", id: view["id"] }
        : undefined;
    default:
      return undefined;
  }
}
