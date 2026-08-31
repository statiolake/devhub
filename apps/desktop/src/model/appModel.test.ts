import { describe, expect, it } from "vitest";
import { AppModel, SPLIT_DEFAULT_RATIO } from "./appModel.js";
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

const codex = AgentProfile.create(
  agentProfileId("codex"),
  "Codex",
  "codex",
  "codex",
);

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
  it("starts on the Global context with no workspaces", () => {
    const snapshot = new AppModel().snapshot();
    expect(snapshot.workspaces).toHaveLength(0);
    expect(snapshot.selection).toEqual({ context: { kind: "global" } });
    expect(snapshot.revision).toBe(0);
  });
});

describe("layout resolution", () => {
  it("gives the Global context the folderless workbench, alone", () => {
    const model = new AppModel();
    expect(model.resolveLayout({ kind: "global" })).toEqual({
      kind: "workbench",
      editor: { kind: "global-editor" },
    });
  });

  it("gives a Workspace its own workbench, alone", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    expect(
      model.resolveLayout({ kind: "workspace", workspaceId: WS_A }),
    ).toEqual({
      kind: "workbench",
      editor: { kind: "workspace-editor", workspaceId: WS_A },
    });
  });

  it("has nothing to show for a Workspace that is not available", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    const context = { kind: "workspace", workspaceId: WS_A } as const;
    model.markWorkspaceUnavailable(WS_A, "root_missing");
    expect(model.resolveLayout(context)).toEqual({ kind: "unavailable" });
    model.markWorkspaceAvailable(WS_A);
    model.markWorkspaceClosing(WS_A, cleanupProgress(0, false, false));
    expect(model.resolveLayout(context)).toEqual({ kind: "unavailable" });
    model.markWorkspaceClosingFailed(
      WS_A,
      "cleanup_failed",
      cleanupProgress(0, false, false),
    );
    expect(model.resolveLayout(context)).toEqual({ kind: "unavailable" });
  });

  it("splits an Agent beside its own Workspace's workbench", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    expect(model.resolveLayout({ kind: "agent", agentId: AG_A })).toEqual({
      kind: "split",
      editor: { kind: "workspace-editor", workspaceId: WS_A },
      agent: { kind: "agent", agentId: AG_A },
    });
  });

  it("shows nothing for an Agent whose Workspace went away", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.markWorkspaceUnavailable(WS_A, "root_missing");
    expect(model.resolveLayout({ kind: "agent", agentId: AG_A })).toEqual({
      kind: "unavailable",
    });
  });
});

describe("the split", () => {
  it("starts where a person would put it and remembers where they moved it", () => {
    const model = new AppModel();
    expect(model.snapshot().splitRatio).toBe(SPLIT_DEFAULT_RATIO);
    expect(model.setSplitRatio(0.7)).toBe(true);
    expect(model.snapshot().splitRatio).toBe(0.7);
    expect(model.setSplitRatio(0.7)).toBe(false);
  });

  it("refuses a ratio that would leave a pane with nothing in it", () => {
    const model = new AppModel();
    expect(codeOf(() => model.setSplitRatio(0.1))).toBe(
      DomainErrorCode.InvalidSplitRatio,
    );
    expect(codeOf(() => model.setSplitRatio(0.99))).toBe(
      DomainErrorCode.InvalidSplitRatio,
    );
  });
});

describe("selection", () => {
  it("is the context and nothing else, and a new Agent takes it", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    expect(model.selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
    });
    model.addAgent(WS_A, AG_A, codex);
    expect(model.selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
    });
    model.selectContext({ kind: "global" });
    expect(model.selection).toEqual({ context: { kind: "global" } });
  });

  it("falls to the next agent, then the workspace, when one exits", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.addAgent(WS_A, AG_B, codex);
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.agentExited(AG_A);
    expect(model.selection).toEqual({
      context: { kind: "agent", agentId: AG_B },
    });
    model.agentExited(AG_B);
    expect(model.selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
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

  it("keeps a workspace's agents in the projection, always", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    expect(model.snapshot().workspaces[0].agents.map((a) => a.id)).toEqual([
      AG_A,
    ]);
    model.agentExited(AG_A);
    expect(model.snapshot().workspaces[0].agents).toEqual([]);
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
    expect(model.selection).toEqual({ context: { kind: "global" } });
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

describe("unread agents", () => {
  /**
   * A launched Agent, with the person looking somewhere else.
   *
   * Launching one selects it — you asked for it, you are looking at it — so
   * every case below has to navigate away first to be about an Agent nobody is
   * watching, which is the only case unread is about.
   */
  function withAgent() {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    return model;
  }

  it("becomes unread on entering waiting, but not while it is on screen", () => {
    const model = withAgent();
    // Nobody is looking: the question is one to come back to.
    model.setAgentStatus(AG_A, "waiting");
    expect(model.agent(AG_A)?.unread).toBe(true);

    // Opening it is reading it.
    model.selectContext({ kind: "agent", agentId: AG_A });
    expect(model.agent(AG_A)?.unread).toBe(false);

    // Asking again while you are looking at it is not something to come back
    // to — you are already there.
    model.setAgentStatus(AG_A, "working");
    model.setAgentStatus(AG_A, "waiting");
    expect(model.agent(AG_A)?.unread).toBe(false);
  });

  it("survives the Agent moving on, and is only cleared by opening it", () => {
    const model = withAgent();
    model.setAgentStatus(AG_A, "waiting");
    // It asked, nobody came, it timed out and went idle. The row still owes an
    // answer, which is the case a single status mark would lose.
    model.setAgentStatus(AG_A, "idle");
    expect(model.agent(AG_A)?.unread).toBe(true);
    model.selectContext({ kind: "agent", agentId: AG_A });
    expect(model.agent(AG_A)?.unread).toBe(false);
  });

  it("can be put back by hand, and re-read by clicking the same row", () => {
    const model = withAgent();
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.markAgentUnread(AG_A);
    expect(model.agent(AG_A)?.unread).toBe(true);
    const before = model.snapshot().revision;
    // Already selected: re-selecting still reads it, and still counts as a
    // change, or the sidebar would keep drawing the dot.
    model.selectContext({ kind: "agent", agentId: AG_A });
    expect(model.agent(AG_A)?.unread).toBe(false);
    expect(model.snapshot().revision).toBeGreaterThan(before);
  });
});
