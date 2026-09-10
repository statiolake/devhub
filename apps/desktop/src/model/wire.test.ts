/**
 * What survives the projection seam.
 *
 * The model is disciplined about payload-carrying unions; the wire used to
 * flatten two of them to their tag and bolt the payload back on beside it as
 * an optional field. That made `{ state: "available", stateDiagnostic:
 * "cleanup_failed" }` writable — an invalid state the model had made
 * unrepresentable, representable one function call later — and it dropped
 * `CleanupProgress` entirely, so the page could not say how far a close got.
 *
 * These tests pin the rule that replaced it: the wire type *is* the model
 * type, with branded ids widened to `string` and nothing else. Every variant
 * crosses whole and no two variants land on the same wire value. That the
 * reason which crosses is the reason a person reads is
 * `shell/components/shell/diagnosticLabel.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  agentsStepDone,
  cleanupProgress,
  DIAGNOSTIC_CODES,
  type AgentControlState,
  type CleanupProgress,
  type DiagnosticCode,
  type WorkspaceState,
} from "./domain.js";
import { snapshotWire } from "./wire.js";
import type {
  AgentSnapshot,
  AppSnapshot,
  WorkspaceSnapshot,
} from "./appModel.js";

const PROGRESS: CleanupProgress = cleanupProgress(
  agentsStepDone(2),
  true,
  false,
);

function agent(controlState: AgentControlState): AgentSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    profile: { id: "claude", kind: "claude", displayName: "Claude" },
    profileId: "claude",
    profileKind: "claude",
    profileDisplayName: "Claude",
    displayName: "claude 1",
    ordinal: 1,
    status: "idle",
    runtimeHealth: "healthy",
    controlState,
    unread: undefined,
    activity: undefined,
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
  } as unknown as AgentSnapshot;
}

function workspace(
  state: WorkspaceState,
  agents: readonly AgentSnapshot[] = [],
): WorkspaceSnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    label: "example",
    root: "/example",
    selectedPath: "example",
    repositoryId: undefined,
    state,
    agents,
    canCreateAgent: true,
    lastAgentId: undefined,
  } as unknown as WorkspaceSnapshot;
}

function snapshotOf(workspaces: readonly WorkspaceSnapshot[]): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    selection: { context: { kind: "global" }, presentation: "full" },
    layout: { kind: "unavailable" },
    workspaces,
    sidebar: { width: 248 },
    splitRatio: 0.55,
    editorHost: { kind: "ready" },
  } as unknown as AppSnapshot;
}

function projectWorkspace(state: WorkspaceState) {
  return snapshotWire(snapshotOf([workspace(state)]), "ready", () => undefined)
    .workspaces[0]!.state;
}

function projectControl(state: AgentControlState) {
  return snapshotWire(
    snapshotOf([workspace({ kind: "available" }, [agent(state)])]),
    "ready",
    () => undefined,
  ).workspaces[0]!.agents[0]!.controlState;
}

const WORKSPACE_STATES: readonly WorkspaceState[] = [
  { kind: "available" },
  { kind: "unavailable", reason: "root_missing" },
  { kind: "closing", progress: PROGRESS },
  {
    kind: "closing-failed",
    diagnostic: "close_editor_vetoed",
    progress: PROGRESS,
  },
];

const CONTROL_STATES: readonly AgentControlState[] = [
  { kind: "running" },
  { kind: "stopping" },
  { kind: "stop-failed", diagnostic: "close_agents_unknown" },
];

describe("a Workspace's state across the wire", () => {
  it("carries each variant whole", () => {
    for (const state of WORKSPACE_STATES) {
      expect(projectWorkspace(state)).toEqual(state);
    }
  });

  it("gives every variant a distinct wire value", () => {
    const seen = WORKSPACE_STATES.map((state) =>
      JSON.stringify(projectWorkspace(state)),
    );
    expect(new Set(seen).size).toBe(WORKSPACE_STATES.length);
  });

  it("carries how far a close got, not only that one is running", () => {
    const projected = projectWorkspace({ kind: "closing", progress: PROGRESS });
    expect(projected.kind).toBe("closing");
    if (projected.kind !== "closing") throw new Error("unreachable");
    expect(projected.progress).toEqual(PROGRESS);
  });

  it("carries a failed close's own reason, whichever it is", () => {
    for (const diagnostic of DIAGNOSTIC_CODES) {
      const projected = projectWorkspace({
        kind: "closing-failed",
        diagnostic,
        progress: PROGRESS,
      });
      if (projected.kind !== "closing-failed") throw new Error("unreachable");
      expect(projected.diagnostic).toBe(diagnostic);
    }
  });
});

describe("an Agent's control state across the wire", () => {
  it("carries each variant whole", () => {
    for (const state of CONTROL_STATES) {
      expect(projectControl(state)).toEqual(state);
    }
  });

  it("gives every variant a distinct wire value", () => {
    const seen = CONTROL_STATES.map((state) =>
      JSON.stringify(projectControl(state)),
    );
    expect(new Set(seen).size).toBe(CONTROL_STATES.length);
  });

  /**
   * The bug this file exists for: an Agent that would not stop reached the
   * page as the bare word "stop-failed", so the row could say that it would
   * not stop and never why — although DevHub knew, and had written it down.
   */
  it("carries the reason a stop failed, whichever it is", () => {
    const codes: readonly DiagnosticCode[] = DIAGNOSTIC_CODES;
    for (const diagnostic of codes) {
      const projected = projectControl({ kind: "stop-failed", diagnostic });
      if (projected.kind !== "stop-failed") throw new Error("unreachable");
      expect(projected.diagnostic).toBe(diagnostic);
    }
  });
});
