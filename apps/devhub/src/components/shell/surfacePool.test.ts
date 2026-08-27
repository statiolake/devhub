import { describe, expect, it } from "vitest";
import { attachableSurfaces } from "./surfacePool";
import {
  agentSnapshot,
  globalSnapshot,
  unavailableSnapshot,
} from "../../visual-fixtures/app-shell";
import type { AppSnapshot } from "../../generated/app-shell";

describe("the pool of attachable Surfaces", () => {
  it("always holds the Scratch terminal", () => {
    expect([...attachableSurfaces(globalSnapshot).keys()]).toEqual([
      "global-terminal",
    ]);
  });

  it("holds one terminal per available Workspace and one per running Agent", () => {
    expect([...attachableSurfaces(agentSnapshot).keys()]).toEqual([
      "global-terminal",
      "workspace-terminal:workspace-1",
      "agent:agent-1",
      "agent:agent-2",
    ]);
  });

  it("evicts a Workspace whose Root is gone, along with its Agents", () => {
    // A pooled Surface outlives the selection but not its subject: leaving an
    // unavailable Workspace in the pool would park an attachment on a Root
    // that is no longer there.
    const keys = [...attachableSurfaces(unavailableSnapshot).keys()];
    expect(keys).toEqual(["global-terminal"]);
  });

  it("evicts an Agent the moment it stops running", () => {
    const stopping: AppSnapshot = {
      ...agentSnapshot,
      workspaces: agentSnapshot.workspaces.map((workspace) => ({
        ...workspace,
        agents: workspace.agents.map((agent) =>
          agent.id === "agent-1"
            ? { ...agent, controlState: "stopping" as const }
            : agent,
        ),
      })),
    };
    expect([...attachableSurfaces(stopping).keys()]).not.toContain(
      "agent:agent-1",
    );
    expect([...attachableSurfaces(stopping).keys()]).toContain("agent:agent-2");
  });
});
