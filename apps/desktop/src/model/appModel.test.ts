import { describe, expect, it } from "vitest";
import { AppModel } from "./appModel.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  DomainError,
  DomainErrorCode,
  displayPath,
  CLEAN_CLOSE_INSPECTION,
  cleanupProgress,
  Workspace,
  workspaceId,
  workspaceRoot,
} from "./domain.js";

const WS_A = workspaceId("550e8400-e29b-41d4-a716-446655440000");
const WS_B = workspaceId("550e8400-e29b-41d4-a716-446655440001");
const AG_A = agentId("550e8400-e29b-41d4-a716-4466554400a0");
const AG_B = agentId("550e8400-e29b-41d4-a716-4466554400a1");

const codex = AgentProfile.create(agentProfileId("codex"), "Codex", "codex");

function codeOf(run: () => unknown): DomainErrorCode | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? error.code : undefined;
  }
  return undefined;
}

function modelWith(...roots: [ReturnType<typeof workspaceId>, string][]) {
  const model = new AppModel();
  for (const [id, path] of roots) {
    model.addWorkspace(
      new Workspace(id, workspaceRoot(path), displayPath(path)),
    );
  }
  return model;
}

describe("startup", () => {
  it("starts on the Global context's terminal with no workspaces", () => {
    const snapshot = new AppModel().snapshot();
    expect(snapshot.workspaces).toHaveLength(0);
    expect(snapshot.selection).toEqual({
      context: { kind: "global" },
      activity: "terminal",
    });
    expect(snapshot.revision).toBe(0);
  });
});

describe("activity resolution", () => {
  it("offers Editor and Terminal in the Global context and never Agent", () => {
    const model = new AppModel();
    expect(model.resolveSurface({ kind: "global" }, "editor")).toEqual({
      kind: "enabled",
      surfaceKey: { kind: "global-editor" },
    });
    expect(model.resolveSurface({ kind: "global" }, "terminal")).toEqual({
      kind: "enabled",
      surfaceKey: { kind: "global-terminal" },
    });
    expect(model.resolveSurface({ kind: "global" }, "agent")).toEqual({
      kind: "disabled",
      reason: "global-agent-not-applicable",
    });
  });

  it("asks for an Agent selection in a Workspace, whatever its state", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    const context = { kind: "workspace", workspaceId: WS_A } as const;
    expect(model.resolveSurface(context, "agent")).toEqual({
      kind: "disabled",
      reason: "workspace-agent-requires-agent-selection",
    });
    model.markWorkspaceUnavailable(WS_A, "root_missing");
    expect(model.resolveSurface(context, "agent")).toEqual({
      kind: "disabled",
      reason: "workspace-agent-requires-agent-selection",
    });
    expect(model.resolveSurface(context, "editor")).toEqual({
      kind: "disabled",
      reason: "workspace-unavailable",
    });
  });

  it("distinguishes closing from closing-failed", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    const context = { kind: "workspace", workspaceId: WS_A } as const;
    model.markWorkspaceClosing(WS_A, cleanupProgress(0, false, false));
    expect(model.resolveSurface(context, "editor")).toEqual({
      kind: "disabled",
      reason: "workspace-closing",
    });
    model.markWorkspaceClosingFailed(
      WS_A,
      "cleanup_failed",
      cleanupProgress(0, false, false),
    );
    expect(model.resolveSurface(context, "terminal")).toEqual({
      kind: "disabled",
      reason: "workspace-closing-failed",
    });
  });

  it("keeps an Agent context's own surface enabled and borrows its workspace", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    const context = { kind: "agent", agentId: AG_A } as const;
    expect(model.resolveSurface(context, "agent")).toEqual({
      kind: "enabled",
      surfaceKey: { kind: "agent", agentId: AG_A },
    });
    expect(model.resolveSurface(context, "terminal")).toEqual({
      kind: "enabled",
      surfaceKey: { kind: "workspace-terminal", workspaceId: WS_A },
    });
  });

  it("refuses to select a disabled activity", () => {
    const model = new AppModel();
    expect(
      codeOf(() => {
        model.selectActivity("agent");
      }),
    ).toBe(DomainErrorCode.ActivityDisabled);
  });
});

describe("selection", () => {
  it("lands each context on its own default activity", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    expect(model.selection.activity).toBe("editor");
    model.addAgent(WS_A, AG_A, codex);
    expect(model.selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      activity: "agent",
    });
    model.selectContext({ kind: "global" });
    expect(model.selection.activity).toBe("terminal");
  });

  it("falls to the next agent, then the workspace, when one exits", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.addAgent(WS_A, AG_B, codex);
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.agentExited(AG_A);
    expect(model.selection).toEqual({
      context: { kind: "agent", agentId: AG_B },
      activity: "agent",
    });
    model.agentExited(AG_B);
    expect(model.selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
      activity: "editor",
    });
  });
});

describe("ordinals", () => {
  it("numbers agents per workspace and profile", () => {
    const model = modelWith([WS_A, "/dev/a"], [WS_B, "/dev/b"]);
    model.addAgent(WS_A, AG_A, codex);
    model.addAgent(WS_B, AG_B, codex);
    expect(model.agent(AG_A)?.displayName).toBe("Codex 1");
    expect(model.agent(AG_B)?.displayName).toBe("Codex 1");
  });
});

describe("labels", () => {
  it("uses the basename until two workspaces collide", () => {
    const model = modelWith([WS_A, "/dev/alpha/app"], [WS_B, "/dev/beta/app"]);
    const labels = model
      .snapshot()
      .workspaces.map((workspace) => workspace.label);
    expect(labels).toEqual(["app — alpha", "app — beta"]);
  });

  it("leaves a unique basename alone", () => {
    const model = modelWith([WS_A, "/dev/alpha"], [WS_B, "/dev/beta"]);
    expect(model.snapshot().workspaces.map((w) => w.label)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

describe("aggregate status", () => {
  it("reports the most urgent agent status", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.addAgent(WS_A, AG_B, codex);
    expect(model.snapshot().workspaces[0].aggregateStatus).toBe("idle");
    model.setAgentStatus(AG_A, "working");
    expect(model.snapshot().workspaces[0].aggregateStatus).toBe("working");
    model.setAgentStatus(AG_B, "waiting");
    expect(model.snapshot().workspaces[0].aggregateStatus).toBe("waiting");
    model.setAgentStatus(AG_A, "error");
    expect(model.snapshot().workspaces[0].aggregateStatus).toBe("error");
  });
});

describe("revisions", () => {
  it("bumps only when something actually changed", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    const before = model.snapshot().revision;
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    const after = model.snapshot().revision;
    expect(after).toBeGreaterThan(before);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    expect(model.snapshot().revision).toBe(after);
  });
});

describe("sidebar", () => {
  it("clamps the width to the supported range", () => {
    const model = new AppModel();
    expect(codeOf(() => model.setSidebarWidth(100))).toBe(
      DomainErrorCode.InvalidSidebarWidth,
    );
    expect(model.setSidebarWidth(300)).toBe(true);
    expect(model.snapshot().sidebar.width).toBe(300);
  });

  it("only expands a workspace that has agents", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    expect(model.setWorkspaceDisclosure(WS_A, true)).toBe(false);
    model.addAgent(WS_A, AG_A, codex);
    expect(model.setWorkspaceDisclosure(WS_A, true)).toBe(true);
    expect(model.snapshot().sidebar.expandedWorkspaceIds).toEqual([WS_A]);
    model.agentExited(AG_A);
    expect(model.snapshot().sidebar.expandedWorkspaceIds).toEqual([]);
  });
});

describe("closing", () => {
  it("refuses a workspace that still has agents", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    expect(
      codeOf(() => {
        model.closeWorkspace(WS_A, CLEAN_CLOSE_INSPECTION);
      }),
    ).toBe(DomainErrorCode.WorkspaceHasLiveAgents);
  });

  it("moves the selection to the next workspace, then to Global", () => {
    const model = modelWith([WS_A, "/dev/a"], [WS_B, "/dev/b"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    model.closeWorkspace(WS_A, CLEAN_CLOSE_INSPECTION);
    expect(model.selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_B,
    });
    model.closeWorkspace(WS_B, CLEAN_CLOSE_INSPECTION);
    expect(model.selection).toEqual({
      context: { kind: "global" },
      activity: "terminal",
    });
  });

  it("puts a rolled-back close back where it was", () => {
    const model = modelWith([WS_A, "/dev/a"], [WS_B, "/dev/b"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    const rollback = model.closeWorkspaceForPersistence(
      WS_A,
      CLEAN_CLOSE_INSPECTION,
    );
    expect(model.workspaces).toHaveLength(1);
    model.rollbackWorkspaceClose(rollback);
    expect(model.workspaces.map((workspace) => workspace.id)).toEqual([
      WS_A,
      WS_B,
    ]);
    expect(model.selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_A,
    });
  });
});

describe("relocation", () => {
  it("only relocates an unavailable workspace, and keeps its identity", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    expect(
      codeOf(() => {
        model.relocateWorkspace(
          WS_A,
          workspaceRoot("/dev/moved"),
          displayPath("/dev/moved"),
        );
      }),
    ).toBe(DomainErrorCode.WorkspaceNotUnavailable);
    model.markWorkspaceUnavailable(WS_A, "root_missing");
    model.relocateWorkspace(
      WS_A,
      workspaceRoot("/dev/moved"),
      displayPath("/dev/moved"),
    );
    expect(model.workspace(WS_A)?.root).toBe("/dev/moved");
    expect(model.workspace(WS_A)?.state.kind).toBe("available");
  });
});

describe("duplicates", () => {
  it("refuses a second workspace on the same canonical root", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    expect(
      codeOf(() => {
        model.addWorkspace(
          new Workspace(WS_B, workspaceRoot("/dev/a"), displayPath("/dev/a")),
        );
      }),
    ).toBe(DomainErrorCode.DuplicateWorkspaceRoot);
  });
});
