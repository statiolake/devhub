import { describe, expect, it } from "vitest";
import { attachableSurfaces, editorSurfaces } from "./surfacePool";
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

describe("the Editors, one per Workspace", () => {
  it("gives every available Workspace an Editor of its own", () => {
    // A Workbench holds the workspace it was raised with and cannot be given
    // another, so one per Workspace is not a number to be tuned — it is the
    // only arrangement that works.
    const editors = editorSurfaces(agentSnapshot);
    expect([...editors.keys()]).toEqual([
      "global-editor",
      "workspace-editor:workspace-1",
    ]);
    expect(editors.get("workspace-editor:workspace-1")?.folder).toBe(
      agentSnapshot.workspaces[0]?.root,
    );
  });

  it("drops a Workspace whose Root is gone, keeping the folderless one", () => {
    expect([...editorSurfaces(unavailableSnapshot).keys()]).toEqual([
      "global-editor",
    ]);
  });
});
