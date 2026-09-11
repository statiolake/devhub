/**
 * That every reason the model can compute is a reason a person can read.
 *
 * `model/wire.test.ts` pins the other half: the diagnostic crosses the wire
 * with the state that carries it, instead of being dropped and the tag
 * arriving alone. The two together are the rule — a stop or a close that
 * failed says *why*, in one vocabulary, wherever it is shown.
 */

import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES } from "../../../model/domain";
import { agentFailureLabel, closeDiagnosticLabel } from "./diagnosticLabel";

describe("the close vocabulary", () => {
  it("gives every diagnostic a sentence of its own", () => {
    const labels = DIAGNOSTIC_CODES.map(closeDiagnosticLabel);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(DIAGNOSTIC_CODES.length);
  });

  it("never names a control somewhere else, or a code", () => {
    for (const code of DIAGNOSTIC_CODES) {
      const label = closeDiagnosticLabel(code);
      expect(label).not.toContain(code);
      expect(label).not.toMatch(/from the Sidebar/);
    }
  });
});

describe("what a refusal about one Agent reads as", () => {
  it("lets a tmux refusal say the command and the reason, and nothing twice", () => {
    // The summary is the same sentence with the facts taken out, so the
    // detail stands alone rather than following it.
    expect(
      agentFailureLabel({
        code: "tmux_command_failed",
        detail: "tmux `kill-session` failed: can't find session: nope",
      }),
    ).toBe("tmux `kill-session` failed: can't find session: nope");
    expect(
      agentFailureLabel({
        code: "tmux_command_timed_out",
        detail: "tmux `list-sessions` did not answer within 8 s",
      }),
    ).toBe("tmux `list-sessions` did not answer within 8 s");
  });

  it("still says something when there is nothing tmux told it", () => {
    expect(agentFailureLabel({ code: "tmux_command_failed" })).toBe(
      "The Agent runtime refused the request.",
    );
  });

  it("keeps both halves for a code whose detail adds something", () => {
    expect(
      agentFailureLabel({
        code: "agent_runtime_unavailable",
        detail: "DevHub could not find 'tmux' on PATH.",
      }),
    ).toBe(
      "The Agent runtime could not be reached. DevHub could not find 'tmux' on PATH.",
    );
  });
});
