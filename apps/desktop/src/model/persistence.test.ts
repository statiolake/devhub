import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppModel, SPLIT_DEFAULT_RATIO } from "./appModel.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  displayPath,
  Workspace,
  workspaceId,
  workspaceRoot,
} from "./domain.js";
import {
  applySnapshot,
  freshState,
  hydrateModel,
  JsonStateStore,
  markCleanShutdown,
  markStarting,
  restoreNavigation,
  StateError,
  stateFromSnapshot,
  STATE_SCHEMA_VERSION,
  validateState,
  type LoadMetadata,
  type PersistedAgentsStep,
  type PersistedAppState,
} from "./persistence.js";
import { makeScratchDir, removeScratchDir } from "./testScratch.js";

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

/** The same state with nothing left in it, which is still a valid state. */
function emptied(state: PersistedAppState): PersistedAppState {
  return {
    ...state,
    workspaces: [],
    navigation: { context: { kind: "global" } },
    sidebar: { ...state.sidebar },
  };
}

function populatedModel(): AppModel {
  const model = new AppModel();
  model.addWorkspace(
    new Workspace(WS_A, workspaceRoot("/dev/a"), displayPath("/dev/a")),
  );
  model.addWorkspace(
    new Workspace(WS_B, workspaceRoot("/dev/b"), displayPath("/dev/b")),
  );
  model.addAgent(WS_A, AG_A, codex);
  return model;
}

describe("projection", () => {
  it("round-trips a populated model through records", () => {
    const model = populatedModel();
    const state = stateFromSnapshot(model.snapshot());
    const restored = hydrateModel(state, [codex]);
    expect(restored.snapshot().workspaces.map((w) => w.root)).toEqual([
      "/dev/a",
      "/dev/b",
    ]);
    expect(restored.snapshot().workspaces[0].agents.map((a) => a.id)).toEqual([
      AG_A,
    ]);
    expect(restored.snapshot().selection).toEqual(model.snapshot().selection);
  });

  it("keeps an agent whose profile is gone, marked unavailable", () => {
    const state = stateFromSnapshot(populatedModel().snapshot());
    const restored = hydrateModel(state, []);
    const agent = restored.snapshot().workspaces[0].agents[0];
    expect(agent.status).toBe("waiting");
    expect(agent.runtimeHealth).toBe("unavailable");
    // The only Codex in its Workspace, so there is nothing for an ordinal to
    // tell it apart from — see `agentLabelFor`.
    expect(agent.displayName).toBe("Codex");
  });

  it("round-trips why an Agent is unread", () => {
    const model = populatedModel();
    // Somewhere else, so the Agent that stops working is not being looked at.
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    model.setAgentStatus(AG_A, "working");
    model.setAgentStatus(AG_A, "idle");
    const state = stateFromSnapshot(model.snapshot());
    expect(state.workspaces[0].agents[0].unread).toBe("idle");
    const restored = hydrateModel(state, [codex]);
    expect(restored.snapshot().workspaces[0].agents[0].unread).toBe("idle");
  });

  it("reads an older DevHub's `unread: true` as the question it meant", () => {
    // That DevHub could only become unread by entering `waiting`, so `true`
    // has exactly one reason and this is it. Nothing is lost and nothing is
    // invented.
    const model = populatedModel();
    // Looking elsewhere, or restoring the file would put the Agent on screen
    // and reading it is exactly what that means.
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    state.workspaces[0].agents[0].unread = true;
    const restored = hydrateModel(state, [codex]);
    expect(restored.snapshot().workspaces[0].agents[0].unread).toBe("waiting");
  });

  it("reads an older DevHub's `unread: false` as read", () => {
    const model = populatedModel();
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    state.workspaces[0].agents[0].unread = false;
    const restored = hydrateModel(state, [codex]);
    expect(restored.snapshot().workspaces[0].agents[0].unread).toBeUndefined();
  });

  it("round-trips the Agent a workspace was last in", () => {
    const model = populatedModel();
    model.selectContext({ kind: "agent", agentId: AG_A });
    // Away again, so the selection is not what puts the answer back.
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    expect(state.workspaces[0].last_agent_id).toBe(AG_A);
    const restored = hydrateModel(state, [codex]);
    expect(restored.lastAgentIn(WS_A)).toBe(AG_A);
  });

  it("has nothing remembered for a workspace nobody opened an Agent in", () => {
    const model = populatedModel();
    // Adding the Agent selected it; leave, so nothing was ever asked for here.
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    state.workspaces[0].last_agent_id = undefined;
    expect(hydrateModel(state, [codex]).lastAgentIn(WS_A)).toBeUndefined();
  });

  it("forgets an Agent that did not come back", () => {
    const model = populatedModel();
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    // An Agent this workspace does not have: the same shape as an id whose
    // Agent was removed while DevHub was not running.
    state.workspaces[0].last_agent_id = AG_B;
    expect(hydrateModel(state, [codex]).lastAgentIn(WS_A)).toBeUndefined();
  });

  it("keeps the provider mapping the model does not own", () => {
    const model = populatedModel();
    const state = stateFromSnapshot(model.snapshot());
    state.workspaces[0].agents[0].provider_mapping = "session-42";
    model.addAgent(WS_A, AG_B, codex);
    const next = applySnapshot(state, model.snapshot());
    expect(next.workspaces[0].agents[0].provider_mapping).toBe("session-42");
    expect(next.workspaces[0].agents[1].provider_mapping).toBeUndefined();
  });

  it("writes nothing down about which Issue a workspace is for", () => {
    // A record cannot follow a checkout, so there is no record: the branch that
    // is checked out is the link, read fresh on every poll. See
    // `issueNumberFromBranch` and `RepositoryStatusWatcher`.
    const state = stateFromSnapshot(populatedModel().snapshot());
    expect(state.workspaces[0]).not.toHaveProperty("issue_url");
  });

  it("ignores the Issue an older DevHub wrote down", () => {
    // Files written before the link moved to the branch still carry the key.
    // It is not read and not validated, so it neither refuses the file nor
    // survives into the next one.
    const state = stateFromSnapshot(populatedModel().snapshot());
    (state.workspaces[0] as unknown as Record<string, unknown>)["issue_url"] =
      "https://example.com/not-an-issue";
    expect(() => {
      validateState(state);
    }).not.toThrow();
    const rewritten = stateFromSnapshot(
      hydrateModel(state, [codex]).snapshot(),
    );
    expect(rewritten.workspaces[0]).not.toHaveProperty("issue_url");
  });
});

describe("navigation restore", () => {
  it("falls to the next agent, then the workspace, then Global", () => {
    const model = populatedModel();
    model.addAgent(WS_A, AG_B, codex);
    model.selectContext({ kind: "agent", agentId: AG_A });
    const state = stateFromSnapshot(model.snapshot());

    const nextAgent = restoreNavigation(
      state,
      new Set([WS_A, WS_B]),
      new Set([AG_B]),
    );
    expect(nextAgent).toEqual({
      context: { kind: "agent", agent_id: AG_B },
      changed: true,
    });

    const workspace = restoreNavigation(
      state,
      new Set([WS_A, WS_B]),
      new Set(),
    );
    expect(workspace).toEqual({
      context: { kind: "workspace", workspace_id: WS_A },
      changed: true,
    });

    const global = restoreNavigation(state, new Set(), new Set());
    expect(global).toEqual({
      context: { kind: "global" },
      changed: true,
    });
  });
});

describe("validation", () => {
  it("rejects two workspaces on the same canonical path", () => {
    const state = freshState();
    const record = {
      workspace_id: WS_A,
      selected_path: "/dev/a",
      canonical_path: "/dev/a",
      lifecycle: { kind: "available" as const },
      agents: [],
    };
    state.workspaces = [record, { ...record, workspace_id: WS_B }];
    expect(() => {
      validateState(state);
    }).toThrow(StateError);
  });

  it("rejects cleanup progress that closed the editor before the terminal", () => {
    const state = freshState();
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/dev/a",
        canonical_path: "/dev/a",
        lifecycle: {
          kind: "closing",
          progress: {
            agents_step: { kind: "done", closed: 0 },
            terminal_closed: false,
            editor_closed: true,
          },
        },
        agents: [],
      },
    ];
    expect(() => {
      validateState(state);
    }).toThrow(StateError);
  });
});

describe("cleanup progress after the agents step", () => {
  it("accepts more Agents closed than are left in the record", () => {
    // The agents step stops every Agent and takes it out of the workspace, and
    // then writes down how many it stopped. So the record a close saves has
    // `agents_closed: 2` and no Agents — which is the normal shape of a close
    // that is going well, not a corrupt one. Refusing it is what made closing
    // a workspace with an Agent in it fail on every attempt.
    const state = freshState();
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/dev/a",
        canonical_path: "/dev/a",
        lifecycle: {
          kind: "closing",
          progress: {
            agents_step: { kind: "done", closed: 2 },
            terminal_closed: false,
            editor_closed: false,
          },
        },
        agents: [],
      },
    ];
    expect(() => {
      validateState(state);
    }).not.toThrow();
  });

  it("still refuses a count that is not one", () => {
    const state = freshState();
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/dev/a",
        canonical_path: "/dev/a",
        lifecycle: {
          kind: "closing_failed",
          diagnostic: "cleanup_failed",
          progress: {
            agents_step: { kind: "done", closed: -1 },
            terminal_closed: false,
            editor_closed: false,
          },
        },
        agents: [],
      },
    ];
    expect(() => {
      validateState(state);
    }).toThrow(StateError);
  });
});

/**
 * The Agents step is one value, and the file holds that value.
 *
 * It used to be `agents_closed` plus `agents_step_completed`, and there were
 * two constructors that disagreed about the pair — one derived the flag from
 * the count, one set it. So `{ agents_closed: 3, agents_step_completed: false }`
 * was writable and came back as *completed*: the resumed close skipped its
 * Agents step, and the symptom was a close that did not finish with nothing
 * anywhere saying why.
 */
describe("how far a close got, across a restart", () => {
  const STEPS: readonly PersistedAgentsStep[] = [
    { kind: "pending" },
    { kind: "done", closed: 0 },
    { kind: "done", closed: 3 },
  ];

  function closingWith(step: PersistedAgentsStep): PersistedAppState {
    const state = freshState();
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/dev/a",
        canonical_path: "/dev/a",
        lifecycle: {
          kind: "closing_failed",
          diagnostic: "cleanup_failed",
          progress: {
            agents_step: step,
            terminal_closed: false,
            editor_closed: false,
          },
        },
        agents: [],
      },
    ];
    return state;
  }

  it("comes back the step it went in as, and writes back the same one", () => {
    for (const step of STEPS) {
      const model = hydrateModel(closingWith(step), []);
      const restored = model.snapshot().workspaces[0]!.state;
      expect(restored.kind).toBe("closing-failed");
      if (restored.kind !== "closing-failed") throw new Error("unreachable");
      expect(restored.progress.agentsStep).toEqual(
        step.kind === "done"
          ? { kind: "done", closed: step.closed }
          : { kind: "pending" },
      );
      const written = stateFromSnapshot(model.snapshot()).workspaces[0]!;
      expect(written.lifecycle).toMatchObject({
        progress: { agents_step: step },
      });
    }
  });

  it("keeps a step that ran and closed nothing apart from one that has not run", () => {
    const ran = hydrateModel(
      closingWith({ kind: "done", closed: 0 }),
      [],
    ).snapshot().workspaces[0]!.state;
    const pending = hydrateModel(
      closingWith({ kind: "pending" }),
      [],
    ).snapshot().workspaces[0]!.state;
    if (ran.kind !== "closing-failed" || pending.kind !== "closing-failed") {
      throw new Error("unreachable");
    }
    expect(ran.progress.agentsStep).not.toEqual(pending.progress.agentsStep);
  });
});

describe("a close that was in progress when DevHub stopped", () => {
  it("comes back as a close that failed, never as one still running", () => {
    const state = freshState();
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/dev/a",
        canonical_path: "/dev/a",
        lifecycle: {
          kind: "closing",
          progress: {
            agents_step: { kind: "done", closed: 0 },
            terminal_closed: true,
            editor_closed: false,
          },
        },
        agents: [],
      },
    ];
    const model = hydrateModel(state, []);
    const workspace = model.snapshot().workspaces[0];
    // Nothing is left to drive the remaining steps, so "closing" would be a
    // row that never stops closing. It is a failure with the progress kept,
    // which the Sidebar offers a retry for.
    expect(workspace.state.kind).toBe("closing-failed");
    expect(workspace.state).toMatchObject({
      progress: { terminalClosed: true, editorClosed: false },
    });
  });
});

describe("shutdown metadata", () => {
  it("marks a launch unclean and a shutdown clean again", () => {
    const state = freshState();
    expect(markStarting(state)).toBe(true);
    expect(state.shutdown).toEqual({ clean: false, launch_generation: 1 });
    expect(markCleanShutdown(state)).toBe(true);
    expect(markCleanShutdown(state)).toBe(false);
  });
});

describe("store", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = makeScratchDir("state");
    path = join(directory, "state.json");
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  it("returns a fresh state when there is no file", async () => {
    const load = await new JsonStateStore(path).loadState();
    expect(load.metadata.origin).toBe("fresh");
    expect(load.metadata.recoveryReason).toBe("missing");
    expect(load.state).toEqual(freshState());
  });

  it("round-trips a save and a load", async () => {
    const store = new JsonStateStore(path);
    const state = stateFromSnapshot(populatedModel().snapshot());
    await store.saveState(state);
    const load = await store.loadState();
    expect(load.metadata.origin).toBe("primary");
    expect(load.state).toEqual(state);
  });

  it("keeps a backup of the last file that parsed", async () => {
    const store = new JsonStateStore(path);
    const first = stateFromSnapshot(populatedModel().snapshot());
    await store.saveState(first);
    await store.saveState(emptied(first));
    const backup: unknown = JSON.parse(
      await readFile(store.backupPath, "utf8"),
    );
    expect(backup).toEqual(first);
  });

  it("quarantines a corrupt primary and recovers from the backup", async () => {
    const store = new JsonStateStore(path);
    const good = stateFromSnapshot(populatedModel().snapshot());
    await store.saveState(good);
    await store.saveState(emptied(good));
    await writeFile(path, "{ not json", { mode: 0o600 });
    const load = await store.loadState();
    expect(load.metadata.origin).toBe("backup");
    expect(load.metadata.recoveryReason).toBe("corrupt_primary");
    expect(load.metadata.primaryQuarantined).toBe(true);
    expect(load.state).toEqual(good);
  });

  it("names the file and the reason when a save cannot be written", async () => {
    const store = new JsonStateStore(join(directory, "locked", "state.json"));
    await chmod(directory, 0o500);
    try {
      await store.saveState(freshState());
      throw new Error("the save should not have succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(StateError);
      const described = (error as StateError).describe();
      // What the person reads has to be enough to go and look: which file,
      // and what the operating system said about it.
      expect(described).toContain("state.json");
      expect(described).toMatch(/permission|could not be written/);
      expect(described).toContain("EACCES");
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("refuses a state file from a newer schema", async () => {
    await writeFile(path, JSON.stringify({ schema_version: 99 }), {
      mode: 0o600,
    });
    await expect(new JsonStateStore(path).loadState()).rejects.toThrow(
      StateError,
    );
  });

  it("refuses a world-readable state file rather than trusting it", async () => {
    await writeFile(path, JSON.stringify(freshState()), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(new JsonStateStore(path).loadState()).rejects.toThrow(
      StateError,
    );
  });

  it("migrates a legacy file that still spells the schema as `version`", async () => {
    await writeFile(
      path,
      JSON.stringify({ ...freshState(), schema_version: 1, version: 1 }),
      { mode: 0o600 },
    );
    const load = await new JsonStateStore(path).loadState();
    expect(load.metadata.migrated).toBe(true);
    const written: Record<string, unknown> = JSON.parse(
      await readFile(path, "utf8"),
    ) as Record<string, unknown>;
    expect(written["version"]).toBeUndefined();
    expect(written["schema_version"]).toBe(STATE_SCHEMA_VERSION);
  });

  it("takes a version-1 file, activity and all, and drops what it retired", async () => {
    const legacy = {
      ...freshState(),
      schema_version: 1,
      navigation: { context: { kind: "global" }, activity: "terminal" },
    };
    delete (legacy as Record<string, unknown>)["split"];
    await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
    const load = await new JsonStateStore(path).loadState();
    expect(load.metadata.migrated).toBe(true);
    // The retired field is not read — the decoder keeps what this build reads
    // and nothing else — and the new one defaults rather than making an old
    // file unloadable.
    expect(load.state.navigation).toEqual({ context: { kind: "global" } });
    expect(load.state.split.ratio).toBe(SPLIT_DEFAULT_RATIO);
  });

  it("loads a file that still says the sidebar is collapsed", async () => {
    // `sidebar.expanded` is retired: there is one sidebar form now. A file that
    // says it was collapsed still loads, and the field it says it with is
    // ignored on load and gone from the next save.
    const collapsed = {
      ...freshState(),
      sidebar: { width: 321, expanded: false },
    };
    await writeFile(path, JSON.stringify(collapsed), { mode: 0o600 });
    const store = new JsonStateStore(path);
    const load = await store.loadState();
    expect(load.state.sidebar.width).toBe(321);

    const model = hydrateModel(load.state, []);
    expect(model.snapshot().sidebar.width).toBe(321);

    await store.saveState(stateFromSnapshot(model.snapshot()));
    const written: Record<string, unknown> = JSON.parse(
      await readFile(path, "utf8"),
    ) as Record<string, unknown>;
    expect(written["sidebar"]).toEqual({ width: 321 });
  });

  it("round-trips an interrupted socket transition", async () => {
    const state = stateFromSnapshot(populatedModel().snapshot());
    state.tmux = {
      effective_socket_name: "devhub",
      transition: {
        kind: "cleaning_old",
        old_socket_name: "devhub",
        requested_socket_name: "devhub-next",
        target_preflight: "target_absent",
        required: [
          { kind: "scratch", session_name: "scratch" },
          {
            kind: "workspace",
            workspace_id: WS_A,
            session_name: "ws-0123456789abcdef0123",
          },
          {
            kind: "workspace",
            workspace_id: WS_B,
            session_name: "ws-fedcba9876543210fedc",
          },
        ],
        sessions: [
          {
            session: { kind: "scratch", session_name: "scratch" },
            status: "completed",
          },
        ],
      },
    };
    const store = new JsonStateStore(path);
    await store.saveState(state);
    expect((await store.loadState()).state.tmux).toEqual(state.tmux);
  });

  it("carries every field the model owns, not only the ones it used to", () => {
    // `applySnapshot` merges the live model over the stored document, and a
    // field it forgets is a setting that changes on screen and is gone at the
    // next launch — which is what happened to the split's ratio.
    const model = populatedModel();
    model.setSidebarWidth(321);
    model.setSplitRatio(0.7);
    const merged = applySnapshot(freshState(), model.snapshot());
    expect(merged.sidebar.width).toBe(321);
    expect(merged.split.ratio).toBe(0.7);
  });
});

/**
 * The state file is bytes, and this is where they become typed values.
 *
 * Every case here used to be accepted: `object["sidebar"] as SidebarState` is
 * an assertion, not a check, so `"width": "300"` passed the range test that
 * follows it — `"300" < 200` and `"300" > 400` are both false — and reached
 * the model and the wire as a string. `"status": "banana"` hydrated into an
 * Agent whose row drew nothing, arbitrarily far from the file that caused it.
 */
describe("decoding the state file", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = makeScratchDir("decode");
    path = join(directory, "state.json");
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  /** A good file with one thing changed, loaded, and what the load said. */
  async function loadWith(
    mutate: (document: Record<string, unknown>) => void,
  ): Promise<LoadMetadata & { readonly state: PersistedAppState }> {
    const good = stateFromSnapshot(populatedModel().snapshot());
    const document = JSON.parse(JSON.stringify(good)) as Record<
      string,
      unknown
    >;
    mutate(document);
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    const load = await new JsonStateStore(path).loadState();
    return { ...load.metadata, state: load.state };
  }

  function firstAgent(
    document: Record<string, unknown>,
  ): Record<string, unknown> {
    const workspaces = document["workspaces"] as Record<string, unknown>[];
    return (workspaces[0]["agents"] as Record<string, unknown>[])[0];
  }

  it("refuses a value that is not a member of its enum, and says which", async () => {
    const load = await loadWith((document) => {
      firstAgent(document)["status"] = "banana";
    });
    expect(load.recoveryReason).toBe("corrupt_primary");
    expect(load.corruptionDetail).toContain("workspaces[0].agents[0].status");
    expect(load.corruptionDetail).toContain('"banana"');
    expect(load.corruptionDetail).toContain("working");
  });

  it("refuses a number written as a string, before anything compares it", async () => {
    // The whole bug: `"300"` is inside the sidebar's range because neither
    // comparison against a string is true.
    const load = await loadWith((document) => {
      document["sidebar"] = { width: "300" };
    });
    expect(load.recoveryReason).toBe("corrupt_primary");
    expect(load.corruptionDetail).toContain("sidebar.width");
    expect(load.corruptionDetail).toContain("a number");
    expect(load.corruptionDetail).toContain('"300"');
  });

  /** The workspace's cleanup progress, in the raw document. */
  function progressOf(
    document: Record<string, unknown>,
  ): Record<string, unknown> {
    const workspaces = document["workspaces"] as Record<string, unknown>[];
    workspaces[0]["lifecycle"] = {
      kind: "closing_failed",
      diagnostic: "cleanup_failed",
      progress: {
        agents_step: { kind: "pending" },
        terminal_closed: false,
        editor_closed: false,
      },
    };
    return (workspaces[0]["lifecycle"] as Record<string, unknown>)[
      "progress"
    ] as Record<string, unknown>;
  }

  it("refuses an Agents step it cannot read, rather than choosing one", async () => {
    for (const broken of [
      { kind: "done" },
      { kind: "done", closed: -1 },
      { kind: "done", closed: 1.5 },
      { kind: "done", closed: "3" },
      { kind: "banana" },
      true,
    ]) {
      const load = await loadWith((document) => {
        progressOf(document)["agents_step"] = broken;
      });
      expect(load.recoveryReason).toBe("corrupt_primary");
      expect(load.corruptionDetail).toContain("agents_step");
    }
  });

  /**
   * A close only sits in a state file while it is *interrupted*, so a file
   * from the previous build is a person mid-close. Dropping their progress
   * would restart the close from the beginning — the bug the union exists to
   * prevent — so the retired pair is read, once, here.
   */
  it("reads a version-2 file's Agents step without losing its place", async () => {
    const done = await loadWith((document) => {
      const progress = progressOf(document);
      delete progress["agents_step"];
      progress["agents_closed"] = 3;
      progress["agents_step_completed"] = true;
    });
    expect(done.recoveryReason).toBeUndefined();
    expect(done.state.workspaces[0]!.lifecycle).toMatchObject({
      progress: { agents_step: { kind: "done", closed: 3 } },
    });

    const pending = await loadWith((document) => {
      const progress = progressOf(document);
      delete progress["agents_step"];
      progress["agents_closed"] = 0;
      progress["agents_step_completed"] = false;
    });
    expect(pending.recoveryReason).toBeUndefined();
    expect(pending.state.workspaces[0]!.lifecycle).toMatchObject({
      progress: { agents_step: { kind: "pending" } },
    });
  });

  it("refuses a required field that is not there", async () => {
    const load = await loadWith((document) => {
      const workspaces = document["workspaces"] as Record<string, unknown>[];
      delete workspaces[0]["lifecycle"];
    });
    expect(load.recoveryReason).toBe("corrupt_primary");
    expect(load.corruptionDetail).toContain("workspaces[0].lifecycle");
    expect(load.corruptionDetail).toContain("nothing");
  });

  it("refuses an unknown tag on a union the model owns", async () => {
    const load = await loadWith((document) => {
      firstAgent(document)["control_state"] = { kind: "exploded" };
    });
    expect(load.corruptionDetail).toContain(
      "workspaces[0].agents[0].control_state.kind",
    );
    expect(load.corruptionDetail).toContain("stop_failed");
  });

  it("decodes an optional field once, into the type the model uses", async () => {
    // `unread: true` is the old spelling of "waiting", and it is translated
    // here rather than travelling as a boolean and being translated later.
    const load = await loadWith((document) => {
      firstAgent(document)["unread"] = true;
      // Looking at an Agent is what clears its mark, so look elsewhere.
      document["navigation"] = { context: { kind: "global" } };
    });
    expect(load.recoveryReason).toBeUndefined();
    const agent = hydrateModel(load.state, []).snapshot().workspaces[0]
      .agents[0];
    expect(agent.unread).toBe("waiting");

    const bad = await loadWith((document) => {
      firstAgent(document)["unread"] = "banana";
    });
    expect(bad.corruptionDetail).toContain("workspaces[0].agents[0].unread");
  });

  it("ignores keys this build has no use for, and drops them", async () => {
    // The policy, and it is deliberate: `navigation.activity`, `issue_url` and
    // `sidebar.expanded` are all fields a past DevHub wrote. Refusing them
    // would make every key ever retired a file this build cannot open.
    const load = await loadWith((document) => {
      document["nonsense"] = 1;
      document["sidebar"] = { width: 321, expanded: false };
      const workspaces = document["workspaces"] as Record<string, unknown>[];
      workspaces[0]["issue_url"] = "https://example.invalid/1";
    });
    expect(load.recoveryReason).toBeUndefined();
    expect(load.state.sidebar).toEqual({ width: 321 });
    expect(load.state.workspaces[0]).not.toHaveProperty("issue_url");
  });
});

/**
 * What a refusal to project a state file blames.
 *
 * Projection used to be six `try { ... } catch { return fail("STATE_INVALID") }`
 * blocks with the cause thrown away, so a record the domain refused, a value
 * that slipped past the decoder and a programming error inside `AppModel` all
 * came out identically — as "your file is corrupt", which quarantines the
 * person's session and blames the file for a bug in the code.
 */
describe("projecting a state file that will not project", () => {
  it("names the record and the reason when the document is at fault", () => {
    const state = stateFromSnapshot(populatedModel().snapshot());
    // Valid as a document — absolute, no NUL — and not a path the domain will
    // accept, because it climbs out above the root.
    state.workspaces[0].selected_path = "/dev/../..";
    try {
      hydrateModel(state, []);
      throw new Error("the projection should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(StateError);
      const described = (error as StateError).describe("state.json");
      expect(described).toContain(state.workspaces[0].workspace_id);
      expect(described).toContain("INVALID_PATH");
    }
  });

  it("lets a bug in the projection itself through, uncaught", () => {
    const state = stateFromSnapshot(populatedModel().snapshot());
    // Not a profile. A caller that hands this over has a bug, and a bug is a
    // crash with the cause attached — not a state file declared corrupt and
    // moved out of the way.
    const notProfiles = [
      { id: "codex" },
      { id: "codex" },
    ] as unknown as AgentProfile[];
    expect(() => hydrateModel(state, notProfiles)).toThrow(TypeError);
  });
});
