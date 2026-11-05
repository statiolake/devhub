/**
 * The Orchestrator row's Workspace (`AppModel.orchestratorWorkspaceId`): the
 * orchestrator's folder, drawn as the Orchestrator row the way Scratch's
 * Workspace is drawn as Scratch. See `docs/orchestrator.md`.
 */

import { describe, expect, it } from "vitest";
import { sidebarWorkspaces } from "../ipc/appShell.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  CLEAN_CLOSE_INSPECTION,
  DomainError,
  DomainErrorCode,
  workspaceId,
} from "./domain.js";
import {
  drawn,
  localWorkspace,
  scratchModel,
  SCRATCH_PATH,
} from "./testWorkspaces.js";

const ROOT = "/Users/me/orchestrator";
const WS_ROOT = workspaceId("550e8400-e29b-41d4-a716-4466554400d0");
const WS_APP = workspaceId("550e8400-e29b-41d4-a716-4466554400d1");
const ORCH = agentId("550e8400-e29b-41d4-a716-4466554400e0");
const HELPER = agentId("550e8400-e29b-41d4-a716-4466554400e1");
const OTHER = agentId("550e8400-e29b-41d4-a716-4466554400e2");

const claude = AgentProfile.create(
  agentProfileId("claude"),
  "Claude",
  "claude",
  "claude",
);

function codeOf(run: () => unknown): DomainErrorCode | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? error.code : undefined;
  }
  return undefined;
}

/** A model with the root open as an ordinary Workspace, and one more. */
function withRootOpen() {
  const model = scratchModel();
  model.addWorkspace(localWorkspace(ROOT, WS_ROOT));
  model.addWorkspace(localWorkspace("/src/app", WS_APP));
  return model;
}

describe("the Orchestrator row's Workspace", () => {
  it("adopts a Workspace already open at the root, as soon as main names the root", () => {
    // Persisted by the earlier design as an ordinary row.
    const model = withRootOpen();
    expect(model.orchestratorWorkspaceId).toBeUndefined();
    expect(
      sidebarWorkspaces(model.snapshot()).rows.map((one) => one.id),
    ).toContain(WS_ROOT);

    model.setOrchestratorRoot(ROOT);
    const snapshot = model.snapshot();
    expect(snapshot.orchestratorWorkspaceId).toBe(WS_ROOT);
    const { orchestrator, scratch, rows } = sidebarWorkspaces(snapshot);
    // Not an ordinary row any more, and never a duplicate one.
    expect(orchestrator?.id).toBe(WS_ROOT);
    expect(scratch.id).toBe(model.scratchWorkspaceId);
    expect(rows.map((one) => one.id)).toEqual([WS_APP]);
    expect(orchestrator?.label).toBe("Orchestrator");
    // Drawn first, above Scratch, in the order a close lands by.
    expect(drawn(model)).toEqual([WS_ROOT, model.scratchWorkspaceId, WS_APP]);
  });

  it("is the orchestrator agent's Workspace while one is assigned, whatever the root", () => {
    const model = withRootOpen();
    model.setOrchestratorRoot("/somewhere/else");
    expect(model.orchestratorWorkspaceId).toBeUndefined();
    model.addAgent(WS_ROOT, ORCH, claude, "gui");
    model.setOrchestratorAgent(ORCH);
    expect(model.orchestratorWorkspaceId).toBe(WS_ROOT);
    // It stopped: the Workspace at a root that is not the configured one is
    // an ordinary row again.
    model.agentExited(ORCH);
    expect(model.orchestratorWorkspaceId).toBeUndefined();
    expect(
      model.snapshot().workspaces.find((one) => one.id === WS_ROOT)?.label,
    ).toBe("orchestrator");
  });

  it("is never Scratch", () => {
    const model = scratchModel();
    model.setOrchestratorRoot(SCRATCH_PATH);
    expect(model.orchestratorWorkspaceId).toBeUndefined();
  });

  it("cannot be closed, as Scratch cannot", () => {
    const model = withRootOpen();
    model.setOrchestratorRoot(ROOT);
    expect(
      codeOf(() =>
        model.closeWorkspace(WS_ROOT, CLEAN_CLOSE_INSPECTION, drawn(model)),
      ),
    ).toBe(DomainErrorCode.OrchestratorCannotClose);
    expect(model.workspace(WS_ROOT)).toBeDefined();
  });

  it("selects its agents and its editor like any Workspace's, the orchestrator itself being the row", () => {
    const model = withRootOpen();
    model.setOrchestratorRoot(ROOT);
    model.addAgent(WS_ROOT, ORCH, claude, "gui");
    model.addAgent(WS_ROOT, HELPER, claude, "tui");
    model.setOrchestratorAgent(ORCH);

    model.selectContext({ kind: "agent", agentId: HELPER });
    expect(model.snapshot().layout).toEqual({
      kind: "agent",
      agent: { kind: "agent", agentId: HELPER },
    });
    model.selectContext({ kind: "workspace", workspaceId: WS_ROOT });
    expect(model.snapshot().layout).toEqual({
      kind: "workbench",
      editor: { kind: "workspace-editor", workspaceId: WS_ROOT },
    });
    model.selectContext({ kind: "agent", agentId: ORCH });
    expect(model.selection.context).toEqual({ kind: "orchestrator" });
  });

  it("lands a close of its last helper on the Orchestrator row, not on its agent's pane", () => {
    const model = withRootOpen();
    model.setOrchestratorRoot(ROOT);
    model.addAgent(WS_ROOT, ORCH, claude, "gui");
    model.addAgent(WS_ROOT, HELPER, claude, "tui");
    model.addAgent(WS_APP, OTHER, claude, "tui");
    model.setOrchestratorAgent(ORCH);
    model.selectContext({ kind: "agent", agentId: HELPER });
    model.agentExited(HELPER);
    expect(model.selection).toEqual({
      context: { kind: "orchestrator" },
      presentation: "full",
    });
  });
});
