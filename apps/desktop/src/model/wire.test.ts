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
  CLOSE_STEPS,
  DIAGNOSTIC_CODES,
  type AgentControlState,
  type DiagnosticCode,
  type WorkspaceClose,
  type WorkspaceState,
} from "./domain.js";
import { snapshotWire } from "./wire.js";
import type {
  AgentSnapshot,
  AppSnapshot,
  WorkspaceSnapshot,
} from "./appModel.js";

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
    location: { kind: "local", path: "/example" },
    root: "/example",
    key: "/example",
    selectedPath: "example",
    repositoryId: undefined,
    state,
    close: { kind: "idle" },
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

function projectClose(close: WorkspaceClose) {
  return snapshotWire(
    snapshotOf([{ ...workspace({ kind: "available" }), close }]),
    "ready",
    () => undefined,
  ).workspaces[0]!.close;
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
];

const WORKSPACE_CLOSES: readonly WorkspaceClose[] = [
  { kind: "idle" },
  { kind: "running" },
  { kind: "failed", step: "editor", diagnostic: "close_editor_vetoed" },
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
});

describe("a Workspace's close across the wire", () => {
  it("carries each variant whole", () => {
    for (const close of WORKSPACE_CLOSES) {
      expect(projectClose(close)).toEqual(close);
    }
  });

  it("carries both halves of a failure: the step, and the reason", () => {
    // Either alone is unreadable. Every step reports the same handful of
    // diagnostics, so the diagnostic without the step never says which step
    // stopped — and the step without the reason never says why.
    for (const step of CLOSE_STEPS) {
      for (const diagnostic of DIAGNOSTIC_CODES) {
        expect(projectClose({ kind: "failed", step, diagnostic })).toEqual({
          kind: "failed",
          step,
          diagnostic,
        });
      }
    }
  });

  it("says nothing about a close in the Workspace's availability", () => {
    // Two facts, not one. A Workspace whose folder vanished mid-close is
    // both, and one used to overwrite the other.
    const projected = snapshotWire(
      snapshotOf([
        {
          ...workspace({ kind: "unavailable", reason: "root_missing" }),
          close: { kind: "running" },
        },
      ]),
      "ready",
      () => undefined,
    ).workspaces[0]!;
    expect(projected.state).toEqual({
      kind: "unavailable",
      reason: "root_missing",
    });
    expect(projected.close).toEqual({ kind: "running" });
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
