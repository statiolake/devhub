/**
 * What the Orchestrator screen's left pane shows, as part of a place in Back
 * and Forward.
 *
 * The Orchestrator row is one selection, but the pane on it is a small stack
 * of its own — the board (or the Files tab's tree) with an escalation (or a
 * file) pushed over it — and opening an escalation is going somewhere, the
 * way following a link is. So a history entry on the Orchestrator row is the
 * selection *and* this view (`AppModel`), and Back from an escalation is the
 * board it was opened from.
 *
 * Only identity is here: which escalation, which file. How the place looked —
 * the board's scroll, its folded lanes, the tab — is per entry and kept by
 * the page (`shell/agents/orchestratorHistory.ts`), as a browser keeps scroll
 * per entry rather than in the URL.
 *
 * Pure: no DOM, no Node.
 */

import type { OrchestratorPlaceWire } from "../ipc/appShell.js";

export type OrchestratorView = OrchestratorPlaceWire;

export const BOARD_VIEW: OrchestratorView = { kind: "board" };

export function sameOrchestratorView(
  left: OrchestratorView,
  right: OrchestratorView,
): boolean {
  switch (left.kind) {
    case "board":
    case "files":
      return right.kind === left.kind;
    case "escalation":
      return right.kind === "escalation" && right.id === left.id;
    case "file":
      return right.kind === "file" && right.path === left.path;
  }
}

/**
 * The page under a view pushed over one: the board under an escalation, the
 * tree under a file. A page under is its own parent.
 */
export function parentView(view: OrchestratorView): OrchestratorView {
  switch (view.kind) {
    case "escalation":
      return BOARD_VIEW;
    case "file":
      return { kind: "files" };
    default:
      return view;
  }
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
    case "files":
      return { kind: "files" };
    case "escalation":
      return typeof view["id"] === "number" &&
        Number.isSafeInteger(view["id"]) &&
        view["id"] > 0
        ? { kind: "escalation", id: view["id"] }
        : undefined;
    case "file":
      return typeof view["path"] === "string" && view["path"] !== ""
        ? { kind: "file", path: view["path"] }
        : undefined;
    default:
      return undefined;
  }
}
