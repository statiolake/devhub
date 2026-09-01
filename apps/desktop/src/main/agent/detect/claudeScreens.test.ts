/**
 * The Claude Code manifest, against screens a real Claude Code drew.
 *
 * `rules.test.ts` proves the engine. This proves the manifest still describes
 * the program: the rules are a model of somebody else's UI, and the only thing
 * standing between a redesigned screen and a sidebar that confidently says the
 * wrong word is a transcript of each state with the answer written down.
 */

import { describe, expect, it } from "vitest";
import {
  CLAUDE_IDLE,
  CLAUDE_WAITING,
  CLAUDE_WORKING,
  type ClaudeScreen,
} from "./claudeScreens.fixture.js";
import { CLAUDE } from "./manifests.js";
import { read } from "./rules.js";

function reading(screen: ClaudeScreen) {
  return read(CLAUDE, { ...screen, oscProgress: "" });
}

describe("the Claude Code manifest, on real screens", () => {
  it("says working while it is working", () => {
    const result = reading(CLAUDE_WORKING);
    expect(result.state).toBe("working");
    expect(result.visibleWorking).toBe(true);
  });

  it("says idle when it is waiting for a person to type", () => {
    expect(reading(CLAUDE_IDLE).state).toBe("idle");
  });

  it("says blocked when it has stopped to ask a question", () => {
    const result = reading(CLAUDE_WAITING);
    expect(result.state).toBe("blocked");
    expect(result.visibleBlocker).toBe(true);
  });

  /** Each state is decided by chrome that is actually on the screen. */
  it("decides each state from live chrome, and says so", () => {
    expect(reading(CLAUDE_WORKING).matchedRuleId).toBe("screen_working_footer");
    expect(reading(CLAUDE_IDLE).matchedRuleId).toBe("live_prompt_box");
    expect(reading(CLAUDE_WAITING).matchedRuleId).toBe(
      "numbered_permission_prompt",
    );
  });

  /**
   * Which way the manifest fails when Claude Code is redrawn again.
   *
   * `unknown` is the sidebar's `?`, and the injection queue will not send on
   * it. `idle` is an invitation to act, and the thing the queue *does* send
   * on — so a stale rule that guessed idle would type into a running turn.
   * The old title rule guessed exactly that for every screen it did not know.
   */
  it("says it cannot tell, rather than guessing idle, on a screen it does not know", () => {
    const result = read(CLAUDE, {
      screen: "a screen no rule here describes",
      oscTitle: CLAUDE_WORKING.oscTitle,
      oscProgress: "",
    });
    expect(result.state).toBe("unknown");
  });

  /**
   * The title used to carry a spinner and was the whole of how working was
   * told from idle. It does not any more, in any state, which is why this is
   * worth stating: a rule keyed on it can only ever be dead weight now, and a
   * reading that depends on it is a reading that has stopped working.
   */
  it("cannot tell the three states apart by the title alone", () => {
    expect(CLAUDE_WORKING.oscTitle).toBe(CLAUDE_IDLE.oscTitle);
    expect(CLAUDE_IDLE.oscTitle).toBe(CLAUDE_WAITING.oscTitle);
  });
});
