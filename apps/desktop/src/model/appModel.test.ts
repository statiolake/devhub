import { describe, expect, it } from "vitest";
import { AppModel, SPLIT_DEFAULT_RATIO, wantsAttention } from "./appModel.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  DomainError,
  DomainErrorCode,
  displayPath,
  CLEAN_CLOSE_INSPECTION,
  Workspace,
  workspaceId,
  workspaceRoot,
  type AgentStatus,
  type NavigationContext,
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
    expect(snapshot.selection).toEqual({
      context: { kind: "global" },
      presentation: "full",
    });
    expect(snapshot.revision).toBe(0);
  });
});

/** The layout for a plainly selected context — the unmodified gesture. */
function full(model: AppModel, context: NavigationContext) {
  return model.resolveLayout({ context, presentation: "full" });
}

describe("layout resolution", () => {
  it("gives the Global context the folderless workbench, alone", () => {
    const model = new AppModel();
    expect(full(model, { kind: "global" })).toEqual({
      kind: "workbench",
      editor: { kind: "global-editor" },
    });
  });

  it("gives a Workspace its own workbench, alone", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    expect(full(model, { kind: "workspace", workspaceId: WS_A })).toEqual({
      kind: "workbench",
      editor: { kind: "workspace-editor", workspaceId: WS_A },
    });
  });

  it("has nothing to show for a Workspace that is not available", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    const context = { kind: "workspace", workspaceId: WS_A } as const;
    model.markWorkspaceUnavailable(WS_A, "root_missing");
    expect(full(model, context)).toEqual({ kind: "unavailable" });
    model.markWorkspaceAvailable(WS_A);
    model.beginWorkspaceClose(WS_A);
    expect(full(model, context)).toEqual({ kind: "unavailable" });
    // A close that failed leaves the Workspace open, and a workspace that is
    // open shows its workbench. There is no third state to draw.
    model.markWorkspaceCloseFailed(WS_A, "terminal", "close_terminal_unknown");
    expect(full(model, context)).toEqual({
      kind: "workbench",
      editor: { kind: "workspace-editor", workspaceId: WS_A },
    });
  });

  it("gives a plainly selected Agent the whole content area", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    expect(full(model, { kind: "agent", agentId: AG_A })).toEqual({
      kind: "agent",
      agent: { kind: "agent", agentId: AG_A },
    });
  });

  it("splits an Agent beside its own Workspace's workbench when asked", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    expect(
      model.resolveLayout({
        context: { kind: "agent", agentId: AG_A },
        presentation: "beside",
      }),
    ).toEqual({
      kind: "split",
      editor: { kind: "workspace-editor", workspaceId: WS_A },
      agent: { kind: "agent", agentId: AG_A },
    });
  });

  it("keeps the presentation out of a selection with no other half", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    // A Workspace with no Agents has nothing to be beside, and neither has
    // Scratch. Recording `beside` anyway would leave a value in the snapshot
    // that nothing honours and the next reader has to know to ignore.
    model.selectContext({ kind: "workspace", workspaceId: WS_A }, "beside");
    expect(model.snapshot().selection.presentation).toBe("full");
    model.selectContext({ kind: "global" }, "beside");
    expect(model.snapshot().selection.presentation).toBe("full");
  });

  it("splits a Workspace beside the Agent it is paired with", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.addAgent(WS_A, AG_B, codex);
    // Never been in one: the pair is the first Agent. The editor is what is
    // selected, so the editor is the half in front.
    expect(
      model.resolveLayout({
        context: { kind: "workspace", workspaceId: WS_A },
        presentation: "beside",
      }),
    ).toEqual({
      kind: "split",
      editor: { kind: "workspace-editor", workspaceId: WS_A },
      agent: { kind: "agent", agentId: AG_A },
    });
    // Once an Agent has been selected here, that is the one it pairs with.
    model.selectContext({ kind: "agent", agentId: AG_B });
    expect(
      model.resolveLayout({
        context: { kind: "workspace", workspaceId: WS_A },
        presentation: "beside",
      }),
    ).toEqual({
      kind: "split",
      editor: { kind: "workspace-editor", workspaceId: WS_A },
      agent: { kind: "agent", agentId: AG_B },
    });
  });

  it("swaps the half of a split the keyboard is in, and only inside one", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.selectContext({ kind: "agent", agentId: AG_A }, "beside");
    model.swapSplitFocus();
    expect(model.snapshot().selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
      presentation: "beside",
    });
    model.swapSplitFocus();
    expect(model.snapshot().selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      presentation: "beside",
    });
    // Outside a split there is no other pane, so nothing moves.
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.swapSplitFocus();
    expect(model.snapshot().selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      presentation: "full",
    });
  });

  it("jumps to Scratch and comes back to the whole selection it left", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    model.toggleScratch();
    expect(model.snapshot().selection).toEqual({
      context: { kind: "global" },
      presentation: "full",
    });
    model.toggleScratch();
    expect(model.snapshot().selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
      presentation: "full",
    });
  });

  it("comes back to an Agent, and to one that was side by side, as it was", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.toggleScratch();
    model.toggleScratch();
    expect(model.snapshot().selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      presentation: "full",
    });
    // The presentation is half of "where you were": an Agent left beside its
    // editor comes back beside it, not alone on top of it.
    model.selectContext({ kind: "agent", agentId: AG_A }, "beside");
    model.toggleScratch();
    model.toggleScratch();
    expect(model.snapshot().selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      presentation: "beside",
    });
  });

  it("stays on Scratch when the way back has been closed, or was never there", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    model.toggleScratch();
    model.closeWorkspace(WS_A, CLEAN_CLOSE_INSPECTION);
    model.toggleScratch();
    expect(model.snapshot().selection.context).toEqual({ kind: "global" });
    // And nothing remembered at all — a fresh model, which is also what a
    // restart is.
    const fresh = new AppModel();
    fresh.toggleScratch();
    expect(fresh.snapshot().selection).toEqual({
      context: { kind: "global" },
      presentation: "full",
    });
  });

  it("remembers where the jump out started, not the last thing selected", () => {
    const model = modelWith([WS_A, "/dev/a"], [WS_B, "/dev/b"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    model.toggleScratch();
    // Wandering by ordinary selections and ending up back on Scratch does not
    // move the way out: it is written by the jump and by nothing else, so the
    // chord still comes back to where the jump started.
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    model.selectContext({ kind: "global" });
    model.toggleScratch();
    expect(model.snapshot().selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_A,
    });
  });

  it("re-selecting the same Agent a different way moves the layout", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    const context = { kind: "agent", agentId: AG_A } as const;
    model.selectContext(context, "full");
    const before = model.snapshot().revision;
    model.selectContext(context, "beside");
    // The context did not change, so a selection compared on context alone
    // would call this a no-op and leave the Agent full screen.
    expect(model.snapshot().revision).toBeGreaterThan(before);
    expect(model.snapshot().layout.kind).toBe("split");
  });

  it("shows nothing for an Agent whose Workspace went away", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.markWorkspaceUnavailable(WS_A, "root_missing");
    expect(full(model, { kind: "agent", agentId: AG_A })).toEqual({
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
  it("is the context and how it is shown, and a new Agent takes it", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    expect(model.selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
      presentation: "full",
    });
    model.addAgent(WS_A, AG_A, codex);
    expect(model.selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      presentation: "full",
    });
    model.selectContext({ kind: "global" });
    expect(model.selection).toEqual({
      context: { kind: "global" },
      presentation: "full",
    });
  });

  it("falls to the next agent, then the workspace, when one exits", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.addAgent(WS_A, AG_B, codex);
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.agentExited(AG_A);
    expect(model.selection).toEqual({
      context: { kind: "agent", agentId: AG_B },
      presentation: "full",
    });
    model.agentExited(AG_B);
    expect(model.selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
      presentation: "full",
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

  it("shows the number only once there are two of a profile to tell apart", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    const names = () =>
      model.snapshot().workspaces[0].agents.map((agent) => agent.displayName);
    expect(names()).toEqual(["Codex"]);

    model.addAgent(WS_A, AG_B, codex);
    expect(names()).toEqual(["Codex 1", "Codex 2"]);

    // A name a person typed is theirs, and is not a second Codex the other one
    // has to be numbered against.
    model.renameAgent(AG_B, "Investigator");
    expect(names()).toEqual(["Codex", "Investigator"]);
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
    expect(model.selection).toEqual({
      context: { kind: "global" },
      presentation: "full",
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

describe("wantsAttention", () => {
  /**
   * The whole rule, in a table: leaving `working` is the only thing that owes
   * the person a look. Every other pair is something nobody was waiting for.
   */
  const statuses: AgentStatus[] = [
    "working",
    "waiting",
    "idle",
    "error",
    "unknown",
  ];

  it("is exactly 'it stopped working'", () => {
    for (const previous of statuses) {
      for (const next of statuses) {
        expect(wantsAttention(previous, next)).toBe(
          previous === "working" && next !== "working",
        );
      }
    }
  });

  it("says nothing about a screen nobody had read, or a status standing still", () => {
    for (const next of statuses) {
      expect(wantsAttention("unknown", next)).toBe(false);
    }
    for (const status of statuses) {
      expect(wantsAttention(status, status)).toBe(false);
    }
    // The finish is the case this rule exists for.
    expect(wantsAttention("working", "idle")).toBe(true);
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

  /** Take it through `working` first: that is what makes leaving it mean something. */
  function ranAndThen(model: AppModel, status: AgentStatus) {
    model.setAgentStatus(AG_A, "working");
    model.setAgentStatus(AG_A, status);
  }

  it("becomes unread whenever it stops working, and says which way", () => {
    for (const status of ["idle", "waiting", "error", "unknown"] as const) {
      const model = withAgent();
      ranAndThen(model, status);
      expect(model.agent(AG_A)?.unread).toBe(status);
    }
  });

  it("stays read when it stops working in front of you", () => {
    const model = withAgent();
    model.selectContext({ kind: "agent", agentId: AG_A });
    ranAndThen(model, "idle");
    expect(model.agent(AG_A)?.unread).toBeUndefined();
  });

  it("counts the side-by-side pane as looking at it", () => {
    const model = withAgent();
    model.selectContext({ kind: "agent", agentId: AG_A }, "beside");
    ranAndThen(model, "waiting");
    expect(model.agent(AG_A)?.unread).toBeUndefined();
  });

  it("reads an Agent mounted in the side pane", () => {
    const model = withAgent();
    ranAndThen(model, "idle");
    model.selectContext({ kind: "agent", agentId: AG_A }, "beside");
    expect(model.agent(AG_A)?.unread).toBeUndefined();
  });

  it("does not raise a mark for anything that did not stop working", () => {
    const model = withAgent();
    // The first reading of a screen nobody had read.
    model.setAgentStatus(AG_A, "waiting");
    expect(model.agent(AG_A)?.unread).toBeUndefined();
    // An Agent that never went away asking again.
    model.setAgentStatus(AG_A, "idle");
    model.setAgentStatus(AG_A, "waiting");
    expect(model.agent(AG_A)?.unread).toBeUndefined();
  });

  it("keeps the mark while the Agent moves on, and clears it only by opening it", () => {
    const model = withAgent();
    ranAndThen(model, "waiting");
    // It asked, nobody came, it timed out and went idle. The row still owes an
    // answer, and still owes it for the reason it was first owed.
    model.setAgentStatus(AG_A, "idle");
    expect(model.agent(AG_A)?.unread).toBe("waiting");
    model.selectContext({ kind: "agent", agentId: AG_A });
    expect(model.agent(AG_A)?.unread).toBeUndefined();
  });

  it("can be put back by hand, and re-read by clicking the same row", () => {
    const model = withAgent();
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.setAgentStatus(AG_A, "working");
    model.markAgentUnread(AG_A);
    // By hand, the reason is whatever it is doing now: that is what you are
    // asking to be reminded of.
    expect(model.agent(AG_A)?.unread).toBe("working");
    const before = model.snapshot().revision;
    // Already selected: re-selecting still reads it, and still counts as a
    // change, or the sidebar would keep drawing the dot.
    model.selectContext({ kind: "agent", agentId: AG_A });
    expect(model.agent(AG_A)?.unread).toBeUndefined();
    expect(model.snapshot().revision).toBeGreaterThan(before);
  });
});

describe("looking at an Agent, and the window that is not in front", () => {
  function selectedAgent() {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    model.selectContext({ kind: "agent", agentId: AG_A });
    return model;
  }

  it("is nobody looking at anything while DevHub is behind another window", () => {
    const model = selectedAgent();
    model.setWindowFocused(false);
    expect(model.isAgentVisible(AG_A)).toBe(false);
    // The case the whole rule is for: it finished while you were elsewhere.
    model.setAgentStatus(AG_A, "working");
    model.setAgentStatus(AG_A, "idle");
    expect(model.agent(AG_A)?.unread).toBe("idle");
  });

  it("reads what is on screen when the window comes back", () => {
    const model = selectedAgent();
    model.setWindowFocused(false);
    model.setAgentStatus(AG_A, "working");
    model.setAgentStatus(AG_A, "idle");
    const before = model.snapshot().revision;
    model.setWindowFocused(true);
    expect(model.agent(AG_A)?.unread).toBeUndefined();
    expect(model.snapshot().revision).toBeGreaterThan(before);
  });

  it("reads nothing when the window comes back to something that is not an Agent", () => {
    const model = selectedAgent();
    model.setWindowFocused(false);
    model.setAgentStatus(AG_A, "working");
    model.setAgentStatus(AG_A, "error");
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    model.setWindowFocused(true);
    expect(model.agent(AG_A)?.unread).toBe("error");
  });

  it("does not read an Agent selected while the window is away", () => {
    const model = selectedAgent();
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    model.setWindowFocused(false);
    model.setAgentStatus(AG_A, "working");
    model.setAgentStatus(AG_A, "idle");
    model.selectContext({ kind: "agent", agentId: AG_A });
    expect(model.agent(AG_A)?.unread).toBe("idle");
    model.setWindowFocused(true);
    expect(model.agent(AG_A)?.unread).toBeUndefined();
  });
});

/**
 * A failure about one Agent, and how long it is shown for.
 *
 * The rule is the App Shell's one lifetime rule applied to a failure that has
 * a subject: it is retired by the event that makes it untrue, and by nothing
 * else. For an Agent that event is the next reconcile that actually read it.
 * There is no dismiss and no timer, because a failure a person could put away
 * while the condition held would be a failure they could hide from themselves.
 */
describe("a refusal about one Agent", () => {
  function withFailingAgent() {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex);
    return model;
  }

  function failureOf(model: AppModel) {
    return model
      .snapshot()
      .workspaces.flatMap((workspace) => workspace.agents)
      .find((agent) => agent.id === AG_A)?.failure;
  }

  it("is carried by the Agent it is about", () => {
    const model = withFailingAgent();
    model.markAgentFailed(AG_A, {
      code: "tmux_session_conflict",
      detail: "A session of that name is already there.",
    });
    expect(failureOf(model)).toEqual({
      code: "tmux_session_conflict",
      detail: "A session of that name is already there.",
    });
  });

  it("goes when the next reconcile reads the Agent, with nothing to dismiss", () => {
    const model = withFailingAgent();
    model.markAgentFailed(AG_A, { code: "agent_runtime_unavailable" });
    expect(failureOf(model)).toBeDefined();
    model.setAgentStatus(AG_A, "working");
    expect(failureOf(model)).toBeUndefined();
  });

  it("stays until then, however many times it is raised again", () => {
    // The hard case the App Shell's own lifetime test pins: a condition that
    // keeps failing must not flicker, and must not stop being shown.
    const model = withFailingAgent();
    model.markAgentFailed(AG_A, { code: "agent_runtime_unavailable" });
    const before = model.snapshot().revision;
    model.markAgentFailed(AG_A, { code: "agent_runtime_unavailable" });
    // The same refusal raised again is not news, so nothing is republished —
    // which is what stops a condition failing every few seconds from
    // redrawing the pane over and over.
    expect(model.snapshot().revision).toBe(before);
    expect(failureOf(model)).toEqual({ code: "agent_runtime_unavailable" });
  });

  it("is replaced by a different refusal about the same Agent", () => {
    const model = withFailingAgent();
    model.markAgentFailed(AG_A, { code: "agent_runtime_unavailable" });
    model.markAgentFailed(AG_A, { code: "tmux_command_timed_out" });
    expect(failureOf(model)).toEqual({ code: "tmux_command_timed_out" });
  });
});
