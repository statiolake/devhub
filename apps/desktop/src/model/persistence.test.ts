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

  it("keeps the provider mapping the model does not own", () => {
    const model = populatedModel();
    const state = stateFromSnapshot(model.snapshot());
    state.workspaces[0].agents[0].provider_mapping = "session-42";
    model.addAgent(WS_A, AG_B, codex);
    const next = applySnapshot(state, model.snapshot());
    expect(next.workspaces[0].agents[0].provider_mapping).toBe("session-42");
    expect(next.workspaces[0].agents[1].provider_mapping).toBeUndefined();
  });

  it("keeps the Issue a workspace was started for", () => {
    // The record is the whole point: a branch can be renamed, and a workspace
    // that survived a restart must still know what it is about.
    const model = populatedModel();
    model.associateIssue(WS_A, {
      owner: "example",
      repository: "widget",
      number: 128,
    });
    const state = stateFromSnapshot(model.snapshot());
    expect(state.workspaces[0].issue_url).toBe(
      "https://github.com/example/widget/issues/128",
    );
    expect(hydrateModel(state, [codex]).snapshot().workspaces[0].issue).toEqual(
      {
        owner: "example",
        repository: "widget",
        number: 128,
      },
    );
  });

  it("refuses a state whose Issue link cannot be read back", () => {
    const state = stateFromSnapshot(populatedModel().snapshot());
    state.workspaces[0].issue_url = "https://example.com/not-an-issue";
    expect(() => {
      validateState(state);
    }).toThrow();
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
            agents_closed: 0,
            agents_step_completed: true,
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
    // The retired field is not read, and the new one defaults rather than
    // making an old file unloadable.
    expect(load.state.navigation).toEqual({
      context: { kind: "global" },
      activity: "terminal",
    });
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
