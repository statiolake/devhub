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
  return snapshotWire(
    snapshotOf([workspace(state)]),
    "ready",
    () => undefined,
    () => undefined,
  ).workspaces[0]!.state;
}

function projectClose(close: WorkspaceClose) {
  return snapshotWire(
    snapshotOf([{ ...workspace({ kind: "available" }), close }]),
    "ready",
    () => undefined,
    () => undefined,
  ).workspaces[0]!.close;
}

function projectControl(state: AgentControlState) {
  return snapshotWire(
    snapshotOf([workspace({ kind: "available" }, [agent(state)])]),
    "ready",
    () => undefined,
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

describe("the order the projection puts the rows in", () => {
  const row = (id: string, label: string, key: string): WorkspaceSnapshot =>
    ({
      ...workspace({ kind: "available" }),
      id,
      label,
      key,
      root: key,
    }) as unknown as WorkspaceSnapshot;

  const A = "22222222-2222-4222-8222-22222222000a";
  const B = "22222222-2222-4222-8222-22222222000b";
  const W = "22222222-2222-4222-8222-22222222000c";

  const project = (order: readonly string[]) =>
    snapshotWire(
      {
        ...snapshotOf([
          row(B, "beta", "/b"),
          row(A, "alpha", "/a"),
          row(W, "alpha_wt", "/a_wt"),
        ]),
        workspaceOrder: order,
      } as unknown as AppSnapshot,
      "ready",
      (id) => (id === A || id === W ? "/a" : undefined),
      () => undefined,
    ).workspaces;

  it("says which group each row is in, so nobody has to work it out twice", () => {
    expect(project([]).map((one) => [one.label, one.groupKey])).toEqual([
      ["alpha", "/a"],
      ["alpha_wt", "/a"],
      ["beta", "/b"],
    ]);
  });

  it("applies the person's arrangement over the automatic rule", () => {
    expect(project([B, A]).map((one) => one.label)).toEqual([
      "beta",
      "alpha",
      "alpha_wt",
    ]);
  });
});

/**
 * A path written the way the person whose folder it is writes it.
 *
 * `~` is not a fact about a path, it is a fact about a path *and a machine*.
 * The page has no home directory it could use — and the one it could reach for
 * would be this Mac's, which is right about local rows and quietly wrong about
 * every row on a host. So the projection is told whose home to use, per machine,
 * and `root` crosses unchanged beside it for everything that is not reading.
 */
describe("the path a row shows", () => {
  const HOME = "/Users/example";
  const REMOTE_HOME = "/volume1/home/example";

  function rowAt(
    root: string,
    location: unknown,
    home: (id: string) => string,
  ) {
    const one = {
      ...workspace({ kind: "available" }),
      root,
      key: root,
      location,
    } as unknown as WorkspaceSnapshot;
    return snapshotWire(
      snapshotOf([one]),
      "ready",
      () => undefined,
      (at) => home(at.kind === "ssh" ? at.host : "local"),
    ).workspaces[0]!;
  }

  const local = { kind: "local", path: "/x" };
  const nas = { kind: "ssh", host: "nas", path: "/x" };

  it("abbreviates a folder under this machine's home", () => {
    const row = rowAt(`${HOME}/projects/x`, local, () => HOME);
    expect(row.displayRoot).toBe("~/projects/x");
    // And the canonical root is untouched: it is what identifies the Workspace,
    // keys its sessions, is handed to git and is printed by the CLI.
    expect(row.root).toBe(`${HOME}/projects/x`);
  });

  it("leaves a folder that is not under it alone", () => {
    const row = rowAt("/srv/api", local, () => HOME);
    expect(row.displayRoot).toBe("/srv/api");
  });

  it("uses the remote machine's home for a remote folder", () => {
    // The whole point. This Mac's home is no prefix of a NAS's, so a page doing
    // this for itself would show the full path here and think it was right.
    const row = rowAt(`${REMOTE_HOME}/api`, nas, (id) =>
      id === "nas" ? REMOTE_HOME : HOME,
    );
    expect(row.displayRoot).toBe("~/api");
  });

  it("shows the true path until the machine has answered", () => {
    // A host DevHub has not reached yet. Longer, never wrong.
    const row = rowAt(`${REMOTE_HOME}/api`, nas, () => "");
    expect(row.displayRoot).toBe(`${REMOTE_HOME}/api`);
  });
});
