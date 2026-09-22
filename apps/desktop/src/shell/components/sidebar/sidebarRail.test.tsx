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

import { readFileSync } from "node:fs";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type {
  SidebarAreaWire,
  TooltipRequestWire,
} from "../../../ipc/contract";
import { scratchModel } from "../../../model/testWorkspaces";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
  onMenuCommand: () => () => undefined,
  // The Sidebar asks main for its tooltips now rather than drawing them
  // (`RowTooltip.tsx`), so every render of it reaches these three.
  onSidebarArea: () => () => undefined,
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
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
    scratchWorkspaceId: SCRATCH_ID,
    workspaces: [
      scratchWorkspace(),
      {
        id: "w-1",
        label: "widget",
        location: { kind: "local" },
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
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const value = {
    dispatch,
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
      <Sidebar snapshot={snapshot(collapsed)} />
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

  it("names each row in a tooltip, since the words are off", () => {
    mount(true);
    const lines = JSON.parse(
      screen
        .getByRole("button", { name: /^Scratch workspace/ })
        .closest(".sidebar-row")
        ?.getAttribute("data-tooltip-lines") ?? "[]",
    ) as { text: string }[];
    expect(lines.map((line) => line.text).slice(0, 2)).toEqual([
      "Scratch",
      "~/junk/20260923",
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
 * The pointer, in a rail, is in the position a screen reader is always in: the
 * words are off and the glyph is all there is. So it is told the same thing —
 * one composition, handed to `aria-label` when the row is drawn and to `title`
 * when it is not — and the entry it points at selects the row, because in the
 * rail the entry is the whole of what there is to click.
 */
describe("what a rail entry does under the pointer", () => {
  /**
   * The row's own select control, named by the tree item it is.
   *
   * By the attribute and not by its accessible name: the folder glyph is the
   * link to the repository's page and says the same sentence with "open on
   * GitHub" after it, so a name match would find two buttons in the expanded
   * row and one in the rail, which is the difference this file is about.
   */
  function selectButton(item: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-tree-item-id="${item}"]`,
    );
    if (!button) throw new Error(`no tree item ${item}`);
    return button;
  }

  /**
   * The element a tooltip would be raised from for something inside a row.
   *
   * The same walk `RowTooltip` does — `closest()` up from whatever the pointer
   * came to rest on — so this asks the question the pointer asks rather than
   * naming the element the answer happens to be.
   */
  function rowTooltip(inside: Element): HTMLElement {
    const element = inside.closest<HTMLElement>("[data-tooltip-lines]");
    if (!element) throw new Error("nothing here raises a tooltip");
    return element;
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

  it("leaves the expanded row's folder glyph the link it is", () => {
    // The same rule from the other side: with the words on, the glyph is a
    // sibling of the select button and is the way to the repository's page.
    // Only the rail folds it in, and only because there the entry is all there
    // is to click.
    const expanded = mount(false, REPOSITORY);
    const glyph = document.querySelector<HTMLButtonElement>(
      ".workspace-row .row-glyph-button",
    );
    expect(glyph).not.toBeNull();
    glyph?.click();
    expect(expanded.openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget",
    );
    expect(expanded.dispatch).not.toHaveBeenCalled();
  });

  it("puts no link of any kind in the rail", () => {
    // Not hidden — absent. A link that is merely invisible is still a link the
    // pointer can find.
    mount(true, REPOSITORY);
    expect(document.querySelector(".row-glyph-button")).toBeNull();
    expect(document.querySelector(".row-marks")).toBeNull();
  });

  it("says in the tooltip exactly what the expanded row says", () => {
    mount(false, REPOSITORY);
    const expandedWorkspace = rowTooltip(
      selectButton("workspace:w-1"),
    ).getAttribute("data-tooltip-lines");
    const expandedAgent = rowTooltip(
      screen.getByRole("button", { name: /^Codex/u }),
    ).getAttribute("data-tooltip-lines");
    cleanup();
    mount(true, REPOSITORY);
    expect(rowTooltip(selectButton("workspace:w-1"))).toHaveAttribute(
      "data-tooltip-lines",
      expandedWorkspace,
    );
    expect(
      rowTooltip(screen.getByRole("button", { name: /^Codex/ })),
    ).toHaveAttribute("data-tooltip-lines", expandedAgent);
  });

  /**
   * The facts, and no label words: the mark in front of each line is what the
   * word "branch" used to be. The words survive in `aria-label`, which is the
   * one reader that has no mark to look at.
   *
   * Three of the facts carry a `href` as well, and it is the row's own URL
   * rather than a second one composed here: the tooltip draws those facts as
   * the same links the row draws, so the box and the row cannot lead anywhere
   * different.
   */
  it("carries the branch and the work as facts, each behind its own mark", () => {
    mount(true, REPOSITORY);
    const button = selectButton("workspace:w-1");
    const row = rowTooltip(button);
    expect(JSON.parse(row.getAttribute("data-tooltip-lines") ?? "[]")).toEqual([
      { text: "widget", style: "name" },
      { text: "/projects/widget", style: "muted" },
      {
        icon: "repository",
        text: "github.com/example/widget",
        style: "muted",
        href: "https://github.com/example/widget",
      },
      { icon: "branch", text: "feature/128-tidy", style: "muted" },
      {
        icon: "issueOpen",
        text: "#128 Tidy the rail",
        style: "muted",
        href: "https://github.com/example/widget/issues/128",
      },
      {
        icon: "pullRequestDraft",
        text: "#131 Tidy the rail",
        style: "muted",
        href: "https://github.com/example/widget/pull/131",
      },
    ]);
    // The spoken sentence stays on the control that is spoken: the facts are
    // the row's and the name is the button's, which is the one reader that has
    // no mark to look at.
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

  /**
   * The rail's Agent entry, which had no tooltip at all.
   *
   * The lines were on the select button, and in the rail an Agent's button
   * holds nothing: its mark is the sibling in the icon column and its words
   * are off, so it is a zero-by-zero box. `RowTooltip` clips a row's box to
   * the column and asks for nothing when what comes back is empty — which is
   * every rail Agent, every time. A Workspace's button kept a box because the
   * rail draws its glyph inside it, which is why one kind of entry answered
   * the pointer and the other did not.
   *
   * So the anchor is the row, in both states and for both kinds of entry, and
   * the row is what the tooltip was always about.
   */
  it("raises an Agent's tooltip from the row, which the rail leaves a box", () => {
    mount(true, REPOSITORY);
    const mark = document.querySelector(".agent-row .row-glyph");
    if (!mark) throw new Error("the rail draws no status mark");
    const row = rowTooltip(mark);
    expect(row).toHaveClass("agent-row");
    expect(JSON.parse(row.getAttribute("data-tooltip-lines") ?? "[]")).toEqual([
      { icon: "statusUnread", text: "Codex", tone: "idle" },
    ]);
    // The element it used to be on, and the two rules that leave it without a
    // box: its words come off and it is told to take no width. The markup is
    // the same in both states — the collapse is drawn — so this is a fact
    // about the stylesheet and there is nowhere else for it to be said.
    const shell = readFileSync("src/shell/styles/shell.css", "utf8");
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .row-text,\n.sidebar[data-collapsed="true"] .sidebar-empty {\n  display: none;\n}',
    );
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .agent-row .sidebar-context-button {\n  flex: 0 0 0;',
    );
  });

  /**
   * And the pointer resting on it asks main for that tooltip. The attribute
   * being in the markup is half the fact; the other half is that the walk from
   * what the pointer is actually over — the status mark, which is not inside
   * the button — reaches it.
   */
  it("asks main for it when the pointer rests on a rail Agent", () => {
    vi.useFakeTimers();
    const asked: TooltipRequestWire[] = [];
    let pushArea: ((area: SidebarAreaWire) => void) | undefined;
    const devhub = window.devhub;
    window.devhub = {
      ...(devhub as unknown as Record<string, unknown>),
      onSidebarArea: (listener: (area: SidebarAreaWire) => void) => {
        pushArea = listener;
        return () => (pushArea = undefined);
      },
      showTooltip: (request: TooltipRequestWire) => asked.push(request),
    } as unknown as typeof window.devhub;
    try {
      mount(true, REPOSITORY);
      act(() => {
        if (!pushArea) throw new Error("the page never asked where it is");
        // The rail with no title bar: the traffic lights' span.
        pushArea({ x: 0, y: 38, width: 76, height: 862 });
      });
      const row = document.querySelector(".agent-row");
      const mark = row?.querySelector(".row-glyph");
      if (!row || !mark) throw new Error("the rail draws no Agent");
      // jsdom lays nothing out, so the row says where it is.
      row.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 40,
          top: 60,
          bottom: 86,
          width: 40,
          height: 26,
        }) as DOMRect;
      fireEvent.pointerOver(mark);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(asked).toHaveLength(1);
      expect(asked[0]?.lines).toEqual([
        { icon: "statusUnread", text: "Codex", tone: "idle" },
      ]);
      expect(asked[0]?.anchor).toEqual({
        x: 0,
        y: 38 + 60,
        width: 40,
        height: 26,
      });
    } finally {
      vi.useRealTimers();
      window.devhub = devhub;
    }
  });
});
