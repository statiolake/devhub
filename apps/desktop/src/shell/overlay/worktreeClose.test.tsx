// @vitest-environment jsdom

/**
 * The one question asked before a worktree is destroyed.
 *
 * There used to be two of these — a picker with three rows for the chords, and
 * an alert with two buttons for the sidebar's trash — so what happened to a
 * folder depended on which control was pressed. There is one now, reached from
 * whichever entry point closed the workspace, and what is checked here is the
 * part a person's fingers rely on: Cancel is first and is therefore what Return
 * takes, Escape means the same thing, and each of the three rows does the one
 * thing it says.
 *
 * The rule about *when* it is asked at all lives with the predicate that
 * decides it (`closingDeletesWorktree`) and with `closeWorkspaceOrWorktree` in
 * main; a clean worktree never reaches this sheet.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShellContext, type AppShellContextValue } from "../useAppShell";
import { WorktreeCloseSheet } from "./WorktreeCloseSheet";

// jsdom implements no layout, so it has no `scrollIntoView`. Keeping the
// selected row visible is the picker's job, not this file's subject.
Element.prototype.scrollIntoView = vi.fn();

const WORKSPACE_ID = "63752e9f-c93d-4d49-87f0-70f352eea8b0";

function mount(dirty: boolean | undefined) {
  const dispatch = vi.fn(async () => ({}) as never);
  const removeWorktree = vi.fn(async () => ({}) as never);
  const reportFailure = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AppShellContext.Provider
      value={
        {
          dispatch,
          removeWorktree,
          reportFailure,
        } as unknown as AppShellContextValue
      }
    >
      <WorktreeCloseSheet
        workspaceId={WORKSPACE_ID}
        label="widget_fix"
        root="/projects/widget_fix"
        branch="feature/128-tidy"
        dirty={dirty}
        onDismiss={onDismiss}
      />
    </AppShellContext.Provider>,
  );
  return { dispatch, removeWorktree, reportFailure, onDismiss };
}

/** The rows, in the order the arrows and Return walk them. */
function rows(): string[] {
  return screen
    .getAllByRole("option")
    .map((row) => row.querySelector(".mac-list-title")?.textContent ?? "");
}

afterEach(cleanup);

describe("closing a worktree with something in it to lose", () => {
  it("offers three answers, with the safe one first", () => {
    mount(true);
    expect(rows()).toEqual([
      "Cancel",
      "Just close the workspace",
      "Delete the worktree",
    ]);
    // First is what the picker starts on, and therefore what Return takes.
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("does nothing at all on Return, because Cancel is the default", () => {
    const { dispatch, removeWorktree, onDismiss } = mount(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("does nothing at all on Escape, which means what Cancel means", () => {
    const { dispatch, removeWorktree, onDismiss } = mount(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("closes the workspace and keeps the folder on the second row", () => {
    const { dispatch, removeWorktree, onDismiss } = mount(true);
    fireEvent.click(screen.getByText("Just close the workspace"));
    expect(dispatch).toHaveBeenCalledWith({
      type: "request_close_workspace",
      workspaceId: WORKSPACE_ID,
    });
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("removes the folder with --force on the third", () => {
    // Forced, because this question is only ever asked when git would refuse —
    // or when DevHub cannot promise it would not.
    const { dispatch, removeWorktree, onDismiss } = mount(true);
    fireEvent.click(screen.getByText("Delete the worktree"));
    expect(removeWorktree).toHaveBeenCalledWith(WORKSPACE_ID, true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  /**
   * Not knowing is not clean. "There are changes" and "DevHub could not tell"
   * lead to different decisions, so they are two sentences and not one.
   */
  it("says which of the two it is when it could not read the tree", () => {
    mount(undefined);
    expect(
      screen.getByText(/could not tell whether there is anything uncommitted/u),
    ).toBeInTheDocument();
    cleanup();
    mount(true);
    expect(
      screen.getByText(/is a worktree with uncommitted changes in it/u),
    ).toBeInTheDocument();
  });

  it("names the folder as well as the label, and promises the branch", () => {
    mount(true);
    // Two worktrees of one repository differ by one word in a sidebar and by
    // their whole path on disk, and the path is what can actually be checked.
    expect(
      screen.getByText("Keep /projects/widget_fix on disk."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Remove /projects/widget_fix and everything uncommitted on feature/128-tidy.",
      ),
    ).toBeInTheDocument();
  });
});
