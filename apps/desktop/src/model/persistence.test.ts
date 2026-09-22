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
  workspaceId as parseWorkspaceId,
  workspaceLocation,
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
  type PersistedAppState,
} from "./persistence.js";
import { makeScratchDir, removeScratchDir } from "./testScratch.js";
import { localWorkspace } from "./testWorkspaces.js";

/**
 * Today's Scratch, as a launch hands it to `hydrateModel`: a Workspace for
 * the day's folder with an id nobody has used.
 *
 * The populated model below is made with `/dev/a` as its Scratch, so a state
 * written from it names that folder and hydrating it with this day finds it
 * — which keeps every record where the rest of this file expects it.
 */
const TODAY_PATH = "/dev/a";
function today(path: string = TODAY_PATH): Workspace {
  return localWorkspace(path);
}

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
    navigation: {},
    sidebar: { ...state.sidebar },
  };
}

function populatedModel(): AppModel {
  const model = new AppModel(
    new Workspace(
      WS_A,
      workspaceLocation({ kind: "local", path: "/dev/a" }),
      displayPath("/dev/a"),
    ),
  );
  model.addWorkspace(
    new Workspace(
      WS_B,
      workspaceLocation({ kind: "local", path: "/dev/b" }),
      displayPath("/dev/b"),
    ),
  );
  model.addAgent(WS_A, AG_A, codex);
  return model;
}

describe("projection", () => {
  it("round-trips a populated model through records", () => {
    const model = populatedModel();
    const state = stateFromSnapshot(model.snapshot());
    const restored = hydrateModel(state, [codex], today());
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
    const restored = hydrateModel(state, [], today());
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
    const restored = hydrateModel(state, [codex], today());
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
    const restored = hydrateModel(state, [codex], today());
    expect(restored.snapshot().workspaces[0].agents[0].unread).toBe("waiting");
  });

  it("reads an older DevHub's `unread: false` as read", () => {
    const model = populatedModel();
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    state.workspaces[0].agents[0].unread = false;
    const restored = hydrateModel(state, [codex], today());
    expect(restored.snapshot().workspaces[0].agents[0].unread).toBeUndefined();
  });

  it("round-trips the Agent a workspace was last in", () => {
    const model = populatedModel();
    model.selectContext({ kind: "agent", agentId: AG_A });
    // Away again, so the selection is not what puts the answer back.
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    expect(state.workspaces[0].last_agent_id).toBe(AG_A);
    const restored = hydrateModel(state, [codex], today());
    expect(restored.lastAgentIn(WS_A)).toBe(AG_A);
  });

  it("has nothing remembered for a workspace nobody opened an Agent in", () => {
    const model = populatedModel();
    // Adding the Agent selected it; leave, so nothing was ever asked for here.
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    state.workspaces[0].last_agent_id = undefined;
    expect(
      hydrateModel(state, [codex], today()).lastAgentIn(WS_A),
    ).toBeUndefined();
  });

  it("forgets an Agent that did not come back", () => {
    const model = populatedModel();
    model.selectContext({ kind: "agent", agentId: AG_A });
    model.selectContext({ kind: "workspace", workspaceId: WS_B });
    const state = stateFromSnapshot(model.snapshot());
    // An Agent this workspace does not have: the same shape as an id whose
    // Agent was removed while DevHub was not running.
    state.workspaces[0].last_agent_id = AG_B;
    expect(
      hydrateModel(state, [codex], today()).lastAgentIn(WS_A),
    ).toBeUndefined();
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
      hydrateModel(state, [codex], today()).snapshot(),
    );
    expect(rewritten.workspaces[0]).not.toHaveProperty("issue_url");
  });
});

describe("Scratch across a restart", () => {
  it("brings yesterday's Scratch back as an ordinary row, with its Agents, and makes today's", () => {
    // A state file written yesterday: Scratch was `/dev/a` and had an Agent.
    const yesterday = populatedModel();
    yesterday.selectContext({ kind: "workspace", workspaceId: WS_A });
    const state = stateFromSnapshot(yesterday.snapshot());
    // The selection was on Scratch, so the file says so by saying nothing.
    expect(state.navigation).toEqual({});
    const model = hydrateModel(state, [codex], today("/dev/daily/20260924"));
    const snapshot = model.snapshot();
    expect(snapshot.workspaces.map((w) => [w.root, w.label])).toEqual([
      ["/dev/daily/20260924", "Scratch"],
      ["/dev/a", "a"],
      ["/dev/b", "b"],
    ]);
    expect(snapshot.workspaces[1].id).toBe(WS_A);
    expect(snapshot.workspaces[1].agents.map((a) => a.id)).toEqual([AG_A]);
    // Being on Scratch comes back as today's Scratch.
    expect(snapshot.selection.context).toEqual({
      kind: "workspace",
      workspaceId: snapshot.scratchWorkspaceId,
    });
  });

  it("keeps Scratch's id, Agents and all, on the same day", () => {
    const state = stateFromSnapshot(populatedModel().snapshot());
    const model = hydrateModel(state, [codex], today());
    expect(model.scratchWorkspaceId).toBe(WS_A);
    expect(model.snapshot().workspaces).toHaveLength(2);
  });
});

describe("navigation restore", () => {
  it("falls to the next agent, then the workspace, then Scratch", () => {
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

    // Absent is Scratch, whichever day's folder that is when it is read.
    const scratch = restoreNavigation(state, new Set(), new Set());
    expect(scratch).toEqual({ context: undefined, changed: true });
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
});

/**
 * A close is never resumed, so a close is never in the file.
 *
 * The two variants below are what version 3 wrote. They still decode, because
 * refusing them would quarantine a session over a record this build simply has
 * no use for — and they load as a Workspace that is open, which is what it is:
 * whatever close that file named, nothing was running it by the time the file
 * was read, and the steps are idempotent, so closing again repeats them.
 */
describe("a version-3 file with a close in it", () => {
  function fileWithLifecycle(lifecycle: unknown): PersistedAppState {
    const state = freshState();
    state.schema_version = 3;
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/dev/a",
        canonical_path: "/dev/a",
        lifecycle:
          lifecycle as PersistedAppState["workspaces"][number]["lifecycle"],
        agents: [],
      },
    ];
    return state;
  }

  const CLOSING = {
    kind: "closing",
    progress: {
      agents_step: { kind: "done", closed: 2 },
      terminal_closed: true,
      editor_closed: false,
    },
  };
  const CLOSING_FAILED = {
    kind: "closing_failed",
    diagnostic: "cleanup_failed",
    progress: {
      agents_step: { kind: "pending" },
      terminal_closed: false,
      editor_closed: false,
    },
  };

  async function loadedFrom(lifecycle: unknown): Promise<PersistedAppState> {
    const directory = makeScratchDir("state");
    const path = join(directory, "state.json");
    await writeFile(path, JSON.stringify(fileWithLifecycle(lifecycle)), {
      mode: 0o600,
    });
    return (await new JsonStateStore(path).loadState()).state;
  }

  it("decodes both of them rather than refusing the file", async () => {
    for (const lifecycle of [CLOSING, CLOSING_FAILED]) {
      const state = await loadedFrom(lifecycle);
      expect(state.schema_version).toBe(STATE_SCHEMA_VERSION);
      expect(state.workspaces[0]!.lifecycle).toEqual({ kind: "available" });
    }
  });

  it("loads the Workspace as open, because it was never closed", async () => {
    for (const lifecycle of [CLOSING, CLOSING_FAILED]) {
      const workspace = hydrateModel(
        await loadedFrom(lifecycle),
        [],
        today(),
      ).snapshot().workspaces[0]!;
      expect(workspace.state).toEqual({ kind: "available" });
      expect(workspace.close).toEqual({ kind: "idle" });
    }
  });

  it("writes the file back with no close in it at all", async () => {
    const written = stateFromSnapshot(
      hydrateModel(await loadedFrom(CLOSING), [], today()).snapshot(),
    );
    expect(written.workspaces[0]!.lifecycle).toEqual({ kind: "available" });
    // Not "the progress fields are empty": there are no such fields. A close
    // that can be resumed from a file is the thing this version removed.
    expect(JSON.stringify(written)).not.toContain("agents_step");
    expect(JSON.stringify(written)).not.toContain("progress");
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
    expect(load.state.navigation).toEqual({});
    expect(load.state.split.ratio).toBe(SPLIT_DEFAULT_RATIO);
  });

  it("reads the retired `expanded` as nothing, and writes the field there is", async () => {
    // `sidebar.expanded` is retired and `sidebar.collapsed` is what says the
    // same thing now — they are not the same field under two names, and the
    // old one is not translated. A file that carries it loads, the key is
    // ignored, and the next save writes the one this build has.
    const collapsed = {
      ...freshState(),
      sidebar: { width: 321, expanded: false },
    };
    await writeFile(path, JSON.stringify(collapsed), { mode: 0o600 });
    const store = new JsonStateStore(path);
    const load = await store.loadState();
    expect(load.state.sidebar.width).toBe(321);

    const model = hydrateModel(load.state, [], today());
    expect(model.snapshot().sidebar.width).toBe(321);
    expect(model.snapshot().sidebar.collapsed).toBe(false);

    await store.saveState(stateFromSnapshot(model.snapshot()));
    const written: Record<string, unknown> = JSON.parse(
      await readFile(path, "utf8"),
    ) as Record<string, unknown>;
    expect(written["sidebar"]).toEqual({
      width: 321,
      collapsed: false,
      order: [],
    });
  });

  it("brings the rail back exactly as it was left", async () => {
    const store = new JsonStateStore(path);
    await store.saveState({
      ...freshState(),
      sidebar: { width: 321, collapsed: true, order: [] },
    });

    const load = await store.loadState();
    const model = hydrateModel(load.state, [], today());
    // Both facts, because there are two: the rail is what is on screen, and
    // the width is what it goes back to.
    expect(model.snapshot().sidebar).toEqual({ width: 321, collapsed: true });
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
            session: {
              kind: "workspace",
              workspace_id: WS_A,
              session_name: "ws-0123456789abcdef0123",
            },
            status: "completed",
          },
        ],
      },
    };
    const store = new JsonStateStore(path);
    await store.saveState(state);
    expect((await store.loadState()).state.tmux).toEqual(state.tmux);
  });

  it("migrates a version-9 file's Scratch: Global becomes absent, the scratch session goes", async () => {
    // What a version-9 DevHub wrote while on Scratch in the middle of a socket
    // change: the folderless context, and the `scratch` session in every list.
    const state = stateFromSnapshot(populatedModel().snapshot());
    const document = JSON.parse(JSON.stringify(state)) as Record<
      string,
      unknown
    >;
    document["schema_version"] = 9;
    document["navigation"] = { context: { kind: "global" } };
    document["tmux"] = {
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
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    const load = await new JsonStateStore(path).loadState();
    expect(load.metadata.migrated).toBe(true);
    expect(load.state.schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(load.state.navigation).toEqual({});
    const transition = load.state.tmux.transition;
    expect(transition.kind).toBe("cleaning_old");
    if (transition.kind !== "cleaning_old") return;
    expect(transition.required.map((one) => one.workspace_id)).toEqual([
      WS_A,
      WS_B,
    ]);
    expect(transition.sessions).toEqual([]);
    // Every Workspace and Agent it had is still there, and the selection it
    // left on Scratch comes back as today's Scratch.
    const model = hydrateModel(
      load.state,
      [codex],
      today("/srv/daily/20260923"),
    );
    const snapshot = model.snapshot();
    expect(snapshot.workspaces.map((w) => w.root)).toEqual([
      "/srv/daily/20260923",
      "/dev/a",
      "/dev/b",
    ]);
    expect(snapshot.workspaces[1].agents.map((a) => a.id)).toEqual([AG_A]);
    expect(snapshot.selection.context).toEqual({
      kind: "workspace",
      workspaceId: snapshot.scratchWorkspaceId,
    });
  });

  it("refuses a version-10 file that still names Global", async () => {
    const document = JSON.parse(JSON.stringify(freshState())) as Record<
      string,
      unknown
    >;
    document["navigation"] = { context: { kind: "global" } };
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    const load = await new JsonStateStore(path).loadState();
    expect(load.metadata.corruptionDetail).toContain("navigation.context.kind");
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

  it("takes a lifecycle that names a close and gives back an open one", async () => {
    // Version 3's two close variants, whatever they carried. They decode so
    // an older file is not quarantined, and they decode to `available`: a
    // close named in a file is a close nothing is running.
    for (const lifecycle of [
      {
        kind: "closing",
        progress: {
          agents_step: { kind: "done", closed: 3 },
          terminal_closed: true,
          editor_closed: false,
        },
      },
      { kind: "closing_failed", diagnostic: "cleanup_failed", progress: {} },
      // Even a progress record this build could not have made sense of: it is
      // not read at all, so there is nothing in it to refuse.
      { kind: "closing", progress: { agents_step: "banana" } },
    ]) {
      const load = await loadWith((document) => {
        const workspaces = document["workspaces"] as Record<string, unknown>[];
        workspaces[0]["lifecycle"] = lifecycle;
      });
      expect(load.recoveryReason).toBeUndefined();
      expect(load.state.workspaces[0]!.lifecycle).toEqual({
        kind: "available",
      });
    }
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
      document["navigation"] = {
        context: { kind: "workspace", workspace_id: WS_B },
      };
    });
    expect(load.recoveryReason).toBeUndefined();
    const agent = hydrateModel(load.state, [], today()).snapshot().workspaces[0]
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
    expect(load.state.sidebar).toEqual({
      width: 321,
      collapsed: false,
      order: [],
    });
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
      hydrateModel(state, [], today());
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
    expect(() => hydrateModel(state, notProfiles, today())).toThrow(TypeError);
  });
});

/**
 * Version 5's whole story is one absent key.
 *
 * A version-4 record has no `location`, and every Workspace a version-4 DevHub
 * could hold was a folder on this machine — so absence is the answer, not a
 * missing value, and there is no migration step to get wrong. The bump is for
 * the other direction: a version-4 build reading a version-5 file would find a
 * `canonical_path` naming a directory on a machine it has never heard of.
 */
describe("a Workspace's place across a restart", () => {
  const WS_C = "33333333-3333-4333-8333-333333333333";

  function remoteModel(): AppModel {
    const model = new AppModel(today());
    model.addWorkspace(
      new Workspace(
        WS_B,
        workspaceLocation({
          kind: "ssh",
          host: "build.example.com",
          path: "/srv/api",
        }),
        displayPath("/srv/api"),
      ),
    );
    // The same path on a second machine: two Workspaces, and the file has to
    // keep them apart or one of them does not come back.
    model.addWorkspace(
      new Workspace(
        parseWorkspaceId(WS_C),
        workspaceLocation({
          kind: "ssh",
          host: "staging.example.com",
          path: "/srv/api",
        }),
        displayPath("/srv/api"),
      ),
    );
    return model;
  }

  it("round-trips the machine, not just the path", () => {
    const state = stateFromSnapshot(remoteModel().snapshot());
    expect(state.workspaces.map((record) => record.location)).toEqual([
      { kind: "local" },
      { kind: "ssh", host: "build.example.com" },
      { kind: "ssh", host: "staging.example.com" },
    ]);
    validateState(state);
    const restored = hydrateModel(state, [], today()).snapshot();
    expect(restored.workspaces.map((workspace) => workspace.key)).toEqual([
      "/dev/a",
      "ssh://build.example.com/srv/api",
      "ssh://staging.example.com/srv/api",
    ]);
  });

  it("loads a version-4 record as a folder on this machine", async () => {
    const state = freshState();
    state.schema_version = 4;
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/dev/a",
        canonical_path: "/dev/a",
        lifecycle: { kind: "available" },
        agents: [],
      },
    ];
    // Written without `location` at all — the shape a version-4 DevHub wrote —
    // and read back through the store, which is the only path a real file
    // takes.
    const directory = makeScratchDir("state");
    const path = join(directory, "state.json");
    const document = JSON.parse(JSON.stringify(state)) as {
      workspaces: Record<string, unknown>[];
    };
    delete document.workspaces[0]!["location"];
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    const loaded = (await new JsonStateStore(path).loadState()).state;
    expect(loaded.schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(loaded.workspaces[0]!.location).toEqual({ kind: "local" });
    expect(
      hydrateModel(loaded, [], today()).snapshot().workspaces[0]!.location,
    ).toEqual({
      kind: "local",
      path: "/dev/a",
    });
    removeScratchDir(directory);
  });

  /**
   * Version 6's whole story is one absent key, run the other way.
   *
   * A version-5 file has no `session_machines`, and the empty list is not a
   * gap: the sweep asks the persisted set *and* every machine a Workspace is
   * on, so a v5 file's machines are exactly the ones its Workspaces name. The
   * bump is for the other direction — a version-5 build would drop the list on
   * its next save, and the machines in it would stop being swept.
   */
  it("loads a version-5 file with no machines remembered, and writes them back", async () => {
    const state = freshState();
    state.schema_version = 5;
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/srv/api",
        canonical_path: "/srv/api",
        location: { kind: "ssh", host: "build.example.com" },
        lifecycle: { kind: "available" },
        agents: [],
      },
    ];
    const directory = makeScratchDir("state");
    const path = join(directory, "state.json");
    const document = JSON.parse(JSON.stringify(state)) as Record<
      string,
      unknown
    >;
    delete document["session_machines"];
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });

    const store = new JsonStateStore(path);
    const load = await store.loadState();
    expect(load.state.schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(load.state.session_machines).toEqual([]);

    // And the key is a plain list of machine ids once something writes one.
    load.state.session_machines = ["ssh:build.example.com"];
    await store.saveState(load.state);
    const again = await new JsonStateStore(path).loadState();
    expect(again.state.session_machines).toEqual(["ssh:build.example.com"]);
    removeScratchDir(directory);
  });

  it("refuses a host that could not survive being a URI authority", () => {
    const state = freshState();
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/srv/api",
        canonical_path: "/srv/api",
        location: { kind: "ssh", host: "build/etc" },
        lifecycle: { kind: "available" },
        agents: [],
      },
    ];
    expect(() => {
      validateState(state);
    }).toThrow();
  });

  it("keeps two machines' identical paths as two records", () => {
    const state = stateFromSnapshot(remoteModel().snapshot());
    // The uniqueness rule is about the place, not the path: this used to be a
    // set of canonical paths, and the second remote Workspace would have been
    // refused as a duplicate of the first.
    expect(() => {
      validateState(state);
    }).not.toThrow();
  });
});

describe("the order a person put the rows in, across a restart", () => {
  /**
   * Version 7's whole story is one absent key.
   *
   * A version-6 file has no `sidebar.order`, and the empty list is not a gap:
   * it *is* the automatic order, which is what that file always meant. The
   * bump is for the other direction — a version-6 build would drop the list on
   * its next save and the sidebar would fall back to the automatic order,
   * which looks like the arrangement was never made.
   */
  it("loads a version-6 file as the automatic order, and writes one back", async () => {
    const state = freshState();
    state.schema_version = 6;
    state.workspaces = [
      {
        workspace_id: WS_A,
        selected_path: "/srv/api",
        canonical_path: "/srv/api",
        lifecycle: { kind: "available" },
        agents: [],
      },
    ];
    const directory = makeScratchDir("state");
    const path = join(directory, "state.json");
    const document = JSON.parse(JSON.stringify(state)) as Record<
      string,
      unknown
    >;
    document["sidebar"] = { width: 260, collapsed: false };
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });

    const store = new JsonStateStore(path);
    const load = await store.loadState();
    expect(load.state.schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(load.state.sidebar.order).toEqual([]);
    expect(hydrateModel(load.state, [], today()).workspaceOrder).toEqual([]);

    load.state.sidebar.order = [WS_A];
    await store.saveState(load.state);
    const again = await new JsonStateStore(path).loadState();
    expect(again.state.sidebar.order).toEqual([WS_A]);
    removeScratchDir(directory);
  });

  /**
   * The Agent panes' zoom survives a restart, which is the whole point of it
   * being in this file rather than in `settings.toml`.
   *
   * A version-8 file has no key and loads as `0` — the setting untouched —
   * which is what every file written before the zoom existed meant.
   */
  it("loads a version-8 file with no zoom, and writes the zoom back", async () => {
    const state = freshState();
    state.schema_version = 8;
    const directory = makeScratchDir("state");
    const path = join(directory, "state.json");
    const document = JSON.parse(JSON.stringify(state)) as Record<
      string,
      unknown
    >;
    delete document["terminal"];
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });

    const store = new JsonStateStore(path);
    const load = await store.loadState();
    expect(load.state.schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(load.state.terminal.zoom_offset).toBe(0);
    expect(hydrateModel(load.state, [], today()).terminalZoomOffset).toBe(0);

    const model = hydrateModel(load.state, [], today());
    model.zoomTerminal(13, "in");
    model.zoomTerminal(13, "in");
    await store.saveState(applySnapshot(load.state, model.snapshot()));

    const again = await new JsonStateStore(path).loadState();
    expect(again.state.terminal.zoom_offset).toBe(2);
    expect(hydrateModel(again.state, [], today()).terminalZoomOffset).toBe(2);
    removeScratchDir(directory);
  });

  it("refuses a zoom no size could be named by", async () => {
    const state = freshState();
    const directory = makeScratchDir("state");
    const path = join(directory, "state.json");
    const document = JSON.parse(JSON.stringify(state)) as Record<
      string,
      unknown
    >;
    document["terminal"] = { zoom_offset: 400 };
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });

    const load = await new JsonStateStore(path).loadState();
    // Quarantined and started fresh, which is what an unreadable file means
    // here: the number said nothing this build can act on.
    expect(load.state.terminal.zoom_offset).toBe(0);
    expect(load.metadata.origin).not.toBe("primary");
    removeScratchDir(directory);
  });

  it("carries an arrangement from the model to the file and back", () => {
    const model = new AppModel(today());
    model.addWorkspace(
      new Workspace(
        WS_A,
        workspaceLocation({ kind: "local", path: "/srv/api" }),
        displayPath("/srv/api"),
      ),
    );
    model.addWorkspace(
      new Workspace(
        WS_B,
        workspaceLocation({ kind: "local", path: "/srv/web" }),
        displayPath("/srv/web"),
      ),
    );
    model.setWorkspaceOrder([WS_B, WS_A]);

    const state = stateFromSnapshot(model.snapshot());
    expect(state.sidebar.order).toEqual([WS_B, WS_A]);
    expect(hydrateModel(state, [], today()).workspaceOrder).toEqual([
      WS_B,
      WS_A,
    ]);
  });

  it("keeps an id whose workspace has closed", () => {
    // The row comes back where it was if the folder is opened again, and
    // pruning here would make closing one workspace a way of forgetting where
    // its neighbours went.
    const model = new AppModel(today());
    model.addWorkspace(
      new Workspace(
        WS_A,
        workspaceLocation({ kind: "local", path: "/srv/api" }),
        displayPath("/srv/api"),
      ),
    );
    model.setWorkspaceOrder([WS_B, WS_A]);
    const state = stateFromSnapshot(model.snapshot());
    expect(state.sidebar.order).toEqual([WS_B, WS_A]);
    expect(hydrateModel(state, [], today()).workspaceOrder).toEqual([
      WS_B,
      WS_A,
    ]);
  });

  it("refuses an order entry that is not an identity", () => {
    const state = freshState();
    state.sidebar.order = ["not-a-uuid"];
    expect(() => {
      validateState(state);
    }).toThrow();
  });

  it("writes an Agent's place out as the place it is in the list", () => {
    // Agents need no key of their own: the array *is* the order, so arranging
    // them is moving them in it, and the file already says what that is.
    const model = new AppModel(today());
    model.addWorkspace(
      new Workspace(
        WS_A,
        workspaceLocation({ kind: "local", path: "/srv/api" }),
        displayPath("/srv/api"),
      ),
    );
    model.addAgent(WS_A, AG_A, codex);
    model.addAgent(WS_A, AG_B, codex);
    model.setAgentOrder(WS_A, [AG_B, AG_A]);

    const state = stateFromSnapshot(model.snapshot());
    // After Scratch, which is always the model's first Workspace.
    expect(state.workspaces[1].agents.map((agent) => agent.agent_id)).toEqual([
      AG_B,
      AG_A,
    ]);
    expect(
      hydrateModel(state, [codex], today())
        .snapshot()
        .workspaces[1].agents.map((agent) => agent.id),
    ).toEqual([AG_B, AG_A]);
  });
});

/**
 * One gate, not two.
 *
 * The state file used to have two validators that disagreed. `validateState`
 * checked the schema and called a record valid; `hydrateModel` then read
 * fields the schema check had never looked at, and a record without a
 * `control_state` came out of `controlStateFrom` as a bare `TypeError` — on a
 * state that had just been pronounced good. An unnamed crash is not a refusal:
 * the store's integrity path quarantines a `StateError` and recovers from the
 * backup with a notice, and a `TypeError` goes past it to the top of the app.
 *
 * So the rule these tests hold to: validation is the single gate, and every
 * field hydration reads is checked there, by the same decoder the file is read
 * with. Past it, hydration is total for shape.
 */
describe("what validation checks and hydration may then assume", () => {
  /** A good state with one record broken, and the refusal it produced. */
  function refusalFrom(mutate: (state: PersistedAppState) => void): StateError {
    const state = stateFromSnapshot(populatedModel().snapshot());
    mutate(state);
    let refusal: unknown;
    try {
      validateState(state);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(StateError);
    // The same state through the other road: hydration must refuse it the same
    // way, and never with the unnamed error this whole rule exists to stop.
    expect(() => hydrateModel(state, [codex], today())).toThrow(StateError);
    expect(() => hydrateModel(state, [codex], today())).not.toThrow(TypeError);
    return refusal as StateError;
  }

  /**
   * Every field hydration reads that the schema check used to skip.
   *
   * `control_state` is the one that was reported, and it was never the only
   * one: `status`, `runtime_health`, `profile_kind`, `unread`, a workspace's
   * `lifecycle` and `location`, the sidebar's width and collapse, the split's
   * ratio and the navigation context's kind were all read by hydration and
   * checked by nothing, because the decoder that checks them is only on the
   * road that comes from a file.
   */
  const gaps: readonly (readonly [
    string,
    string,
    (state: PersistedAppState) => void,
  ])[] = [
    [
      "an agent with no control state",
      "workspaces[0].agents[0].control_state",
      (state) => {
        delete (
          state.workspaces[0].agents[0] as unknown as Record<string, unknown>
        )["control_state"];
      },
    ],
    [
      "an agent whose control state names no kind",
      "workspaces[0].agents[0].control_state.kind",
      (state) => {
        state.workspaces[0].agents[0].control_state = {} as never;
      },
    ],
    [
      "a stop that failed without saying why",
      "workspaces[0].agents[0].control_state.diagnostic",
      (state) => {
        state.workspaces[0].agents[0].control_state = {
          kind: "stop_failed",
        } as never;
      },
    ],
    [
      "an agent with no status",
      "workspaces[0].agents[0].status",
      (state) => {
        delete (
          state.workspaces[0].agents[0] as unknown as Record<string, unknown>
        )["status"];
      },
    ],
    [
      "an agent whose status is not one",
      "workspaces[0].agents[0].status",
      (state) => {
        state.workspaces[0].agents[0].status = "banana" as never;
      },
    ],
    [
      "an agent with no runtime health",
      "workspaces[0].agents[0].runtime_health",
      (state) => {
        delete (
          state.workspaces[0].agents[0] as unknown as Record<string, unknown>
        )["runtime_health"];
      },
    ],
    [
      "an agent whose profile kind is not one",
      "workspaces[0].agents[0].profile_kind",
      (state) => {
        state.workspaces[0].agents[0].profile_kind = "banana" as never;
      },
    ],
    [
      "an agent owed a look for a reason that is not one",
      "workspaces[0].agents[0].unread",
      (state) => {
        state.workspaces[0].agents[0].unread = "banana" as never;
      },
    ],
    [
      "a workspace with no lifecycle",
      "workspaces[0].lifecycle",
      (state) => {
        delete (state.workspaces[0] as unknown as Record<string, unknown>)[
          "lifecycle"
        ];
      },
    ],
    [
      "a workspace unavailable for a reason that is not one",
      "workspaces[0].lifecycle.reason",
      (state) => {
        state.workspaces[0].lifecycle = {
          kind: "unavailable",
          reason: "banana",
        } as never;
      },
    ],
    [
      "a workspace on a kind of place there is none of",
      "workspaces[0].location.kind",
      (state) => {
        state.workspaces[0].location = { kind: "banana" } as never;
      },
    ],
    [
      "a sidebar width written as a string",
      "sidebar.width",
      (state) => {
        state.sidebar.width = "300" as never;
      },
    ],
    [
      "a sidebar collapse that is not a yes or a no",
      "sidebar.collapsed",
      (state) => {
        state.sidebar.collapsed = "yes" as never;
      },
    ],
    [
      "a split ratio written as a string",
      "split.ratio",
      (state) => {
        state.split.ratio = "0.5" as never;
      },
    ],
    [
      "a selection of a kind there is none of",
      "navigation.context.kind",
      (state) => {
        state.navigation.context = { kind: "banana" } as never;
      },
    ],
  ];

  for (const [what, path, mutate] of gaps) {
    it(`refuses ${what}, and names the field`, () => {
      const refusal = refusalFrom(mutate);
      expect(refusal.code).toBe("STATE_INVALID");
      expect(refusal.describe("state.json")).toContain(path);
    });
  }

  /**
   * The property, over the records this build can write.
   *
   * Every optional key dropped, one at a time, from a good state: whatever
   * `validateState` accepts, `hydrateModel` projects. The absent ones that are
   * migrations — `location`, `profile_kind` and the rest of the launch
   * snapshot, `last_agent_id` — are accepted and hydrate; the ones that are
   * gaps are refused as `StateError`. Neither road ends in a `TypeError`.
   */
  it("hydrates every record it accepts, whichever key is absent", () => {
    const good = stateFromSnapshot(populatedModel().snapshot());
    const paths: string[] = [
      ...Object.keys(good.workspaces[0].agents[0]).map(
        (key) => `workspaces.0.agents.0.${key}`,
      ),
      ...Object.keys(good.workspaces[0])
        .filter((key) => key !== "agents")
        .map((key) => `workspaces.0.${key}`),
      ...Object.keys(good.sidebar).map((key) => `sidebar.${key}`),
      "split.ratio",
      "navigation.context",
    ];
    let accepted = 0;
    for (const path of paths) {
      const state = JSON.parse(JSON.stringify(good)) as PersistedAppState;
      const steps = path.split(".");
      let node = state as unknown as Record<string, unknown>;
      for (const step of steps.slice(0, -1)) {
        node = node[step] as Record<string, unknown>;
      }
      delete node[steps[steps.length - 1]!];
      try {
        validateState(state);
      } catch (error) {
        expect(error, `${path} was refused by something else`).toBeInstanceOf(
          StateError,
        );
        continue;
      }
      accepted += 1;
      expect(() => hydrateModel(state, [codex], today()), path).not.toThrow();
    }
    // The absences that are migrations, not gaps — if this ever reaches zero
    // the loop is passing because nothing gets through it.
    expect(accepted).toBeGreaterThan(0);
  });

  it("quarantines a file whose agent has no control state", async () => {
    const directory = makeScratchDir("gate");
    const path = join(directory, "state.json");
    const store = new JsonStateStore(path);
    const good = stateFromSnapshot(populatedModel().snapshot());
    await store.saveState(good);
    await store.saveState(emptied(good));
    const document = JSON.parse(JSON.stringify(good)) as PersistedAppState;
    delete (
      document.workspaces[0].agents[0] as unknown as Record<string, unknown>
    )["control_state"];
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });

    const load = await store.loadState();
    expect(load.metadata.recoveryReason).toBe("corrupt_primary");
    expect(load.metadata.primaryQuarantined).toBe(true);
    expect(load.metadata.corruptionDetail).toContain(
      "workspaces[0].agents[0].control_state",
    );
    expect(load.state).toEqual(good);
    removeScratchDir(directory);
  });
});
