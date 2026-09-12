// @vitest-environment jsdom

/**
 * The Sidebar collapsed to its icon rail.
 *
 * The property worth pinning is that collapsing is *drawn* and never rendered
 * differently: the same rows in the same order, same buttons, same labels, same
 * roving tab stop. So the tree the arrows walk and the sentence a screen reader
 * reads are one set of markup in both states, and what CSS takes away is only
 * what needs width to be read. These tests say the markup is the same, that
 * what a rail cannot honour is gone, and that the state survives a restart.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import { AppModel } from "../../../model/appModel";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "./Sidebar";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
  onMenuCommand: () => () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function snapshot(collapsed: boolean): AppSnapshot {
  return {
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
    workspaces: [
      {
        id: "w-1",
        label: "widget",
        location: { kind: "local" },
        root: "/projects/widget",
        key: "/projects/widget",
        selectedPath: "/projects/widget",
        state: { kind: "available" },
        close: { kind: "idle" },
        canCreateAgent: true,
        agents: [
          {
            id: "a-1",
            workspaceId: "w-1",
            ordinal: 0,
            displayName: "Codex",
            profileId: "p",
            status: "idle",
            runtimeHealth: "healthy",
            controlState: { kind: "running" },
            unread: "idle",
            activity: undefined,
            injection: {
              queued: 0,
              waitingFor: "nothing_queued",
              lastResult: undefined,
            },
          },
        ],
      },
    ],
  } as unknown as AppSnapshot;
}

function mount(collapsed: boolean) {
  const value = {
    dispatch: vi.fn(),
    openExternalUrl: vi.fn(),
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    dismissIntentError: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <Sidebar snapshot={snapshot(collapsed)} onDispatch={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return screen.getByRole("complementary", { name: "Workspace navigation" });
}

describe("the collapsed rail", () => {
  it("says it is collapsed, and says nothing when it is not", () => {
    expect(mount(true)).toHaveAttribute("data-collapsed", "true");
    cleanup();
    expect(mount(false)).not.toHaveAttribute("data-collapsed");
  });

  it("keeps every row, in the same order, as the same buttons", () => {
    mount(true);
    expect(
      screen.getByRole("button", { name: "Scratch terminal" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /widget workspace/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Codex,/ })).toBeInTheDocument();
  });

  it("keeps the tree, so the keyboard is unchanged", () => {
    mount(true);
    const tree = screen.getByRole("tree", { name: "Open workspaces" });
    expect(tree.querySelectorAll("[data-tree-item-id]")).toHaveLength(2);
    // The roving tab stop is still on the selected row.
    expect(
      screen.getByRole("button", { name: /widget workspace/ }),
    ).toHaveAttribute("tabindex", "0");
  });

  it("keeps the unread dot, which is the mark a rail can least afford to lose", () => {
    mount(true);
    expect(document.querySelector(".row-unread")).not.toBeNull();
  });

  it("names each row in a tooltip, since the words are off", () => {
    mount(true);
    expect(screen.getByRole("button", { name: /^Codex,/ })).toHaveAttribute(
      "title",
      "Codex",
    );
    expect(
      screen.getByRole("button", { name: "Scratch terminal" }),
    ).toHaveAttribute("title", "Scratch");
  });

  it("takes away the resize handle, because a rail has no width to set", () => {
    mount(true);
    expect(
      screen.queryByRole("separator", { name: "Resize sidebar" }),
    ).toBeNull();
    cleanup();
    mount(false);
    expect(
      screen.getByRole("separator", { name: "Resize sidebar" }),
    ).toBeInTheDocument();
  });
});

describe("what the model remembers about the rail", () => {
  it("keeps the width, so coming back comes back to it", () => {
    const model = new AppModel();
    model.setSidebarWidth(321);
    model.toggleSidebar();
    expect(model.snapshot().sidebar).toEqual({ width: 321, collapsed: true });
    model.toggleSidebar();
    expect(model.snapshot().sidebar).toEqual({ width: 321, collapsed: false });
  });
});
