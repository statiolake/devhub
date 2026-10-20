import { describe, expect, it } from "vitest";
import {
  TERMINALS_IDLE,
  TerminalPanes,
  type TerminalPaneObservation,
} from "./terminalActivity.js";
import { scratchModel } from "./testWorkspaces.js";
import {
  displayPath,
  Workspace,
  workspaceId,
  workspaceLocation,
} from "./domain.js";

const WORKING = { status: "working", unread: undefined } as const;
const UNREAD = { status: "idle", unread: "idle" } as const;

function pane(
  id: string,
  running: boolean,
  inView = false,
): TerminalPaneObservation {
  return { pane: id, running, inView };
}

describe("a Workspace's terminal panes", () => {
  it("is idle and draws nothing until something runs", () => {
    const panes = new TerminalPanes();
    expect(panes.activity).toEqual(TERMINALS_IDLE);
    expect(panes.observe([pane("%1", false)], false)).toBe(false);
    expect(panes.activity).toEqual(TERMINALS_IDLE);
  });

  it("goes working → finished unseen → unread → viewed → read", () => {
    const panes = new TerminalPanes();
    expect(panes.observe([pane("%1", true)], false)).toBe(true);
    expect(panes.activity).toEqual(WORKING);
    // The command exited, or went quiet: the same event here.
    expect(panes.observe([pane("%1", false)], false)).toBe(true);
    expect(panes.activity).toEqual(UNREAD);
    // Still unread round after round while nobody looks.
    expect(panes.observe([pane("%1", false)], false)).toBe(false);
    expect(panes.activity).toEqual(UNREAD);
    // The Workspace is visible, but the pane's window is not on screen.
    expect(panes.observe([pane("%1", false, false)], true)).toBe(false);
    expect(panes.activity).toEqual(UNREAD);
    // Now it is: read.
    expect(panes.observe([pane("%1", false, true)], true)).toBe(true);
    expect(panes.activity).toEqual(TERMINALS_IDLE);
  });

  it("is never unread when it finishes while being looked at", () => {
    const panes = new TerminalPanes();
    panes.observe([pane("%1", true, true)], true);
    panes.observe([pane("%1", false, true)], true);
    expect(panes.activity).toEqual(TERMINALS_IDLE);
  });

  it("goes back to working when output resumes, and unread again when it settles", () => {
    const panes = new TerminalPanes();
    panes.observe([pane("%1", true)], false);
    panes.observe([pane("%1", false)], false);
    expect(panes.activity).toEqual(UNREAD);
    panes.observe([pane("%1", true)], false);
    // Unread is still owed, and drawn as working (`unreadShows`).
    expect(panes.activity).toEqual({ status: "working", unread: "idle" });
    panes.observe([pane("%1", false)], false);
    expect(panes.activity).toEqual(UNREAD);
  });

  it("is read by `read` for the panes on screen only", () => {
    const panes = new TerminalPanes();
    panes.observe([pane("%1", true, true), pane("%2", true, false)], false);
    panes.observe([pane("%1", false, true), pane("%2", false, false)], false);
    expect(panes.activity).toEqual(UNREAD);
    // %1 is read; %2's window is not the one on screen, so it is still owed.
    expect(panes.read()).toBe(false);
    expect(panes.activity).toEqual(UNREAD);
    // %2 closed: nothing left to look at, and so nothing left unread.
    expect(panes.observe([pane("%1", false, true)], false)).toBe(true);
    expect(panes.activity).toEqual(TERMINALS_IDLE);
  });

  it("rolls several panes up: working if any is, unread if any is", () => {
    const panes = new TerminalPanes();
    panes.observe([pane("%1", true), pane("%2", true)], false);
    panes.observe([pane("%1", false), pane("%2", true)], false);
    expect(panes.activity).toEqual({ status: "working", unread: "idle" });
  });

  it("forgets a pane that closed, unread included", () => {
    const panes = new TerminalPanes();
    panes.observe([pane("%1", true)], false);
    panes.observe([pane("%1", false)], false);
    expect(panes.observe([], false)).toBe(true);
    expect(panes.activity).toEqual(TERMINALS_IDLE);
    // A pane first seen idle was never seen working: no unread.
    panes.observe([pane("%3", false)], false);
    expect(panes.activity).toEqual(TERMINALS_IDLE);
  });
});

describe("the model's half of seen", () => {
  const WS = workspaceId("550e8400-e29b-41d4-a716-446655440000");

  function model() {
    const app = scratchModel();
    app.addWorkspace(
      new Workspace(
        WS,
        workspaceLocation({ kind: "local", path: "/dev/a" }),
        displayPath("/dev/a"),
      ),
    );
    return app;
  }

  function terminalsOf(app: ReturnType<typeof model>) {
    return app.snapshot().workspaces.find((one) => one.id === WS)?.terminals;
  }

  it("raises unread for a Workspace nobody is looking at, and clears it when it is selected", () => {
    const app = model();
    app.setWindowFocused(true);
    app.observeTerminalActivity([
      { workspaceId: WS, panes: [pane("%1", true, true)] },
    ]);
    expect(terminalsOf(app)).toEqual(WORKING);
    app.observeTerminalActivity([
      { workspaceId: WS, panes: [pane("%1", false, true)] },
    ]);
    expect(terminalsOf(app)).toEqual(UNREAD);
    app.selectContext({ kind: "workspace", workspaceId: WS });
    expect(terminalsOf(app)).toEqual(TERMINALS_IDLE);
  });

  it("is not seen while DevHub is behind another window, and is read when it comes back", () => {
    const app = model();
    app.setWindowFocused(true);
    app.selectContext({ kind: "workspace", workspaceId: WS });
    app.setWindowFocused(false);
    app.observeTerminalActivity([
      { workspaceId: WS, panes: [pane("%1", true, true)] },
    ]);
    app.observeTerminalActivity([
      { workspaceId: WS, panes: [pane("%1", false, true)] },
    ]);
    expect(terminalsOf(app)).toEqual(UNREAD);
    app.setWindowFocused(true);
    expect(terminalsOf(app)).toEqual(TERMINALS_IDLE);
  });

  it("finishing on screen raises nothing", () => {
    const app = model();
    app.setWindowFocused(true);
    app.selectContext({ kind: "workspace", workspaceId: WS });
    app.observeTerminalActivity([
      { workspaceId: WS, panes: [pane("%1", true, true)] },
    ]);
    app.observeTerminalActivity([
      { workspaceId: WS, panes: [pane("%1", false, true)] },
    ]);
    expect(terminalsOf(app)).toEqual(TERMINALS_IDLE);
  });

  it("skips a Workspace it does not have, and only bumps the revision on a change", () => {
    const app = model();
    const before = app.snapshot().revision;
    app.observeTerminalActivity([
      { workspaceId: "gone", panes: [pane("%1", true)] },
      { workspaceId: WS, panes: [pane("%1", false)] },
    ]);
    expect(app.snapshot().revision).toBe(before);
  });
});
