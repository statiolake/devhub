// @vitest-environment jsdom

/**
 * Assigning an Issue, as the person walks it.
 *
 * The flow's value is in what it *asks*, what it does between the questions,
 * and what it finally sends, so that is what these check: the folder made —
 * and not opened — before the agent is asked about, the agent question listing
 * that folder's sessions by its path, the folder opened only with the agent, a
 * URL that is not an Issue URL, a folder that could not be made, and Escape
 * coming back to a question that has already been answered.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueFolderRequest } from "../../ipc/contract";
import { worktreeDirectory } from "../../model/worktrees";
import type { PickerValue } from "./PickerContext";
import { PickerContext } from "./PickerContext";
import { IssueAssignmentSheet } from "./IssueAssignmentSheet";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const ISSUE = "https://github.com/example/widget/issues/128";
const PULL_REQUEST = "https://github.com/example/widget/pull/128";

/**
 * Main's half of the folder step, as far as the flow can tell: the worktree
 * for a branch lands where `worktreeDirectory` says, and the answer is that
 * folder on its machine. Nothing is opened, so there is no outcome to apply.
 */
function preparedFolder() {
  return vi.fn((request: IssueFolderRequest) =>
    Promise.resolve(
      request.branch === undefined
        ? request.place
        : {
            ...request.place,
            path: worktreeDirectory(request.place.path, request.branch),
          },
    ),
  );
}

function mount(overrides: Partial<PickerValue> = {}) {
  const assignIssue = vi.fn().mockResolvedValue(undefined);
  const prepareIssueFolder = preparedFolder();
  // The page's own way to open or select anything. The flow must not reach
  // for it: the folder is opened by `assignIssue`, with the agent.
  const dispatch = vi.fn().mockResolvedValue(undefined);
  // One repository, checked out in one place: the shape most of these walk.
  const findIssueRepositories = vi.fn().mockResolvedValue([
    {
      place: { kind: "local", path: "/projects/widget" },
      worktrees: [
        {
          place: { kind: "local", path: "/projects/widget" },
          branch: "main",
          isMainWorktree: true,
        },
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
      profiles: [
        {
          id: "claude",
          displayName: "Claude",
          kind: "claude",
          presentation: "tui",
          presentations: ["tui", "gui"],
        },
        {
          id: "cursor",
          displayName: "Cursor",
          kind: "cursor",
          presentation: "tui",
          presentations: ["tui"],
        },
      ],
    },
    dispatch,
    findIssueRepositories,
    listBranches,
    cloneRepository,
    prepareIssueFolder,
    assignIssue,
    projectDefaultDirectory: vi.fn().mockResolvedValue("/projects"),
    cloneParentDirectories: vi
      .fn()
      .mockResolvedValue(["/projects", "/code/github"]),
    assignmentBranch,
    // No earlier sessions unless a test says so.
    listAgentSessions: vi.fn().mockResolvedValue([]),
    previewAgentSession: vi.fn().mockResolvedValue([]),
    // The URL step's rows are the person's own actions.
    agentActions: vi.fn().mockResolvedValue([
      { id: "implement", displayName: "Work on it", trigger: "issue" },
      // A workspace button's action, in the same list. It is not an answer to
      // "what should the agent do with this Issue", so it must not be a row.
      { id: "commit_changes", displayName: "Commit", trigger: "commit" },
    ]),
    ...overrides,
  } as unknown as PickerValue;
  render(
    <PickerContext.Provider value={value}>
      <IssueAssignmentSheet onDismiss={onDismiss} />
    </PickerContext.Provider>,
  );
  return {
    assignIssue,
    dispatch,
    prepareIssueFolder: value.prepareIssueFolder as ReturnType<
      typeof preparedFolder
    >,
    findIssueRepositories,
    listBranches,
    cloneRepository,
    assignmentBranch,
    onDismiss,
  };
}

/** The same, for a test that has to change the context after mounting. */
function mountFor(agentProfiles: PickerValue["agentProfiles"]) {
  const value = {
    agentProfiles,
    findIssueRepositories: vi.fn().mockResolvedValue([
      {
        place: { kind: "local", path: "/projects/widget" },
        worktrees: [],
      },
    ]),
    listAgentSessions: vi.fn().mockResolvedValue([]),
    previewAgentSession: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn().mockResolvedValue([]),
    cloneRepository: vi.fn().mockResolvedValue("/projects/widget"),
    prepareIssueFolder: preparedFolder(),
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
  } as unknown as PickerValue;
  const view = render(
    <PickerContext.Provider value={value}>
      <IssueAssignmentSheet onDismiss={vi.fn()} />
    </PickerContext.Provider>,
  );
  return {
    value,
    rerender: (next: PickerValue) => {
      view.rerender(
        <PickerContext.Provider value={next}>
          <IssueAssignmentSheet onDismiss={vi.fn()} />
        </PickerContext.Provider>,
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
  // Found, not got: a sheet can be up before all of its rows are — the Agent
  // question fills in the folder's earlier sessions after it opens — and a
  // person clicks the row once it is there, not the moment the sheet is.
  fireEvent.click(await screen.findByRole("option", { name: rowName }));
}

async function answer(
  name: string | RegExp,
  text?: string,
  modifiers: { altKey?: boolean } = {},
) {
  const dialog = await screen.findByRole("dialog", { name });
  if (text !== undefined) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  }
  fireEvent.keyDown(dialog, { key: "Enter", ...modifiers });
}

/** The rows on screen, by their titles, in order. */
function rowTitles(): readonly (string | null | undefined)[] {
  return screen
    .getAllByRole("option")
    .map((row) => row.querySelector(".mac-list-title")?.textContent);
}

/** A refusal in the shape main's actually arrives in. */
function refusal(summary: string): Error {
  return new Error(
    `Error: ${JSON.stringify({
      code: "workspace_unavailable",
      summary,
      module: "app",
      timestampMs: 0,
      runtimeVersion: "0.1.0",
      actions: ["retry"],
    })}`,
  );
}

describe("assigning an Issue", () => {
  it("makes the folder, asks which agent, then opens it with the agent and the Issue", async () => {
    // The Issue, which folder, and the agent. The repository is not asked
    // because there is exactly one clone, and the Issue has no branch of its
    // own: DevHub offers `feature/128-wip` and the agent is told to rename it.
    const { prepareIssueFolder, assignIssue, dispatch } = mount();

    await answer("Assign Issue", ISSUE);
    await choose(
      /Where to work on example\/widget#128/u,
      /New worktree: feature\/128-wip/u,
    );
    await screen.findByRole("dialog", {
      name: /Agent for example\/widget#128/u,
    });

    // The folder is made before the agent is asked about — and only made:
    // nothing opens or selects a Workspace while the question is up, so no
    // editor starts behind it and the keyboard stays in it.
    expect(prepareIssueFolder).toHaveBeenCalledWith({
      issueUrl: ISSUE,
      place: { kind: "local", path: "/projects/widget" },
      branch: "feature/128-wip",
      allowStaleBase: false,
    });
    expect(assignIssue).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();

    await answer(/Agent for example\/widget#128/u);

    // Choosing the agent is what opens the folder: the worktree, by its path
    // on its machine, with the agent and the Issue's action to queue for it.
    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith({
        issueUrl: ISSUE,
        place: { kind: "local", path: "/projects/widget_feature_128-wip" },
        profileId: "claude",
        actionId: "implement",
        split: false,
        presentation: "tui",
      });
    });
    expect(prepareIssueFolder).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("asks the agent question in New Agent's words, with the Issue in the title", async () => {
    mount();

    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /Root checkout/u);

    const dialog = await screen.findByRole("dialog", {
      name: /Agent for example\/widget#128/u,
    });
    expect(dialog).toHaveTextContent(
      "Start a new session, or go on with one of this folder's earlier ones.",
    );
    expect(dialog).toHaveTextContent(
      "The agent starts in this folder. ⌘Return opens it beside the editor; ⌥Return opens it as the other of TUI and GUI.",
    );
  });

  it("offers TUI and GUI the way New Agent does, and carries the choice to the launch", async () => {
    const { assignIssue } = mount();

    await answer("Assign Issue", ISSUE);
    await choose(
      /Where to work on example\/widget#128/u,
      /New worktree: feature\/128-wip/u,
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Agent for example\/widget#128/u,
    });
    // Each row says what Return launches, and the other while ⌥ is held.
    expect(screen.getByRole("option", { name: /Claude/u })).toHaveTextContent(
      "TUI",
    );
    fireEvent.keyDown(dialog, { key: "Alt", altKey: true });
    expect(screen.getByRole("option", { name: /Claude/u })).toHaveTextContent(
      "GUI",
    );
    // A kind with no GUI does not flip.
    expect(screen.getByRole("option", { name: /Cursor/u })).toHaveTextContent(
      "TUI",
    );
    fireEvent.keyUp(dialog, { key: "Alt", altKey: false });
    await answer(/Agent for example\/widget#128/u, undefined, { altKey: true });

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "claude", presentation: "gui" }),
      );
    });
  });

  it("asks which repository only when there are two of them", async () => {
    const { prepareIssueFolder } = mount({
      findIssueRepositories: vi.fn().mockResolvedValue([
        {
          place: { kind: "local", path: "/projects/widget" },
          worktrees: [
            { path: "/projects/widget", branch: "main", isMainWorktree: true },
          ],
        },
        {
          place: { kind: "local", path: "/other/widget" },
          worktrees: [
            { path: "/other/widget", branch: "main", isMainWorktree: true },
          ],
        },
      ]),
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await choose(/Which example\/widget/u, /\/other\/widget/u);
    await choose(/Where to work on/u, /Root checkout/u);

    await vi.waitFor(() => {
      expect(prepareIssueFolder).toHaveBeenCalledWith({
        issueUrl: ISSUE,
        place: { kind: "local", path: "/other/widget" },
        allowStaleBase: false,
      });
    });
  });

  it("opens the worktree a branch is already checked out in, where it is", async () => {
    // A pull request whose branch is already checked out somewhere. git gives
    // one branch one worktree, so the honest offer is the folder the work is
    // already in — opening it, not making a second one git would refuse.
    const { prepareIssueFolder } = mount({
      assignmentBranch: vi.fn().mockResolvedValue({
        branch: "alice/fix-the-crash",
        reachable: true,
        checkedOutAt: "/projects/widget_alice_fix-the-crash",
      }),
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await choose(
      /Where to work on/u,
      /Existing worktree: alice\/fix-the-crash/u,
    );

    await vi.waitFor(() => {
      expect(prepareIssueFolder).toHaveBeenCalledWith({
        issueUrl: PULL_REQUEST,
        place: {
          kind: "local",
          path: "/projects/widget_alice_fix-the-crash",
        },
        allowStaleBase: false,
      });
    });
  });

  it("keeps the machine on every step once the clone is on one", async () => {
    // A repository on a host. Every git question after this is asked of that
    // host, and the worktree the flow makes is beside the repository — on the
    // host, because a worktree of a remote repository cannot be anywhere else.
    const place = {
      kind: "ssh",
      host: "build.example.com",
      path: "/srv/widget",
    };
    const assignmentBranch = vi.fn().mockResolvedValue({ reachable: false });
    const listAgentSessions = vi.fn().mockResolvedValue([]);
    const { prepareIssueFolder } = mount({
      findIssueRepositories: vi.fn().mockResolvedValue([
        {
          place,
          worktrees: [{ place, branch: "main", isMainWorktree: true }],
        },
      ]),
      assignmentBranch,
      listAgentSessions,
    } as unknown as Partial<PickerValue>);
    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /New worktree/u);
    await screen.findByRole("dialog", { name: /Agent for/u });

    expect(prepareIssueFolder).toHaveBeenCalledWith(
      expect.objectContaining({ place, branch: "feature/128-wip" }),
    );
    expect(assignmentBranch).toHaveBeenCalledWith(
      ISSUE,
      place,
      expect.any(AbortSignal),
    );
    // And the sessions are read on that host, in the worktree.
    expect(listAgentSessions).toHaveBeenCalledWith(
      { ...place, path: "/srv/widget_feature_128-wip" },
      "claude",
    );
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
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await screen.findByRole("dialog", { name: /Where to work on/u });

    expect(
      screen.getByText(
        "patch-1 is in alice/widget, which this clone has no remote for, so it cannot be checked out here.",
      ),
    ).toBeVisible();
    expect(rowTitles()).toEqual([
      "New worktree: feature/128-wip",
      "Root checkout",
    ]);
  });

  it("makes no branch when the work stays in the root checkout", async () => {
    // Which also means it is linked to no Issue unless the branch already
    // happens to name one — see the branch-only linking rule.
    const { prepareIssueFolder, assignIssue } = mount();

    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /Root checkout/u);
    await answer(/Agent for/u);

    expect(prepareIssueFolder).toHaveBeenCalledWith({
      issueUrl: ISSUE,
      place: { kind: "local", path: "/projects/widget" },
      allowStaleBase: false,
    });
    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          place: { kind: "local", path: "/projects/widget" },
        }),
      );
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
    } as unknown as PickerValue["agentProfiles"];
    const { rerender, value } = mountFor(empty);

    rerender({
      ...value,
      agentProfiles: {
        sequence: 2,
        availability: "available",
        profiles: [{ id: "claude", displayName: "Claude", kind: "claude" }],
      } as unknown as PickerValue["agentProfiles"],
    });
    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /Root checkout/u);

    expect(
      await screen.findByRole("option", { name: /New Claude Session/u }),
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
    const { prepareIssueFolder } = mount({
      assignmentBranch,
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await choose(
      /Where to work on example\/widget#128/u,
      /Check out alice\/fix-the-crash in a new worktree/u,
    );

    await vi.waitFor(() => {
      expect(prepareIssueFolder).toHaveBeenCalledWith({
        issueUrl: PULL_REQUEST,
        place: { kind: "local", path: "/projects/widget" },
        branch: "alice/fix-the-crash",
        allowStaleBase: false,
      });
    });
    expect(assignmentBranch).toHaveBeenCalledWith(
      PULL_REQUEST,
      { kind: "local", path: "/projects/widget" },
      expect.any(AbortSignal),
    );
  });

  it("says what each row does and where, in the folder names it will use", async () => {
    // "A worktree of its own, beside widget" left the person to guess whether
    // an existing folder was meant, and which. Each row now says whether it
    // creates or opens, and names the folder.
    mount({
      assignmentBranch: vi
        .fn()
        .mockResolvedValue({ branch: "alice/fix-the-crash", reachable: true }),
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await screen.findByRole("dialog", { name: /Where to work on/u });

    expect(
      screen.getByRole("option", {
        name: /Check out alice\/fix-the-crash in a new worktree/u,
      }),
    ).toHaveTextContent(
      "Creates ../widget_alice_fix-the-crash on the branch this work already has",
    );
    expect(
      screen.getByRole("option", { name: /New worktree: feature\/128-wip/u }),
    ).toHaveTextContent(
      "Creates ../widget_feature_128-wip on a new branch from origin's default branch",
    );
    expect(
      screen.getByRole("option", { name: /^Root checkout/u }),
    ).toHaveTextContent(
      "Opens /projects/widget on whatever branch it is on now; nothing is checked out or created",
    );
  });

  it("names an existing worktree by its folder, and offers no second row for the same branch", async () => {
    // The owner's case: an earlier `feature/128-wip` worktree, found by the
    // Issue's number. Opening it is the answer; "New worktree: feature/128-wip"
    // beside it would open the same folder while claiming to create one.
    mount({
      assignmentBranch: vi.fn().mockResolvedValue({
        branch: "feature/128-wip",
        reachable: true,
        checkedOutAt: "/projects/widget_feature_128-wip",
      }),
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await screen.findByRole("dialog", { name: /Where to work on/u });

    expect(rowTitles()).toEqual([
      "Existing worktree: feature/128-wip",
      "Root checkout",
    ]);
    expect(
      screen.getByRole("option", { name: /Existing worktree/u }),
    ).toHaveTextContent(
      "Opens ../widget_feature_128-wip, where feature/128-wip is already checked out",
    );
  });

  it("offers the root checkout once when the work's branch is checked out there", async () => {
    mount({
      assignmentBranch: vi.fn().mockResolvedValue({
        branch: "feature/128-tidy",
        reachable: true,
        checkedOutAt: "/projects/widget",
      }),
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await screen.findByRole("dialog", { name: /Where to work on/u });

    expect(rowTitles()).toEqual([
      "Root checkout: feature/128-tidy",
      "New worktree: feature/128-wip",
    ]);
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
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await screen.findByRole("dialog", { name: /Where to work on/u });

    expect(rowTitles()).toEqual([
      "Check out alice/fix-the-crash in a new worktree",
      "New worktree: feature/128-wip",
      "Root checkout",
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
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);

    expect(
      await screen.findByRole("dialog", { name: "Clone example/widget" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        /No clone of example\/widget was found on this machine, so it has to be cloned before the agent can start\. Choose the folder to clone it into\./u,
      ),
    ).toBeVisible();
    // And it is the second question, not the first: Escape has somewhere to go.
    expect(screen.getByText("Step 2")).toBeVisible();
  });

  it("takes Escape back to the question before, opening no Workspace", async () => {
    // Declining to start an agent opens nothing: the folder became a
    // Workspace only with an agent. The worktree made for it stays on disk —
    // nothing asks main to take it back — and nothing is started or selected.
    const { prepareIssueFolder, assignIssue, dispatch } = mount();

    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /New worktree/u);
    // Escape from the agent question goes back to where to work.
    fireEvent.keyDown(
      await screen.findByRole("dialog", { name: /Agent for/u }),
      { key: "Escape" },
    );
    // Escape from the question *after* the repository step, which decided for
    // itself and asked nothing. It must reach the Issue question rather than
    // the step that would only decide the same way again.
    fireEvent.keyDown(
      await screen.findByRole("dialog", { name: /Where to work on/u }),
      {
        key: "Escape",
      },
    );

    expect(
      await screen.findByRole("dialog", { name: "Assign Issue" }),
    ).toBeVisible();
    expect(prepareIssueFolder).toHaveBeenCalledTimes(1);
    expect(assignIssue).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shows a folder that could not be made on the branch question, and asks no agent", async () => {
    const prepareIssueFolder = vi
      .fn()
      .mockRejectedValueOnce(
        refusal(
          "/projects/widget_feature_128-wip already exists and is not a worktree for feature/128-wip.",
        ),
      );
    const { assignIssue } = mount({
      prepareIssueFolder,
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /New worktree/u);

    // The branch question again, redrawn with the reason under it.
    expect(
      await screen.findByText(
        "/projects/widget_feature_128-wip already exists and is not a worktree for feature/128-wip.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: /Where to work on/u }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /Agent for/u })).toBeNull();
    expect(prepareIssueFolder).toHaveBeenCalledTimes(1);
    expect(assignIssue).not.toHaveBeenCalled();
  });

  it("shows an agent that could not start on the agent question", async () => {
    const assignIssue = vi
      .fn()
      .mockRejectedValueOnce(refusal("Claude is not on this machine's PATH."));
    mount({ assignIssue } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /Root checkout/u);
    await answer(/Agent for/u);

    // The agent question again, redrawn with the reason under it.
    expect(
      await screen.findByText("Claude is not on this machine's PATH."),
    ).toBeVisible();
    expect(screen.getByRole("dialog", { name: /Agent for/u })).toBeVisible();
  });

  it("asks before starting a branch from a copy the fetch could not refresh", async () => {
    // The fetch failing is not the end of the flow and not a silent fallback:
    // the reason is shown, and starting from what is on disk is a decision the
    // person makes once, in words — before the agent is asked about, because
    // the folder is what the fetch was for.
    const failure = Object.assign(new Error("fetch"), {
      code: "git_fetch_failed",
      summary:
        "The latest changes could not be fetched: Could not read origin.",
      module: "app",
      actions: [],
    });
    const fallback = preparedFolder();
    const prepareIssueFolder = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(fallback);
    mount({ prepareIssueFolder } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await choose(
      /Where to work on example\/widget#128/u,
      /New worktree: feature\/128-wip/u,
    );

    expect(
      await screen.findByText(
        "The latest changes could not be fetched: Could not read origin.",
      ),
    ).toBeInTheDocument();
    await choose(/remote could not be reached/u, /Start from the copy/u);

    await screen.findByRole("dialog", { name: /Agent for/u });
    expect(prepareIssueFolder).toHaveBeenLastCalledWith(
      expect.objectContaining({
        branch: "feature/128-wip",
        allowStaleBase: true,
      }),
    );
  });

  it("clones when there is no clone to work in", async () => {
    const { cloneRepository, prepareIssueFolder } = mount({
      findIssueRepositories: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    // Nothing was found, so the repository question has no answers to put and
    // is skipped: cloning is where the flow goes. The folders offered are the
    // parents of everything the workspace sources find.
    await choose(/Clone example\/widget/u, /\/code\/github/u);
    // A fresh clone is checked out in one place, and that place plus a new
    // worktree is the same location question everybody else gets.
    await choose(/Where to work on/u, /Root checkout/u);

    await vi.waitFor(() => {
      expect(cloneRepository).toHaveBeenCalledWith(
        "https://github.com/example/widget.git",
        "/code/github",
      );
    });
    await vi.waitFor(() => {
      expect(prepareIssueFolder).toHaveBeenCalled();
    });
  });

  it("clones into a folder no source knows about, when one is typed", async () => {
    // The escape hatch, and the whole of what is left of the field this
    // replaced: a path nobody offered, typed, and taken by the pinned row.
    const { cloneRepository } = mount({
      findIssueRepositories: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await screen.findByRole("dialog", { name: /Clone example\/widget/u });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/elsewhere/scratch" },
    });
    fireEvent.click(screen.getByRole("option", { name: /typed above/u }));
    await choose(/Where to work on/u, /Root checkout/u);

    await vi.waitFor(() => {
      expect(cloneRepository).toHaveBeenCalledWith(
        "https://github.com/example/widget.git",
        "/elsewhere/scratch",
      );
    });
  });

  it("turns a lookup that failed into a question, not another lookup", async () => {
    // The runner re-runs a step that failed, and this step begins with the
    // lookup — so a failure handed straight back starts a second lookup, and a
    // third. The person watches a spinner that reports nothing however long
    // they wait, which is the original complaint arrived at from the other
    // side. The refusal has to become something answerable.
    const findIssueRepositories = vi
      .fn()
      .mockRejectedValue(
        refusal("example/widget could not be found within 20s."),
      );
    mount({ findIssueRepositories } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);

    const sheet = await screen.findByRole("dialog", {
      name: /Looking for example\/widget/u,
    });
    // The words main refused with, drawn where the person is looking.
    expect(sheet).toHaveTextContent(/could not be found within 20s/u);
    // And rows to act on, rather than a spinner that keeps its own counsel.
    expect(screen.getByRole("option", { name: /Look again/u })).toBeVisible();
    expect(screen.getByRole("option", { name: /Clone/u })).toBeVisible();

    // One lookup, not a stream of them.
    expect(findIssueRepositories).toHaveBeenCalledTimes(1);
  });

  it("asks for the folder anyway when the walk that lists them did not finish", async () => {
    // The folder step's first act is slow too, so it had the same two bugs: no
    // refusal in the sheet, and re-running the step would restart the walk. A
    // walk that did not finish loses the rows and not the question — the folder
    // can still be typed, and the pinned row has always taken it.
    const cloneParentDirectories = vi
      .fn()
      .mockRejectedValue(
        refusal(
          "the folders a clone could go into could not be found within 20s.",
        ),
      );
    const { cloneRepository } = mount({
      findIssueRepositories: vi.fn().mockResolvedValue([]),
      cloneParentDirectories,
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);

    const sheet = await screen.findByRole("dialog", {
      name: /Clone example\/widget/u,
    });
    expect(sheet).toHaveTextContent(/could not be found within 20s/u);
    // One walk, not a stream of them.
    expect(cloneParentDirectories).toHaveBeenCalledTimes(1);

    // And the question still works: a typed folder is taken by the pinned row.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/elsewhere/scratch" },
    });
    fireEvent.click(screen.getByRole("option", { name: /typed above/u }));
    await choose(/Where to work on/u, /Root checkout/u);
    await vi.waitFor(() => {
      expect(cloneRepository).toHaveBeenCalledWith(
        "https://github.com/example/widget.git",
        "/elsewhere/scratch",
      );
    });
  });

  it("aborts the lookup's signal when the person escapes the spinner", async () => {
    // The end of "spins forever, and then nothing can be cancelled". Escape on
    // the working panel has to reach the lookup itself, not only the spinner
    // drawn over it, or the `gh` main started outlives the question by up to a
    // whole deadline.
    let signal: AbortSignal | undefined;
    const findIssueRepositories = vi.fn((_url: string, given?: AbortSignal) => {
      signal = given;
      // Never settles: the state being tested is the one where the lookup
      // does not come back on its own.
      return new Promise<never>(() => {});
    });
    mount({ findIssueRepositories } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);

    const working = await screen.findByRole("dialog", {
      name: /Looking for example\/widget/u,
    });
    expect(signal?.aborted).toBe(false);

    fireEvent.keyDown(working, { key: "Escape" });

    // The signal is what PickerContext turns into `cancelPickerLookup`, so
    // this is the renderer's whole half of killing the child.
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true);
    });

    // And it goes back to the question before it rather than re-running the
    // step, which would start the very lookup the person just escaped.
    expect(
      await screen.findByRole("dialog", { name: "Assign Issue" }),
    ).toBeVisible();
    expect(findIssueRepositories).toHaveBeenCalledTimes(1);
  });
});

describe("going on with an earlier session", () => {
  it("offers the sessions of the folder the work is in, and resumes the one taken before the Issue is said", async () => {
    // Review comments on a pull request whose branch is already checked out:
    // the session that wrote it is there, and is what the person goes on with.
    const checkout = {
      kind: "local",
      path: "/projects/widget_alice_fix-the-crash",
    };
    const listAgentSessions = vi.fn((_place: unknown, profileId: string) =>
      Promise.resolve(
        profileId === "claude"
          ? [
              {
                id: "session-1",
                title: "Fix the crash",
                cwd: checkout.path,
                branch: "alice/fix-the-crash",
                resumableHere: true,
              },
            ]
          : [],
      ),
    );
    const { assignIssue } = mount({
      assignmentBranch: vi.fn().mockResolvedValue({
        branch: "alice/fix-the-crash",
        reachable: true,
        checkedOutAt: checkout.path,
      }),
      listAgentSessions,
    } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", PULL_REQUEST);
    await choose(/Where to work on/u, /Existing worktree/u);
    await choose(/Agent for/u, /^Claude Session: Fix the crash/u);

    // Listed where the Agent will run — the folder, by its path, before it is
    // opened as anything — not the repository's root.
    expect(listAgentSessions).toHaveBeenCalledWith(checkout, "claude");
    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith({
        issueUrl: PULL_REQUEST,
        place: checkout,
        profileId: "claude",
        // The Issue's action is still said, into the resumed session.
        actionId: "implement",
        split: false,
        presentation: "tui",
        resume: "session-1",
      });
    });
  });

  it("offers the root checkout's sessions", async () => {
    const listAgentSessions = vi.fn((_place: unknown, profileId: string) =>
      Promise.resolve(
        profileId === "claude"
          ? [
              {
                id: "session-2",
                title: "Tidy the parser",
                cwd: "/projects/widget",
                resumableHere: true,
              },
            ]
          : [],
      ),
    );
    mount({ listAgentSessions } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /Root checkout/u);

    expect(
      await screen.findByRole("option", {
        name: /Claude Session: Tidy the parser/u,
      }),
    ).toBeInTheDocument();
    expect(listAgentSessions).toHaveBeenCalledWith(
      { kind: "local", path: "/projects/widget" },
      "claude",
    );
  });

  it("offers only New rows in a worktree just made, which has had no session", async () => {
    // Nothing special-cased: the new folder is listed like any other, and a
    // folder nobody has worked in lists nothing.
    const listAgentSessions = vi.fn().mockResolvedValue([]);
    mount({ listAgentSessions } as unknown as Partial<PickerValue>);

    await answer("Assign Issue", ISSUE);
    await choose(/Where to work on/u, /New worktree: feature\/128-wip/u);
    await screen.findByRole("dialog", { name: /Agent for/u });

    await vi.waitFor(() => {
      expect(listAgentSessions).toHaveBeenCalledWith(
        { kind: "local", path: "/projects/widget_feature_128-wip" },
        "claude",
      );
    });
    await vi.waitFor(() => {
      expect(rowTitles()).toEqual(["New Claude Session", "New Cursor Session"]);
    });
  });
});
