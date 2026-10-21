/**
 * An Agent's own terminal, as the model keeps it: one per Agent, shown right
 * of whatever the view is when that Agent is the view's, hidden and shown
 * again without its session going, its width remembered, and carried across
 * a restart — including from the files written when terminals were a
 * Workspace's tree of panes.
 */

import { describe, expect, it } from "vitest";
import { AppModel } from "./appModel.js";
import { scratchModel } from "./testWorkspaces.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  displayPath,
  Workspace,
  workspaceId,
  workspaceLocation,
  type WorkspaceId,
} from "./domain.js";
import {
  TERMINAL_DEFAULT_SHARE,
  agentTerminalSessionName,
  clampTerminalShare,
  legacyAgentTerminal,
  placeTerminal,
} from "./agentTerminal.js";
import {
  hydrateModel,
  stateFromSnapshot,
  validateState,
} from "./persistence.js";

const WS_A = workspaceId("550e8400-e29b-41d4-a716-446655440000");
const WS_B = workspaceId("550e8400-e29b-41d4-a716-446655440001");
const AG_A = agentId("550e8400-e29b-41d4-a716-4466554400a0");
const AG_B = agentId("550e8400-e29b-41d4-a716-4466554400b0");
const AG_C = agentId("550e8400-e29b-41d4-a716-4466554400c0");
const T_OLD = "11111111-1111-4111-8111-111111111111";
const T_OTHER = "22222222-2222-4222-8222-222222222222";

const codex = AgentProfile.create(
  agentProfileId("codex"),
  "Codex",
  "codex",
  "codex",
);

function workspace(id: WorkspaceId, path: string): Workspace {
  return new Workspace(
    id,
    workspaceLocation({ kind: "local", path }),
    displayPath(path),
  );
}

/** WS_A with two Agents, WS_B with one and WS_A's first Agent selected. */
function model(): AppModel {
  const made = scratchModel();
  made.addWorkspace(workspace(WS_A, "/dev/a"));
  made.addWorkspace(workspace(WS_B, "/dev/b"));
  made.addAgent(WS_A, AG_A, codex, "tui");
  made.addAgent(WS_A, AG_B, codex, "tui");
  made.addAgent(WS_B, AG_C, codex, "tui");
  made.selectContext({ kind: "agent", agentId: AG_A });
  return made;
}

describe("one terminal per Agent", () => {
  it("is named by its Agent, and shows right of that Agent when opened", () => {
    const m = model();
    expect(m.visibleTerminal()).toBeUndefined();
    m.agentTerminalOpened(AG_A, AG_A, { focus: true });
    expect(m.visibleTerminal()).toMatchObject({
      agentId: AG_A,
      terminalId: AG_A,
      open: true,
    });
    expect(m.paneFocus).toBe(AG_A);
    expect(agentTerminalSessionName(AG_A)).toBe(`tm-${AG_A}`);
    const agent = m
      .snapshot()
      .workspaces.find((one) => one.id === WS_A)
      ?.agents.find((one) => one.id === AG_A);
    expect(agent?.terminal?.terminalId).toBe(AG_A);
    expect(m.snapshot().visibleTerminal?.agentId).toBe(AG_A);
  });

  it("switches with the Agent: each shows its own, and the one left runs on hidden", () => {
    const m = model();
    m.agentTerminalOpened(AG_A, AG_A, { focus: true });
    m.selectContext({ kind: "agent", agentId: AG_B });
    // B has none: nothing on the right, and A's is still there, still open.
    expect(m.visibleTerminal()).toBeUndefined();
    expect(m.agentTerminal(AG_A)?.open).toBe(true);
    expect(m.paneFocus).toBeUndefined();
    m.agentTerminalOpened(AG_B, AG_B);
    expect(m.visibleTerminal()?.agentId).toBe(AG_B);
    m.selectContext({ kind: "agent", agentId: AG_A });
    expect(m.visibleTerminal()?.agentId).toBe(AG_A);
  });

  it("hides and shows without the session going, and the keyboard leaves a hidden one", () => {
    const m = model();
    m.agentTerminalOpened(AG_A, AG_A, { focus: true });
    expect(m.showAgentTerminal(AG_A, false)).toBe(true);
    expect(m.visibleTerminal()).toBeUndefined();
    expect(m.paneFocus).toBeUndefined();
    expect(m.agentTerminal(AG_A)).toMatchObject({ open: false });
    expect(m.showAgentTerminal(AG_A, true, { focus: true })).toBe(true);
    expect(m.paneFocus).toBe(AG_A);
    // Nothing to show for an Agent that has no terminal.
    expect(m.showAgentTerminal(AG_B, true)).toBe(false);
  });

  it("on a Workspace's row, is the Agent it pairs with — last selected, else first", () => {
    const m = model();
    m.agentTerminalOpened(AG_B, AG_B);
    m.selectContext({ kind: "workspace", workspaceId: WS_A });
    // A was the last selected, and it has no terminal.
    expect(m.terminalAgentId()).toBe(AG_A);
    expect(m.visibleTerminal()).toBeUndefined();
    m.selectContext({ kind: "agent", agentId: AG_B });
    m.selectContext({ kind: "workspace", workspaceId: WS_A });
    expect(m.terminalAgentId()).toBe(AG_B);
    expect(m.visibleTerminal()?.agentId).toBe(AG_B);
    // Scratch has no Agent, so no terminal.
    m.selectContext({ kind: "workspace", workspaceId: m.scratchWorkspaceId });
    expect(m.terminalAgentId()).toBeUndefined();
  });

  it("goes when it is closed, or when its Agent does", () => {
    const m = model();
    m.agentTerminalOpened(AG_A, AG_A, { focus: true });
    expect(m.agentTerminalClosed(AG_A)).toBe(true);
    expect(m.paneFocus).toBeUndefined();
    expect(m.agentTerminalClosed(AG_A)).toBe(false);
    m.agentTerminalOpened(AG_C, AG_C);
    m.resizeAgentTerminal(AG_C, 0.6);
    m.agentExited(AG_C);
    expect(m.agentTerminal(AG_C)).toBeUndefined();
    expect(m.terminalShare(AG_C)).toBe(TERMINAL_DEFAULT_SHARE);
  });

  it("remembers its width per Agent, clamped, across a close", () => {
    const m = model();
    expect(m.resizeAgentTerminal(AG_A, 0.7)).toBe(true);
    expect(m.resizeAgentTerminal(AG_A, 0.7)).toBe(false);
    expect(m.terminalShare(AG_B)).toBe(TERMINAL_DEFAULT_SHARE);
    m.agentTerminalOpened(AG_A, AG_A);
    m.agentTerminalClosed(AG_A);
    expect(m.terminalShare(AG_A)).toBe(0.7);
    m.resizeAgentTerminal(AG_A, 5);
    expect(m.terminalShare(AG_A)).toBe(clampTerminalShare(5));
  });
});

describe("which terminals are still running", () => {
  it("closes one whose session a later reading did not find", () => {
    const m = model();
    m.agentTerminalOpened(AG_A, AG_A, { openedAt: 100 });
    m.agentTerminalOpened(AG_B, AG_B, { openedAt: 100 });
    expect(m.observePaneTerminals([WS_A], new Set([AG_B]), 200)).toBe(true);
    expect(m.agentTerminal(AG_A)).toBeUndefined();
    expect(m.agentTerminal(AG_B)).toBeDefined();
  });

  it("keeps one the model learned of after the reading began", () => {
    const m = model();
    m.agentTerminalOpened(AG_A, AG_A, { openedAt: 300 });
    expect(m.observePaneTerminals([WS_A], new Set(), 200)).toBe(false);
    expect(m.agentTerminal(AG_A)).toBeDefined();
  });

  it("says nothing about a Workspace the reading was not about", () => {
    const m = model();
    m.agentTerminalOpened(AG_C, AG_C, { openedAt: 100 });
    expect(m.observePaneTerminals([WS_A], new Set(), 200)).toBe(false);
    expect(m.agentTerminal(AG_C)).toBeDefined();
  });
});

describe("moving the keyboard between panes", () => {
  it("cycles the editor, the Agent and the terminal, wrapping", () => {
    const m = model();
    m.selectContext({ kind: "agent", agentId: AG_A }, "beside");
    m.agentTerminalOpened(AG_A, AG_A);
    // Starting in the Agent half: on to the terminal.
    expect(m.cyclePaneFocus()).toBe(true);
    expect(m.paneFocus).toBe(AG_A);
    // Round to the editor half: the workspace selected beside.
    m.cyclePaneFocus();
    expect(m.paneFocus).toBeUndefined();
    expect(m.selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
      presentation: "beside",
    });
    m.cyclePaneFocus();
    expect(m.selection.context).toEqual({ kind: "agent", agentId: AG_A });
    // And backwards from the Agent half to the editor.
    m.cyclePaneFocus(-1);
    expect(m.selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_A,
    });
  });

  it("goes between the content and the terminal with one pane of content", () => {
    const m = model();
    m.agentTerminalOpened(AG_A, AG_A);
    expect(m.cyclePaneFocus()).toBe(true);
    expect(m.paneFocus).toBe(AG_A);
    expect(m.cyclePaneFocus()).toBe(true);
    expect(m.paneFocus).toBeUndefined();
    expect(m.selection.context).toEqual({ kind: "agent", agentId: AG_A });
  });

  it("is a no-op with one pane on screen, and with the terminal hidden", () => {
    const m = model();
    expect(m.cyclePaneFocus()).toBe(false);
    m.agentTerminalOpened(AG_A, AG_A);
    m.showAgentTerminal(AG_A, false);
    expect(m.cyclePaneFocus()).toBe(false);
  });

  it("only focuses the terminal on screen", () => {
    const m = model();
    m.agentTerminalOpened(AG_C, AG_C);
    expect(m.focusPane({ kind: "terminal", terminalId: AG_C })).toBe(false);
    m.agentTerminalOpened(AG_A, AG_A);
    expect(m.focusPane({ kind: "terminal", terminalId: AG_A })).toBe(true);
    expect(m.focusPane({ kind: "content" })).toBe(true);
    expect(m.paneFocus).toBeUndefined();
  });
});

describe("across a restart", () => {
  function restore(state: ReturnType<typeof stateFromSnapshot>): AppModel {
    return hydrateModel(
      JSON.parse(JSON.stringify(state)) as typeof state,
      [codex],
      workspace(workspaceId("550e8400-e29b-41d4-a716-4466554400ff"), "/x"),
    );
  }

  it("writes each Agent's terminal and width, and reads them back", () => {
    const m = model();
    m.agentTerminalOpened(AG_A, AG_A);
    m.agentTerminalOpened(AG_B, AG_B);
    m.showAgentTerminal(AG_B, false);
    m.resizeAgentTerminal(AG_B, 0.25);
    m.resizeAgentTerminal(AG_C, 0.6);
    const state = stateFromSnapshot(m.snapshot());
    expect(() => validateState(state)).not.toThrow();
    const agents = state.workspaces.flatMap((one) => one.agents);
    const record = (id: string) => agents.find((one) => one.agent_id === id);
    expect(record(AG_A)?.terminal).toEqual({ terminal_id: AG_A, open: true });
    expect(record(AG_A)?.terminal_share).toBeUndefined();
    expect(record(AG_B)).toMatchObject({
      terminal: { terminal_id: AG_B, open: false },
      terminal_share: 0.25,
    });
    expect(record(AG_C)?.terminal).toBeUndefined();
    expect(record(AG_C)?.terminal_share).toBe(0.6);
    for (const one of state.workspaces) {
      expect(one.pane_layout).toBeUndefined();
      expect(one.pane_terminals).toBeUndefined();
    }
    const restored = restore(state);
    // Restored, not opened: the first reading decides.
    expect(restored.agentTerminal(AG_A)).toEqual({
      agentId: AG_A,
      terminalId: AG_A,
      open: true,
      openedAt: 0,
    });
    expect(restored.agentTerminal(AG_B)?.open).toBe(false);
    expect(restored.terminalShare(AG_B)).toBe(0.25);
    expect(restored.terminalShare(AG_C)).toBe(0.6);
  });

  it("refuses a terminal record that is not one", () => {
    const m = model();
    m.agentTerminalOpened(AG_A, AG_A);
    const state = stateFromSnapshot(m.snapshot());
    const record = state.workspaces
      .flatMap((one) => one.agents)
      .find((one) => one.agent_id === AG_A)!;
    record.terminal_share = 2;
    expect(() => validateState(state)).toThrow();
    record.terminal_share = undefined;
    record.terminal = { terminal_id: "nope", open: true };
    expect(() => validateState(state)).toThrow();
  });

  /** A Workspace record as 3de5ad4 wrote it: a tree of panes, its terminals. */
  function legacy(
    state: ReturnType<typeof stateFromSnapshot>,
    id: WorkspaceId,
    layout: unknown,
    terminals: unknown,
  ) {
    const record = state.workspaces.find((one) => one.workspace_id === id)!;
    record.pane_layout = layout;
    record.pane_terminals = terminals;
    return record;
  }

  const OLD_TREE = {
    kind: "split",
    axis: "row",
    ratio: 0.7,
    first: { kind: "content" },
    second: {
      kind: "split",
      axis: "column",
      ratio: 0.5,
      first: { kind: "terminal", terminal_id: T_OLD },
      second: { kind: "terminal", terminal_id: T_OTHER },
    },
  };
  const OLD_TERMINALS = [
    { terminal_id: T_OLD, name: "Terminal 1" },
    { terminal_id: T_OTHER, name: "Terminal 2", command: "npm run dev" },
  ];

  it("gives a Workspace's first terminal from before to its last Agent, and drops the rest", () => {
    const m = model();
    // B was last selected in WS_A.
    m.selectContext({ kind: "agent", agentId: AG_B });
    const state = stateFromSnapshot(m.snapshot());
    legacy(state, WS_A, OLD_TREE, OLD_TERMINALS);
    expect(() => validateState(state)).not.toThrow();
    const restored = restore(state);
    expect(restored.agentTerminal(AG_B)).toEqual({
      agentId: AG_B,
      terminalId: T_OLD,
      open: true,
      openedAt: 0,
    });
    expect(restored.agentTerminal(AG_A)).toBeUndefined();
    expect(restored.agentTerminalById(T_OTHER)).toBeUndefined();
    // Nested on the right: the default width, not a share of a share.
    expect(restored.terminalShare(AG_B)).toBe(TERMINAL_DEFAULT_SHARE);
    // And the next file is the new shape only.
    const next = stateFromSnapshot(restored.snapshot());
    expect(
      next.workspaces.find((one) => one.workspace_id === WS_A)?.pane_layout,
    ).toBeUndefined();
  });

  it("carries the width of a terminal that sat right of the content", () => {
    const carried = legacyAgentTerminal(
      {
        kind: "split",
        axis: "row",
        ratio: 0.7,
        first: { kind: "content" },
        second: { kind: "terminal", terminal_id: T_OLD },
      },
      [{ terminal_id: T_OLD, name: "Terminal 1" }],
    );
    expect(carried?.terminalId).toBe(T_OLD);
    expect(carried?.share).toBeCloseTo(0.3);
  });

  it("gives it to the only Agent when none was last, and to nobody without one", () => {
    const m = model();
    const state = stateFromSnapshot(m.snapshot());
    // WS_B has one Agent and nothing remembered.
    const b = legacy(state, WS_B, OLD_TREE, OLD_TERMINALS);
    b.last_agent_id = undefined;
    // Scratch has none at all.
    legacy(state, m.scratchWorkspaceId, OLD_TREE, OLD_TERMINALS);
    const restored = restore(state);
    expect(restored.agentTerminal(AG_C)?.terminalId).toBe(T_OLD);
  });

  it("drops a layout from before that does not read, without refusing the file", () => {
    const m = model();
    const state = stateFromSnapshot(m.snapshot());
    legacy(state, WS_A, { kind: "spiral" }, [{ terminal_id: "not-a-uuid" }]);
    legacy(state, WS_B, "garbage", "garbage");
    expect(() => validateState(state)).not.toThrow();
    const restored = restore(state);
    expect(restored.agentTerminals()).toEqual([]);
  });
});

describe("where the terminal goes", () => {
  it("takes its share of the width on the right, past a seam", () => {
    const placed = placeTerminal(
      { x: 10, y: 20, width: 1006, height: 500 },
      0.4,
      6,
    );
    expect(placed.terminal).toEqual({ x: 616, y: 20, width: 400, height: 500 });
    expect(placed.seam).toEqual({ x: 610, y: 20, width: 6, height: 500 });
    expect(placed.content).toEqual({ x: 10, y: 20, width: 600, height: 500 });
  });

  it("clamps a share it is asked for", () => {
    expect(clampTerminalShare(0)).toBe(0.15);
    expect(clampTerminalShare(1)).toBe(0.85);
    expect(clampTerminalShare(Number.NaN)).toBe(TERMINAL_DEFAULT_SHARE);
  });
});
