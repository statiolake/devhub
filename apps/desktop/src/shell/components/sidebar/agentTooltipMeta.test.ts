/**
 * An Agent's own key/value pairs in its row's tooltip: quiet `key: value`
 * lines after what the row leads with, and nothing for an Agent with none.
 */

import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../../../ipc/appShell";
import { agentTooltipFacts } from "./rowDescription";

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "a-1",
    workspaceId: "w-1",
    ordinal: 1,
    displayName: "Reviewer",
    named: true,
    profileId: "claude",
    profileKind: "claude",
    presentation: "gui",
    status: "idle",
    runtimeHealth: "healthy",
    controlState: { kind: "running" },
    unread: undefined,
    activity: undefined,
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
    ...overrides,
  } as unknown as AgentSnapshot;
}

describe("an Agent's metadata in its tooltip", () => {
  it("is one quiet line a pair, after the name", () => {
    const facts = agentTooltipFacts(
      agent({ meta: { role: "reviewer", parent: "b-2" } }),
    );
    expect(facts.map((fact) => [fact.text, fact.style])).toEqual([
      ["Reviewer", undefined],
      ["role: reviewer", "muted"],
      ["parent: b-2", "muted"],
    ]);
  });

  it("adds nothing for an Agent with none", () => {
    expect(agentTooltipFacts(agent()).map((fact) => fact.text)).toEqual([
      "Reviewer",
    ]);
  });

  it("says an Agent under the orchestrator's management is", () => {
    expect(
      agentTooltipFacts(agent({ managed: true })).map((fact) => [
        fact.icon,
        fact.text,
      ]),
    ).toContainEqual(["orchestrator", "Managed by the orchestrator"]);
  });
});
