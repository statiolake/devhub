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

function mount(overrides: Partial<AppShellContextValue> = {}) {
  const assignIssue = vi.fn().mockResolvedValue(undefined);
  const findIssueClones = vi
    .fn()
    .mockResolvedValue([
      { path: "/projects/widget", branch: "main", isMainWorktree: true },
    ]);
  const listBranches = vi.fn().mockResolvedValue(["main", "release"]);
  const cloneRepository = vi.fn().mockResolvedValue("/projects/widget");
  const onDismiss = vi.fn();
  const value = {
    agentProfiles: {
      sequence: 1,
      availability: "available",
      profiles: [{ id: "claude", displayName: "Claude", kind: "claude" }],
    },
    findIssueClones,
    listBranches,
    cloneRepository,
    assignIssue,
    projectDefaultDirectory: vi.fn().mockResolvedValue("/projects"),
    cloneParentDirectories: vi
      .fn()
      .mockResolvedValue(["/projects", "/code/github"]),
    ...overrides,
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <IssueAssignmentSheet onDismiss={onDismiss} />
    </AppShellContext.Provider>,
  );
  return {
    assignIssue,
    findIssueClones,
    listBranches,
    cloneRepository,
    onDismiss,
  };
}

/** The same, for a test that has to change the context after mounting. */
function mountFor(agentProfiles: AppShellContextValue["agentProfiles"]) {
  const value = {
    agentProfiles,
    findIssueClones: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn().mockResolvedValue([]),
    cloneRepository: vi.fn().mockResolvedValue("/projects/widget"),
    assignIssue: vi.fn().mockResolvedValue(undefined),
    projectDefaultDirectory: vi.fn().mockResolvedValue("/projects"),
    cloneParentDirectories: vi.fn().mockResolvedValue([]),
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
  it("asks its five questions and sends what they add up to", async () => {
    const { assignIssue, listBranches } = mount();

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for example\/widget#128/u);
    await choose(/Where to work on/u, /\/projects\/widget/u);
    await choose(/Work on example\/widget#128/u, /In a new worktree/u);
    await answer(/Branch for/u, "feature/128-tidy");

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith({
        issueUrl: ISSUE,
        directory: "/projects/widget",
        branch: "feature/128-tidy",
        profileId: "claude",
        split: false,
        allowStaleBase: false,
      });
    });
    expect(listBranches).toHaveBeenCalledWith("/projects/widget");
  });

  it("does not ask for a branch when the work stays in the workspace", async () => {
    const { assignIssue, listBranches } = mount();

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    await choose(/Where to work on/u, /\/projects\/widget/u);
    await choose(/Work on example\/widget#128/u, /In this workspace/u);

    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith({
        issueUrl: ISSUE,
        directory: "/projects/widget",
        branch: undefined,
        profileId: "claude",
        split: false,
        allowStaleBase: false,
      });
    });
    expect(listBranches).not.toHaveBeenCalled();
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
      await screen.findByText("That is not a GitHub Issue URL."),
    ).toBeInTheDocument();
    // The typing survives, because retyping a URL is the one thing a person
    // who mistyped a URL should not have to do.
    expect(screen.getByRole("textbox")).toHaveValue("https://example.com/nope");
  });

  it("takes Escape back to the question before, with its answers still true", async () => {
    const { assignIssue } = mount();

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
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
    await choose(/Where to work on/u, /\/projects\/widget/u);
    await choose(/Work on example\/widget#128/u, /In a new worktree/u);
    await answer(/Branch for/u, "feature/128-tidy");

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
      findIssueClones: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    // The only row is "Clone…", because nothing was found.
    await answer(/Where to work on/u);
    // The folders this person keeps projects in, offered as rows: the parents
    // of everything the workspace sources find.
    await choose(/Clone example\/widget/u, /\/code\/github/u);
    await choose(/Work on example\/widget#128/u, /In this workspace/u);

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
      findIssueClones: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    await answer(/Where to work on/u);
    await screen.findByRole("dialog", { name: /Clone example\/widget/u });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/elsewhere/scratch" },
    });
    fireEvent.click(screen.getByRole("option", { name: /typed above/u }));
    await choose(/Work on example\/widget#128/u, /In this workspace/u);

    await vi.waitFor(() => {
      expect(cloneRepository).toHaveBeenCalledWith(
        "https://github.com/example/widget.git",
        "/elsewhere/scratch",
      );
    });
  });
});
