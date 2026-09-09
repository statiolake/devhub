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
import type { AppSnapshot } from "../../../ipc/appShell";
import type { RepositoryStatusWire } from "../../client";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "./Sidebar";

// The Sidebar asks main to put modals on screen and listens for menu
// commands. Both are what the component genuinely does, so the bridge is
// present rather than mocked away — and `openModal` is watched, because
// *whether a question is asked at all* is now part of what a row decides.
const openModal = vi.fn(() => Promise.resolve(""));
window.devhub = {
  openModal,
  onMenuCommand: () => () => undefined,
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
  selection: { context: { kind: "global" }, presentation: "full" },
  sidebar: { width: 248 },
  splitRatio: 0.55,
  workspaces: [
    {
      id: "w-1",
      label: "widget",
      root: "/projects/widget",
      selectedPath: "/projects/widget",
      state: "available",
      canCreateAgent: true,
      agents: [],
    },
  ],
} as unknown as AppSnapshot;

function mount(
  repositoryStatus: RepositoryStatusWire,
  /** The workspace's own state, for the one test that is about a failed close. */
  workspaceState = "available",
) {
  const openExternalUrl = vi.fn();
  const removeWorktree = vi.fn(() => Promise.resolve({}));
  const closeWorkspace = vi.fn();
  const dispatch = vi.fn();
  const onDispatch = vi.fn();
  const reportFailure = vi.fn();
  const value = {
    dispatch,
    openExternalUrl,
    removeWorktree,
    closeWorkspace,
    reportFailure,
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus,
  } as unknown as AppShellContextValue;
  const snapshot = {
    ...SNAPSHOT,
    workspaces: SNAPSHOT.workspaces.map((workspace) => ({
      ...workspace,
      state: workspaceState,
    })),
  } as unknown as AppSnapshot;
  render(
    <AppShellContext.Provider value={value}>
      <Sidebar snapshot={snapshot} onDispatch={onDispatch} />
    </AppShellContext.Provider>,
  );
  return {
    openExternalUrl,
    removeWorktree,
    closeWorkspace,
    onDispatch,
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
  it("says which branch it is on and what that branch is for", () => {
    mount(WORKING_ON);
    expect(screen.getByText("feature/128-tidy")).toBeInTheDocument();
    expect(screen.getByText("Tidy the picker")).toBeInTheDocument();
  });

  it("gives the name, the branch and the work a line each", () => {
    // Three lines because they are three subjects. The branch is long and ends
    // in the part that identifies it, so it shares with nothing; what the work
    // is — the marks and the title — is one sentence and sits together on the
    // last line.
    mount(WORKING_ON);
    const row = document.querySelector(".workspace-row");
    expect(row?.querySelector(".row-label")?.textContent).toBe("widget");
    expect(row?.querySelector(".row-line-secondary")?.textContent).toBe(
      "feature/128-tidy",
    );
    expect(row?.querySelector(".row-line-links")?.textContent).toContain(
      "Tidy the picker",
    );
  });

  it("spends no line on the number the marks already link to", () => {
    // `#128` used to lead the title on the third line. It is the part a person
    // already knows — they are looking at the row because of it — and it was
    // four characters that never shrank, taken off the front of the only text
    // on the line that says what the work actually is.
    mount(WORKING_ON);
    const line = document.querySelector(".row-line-links");
    expect(line?.textContent).not.toContain("#128");
    // Still one click away, and still named for anyone who cannot see it.
    expect(
      screen.getByRole("button", {
        name: /Issue #128, open: Tidy the picker/u,
      }),
    ).toBeInTheDocument();
  });

  it("has no third line for a workspace that is only a repository", () => {
    // The line used to appear for the repository link alone, so every
    // workspace in a GitHub repository spent a third of its height on one icon
    // that said the same thing for all of them. That link is the row's first
    // mark now.
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
    expect(document.querySelector(".row-line-links")).toBeNull();
  });

  it("says what the pull request is called when there is no Issue", () => {
    // A branch that names no Issue can still have a pull request out from it,
    // and then the pull request's title is what the work is called. The old
    // lookup could not even ask about such a branch.
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
    expect(document.querySelector(".row-line-links")?.textContent).toContain(
      "Rework the picker",
    );
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
    const mark = screen.getByRole("button", {
      name: new RegExp(`Pull request #9, ${state}`, "u"),
    });
    expect(mark).toHaveClass(`is-pr-${state}`);
    expect(mark.querySelector("svg")?.dataset.glyph).toBe(glyph);
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
    const mark = screen.getByRole("button", {
      name: new RegExp(`Issue #128, ${state}`, "u"),
    });
    expect(mark).toHaveClass(`is-issue-${state}`);
    expect(mark.querySelector("svg")?.dataset.glyph).toBe(glyph);
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
        document.querySelector(".row-link-button svg")?.innerHTML ?? "",
      );
    }
    expect(drawn.size).toBe(4);
  });
});

/**
 * Which of the three marks a row starts with.
 *
 * A plain folder, a repository, and a worktree of one are three kinds of
 * Workspace, and the leading mark is how a person tells them apart down a
 * column without reading a word of any of them.
 */
describe("the mark a workspace row starts with", () => {
  function leadingGlyph(): string | undefined {
    return (
      document
        .querySelector(".workspace-row .row-glyph svg")
        ?.getAttribute("data-glyph") ?? undefined
    );
  }

  it("is a folder when the workspace is not a repository", () => {
    mount({ sequence: 1, workspaces: [{ workspaceId: "w-1" }] });
    expect(leadingGlyph()).toBe("folder");
  });

  it("is the repository when the checkout is the repository itself", () => {
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "main",
          mainWorktree: "/projects/widget",
          worktree: "/projects/widget",
        },
      ],
    });
    expect(leadingGlyph()).toBe("repository");
  });

  it("is a worktree when the checkout is not the repository itself", () => {
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
    expect(leadingGlyph()).toBe("worktree");
  });

  it("is the repository for a subdirectory of one, not a worktree", () => {
    // The row is /projects/widget and the checkout it is in starts at
    // /projects, which is also the repository. Comparing the *row's* path to
    // `mainWorktree` said "not the main worktree" — true, and not the question
    // — so every folder opened inside a repository drew a worktree's mark and
    // was offered a button that would have deleted the checkout around it.
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
    expect(leadingGlyph()).toBe("repository");
    expect(
      screen.queryByRole("button", { name: /Remove the worktree/u }),
    ).toBeNull();
  });

  it("is the way to the repository's page when there is one", () => {
    // The mark *is* the link. It used to be a fourth button on the third line,
    // which meant a row with no Issue spent a whole line on a single icon.
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
    const mark = screen.getByRole("button", {
      name: /Open example\/widget on GitHub/u,
    });
    expect(mark).toHaveClass("row-glyph");
    fireEvent.click(mark);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget",
    );
  });

  it("takes a worktree to the repository's page too", () => {
    // A worktree is not a separate thing on GitHub. It keeps its own mark, and
    // the mark leads to the page the repository has.
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
    const mark = screen.getByRole("button", {
      name: /Open example\/widget on GitHub/u,
    });
    expect(mark.querySelector("svg")?.dataset.glyph).toBe("worktree");
    fireEvent.click(mark);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget",
    );
  });
});

describe("a workspace row, continued", () => {
  it("has no second line when there is nothing to put on it", () => {
    mount({ sequence: 1, workspaces: [] });
    const row = document.querySelector(".workspace-row");
    expect(row?.querySelector(".row-label")?.textContent).toBe("widget");
    expect(row?.querySelector(".row-line-secondary")).toBeNull();
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
      expect(button).toHaveAttribute("title", "Close worktree…");
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
        expect(button).toHaveAttribute("title", "Close workspace");
        cleanup();
      }
    });

    it("still retries a failed close through the model, not through main", () => {
      // A close that failed is retried by asking for the same thing again, and
      // that retry is the model's own command: nothing about the folder has
      // changed, so there is nothing for the close rule to decide again.
      const { closeWorkspace, onDispatch } = mount(
        worktree(false),
        "closing-failed",
      );
      fireEvent.click(close() as HTMLElement);
      expect(closeWorkspace).not.toHaveBeenCalled();
      expect(onDispatch).toHaveBeenCalledWith({
        type: "retry_close_workspace",
        workspaceId: "w-1",
      });
    });
  });

  it("opens the Issue and the pull request on GitHub", () => {
    const { openExternalUrl } = mount(WORKING_ON);

    fireEvent.click(screen.getByRole("button", { name: /Issue #128, open/u }));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget/issues/128",
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Pull request #210, draft/u }),
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
    expect(screen.queryByRole("button", { name: /Issue #/u })).toBeNull();
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
    const row = document.querySelector(".workspace-row");
    expect(row?.querySelector(".row-issue-unavailable")).toHaveTextContent(
      "#128 · GitHub has no issue example/widget#128.",
    );
    // The branch is still said; it is the fact this row is named by.
    expect(screen.getByText("feature/128-tidy")).toBeInTheDocument();
    // And no Issue mark, because DevHub does not know the state to draw.
    expect(screen.queryByRole("button", { name: /Issue #/u })).toBeNull();
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
      .querySelector(".workspace-row")
      ?.querySelector(".row-issue-unavailable");
    expect(note).toHaveTextContent("detected dubious ownership");
    expect(note?.textContent).not.toMatch(/undefined|^#/u);
  });

  it("keeps what it knows when a look fails, and says why beside it", () => {
    // A network that dropped must not read as an issue that closed.
    mount({ ...WORKING_ON, diagnostic: "GitHub answered 502." });
    expect(screen.getByText("Tidy the picker")).toBeInTheDocument();
    expect(screen.getByText("GitHub answered 502.")).toBeInTheDocument();
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
