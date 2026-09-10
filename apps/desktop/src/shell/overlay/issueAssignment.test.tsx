// @vitest-environment jsdom

/**
 * Assigning an Issue, as the person walks it.
 *
 * The flow's value is in what it *asks* and what it finally sends, so that is
 * what these check: the whole way through with a worktree, the shorter way
 * without one, a URL that is not an Issue URL, and Escape coming back to a
 * question that has already been answered once.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppShellContextValue } from "../useAppShell";
import { AppShellContext } from "../useAppShell";
import { IssueAssignmentSheet } from "./IssueAssignmentSheet";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const ISSUE = "https://github.com/example/widget/issues/128";
const PULL_REQUEST = "https://github.com/example/widget/pull/128";

function mount(overrides: Partial<AppShellContextValue> = {}) {
  const assignIssue = vi.fn().mockResolvedValue(undefined);
  // One repository, checked out in one place: the shape most of these walk.
  const findIssueRepositories = vi.fn().mockResolvedValue([
    {
      mainWorktree: "/projects/widget",
      worktrees: [
        { path: "/projects/widget", branch: "main", isMainWorktree: true },
      ],
    },
  ]);
  const listBranches = vi.fn().mockResolvedValue(["main", "release"]);
  const cloneRepository = vi.fn().mockResolvedValue("/projects/widget");
  // Nothing has a branch yet: the shape most of these walk, where the flow
  // offers `feature/128-wip` and the root checkout.
  const assignmentBranch = vi.fn().mockResolvedValue({ reachable: false });
  const onDismiss = vi.fn();
  const value = {
    agentProfiles: {
      sequence: 1,
      availability: "available",
      profiles: [{ id: "claude", displayName: "Claude", kind: "claude" }],
    },
    findIssueRepositories,
    listBranches,
    cloneRepository,
    assignIssue,
    projectDefaultDirectory: vi.fn().mockResolvedValue("/projects"),
    cloneParentDirectories: vi
      .fn()
      .mockResolvedValue(["/projects", "/code/github"]),
    assignmentBranch,
    // The URL step's rows are the person's own actions.
    agentActions: vi.fn().mockResolvedValue([
      { id: "implement", displayName: "Work on it", trigger: "issue" },
      // A workspace button's action, in the same list. It is not an answer to
      // "what should the agent do with this Issue", so it must not be a row.
      { id: "commit_changes", displayName: "Commit", trigger: "commit" },
    ]),
    ...overrides,
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <IssueAssignmentSheet onDismiss={onDismiss} />
    </AppShellContext.Provider>,
  );
  return {
    assignIssue,
    findIssueRepositories,
    listBranches,
    cloneRepository,
    assignmentBranch,
    onDismiss,
  };
}

/** The same, for a test that has to change the context after mounting. */
function mountFor(agentProfiles: AppShellContextValue["agentProfiles"]) {
  const value = {
    agentProfiles,
    findIssueRepositories: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn().mockResolvedValue([]),
    cloneRepository: vi.fn().mockResolvedValue("/projects/widget"),
    assignIssue: vi.fn().mockResolvedValue(undefined),
    projectDefaultDirectory: vi.fn().mockResolvedValue("/projects"),
    cloneParentDirectories: vi.fn().mockResolvedValue([]),
    assignmentBranch: vi.fn().mockResolvedValue({ reachable: false }),
    agentActions: vi.fn().mockResolvedValue([
      { id: "implement", displayName: "Work on it", trigger: "issue" },
      // A workspace button's action, in the same list. It is not an answer to
      // "what should the agent do with this Issue", so it must not be a row.
      { id: "commit_changes", displayName: "Commit", trigger: "commit" },
    ]),
  } as unknown as AppShellContextValue;
  const view = render(
    <AppShellContext.Provider value={value}>
      <IssueAssignmentSheet onDismiss={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return {
    value,
    rerender: (next: AppShellContextValue) => {
      view.rerender(
        <AppShellContext.Provider value={next}>
          <IssueAssignmentSheet onDismiss={vi.fn()} />
        </AppShellContext.Provider>,
      );
    },
  };
}

/**
 * Take the row that names something, rather than the pinned action.
 *
 * With nothing typed the picker leads with its pinned rows — "Clone…" here —
 * because that is the menu of what one can do. Choosing a clone that exists is
 * choosing a row, so the test chooses it the way a person would.
 */
async function choose(dialogName: RegExp, rowName: string | RegExp) {
  await screen.findByRole("dialog", { name: dialogName });
  fireEvent.click(screen.getByRole("option", { name: rowName }));
}

async function answer(name: string | RegExp, text?: string) {
  const dialog = await screen.findByRole("dialog", { name });
  if (text !== undefined) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  }
  fireEvent.keyDown(dialog, { key: "Enter" });
}

describe("assigning an Issue", () => {
  it("asks three questions and sends what they add up to", async () => {
    // The Issue, the agent, and which branch. The repository is not asked
    // because there is exactly one clone, and the Issue has no branch of its
    // own: DevHub offers `feature/128-wip` and the agent is told to rename it.
    const { assignIssue } = mount();

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for example\/widget#128/u);
    await choose(
      /Where to work on example\/widget#128/u,
      /New branch feature\/128-wip/u,
    );

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith({
        issueUrl: ISSUE,
        directory: "/projects/widget",
        branch: "feature/128-wip",
        profileId: "claude",
        actionId: "implement",
        split: false,
        allowStaleBase: false,
      });
    });
  });

  it("asks which repository only when there are two of them", async () => {
    const { assignIssue } = mount({
      findIssueRepositories: vi.fn().mockResolvedValue([
        {
          mainWorktree: "/projects/widget",
          worktrees: [
            { path: "/projects/widget", branch: "main", isMainWorktree: true },
          ],
        },
        {
          mainWorktree: "/other/widget",
          worktrees: [
            { path: "/other/widget", branch: "main", isMainWorktree: true },
          ],
        },
      ]),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    await choose(/Which example\/widget/u, /\/other\/widget/u);
    await choose(/Where to work on/u, /root checkout/u);

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: "/other/widget",
          branch: undefined,
        }),
      );
    });
  });

  it("offers the branch the work already has, and opens it where it is", async () => {
    // A pull request whose branch is already checked out somewhere. git gives
    // one branch one worktree, so the honest offer is the folder the work is
    // already in — opening it, not making a second one git would refuse.
    const { assignIssue } = mount({
      assignmentBranch: vi.fn().mockResolvedValue({
        branch: "alice/fix-the-crash",
        reachable: true,
        checkedOutAt: "/projects/widget_alice_fix-the-crash",
      }),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await answer(/Agent for/u);
    await choose(/Where to work on/u, /Open widget_alice_fix-the-crash/u);

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: "/projects/widget_alice_fix-the-crash",
          branch: undefined,
        }),
      );
    });
  });

  it("says a fork's branch cannot be checked out here, and offers the rest", async () => {
    // The branch exists and is in somebody else's copy. DevHub will not add a
    // remote to somebody's repository on their behalf, so the row is not there
    // — and the reason is, rather than a checkout that fails a step later.
    mount({
      assignmentBranch: vi.fn().mockResolvedValue({
        branch: "patch-1",
        fork: "alice/widget",
        reachable: false,
      }),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await answer(/Agent for/u);
    await screen.findByRole("dialog", { name: /Where to work on/u });

    expect(
      screen.getByText(
        "patch-1 is in alice/widget, which this clone has no remote for, so it cannot be checked out here.",
      ),
    ).toBeVisible();
    expect(
      screen
        .getAllByRole("option")
        .map((row) => row.querySelector(".mac-list-title")?.textContent),
    ).toEqual(["New branch feature/128-wip", "Work in the root checkout"]);
  });

  it("makes no branch when the work stays in the workspace", async () => {
    // Which also means it is linked to no Issue unless the branch already
    // happens to name one — see the branch-only linking rule.
    const { assignIssue } = mount();

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    await choose(/Where to work on/u, /root checkout/u);

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith({
        issueUrl: ISSUE,
        directory: "/projects/widget",
        branch: undefined,
        profileId: "claude",
        actionId: "implement",
        split: false,
        allowStaleBase: false,
      });
    });
  });

  it("offers the profiles that arrived after the flow started", async () => {
    // The profiles are a projection: at the moment the sheet mounts there are
    // none, and they land a beat later. The flow is built once and walked over
    // several seconds, so a step that closed over the value asked "which
    // agent?" over an empty list and answered "profiles are unavailable" —
    // true at mount, false by the time anyone read it.
    const empty = {
      sequence: 1,
      availability: "unavailable",
      profiles: [],
    } as unknown as AppShellContextValue["agentProfiles"];
    const { rerender, value } = mountFor(empty);

    rerender({
      ...value,
      agentProfiles: {
        sequence: 2,
        availability: "available",
        profiles: [{ id: "claude", displayName: "Claude", kind: "claude" }],
      } as unknown as AppShellContextValue["agentProfiles"],
    });
    await answer("Assign Issue", ISSUE);

    expect(
      await screen.findByRole("option", { name: /Claude/u }),
    ).toBeInTheDocument();
  });

  it("asks again, keeping what was typed, when the URL is not an Issue", async () => {
    mount();

    await answer("Assign Issue", "https://example.com/nope");

    expect(
      await screen.findByText(
        "That is not a GitHub Issue or pull request URL.",
      ),
    ).toBeInTheDocument();
    // The typing survives, because retyping a URL is the one thing a person
    // who mistyped a URL should not have to do.
    expect(screen.getByRole("textbox")).toHaveValue("https://example.com/nope");
  });

  it("asks for the Issue once, and shows the shape of one", async () => {
    // The heading asks the question. The placeholder is the only thing on the
    // sheet that is not the question — an example, showing where the number
    // goes — and the caption that used to say "Paste an Issue URL" under a
    // heading already saying so is gone.
    mount();

    const field = await screen.findByRole("textbox");
    expect(field).toHaveAttribute(
      "placeholder",
      "https://github.com/owner/repo/issues/128 or /pull/128",
    );
    expect(screen.queryByText(/Paste an Issue URL/u)).toBeNull();
    expect(document.querySelector(".picker-empty")).toBeNull();
  });

  it("makes a pull request's worktree on the branch it is asking to merge", async () => {
    // An Issue has no branch yet, so DevHub makes one. A pull request *is* a
    // branch, and it is the one being reviewed — a new `feature/128-wip` beside
    // it would be an empty worktree under a name promising somebody's work.
    const assignmentBranch = vi
      .fn()
      .mockResolvedValue({ branch: "alice/fix-the-crash", reachable: true });
    const { assignIssue } = mount({
      assignmentBranch,
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await answer(/Agent for example\/widget#128/u);
    await choose(
      /Where to work on example\/widget#128/u,
      /Check out alice\/fix-the-crash/u,
    );

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueUrl: PULL_REQUEST,
          directory: "/projects/widget",
          branch: "alice/fix-the-crash",
        }),
      );
    });
    expect(assignmentBranch).toHaveBeenCalledWith(
      PULL_REQUEST,
      "/projects/widget",
    );
  });

  it("checks nothing out when the work stays in the repository itself", async () => {
    // The agent is handed the repository as it stands. Which branch to look at
    // is then the agent's business, and DevHub moving somebody's checkout out
    // from under them would be the wrong kind of helpful.
    const { assignIssue } = mount({
      assignmentBranch: vi
        .fn()
        .mockResolvedValue({ branch: "alice/fix-the-crash", reachable: true }),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await answer(/Agent for/u);
    await choose(/Where to work on/u, /root checkout/u);

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueUrl: PULL_REQUEST,
          directory: "/projects/widget",
          branch: undefined,
        }),
      );
    });
  });

  it("leads with the branch the work already has, then the two standing answers", async () => {
    // Read top to bottom that is the order the decision is considered in, and
    // the branch this work already has leads, because a person assigning a pull
    // request has decided what to work on and it is not a new branch — so it is
    // also what Return takes on a sheet nobody has typed into.
    mount({
      assignmentBranch: vi
        .fn()
        .mockResolvedValue({ branch: "alice/fix-the-crash", reachable: true }),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await answer(/Agent for/u);
    await screen.findByRole("dialog", { name: /Where to work on/u });

    expect(
      screen
        .getAllByRole("option")
        .map((row) => row.querySelector(".mac-list-title")?.textContent),
    ).toEqual([
      "Check out alice/fix-the-crash in a worktree",
      "New branch feature/128-wip",
      "Work in the root checkout",
    ]);
    // Every row is an answer rather than a name to search among, so they are
    // all pinned and typing narrows nothing away: there is no list here that a
    // query could leave empty.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "nothing-like-this" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("says why a clone is being asked about when nobody asked for one", async () => {
    // The sheet the complaint was about. A flow that started at "assign this
    // Issue" puts up a list of folders, and without this the person has to
    // work out from the rows alone that the repository was not found and that
    // they are being asked where a clone should go.
    mount({
      findIssueRepositories: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);

    expect(
      await screen.findByRole("dialog", { name: "Clone example/widget" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        /No clone of example\/widget was found on this machine, so it has to be cloned before the agent can start\. Choose the folder to clone it into\./u,
      ),
    ).toBeVisible();
    // And it is the third question, not the first: Escape has somewhere to go.
    expect(screen.getByText("Step 3")).toBeVisible();
  });

  it("takes Escape back to the question before, with its answers still true", async () => {
    const { assignIssue } = mount();

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    // Escape from the question *after* the repository step, which decided for
    // itself and asked nothing. It must reach the agent question rather than
    // the step that would only decide the same way again.
    fireEvent.keyDown(
      await screen.findByRole("dialog", { name: /Where to work on/u }),
      {
        key: "Escape",
      },
    );

    expect(
      await screen.findByRole("dialog", { name: /Agent for/u }),
    ).toBeVisible();
    expect(assignIssue).not.toHaveBeenCalled();
  });

  it("asks before starting a branch from a copy the fetch could not refresh", async () => {
    // The fetch failing is not the end of the flow and not a silent fallback:
    // the reason is shown, and starting from what is on disk is a decision the
    // person makes once, in words.
    const failure = Object.assign(new Error("fetch"), {
      code: "git_fetch_failed",
      summary:
        "The latest changes could not be fetched: Could not read origin.",
      module: "app",
      actions: [],
    });
    const assignIssue = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    mount({ assignIssue } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    await choose(
      /Where to work on example\/widget#128/u,
      /New branch feature\/128-wip/u,
    );

    expect(
      await screen.findByText(
        "The latest changes could not be fetched: Could not read origin.",
      ),
    ).toBeInTheDocument();
    await choose(/remote could not be reached/u, /Start from the copy/u);

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowStaleBase: true }),
      );
    });
  });

  it("clones when there is no clone to work in", async () => {
    const { cloneRepository, assignIssue } = mount({
      findIssueRepositories: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    // Nothing was found, so the repository question has no answers to put and
    // is skipped: cloning is where the flow goes. The folders offered are the
    // parents of everything the workspace sources find.
    await choose(/Clone example\/widget/u, /\/code\/github/u);
    // A fresh clone is checked out in one place, and that place plus a new
    // worktree is the same location question everybody else gets.
    await choose(/Where to work on/u, /root checkout/u);

    await vi.waitFor(() => {
      expect(cloneRepository).toHaveBeenCalledWith(
        "https://github.com/example/widget.git",
        "/code/github",
      );
    });
    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalled();
    });
  });

  it("clones into a folder no source knows about, when one is typed", async () => {
    // The escape hatch, and the whole of what is left of the field this
    // replaced: a path nobody offered, typed, and taken by the pinned row.
    const { cloneRepository } = mount({
      findIssueRepositories: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    await screen.findByRole("dialog", { name: /Clone example\/widget/u });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/elsewhere/scratch" },
    });
    fireEvent.click(screen.getByRole("option", { name: /typed above/u }));
    await choose(/Where to work on/u, /root checkout/u);

    await vi.waitFor(() => {
      expect(cloneRepository).toHaveBeenCalledWith(
        "https://github.com/example/widget.git",
        "/elsewhere/scratch",
      );
    });
  });
});
