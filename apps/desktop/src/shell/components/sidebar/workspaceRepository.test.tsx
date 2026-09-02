// @vitest-environment jsdom

/**
 * What a Workspace row says about the work in it.
 *
 * The branch and the Issue live on the *Workspace* row, because the Issue is
 * recorded against the workspace: one fact, one place. The marks are links
 * rather than decoration, and the reason a look failed is drawn beside what is
 * still known rather than instead of it.
 */

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

function mount(repositoryStatus: RepositoryStatusWire) {
  const openExternalUrl = vi.fn();
  const removeWorktree = vi.fn(() => Promise.resolve({}));
  const reportFailure = vi.fn();
  const value = {
    dispatch: vi.fn(),
    openExternalUrl,
    removeWorktree,
    reportFailure,
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus,
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <Sidebar snapshot={SNAPSHOT} onDispatch={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return { openExternalUrl, removeWorktree, reportFailure };
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

  it("draws a merged pull request as the one that landed", () => {
    // The only silhouette difference in the set of four, because it is the one
    // question a person scans this column for. The other three differ by
    // colour, which is the class.
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
            state: "merged",
          },
        },
      ],
    });
    const mark = screen.getByRole("button", {
      name: /Pull request #9, merged/u,
    });
    expect(mark).toHaveClass("is-pr-merged");
    expect(mark.querySelector("svg")?.dataset.glyph).toBe("pullRequestMerged");
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

  describe("removing a worktree", () => {
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
    const button = () =>
      screen.queryByRole("button", { name: /Remove the worktree/u });

    it("is offered for a clean worktree", () => {
      mount(worktree(false));
      expect(button()).toBeInTheDocument();
    });

    it("is offered while there is work in it to lose", () => {
      // It used to be withheld, which left a worktree with one stray file with
      // no way to be removed from DevHub at all — and nothing on screen saying
      // why the control had gone.
      mount(worktree(true));
      expect(button()).toBeInTheDocument();
    });

    it("is offered when DevHub cannot tell", () => {
      mount(worktree(undefined));
      expect(button()).toBeInTheDocument();
    });

    it("is not offered for the repository itself", () => {
      mount({
        sequence: 1,
        workspaces: [
          {
            workspaceId: "w-1",
            branch: "main",
            mainWorktree: "/projects/widget",
            worktree: "/projects/widget",
            dirty: false,
          },
        ],
      });
      expect(button()).toBeNull();
    });

    it("does not ask about a clean worktree, and does not force it", () => {
      // A folder git can rebuild in a second. Confirming that is a question
      // whose answer is always yes, and a question like that is what teaches
      // people to dismiss the ones that matter. Unforced, so that if the poll
      // was stale git refuses and nothing has happened.
      const { removeWorktree } = mount(worktree(false));
      fireEvent.click(button() as HTMLElement);
      expect(removeWorktree).toHaveBeenCalledWith("w-1", false);
      expect(openModal).not.toHaveBeenCalled();
    });

    it("reports git disagreeing about clean, rather than swallowing it", () => {
      // The removal that is not asked about has no sheet of its own to show a
      // failure in, so it goes to the one place the shell shows them. Without
      // this the poll being a minute stale is a button that silently does
      // nothing.
      // Rejected when the mock is *called*, not when it is set up: a promise
      // built here and rejected before anything attaches a handler is an
      // unhandled rejection, and it would be reported against whichever test
      // happened to be running when the microtask queue next drained.
      const refusal = new Error("fatal: '…' contains modified files");
      const { removeWorktree, reportFailure } = mount(worktree(false));
      removeWorktree.mockImplementation(() => Promise.reject(refusal));
      fireEvent.click(button() as HTMLElement);
      return Promise.resolve().then(() => {
        expect(reportFailure).toHaveBeenCalledWith(refusal);
      });
    });

    it("asks before destroying uncommitted work, and names the folder", () => {
      const { removeWorktree } = mount(worktree(true));
      fireEvent.click(button() as HTMLElement);
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(openModal).toHaveBeenCalledWith({
        kind: "worktree-removal",
        workspaceId: "w-1",
        label: "widget",
        root: "/projects/widget",
        branch: "feature/128-tidy",
      });
    });

    it("asks when it cannot tell, because not knowing is not clean", () => {
      const { removeWorktree } = mount(worktree(undefined));
      fireEvent.click(button() as HTMLElement);
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(openModal).toHaveBeenCalled();
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
