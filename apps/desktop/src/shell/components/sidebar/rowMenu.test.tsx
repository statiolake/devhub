// @vitest-environment jsdom

/**
 * A row's right-click menu is a native menu, asked of main.
 *
 * It used to be a box in this page, and this page is a view the width of the
 * Sidebar: on a collapsed rail the menu was clipped to nothing. What this page
 * still owns is what is in the menu and what each item does — so that is what
 * is pinned: the items for each state, the click's point in this view's own
 * coordinates, and that the id main answers with runs the same intent the
 * row's own controls dispatch. Nothing of the menu is drawn here any more.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSnapshot,
  AppSnapshot,
  WorkspaceSnapshot,
} from "../../../ipc/appShell";
import type { ContextMenuRequestWire } from "../../../ipc/contract";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { agentMenuItems, workspaceMenuItems } from "./rowMenu";
import { SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

let answer: string | undefined;
const showContextMenu = vi.fn((_request: ContextMenuRequestWire) =>
  Promise.resolve(answer),
);
const openModal = vi.fn(() => Promise.resolve(""));

window.devhub = {
  openModal,
  focusSurface: vi.fn(() => Promise.resolve()),
  onMenuCommand: () => () => undefined,
  onSidebarArea: () => () => undefined,
  onChordArmed: () => () => undefined,
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
  showContextMenu,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  answer = undefined;
});

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "a-1",
    workspaceId: "w-1",
    ordinal: 0,
    displayName: "Codex",
    profileId: "p",
    profileKind: "codex",
    presentation: "gui",
    status: "idle",
    runtimeHealth: "healthy",
    controlState: { kind: "running" },
    unread: undefined,
    activity: undefined,
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
    ...overrides,
  } as unknown as AgentSnapshot;
}

function workspace(
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    id: "w-1",
    label: "widget",
    location: { kind: "local" },
    editor: { kind: "devContainer" },
    root: "/projects/widget",
    displayRoot: "/projects/widget",
    key: "/projects/widget",
    selectedPath: "/projects/widget",
    state: { kind: "available" },
    close: { kind: "idle" },
    canCreateAgent: true,
    agents: [agent()],
    ...overrides,
  } as unknown as WorkspaceSnapshot;
}

function mount(collapsed: boolean) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const reopenEditorLocally = vi.fn();
  const reopenEditorInContainer = vi.fn();
  const continueAgent = vi.fn();
  const closeWorkspace = vi.fn();
  const value = {
    dispatch,
    reopenEditorLocally,
    reopenEditorInContainer,
    continueAgent,
    openExternalUrl: vi.fn(),
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace,
    reportFailure: vi.fn(),
    dismissIntentError: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    usageLimits: { clis: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as SidebarValue;
  const snapshot = {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: {
      context: { kind: "workspace", workspaceId: "w-1" },
      presentation: "full",
    },
    sidebar: { width: 248, collapsed },
    splitRatio: 0.55,
    smartButtons: {},
    scratchWorkspaceId: SCRATCH_ID,
    workspaces: [scratchWorkspace(), workspace()],
  } as unknown as AppSnapshot;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot} />
    </SidebarContext.Provider>,
  );
  return {
    dispatch,
    reopenEditorLocally,
    reopenEditorInContainer,
    continueAgent,
    closeWorkspace,
  };
}

const labels = (items: readonly { readonly label: string }[]) =>
  items.map((item) => item.label);

describe("what a right-click on an Agent offers", () => {
  const none = () => undefined;

  it("offers Rename, Mark as Unread, Restart, Continue in Terminal and Stop on a running GUI Agent", () => {
    expect(labels(agentMenuItems(agent(), none, none, none))).toEqual([
      "Rename…",
      "Mark as Unread",
      "Restart Session",
      "Continue in Terminal",
      "Stop Agent",
    ]);
  });

  it("offers a terminal Claude or Codex Agent Continue in GUI, and runs it for that Agent", () => {
    const continued: string[] = [];
    const items = agentMenuItems(
      agent({ presentation: "tui" }),
      none,
      none,
      (each) => continued.push(each.id),
    );
    expect(labels(items)).toContain("Continue in GUI");
    expect(labels(items)).not.toContain("Continue in Terminal");
    items.find((item) => item.id === "continue")?.run();
    expect(continued).toEqual(["a-1"]);
  });

  it("offers no Continue where the pane control did not: other CLIs, a failed Agent, one not running", () => {
    for (const overrides of [
      { profileKind: "cursor" },
      { failure: { code: "conversation_failed" } },
      { controlState: { kind: "stopping" } },
      { controlState: { kind: "stop-failed" } },
    ]) {
      expect(
        labels(agentMenuItems(agent(overrides as never), none, none, none)),
      ).not.toContain("Continue in Terminal");
    }
  });

  it("puts Stop Agent last and apart", () => {
    const items = agentMenuItems(agent(), none, none, none);
    expect(items.at(-1)).toMatchObject({ id: "stop", separated: true });
    expect(items.slice(0, -1).some((item) => item.separated)).toBe(false);
  });

  it("leaves out Mark as Unread on an Agent that is already unread", () => {
    expect(
      labels(
        agentMenuItems(agent({ unread: "idle" } as never), none, none, none),
      ),
    ).not.toContain("Mark as Unread");
  });

  it("offers Restart Session on a terminal Claude or Codex Agent too", () => {
    for (const profileKind of ["claude", "codex"] as const) {
      expect(
        labels(
          agentMenuItems(
            agent({ presentation: "tui", profileKind }),
            none,
            none,
            none,
          ),
        ),
      ).toContain("Restart Session");
    }
  });

  it("leaves out Restart Session where the coordinator would refuse it", () => {
    expect(
      labels(
        agentMenuItems(
          agent({ presentation: "tui", profileKind: "custom" }),
          none,
          none,
          none,
        ),
      ),
    ).not.toContain("Restart Session");
  });

  it("says Retry Stop after a stop failed, and nothing while stopping", () => {
    const failed = agent({ controlState: { kind: "stop-failed" } } as never);
    const dispatched: unknown[] = [];
    const items = agentMenuItems(
      failed,
      (intent) => dispatched.push(intent),
      none,
      none,
    );
    expect(labels(items)).toContain("Retry Stop");
    items.find((item) => item.id === "stop")?.run();
    expect(dispatched).toEqual([{ type: "retry_stop_agent", agentId: "a-1" }]);
    expect(
      labels(
        agentMenuItems(
          agent({ controlState: { kind: "stopping" } } as never),
          none,
          none,
          none,
        ),
      ),
    ).not.toContain("Stop Agent");
  });
});

describe("what a right-click on a Workspace offers", () => {
  const actions = (over: Record<string, unknown> = {}) => ({
    reopenInContainer: vi.fn(),
    reopenLocally: vi.fn(),
    close: vi.fn(),
    deletesWorktree: false,
    fixed: false,
    ...over,
  });

  it("offers the two ways to reopen a dev container's editor, then Close Workspace…", () => {
    const a = actions();
    const items = workspaceMenuItems(workspace(), a);
    expect(labels(items)).toEqual([
      "Reopen Editor in Container",
      "Reopen Editor Locally",
      "Close Workspace…",
    ]);
    for (const item of items) item.run();
    expect(a.reopenInContainer).toHaveBeenCalledWith("w-1");
    expect(a.reopenLocally).toHaveBeenCalledWith("w-1");
    expect(a.close).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w-1" }),
    );
    expect(items.at(-1)?.separated).toBe(true);
  });

  it("offers only the close on an ordinary Workspace, and says Worktree where closing deletes the folder", () => {
    const local = workspace({ editor: { kind: "local" } } as never);
    expect(labels(workspaceMenuItems(local, actions()))).toEqual([
      "Close Workspace…",
    ]);
    expect(
      labels(workspaceMenuItems(local, actions({ deletesWorktree: true }))),
    ).toEqual(["Close Worktree…"]);
  });

  it("offers Scratch no close: nothing outside a dev container", () => {
    const local = workspace({ editor: { kind: "local" } } as never);
    expect(workspaceMenuItems(local, actions({ fixed: true }))).toEqual([]);
  });
});

describe("the menu is main's to draw", () => {
  it.each([false, true])(
    "asks main for the Agent's menu at the click, collapsed: %s",
    async (collapsed) => {
      const { dispatch } = mount(collapsed);
      answer = "unread";
      const row = document.querySelector(".agent-row");
      expect(row).not.toBeNull();
      await act(async () => {
        fireEvent.contextMenu(row as Element, { clientX: 12, clientY: 34 });
        await Promise.resolve();
      });
      expect(showContextMenu).toHaveBeenCalledWith({
        items: [
          { id: "rename", label: "Rename…" },
          { id: "unread", label: "Mark as Unread" },
          { id: "restart", label: "Restart Session" },
          { id: "continue", label: "Continue in Terminal" },
          { id: "stop", label: "Stop Agent", separatorBefore: true },
        ],
        at: { x: 12, y: 34 },
      });
      expect(dispatch).toHaveBeenCalledWith({
        type: "mark_agent_unread",
        agentId: "a-1",
      });
      // Nothing of the menu is drawn in this view.
      expect(document.querySelector('[role="menu"]')).toBeNull();
    },
  );

  it("runs Rename through the same sheet the row's own key opens", async () => {
    mount(false);
    answer = "rename";
    await act(async () => {
      fireEvent.contextMenu(document.querySelector(".agent-row") as Element);
      await Promise.resolve();
    });
    expect(openModal).toHaveBeenCalledWith({
      kind: "agent-rename",
      agentId: "a-1",
    });
  });

  it("runs nothing when the menu is dismissed", async () => {
    const { dispatch } = mount(false);
    answer = undefined;
    await act(async () => {
      fireEvent.contextMenu(document.querySelector(".agent-row") as Element);
      await Promise.resolve();
    });
    expect(showContextMenu).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(openModal).not.toHaveBeenCalled();
  });

  it("asks for a dev-container Workspace's menu and reopens the one chosen", async () => {
    const { reopenEditorLocally } = mount(true);
    answer = "reopen-locally";
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    await act(async () => {
      fireEvent.contextMenu(row as Element, { clientX: 5, clientY: 6 });
      await Promise.resolve();
    });
    expect(showContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ at: { x: 5, y: 6 } }),
    );
    expect(reopenEditorLocally).toHaveBeenCalledWith("w-1");
  });

  it("continues the Agent in its other presentation through main", async () => {
    const { continueAgent } = mount(false);
    answer = "continue";
    await act(async () => {
      fireEvent.contextMenu(document.querySelector(".agent-row") as Element);
      await Promise.resolve();
    });
    expect(continueAgent).toHaveBeenCalledWith("a-1");
  });

  it("closes a Workspace through the row's own close, the one path", async () => {
    const { closeWorkspace } = mount(false);
    answer = "close-workspace";
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    await act(async () => {
      fireEvent.contextMenu(row as Element);
      await Promise.resolve();
    });
    expect(closeWorkspace).toHaveBeenCalledWith("w-1");
  });

  it("puts up no menu on Scratch, which cannot be closed", async () => {
    mount(false);
    await act(async () => {
      fireEvent.contextMenu(
        document.querySelector(".workspace-row.is-scratch") as Element,
      );
      await Promise.resolve();
    });
    expect(showContextMenu).not.toHaveBeenCalled();
  });
});
