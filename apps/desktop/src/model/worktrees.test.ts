import { describe, expect, it } from "vitest";
import {
  baseName,
  closingDeletesWorktree,
  sanitizeBranchName,
  worktreeDirectory,
} from "./worktrees.js";

describe("a worktree's directory", () => {
  it("is a sibling of the repository, named for both", () => {
    expect(worktreeDirectory("/projects/widget", "feature/128-tidy")).toBe(
      "/projects/widget_feature_128-tidy",
    );
  });

  it("is a sibling of the *main* worktree, wherever it was asked for", () => {
    // A worktree made from inside another worktree must not nest: the branch's
    // directory cannot depend on where the person was standing.
    expect(worktreeDirectory("/projects/widget", "fix/9-crash")).toBe(
      "/projects/widget_fix_9-crash",
    );
  });

  it("replaces every character a path would argue about", () => {
    expect(sanitizeBranchName('a/b:c\\d*e?f"g<h>i|j')).toBe(
      "a_b_c_d_e_f_g_h_i_j",
    );
  });

  it("ignores a trailing separator on the repository", () => {
    expect(worktreeDirectory("/projects/widget/", "main")).toBe(
      "/projects/widget_main",
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
