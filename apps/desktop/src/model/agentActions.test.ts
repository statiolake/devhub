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
  DEFAULT_ACTION_TEMPLATE,
  fillVariables,
  renderAgentAction,
} from "./agentActions.js";

describe("the action DevHub ships", () => {
  it("uses every variable an action is offered", () => {
    // A variable the Settings note advertises and the shipped wording never
    // uses is one it invites somebody to type where it means nothing.
    for (const name of ACTION_VARIABLES) {
      expect(DEFAULT_ACTION_TEMPLATE).toContain(`{{${name}}}`);
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
