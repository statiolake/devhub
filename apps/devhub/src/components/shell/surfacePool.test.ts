import { describe, expect, it } from "vitest";
import { attachableSurfaces, warmSurfaces } from "./surfacePool";
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

describe("the Surfaces warmed before they are asked for", () => {
  it("warms Scratch from everywhere", () => {
    expect(warmSurfaces(globalSnapshot)).toEqual(["global-terminal"]);
  });

  it("warms the selected Workspace's terminal and its running Agents", () => {
    // These are the Surfaces one click away in the Sidebar, and their
    // processes are alive either way — warming buys only the handshake.
    expect(warmSurfaces(agentSnapshot)).toEqual([
      "global-terminal",
      "workspace-terminal:workspace-1",
      "agent:agent-1",
      "agent:agent-2",
    ]);
  });

  it("warms nothing belonging to a Workspace that is not there", () => {
    expect(warmSurfaces(unavailableSnapshot)).toEqual(["global-terminal"]);
  });
});
