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
import type { AppSnapshot, WorkspaceCloseWire } from "../../../ipc/appShell";
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
      },
    },
  ],
};

describe("a workspace row", () => {
  it("says its name and the branch it is on, and nothing else in words", () => {
    // One line, and the words on it are the two facts that tell this row from
    // the next. Everything else the row knows is a mark at its trailing edge
    // and a line in its tooltip.
    mount(WORKING_ON);
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    expect(row?.querySelector(".row-text")?.textContent).toBe(
      "widgetfeature/128-tidy",
    );
    expect(row?.querySelector(".row-label")?.textContent).toBe("widget");
    expect(row?.querySelector(".row-branch")?.textContent).toBe(
      "feature/128-tidy",
    );
  });

  it("spends no words on the Issue's number or its title", () => {
    // Both used to be on a line of their own. A Sidebar column is about twenty
    // characters wide and those twenty belong to the name and the branch: the
    // number is the part a person already knows, and the title is what the
    // Issue's own mark says the moment it is hovered.
    mount(WORKING_ON);
    const row = document.querySelector(".workspace-row:not(.is-scratch)");
    expect(row?.querySelector(".row-text")?.textContent).not.toContain("#128");
    expect(row?.querySelector(".row-text")?.textContent).not.toContain(
      "Tidy the picker",
    );
    // Still one click away, still named for anyone who cannot see it, and the
    // whole of it under the pointer.
    const mark = document.querySelector(".row-link-button.is-issue-open");
    expect(mark).toHaveAttribute(
      "aria-label",
      "Issue #128, open: Tidy the picker",
    );
    expect(
      JSON.parse(mark?.getAttribute("data-tooltip-lines") ?? "[]"),
    ).toEqual([{ icon: "issueOpen", text: "#128 Tidy the picker" }]);
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

  it("says what the pull request is called in the mark's own hover", () => {
    // A branch that names no Issue can still have a pull request out from it,
    // and then the pull request is what the work is called. It is the mark's
    // sentence rather than the row's words, like every other mark here.
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
          },
        },
      ],
    });
    expect(
      JSON.parse(
        document
          .querySelector(".row-link-button.is-pr-open")
          ?.getAttribute("data-tooltip-lines") ?? "[]",
      ),
    ).toEqual([{ icon: "pullRequest", text: "#7 Rework the picker" }]);
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
    const mark = document.querySelector(`.row-link-button.is-issue-${state}`);
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
            pullRequest: { number: 9, url: "p", title: "t", state },
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

  it("is the link, when there is a repository behind it", () => {
    // One mark, one question. The folder *is* the checkout, so the folder is
    // what leads to the page it is a checkout of; the `repository` mark that
    // used to sit in the trailing group was that same question asked twice, in
    // a second silhouette a person had to learn in order to press it.
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
    expect(glyph?.tagName).toBe("BUTTON");
    expect(glyph).toHaveClass("row-glyph-button");
    // The row's own sentence, and then what pressing it does — not a second,
    // shorter account of which Workspace this is.
    expect(glyph?.getAttribute("aria-label")).toBe(
      [
        "widget workspace",
        "path /projects/widget",
        "repository github.com/example/widget",
        "branch main",
      ].join("\n") + ", open on GitHub",
    );
    fireEvent.click(glyph!);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget",
    );
  });

  it("is inert, and not a control at all, when there is no repository", () => {
    // Not a disabled button: a control that can never be pressed is one that
    // has to explain itself, and there is nothing here to explain. The row is
    // still selected by clicking it, because the select button's hit area runs
    // under the whole row.
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
    // What this is a checkout of is the folder glyph. Nothing in the mark group
    // says it a second time.
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

  it("takes a worktree to the repository's page, under the same one mark", () => {
    // A worktree is not a separate thing on GitHub, so the folder that is a
    // worktree leads to the same page as the folder that is not. Which of the
    // two this is, is a line in the tooltip.
    const { openExternalUrl } = mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          mainWorktree: "/projects/other",
          worktree: "/projects/widget",
          repositoryUrl: "https://github.com/example/widget",
        },
      ],
    });
    const glyph = document.querySelector(
      ".workspace-row:not(.is-scratch) .row-glyph-button",
    );
    expect(glyph?.querySelector("svg")?.dataset.glyph).toBe("folder");
    fireEvent.click(glyph!);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget",
    );
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
      expect(button).toHaveAttribute("data-tooltip", "Close worktree…");
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
        expect(button).toHaveAttribute("data-tooltip", "Close workspace");
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
  });

  it("opens the Issue and the pull request on GitHub", () => {
    const { openExternalUrl } = mount(WORKING_ON);

    fireEvent.click(
      document.querySelector(".row-link-button.is-issue-open") as HTMLElement,
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
    expect(
      document.querySelector(".row-link-button[class*='is-issue']"),
    ).toBeNull();
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
    expect(mark).toHaveAttribute(
      "data-tooltip",
      "#128 · GitHub has no issue example/widget#128.",
    );
    // The branch is still said; it is the fact this row is named by.
    expect(screen.getByText("feature/128-tidy")).toBeInTheDocument();
    // And no Issue mark, because DevHub does not know the state to draw.
    expect(
      document.querySelector(".row-link-button[class*='is-issue']"),
    ).toBeNull();
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
      document.querySelector(".row-link-button.is-issue-open"),
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
 *     [ icon ][ connector ][ the Agent's words … ]
 *        |      |
 *        |     vertical, then the elbow turning right
 *       one column, at one x, on every row
 *
 * Every row leads with the same column and the same x — the folder on a
 * Workspace, the status mark on an Agent, the terminal on Scratch — so the
 * statuses are a column to run an eye down and the rail is these rows with the
 * connector and the words taken off. What is left to say which Workspace an
 * Agent belongs to is the connector, and that is the whole of what it is for.
 *
 * jsdom resolves neither `calc` nor a custom property, so the numbers are
 * resolved from the tokens themselves and the expressions are checked to be
 * written in those terms — which is what keeps the two halves of this from
 * drifting: a stylesheet that stopped reading the token would fail the second
 * half, and a token whose value moved would fail the first.
 */
describe("a row's leading columns, and the connector between them", () => {
  const shell = readFileSync("src/shell/styles/shell.css", "utf8");
  const tokens = readFileSync("src/shell/styles/tokens.css", "utf8");
  const reorder = readFileSync("src/shell/styles/reorder.css", "utf8");

  /** One `--name: 12px;` out of the stylesheet, as a number. */
  function pixels(source: string, name: string): number {
    const match = new RegExp(`${name}: (\\d+)px;`, "u").exec(source);
    if (!match?.[1]) throw new Error(`${name} is not a plain px value`);
    return Number(match[1]);
  }

  const gap = pixels(tokens, "--space-2");
  /** `--sidebar-tree-gap`, and the step the vertical stands past the icon. */
  const step = pixels(tokens, "--space-1");

  /**
   * Where everything on a row lands, at one density — from the density's own
   * numbers, through the arrangement the stylesheets are written in.
   */
  function geometry(density: "compact" | "comfortable") {
    const block = tokens.slice(
      tokens.indexOf(`[data-sidebar-density="${density}"]`),
    );
    const glyph = pixels(block, "--sidebar-glyph-width");
    const ink = pixels(block, "--sidebar-glyph-ink");
    // `--sidebar-tree-width: var(--sidebar-glyph-width)` — the connector's
    // column is as wide as the icon column beside it.
    const tree = glyph;
    // `--sidebar-row-inset: var(--sidebar-glyph-width)` — the list's indent
    // from the pane's leading edge, which is where the folder glyph stood
    // when a gutter led the row.
    const inset = glyph;
    return {
      /** The indent every row leads with, before anything is drawn. */
      inset: { from: 0, to: inset },
      /** The one icon column, on every row, and the mark centred in it. */
      icon: { from: inset, to: inset + glyph, centre: inset + glyph / 2 },
      mark: {
        from: inset + (glyph - ink) / 2,
        to: inset + (glyph + ink) / 2,
      },
      /** The Workspace's own words: after the icon column, one gap. */
      workspaceText: inset + glyph + gap,
      /** `--sidebar-tree-line`: where the vertical stands. */
      vertical: inset + glyph + step,
      /** Where the elbow's horizontal run stops, one gap short of the words. */
      elbowEnd: inset + glyph + tree - step,
      /** `--sidebar-agent-text-inset`: after the connector column. */
      agentText: inset + glyph + tree,
    };
  }

  it("puts every row's mark in one column, at one x", () => {
    // The fact the whole arrangement rests on. There is one leading column and
    // not two — the gutter that used to hold an Agent's status beside a
    // Workspace's folder is gone — so an Agent's status and its Workspace's
    // folder are at the same x, and the collapse to the rail moves neither.
    //
    // That x is one glyph column in, not the pane's own edge: it is where the
    // folder glyph stood while the gutter led the row, and a source list
    // indents its contents from the edge it is against.
    expect(geometry("compact").inset.to).toBe(16);
    expect(geometry("comfortable").inset.to).toBe(18);
    for (const density of ["compact", "comfortable"] as const) {
      const at = geometry(density);
      expect(at.icon.from).toBe(at.inset.to);
    }
    expect(geometry("compact").icon.to).toBe(32);
    expect(geometry("comfortable").icon.to).toBe(36);
  });

  it("stands the vertical clear of the mark in that column", () => {
    // The one collision at this end of the row, and the reason the vertical is
    // not down the icon column's centre the way a file tree draws it: that
    // centre now has an Agent's status mark in it, which is the one thing this
    // pane exists to show. So the line starts where the ink stops.
    for (const density of ["compact", "comfortable"] as const) {
      const at = geometry(density);
      expect(at.vertical).toBeGreaterThan(at.mark.to);
      expect(at.vertical).toBeGreaterThan(at.icon.centre);
    }
    expect(geometry("compact").vertical).toBe(36);
    expect(geometry("comfortable").vertical).toBe(40);
  });

  it("turns the elbow into the words, stopping a gap short of them", () => {
    for (const density of ["compact", "comfortable"] as const) {
      const at = geometry(density);
      expect(at.elbowEnd).toBeGreaterThan(at.vertical);
      expect(at.agentText - at.elbowEnd).toBe(step);
    }
    expect(geometry("compact").elbowEnd).toBe(44);
    expect(geometry("comfortable").elbowEnd).toBe(50);
  });

  it("starts an Agent's words one connector column in from its Workspace's", () => {
    for (const density of ["compact", "comfortable"] as const) {
      const at = geometry(density);
      expect(at.agentText).toBeGreaterThan(at.workspaceText);
    }
    expect(geometry("compact").workspaceText).toBe(40);
    expect(geometry("compact").agentText).toBe(48);
    expect(geometry("comfortable").workspaceText).toBe(44);
    expect(geometry("comfortable").agentText).toBe(54);
  });

  it("is one arrangement, declared once", () => {
    expect(tokens).toContain(
      "--sidebar-tree-width: var(--sidebar-glyph-width);",
    );
    expect(tokens).toContain(
      "--sidebar-row-inset: var(--sidebar-glyph-width);",
    );
    // Written past the inset, so moving the list's indent moves the connector
    // with it and neither has to be moved twice.
    expect(tokens).toContain(
      "--sidebar-tree-line: calc(\n    var(--sidebar-row-inset) + var(--sidebar-glyph-width) + var(--space-1)\n  );",
    );
    expect(tokens).toContain("--sidebar-tree-gap: var(--space-1);");
    // On `.app-shell`, where the glyph column they are written in terms of is
    // also declared — and measured in a real browser to be sure of it. A custom
    // property resolves its own `var()`s where it is *declared*, so the same
    // expression at `:root`, above every density, is invalid and inherits down
    // as nothing at all: the connector silently stood at zero and an Agent's
    // words started against the icon. There is no way to catch that here, in an
    // engine that resolves neither — only to keep the declarations where the
    // terms are.
    const at = tokens.indexOf("--sidebar-tree-width");
    expect(tokens.lastIndexOf(".app-shell {", at)).toBeGreaterThan(
      tokens.lastIndexOf(":root {", at),
    );
    // The gutter that used to lead every row is gone, along with the term that
    // sized it and the depth that was written against it.
    expect(tokens).not.toContain("--sidebar-rail-width");
    expect(tokens).not.toContain("--sidebar-agent-indent");
    expect(shell).not.toContain(".row-rail");
    expect(shell).not.toContain("--row-agent-inset");
  });

  /**
   * The bent guide: a vertical through the run, and an elbow into each row —
   * `├` for every Agent but the last, `└` for the last, which is the one thing
   * that says where a Workspace's Agents stop.
   */
  it("draws the vertical, the elbow, and a stem that closes on the last row", () => {
    expect(shell).toContain(
      '.agent-row::before {\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: var(--sidebar-tree-line);\n  width: 1px;\n  background: var(--line);\n  content: "";\n}',
    );
    // The elbow meets the mark it points at off one term — every row centres
    // its first line at `--row-height / 2`, whatever else it has to say — so
    // the stem that closes and the run that turns cannot disagree about where
    // the row's middle is.
    expect(shell).toContain(
      ".agent-tree > li:last-child .agent-row::before {\n  bottom: auto;",
    );
    expect(shell).toContain("  height: calc(var(--row-height) / 2);");
    expect(shell).toContain(
      ".agent-row::after {\n  position: absolute;\n  top: calc(var(--row-height) / 2);\n  left: var(--sidebar-tree-line);",
    );
  });

  it("is the Sidebar's hairline, and never lights up", () => {
    // `--line`, the same ink as the rule under the section heading, because
    // that is what it is. The hierarchy is not a thing you can point at.
    expect(shell).not.toContain(".agent-row:hover::before");
    expect(shell).not.toContain(".agent-row.is-selected::before");
  });

  it("moves the row, its connector and its drop line together", () => {
    // The row's own inset, the connector beside it, and the drop line the
    // reorder draws all start from the same terms, so none of them can drift.
    expect(shell).toContain(
      ".agent-row .sidebar-context-button {\n  /* The button starts where the icon column ends, so what it clears is the\n     connector column and nothing else — `--sidebar-agent-text-inset` is the\n     same distance counted from the row's leading edge instead. */\n  padding-left: var(--sidebar-tree-width);\n}",
    );
    // The row's own indent, and the rail trading it for the rail's own: the
    // glyph column centred in an entry as wide as the row is tall.
    expect(shell).toContain("  padding-inline: var(--sidebar-row-inset) 0;");
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .sidebar-row {\n  padding-inline: calc(\n    (var(--sidebar-rail-entry) - var(--sidebar-glyph-width)) / 2\n  );\n}',
    );
    expect(reorder).toContain("  left: var(--sidebar-text-inset);");
    expect(reorder).toContain("  left: var(--sidebar-agent-text-inset);");
  });

  /**
   * The collapse is a subtraction and nothing else: the connector and the words
   * come off, and the icon column does not move within its row. The rail is
   * then centred by the pane rather than by each row, which is what stopped the
   * marks stepping from side to side down the column.
   */
  it("takes the connector and the words off, and moves nothing", () => {
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .agent-row::before,\n.sidebar[data-collapsed="true"] .agent-row::after {\n  content: none;\n}',
    );
    expect(shell).toContain(
      '.sidebar[data-collapsed="true"] .sidebar-scroll-region {\n  --sidebar-rail-air: calc(\n    (var(--sidebar-rail-collapsed-width) - var(--sidebar-rail-entry)) / 2\n  );\n\n  padding-inline: var(--sidebar-rail-air)\n    calc(var(--sidebar-rail-air) - var(--sidebar-edge));\n}',
    );
    // An entry is a square: as wide as a row is tall at either density, which
    // is the only number the rail adds, and it is written as that relation.
    // The rail's own width is `windowLayout.test.ts`'s to pin, and does not
    // move — the square is paid for out of the air around it.
    expect(tokens).toContain("  --sidebar-rail-entry: var(--row-height);");
    // The Sidebar's trailing hairline is inside the rail's width, so the air
    // after the entry is short by it; both read one term.
    expect(tokens).toContain("  --sidebar-edge: 1px;");
    expect(shell).toContain(
      "  border-right: var(--sidebar-edge) solid var(--line-strong);",
    );
    // Nothing re-centres a row, which is what used to move the icon.
    expect(shell).not.toContain(
      '.sidebar[data-collapsed="true"] .row-head {\n  justify-content: center;\n}',
    );
  });
});
