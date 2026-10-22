/**
 * An Agent's own terminal: one tmux session per Agent, drawn as one pane
 * beside its Agent — to the right of it, or under it when the Agent is the
 * right half of a split with its workbench.
 *
 * A person who wants more than one shell splits *inside* it — it is a whole
 * tmux session — so DevHub draws exactly one terminal pane and never tiles
 * them. What belongs to whom is the point of the design:
 *
 * - **The terminal is the Agent's.** Each Agent has at most one; its session
 *   is `tm-<id>` on the Workspace's machine, started in the Workspace's folder
 *   (the Agent's worktree, when the Workspace is one). Switching to another
 *   Agent shows *that* Agent's terminal, if it has one open; the one left
 *   behind keeps running, detached and hidden, until its Agent goes.
 * - **The terminal and its Agent are a set: one is on screen only with the
 *   other.** The selected Agent's, full (the terminal on its right) or beside
 *   its workbench (the editor on the left, the Agent over the terminal on the
 *   right); with the Workspace's row selected beside an Agent, the Agent that
 *   Workspace pairs with (`pairedAgentId`, the Agent `Cmd+Q Cmd+J` goes to).
 *   The workbench alone shows no Agent, so it shows no terminal either — the
 *   one it would have runs on hidden, its `open` untouched for when its Agent
 *   is back on screen.
 * - **Open and size are per Agent**, and persisted with it: `Cmd+Q V` hides
 *   and shows the pane without touching the session, and each divider's
 *   position — the width beside a full Agent, the height under a split's —
 *   is remembered for the next time it is shown that way.
 *
 * The pane ends when its session does — `Cmd+Q X` with the keyboard in it,
 * `devhub --tell terminal close`, its shell exiting, or its Agent
 * being stopped.
 *
 * Everything here is pure: what the model keeps, the rectangles the window
 * lays it into, and the reading of the layout files written before this (the
 * tree of panes a Workspace had at 3de5ad4, see `legacyAgentTerminal`).
 */

/**
 * The terminal's share of the area it divides with its Agent — the width
 * beside a full Agent, the height under a split's — as far as the divider may
 * take it, and where it starts. One range for both, each kept apart.
 */
export const TERMINAL_MIN_SHARE = 0.15;
export const TERMINAL_MAX_SHARE = 0.85;
export const TERMINAL_DEFAULT_SHARE = 0.4;

/** What the model keeps about one Agent's terminal while its session is up. */
export interface AgentTerminal<AgentKey extends string = string> {
  readonly agentId: AgentKey;
  /**
   * The id its session is named by (`tm-<terminalId>`). The Agent's own id
   * for every terminal DevHub opens now; a terminal carried over from a file
   * written when terminals were the Workspace's keeps the UUID it had, so its
   * running session is not orphaned by the rename.
   */
  readonly terminalId: string;
  /** Drawn when its Agent is the view's — `false` is hidden, still running. */
  readonly open: boolean;
  /**
   * When the model learned of it, in main's clock. A tmux reading that began
   * before this cannot have seen its session, so it cannot close it. `0` for
   * one restored from the state file.
   */
  readonly openedAt: number;
}

/**
 * The tmux session an Agent's terminal is, by its terminal id: `tm-<id>`, the
 * way an Agent's own is `ag-<id>`. Said here because the tmux runtime creates
 * it and an Agent reports it to the person.
 */
export function agentTerminalSessionName(terminalId: string): string {
  return `tm-${terminalId}`;
}

export function clampTerminalShare(share: number): number {
  if (!Number.isFinite(share)) return TERMINAL_DEFAULT_SHARE;
  return Math.min(TERMINAL_MAX_SHARE, Math.max(TERMINAL_MIN_SHARE, share));
}

export function isTerminalShare(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= TERMINAL_MIN_SHARE &&
    value <= TERMINAL_MAX_SHARE
  );
}

//#region rectangles

export interface TerminalRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalPlacement {
  /**
   * What the Agent draws into: the area less the terminal and the seam — the
   * whole selection's pane right of it, or the split's right half above it.
   */
  readonly content: TerminalRect;
  readonly terminal: TerminalRect;
  /** The strip between them, `gap` across — what the divider is drawn in. */
  readonly seam: TerminalRect;
}

/**
 * Where the content and the terminal go inside `area`, the terminal taking
 * `share` of the width on the right. Whole pixels, tiling `area` exactly.
 */
export function placeTerminal(
  area: TerminalRect,
  share: number,
  gap: number,
): TerminalPlacement {
  const available = Math.max(0, area.width - gap);
  const terminalWidth = Math.max(
    0,
    Math.round(available * clampTerminalShare(share)),
  );
  const contentWidth = Math.max(0, area.width - gap - terminalWidth);
  return {
    content: { ...area, width: contentWidth },
    seam: {
      ...area,
      x: area.x + contentWidth,
      width: Math.min(gap, area.width),
    },
    terminal: {
      ...area,
      x: area.x + contentWidth + gap,
      width: Math.max(0, area.width - contentWidth - gap),
    },
  };
}

/**
 * The same, stacked: the terminal taking `share` of `area`'s height at the
 * bottom, under the content. What a split's right half — its Agent — is
 * divided into. Whole pixels, tiling `area` exactly.
 */
export function placeTerminalBelow(
  area: TerminalRect,
  share: number,
  gap: number,
): TerminalPlacement {
  const available = Math.max(0, area.height - gap);
  const terminalHeight = Math.max(
    0,
    Math.round(available * clampTerminalShare(share)),
  );
  const contentHeight = Math.max(0, area.height - gap - terminalHeight);
  return {
    content: { ...area, height: contentHeight },
    seam: {
      ...area,
      y: area.y + contentHeight,
      height: Math.min(gap, area.height),
    },
    terminal: {
      ...area,
      y: area.y + contentHeight + gap,
      height: Math.max(0, area.height - contentHeight - gap),
    },
  };
}

//#endregion

//#region the layout files written before

/**
 * What a Workspace's terminal turns into when a file written while terminals
 * were the Workspace's — a tree of panes (`pane_layout`) and its terminals
 * (`pane_terminals`) — is read now.
 *
 * At most one of them survives, and only when there is an Agent to give it
 * to: the first terminal opened, to the Workspace's last Agent (or its only
 * one), shown, at the width it had when it sat right of the content. The rest
 * are dropped, and their sessions are swept like any session nothing accounts
 * for. Nothing here throws: a layout that does not read is a layout dropped,
 * never a state file refused.
 */
export function legacyAgentTerminal(
  layout: unknown,
  terminals: unknown,
): { readonly terminalId: string; readonly share: number } | undefined {
  if (!Array.isArray(terminals)) return undefined;
  const first: unknown = terminals[0];
  if (typeof first !== "object" || first === null) return undefined;
  const terminalId = (first as Record<string, unknown>)["terminal_id"];
  if (typeof terminalId !== "string" || !UUID.test(terminalId)) {
    return undefined;
  }
  return { terminalId, share: legacyShare(layout, terminalId) };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * The width the terminal had: the share of a side-by-side split at the root
 * whose second half holds it, which is where `Cmd+Q V` used to put one.
 * Anything else — stacked, nested, on the left — starts at the default.
 */
function legacyShare(layout: unknown, terminalId: string): number {
  if (typeof layout !== "object" || layout === null) {
    return TERMINAL_DEFAULT_SHARE;
  }
  const root = layout as Record<string, unknown>;
  const second = root["second"] as Record<string, unknown> | undefined;
  if (
    root["kind"] === "split" &&
    root["axis"] === "row" &&
    typeof root["ratio"] === "number" &&
    second?.["kind"] === "terminal" &&
    second["terminal_id"] === terminalId
  ) {
    return clampTerminalShare(1 - root["ratio"]);
  }
  return TERMINAL_DEFAULT_SHARE;
}

//#endregion
