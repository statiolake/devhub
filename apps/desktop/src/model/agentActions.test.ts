/**
 * What DevHub says to an Agent, and how it says it to each of them.
 *
 * Two transformations, and both are here because both used to be candidates
 * for being done twice: filling in the variables, and translating the skill
 * notation for whichever agent is being spoken to.
 */

import { describe, expect, it } from "vitest";
import {
  ACTION_VARIABLES,
  applySkillNotation,
  BUILT_IN_ACTIONS,
  fillVariables,
  renderAgentAction,
  triggerOf,
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

  it("says what fires each of them, and calls anything else an Issue action", () => {
    // The extension point: an id DevHub has never heard of is wording somebody
    // wrote for the Issue flow, which is the one trigger that has a picker.
    expect(triggerOf("issue_assignment")).toBe("issue");
    expect(triggerOf("commit_changes")).toBe("commit");
    expect(triggerOf("push_commits")).toBe("push");
    expect(triggerOf("open_pull_request")).toBe("pull_request");
    expect(triggerOf("review_it_instead")).toBe("issue");
  });

  it("ships exactly one action per shortcut", () => {
    // Each of the three buttons fires one action and has no picker, so a
    // second action with the same trigger would be a message that can never
    // be sent.
    for (const trigger of ["commit", "push", "pull_request"] as const) {
      expect(
        BUILT_IN_ACTIONS.filter((action) => action.trigger === trigger),
      ).toHaveLength(1);
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
  it("is the wording, filled in, in that agent's dialect", () => {
    expect(
      renderAgentAction(
        "$solve-task {{ISSUE_URL}}\nbranch feature/{{ISSUE_NO}}-wip",
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
