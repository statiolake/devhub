import { describe, expect, it } from "vitest";
import {
  bodyClosesIssue,
  wipBranchForIssue,
  issueNumberFromBranch,
  issueUrl,
  parseIssueUrl,
} from "./github.js";

describe("an Issue URL", () => {
  it("is read as owner, repository and number", () => {
    expect(
      parseIssueUrl("https://github.com/example/widget/issues/128"),
    ).toEqual({ owner: "example", repository: "widget", number: 128 });
  });

  it("survives what a browser adds to it", () => {
    expect(
      parseIssueUrl(
        "  https://github.com/example/widget/issues/128#issuecomment-9  ",
      ),
    ).toEqual({ owner: "example", repository: "widget", number: 128 });
  });

  it("is not a pull request URL", () => {
    // They share a numbering, and a person who pasted a PR meant to work on
    // something that already has a branch. Starting a second one silently is
    // the failure this refusal exists to prevent.
    expect(
      parseIssueUrl("https://github.com/example/widget/pull/128"),
    ).toBeUndefined();
  });

  it("is not some other host wearing the same path", () => {
    expect(
      parseIssueUrl("https://github.example.com/example/widget/issues/128"),
    ).toBeUndefined();
  });

  it("round-trips through the reference DevHub keeps", () => {
    const url = "https://github.com/example/widget/issues/128";
    const parsed = parseIssueUrl(url);
    expect(parsed && issueUrl(parsed)).toBe(url);
  });
});

describe("the branch naming convention", () => {
  it("starts an Issue on a branch that says the work is not named yet", () => {
    // And that DevHub's own branch is recognised by DevHub's own convention,
    // so the workspace is linked to the Issue from the first second.
    expect(wipBranchForIssue(128)).toBe("feature/128-wip");
    expect(issueNumberFromBranch(wipBranchForIssue(128))).toBe(128);
  });

  it("recognises an Issue in a branch made outside DevHub", () => {
    expect(issueNumberFromBranch("feature/128-tidy-the-picker")).toBe(128);
    expect(issueNumberFromBranch("fix/9-crash")).toBe(9);
  });

  it("reads a prefix that is several segments deep", () => {
    expect(issueNumberFromBranch("alice/fix/128-crash")).toBe(128);
    expect(issueNumberFromBranch("team/alice/feature/9-thing")).toBe(9);
  });

  it("reads a prefix that is several segments deep with the number written as an Issue", () => {
    // Reported as not linking, and it does: every part of this name is read
    // here. What was wrong was somewhere else — see the note on
    // `RepositoryStatusWatcher`.
    expect(issueNumberFromBranch("step/feature/#1234-issue-body")).toBe(1234);
  });

  it("reads the number whether or not it is written as an Issue", () => {
    expect(issueNumberFromBranch("feature/#128-tidy-the-picker")).toBe(128);
    expect(issueNumberFromBranch("alice/fix/#9-crash")).toBe(9);
  });

  it("reads a name that starts at the slash", () => {
    expect(issueNumberFromBranch("/128-tidy")).toBe(128);
    expect(issueNumberFromBranch("/#128-tidy")).toBe(128);
  });

  it("does not read a number that is not the convention", () => {
    expect(issueNumberFromBranch("feature/tidy-128")).toBeUndefined();
    expect(issueNumberFromBranch("128-tidy")).toBeUndefined();
    expect(issueNumberFromBranch("feature/128")).toBeUndefined();
    expect(issueNumberFromBranch("v2-rewrite")).toBeUndefined();
    expect(issueNumberFromBranch("feature/#128")).toBeUndefined();
  });
});

describe("a pull request body", () => {
  it("closes an Issue by any of GitHub's keywords", () => {
    for (const keyword of [
      "Closes",
      "closed",
      "close",
      "Fixes",
      "fixed",
      "fix",
      "Resolves",
      "resolved",
      "resolve",
    ]) {
      expect(bodyClosesIssue(`${keyword} #128`, 128)).toBe(true);
    }
  });

  it("reads the colon form too", () => {
    expect(bodyClosesIssue("Closes: #128", 128)).toBe(true);
  });

  it("does not read a bare mention as a closing reference", () => {
    expect(bodyClosesIssue("Related to #128", 128)).toBe(false);
    expect(bodyClosesIssue("See #128 for context", 128)).toBe(false);
  });

  it("does not confuse one number for another that starts the same", () => {
    expect(bodyClosesIssue("Closes #1280", 128)).toBe(false);
  });
});
