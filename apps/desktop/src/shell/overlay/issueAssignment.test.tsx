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
      });
    });
    expect(listBranches).not.toHaveBeenCalled();
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

  it("clones when there is no clone to work in", async () => {
    const { cloneRepository, assignIssue } = mount({
      findIssueClones: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<AppShellContextValue>);

    await answer("Assign Issue", ISSUE);
    await answer(/Agent for/u);
    // The only row is "Clone…", because nothing was found.
    await answer(/Where to work on/u);
    await answer(/Clone example\/widget/u, "/projects");
    await choose(/Work on example\/widget#128/u, /In this workspace/u);

    await vi.waitFor(() => {
      expect(cloneRepository).toHaveBeenCalledWith(
        "https://github.com/example/widget.git",
        "/projects",
      );
    });
    await vi.waitFor(() => {
      expect(assignIssue).toHaveBeenCalled();
    });
  });
});
