/**
 * The terminals opened beside a Workspace's panes, as the model keeps them:
 * which tree each Workspace has, which pane has the keyboard, what closes a
 * pane, and what the state file says about them across a restart.
 */

import { describe, expect, it } from "vitest";
import { AppModel, type PaneTerminal } from "./appModel.js";
import { scratchModel } from "./testWorkspaces.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  CLEAN_CLOSE_INSPECTION,
  displayPath,
  Workspace,
  workspaceId,
  workspaceLocation,
  type WorkspaceId,
} from "./domain.js";
import { CONTENT_PANE, paneTerminals, terminalPane } from "./paneLayout.js";
import {
  freshState,
  hydrateModel,
  stateFromSnapshot,
  validateState,
} from "./persistence.js";

const WS_A = workspaceId("550e8400-e29b-41d4-a716-446655440000");
const WS_B = workspaceId("550e8400-e29b-41d4-a716-446655440001");
const AG_A = agentId("550e8400-e29b-41d4-a716-4466554400a0");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";

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

function modelWithA(): AppModel {
  const model = scratchModel();
  model.addWorkspace(workspace(WS_A, "/dev/a"));
  model.addWorkspace(workspace(WS_B, "/dev/b"));
  model.selectContext({ kind: "workspace", workspaceId: WS_A });
  return model;
}

function terminal(
  id: string,
  workspaceId: WorkspaceId = WS_A,
  openedAt = 100,
): PaneTerminal {
  return {
    id,
    workspaceId,
    name: `T ${id.slice(0, 1)}`,
    cwd: undefined,
    command: undefined,
    openedAt,
  };
}

describe("opening and closing terminal panes", () => {
  it("splits the pane with the keyboard, and nests inside a terminal", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1), "right", { focus: true });
    expect(model.paneFocus).toBe(T1);
    // The keyboard is in T1, so `below` splits T1, not the content.
    model.openPaneTerminal(terminal(T2), "below", { focus: true });
    expect(model.paneTree(WS_A)).toMatchObject({
      axis: "row",
      first: CONTENT_PANE,
      second: {
        axis: "column",
        first: terminalPane(T1),
        second: terminalPane(T2),
      },
    });
    expect(model.snapshot().paneFocus).toBe(T2);
    const snapshot = model.snapshot().workspaces.find((one) => one.id === WS_A);
    expect(snapshot?.paneTerminals.map((one) => one.id)).toEqual([T1, T2]);
  });

  it("names them in order, reusing a name only once it is free", () => {
    const model = modelWithA();
    expect(model.nextPaneTerminalName(WS_A)).toBe("Terminal 1");
    model.openPaneTerminal({ ...terminal(T1), name: "Terminal 1" }, "right");
    expect(model.nextPaneTerminalName(WS_A)).toBe("Terminal 2");
  });

  it("opens beside the content of a Workspace that is not on screen", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1, WS_B), "below", { focus: true });
    expect(model.paneTree(WS_B)).toMatchObject({ axis: "column" });
    // Not on screen, so it cannot have the keyboard.
    expect(model.paneFocus).toBeUndefined();
    expect(model.paneTree(WS_A)).toEqual(CONTENT_PANE);
  });

  it("gives the keyboard to the neighbour when the focused pane closes", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1), "right", { focus: true });
    model.openPaneTerminal(terminal(T2), "below", { focus: true });
    expect(model.closePaneTerminal(T2)).toBe(true);
    expect(model.paneFocus).toBe(T1);
    expect(model.closePaneTerminal(T1)).toBe(true);
    expect(model.paneFocus).toBeUndefined();
    expect(model.paneTree(WS_A)).toEqual(CONTENT_PANE);
    expect(model.closePaneTerminal(T1)).toBe(false);
  });

  it("takes the keyboard back to the selection's pane on any selection", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1), "right", { focus: true });
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    expect(model.paneFocus).toBeUndefined();
  });

  it("forgets a Workspace's panes when the Workspace closes", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1, WS_B), "right");
    model.closeWorkspace(WS_B, CLEAN_CLOSE_INSPECTION, [
      model.scratchWorkspaceId,
      WS_A,
      WS_B,
    ]);
    expect(model.paneTerminal(T1)).toBeUndefined();
  });

  it("resizes and moves panes through the tree", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1), "right");
    expect(model.resizePaneSplit(WS_A, "", 0.7)).toBe(true);
    expect(model.paneTree(WS_A)).toMatchObject({ ratio: 0.7 });
    expect(model.resizePaneSplit(WS_A, "", 0.7)).toBe(false);
    model.openPaneTerminal(terminal(T2), "right", { beside: terminalPane(T1) });
    expect(model.movePaneTerminal(T2, CONTENT_PANE, "below")).toBe(true);
    expect(model.paneTree(WS_A)).toMatchObject({
      first: { axis: "column", first: CONTENT_PANE, second: terminalPane(T2) },
      second: terminalPane(T1),
    });
  });
});

describe("which terminals are still running", () => {
  it("closes a pane whose session a later reading did not find", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1, WS_A, 100), "right");
    model.openPaneTerminal(terminal(T2, WS_A, 100), "below");
    expect(model.observePaneTerminals([WS_A], new Set([T2]), 200)).toBe(true);
    expect(paneTerminals(model.paneTree(WS_A))).toEqual([T2]);
  });

  it("keeps one the model learned of after the reading began", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1, WS_A, 300), "right");
    expect(model.observePaneTerminals([WS_A], new Set(), 200)).toBe(false);
    expect(model.paneTerminal(T1)).toBeDefined();
  });

  it("says nothing about a Workspace the reading was not about", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1, WS_B, 100), "right");
    expect(model.observePaneTerminals([WS_A], new Set(), 200)).toBe(false);
    expect(model.paneTerminal(T1)).toBeDefined();
  });
});

describe("moving the keyboard between panes", () => {
  /** WS_A's Agent beside its editor, a terminal right of both, one below. */
  function split(): AppModel {
    const model = modelWithA();
    model.addAgent(WS_A, AG_A, codex, "tui");
    model.selectContext({ kind: "agent", agentId: AG_A }, "beside");
    model.openPaneTerminal(terminal(T1), "right");
    model.openPaneTerminal(terminal(T2), "below", {
      beside: terminalPane(T1),
    });
    return model;
  }

  it("cycles the editor, the Agent and every terminal, wrapping", () => {
    const model = split();
    // Starting in the Agent half.
    expect(model.cyclePaneFocus()).toBe(true);
    expect(model.paneFocus).toBe(T1);
    model.cyclePaneFocus();
    expect(model.paneFocus).toBe(T2);
    model.cyclePaneFocus();
    // Round to the editor half: the workspace selected beside.
    expect(model.paneFocus).toBeUndefined();
    expect(model.selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
      presentation: "beside",
    });
    model.cyclePaneFocus();
    expect(model.selection.context).toEqual({ kind: "agent", agentId: AG_A });
    model.cyclePaneFocus(-1);
    expect(model.selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_A,
    });
  });

  it("is a no-op with one pane on screen", () => {
    const model = modelWithA();
    expect(model.cyclePaneFocus()).toBe(false);
  });

  it("goes by direction, through the split's halves first", () => {
    const model = split();
    model.selectContext({ kind: "workspace", workspaceId: WS_A }, "beside");
    // Editor → Agent → T1 → T2, and back up and left.
    expect(model.focusPaneTowards("right")).toBe(true);
    expect(model.selection.context).toEqual({ kind: "agent", agentId: AG_A });
    expect(model.focusPaneTowards("right")).toBe(true);
    expect(model.paneFocus).toBe(T1);
    expect(model.focusPaneTowards("below")).toBe(true);
    expect(model.paneFocus).toBe(T2);
    expect(model.focusPaneTowards("right")).toBe(false);
    expect(model.focusPaneTowards("above")).toBe(true);
    expect(model.paneFocus).toBe(T1);
    expect(model.focusPaneTowards("left")).toBe(true);
    // Into the half facing the pane left: the Agent's.
    expect(model.paneFocus).toBeUndefined();
    expect(model.selection.context).toEqual({ kind: "agent", agentId: AG_A });
  });

  it("only focuses a terminal of the Workspace on screen", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T3, WS_B), "right");
    expect(model.focusPane({ kind: "terminal", terminalId: T3 })).toBe(false);
  });
});

describe("across a restart", () => {
  it("writes the tiling and its terminals, and reads them back", () => {
    const model = modelWithA();
    model.openPaneTerminal(
      { ...terminal(T1), name: "Server", command: "npm run dev" },
      "right",
    );
    model.openPaneTerminal({ ...terminal(T2), cwd: "/dev/a/api" }, "below", {
      beside: terminalPane(T1),
    });
    model.resizePaneSplit(WS_A, "1", 0.3);
    const state = stateFromSnapshot(model.snapshot());
    expect(() => validateState(state)).not.toThrow();
    const record = state.workspaces.find((one) => one.workspace_id === WS_A);
    expect(record?.pane_terminals).toEqual([
      { terminal_id: T1, name: "Server", command: "npm run dev" },
      { terminal_id: T2, name: "T 2", cwd: "/dev/a/api" },
    ]);
    const restored = hydrateModel(
      JSON.parse(JSON.stringify(state)) as typeof state,
      [codex],
      workspace(workspaceId("550e8400-e29b-41d4-a716-4466554400ff"), "/x"),
    );
    expect(restored.paneTree(WS_A)).toEqual(model.paneTree(WS_A));
    expect(restored.paneTerminal(T1)).toMatchObject({
      name: "Server",
      command: "npm run dev",
      // Restored, not opened: the first reading decides.
      openedAt: 0,
    });
    expect(restored.paneTerminal(T2)?.cwd).toBe("/dev/a/api");
  });

  it("writes nothing for a Workspace with no terminals", () => {
    const state = stateFromSnapshot(modelWithA().snapshot());
    for (const record of state.workspaces) {
      expect(record.pane_layout).toBeUndefined();
      expect(record.pane_terminals).toBeUndefined();
    }
  });

  it("refuses a file whose tiling and terminals disagree", () => {
    const model = modelWithA();
    model.openPaneTerminal(terminal(T1), "right");
    const state = stateFromSnapshot(model.snapshot());
    const record = state.workspaces.find((one) => one.workspace_id === WS_A)!;
    record.pane_terminals = [];
    expect(() => validateState(state)).toThrow();
    const fresh = freshState();
    expect(() => validateState(fresh)).not.toThrow();
  });
});
