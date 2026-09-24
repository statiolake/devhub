import { describe, expect, it } from "vitest";
import { AppModel, SPLIT_DEFAULT_RATIO, wantsAttention } from "./appModel.js";
import {
  drawn,
  localWorkspace,
  SCRATCH_PATH,
  scratchModel,
} from "./testWorkspaces.js";
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
  workspaceLocation,
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

/** Scratch, as a context: the model's own daily-folder Workspace. */
function scratchOf(model: AppModel): NavigationContext {
  return { kind: "workspace", workspaceId: model.scratchWorkspaceId };
}

function modelWith(...roots: [ReturnType<typeof workspaceId>, string][]) {
  const model = scratchModel();
  for (const [id, path] of roots) {
    model.addWorkspace(
      new Workspace(
        id,
        workspaceLocation({ kind: "local", path }),
        displayPath(path),
      ),
    );
  }
  return model;
}

describe("startup", () => {
  it("starts on Scratch, which is its only workspace and is called Scratch", () => {
    const model = scratchModel();
    const snapshot = model.snapshot();
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.scratchWorkspaceId).toBe(model.scratchWorkspaceId);
    expect(snapshot.workspaces[0]).toMatchObject({
      id: model.scratchWorkspaceId,
      label: "Scratch",
      root: SCRATCH_PATH,
    });
    expect(snapshot.selection).toEqual({
      context: scratchOf(model),
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
  it("gives Scratch its own workbench, like any Workspace", () => {
    const model = scratchModel();
    expect(full(model, scratchOf(model))).toEqual({
      kind: "workbench",
      editor: {
        kind: "workspace-editor",
        workspaceId: model.scratchWorkspaceId,
      },
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
    model.addAgent(WS_A, AG_A, codex, "tui");
    expect(full(model, { kind: "agent", agentId: AG_A })).toEqual({
      kind: "agent",
      agent: { kind: "agent", agentId: AG_A },
    });
  });

  it("splits an Agent beside its own Workspace's workbench when asked", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
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
    // A Workspace with no Agents has nothing to be beside, and Scratch with
    // none is no different. Recording `beside` anyway would leave a value in the snapshot
    // that nothing honours and the next reader has to know to ignore.
    model.selectContext({ kind: "workspace", workspaceId: WS_A }, "beside");
    expect(model.snapshot().selection.presentation).toBe("full");
    model.selectContext(scratchOf(model), "beside");
    expect(model.snapshot().selection.presentation).toBe("full");
  });

  it("splits a Workspace beside the Agent it is paired with", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
    model.addAgent(WS_A, AG_B, codex, "tui");
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
    model.addAgent(WS_A, AG_A, codex, "tui");
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
    model.addAgent(WS_A, AG_A, codex, "tui");
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    model.toggleScratch();
    expect(model.snapshot().selection).toEqual({
      context: scratchOf(model),
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
    model.addAgent(WS_A, AG_A, codex, "tui");
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
    model.closeWorkspace(WS_A, CLEAN_CLOSE_INSPECTION, drawn(model));
    model.toggleScratch();
    expect(model.snapshot().selection.context).toEqual(scratchOf(model));
    // And nothing remembered at all — a fresh model, which is also what a
    // restart is.
    const fresh = scratchModel();
    fresh.toggleScratch();
    expect(fresh.snapshot().selection).toEqual({
      context: scratchOf(fresh),
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
    model.selectContext(scratchOf(model));
    model.toggleScratch();
    expect(model.snapshot().selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_A,
    });
  });

  it("re-selecting the same Agent a different way moves the layout", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
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
    model.addAgent(WS_A, AG_A, codex, "tui");
    model.markWorkspaceUnavailable(WS_A, "root_missing");
    expect(full(model, { kind: "agent", agentId: AG_A })).toEqual({
      kind: "unavailable",
    });
  });
});

describe("the split", () => {
  it("starts where a person would put it and remembers where they moved it", () => {
    const model = scratchModel();
    expect(model.snapshot().splitRatio).toBe(SPLIT_DEFAULT_RATIO);
    expect(model.setSplitRatio(0.7)).toBe(true);
    expect(model.snapshot().splitRatio).toBe(0.7);
    expect(model.setSplitRatio(0.7)).toBe(false);
  });

  it("refuses a ratio that would leave a pane with nothing in it", () => {
    const model = scratchModel();
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
    model.addAgent(WS_A, AG_A, codex, "tui");
    expect(model.selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      presentation: "full",
    });
    model.selectContext(scratchOf(model));
    expect(model.selection).toEqual({
      context: scratchOf(model),
      presentation: "full",
    });
  });

  it("falls to the next agent, then the workspace, when one exits", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
    model.addAgent(WS_A, AG_B, codex, "tui");
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.agentExited(AG_A, drawn(model));
    expect(model.selection).toEqual({
      context: { kind: "agent", agentId: AG_B },
      presentation: "full",
    });
    model.agentExited(AG_B, drawn(model));
    expect(model.selection).toEqual({
      context: { kind: "workspace", workspaceId: WS_A },
      presentation: "full",
    });
  });

  it("refuses a drawn order that does not name the open workspaces", () => {
    // A caller reading a list that no longer exists would land the selection
    // on a row nobody sees; it fails where it is read instead, and nothing
    // is removed.
    const model = modelWith([WS_A, "/dev/a"], [WS_B, "/dev/b"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
    const stale = drawn(model).filter((id) => id !== WS_B);
    expect(() => {
      model.agentExited(AG_A, stale);
    }).toThrow(/does not name the open workspaces/);
    expect(() => {
      model.closeWorkspace(WS_B, CLEAN_CLOSE_INSPECTION, [
        ...drawn(model),
        WS_A,
      ]);
    }).toThrow(/does not name the open workspaces/);
    expect(model.agent(AG_A)).toBeDefined();
    expect(model.workspace(WS_B)).toBeDefined();
  });
});

describe("ordinals", () => {
  it("numbers agents per workspace and profile", () => {
    const model = modelWith([WS_A, "/dev/a"], [WS_B, "/dev/b"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
    model.addAgent(WS_B, AG_B, codex, "tui");
    expect(model.agent(AG_A)?.displayName).toBe("Codex 1");
    expect(model.agent(AG_B)?.displayName).toBe("Codex 1");
  });

  it("shows the number only once there are two of a profile to tell apart", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
    const names = () =>
      model.snapshot().workspaces[1].agents.map((agent) => agent.displayName);
    expect(names()).toEqual(["Codex"]);

    model.addAgent(WS_A, AG_B, codex, "tui");
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
    expect(labels).toEqual(["Scratch", "app — alpha", "app — beta"]);
  });

  it("leaves a unique basename alone", () => {
    const model = modelWith([WS_A, "/dev/alpha"], [WS_B, "/dev/beta"]);
    expect(model.snapshot().workspaces.map((w) => w.label)).toEqual([
      "Scratch",
      "alpha",
      "beta",
    ]);
  });

  it("does not count Scratch's folder name as a collision", () => {
    // Scratch is `.../junk/20260923` and is called Scratch; a row that
    // happens to share the basename has nothing to be told apart from.
    const model = modelWith([WS_A, "/elsewhere/20260923"]);
    expect(model.snapshot().workspaces.map((w) => w.label)).toEqual([
      "Scratch",
      "20260923",
    ]);
  });
});

describe("Scratch, today's daily folder", () => {
  const TOMORROW = "/scratch-test/junk/20260924";

  it("moves to the new day's folder and leaves yesterday's as an ordinary row", () => {
    const model = scratchModel();
    const yesterday = model.scratchWorkspaceId;
    model.addAgent(yesterday, AG_A, codex, "tui");
    const day = localWorkspace(TOMORROW);
    expect(model.adoptScratchDay(day)).toBe(true);
    const snapshot = model.snapshot();
    expect(snapshot.scratchWorkspaceId).toBe(day.id);
    const old = snapshot.workspaces.find((w) => w.id === yesterday);
    // Untouched: the same Workspace, its Agent still there and still
    // selected, and now named by its folder like any other row.
    expect(old?.label).toBe("20260923");
    expect(old?.agents.map((agent) => agent.id)).toEqual([AG_A]);
    expect(snapshot.selection.context).toEqual({
      kind: "agent",
      agentId: AG_A,
    });
    expect(snapshot.workspaces.find((w) => w.id === day.id)?.label).toBe(
      "Scratch",
    );
  });

  it("adopts an already-open Workspace for the day's folder instead of a second one", () => {
    const model = modelWith([WS_A, TOMORROW]);
    expect(model.adoptScratchDay(localWorkspace(TOMORROW))).toBe(true);
    expect(model.scratchWorkspaceId).toBe(WS_A);
    expect(model.workspaces).toHaveLength(2);
  });

  it("is a no-op when the day has not changed", () => {
    const model = scratchModel();
    const before = model.snapshot().revision;
    expect(model.adoptScratchDay(localWorkspace(SCRATCH_PATH))).toBe(false);
    expect(model.snapshot().revision).toBe(before);
    expect(model.workspaces).toHaveLength(1);
  });

  it("refuses to close today's Scratch, and closes yesterday's like any row", () => {
    const model = scratchModel();
    const yesterday = model.scratchWorkspaceId;
    expect(
      codeOf(() => {
        model.closeWorkspace(yesterday, CLEAN_CLOSE_INSPECTION, drawn(model));
      }),
    ).toBe(DomainErrorCode.ScratchCannotClose);
    model.adoptScratchDay(localWorkspace(TOMORROW));
    model.closeWorkspace(yesterday, CLEAN_CLOSE_INSPECTION, drawn(model));
    expect(model.workspace(yesterday)).toBeUndefined();
  });

  it("lets Agents be created in Scratch", () => {
    const model = scratchModel();
    model.addAgent(model.scratchWorkspaceId, AG_A, codex, "tui");
    expect(model.snapshot().workspaces[0].agents.map((a) => a.id)).toEqual([
      AG_A,
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
    const model = scratchModel();
    expect(codeOf(() => model.setSidebarWidth(100))).toBe(
      DomainErrorCode.InvalidSidebarWidth,
    );
    expect(model.setSidebarWidth(300)).toBe(true);
    expect(model.snapshot().sidebar.width).toBe(300);
  });

  it("keeps a workspace's agents in the projection, always", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
    expect(model.snapshot().workspaces[1].agents.map((a) => a.id)).toEqual([
      AG_A,
    ]);
    model.agentExited(AG_A, drawn(model));
    expect(model.snapshot().workspaces[1].agents).toEqual([]);
  });
});

describe("closing", () => {
  it("refuses a workspace that still has agents", () => {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex, "tui");
    expect(
      codeOf(() => {
        model.closeWorkspace(WS_A, CLEAN_CLOSE_INSPECTION, drawn(model));
      }),
    ).toBe(DomainErrorCode.WorkspaceHasLiveAgents);
  });

  it("moves the selection to the next workspace, then to Scratch", () => {
    const model = modelWith([WS_A, "/dev/a"], [WS_B, "/dev/b"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    model.closeWorkspace(WS_A, CLEAN_CLOSE_INSPECTION, drawn(model));
    expect(model.selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_B,
    });
    model.closeWorkspace(WS_B, CLEAN_CLOSE_INSPECTION, drawn(model));
    expect(model.selection).toEqual({
      context: scratchOf(model),
      presentation: "full",
    });
  });

  it("puts a rolled-back close back where it was", () => {
    const model = modelWith([WS_A, "/dev/a"], [WS_B, "/dev/b"]);
    model.selectContext({ kind: "workspace", workspaceId: WS_A });
    const rollback = model.closeWorkspaceForPersistence(
      WS_A,
      CLEAN_CLOSE_INSPECTION,
      drawn(model),
    );
    expect(model.workspaces).toHaveLength(2);
    model.rollbackWorkspaceClose(rollback);
    expect(model.workspaces.map((workspace) => workspace.id)).toEqual([
      model.scratchWorkspaceId,
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
          workspaceLocation({ kind: "local", path: "/dev/moved" }),
          displayPath("/dev/moved"),
        );
      }),
    ).toBe(DomainErrorCode.WorkspaceNotUnavailable);
    model.markWorkspaceUnavailable(WS_A, "root_missing");
    model.relocateWorkspace(
      WS_A,
      workspaceLocation({ kind: "local", path: "/dev/moved" }),
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
          new Workspace(
            WS_B,
            workspaceLocation({ kind: "local", path: "/dev/a" }),
            displayPath("/dev/a"),
          ),
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
    model.addAgent(WS_A, AG_A, codex, "tui");
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
    model.addAgent(WS_A, AG_A, codex, "tui");
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
    model.addAgent(WS_A, AG_A, codex, "tui");
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

/**
 * A failure that is itself a reading: a GUI Agent's conversation that cannot
 * be followed, or that broke. It holds for as many rounds as the round keeps
 * finding it, so it is carried on the reading — and retired by the same rule
 * as a refusal, the next reading, because that is the reading that no longer
 * says it.
 */
describe("a failure a reading carries", () => {
  const lost = {
    code: "conversation_host_lost",
    detail: "the journal stopped",
  } as const;

  function reading(failure: typeof lost | undefined) {
    return {
      observations: [
        {
          agentId: AG_A,
          status: "unknown" as const,
          runtimeHealth: "healthy" as const,
          activity: undefined,
          injection: {
            queued: 0,
            waitingFor: "nothing_queued" as const,
            lastResult: undefined,
          },
          failure,
        },
      ],
      exited: [],
    };
  }

  function model() {
    const model = modelWith([WS_A, "/dev/a"]);
    model.addAgent(WS_A, AG_A, codex, "gui");
    return model;
  }

  function failureOf(model: AppModel) {
    return model
      .snapshot()
      .workspaces.flatMap((workspace) => workspace.agents)
      .find((agent) => agent.id === AG_A)?.failure;
  }

  it("is shown on the Agent while the rounds keep reading it, without being republished", () => {
    const shown = model();
    shown.reconcileAgents(reading(lost), [WS_A]);
    expect(failureOf(shown)).toEqual(lost);
    const before = shown.snapshot().revision;
    shown.reconcileAgents(reading(lost), [WS_A]);
    expect(shown.snapshot().revision).toBe(before);
    expect(failureOf(shown)).toEqual(lost);
  });

  it("goes with the first reading that does not carry it", () => {
    const shown = model();
    shown.reconcileAgents(reading(lost), [WS_A]);
    shown.reconcileAgents(reading(undefined), [WS_A]);
    expect(failureOf(shown)).toBeUndefined();
  });
});

describe("arranging the rows", () => {
  function withTwoAgents(): AppModel {
    const model = scratchModel();
    model.addWorkspace(
      new Workspace(
        WS_A,
        workspaceLocation({ kind: "local", path: "/srv/api" }),
        displayPath("/srv/api"),
      ),
    );
    model.addAgent(WS_A, AG_A, codex, "tui");
    model.addAgent(WS_A, AG_B, codex, "tui");
    return model;
  }

  it("takes any order for the rows, because none of them can be wrong", () => {
    // The order is read as a permutation request over the grouping
    // (`orderWorkspaces`), so there is no list here that produces a sidebar
    // that is wrong — and therefore nothing to refuse.
    const model = scratchModel();
    expect(model.workspaceOrder).toEqual([]);
    expect(model.setWorkspaceOrder([WS_B, WS_A])).toBe(true);
    expect(model.workspaceOrder).toEqual([WS_B, WS_A]);
  });

  it("publishes nothing when the order is the one it already had", () => {
    const model = scratchModel();
    model.setWorkspaceOrder([WS_B, WS_A]);
    const before = model.snapshot().revision;
    expect(model.setWorkspaceOrder([WS_B, WS_A])).toBe(false);
    expect(model.snapshot().revision).toBe(before);
  });

  it("moves an Agent within its workspace, which is where the order lives", () => {
    const model = withTwoAgents();
    expect(model.setAgentOrder(WS_A, [AG_B, AG_A])).toBe(true);
    expect(
      model.snapshot().workspaces[1].agents.map((agent) => agent.id),
    ).toEqual([AG_B, AG_A]);
    expect(model.setAgentOrder(WS_A, [AG_B, AG_A])).toBe(false);
  });

  it("refuses an Agent order that is not the Agents it has", () => {
    // A caller working from a list that no longer exists. Rearranging the half
    // that still overlaps would put Agents somewhere nobody asked for.
    const model = withTwoAgents();
    expect(codeOf(() => model.setAgentOrder(WS_A, [AG_B]))).toBe(
      DomainErrorCode.UnknownAgent,
    );
    expect(codeOf(() => model.setAgentOrder(WS_A, [AG_A, AG_A]))).toBe(
      DomainErrorCode.UnknownAgent,
    );
    expect(codeOf(() => model.setAgentOrder(WS_B, [AG_A, AG_B]))).toBe(
      DomainErrorCode.UnknownWorkspace,
    );
    expect(
      model.snapshot().workspaces[1].agents.map((agent) => agent.id),
    ).toEqual([AG_A, AG_B]);
  });
});
