import { describe, expect, it } from "vitest";
import {
  baseName,
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
