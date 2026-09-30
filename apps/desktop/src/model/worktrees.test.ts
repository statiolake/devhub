import { describe, expect, it } from "vitest";
import {
  baseName,
  closingDeletesWorktree,
  worktreeDirectory,
  worktreeNumber,
} from "./worktrees.js";

const ISSUE_128 = { kind: "issue", number: 128 } as const;

describe("a worktree's directory", () => {
  it("is a sibling of the repository, named for the Issue", () => {
    expect(
      worktreeDirectory("/projects/widget", ISSUE_128, "feature/128-wip"),
    ).toBe("/projects/widget_128");
  });

  it("is the Issue's whatever the branch is called", () => {
    // A branch renamed once the work has a name is still the same work, and
    // checking it out again must not propose a second folder for it.
    expect(
      worktreeDirectory(
        "/projects/widget",
        ISSUE_128,
        "feature/128-short-name",
      ),
    ).toBe("/projects/widget_128");
    expect(worktreeDirectory("/projects/widget", ISSUE_128, "tidy-up")).toBe(
      "/projects/widget_128",
    );
  });

  it("is the Issue's for a pull request whose branch names the Issue", () => {
    // Pull request #130 is the work on Issue #128: reviewing it goes back to
    // the folder the Issue was worked in.
    const pull = { kind: "pull", number: 130 } as const;
    expect(worktreeNumber(pull, "feature/128-short-name")).toBe(128);
    expect(
      worktreeDirectory("/projects/widget", pull, "feature/128-short-name"),
    ).toBe("/projects/widget_128");
  });

  it("is the pull request's own for a branch that names no Issue", () => {
    const pull = { kind: "pull", number: 130 } as const;
    expect(worktreeNumber(pull, "alice/fix-the-crash")).toBe(130);
    expect(
      worktreeDirectory("/projects/widget", pull, "alice/fix-the-crash"),
    ).toBe("/projects/widget_130");
  });

  it("does not read an Issue's number from its branch", () => {
    // An Issue is its own number; a linked branch GitHub made for it may
    // carry another, or none.
    expect(worktreeNumber(ISSUE_128, "feature/9-crash")).toBe(128);
  });

  it("ignores a trailing separator on the repository", () => {
    expect(worktreeDirectory("/projects/widget/", ISSUE_128, "main")).toBe(
      "/projects/widget_128",
    );
  });

  it("names the repository by its last segment", () => {
    expect(baseName("/projects/widget")).toBe("widget");
    expect(baseName("/projects/widget/")).toBe("widget");
  });
});

/**
 * The one question behind "close": does closing this delete a folder?
 *
 * Both halves of DevHub read it — main to decide what to do, the sidebar to
 * decide what its button says it will do — so the two cannot disagree about
 * what a click is about to destroy.
 */
describe("whether closing a workspace deletes its worktree", () => {
  it("does not, for a folder git knows nothing about", () => {
    expect(closingDeletesWorktree(undefined, "/projects/widget")).toBe(false);
    expect(closingDeletesWorktree({}, "/projects/widget")).toBe(false);
  });

  it("does not, for the repository itself", () => {
    // Removing the main worktree is not a close, it is losing the repository.
    expect(
      closingDeletesWorktree(
        { mainWorktree: "/projects/widget", worktree: "/projects/widget" },
        "/projects/widget",
      ),
    ).toBe(false);
  });

  it("does, for a checkout that is not the repository and is the row itself", () => {
    expect(
      closingDeletesWorktree(
        { mainWorktree: "/projects/other", worktree: "/projects/widget" },
        "/projects/widget",
      ),
    ).toBe(true);
  });

  it("does not, for a folder merely inside a worktree", () => {
    // `git worktree remove` takes the checkout's root, so removing from a row
    // three directories down would delete the whole checkout around it.
    expect(
      closingDeletesWorktree(
        { mainWorktree: "/projects/other", worktree: "/projects/widget" },
        "/projects/widget/packages/app",
      ),
    ).toBe(false);
  });
});
