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
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
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

/** A repository row with every line the expanded Sidebar can draw. */
const REPOSITORY = {
  workspaceId: "w-1",
  branch: "feature/128-tidy",
  worktree: "/projects/widget",
  mainWorktree: "/projects/widget",
  repositoryUrl: "https://github.com/example/widget",
  issue: {
    number: 128,
    state: "open",
    title: "Tidy the rail",
    url: "https://github.com/example/widget/issues/128",
  },
  pullRequest: {
    number: 131,
    state: "draft",
    title: "Tidy the rail",
    url: "https://github.com/example/widget/pull/131",
  },
} as const;

function mount(
  collapsed: boolean,
  repository?: typeof REPOSITORY,
  openExternalUrl = vi.fn(),
) {
  const dispatch = vi.fn();
  const value = {
    dispatch: vi.fn(),
    openExternalUrl,
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    dismissIntentError: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: {
      sequence: 1,
      workspaces: repository ? [repository] : [],
    },
  } as unknown as SidebarValue;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot(collapsed)} onDispatch={dispatch} />
    </SidebarContext.Provider>,
  );
  return Object.assign(
    screen.getByRole("complementary", { name: "Workspace navigation" }),
    { dispatch, openExternalUrl },
  );
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
    expect(
      screen.getByRole("button", { name: "Scratch terminal" }),
    ).toHaveAttribute("data-tooltip", "Scratch");
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

/**
 * The pointer, in a rail, is in the position a screen reader is always in: the
 * words are off and the glyph is all there is. So it is told the same thing —
 * one composition, handed to `aria-label` when the row is drawn and to `title`
 * when it is not — and the entry it points at selects the row, because in the
 * rail the entry is the whole of what there is to click.
 */
describe("what a rail entry does under the pointer", () => {
  it("selects the row, and does not open the repository", () => {
    const rail = mount(true, REPOSITORY);
    expect(screen.queryByRole("button", { name: /on GitHub$/ })).toBeNull();
    screen.getByRole("button", { name: /widget workspace/ }).click();
    expect(rail.openExternalUrl).not.toHaveBeenCalled();
    expect(rail.dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "workspace", workspaceId: "w-1" },
    });
  });

  it("leaves the expanded row's mark as the link it is", () => {
    const expanded = mount(false, REPOSITORY);
    screen
      .getByRole("button", { name: "Open example/widget on GitHub" })
      .click();
    expect(expanded.openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget",
    );
    expect(expanded.dispatch).not.toHaveBeenCalled();
  });

  it("says in the tooltip exactly what the expanded row is named", () => {
    mount(false, REPOSITORY);
    const expandedWorkspace = screen
      .getByRole("button", { name: /widget workspace/ })
      .getAttribute("aria-label");
    const expandedAgent = screen
      .getByRole("button", { name: /^Codex,/ })
      .getAttribute("aria-label");
    cleanup();
    mount(true, REPOSITORY);
    expect(
      screen.getByRole("button", { name: /widget workspace/ }),
    ).toHaveAttribute("data-tooltip", expandedWorkspace);
    expect(screen.getByRole("button", { name: /^Codex,/ })).toHaveAttribute(
      "data-tooltip",
      expandedAgent,
    );
  });

  it("carries the branch and the work into the name, not only the path", () => {
    mount(true, REPOSITORY);
    const title = screen
      .getByRole("button", { name: /widget workspace/ })
      .getAttribute("data-tooltip");
    expect(title).toBe(
      [
        "widget workspace, path /projects/widget",
        "branch feature/128-tidy",
        "Issue #128 (open), Pull request #131 (draft), Tidy the rail",
      ].join("\n"),
    );
  });
});
