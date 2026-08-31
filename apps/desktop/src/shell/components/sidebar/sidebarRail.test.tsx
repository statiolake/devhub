// @vitest-environment jsdom

/**
 * The collapsed Sidebar.
 *
 * What the rail must keep from the pane is what a label cannot replace: every
 * destination is still there and still reachable, and selecting through the
 * rail is the same intent as selecting through a row. A rail that shows fewer
 * places than the pane is a place the person cannot get back to without
 * expanding it again.
 *
 * What it must *not* grow is a status of its own. Status belongs to an Agent,
 * the rail has no Agent tiles, and a Workspace has nothing to roll up.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentStatus,
  AppIntent,
  AppSnapshot,
  NavigationContext,
} from "../../../ipc/appShell";
import { SidebarRail } from "./SidebarRail";

const WORKSPACE_A = "63752e9f-c93d-4d49-87f0-70f352eea8b0";
const WORKSPACE_B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const AGENT_A = "5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d";

function workspace(
  id: string,
  label: string,
  statuses: readonly AgentStatus[],
) {
  return {
    id,
    label,
    root: `/w/${label}`,
    selectedPath: `/w/${label}`,
    state: "available",
    canCreateAgent: true,
    agents: statuses.map((status, index) => ({
      id: index === 0 ? AGENT_A : `${id}-${String(index)}`,
      workspaceId: id,
      displayName: `agent ${String(index)}`,
      profileId: "claude",
      ordinal: index + 1,
      status,
      controlState: "running",
      runtimeHealth: "healthy",
    })),
  };
}

function snapshot(context: NavigationContext): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 3,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "workbench", editorKey: "global-editor" },
    selection: { context },
    splitRatio: 0.55,
    sidebar: { expanded: false, width: 248 },
    workspaces: [
      workspace(WORKSPACE_A, "folderA", ["working"]),
      workspace(WORKSPACE_B, "folderB", []),
    ],
  } as unknown as AppSnapshot;
}

function mount(context: NavigationContext) {
  const onDispatch = vi.fn<(intent: AppIntent) => void>();
  const onAddWorkspace = vi.fn();
  render(
    <SidebarRail
      snapshot={snapshot(context)}
      onDispatch={onDispatch}
      onAddWorkspace={onAddWorkspace}
    />,
  );
  return { onDispatch, onAddWorkspace };
}

describe("the Sidebar collapsed to a rail", () => {
  afterEach(cleanup);

  it("keeps every destination the pane has, named for hover and for a reader", () => {
    mount({ kind: "global" });
    expect(screen.getByRole("button", { name: "Scratch" })).toHaveAttribute(
      "title",
      "Scratch",
    );
    // The name plus how many Agents are in it: the tile has no room to write
    // either one, so hovering is where both have to be.
    expect(
      screen.getByRole("button", { name: "folderA — 1 Agent" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "folderB" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open workspace picker" }),
    ).toBeInTheDocument();
  });

  it("puts no status on a Workspace tile, not even where Agents are working", () => {
    mount({ kind: "global" });
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("selects through the same intent a row does", () => {
    const { onDispatch, onAddWorkspace } = mount({ kind: "global" });
    screen.getByRole("button", { name: /folderA/ }).click();
    expect(onDispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "workspace", workspaceId: WORKSPACE_A },
    });
    screen.getByRole("button", { name: "Open workspace picker" }).click();
    expect(onAddWorkspace).toHaveBeenCalled();
  });

  it("marks the Workspace of a selected Agent, which has no tile of its own", () => {
    mount({ kind: "agent", agentId: AGENT_A });
    expect(screen.getByRole("button", { name: /folderA/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "folderB" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
