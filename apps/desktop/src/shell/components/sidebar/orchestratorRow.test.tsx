// @vitest-environment jsdom

/**
 * The Orchestrator row is the tree's first, above Scratch. It wears the
 * board's count of escalations waiting for the person, and the orchestrator
 * agent is drawn on it rather
 * than under its Workspace.
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
import { EMPTY_BOARD, type OrchestratorBoardWire } from "../../../ipc/contract";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { ON_SCRATCH, SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
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
});

function agent(id: string, workspaceId: string) {
  return {
    id,
    workspaceId,
    ordinal: 0,
    displayName: id,
    profileId: "p",
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
  };
}

function snapshot(orchestrator: boolean): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context: ON_SCRATCH, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    smartButtons: {},
    scratchWorkspaceId: SCRATCH_ID,
    ...(orchestrator ? { orchestratorAgentId: "orch" } : {}),
    workspaces: [
      scratchWorkspace({
        agents: [
          agent("orch", SCRATCH_ID),
          agent("worker", SCRATCH_ID),
        ] as never,
      }),
    ],
  } as unknown as AppSnapshot;
}

const escalation = (id: number) => ({
  id,
  title: `t${String(id)}`,
  state: "needs_answer" as const,
  entries: [{ role: "orchestrator" as const, markdown: "x", at: 0 }],
  agents: [],
  links: [],
  createdAt: 0,
  updatedAt: 0,
  stateSince: 0,
});

function mount(value: AppSnapshot, board: OrchestratorBoardWire) {
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
          board,
        } as unknown as SidebarValue
      }
    >
      <Sidebar snapshot={value} />
    </SidebarContext.Provider>,
  );
  return dispatch;
}

const treeItems = () =>
  screen
    .getByRole("tree", { name: "Open workspaces" })
    .querySelectorAll<HTMLElement>("[role=treeitem][aria-level='1']");

describe("the Orchestrator row", () => {
  it("is the tree's first row, above Scratch", () => {
    mount(snapshot(false), EMPTY_BOARD);
    const [first, second] = treeItems();
    expect(first!.querySelector(".row-label")).toHaveTextContent(
      /^Orchestrator$/,
    );
    expect(first!.querySelector(".row-glyph svg")).toHaveAttribute(
      "data-glyph",
      "orchestrator",
    );
    expect(second!.querySelector(".row-label")).toHaveTextContent(/^Scratch$/);
  });

  it("wears the number waiting for an answer, and no 不明 count", () => {
    mount(snapshot(true), {
      ...EMPTY_BOARD,
      orchestratorAgentId: "orch",
      needsAnswer: [escalation(1), escalation(2)],
    });
    const row = treeItems()[0]!;
    expect(row.querySelector(".orchestrator-badge")).toHaveTextContent("2");
    expect(row.querySelector(".orchestrator-unaccounted")).toBeNull();
    const button = within(row).getByRole("button", {
      name: /2 waiting for your answer/u,
    });
    expect(button.getAttribute("aria-label")).not.toMatch(/unaccounted/u);
  });

  it("draws the orchestrator agent on its own row, not under its Workspace", () => {
    mount(snapshot(true), EMPTY_BOARD);
    const group = screen.getByRole("group", { name: "Scratch agents" });
    expect(within(group).queryByRole("button", { name: /^orch/u })).toBeNull();
    expect(
      within(group).getByRole("button", { name: /^worker/u }),
    ).toBeVisible();
  });

  it("selects the Orchestrator screen", () => {
    const dispatch = mount(snapshot(false), EMPTY_BOARD);
    fireEvent.click(
      within(treeItems()[0]!).getByRole("button", { name: /^Orchestrator/u }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "orchestrator" },
    });
  });
  it("selects it as a place for Back and Forward when clicked", () => {
    const dispatch = mount(snapshot(false), EMPTY_BOARD);
    fireEvent.click(
      within(treeItems()[0]!).getByRole("button", { name: /^Orchestrator/u }),
      { detail: 1 },
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "orchestrator" },
      reason: "explicit",
    });
  });
});
