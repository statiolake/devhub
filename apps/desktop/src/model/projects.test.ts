/**
 * The name at the end of a repository URL.
 *
 * The sheet shows where a clone will land and main clones into exactly that
 * directory, both from this function — so what it answers is what the person
 * was promised, and the cases below are the ones a URL actually comes in as.
 */

import { describe, expect, it } from "vitest";
import { cloneDirectoryName, joinPath } from "./projects.js";

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

  it("joins without doubling the separator", () => {
    expect(joinPath("/a/b", "repo")).toBe("/a/b/repo");
    expect(joinPath("/a/b/", "repo")).toBe("/a/b/repo");
  });
});
