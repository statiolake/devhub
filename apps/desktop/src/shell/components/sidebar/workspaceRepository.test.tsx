// @vitest-environment jsdom

/**
 * What a Workspace row says about the work in it.
 *
 * The branch and the Issue live on the *Workspace* row, because the Issue is
 * recorded against the workspace: one fact, one place. The marks are links
 * rather than decoration, and the reason a look failed is drawn beside what is
 * still known rather than instead of it.
 */

import { readFileSync } from "node:fs";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppSnapshot,
  TerminalActivityWire,
  WorkspaceCloseWire,
} from "../../../ipc/appShell";
import type { RepositoryStatusWire } from "../../../ipc/contract";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { ON_SCRATCH, SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

// The Sidebar asks main to put modals on screen and listens for menu
// commands. Both are what the component genuinely does, so the bridge is
// present rather than mocked away — and `openModal` is watched, because
// *whether a question is asked at all* is now part of what a row decides.
const openModal = vi.fn(() => Promise.resolve(""));
window.devhub = {
  openModal,
  onMenuCommand: () => () => undefined,
  // The Sidebar asks main for its tooltips now rather than drawing them
  // (`RowTooltip.tsx`), so every render of it reaches these three.
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

const SNAPSHOT = {
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
      agents: [],
    },
  ],
} as unknown as AppSnapshot;

function mount(
  repositoryStatus: RepositoryStatusWire,
  /** The workspace's own state, for the one test that is about a failed close. */
  workspaceClose: WorkspaceCloseWire = { kind: "idle" },
  /** What the workspace's own terminals are doing (`WorkspaceWire.terminals`). */
  terminals?: TerminalActivityWire,
) {
  const openExternalUrl = vi.fn();
  const answerWorktreeClose = vi.fn(() => Promise.resolve({}));
  const closeWorkspace = vi.fn();
  const dispatch = vi.fn();
  const reportFailure = vi.fn();
  const value = {
    dispatch,
    openExternalUrl,
    answerWorktreeClose,
    closeWorkspace,
    reportFailure,
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus,
    usageLimits: { clis: [] },
  } as unknown as SidebarValue;
  const snapshot = {
    ...SNAPSHOT,
    workspaces: SNAPSHOT.workspaces.map((workspace) => ({
      ...workspace,
      close: workspaceClose,
      ...(terminals === undefined || workspace.id !== "w-1"
        ? {}
        : { terminals }),
    })),
  } as unknown as AppSnapshot;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot} />
    </SidebarContext.Provider>,
  );
  return {
    dispatch,
    openExternalUrl,
    answerWorktreeClose,
    closeWorkspace,
    reportFailure,
  };
}

const WORKING_ON: RepositoryStatusWire = {
  sequence: 3,
  workspaces: [
    {
      workspaceId: "w-1",
      branch: "feature/128-tidy",
      issue: {
        url: "https://github.com/example/widget/issues/128",
        number: 128,
        title: "Tidy the picker",
        state: "open",
      },
      pullRequest: {
        number: 210,
        url: "https://github.com/example/widget/pull/210",
        title: "Tidy the picker, at last",
        state: "draft",
        conversations: { unresolved: 0, uncounted: 0 },
      },
    },
  ],
};

/**
 * What the row's tooltip says, line by line. The marks and buttons inside a
 * row have no tooltip of their own — the pointer on any of them is the pointer
 * on the row — so everything they used to say is read here.
 */
type TipLine = {
  icon?: string;
  text: string;
  style?: string;
  href?: string;
};
function rowTip(): TipLine[] {
  const row = document.querySelector(".workspace-row:not(.is-scratch)");
  return JSON.parse(
    row?.getAttribute("data-tooltip-lines") ?? "[]",
  ) as TipLine[];
}
/** The same lines as icon and text only, which is what a test compares. */
function tipFacts(
  lines: TipLine[] = rowTip(),
): { icon?: string; text: string }[] {
  return lines.map(({ icon, text }) =>
    icon === undefined ? { text } : { icon, text },
  );
}
/** The pull request's lines in the row's tooltip. */
function prLines(): { icon?: string; text: string }[] {
  return tipFacts().filter((line) =>
    /^(pullRequest|conversation|checks)/u.test(line.icon ?? ""),
  );
}

describe("a workspace row's terminals", () => {
  const row = () =>
    document.querySelector(".workspace-row:not(.is-scratch)") as HTMLElement;

  it("draws nothing while its terminals are idle and read — no check mark", () => {
    mount(WORKING_ON);
    expect(row().querySelector(".row-terminal-activity")).toBeNull();
    expect(row().querySelector(".status-mark")).toBeNull();
  });

  it("draws the Agents' working mark while a command runs", () => {
    mount(WORKING_ON, { kind: "idle" }, { status: "working" });
    const mark = row().querySelector(".row-terminal-activity .status-mark");
    expect(mark).toHaveAttribute("data-status", "working");
    expect(mark).toHaveAttribute("aria-label", "Terminal: Working");
    expect(row()).not.toHaveClass("is-unread");
    expect(
      row()
        .querySelector(".sidebar-context-button")
        ?.getAttribute("aria-label"),
    ).toContain("terminal working");
  });

  it("draws the Agents' unread mark when a command finished unseen", () => {
    mount(WORKING_ON, { kind: "idle" }, { status: "idle", unread: "idle" });
    const mark = row().querySelector(".row-terminal-activity .status-mark");
    expect(mark).toHaveAttribute("data-unread", "true");
    expect(mark?.querySelector("svg")?.getAttribute("data-glyph")).toBe(
      "statusUnread",
    );
    expect(mark).toHaveAttribute("aria-label", "Terminal: Idle, unread");
    expect(row()).toHaveClass("is-unread");
  });
});

describe("a workspace row", () => {
  it("says its name and the Issue's icon, in the branch's place, when the Issue is known", () => {
    // `{name} {icon}` and then the pull request's mark. Neither the branch nor
    // the Issue's title is drawn in words: the icon says there is an Issue and
    // in which state, and everything else is in its tooltip.
    mount(WORKING_ON);
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    expect(row?.querySelector(".row-text")?.textContent).toBe("widget");
    expect(row?.querySelector(".row-label")?.textContent).toBe("widget");
    expect(row?.querySelector(".row-branch")).toBeNull();
    const mark = row?.querySelector(".row-issue-title");
    expect(mark?.querySelector("svg")?.getAttribute("data-glyph")).toBe(
      "issueOpen",
    );
    // No title text anywhere on the row: not in the mark, not after it.
    expect(mark?.textContent).toBe("");
    expect(row?.textContent).not.toContain("Tidy the picker");
    // The pull request is the trailing group's last mark; the Issue is not in
    // that group any more.
    const marks = row?.querySelector(".row-marks");
    expect(marks?.querySelector(".is-issue-open")).toBeNull();
    expect(marks?.lastElementChild).toHaveClass("is-pr-draft");
    // The mark has no hover of its own. Everything the row no longer says in
    // words is in the row's tooltip: the number and the whole title, as the
    // link to the Issue, and the branch.
    expect(mark).not.toHaveAttribute("data-tooltip");
    expect(mark).not.toHaveAttribute("data-tooltip-lines");
    expect(rowTip()).toContainEqual({
      icon: "issueOpen",
      text: "#128 Tidy the picker",
      style: "muted",
      href: "https://github.com/example/widget/issues/128",
    });
    expect(tipFacts()).toContainEqual({
      icon: "branch",
      text: "feature/128-tidy",
    });
    // And in its accessible name, for whoever cannot hover.
    expect(mark).toHaveAttribute(
      "aria-label",
      "Issue #128, open: Tidy the picker",
    );
  });

  it("names the repository the workspace numbers its Issues in, over the URL's", () => {
    mount({
      sequence: 1,
      workspaces: [
        {
          ...WORKING_ON.workspaces[0],
          issueRepository: { owner: "upstream-org", repository: "widget" },
          issue: {
            url: "https://example.invalid/128",
            number: 128,
            title:
              "A title long enough that it would never have fitted on the row at all",
            state: "open",
          },
        },
      ],
    });
    const mark = document.querySelector(".row-issue-title");
    expect(mark?.textContent).toBe("");
    const lines = tipFacts();
    const at = lines.findIndex((line) => line.icon === "issueOpen");
    expect(lines.slice(at, at + 2)).toEqual([
      {
        icon: "issueOpen",
        text: "#128 A title long enough that it would never have fitted on the row at all",
      },
      { icon: "repository", text: "Issue in upstream-org/widget" },
    ]);
    // An address that is not a GitHub page is not drawn as a link.
    expect(rowTip()[at]?.href).toBeUndefined();
  });

  it("says its name and the branch, with the marks trailing, when the Issue is not known", () => {
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "spike/rework",
          pullRequest: {
            number: 9,
            url: "p",
            title: "Rework",
            state: "open",
            conversations: { unresolved: 0, uncounted: 0 },
          },
        },
      ],
    });
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    expect(row?.querySelector(".row-text")?.textContent).toBe(
      "widgetspike/rework",
    );
    expect(row?.querySelector(".row-branch")?.textContent).toBe("spike/rework");
    expect(row?.querySelector(".row-issue-title")).toBeNull();
    expect(row?.querySelector(".row-marks .is-pr-open")).not.toBeNull();
  });

  it("opens the Issue from its mark and from its icon", () => {
    const { openExternalUrl } = mount(WORKING_ON);
    const mark = document.querySelector(".row-issue-title") as HTMLElement;
    fireEvent.click(mark);
    fireEvent.click(mark.querySelector("svg") as unknown as HTMLElement);
    expect(openExternalUrl).toHaveBeenCalledTimes(2);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget/issues/128",
    );
  });

  it("spends no words on the Issue's number", () => {
    mount(WORKING_ON);
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    expect(row?.textContent).not.toContain("#128");
  });

  it("is the same one line for a workspace that is only a repository", () => {
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "main",
          mainWorktree: "/projects/widget",
          repositoryUrl: "https://github.com/example/widget",
        },
      ],
    });
    expect(
      document.querySelectorAll(".workspace-row:not(.is-scratch) .row-text"),
    ).toHaveLength(1);
    expect(
      document.querySelector(".workspace-row:not(.is-scratch)")?.textContent,
    ).toBe("widgetmain");
  });

  it("says what the pull request is called in the row's tooltip, not the mark's", () => {
    // A branch that names no Issue can still have a pull request out from it,
    // and then the pull request is what the work is called. The mark has no
    // hover of its own; the row's tooltip says it, as the link to it.
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "spike/rework",
          pullRequest: {
            number: 7,
            url: "https://github.com/example/widget/pull/7",
            title: "Rework the picker",
            state: "open",
            conversations: { unresolved: 0, uncounted: 0 },
          },
        },
      ],
    });
    expect(
      document.querySelector(".row-link-button.is-pr-open"),
    ).not.toHaveAttribute("data-tooltip-lines");
    expect(prLines()).toEqual([
      { icon: "pullRequest", text: "#7 Rework the picker" },
    ]);
    expect(rowTip()).toContainEqual({
      icon: "pullRequest",
      text: "#7 Rework the picker",
      style: "muted",
      href: "https://github.com/example/widget/pull/7",
    });
  });

  /**
   * One drawing per pull-request state, and they are GitHub's own.
   *
   * This used to be two drawings and four colours: `merged` had a silhouette
   * and the other three were told apart by hue alone. Four shapes is what lets
   * the Sidebar go grey at rest — a mark whose state lives only in its colour
   * cannot be greyed without losing the state, and greying everything but an
   * Agent's status is the whole point of the column. It is also what a person
   * who reads GitHub all day already knows by heart.
   */
  it.each([
    ["open", "pullRequest"],
    ["draft", "pullRequestDraft"],
    ["closed", "pullRequestClosed"],
    ["merged", "pullRequestMerged"],
  ] as const)("draws a %s pull request as GitHub draws it", (state, glyph) => {
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          pullRequest: {
            number: 9,
            url: "p",
            title: "Tidy the picker",
            state,
            conversations: { unresolved: 0, uncounted: 0 },
          },
        },
      ],
    });
    const mark = document.querySelector(`.row-link-button.is-pr-${state}`);
    expect(mark).toHaveAttribute(
      "aria-label",
      expect.stringContaining(`Pull request #9, ${state}`),
    );
    expect(mark?.querySelector("svg")?.getAttribute("data-glyph")).toBe(glyph);
  });

  it.each([
    ["open", "issueOpen"],
    ["closed", "issueClosed"],
  ] as const)("draws a %s Issue as GitHub draws it", (state, glyph) => {
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          issue: { number: 128, url: "i", title: "Tidy the picker", state },
        },
      ],
    });
    const mark = document.querySelector(`.row-issue-title.is-issue-${state}`);
    expect(mark).toHaveAttribute(
      "aria-label",
      expect.stringContaining(`Issue #128, ${state}`),
    );
    expect(mark?.querySelector("svg")?.getAttribute("data-glyph")).toBe(glyph);
  });

  it("gives every pull-request state a drawing of its own", () => {
    // Not four references to two pictures. If two states ever shared a
    // silhouette again, the grey column would stop saying which one it is.
    const drawn = new Set<string>();
    for (const state of ["open", "draft", "closed", "merged"] as const) {
      cleanup();
      mount({
        sequence: 1,
        workspaces: [
          {
            workspaceId: "w-1",
            pullRequest: {
              number: 9,
              url: "p",
              title: "t",
              state,
              conversations: { unresolved: 0, uncounted: 0 },
            },
          },
        ],
      });
      drawn.add(
        document.querySelector(".row-marks .row-link-button svg")?.innerHTML ??
          "",
      );
    }
    expect(drawn.size).toBe(4);
  });
});

/**
 * Whether anybody is still waiting on an answer in the pull request.
 *
 * A pull request whose review conversations are all resolved says nothing
 * about them, and one with any left open wears a small conversation mark over
 * its own, and the row's tooltip says how many — the same words the mark's
 * spoken name carries, from one list of facts.
 */
describe("a pull request's unresolved conversations", () => {
  function withConversations(unresolved: number, uncounted = 0) {
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          pullRequest: {
            number: 7,
            url: "https://github.com/example/widget/pull/7",
            title: "Rework the picker",
            state: "open",
            conversations: { unresolved, uncounted },
          },
        },
      ],
    });
    return document.querySelector(".row-link-button.is-pr-open");
  }

  it("puts the conversation mark on the pull request mark", () => {
    const mark = withConversations(3);
    const badge = mark?.querySelector(".row-mark-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("data-glyph")).toBe("conversation");
    // The pull request's own drawing is still the mark's first, untouched.
    expect(mark?.querySelector("svg")?.getAttribute("data-glyph")).toBe(
      "pullRequest",
    );
  });

  it("says how many in the row's tooltip, and to a reader", () => {
    const mark = withConversations(3);
    expect(mark).not.toHaveAttribute("data-tooltip-lines");
    expect(prLines()).toEqual([
      { icon: "pullRequest", text: "#7 Rework the picker" },
      { icon: "conversation", text: "3 unresolved conversations" },
    ]);
    expect(mark).toHaveAttribute(
      "aria-label",
      "Pull request #7, open: Rework the picker\n3 unresolved conversations",
    );
  });

  it("says one conversation in the singular", () => {
    withConversations(1);
    expect(JSON.stringify(prLines())).toContain('"1 unresolved conversation"');
  });

  it("says it in the row's own tooltip too", () => {
    withConversations(2);
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    expect(
      JSON.parse(row?.getAttribute("data-tooltip-lines") ?? "[]"),
    ).toContainEqual({
      icon: "conversation",
      text: "2 unresolved conversations",
      style: "muted",
    });
  });

  it("draws nothing and says nothing when every conversation is resolved", () => {
    const mark = withConversations(0);
    expect(mark?.querySelector(".row-mark-badge")).toBeNull();
    expect(prLines()).toEqual([
      { icon: "pullRequest", text: "#7 Rework the picker" },
    ]);
    expect(
      document
        .querySelector(".workspace-row:not(.is-scratch)")
        ?.getAttribute("data-tooltip-lines"),
    ).not.toContain("conversation");
  });

  it("draws nothing when there is no pull request to be about", () => {
    mount({
      sequence: 1,
      workspaces: [{ workspaceId: "w-1", branch: "feature/128-tidy" }],
    });
    expect(document.querySelector(".row-mark-badge")).toBeNull();
  });

  it("says a count read from one page of threads is only that", () => {
    const mark = withConversations(4, 150);
    expect(mark?.querySelector(".row-mark-badge")).not.toBeNull();
    expect(JSON.stringify(prLines())).toContain(
      '"4 unresolved conversations, 150 more not counted"',
    );
  });

  it("does not draw a conversation it did not count, but says it went uncounted", () => {
    const mark = withConversations(0, 150);
    expect(mark?.querySelector(".row-mark-badge")).toBeNull();
    expect(JSON.stringify(prLines())).toContain(
      '"0 unresolved conversations, 150 more not counted"',
    );
  });
});

/**
 * What the pull request's CI says.
 *
 * A failure wears a red cross and a run still going an amber dot, at the pull
 * request mark's bottom-right; a pass is said in words and not drawn, because
 * it is the ordinary case and asks nothing. Nothing is drawn or said when
 * nothing has reported. The words are the same in the row's tooltip and the
 * mark's spoken name, from one list of facts.
 */
describe("a pull request's CI", () => {
  function withChecks(
    checks:
      | NonNullable<
          NonNullable<
            RepositoryStatusWire["workspaces"][number]["pullRequest"]
          >["checks"]
        >
      | undefined,
    unresolved = 0,
  ) {
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          pullRequest: {
            number: 7,
            url: "https://github.com/example/widget/pull/7",
            title: "Rework the picker",
            state: "open",
            conversations: { unresolved, uncounted: 0 },
            ...(checks === undefined ? {} : { checks }),
          },
        },
      ],
    });
    return document.querySelector(".row-link-button.is-pr-open");
  }

  function badges(mark: Element | null) {
    return [...(mark?.querySelectorAll(".row-mark-badge") ?? [])].map((badge) =>
      badge.getAttribute("data-glyph"),
    );
  }

  // The mark has no hover of its own; what it would have said is in the
  // row's tooltip.
  function hover(mark: Element | null) {
    expect(mark).not.toHaveAttribute("data-tooltip-lines");
    return prLines() as unknown;
  }

  it("wears a cross when it is failing, and says how many of how many", () => {
    const mark = withChecks({
      state: "failing",
      total: 12,
      failing: 3,
      pending: 0,
    });
    expect(badges(mark)).toEqual(["checksFailing"]);
    expect(hover(mark)).toEqual([
      { icon: "pullRequest", text: "#7 Rework the picker" },
      { icon: "checksFailing", text: "CI: failing (3 of 12 checks)" },
    ]);
    expect(mark).toHaveAttribute(
      "aria-label",
      "Pull request #7, open: Rework the picker\nCI: failing (3 of 12 checks)",
    );
  });

  it("wears a dot while it is pending, and says how many have not finished", () => {
    const mark = withChecks({
      state: "pending",
      total: 12,
      failing: 0,
      pending: 4,
    });
    expect(badges(mark)).toEqual(["checksPending"]);
    expect(hover(mark)).toContainEqual({
      icon: "checksPending",
      text: "CI: pending (4 of 12 checks)",
    });
  });

  it("wears nothing when it is passing, and says so in words", () => {
    const mark = withChecks({
      state: "passing",
      total: 1,
      failing: 0,
      pending: 0,
    });
    expect(badges(mark)).toEqual([]);
    expect(hover(mark)).toContainEqual({
      icon: "checksPassing",
      text: "CI: passing (1 check)",
    });
  });

  it("says the verdict alone when none of the counted checks are in it", () => {
    const mark = withChecks({
      state: "failing",
      total: 5,
      failing: 0,
      pending: 0,
    });
    expect(badges(mark)).toEqual(["checksFailing"]);
    expect(hover(mark)).toContainEqual({
      icon: "checksFailing",
      text: "CI: failing",
    });
  });

  it("draws nothing and says nothing when nothing has reported", () => {
    const mark = withChecks(undefined);
    expect(badges(mark)).toEqual([]);
    expect(JSON.stringify(hover(mark))).not.toContain("CI:");
  });

  it("sits beside the conversation badge, each saying its own line", () => {
    const mark = withChecks(
      { state: "failing", total: 12, failing: 3, pending: 0 },
      2,
    );
    expect(badges(mark)).toEqual(["conversation", "checksFailing"]);
    expect(hover(mark)).toEqual([
      { icon: "pullRequest", text: "#7 Rework the picker" },
      { icon: "conversation", text: "2 unresolved conversations" },
      { icon: "checksFailing", text: "CI: failing (3 of 12 checks)" },
    ]);
  });

  it("says it in the row's own tooltip too", () => {
    withChecks({ state: "pending", total: 3, failing: 0, pending: 1 });
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    expect(
      JSON.parse(row?.getAttribute("data-tooltip-lines") ?? "[]"),
    ).toContainEqual({
      icon: "checksPending",
      text: "CI: pending (1 of 3 checks)",
      style: "muted",
    });
  });
});

/**
 * Which mark a row starts with.
 *
 * Two, where there were four. A repository and a worktree of one had marks of
 * their own and the column paid twice: three silhouettes to tell apart at
 * thirteen pixels, bought with a distinction that changes nothing about what
 * the row is or what can be done to it. Every Workspace is a folder you have
 * open. The one distinction left is *where* — a folder on another machine is a
 * different thing to open, to close and to run an Agent in.
 */
describe("the mark a workspace row starts with", () => {
  function leadingGlyph(): string | undefined {
    return (
      document
        .querySelector(".workspace-row:not(.is-scratch) .row-glyph svg")
        ?.getAttribute("data-glyph") ?? undefined
    );
  }

  it("is a folder, whatever kind of checkout the folder is", () => {
    for (const workspaces of [
      [{ workspaceId: "w-1" }],
      [
        {
          workspaceId: "w-1",
          branch: "main",
          mainWorktree: "/projects/widget",
          worktree: "/projects/widget",
        },
      ],
      [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          mainWorktree: "/projects/other",
          worktree: "/projects/widget",
        },
      ],
    ]) {
      mount({ sequence: 1, workspaces });
      expect(leadingGlyph()).toBe("folder");
      cleanup();
    }
  });

  /** Being a worktree is still said — in words, where it is a fact and not a
      shape a person has to learn. */
  it("says a worktree is one in the row's facts, not in its mark", () => {
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          mainWorktree: "/projects/other",
          worktree: "/projects/widget",
        },
      ],
    });
    const button = document.querySelector(
      "[data-tree-item-id='workspace:w-1']",
    );
    const row = button?.closest("[data-tooltip-lines]");
    expect(
      JSON.parse(row?.getAttribute("data-tooltip-lines") ?? "[]"),
    ).toContainEqual({
      icon: "worktree",
      text: "/projects/other",
      style: "muted",
    });
    expect(button?.getAttribute("aria-label")).toContain(
      "worktree of /projects/other",
    );
  });

  it("offers no worktree removal for a folder inside one", () => {
    // The row is /projects/widget and the checkout it is in starts at
    // /projects, which is also the repository, so nothing here is a worktree
    // root and nothing is going to be deleted.
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "main",
          mainWorktree: "/projects",
          worktree: "/projects",
        },
      ],
    });
    expect(
      screen.queryByRole("button", { name: /Remove the worktree/u }),
    ).toBeNull();
  });

  it("is no link even when there is a repository behind it", () => {
    // The folder used to open the repository's page, and people pressed it
    // meaning to select the row. It is inert now: under the select button's
    // hit area, so a click on it is a click on the row.
    const { openExternalUrl } = mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "main",
          mainWorktree: "/projects/widget",
          worktree: "/projects/widget",
          repositoryUrl: "https://github.com/example/widget",
        },
      ],
    });
    expect(leadingGlyph()).toBe("folder");
    const glyph = document.querySelector(
      ".workspace-row:not(.is-scratch) .row-glyph",
    );
    expect(glyph?.tagName).toBe("SPAN");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: /on GitHub/u })).toBeNull();
    fireEvent.click(glyph!);
    expect(openExternalUrl).not.toHaveBeenCalled();
    // Its CSS does not raise it over the select button's hit area, which is
    // what makes a click on it land on the row in the app.
    const shell = readFileSync("src/shell/styles/shell.css", "utf8");
    expect(shell).not.toContain("row-glyph-button");
  });

  it("is inert, and not a control at all, when there is no repository", () => {
    // The row is selected by clicking it, because the select button's hit
    // area runs under the whole row.
    mount({
      sequence: 1,
      workspaces: [{ workspaceId: "w-1", branch: "main" }],
    });
    const glyph = document.querySelector(
      ".workspace-row:not(.is-scratch) .row-glyph",
    );
    expect(glyph?.tagName).toBe("SPAN");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: /on GitHub/u })).toBeNull();
  });

  it("leaves the trailing group to what the row is for, not what it is", () => {
    // What this is a checkout of is a line in the row's tooltip. Nothing in
    // the mark group draws it.
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "main",
          repositoryUrl: "https://github.com/example/widget",
        },
      ],
    });
    expect(document.querySelector(".row-mark-repository")).toBeNull();
    expect(
      document.querySelector(".row-marks [data-glyph='repository']"),
    ).toBeNull();
    expect(
      document.querySelector(".row-marks [data-glyph='worktree']"),
    ).toBeNull();
  });
});

describe("a workspace row, continued", () => {
  it("says only its name when there is nothing else to say", () => {
    mount({ sequence: 1, workspaces: [] });
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    expect(row?.querySelector(".row-label")?.textContent).toBe("widget");
    expect(row?.querySelector(".row-branch")).toBeNull();
  });

  it("offers no repository button for a remote it cannot name a page for", () => {
    mount({
      sequence: 1,
      workspaces: [{ workspaceId: "w-1", branch: "main" }],
    });
    expect(screen.queryByRole("button", { name: /on GitHub/u })).toBeNull();
  });

  describe("getting rid of a workspace", () => {
    const worktree = (dirty: boolean | undefined) => ({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          // The row is /projects/widget, and so is the checkout it is in; the
          // repository is somewhere else. So this workspace is a worktree of
          // it, and it is the worktree's root rather than a folder inside it.
          mainWorktree: "/projects/other",
          worktree: "/projects/widget",
          ...(dirty === undefined ? {} : { dirty }),
        },
      ],
    });
    const close = () =>
      screen.queryByRole("button", { name: /^Close (the worktree )?widget/u });

    it("offers one close, and no second control that means the same thing", () => {
      // The row used to have a close *and* a trash, so whether a worktree
      // survived depended on which of the two you happened to press. There is
      // one button now, and one rule behind it.
      mount(worktree(true));
      expect(close()).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Remove the worktree/u }),
      ).toBeNull();
    });

    it("asks main to close it, whatever kind of workspace it is", () => {
      // The page no longer decides whether a worktree is deleted, or whether
      // to ask first. It could only decide it from a poll up to a minute old,
      // and the chords decided the same question somewhere else — one of the
      // two was always going to be the wrong one. See
      // `closeWorkspaceOrWorktree` in `main/shell/appController.ts`.
      for (const dirty of [false, true, undefined]) {
        const { closeWorkspace } = mount(worktree(dirty));
        fireEvent.click(close() as HTMLElement);
        expect(closeWorkspace).toHaveBeenCalledWith("w-1");
        expect(openModal).not.toHaveBeenCalled();
        cleanup();
        vi.clearAllMocks();
      }
    });

    /**
     * The button says which of the two closes it is. Closing a worktree
     * deletes the folder, and a control that says "Close workspace" while
     * deleting a directory is a control that lies once and is never trusted
     * again. The ellipsis is the rest of the promise: a question may follow.
     */
    it("says it is a worktree it is about to close", () => {
      mount(worktree(true));
      const button = screen.getByRole("button", {
        name: "Close the worktree widget",
      });
      // In the row's tooltip, not the ×'s: the × has no hover of its own.
      expect(button).not.toHaveAttribute("data-tooltip");
      expect(tipFacts()).toContainEqual({
        icon: "close",
        text: "Close worktree…: removes this worktree, asking first",
      });
    });

    it("says only 'close' where nothing is going to be deleted", () => {
      // A plain folder, and a folder *inside* a worktree: `git worktree
      // remove` takes the checkout's root, so a row that is not that root is
      // closed and nothing on disk is touched.
      for (const workspaces of [
        [{ workspaceId: "w-1", branch: "main" }],
        [
          {
            workspaceId: "w-1",
            mainWorktree: "/projects/other",
            worktree: "/projects/widget/nested",
          },
        ],
      ]) {
        mount({ sequence: 1, workspaces });
        const button = screen.getByRole("button", { name: "Close widget" });
        // The × alone says "close", and the row's tooltip adds nothing.
        expect(button).not.toHaveAttribute("data-tooltip");
        expect(JSON.stringify(rowTip())).not.toContain("Close worktree");
        cleanup();
      }
    });

    it("retries a failed close through the same one close, not a second one", () => {
      // A close that failed is retried by asking for the same thing again —
      // and "the same thing" is main's one close, exactly as on the first
      // attempt. The page used to read `closing-failed` here and dispatch a
      // different intent, which is a rule the sidebar knew and the surface
      // pane did not: whether a retry went past the worktree rule depended on
      // which control you happened to press.
      const { closeWorkspace, dispatch } = mount(worktree(false), {
        kind: "failed",
        step: "terminal",
        diagnostic: "cleanup_failed",
      });
      fireEvent.click(close() as HTMLElement);
      expect(closeWorkspace).toHaveBeenCalledWith("w-1");
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("says in the row's tooltip that the × is a retry, once a close has failed", () => {
      // The × looks the same either way; that the last close stopped, and
      // why, is one line in the row's tooltip. The × has no hover.
      mount(worktree(false), {
        kind: "failed",
        step: "terminal",
        diagnostic: "cleanup_failed",
      });
      expect(close()).not.toHaveAttribute("data-tooltip");
      const lines = rowTip().filter((line) =>
        line.text.startsWith("Retry close: "),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ icon: "statusError", style: "danger" });
    });
  });

  it("opens the Issue and the pull request on GitHub", () => {
    const { openExternalUrl } = mount(WORKING_ON);

    fireEvent.click(
      document.querySelector(".row-issue-title.is-issue-open") as HTMLElement,
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget/issues/128",
    );

    fireEvent.click(
      document.querySelector(".row-link-button.is-pr-draft") as HTMLElement,
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget/pull/210",
    );
  });

  it("says nothing about an Issue when the workspace has none", () => {
    mount({
      sequence: 1,
      workspaces: [{ workspaceId: "w-1", branch: "main" }],
    });
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(document.querySelector(".row-issue-title")).toBeNull();
  });

  it("says which Issue it is about, and why, when the look failed", () => {
    // A branch called feature/128-… is about Issue 128 whether or not GitHub
    // answered. Before this the row was indistinguishable from one about no
    // Issue at all, and the reason sat at the foot of the Sidebar naming none
    // of the rows it belonged to.
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          unavailable: {
            number: 128,
            reason: "GitHub has no issue example/widget#128.",
          },
        },
      ],
    });
    // A mark rather than a sentence, and still on the row rather than only in
    // the tooltip: a failure nobody can see without hovering is a failure
    // nobody sees.
    const mark = document.querySelector(".row-mark-unavailable");
    expect(mark).toHaveAttribute(
      "aria-label",
      "#128 · GitHub has no issue example/widget#128.",
    );
    // Why, in the row's tooltip; the mark has no hover of its own.
    expect(mark).not.toHaveAttribute("data-tooltip");
    expect(tipFacts()).toContainEqual({
      icon: "statusError",
      text: "Unavailable: #128 · GitHub has no issue example/widget#128.",
    });
    // The branch is still said; it is the fact this row is named by.
    expect(screen.getByText("feature/128-tidy")).toBeInTheDocument();
    // And no Issue mark, because DevHub does not know the state to draw.
    expect(document.querySelector(".row-issue-title")).toBeNull();
  });

  it("gives the reason alone when the failure never reached an Issue number", () => {
    // git that would not run, or a remote that is not a GitHub repository:
    // there is a question and no number to put on it, so leading with `#undefined`
    // would be worse than leading with the sentence.
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          unavailable: {
            reason:
              "DevHub could not read this repository: fatal: detected dubious ownership",
          },
        },
      ],
    });
    const note = document
      .querySelector(".workspace-row:not(.is-scratch)")
      ?.querySelector(".row-mark-unavailable")
      ?.getAttribute("aria-label");
    expect(note).toContain("detected dubious ownership");
    expect(note).not.toMatch(/undefined|^#/u);
  });

  it("keeps what it knows when a look fails, and leaves the why to the toast", () => {
    // A network that dropped must not read as an issue that closed — and the
    // reason it dropped is about the whole application, not about this list,
    // so the Sidebar's foot is not where it is said. See `shell/notices.ts`.
    mount({ ...WORKING_ON, diagnostic: "GitHub answered 502." });
    expect(
      document.querySelector(".row-issue-title.is-issue-open"),
    ).toBeInTheDocument();
    expect(screen.queryByText("GitHub answered 502.")).not.toBeInTheDocument();
    expect(document.querySelector(".sidebar-status-note")).toBeNull();
  });
});

/**
 * How bright a row's marks are when nobody is pointing at them.
 *
 * A row has marks at both ends — the folder, repository or worktree glyph on
 * the left, GitHub's Issue and pull-request marks on the right — and they are
 * read in one glance, down a column, as one thing. So they rest at one ink.
 * They did not: the leading glyph sat at `--secondary` and the trailing marks
 * at `--tertiary`, which is twice the ink on the left of every row, and the
 * eye read the difference as the folder being the point.
 *
 * The assertion is on the stylesheet because that is where the fact lives; the
 * marks are `currentcolor` all the way down, and jsdom resolves no custom
 * property, so there is nothing to measure on a rendered node.
 */
describe("the ink every mark in a row rests at", () => {
  // Vitest runs from the package root, and these are files rather than modules
  // a jsdom test can import.
  const shell = readFileSync("src/shell/styles/shell.css", "utf8");
  const tokens = readFileSync("src/shell/styles/tokens.css", "utf8");

  it("is one token, named once", () => {
    expect(tokens).toContain("--row-glyph-ink: var(--tertiary);");
  });

  it("is what the leading glyph and GitHub's marks both take at rest", () => {
    // Both sites, by the token and not by a value that happens to match it: a
    // later change to the ink has to move both or neither.
    expect(shell).toContain(
      ".row-glyph {\n  display: flex;\n  width: var(--sidebar-glyph-width);\n  flex: 0 0 var(--sidebar-glyph-width);\n  align-items: center;\n  justify-content: center;\n  color: var(--row-glyph-ink);",
    );
    expect(shell).toContain(
      "  color: var(--row-glyph-ink);\n}\n\n/* The same size a row's own controls take",
    );
  });

  it("is what an unlit state falls back to, so no state is brighter at rest", () => {
    // A pull request with no colour of its own — a draft — must rest exactly
    // where a folder rests, not one step up.
    expect(shell).toContain("color: var(--state-ink, var(--row-glyph-ink));");
    expect(shell).not.toContain("var(--state-ink, var(--tertiary))");
  });
});

/**
 * A row's leading geometry, and the connector that says whose Agent a row is.
 *
 * The arrangement is one thing and it is stated once, in `tokens.css`:
 *
 *     [ icon ][ the Workspace's words … ]
 *       |      [ icon ][ the Agent's words … ]
 *       |  \
 *       |   the elbow, turning right into the Agent's mark
 *      the vertical, dropping from under the Workspace's folder
 *
 * An Agent is indented the way a file tree draws a child: its status mark
 * stands right of the guide, under its Workspace's name, and its words follow
 * one gap on, as a Workspace's follow its folder. In the rail the connector
 * and the words come off and every mark stands in the one column.
 *
 * jsdom resolves neither `calc` nor a custom property, so the numbers are
 * resolved from the tokens themselves and the expressions are checked to be
 * written in those terms — which is what keeps the two halves of this from
 * drifting: a stylesheet that stopped reading the token would fail the second
 * half, and a token whose value moved would fail the first.
 */
describe("a row's leading columns: the rail's, and the tree grown out of it", () => {
  const shell = readFileSync("src/shell/styles/shell.css", "utf8");
  const tokens = readFileSync("src/shell/styles/tokens.css", "utf8");
  const reorder = readFileSync("src/shell/styles/reorder.css", "utf8");

  /** One `--name: 12px;` out of the stylesheet, as a number. */
  function pixels(source: string, name: string): number {
    const match = new RegExp(`${name}: (\\d+)px;`, "u").exec(source);
    if (!match?.[1]) throw new Error(`${name} is not a plain px value`);
    return Number(match[1]);
  }
  /** One `--name: var(--space-N);` resolved through the spacing scale. */
  function spacing(source: string, name: string): number {
    const match = new RegExp(`${name}: var\\((--space-\\d)\\);`, "u").exec(
      source,
    );
    if (!match?.[1]) throw new Error(`${name} is not a spacing step`);
    return pixels(tokens, match[1]);
  }

  const gap = pixels(tokens, "--space-2");
  /** `--sidebar-tree-gap`. */
  const step = pixels(tokens, "--space-1");

  /**
   * Where a row's marks land from the pane's leading edge — in the rail and
   * expanded (the overlay and the docked column, which are one layout) — at
   * one density and one chrome, through the expressions the stylesheets are
   * written in. The rail's width is main's (`windowLayout.sidebarColumnWidth`):
   * the glyph column and 12px either side with a title bar, the traffic
   * lights' 76px without.
   */
  function geometry(
    density: "compact" | "comfortable",
    titleBar: "shown" | "hidden",
  ) {
    const block = tokens.slice(
      tokens.indexOf(`[data-sidebar-density="${density}"]`),
    );
    const glyph = pixels(block, "--sidebar-glyph-width");
    const rowHeight = pixels(block, "--row-height");
    const scrollInset = spacing(block, "--sidebar-scroll-inset");
    const rail = titleBar === "shown" ? glyph + 2 * 12 : 76;
    // `--sidebar-row-inset`: half the rail, less half a glyph, past the
    // scroll region's own inset.
    const rowInset = (rail - glyph) / 2 - scrollInset;
    const expanded = scrollInset + rowInset;
    // The rail: `--sidebar-rail-air`, then the entry's own padding.
    const air = (rail - rowHeight) / 2;
    const railed = air + (rowHeight - glyph) / 2;
    const words = expanded + glyph + gap;
    // `--sidebar-agent-glyph-inset: var(--sidebar-text-inset)`, and the
    // indent is that less the row's own inset.
    const agentIcon = words;
    const indent = agentIcon - expanded;
    const vertical = expanded + glyph / 2;
    return {
      expanded,
      railed,
      words,
      /** The rail takes the indent off: an Agent at its Workspace's x. */
      railAgent: railed,
      agentIcon,
      indent,
      vertical,
      elbowEnd: agentIcon - step,
      agentWords: agentIcon + glyph + gap,
    };
  }

  /**
   * Compact mode turned on or off moves no Workspace sideways: the expanded
   * column puts its icon column where the rail centres it.
   */
  it("puts every Workspace's mark at the rail's x, in either chrome", () => {
    for (const density of ["compact", "comfortable"] as const) {
      for (const titleBar of ["shown", "hidden"] as const) {
        const at = geometry(density, titleBar);
        expect(at.expanded).toBe(at.railed);
      }
    }
    expect(geometry("compact", "shown").expanded).toBe(12);
    expect(geometry("compact", "shown").words).toBe(36);
    expect(geometry("comfortable", "shown").expanded).toBe(12);
    expect(geometry("compact", "hidden").expanded).toBe(30);
  });

  /**
   * Expanded, an Agent is indented under its Workspace's name, right of the
   * guide; in the rail it stands at its Workspace's x, and the indent is the
   * one distance the tree grows in by.
   */
  it("indents an Agent under its Workspace's name, right of the guide", () => {
    for (const density of ["compact", "comfortable"] as const) {
      for (const titleBar of ["shown", "hidden"] as const) {
        const at = geometry(density, titleBar);
        expect(at.agentIcon).toBe(at.words);
        expect(at.vertical).toBeLessThan(at.elbowEnd);
        expect(at.agentIcon - at.elbowEnd).toBe(step);
        expect(at.agentWords - at.agentIcon).toBe(at.words - at.expanded);
        expect(at.railAgent + at.indent).toBe(at.agentIcon);
      }
    }
    expect(geometry("compact", "shown").agentIcon).toBe(36);
    expect(geometry("compact", "shown").vertical).toBe(20);
    expect(geometry("compact", "shown").agentWords).toBe(60);
    expect(geometry("comfortable", "shown").agentIcon).toBe(38);
  });

  it("is one arrangement, declared once", () => {
    expect(tokens).toContain(
      "--sidebar-row-inset: calc(\n    (var(--sidebar-rail-collapsed-width) - var(--sidebar-glyph-width)) / 2 -\n      var(--sidebar-scroll-inset)\n  );",
    );
    expect(tokens).toContain(
      "--sidebar-tree-line: calc(\n    var(--sidebar-row-inset) + var(--sidebar-glyph-width) / 2\n  );",
    );
    expect(tokens).toContain("--sidebar-tree-gap: var(--space-1);");
    expect(tokens).toContain(
      "--sidebar-agent-glyph-inset: var(--sidebar-text-inset);",
    );
    expect(tokens).toContain(
      "--sidebar-agent-indent: calc(\n    var(--sidebar-agent-glyph-inset) - var(--sidebar-row-inset)\n  );",
    );
    expect(tokens).toContain(
      "--sidebar-agent-text-inset: calc(\n    var(--sidebar-agent-glyph-inset) + var(--sidebar-glyph-width) +\n      var(--space-2)\n  );",
    );
    // On `.app-shell`, where the glyph column and the rail's width they are
    // written in terms of are also declared: a custom property resolves its
    // own `var()`s where it is *declared*, so the same expression at `:root`
    // inherits down as nothing.
    const at = tokens.indexOf("--sidebar-agent-glyph-inset");
    expect(tokens.lastIndexOf(".app-shell {", at)).toBeGreaterThan(
      tokens.lastIndexOf(":root {", at),
    );
    expect(tokens).not.toContain("--sidebar-rail-width");
    expect(shell).not.toContain(".row-rail");
    expect(shell).toContain("  padding-inline: var(--sidebar-row-inset) 0;");
    expect(shell).toContain("  margin-left: var(--sidebar-agent-indent);");
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .sidebar-row {\n  padding-inline: calc(\n    (var(--sidebar-rail-entry) - var(--sidebar-glyph-width)) / 2\n  );\n}',
    );
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .sidebar-scroll-region {\n  --sidebar-rail-air: calc(\n    (var(--sidebar-rail-collapsed-width) - var(--sidebar-rail-entry)) / 2\n  );',
    );
    expect(reorder).toContain("  left: var(--sidebar-text-inset);");
    expect(reorder).toContain("  left: var(--sidebar-agent-text-inset);");
  });

  /**
   * The bent guide: a vertical through the run, and an elbow into each row —
   * `├` for every Agent but the last, `└` for the last.
   */
  it("draws the guide expanded, and none in the rail", () => {
    expect(shell).toContain(
      '.agent-row::before {\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: var(--sidebar-tree-line);\n  width: 1px;\n  background: var(--line);\n  content: "";\n}',
    );
    expect(shell).toContain(
      ".agent-tree > li:last-child .agent-row::before {\n  bottom: auto;",
    );
    expect(shell).toContain(
      ".agent-row::after {\n  position: absolute;\n  top: calc(var(--row-height) / 2);\n  left: var(--sidebar-tree-line);",
    );
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .agent-row::before,\n.sidebar[data-collapsed="true"] .agent-row::after {\n  content: none;\n}',
    );
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .agent-row .row-glyph {\n  margin-left: 0;\n}',
    );
    expect(shell).not.toContain(".agent-row:hover::before");
  });

  /**
   * The tree grows in as the Sidebar grows out of the rail, and folds back as
   * it retracts — on the width's own tokens, by transform and opacity only, so
   * nothing is laid out twice and no row moves vertically.
   */
  it("grows the tree in on the width's motion tokens, by transform and opacity", () => {
    for (const [state, duration, easing] of [
      ["growing", "var(--motion-base)", "var(--ease-enter)"],
      ["shrinking", "var(--motion-exit)", "var(--ease-exit)"],
    ] as const) {
      for (const part of [".row-head", "::before", "::after"]) {
        const selector =
          part === ".row-head"
            ? `.sidebar[data-tree="${state}"] .agent-row .row-head {`
            : `.sidebar[data-tree="${state}"] .agent-row${part} {`;
        const at = shell.indexOf(selector);
        expect(at, selector).toBeGreaterThan(-1);
        const rule = shell.slice(at, shell.indexOf("}", at));
        expect(rule).toContain(duration);
        expect(rule).toContain(easing);
      }
    }
    for (const name of [
      "sidebar-tree-indent-in",
      "sidebar-tree-guide-in",
      "sidebar-tree-elbow-in",
    ]) {
      const at = shell.indexOf(`@keyframes ${name} {`);
      expect(at, name).toBeGreaterThan(-1);
      const end = shell.indexOf("\n}\n", at);
      const properties = [
        ...shell.slice(at, end).matchAll(/^\s+([a-z-]+):/gmu),
      ].map((match) => match[1]);
      expect(properties.length).toBeGreaterThan(0);
      for (const property of properties) {
        expect(["transform", "opacity"]).toContain(property);
      }
    }
    // The indent opens from the rail's x, by exactly the indent.
    expect(shell).toContain(
      "transform: translateX(calc(-1 * var(--sidebar-agent-indent)));",
    );
    // And Reduce Motion takes all of it away.
    expect(shell).toContain(
      "@media (prefers-reduced-motion: reduce) {\n  .sidebar[data-tree] .agent-row .row-head,",
    );
  });

  /**
   * And no mark moves down: the section heading is the rail's rule in the
   * docked column too, with the rail's air either side, so every row below it
   * is at one height in both. The words stay in the document for whoever
   * reads the list without seeing it.
   */
  it("is the rail's rule between Scratch and the workspaces, docked or not", () => {
    expect(shell).toContain(
      ".sidebar-section-heading {\n  position: relative;\n  height: 1px;\n  margin: var(--sidebar-section-gap) var(--space-2);\n}",
    );
    expect(shell).toContain(
      ".sidebar-section-heading h2 {\n  position: absolute;\n  overflow: hidden;\n  width: 1px;\n  height: 1px;",
    );
    expect(shell).not.toMatch(
      /\.sidebar\[data-collapsed="true"\] \.sidebar-section-heading \{/,
    );
    expect(shell).toContain(
      ".sidebar-section-actions {\n  position: absolute;",
    );
  });
});

/**
 * A hover is for what a control's look does not say. The section's + and its
 * Issue mark, a row's ×, and the status marks are what they look like, so none
 * of them reads its label back on hover; the pointer on a row's control is the
 * pointer on its row.
 */
describe("the hovers the Sidebar does not raise", () => {
  it("reads no section action and no status mark back", () => {
    mount(WORKING_ON, { kind: "idle" }, { status: "idle", unread: "idle" });
    for (const name of ["Assign issue", "Open workspace picker"]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute(
        "data-tooltip",
      );
    }
    const marks = document.querySelectorAll(".status-mark");
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark).not.toHaveAttribute("data-tooltip");
      expect(mark).not.toHaveAttribute("data-tooltip-lines");
    }
  });

  /**
   * Nothing small inside a row has a hover of its own — not the Issue or pull
   * request mark, the unavailable or dev-container mark, the spinner, +, × or
   * stop. The only element that raises a tooltip in a row is the row.
   */
  it("raises no tooltip from any element inside a row but the row", () => {
    const { container } = renderEverything();
    const rows = container.querySelectorAll(".sidebar-row");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        row.querySelectorAll("[data-tooltip], [data-tooltip-lines]"),
      ).toHaveLength(0);
    }
    // And every one of them is in the row's own tooltip instead.
    const facts = tipFacts();
    expect(facts).toContainEqual({
      icon: "issueOpen",
      text: "#128 Tidy the picker",
    });
    expect(facts).toContainEqual({
      icon: "pullRequestDraft",
      text: "#210 Tidy the picker, at last",
    });
    expect(facts).toContainEqual({
      icon: "container",
      text: "editor in dev container: Node",
    });
    expect(facts).toContainEqual({
      icon: "close",
      text: "Close worktree…: removes this worktree, asking first",
    });
  });

  it("puts Reading #N in the row's tooltip, and not on the spinner", () => {
    mount({
      sequence: 1,
      workspaces: [
        { workspaceId: "w-1", branch: "feature/7-x", pending: { number: 7 } },
      ],
    });
    const spinner = document.querySelector(".row-issue-spinner");
    expect(spinner).not.toBeNull();
    expect(spinner).not.toHaveAttribute("data-tooltip");
    expect(tipFacts()).toContainEqual({ text: "Reading #7" });
  });
});

/** A row with everything a row can carry: an Issue, a pull request, a dev
    container, a worktree it would remove, its terminals and an Agent whose
    stop failed. */
function renderEverything() {
  const value = {
    dispatch: vi.fn(),
    openExternalUrl: vi.fn(),
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    agentProfiles: { sequence: 1, availability: "degraded", profiles: [] },
    repositoryStatus: {
      sequence: 1,
      workspaces: [
        {
          ...WORKING_ON.workspaces[0],
          mainWorktree: "/projects/other",
          worktree: "/projects/widget",
          repositoryUrl: "https://github.com/example/widget",
        },
      ],
    },
    usageLimits: { clis: [] },
  } as unknown as SidebarValue;
  const snapshot = {
    ...SNAPSHOT,
    workspaces: SNAPSHOT.workspaces.map((workspace) =>
      workspace.id !== "w-1"
        ? workspace
        : {
            ...workspace,
            editor: { kind: "devContainer", label: "Node" },
            terminals: { status: "working" },
            agents: [
              {
                id: "a-1",
                profileId: "claude",
                displayName: "Claude 1",
                status: "idle",
                runtimeHealth: "healthy",
                controlState: {
                  kind: "stop-failed",
                  diagnostic: "close_agents_unknown",
                },
              },
            ],
          },
    ),
  } as unknown as AppSnapshot;
  return render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot} />
    </SidebarContext.Provider>,
  );
}
