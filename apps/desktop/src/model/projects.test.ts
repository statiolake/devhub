/**
 * The name at the end of a repository URL.
 *
 * The sheet shows where a clone will land and main clones into exactly that
 * directory, both from this function — so what it answers is what the person
 * was promised, and the cases below are the ones a URL actually comes in as.
 */

import { describe, expect, it } from "vitest";
import {
  cloneDirectoryName,
  cloneTarget,
  folderName,
  joinPath,
  type GitHubLogin,
} from "./projects.js";

describe("the name a clone lands under", () => {
  it("is the last component, without .git", () => {
    expect(cloneDirectoryName("https://github.com/owner/repo.git")).toBe(
      "repo",
    );
    expect(cloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
  });

  it("reads an scp-style remote, which has no scheme and a colon", () => {
    expect(cloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
  });

  it("ignores trailing slashes and a query", () => {
    expect(cloneDirectoryName("https://example.com/owner/repo/")).toBe("repo");
    expect(cloneDirectoryName("https://example.com/o/repo.git?ref=x")).toBe(
      "repo",
    );
  });

  it("answers with nothing when there is no name to take", () => {
    expect(cloneDirectoryName("")).toBeUndefined();
    expect(cloneDirectoryName("   ")).toBeUndefined();
    expect(cloneDirectoryName("https://example.com/../")).toBeUndefined();
  });

  it("is the last segment of a path, whatever follows it", () => {
    expect(folderName("/projects/widget_128-wip")).toBe("widget_128-wip");
    expect(folderName("/projects/widget/")).toBe("widget");
    expect(folderName("widget")).toBe("widget");
    // Nothing to name: the whole string beats a blank row.
    expect(folderName("/")).toBe("/");
  });

  it("joins without doubling the separator", () => {
    expect(joinPath("/a/b", "repo")).toBe("/a/b/repo");
    expect(joinPath("/a/b/", "repo")).toBe("/a/b/repo");
  });

  it("leaves a name that is already a path alone", () => {
    // Somebody who typed a whole path has said where they want it, and
    // `/a/b//tmp/thing` names nowhere.
    expect(joinPath("/a/b", "/tmp/thing")).toBe("/tmp/thing");
    expect(joinPath("/a/b", "~/thing")).toBe("~/thing");
  });
});

/**
 * Reading what somebody typed, the way `gh repo clone` reads it.
 *
 * Three forms, and the person is told which one was understood before anything
 * is cloned — so the interesting cases are the ones where the answer is *not*
 * a clone: a bare name with nobody signed in, and a string that is neither a
 * name nor a URL.
 */
describe("what a typed repository means", () => {
  const SIGNED_IN: GitHubLogin = { kind: "known", login: "octocat" };

  it("takes a bare name as this person's own repository", () => {
    expect(cloneTarget("devhub", SIGNED_IN)).toEqual({
      kind: "clone",
      url: "https://github.com/octocat/devhub.git",
      name: "devhub",
    });
  });

  it("takes one slash as owner and repository on GitHub", () => {
    expect(cloneTarget("example/widget", SIGNED_IN)).toEqual({
      kind: "clone",
      url: "https://github.com/example/widget.git",
      name: "widget",
    });
    // git's own suffix is not part of the name either way it is written.
    expect(cloneTarget("example/widget.git", SIGNED_IN)).toEqual({
      kind: "clone",
      url: "https://github.com/example/widget.git",
      name: "widget",
    });
  });

  it("clones a URL exactly as it was given", () => {
    // Not rewritten, not normalised: a person who pasted an ssh remote, a
    // host that is not GitHub, or a URL their git config rewrites has said
    // what they want and DevHub is not the one to second-guess it.
    for (const [url, name] of [
      ["https://gitlab.example/group/thing.git", "thing"],
      ["ssh://git@example.com:2222/owner/thing", "thing"],
      ["git@github.com:example/widget.git", "widget"],
    ] as const) {
      expect(cloneTarget(url, SIGNED_IN)).toEqual({ kind: "clone", url, name });
    }
  });

  it("says who it would have to be, rather than cloning nobody's repository", () => {
    const target = cloneTarget("devhub", {
      kind: "unknown",
      reason: "there is no `gh` on DevHub's PATH",
    });
    expect(target.kind).toBe("unreadable");
    expect(target.kind === "unreadable" && target.reason).toContain(
      "there is no `gh` on DevHub's PATH",
    );
    // And it says what to type instead, which works with no `gh` at all.
    expect(target.kind === "unreadable" && target.reason).toContain(
      "owner/devhub",
    );
  });

  it("waits rather than guessing while the login is still being read", () => {
    expect(cloneTarget("devhub", { kind: "pending" }).kind).toBe("unreadable");
  });

  it("refuses what is neither a name nor a URL", () => {
    expect(cloneTarget("", SIGNED_IN).kind).toBe("unreadable");
    expect(cloneTarget("   ", SIGNED_IN).kind).toBe("unreadable");
    expect(cloneTarget("a/b/c", SIGNED_IN).kind).toBe("unreadable");
    expect(cloneTarget("../escape", SIGNED_IN).kind).toBe("unreadable");
  });
});
