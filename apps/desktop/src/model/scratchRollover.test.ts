import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppModel } from "./appModel.js";
import { coordinatorFor, drawn } from "./testWorkspaces.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  CLEAN_CLOSE_INSPECTION,
  DomainError,
  DomainErrorCode,
  displayPath,
  Workspace,
  workspaceId,
  workspaceLocation,
  type WorkspaceId,
} from "./domain.js";
import {
  hydrateModel,
  JsonStateStore,
  stateFromSnapshot,
  STATE_SCHEMA_VERSION,
} from "./persistence.js";
import { makeScratchDir, removeScratchDir } from "./testScratch.js";

const YESTERDAY = workspaceId("550e8400-e29b-41d4-a716-446655440001");
const TODAY = workspaceId("550e8400-e29b-41d4-a716-446655440002");
const PROJECT = workspaceId("550e8400-e29b-41d4-a716-446655440003");
const AGENT = agentId("550e8400-e29b-41d4-a716-4466554400a0");

const codex = AgentProfile.create(
  agentProfileId("codex"),
  "Codex",
  "codex",
  "codex",
);

function folder(id: WorkspaceId, path: string): Workspace {
  return new Workspace(
    id,
    workspaceLocation({ kind: "local", path }),
    displayPath(path),
  );
}

const yesterday = (): Workspace => folder(YESTERDAY, "/data/junk/20260922");
const today = (): Workspace => folder(TODAY, "/data/junk/20260923");

function codeOf(run: () => unknown): DomainErrorCode | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? error.code : undefined;
  }
  return undefined;
}

/** Yesterday's Scratch, with an Agent created in it and selected. */
function yesterdayWithAgent(): AppModel {
  const model = new AppModel(yesterday());
  model.addAgent(YESTERDAY, AGENT, codex, "tui");
  return model;
}

describe("Scratch is today's daily-folder Workspace", () => {
  it("is selected, labelled Scratch, and one of the workspaces", () => {
    const snapshot = new AppModel(today()).snapshot();
    expect(snapshot.scratchWorkspaceId).toBe(TODAY);
    expect(snapshot.selection.context).toEqual({
      kind: "workspace",
      workspaceId: TODAY,
    });
    expect(snapshot.workspaces.map((one) => one.label)).toEqual(["Scratch"]);
    expect(snapshot.workspaces[0]?.root).toBe("/data/junk/20260923");
    expect(snapshot.layout).toEqual({
      kind: "workbench",
      editor: { kind: "workspace-editor", workspaceId: TODAY },
    });
  });

  it("takes Agents like any Workspace", () => {
    const model = yesterdayWithAgent();
    expect(model.snapshot().workspaces[0]?.agents.map((one) => one.id)).toEqual(
      [AGENT],
    );
  });

  it("cannot be closed, while it is today's", () => {
    const model = new AppModel(today());
    expect(
      codeOf(() => {
        model.closeWorkspace(TODAY, CLEAN_CLOSE_INSPECTION, drawn(model));
      }),
    ).toBe(DomainErrorCode.ScratchCannotClose);
  });
});

describe("midnight", () => {
  it("leaves yesterday's folder as an ordinary row, Agent, selection and all", () => {
    const model = yesterdayWithAgent();
    expect(model.adoptScratchDay(today())).toBe(true);
    const snapshot = model.snapshot();
    expect(snapshot.scratchWorkspaceId).toBe(TODAY);
    const labels = Object.fromEntries(
      snapshot.workspaces.map((one) => [one.id, one.label]),
    );
    expect(labels).toEqual({ [YESTERDAY]: "20260922", [TODAY]: "Scratch" });
    const old = snapshot.workspaces.find((one) => one.id === YESTERDAY);
    expect(old?.agents.map((one) => one.id)).toEqual([AGENT]);
    // Nothing running is touched: the person is still in the Agent they were
    // in, now in a row called 20260922.
    expect(snapshot.selection.context).toEqual({
      kind: "agent",
      agentId: AGENT,
    });
  });

  it("makes yesterday's row closable, and Cmd+Q Shift+J go to the new day", () => {
    const model = new AppModel(yesterday());
    model.adoptScratchDay(today());
    model.selectContext({ kind: "workspace", workspaceId: YESTERDAY });
    model.toggleScratch();
    expect(model.snapshot().selection.context).toEqual({
      kind: "workspace",
      workspaceId: TODAY,
    });
    model.closeWorkspace(YESTERDAY, CLEAN_CLOSE_INSPECTION, drawn(model));
    expect(model.snapshot().workspaces.map((one) => one.id)).toEqual([TODAY]);
  });

  it("adopts a folder that is already open rather than opening it twice", () => {
    const model = new AppModel(yesterday());
    model.addWorkspace(folder(PROJECT, "/data/junk/20260923"));
    const fresh = today();
    model.adoptScratchDay(fresh);
    const snapshot = model.snapshot();
    expect(snapshot.scratchWorkspaceId).toBe(PROJECT);
    expect(snapshot.workspaces.map((one) => one.id)).not.toContain(TODAY);
  });

  it("is a no-op on the same day", () => {
    const model = new AppModel(today());
    const before = model.snapshot().revision;
    expect(model.adoptScratchDay(folder(PROJECT, "/data/junk/20260923"))).toBe(
      false,
    );
    expect(model.snapshot().revision).toBe(before);
  });

  it("goes through the coordinator as one intent", () => {
    const coordinator = coordinatorFor(new AppModel(yesterday()));
    const fresh = today();
    coordinator.dispatchUser({
      intentId: "00000000-0000-4000-8000-000000000001" as never,
      operationId: "00000000-0000-4000-8000-000000000002" as never,
      intent: {
        type: "adopt_scratch_day",
        workspaceId: fresh.id,
        location: fresh.location,
        selectedPath: fresh.selectedPath,
      },
    });
    expect(coordinator.snapshot().scratchWorkspaceId).toBe(TODAY);
  });
});

describe("launch", () => {
  it("reconciles a state file from yesterday: yesterday's row, today's Scratch", () => {
    const written = stateFromSnapshot(yesterdayWithAgent().snapshot());
    const model = hydrateModel(written, [codex], today());
    const snapshot = model.snapshot();
    expect(snapshot.scratchWorkspaceId).toBe(TODAY);
    const old = snapshot.workspaces.find((one) => one.id === YESTERDAY);
    expect(old?.label).toBe("20260922");
    expect(old?.agents.map((one) => one.id)).toEqual([AGENT]);
  });

  it("keeps today's Workspace, and its id, when the file already has it", () => {
    const written = stateFromSnapshot(new AppModel(today()).snapshot());
    const model = hydrateModel(
      written,
      [],
      folder(PROJECT, "/data/junk/20260923"),
    );
    expect(model.snapshot().scratchWorkspaceId).toBe(TODAY);
    expect(model.snapshot().workspaces).toHaveLength(1);
  });

  it("writes being on Scratch as Scratch, so tomorrow opens tomorrow's", () => {
    const written = stateFromSnapshot(new AppModel(yesterday()).snapshot());
    expect(written.navigation).toEqual({});
    const model = hydrateModel(written, [], today());
    expect(model.snapshot().selection.context).toEqual({
      kind: "workspace",
      workspaceId: TODAY,
    });
  });
});

describe("migrating a version-9 state file", () => {
  let directory: string;
  beforeEach(() => {
    directory = makeScratchDir("scratch-migration");
  });
  afterEach(() => {
    removeScratchDir(directory);
  });

  it("reads the folderless Scratch as today's Scratch and drops its session", async () => {
    const written = stateFromSnapshot(
      (() => {
        const model = new AppModel(today());
        model.addWorkspace(folder(PROJECT, "/data/project"));
        return model;
      })().snapshot(),
    );
    // What a version-9 DevHub wrote: no daily folder among the Workspaces, the
    // folderless context selected, and its own tmux session in a socket
    // change's required set.
    const project = written.workspaces.filter(
      (one) => one.workspace_id === PROJECT,
    );
    const v9 = {
      ...written,
      schema_version: 9,
      workspaces: project,
      navigation: { context: { kind: "global" } },
      tmux: {
        effective_socket_name: "devhub",
        transition: {
          kind: "old_cleaned",
          old_socket_name: "devhub",
          new_socket_name: "devhub-next",
          required: [
            { kind: "scratch", session_name: "scratch" },
            {
              kind: "workspace",
              workspace_id: PROJECT,
              session_name: "ws-0123456789abcdef0123",
            },
          ],
        },
      },
    };
    const path = join(directory, "state.json");
    await writeFile(path, JSON.stringify(v9), { mode: 0o600 });
    const load = await new JsonStateStore(path).loadState();
    expect(load.metadata.corruptionDetail).toBeUndefined();
    expect(load.metadata.migrated).toBe(true);
    expect(load.state.schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(load.state.navigation).toEqual({});
    expect(load.state.tmux.transition).toMatchObject({
      kind: "old_cleaned",
      required: [{ kind: "workspace", workspace_id: PROJECT }],
    });

    const model = hydrateModel(load.state, [], today());
    const snapshot = model.snapshot();
    expect(snapshot.scratchWorkspaceId).toBe(TODAY);
    expect(snapshot.selection.context).toEqual({
      kind: "workspace",
      workspaceId: TODAY,
    });
    expect(snapshot.workspaces.map((one) => one.id).sort()).toEqual(
      [TODAY, PROJECT].sort(),
    );
  });

  it("refuses a version-10 file that still names the folderless context", async () => {
    const written = stateFromSnapshot(new AppModel(today()).snapshot());
    const path = join(directory, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        ...written,
        navigation: { context: { kind: "global" } },
      }),
      { mode: 0o600 },
    );
    const load = await new JsonStateStore(path).loadState();
    expect(load.metadata.corruptionDetail).toContain("navigation.context.kind");
  });
});
