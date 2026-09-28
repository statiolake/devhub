/**
 * What DevHub says to an Agent, and how it says it to each of them.
 *
 * Two transformations, and both are here because both used to be candidates
 * for being done twice: filling in the variables, and translating the skill
 * notation for whichever agent is being spoken to.
 */

import { describe, expect, it } from "vitest";
import { errorWire } from "./wire.js";
import {
  ACTION_TRIGGERS,
  ACTION_VARIABLES,
  applySkillNotation,
  BUILT_IN_ACTIONS,
  fillVariables,
  isSmartButtonTrigger,
  renderAgentAction,
  smartButtonTriggers,
  smartButtonValues,
  triggerOf,
  type SmartButtonRepository,
} from "./agentActions.js";

describe("the actions DevHub ships", () => {
  it("uses every variable its own trigger is offered", () => {
    // A variable the Settings note advertises and the shipped wording never
    // uses is one it invites somebody to type where it means nothing. Read per
    // trigger now that there is more than one: a commit button is not offered
    // an Issue URL, and would have no way to fill one in.
    for (const action of BUILT_IN_ACTIONS) {
      for (const name of ACTION_VARIABLES[action.trigger]) {
        expect(action.template).toContain(`{{${name}}}`);
      }
    }
  });

  /**
   * A built-in's id is what a file written years ago says, and what a person's
   * edited wording is merged onto. New actions are given a generated id now,
   * and that changed nothing here: these four are fixed for good.
   */
  it("keeps the ids it has always shipped", () => {
    expect(BUILT_IN_ACTIONS.map((action) => action.id)).toEqual([
      "issue_assignment",
      "commit_changes",
      "push_commits",
      "open_pull_request",
      "ready_draft_pull_request",
      "address_review_comments",
      "fix_ci",
    ]);
  });

  it("says what fires each of them, and calls anything else an Issue action", () => {
    // The extension point: an id DevHub has never heard of is wording somebody
    // wrote for the Issue flow, which is the one trigger that has a picker.
    expect(triggerOf("issue_assignment")).toBe("issue");
    expect(triggerOf("commit_changes")).toBe("commit");
    expect(triggerOf("push_commits")).toBe("push");
    expect(triggerOf("open_pull_request")).toBe("pull_request");
    expect(triggerOf("review_it_instead")).toBe("issue");
  });

  it("ships exactly one action per trigger", () => {
    // Two built-ins under one trigger would be two buttons for one condition
    // before anybody asked for a second.
    for (const trigger of ACTION_TRIGGERS) {
      expect(
        BUILT_IN_ACTIONS.filter((action) => action.trigger === trigger),
      ).toHaveLength(1);
    }
  });

  it("sends every Smart Button without a review sheet, and reviews the Issue flow's", () => {
    // A Smart Button's text is what its label says; the Issue flow's is a
    // filled-in template about something DevHub read.
    for (const action of BUILT_IN_ACTIONS) {
      expect(action.confirmBeforeSend).toBe(
        !isSmartButtonTrigger(action.trigger),
      );
    }
  });
});

/** A repository on a feature branch with nothing to do, varied per case. */
function repository(
  over: Partial<SmartButtonRepository> = {},
): SmartButtonRepository {
  return {
    branch: "feature/128-tidy",
    defaultBranch: "main",
    dirty: false,
    ahead: 0,
    pullRequest: {
      number: 42,
      url: "https://github.com/example/widget/pull/42",
      title: "Tidy",
      state: "open",
      conversations: { unresolved: 0, uncounted: 0 },
      checks: { state: "passing", total: 3, failing: 0, pending: 0 },
    },
    ...over,
  };
}

type PullRequest = NonNullable<SmartButtonRepository["pullRequest"]>;

function withPullRequest(over: Partial<PullRequest>): SmartButtonRepository {
  const base = repository().pullRequest as PullRequest;
  return repository({ pullRequest: { ...base, ...over } });
}

describe("when a Smart Button is offered", () => {
  it("offers nothing for a repository with nothing to do", () => {
    expect(smartButtonTriggers("idle", repository())).toEqual([]);
  });

  it("offers commit for uncommitted changes", () => {
    expect(smartButtonTriggers("idle", repository({ dirty: true }))).toEqual([
      "commit",
    ]);
    // Not knowing is not dirty.
    expect(
      smartButtonTriggers("idle", repository({ dirty: undefined })),
    ).toEqual([]);
  });

  it("offers push for commits ahead of the upstream, and not with no upstream", () => {
    expect(smartButtonTriggers("idle", repository({ ahead: 2 }))).toEqual([
      "push",
    ]);
    expect(
      smartButtonTriggers("idle", repository({ ahead: undefined })),
    ).toEqual([]);
  });

  it("offers a pull request on a branch with none, pushed or not", () => {
    expect(
      smartButtonTriggers(
        "idle",
        repository({ pullRequest: undefined, ahead: undefined }),
      ),
    ).toEqual(["pull_request"]);
  });

  it("does not offer a pull request from the trunk, or when the trunk is not known", () => {
    expect(
      smartButtonTriggers(
        "idle",
        repository({ pullRequest: undefined, branch: "main" }),
      ),
    ).toEqual([]);
    expect(
      smartButtonTriggers(
        "idle",
        repository({ pullRequest: undefined, defaultBranch: undefined }),
      ),
    ).toEqual([]);
  });

  it("does not offer a second pull request for a branch whose one was merged", () => {
    expect(
      smartButtonTriggers("idle", withPullRequest({ state: "merged" })),
    ).toEqual([]);
  });

  it("offers getting a draft ready for a draft pull request", () => {
    expect(
      smartButtonTriggers("idle", withPullRequest({ state: "draft" })),
    ).toEqual(["draft_pull_request"]);
  });

  it("offers review comments while some are unresolved, or went uncounted", () => {
    expect(
      smartButtonTriggers(
        "idle",
        withPullRequest({ conversations: { unresolved: 2, uncounted: 0 } }),
      ),
    ).toEqual(["unresolved_review_comments"]);
    expect(
      smartButtonTriggers(
        "idle",
        withPullRequest({ conversations: { unresolved: 0, uncounted: 30 } }),
      ),
    ).toEqual(["unresolved_review_comments"]);
    // On a draft too, beside getting it ready.
    expect(
      smartButtonTriggers(
        "idle",
        withPullRequest({
          state: "draft",
          conversations: { unresolved: 1, uncounted: 0 },
        }),
      ),
    ).toEqual(["draft_pull_request", "unresolved_review_comments"]);
  });

  it("offers fixing CI while it fails on an open or draft pull request", () => {
    const failing = {
      state: "failing" as const,
      total: 3,
      failing: 1,
      pending: 0,
    };
    expect(
      smartButtonTriggers("idle", withPullRequest({ checks: failing })),
    ).toEqual(["ci_failing"]);
    expect(
      smartButtonTriggers(
        "idle",
        withPullRequest({ checks: { ...failing, state: "pending" } }),
      ),
    ).toEqual([]);
  });

  it("offers nothing about a pull request that is closed or merged", () => {
    for (const state of ["closed", "merged"] as const) {
      expect(
        smartButtonTriggers(
          "idle",
          withPullRequest({
            state,
            conversations: { unresolved: 3, uncounted: 0 },
            checks: { state: "failing", total: 1, failing: 1, pending: 0 },
          }),
        ),
      ).toEqual([]);
    }
  });

  it("offers them in the order the work goes in", () => {
    expect(
      smartButtonTriggers(
        "idle",
        repository({
          dirty: true,
          ahead: 1,
          pullRequest: {
            ...(repository().pullRequest as PullRequest),
            state: "draft",
            conversations: { unresolved: 1, uncounted: 0 },
            checks: { state: "failing", total: 2, failing: 2, pending: 0 },
          },
        }),
      ),
    ).toEqual([
      "commit",
      "push",
      "draft_pull_request",
      "unresolved_review_comments",
      "ci_failing",
    ]);
  });

  it("offers nothing unless the Agent is idle", () => {
    const busy = repository({ dirty: true, ahead: 1 });
    for (const status of [
      "working",
      "waiting",
      "background",
      "error",
      "unknown",
    ] as const) {
      expect(smartButtonTriggers(status, busy)).toEqual([]);
    }
    expect(smartButtonTriggers("idle", busy)).toEqual(["commit", "push"]);
  });

  it("offers nothing for a Workspace whose repository is not known", () => {
    expect(smartButtonTriggers("idle", undefined)).toEqual([]);
  });
});

describe("what a Smart Button's wording is filled from", () => {
  it("names the branch and the pull request", () => {
    expect(
      smartButtonValues(
        withPullRequest({
          conversations: { unresolved: 4, uncounted: 0 },
          checks: { state: "failing", total: 5, failing: 2, pending: 0 },
        }),
      ),
    ).toEqual({
      BRANCH: "feature/128-tidy",
      PR_URL: "https://github.com/example/widget/pull/42",
      PR_NO: "42",
      UNRESOLVED: "4",
      FAILING: "2",
    });
  });

  it("says a count read from the first page only is a lower bound", () => {
    expect(
      smartButtonValues(
        withPullRequest({ conversations: { unresolved: 100, uncounted: 12 } }),
      )["UNRESOLVED"],
    ).toBe("100+");
  });

  it("leaves out what is not known, so the template keeps its hole", () => {
    const values = smartButtonValues(
      repository({ pullRequest: undefined, branch: undefined }),
    );
    expect(values).toEqual({});
    expect(fillVariables("{{PR_URL}} on {{BRANCH}}", values)).toBe(
      "{{PR_URL}} on {{BRANCH}}",
    );
  });

  it("fills every shipped Smart Button's wording completely for a pull request that has it all", () => {
    const values = smartButtonValues(
      withPullRequest({
        conversations: { unresolved: 1, uncounted: 0 },
        checks: { state: "failing", total: 1, failing: 1, pending: 0 },
      }),
    );
    for (const action of BUILT_IN_ACTIONS) {
      if (!isSmartButtonTrigger(action.trigger)) continue;
      expect(fillVariables(action.template, values)).not.toMatch(/\{\{/u);
    }
  });
});

describe("filling in a message", () => {
  it("replaces every occurrence of a name", () => {
    expect(
      fillVariables("{{A}} and {{B}}, then {{A}}", { A: "one", B: "two" }),
    ).toBe("one and two, then one");
  });

  it("leaves a name it was given no value for exactly as written", () => {
    // A hole where the number should be is a mistake somebody can see. An
    // empty string is a mistake that reads as a sentence.
    expect(fillVariables("issue {{ISSUE_NO}}", {})).toBe("issue {{ISSUE_NO}}");
  });
});

describe("the skill notation", () => {
  it("is Claude Code's slash when the agent is Claude Code", () => {
    expect(applySkillNotation("$solve-task https://x/1", "claude")).toBe(
      "/solve-task https://x/1",
    );
  });

  it("is left as written for Codex, whose notation it already is", () => {
    expect(applySkillNotation("$solve-task https://x/1", "codex")).toBe(
      "$solve-task https://x/1",
    );
  });

  it("is left as written for an agent DevHub has no manifest for", () => {
    // Guessing a syntax for a program nobody has described is how a prompt
    // turns into a command that means something else.
    expect(applySkillNotation("$solve-task", "custom")).toBe("$solve-task");
  });

  /**
   * Having a manifest is not knowing the dialect. DevHub can read Cursor's
   * screen; nothing here has ever seen how Cursor spells a skill, so the line
   * goes as written rather than as guessed.
   */
  it("is left as written for Cursor, whose notation nobody here has seen", () => {
    expect(applySkillNotation("$solve-task", "cursor")).toBe("$solve-task");
  });

  it("only translates at the start of a line", () => {
    // A variable being talked about, and a price, are not skills.
    expect(
      applySkillNotation("read $HOME first\n$go now\ncosts $5", "claude"),
    ).toBe("read $HOME first\n/go now\ncosts $5");
  });
});

describe("what is actually sent", () => {
  // A template somebody wrote empty in settings.toml: there is nothing to
  // send, and saying so names the action, under its own title — it used to
  // reach the page as "The native app shell is unavailable."
  it("is refused, naming the action, when its wording is empty", () => {
    let thrown: unknown;
    try {
      renderAgentAction(
        { id: "nudge", display_name: "Nudge", template: "  \n" },
        {},
        "claude",
      );
    } catch (failure: unknown) {
      thrown = failure;
    }
    expect(errorWire(thrown)).toMatchObject({
      code: "agent_action_empty",
      detail: expect.stringContaining("“Nudge” (nudge)") as string,
    });
  });

  it("is the wording, filled in, in that agent's dialect", () => {
    expect(
      renderAgentAction(
        {
          id: "solve",
          display_name: "Solve",
          template:
            "$solve-task {{ISSUE_URL}}\nbranch feature/{{ISSUE_NO}}-wip",
        },
        {
          ISSUE_URL: "https://github.com/example/widget/issues/128",
          ISSUE_NO: "128",
        },
        "claude",
      ),
    ).toBe(
      "/solve-task https://github.com/example/widget/issues/128\nbranch feature/128-wip",
    );
  });
});
