// @vitest-environment jsdom

/**
 * Every control that closes a Workspace asks for the same thing.
 *
 * There used to be four ways in and they did not agree. The Sidebar's button
 * called main's one close, but read `closing-failed` first and dispatched a
 * different intent for it. The Unavailable pane's "Close" dispatched the raw
 * lifecycle intent, going around the worktree rule entirely — so closing an
 * unavailable worktree from the Sidebar deleted the folder and closing the
 * same workspace from the surface pane did not — and its failed-close action
 * was a fourth entry again. File ▸ Close Workspace went straight to the model
 * in main for the same reason.
 *
 * The rule these pin: the page never dispatches a lifecycle intent for a
 * close. It calls `closeWorkspace(workspaceId)`, whatever state the row is in,
 * and main decides everything else — whether the workspace is a worktree,
 * whether this is a first attempt or a retry, and what has to be asked first.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppSnapshot,
  WorkspaceCloseWire,
  WorkspaceStateWire,
} from "../../../ipc/appShell";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "../sidebar/Sidebar";
import { Unavailable } from "./SurfaceViewport";

window.devhub = {
  openModal: () => Promise.resolve(""),
  onMenuCommand: () => () => undefined,
} as unknown as typeof window.devhub;

const WORKSPACE_ID = "w-1";

const OPEN: Row = { state: { kind: "available" }, close: { kind: "idle" } };

const CLOSE_FAILED: Row = {
  state: { kind: "available" },
  close: {
    kind: "failed",
    step: "editor",
    diagnostic: "close_editor_vetoed",
  },
};

const UNAVAILABLE: Row = {
  state: { kind: "unavailable", reason: "root_missing" },
  close: { kind: "idle" },
};

/** The two facts a workspace row is drawn from. See `WorkspaceWire`. */
interface Row {
  readonly state: WorkspaceStateWire;
  readonly close: WorkspaceCloseWire;
}

function snapshotWith(row: Row): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: {
      context: { kind: "workspace", workspaceId: WORKSPACE_ID },
      presentation: "full",
    },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    workspaces: [
      {
        id: WORKSPACE_ID,
        label: "widget",
        root: "/projects/widget",
        selectedPath: "/projects/widget",
        state: row.state,
        close: row.close,
        canCreateAgent:
          row.state.kind === "available" && row.close.kind !== "running",
        agents: [],
      },
    ],
  } as unknown as AppSnapshot;
}

/**
 * The two controls, mounted against one context so they cannot differ.
 *
 * The surface half renders `Unavailable` rather than the whole viewport: the
 * viewport measures a rectangle for a native workbench view and builds
 * terminals, none of which jsdom has, and this is a test about which call a
 * button makes. What the viewport hands it is `closeWorkspace`, main's one
 * close — the same function the Sidebar is given here.
 */
function mount(where: "sidebar" | "surface", row: Row) {
  const closeWorkspace = vi.fn();
  const dispatch = vi.fn(async () => undefined);
  const onDispatch = vi.fn();
  const value = {
    dispatch,
    closeWorkspace,
    openExternalUrl: vi.fn(),
    reportFailure: vi.fn(),
    dismissIntentError: vi.fn(),
    chooseWorkspaceFolder: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
    state: { status: "ready", snapshot: snapshotWith(row) },
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      {where === "sidebar" ? (
        <Sidebar snapshot={snapshotWith(row)} onDispatch={onDispatch} />
      ) : (
        <Unavailable
          workspace={snapshotWith(row).workspaces[0]}
          actions={
            row.state.kind === "unavailable"
              ? [
                  {
                    label: "Close",
                    run: () => {
                      closeWorkspace(WORKSPACE_ID);
                    },
                  },
                ]
              : undefined
          }
          onClose={() => {
            closeWorkspace(WORKSPACE_ID);
          }}
        />
      )}
    </AppShellContext.Provider>,
  );
  // Both dispatch sinks come back because the Sidebar has one of its own, and
  // "the page sent a lifecycle intent instead" is the bug being pinned rather
  // than an implementation detail.
  return { closeWorkspace, dispatch, onDispatch };
}

/** Every close a control could have asked for, however it asked. */
function closesAsked(mounted: ReturnType<typeof mount>): unknown[] {
  return [
    ...mounted.closeWorkspace.mock.calls,
    ...mounted.dispatch.mock.calls,
    ...mounted.onDispatch.mock.calls,
  ];
}

afterEach(cleanup);

describe("closing a Workspace, from wherever it is asked for", () => {
  it("asks main's one close from the Sidebar's button", () => {
    const mounted = mount("sidebar", OPEN);
    fireEvent.click(screen.getByRole("button", { name: /^Close widget$/ }));
    expect(mounted.closeWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(closesAsked(mounted)).toHaveLength(1);
  });

  it("asks the same close from the Sidebar when the last one failed", () => {
    const mounted = mount("sidebar", CLOSE_FAILED);
    fireEvent.click(screen.getByRole("button", { name: /^Close widget$/ }));
    expect(mounted.closeWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(closesAsked(mounted)).toHaveLength(1);
  });

  it("asks the same close from the Unavailable pane", () => {
    const mounted = mount("surface", UNAVAILABLE);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mounted.closeWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(closesAsked(mounted)).toHaveLength(1);
  });

  it("asks the same close from the pane of a close that failed", () => {
    const mounted = mount("surface", CLOSE_FAILED);
    fireEvent.click(screen.getByRole("button", { name: "Close Workspace" }));
    expect(mounted.closeWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(closesAsked(mounted)).toHaveLength(1);
  });
});
