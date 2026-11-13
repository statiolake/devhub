// @vitest-environment jsdom

/**
 * The Orchestrator row is its Workspace's row, as Scratch's is Scratch's:
 * the orchestrator's folder is not an ordinary row, and the agents there
 * other than the orchestrator are drawn under the Orchestrator row.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import { EMPTY_BOARD } from "../../../ipc/contract";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { forgetOrchestratorFolds } from "./orchestratorGroup";
import { ON_SCRATCH, SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

const showContextMenu = vi.fn(() => Promise.resolve("show-editor"));

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
  showContextMenu,
  onMenuCommand: () => () => undefined,
  onSidebarArea: () => () => undefined,
  onChordArmed: () => () => undefined,
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  forgetOrchestratorFolds();
});

const ROOT_ID = "orchestrator-ws";

function agent(id: string, workspaceId: string, status = "idle") {
  return {
    id,
    workspaceId,
    ordinal: 0,
    displayName: id,
    profileId: "p",
    status,
    runtimeHealth: "healthy",
    controlState: { kind: "running" },
    unread: undefined,
    activity: undefined,
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
  };
}

function snapshot(
  context: AppSnapshot["selection"]["context"] = ON_SCRATCH,
): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    smartButtons: {},
    scratchWorkspaceId: SCRATCH_ID,
    orchestratorAgentId: "orch",
    orchestratorWorkspaceId: ROOT_ID,
    workspaces: [
      scratchWorkspace({
        agents: [agent("scratch-helper", SCRATCH_ID)] as never,
      }),
      scratchWorkspace({
        id: ROOT_ID,
        label: "Orchestrator",
        root: "/home/example/orchestrator",
        key: "/home/example/orchestrator",
        agents: [
          agent("orch", ROOT_ID, "working"),
          agent("researcher", ROOT_ID, "working"),
          agent("reviewer", ROOT_ID),
        ] as never,
      }),
      scratchWorkspace({
        id: "app",
        label: "app",
        root: "/src/app",
        key: "/src/app",
      }),
    ],
  } as unknown as AppSnapshot;
}

function mount(value: AppSnapshot) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  render(
    <SidebarContext.Provider
      value={
        {
          dispatch,
          openExternalUrl: vi.fn(),
          closeWorkspace: vi.fn(),
          reportFailure: vi.fn(),
          retry: vi.fn(),
          agentProfiles: {
            sequence: 1,
            availability: "available",
            profiles: [],
          },
          usageLimits: { clis: [] },
          repositoryStatus: { sequence: 1, workspaces: [] },
          board: { ...EMPTY_BOARD, orchestratorAgentId: "orch" },
        } as unknown as SidebarValue
      }
    >
      <Sidebar snapshot={value} />
    </SidebarContext.Provider>,
  );
  return dispatch;
}

const topRows = () =>
  [
    ...screen
      .getByRole("tree", { name: "Open workspaces" })
      .querySelectorAll<HTMLElement>("[role=treeitem][aria-level='1']"),
  ].filter((row) => !row.classList.contains("is-exiting"));

describe("the Orchestrator row's Workspace", () => {
  it("is not listed as an ordinary row", () => {
    mount(snapshot());
    const labels = topRows().map(
      (row) => row.querySelector(".row-label")?.textContent,
    );
    expect(labels).toEqual(["Orchestrator", "Scratch", "app"]);
    expect(
      document.querySelector(`[data-workspace-id="${ROOT_ID}"]`),
    ).toBeNull();
  });

  it("lists its agents under the Orchestrator row by lane, the orchestrator itself being the row", () => {
    mount(snapshot());
    const row = topRows()[0]!;
    expect(row).toHaveAttribute("aria-expanded", "true");
    const group = within(row).getByRole("group", {
      name: "The orchestrator's work",
    });
    // The working helper is 対応中; the idle one, with nothing open on it, is
    // 完了, which starts folded: its heading and count, not its row.
    const headings = [
      ...group.querySelectorAll<HTMLElement>("[role=treeitem][aria-level='2']"),
    ];
    expect(headings.map((one) => one.dataset["lane"])).toEqual([
      "progress",
      "closed",
    ]);
    expect(headings[1]).toHaveAttribute("aria-expanded", "false");
    const children = [
      ...group.querySelectorAll<HTMLElement>("[role=treeitem][aria-level='3']"),
    ];
    expect(children).toHaveLength(1);
    expect(children[0]!.querySelector(".row-glyph")).not.toBeNull();
    expect(
      within(group).queryByRole("button", { name: /^orch\b/u }),
    ).toBeNull();
    expect(
      within(group).getByRole("button", { name: /^researcher/u }),
    ).toBeVisible();
    fireEvent.click(within(group).getByRole("button", { name: "完了, 1" }));
    expect(
      within(group).getByRole("button", { name: /^reviewer/u }),
    ).toBeVisible();
    // Scratch still lists its own.
    expect(
      within(screen.getByRole("group", { name: "Scratch agents" })).getByRole(
        "button",
        { name: /^scratch-helper/u },
      ),
    ).toBeVisible();
  });

  it("selects a child agent's pane", () => {
    const dispatch = mount(snapshot());
    const group = screen.getByRole("group", {
      name: "The orchestrator's work",
    });
    fireEvent.click(
      within(group).getByRole("button", { name: /^researcher/u }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "agent", agentId: "researcher" },
      split: false,
    });
  });

  it("highlights the Orchestrator row while its child is selected, on the child", () => {
    mount(snapshot({ kind: "agent", agentId: "researcher" }));
    const group = screen.getByRole("group", {
      name: "The orchestrator's work",
    });
    expect(
      within(group).getByRole("button", { name: /^researcher/u }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows the folder's editor as the board's Terminal tab: Show Editor on the row, never the Workspace full", async () => {
    const dispatch = mount(snapshot({ kind: "orchestrator" }));
    fireEvent.contextMenu(topRows()[0]!.querySelector(".orchestrator-row")!);
    expect(showContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ id: "show-editor", label: "Show Editor" }],
      }),
    );
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "show_orchestrator_view",
        view: { kind: "terminal" },
        reason: "explicit",
      });
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "select_context",
        context: { kind: "workspace", workspaceId: ROOT_ID },
      }),
    );
  });

  it("starts a helper in the orchestrator's folder from its +", () => {
    mount(snapshot());
    expect(
      within(topRows()[0]!).getByRole("button", {
        name: /^Create agent in Orchestrator/u,
      }),
    ).toBeInTheDocument();
  });
});
