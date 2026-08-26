import type {
  ActivitySnapshot,
  AgentSnapshot,
  AppSnapshot,
  NavigationContext,
  WorkspaceSnapshot,
} from "../generated/app-shell";

const globalActivities: AppSnapshot["activities"] = [
  {
    activity: "editor",
    resolution: { kind: "enabled", surfaceKey: "global-editor" },
  },
  {
    activity: "agent",
    resolution: {
      kind: "disabled",
      reason: "global-agent-not-applicable",
    },
  },
  {
    activity: "terminal",
    resolution: { kind: "enabled", surfaceKey: "global-terminal" },
  },
];

function workspaceActivities(
  workspaceId: string,
  agent?: string,
): AppSnapshot["activities"] {
  return [
    {
      activity: "editor",
      resolution: {
        kind: "enabled",
        surfaceKey: `workspace-editor:${workspaceId}`,
      },
    },
    {
      activity: "agent",
      resolution: agent
        ? { kind: "enabled", surfaceKey: `agent:${agent}` }
        : {
            kind: "disabled",
            reason: "workspace-agent-requires-agent-selection",
          },
    },
    {
      activity: "terminal",
      resolution: {
        kind: "enabled",
        surfaceKey: `workspace-terminal:${workspaceId}`,
      },
    },
  ];
}

const agent = (
  id: string,
  workspaceId: string,
  displayName: string,
  status: AgentSnapshot["status"],
  ordinal: number,
): AgentSnapshot => ({
  id,
  workspaceId,
  profileId: id === "agent-2" ? "claude" : "codex",
  displayName,
  ordinal,
  status,
  runtimeHealth: "healthy",
  controlState: "running",
});

const workspace = (
  id: string,
  label: string,
  agents: readonly AgentSnapshot[] = [],
  state: WorkspaceSnapshot["state"] = "available",
): WorkspaceSnapshot => ({
  id,
  label,
  root: `/Users/statiolake/dev/${label}`,
  selectedPath: `/Users/statiolake/dev/${label}`,
  state,
  aggregateStatus: agents.some(({ status }) => status === "error")
    ? "error"
    : agents.some(({ status }) => status === "waiting")
      ? "waiting"
      : agents.some(({ status }) => status === "working")
        ? "working"
        : "idle",
  agents,
  canCreateAgent: state === "available",
});

function snapshot(
  context: NavigationContext,
  activity: AppSnapshot["selection"]["activity"],
  activities: AppSnapshot["activities"],
  workspaces: readonly WorkspaceSnapshot[],
  expandedWorkspaceIds: readonly string[] = [],
  revision = 1,
  editorHost: AppSnapshot["editorHost"] = { status: "ready" },
): AppSnapshot {
  return {
    schemaVersion: 1,
    revision,
    readiness: "ready",
    selection: { context, activity },
    activities,
    workspaces,
    sidebar: { width: 248, expandedWorkspaceIds },
    editorHost,
  };
}

export const globalSnapshot = snapshot(
  { kind: "global" },
  "terminal",
  globalActivities,
  [],
);

export const workspaceSnapshot = snapshot(
  { kind: "workspace", workspaceId: "workspace-1" },
  "editor",
  workspaceActivities("workspace-1"),
  [workspace("workspace-1", "devhub")],
);

/** The editor host refused to start; the Surface must say why. */
export const editorFailedSnapshot = snapshot(
  { kind: "workspace", workspaceId: "workspace-1" },
  "editor",
  workspaceActivities("workspace-1"),
  [workspace("workspace-1", "devhub")],
  [],
  1,
  {
    status: "failed",
    summary: "The editor's port is already in use.",
    detail:
      "127.0.0.1:55971 is already in use by another process. This is the port DevHub persisted for its editor origin, so it is not replaced automatically. Quit whatever holds it — a leftover code serve-web is the usual cause — and retry.",
  },
);

export const agentSnapshot = snapshot(
  { kind: "agent", agentId: "agent-1" },
  "agent",
  workspaceActivities("workspace-1", "agent-1"),
  [
    workspace("workspace-1", "devhub", [
      agent("agent-1", "workspace-1", "Codex 1", "working", 1),
      agent("agent-2", "workspace-1", "Claude 1", "waiting", 2),
    ]),
  ],
  ["workspace-1"],
);

export const unavailableSnapshot = snapshot(
  { kind: "workspace", workspaceId: "workspace-missing" },
  "editor",
  [
    {
      activity: "editor",
      resolution: {
        kind: "disabled",
        reason: "workspace-unavailable",
      },
    },
    {
      activity: "agent",
      resolution: {
        kind: "disabled",
        reason: "workspace-agent-requires-agent-selection",
      },
    },
    {
      activity: "terminal",
      resolution: {
        kind: "disabled",
        reason: "workspace-unavailable",
      },
    },
  ],
  [workspace("workspace-missing", "missing", [], "unavailable")],
);

export const closingFailedSnapshot = snapshot(
  { kind: "workspace", workspaceId: "workspace-closing" },
  "editor",
  [
    {
      activity: "editor",
      resolution: {
        kind: "disabled",
        reason: "workspace-closing-failed",
      },
    },
    {
      activity: "agent",
      resolution: {
        kind: "disabled",
        reason: "workspace-agent-requires-agent-selection",
      },
    },
    {
      activity: "terminal",
      resolution: {
        kind: "disabled",
        reason: "workspace-closing-failed",
      },
    },
  ],
  [workspace("workspace-closing", "closing", [], "closing-failed")],
);

export const activityFixtures: readonly ActivitySnapshot[] = [
  ...globalActivities,
  ...workspaceActivities("workspace-1", "agent-1"),
];
