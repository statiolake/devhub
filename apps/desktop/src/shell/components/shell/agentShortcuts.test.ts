/**
 * When a workspace offers to say the next thing.
 *
 * Three shortcuts, three conditions, and the conditions are the whole feature:
 * a button that appears when it cannot help is worse than no button, because it
 * teaches the person that the row's buttons do not mean anything.
 */

import { describe, expect, it } from "vitest";
import type { WorkspaceRepositoryWire } from "../../../ipc/contract";
import { offeredShortcuts } from "./AgentShortcuts";

/** A branch on a repository, with nothing going on, unless a test says so. */
function workspace(
  over: Partial<WorkspaceRepositoryWire> = {},
): WorkspaceRepositoryWire {
  return {
    workspaceId: "w-1",
    branch: "feature/128-tidy",
    defaultBranch: "main",
    dirty: false,
    ahead: 0,
    ...over,
  };
}

describe("the shortcuts a workspace offers", () => {
  it("offers nothing before anything has been read", () => {
    // The projection arrives after the window does. Until it lands there is no
    // condition to hold, and a button drawn on a guess would flicker away.
    expect(offeredShortcuts(undefined)).toEqual([]);
  });

  it("offers a commit when there is something uncommitted", () => {
    expect(offeredShortcuts(workspace({ dirty: true }))).toContain("commit");
  });

  it("offers no commit when DevHub cannot tell whether there is", () => {
    // Not knowing is not dirty. The same rule the worktree removal follows.
    expect(offeredShortcuts(workspace({ dirty: undefined }))).not.toContain(
      "commit",
    );
  });

  it("offers a push when the upstream is behind", () => {
    expect(offeredShortcuts(workspace({ ahead: 2 }))).toContain("push");
  });

  it("offers no push when there is nowhere to push to", () => {
    // `ahead` is absent for a branch nobody has pushed and for a repository
    // with no remotes. "Nothing to push" and "nowhere to push it" are
    // different, and only the first is a button that would help.
    expect(offeredShortcuts(workspace({ ahead: undefined }))).not.toContain(
      "push",
    );
  });

  it("offers a pull request for a pushed branch that has none", () => {
    expect(offeredShortcuts(workspace())).toContain("pull_request");
  });

  it("offers no pull request while there are commits still to push", () => {
    // The pull request would not contain the work. Push is what is offered
    // instead, and it is offered on the same row.
    const offered = offeredShortcuts(workspace({ ahead: 3 }));
    expect(offered).toContain("push");
    expect(offered).not.toContain("pull_request");
  });

  it("offers no pull request when the branch already has one", () => {
    expect(
      offeredShortcuts(
        workspace({
          pullRequest: { number: 7, url: "p", title: "t", state: "open" },
        }),
      ),
    ).not.toContain("pull_request");
  });

  it("offers no second pull request for work that already landed", () => {
    // A merged pull request is still a pull request out from this branch.
    // Offering another would be suggesting the work be done again.
    expect(
      offeredShortcuts(
        workspace({
          pullRequest: { number: 7, url: "p", title: "t", state: "merged" },
        }),
      ),
    ).not.toContain("pull_request");
  });

  it("offers no pull request from the trunk", () => {
    expect(offeredShortcuts(workspace({ branch: "main" }))).not.toContain(
      "pull_request",
    );
  });

  it("offers no pull request when it cannot tell which branch is the trunk", () => {
    // A clone that was never told what `origin`'s HEAD is. Staying quiet is the
    // safe half: the alternative is offering to open a pull request from the
    // trunk, which is a button that cannot do anything useful.
    expect(
      offeredShortcuts(workspace({ defaultBranch: undefined })),
    ).not.toContain("pull_request");
  });

  it("offers them in the order the work happens", () => {
    // Commit, push, open. Fixed rather than in whatever order the conditions
    // came true, so a button never moves under the pointer as the poll lands.
    expect(offeredShortcuts(workspace({ dirty: true, ahead: 2 }))).toEqual([
      "commit",
      "push",
    ]);
  });

  it("offers nothing at all for a folder that is not a repository", () => {
    expect(
      offeredShortcuts({
        workspaceId: "w-1",
      }),
    ).toEqual([]);
  });
});
