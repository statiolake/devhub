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
import { scratchModel } from "../../../model/testWorkspaces";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
  onMenuCommand: () => () => undefined,
  onChordArmed: () => () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function snapshot(
  collapsed: boolean,
  agent: Record<string, unknown> = {},
): AppSnapshot {
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
    smartButtons: {},
    scratchWorkspaceId: SCRATCH_ID,
    workspaces: [
      scratchWorkspace(),
      {
        id: "w-1",
        label: "widget",
        location: { kind: "local" },
        editor: { kind: "host" },
        root: "/projects/widget",
        displayRoot: "/projects/widget",
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
            ...agent,
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
    conversations: { unresolved: 0, uncounted: 0 },
    title: "Tidy the rail",
    url: "https://github.com/example/widget/pull/131",
  },
} as const;

function mount(
  collapsed: boolean,
  repository?: typeof REPOSITORY,
  openExternalUrl = vi.fn(),
  agent: Record<string, unknown> = {},
) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const value = {
    dispatch,
    openExternalUrl,
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    dismissIntentError: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    usageLimits: { clis: [] },
    repositoryStatus: {
      sequence: 1,
      workspaces: repository ? [repository] : [],
    },
  } as unknown as SidebarValue;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot(collapsed, agent)} />
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
      screen.getByRole("button", { name: /^Scratch workspace/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /widget workspace/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Codex/ })).toBeInTheDocument();
  });

  it("keeps the tree, so the keyboard is unchanged", () => {
    mount(true);
    const tree = screen.getByRole("tree", { name: "Open workspaces" });
    expect(tree.querySelectorAll("[data-tree-item-id]")).toHaveLength(3);
    // The roving tab stop is still on the selected row.
    expect(
      screen.getByRole("button", { name: /widget workspace/ }),
    ).toHaveAttribute("tabindex", "0");
  });

  /**
   * "This one asked for you and you have not been" is the fact a rail is least
   * able to afford to lose, and there is no separate dot to keep any more: the
   * status mark draws it — see `unreadShows` — so the rail keeps it by keeping
   * the one mark it was always going to keep.
   */
  it("keeps the unread mark, which is the status mark itself", () => {
    mount(true);
    expect(
      document.querySelector(".agent-row .status-mark.is-unread svg"),
    ).toHaveAttribute("data-glyph", "statusUnread");
  });

  it("names each row in its accessible name, since the words are off", () => {
    mount(true);
    const label = screen
      .getByRole("button", { name: /^Scratch workspace/ })
      .getAttribute("aria-label");
    expect(label?.split("\n").slice(0, 2)).toEqual([
      "Scratch workspace",
      "path ~/junk/20260923",
    ]);
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
    const model = scratchModel();
    model.setSidebarWidth(321);
    model.toggleSidebar();
    expect(model.snapshot().sidebar).toEqual({ width: 321, collapsed: true });
    model.toggleSidebar();
    expect(model.snapshot().sidebar).toEqual({ width: 321, collapsed: false });
  });
});

/**
 * In a rail the words are off and the glyph is all there is, and the entry the
 * pointer is on selects the row, because in the rail the entry is the whole of
 * what there is to click.
 */
describe("what a rail entry does under the pointer", () => {
  /** The row's own select control, named by the tree item it is. */
  function selectButton(item: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-tree-item-id="${item}"]`,
    );
    if (!button) throw new Error(`no tree item ${item}`);
    return button;
  }

  it("selects the row, and does not open the repository", () => {
    const rail = mount(true, REPOSITORY);
    expect(screen.queryByRole("button", { name: /on GitHub$/u })).toBeNull();
    selectButton("workspace:w-1").click();
    expect(rail.openExternalUrl).not.toHaveBeenCalled();
    expect(rail.dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "workspace", workspaceId: "w-1" },
    });
  });

  it("leaves the expanded row's folder glyph no link: it is part of the row", () => {
    // The glyph used to open the repository's page, and people pressed it
    // meaning to select the row. It is an inert mark now, under the select
    // button's hit area, so a click on it is a click on the row. The way to
    // GitHub is the row's trailing marks.
    mount(false, REPOSITORY);
    const glyph = document.querySelector(".workspace-row .row-glyph");
    expect(glyph?.tagName).toBe("SPAN");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: /on GitHub$/u })).toBeNull();
    expect(document.querySelector(".row-glyph-button")).toBeNull();
  });

  it("puts no link of any kind in the rail", () => {
    // Not hidden — absent. A link that is merely invisible is still a link the
    // pointer can find.
    mount(true, REPOSITORY);
    expect(document.querySelector(".row-marks")).toBeNull();
  });

  it("says in the rail exactly what the expanded row says", () => {
    mount(false, REPOSITORY);
    const expandedWorkspace =
      selectButton("workspace:w-1").getAttribute("aria-label");
    const expandedAgent = screen
      .getByRole("button", { name: /^Codex/u })
      .getAttribute("aria-label");
    cleanup();
    mount(true, REPOSITORY);
    expect(selectButton("workspace:w-1")).toHaveAttribute(
      "aria-label",
      expandedWorkspace,
    );
    expect(screen.getByRole("button", { name: /^Codex/ })).toHaveAttribute(
      "aria-label",
      expandedAgent,
    );
  });

  it("carries the branch and the work in the row's accessible name", () => {
    mount(true, REPOSITORY);
    const button = selectButton("workspace:w-1");
    expect(button.getAttribute("aria-label")).toBe(
      [
        "widget workspace",
        "path /projects/widget",
        "repository github.com/example/widget",
        "branch feature/128-tidy",
        "Issue #128, open: Tidy the rail",
        "Pull request #131, draft: Tidy the rail",
      ].join("\n"),
    );
  });
});
