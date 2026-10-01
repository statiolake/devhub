import { describe, expect, it } from "vitest";
import {
  AutomaticActions,
  type AutomaticAgent,
  type AutomaticActionChoice,
} from "./automaticActions.js";
import type { SmartButtonRepository } from "./agentActions.js";

const ACTIONS: readonly AutomaticActionChoice[] = [
  { id: "commit_changes", trigger: "commit" },
  { id: "push_commits", trigger: "push" },
  { id: "open_pull_request", trigger: "pull_request" },
  { id: "address_review_comments", trigger: "unresolved_review_comments" },
  { id: "fix_ci", trigger: "ci_failing" },
];

function pr(
  unresolved: number,
  checks: "failing" | "passing" | "pending" = "passing",
  number = 7,
): SmartButtonRepository {
  return {
    branch: "feature/7-x",
    defaultBranch: "main",
    dirty: false,
    ahead: 0,
    pullRequest: {
      number,
      url: `https://github.com/o/r/pull/${String(number)}`,
      state: "open",
      conversations: { unresolved, uncounted: 0 },
      checks: { state: checks, failing: checks === "failing" ? 1 : 0 },
    },
  } as unknown as SmartButtonRepository;
}

function agent(
  repository: SmartButtonRepository | undefined,
  automaticActions: readonly string[],
  overrides: Partial<AutomaticAgent> = {},
): AutomaticAgent {
  return {
    agentId: "a1",
    status: "idle",
    queued: 0,
    automaticActions,
    repository,
    ...overrides,
  };
}

const fired = (
  automatic: AutomaticActions,
  one: AutomaticAgent,
): readonly string[] =>
  automatic.observe([one], ACTIONS).map((firing) => firing.actionId);

describe("automatic actions", () => {
  it("fires when review comments arrive, once, and again when more do", () => {
    const automatic = new AutomaticActions();
    const on = ["address_review_comments"];
    expect(fired(automatic, agent(pr(0), on))).toEqual([]);
    expect(fired(automatic, agent(pr(2), on))).toEqual([
      "address_review_comments",
    ]);
    // Answered but not resolved: the threads are still there, and are not
    // news.
    expect(fired(automatic, agent(pr(2), on))).toEqual([]);
    // Some resolved: not news either.
    expect(fired(automatic, agent(pr(1), on))).toEqual([]);
    // A new comment.
    expect(fired(automatic, agent(pr(3), on))).toEqual([
      "address_review_comments",
    ]);
  });

  it("is off unless ticked, and never for what was on screen when it was ticked", () => {
    const automatic = new AutomaticActions();
    expect(fired(automatic, agent(pr(2), []))).toEqual([]);
    expect(fired(automatic, agent(pr(2), ["address_review_comments"]))).toEqual(
      [],
    );
    expect(fired(automatic, agent(pr(4), ["address_review_comments"]))).toEqual(
      ["address_review_comments"],
    );
  });

  it("waits for the Agent to be idle with nothing queued", () => {
    const automatic = new AutomaticActions();
    const on = ["fix_ci"];
    expect(fired(automatic, agent(pr(0), on))).toEqual([]);
    expect(
      fired(automatic, agent(pr(0, "failing"), on, { status: "working" })),
    ).toEqual([]);
    expect(
      fired(automatic, agent(pr(0, "failing"), on, { queued: 1 })),
    ).toEqual([]);
    expect(fired(automatic, agent(pr(0, "failing"), on))).toEqual(["fix_ci"]);
  });

  it("fires CI again only for a new failure", () => {
    const automatic = new AutomaticActions();
    const on = ["fix_ci"];
    expect(fired(automatic, agent(pr(0, "failing"), []))).toEqual([]);
    expect(fired(automatic, agent(pr(0, "pending"), on))).toEqual([]);
    expect(fired(automatic, agent(pr(0, "failing"), on))).toEqual(["fix_ci"]);
    expect(fired(automatic, agent(pr(0, "failing"), on))).toEqual([]);
    // Nothing read this round: no news, not the end of the failure.
    expect(fired(automatic, agent(undefined, on))).toEqual([]);
    expect(fired(automatic, agent(pr(0, "failing"), on))).toEqual([]);
    expect(fired(automatic, agent(pr(0, "pending"), on))).toEqual([]);
    expect(fired(automatic, agent(pr(0, "failing"), on))).toEqual(["fix_ci"]);
    // Another pull request failing is another failure.
    expect(fired(automatic, agent(pr(0, "failing", 8), on))).toEqual([
      "fix_ci",
    ]);
  });

  it("does not send what a person already sent", () => {
    const automatic = new AutomaticActions();
    const on = ["address_review_comments"];
    expect(fired(automatic, agent(pr(0), on, { status: "working" }))).toEqual(
      [],
    );
    expect(fired(automatic, agent(pr(2), on, { status: "working" }))).toEqual(
      [],
    );
    automatic.answered("a1", "unresolved_review_comments");
    expect(fired(automatic, agent(pr(2), on))).toEqual([]);
  });

  it("sends one trigger at a time, and never one that is not automatic", () => {
    const automatic = new AutomaticActions();
    const on = ["commit_changes", "push_commits", "open_pull_request"];
    const clean = {
      branch: "feature/x",
      defaultBranch: "main",
      dirty: false,
      ahead: 0,
    } as unknown as SmartButtonRepository;
    expect(fired(automatic, agent(clean, on))).toEqual([]);
    const both = { ...clean, dirty: true, ahead: 1 };
    expect(fired(automatic, agent(both, on))).toEqual(["commit_changes"]);
    expect(fired(automatic, agent(both, on))).toEqual(["push_commits"]);
    expect(fired(automatic, agent(both, on))).toEqual([]);
  });

  it("forgets an Agent that has gone", () => {
    const automatic = new AutomaticActions();
    const on = ["address_review_comments"];
    fired(automatic, agent(pr(2), on));
    automatic.observe([], ACTIONS);
    // Back under the same id, the box ticked anew: what is there is not news.
    expect(fired(automatic, agent(pr(2), on))).toEqual([]);
  });
});
