/**
 * The projection seam: model values in, App Shell wire values out.
 *
 * A port of `crates/devhub-app-core/src/shell.rs`. Nothing downstream of here
 * knows about the model's classes, and nothing upstream knows about camelCase
 * or `kind` tags. Both directions live in this one file so a change to the
 * contract has exactly one place to be wrong.
 */

import {
  agentId as parseAgentId,
  agentProfileId as parseAgentProfileId,
  workspaceId as parseWorkspaceId,
  DomainError,
  DomainErrorCode,
  surfaceKeyName,
  type AgentProfile,
  type CloseInspectionProjection,
  type ResourceInspection,
  type SurfaceResolution,
} from "./domain.js";
import type {
  AgentSnapshot,
  AppSnapshot,
  EditorHostState,
  WorkspaceSnapshot,
} from "./appModel.js";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./appModel.js";
import {
  AppError,
  AppErrorCode,
  confirmationId as parseConfirmationId,
  requestedPath,
  type ConfirmationOutcomePurpose,
  type IntentOutcome,
  type UserIntent,
} from "./intents.js";
import {
  APP_SHELL_SCHEMA_VERSION,
  MAX_SAFE_JS_INTEGER,
  type ActivityWire,
  type AgentProfilesWire,
  type AgentProfileWire,
  type AgentWire,
  type AppAppearanceWire,
  type AppErrorActionWire,
  type AppErrorCodeWire,
  type AppErrorModuleWire,
  type AppErrorWire,
  type AppIntentWire,
  type AppOutcomeWire,
  type AppReadiness,
  type AppSnapshotWire,
  type CloseDiagnosticWire,
  type CloseInspectionWire,
  type CloseResourceWire,
  type ConfirmationPurposeWire,
  type ContextWire,
  type EditorHostWire,
  type ReplayEventKindWire,
  type ReplayWire,
  type ResolutionWire,
  type WorkspaceStateWire,
  type WorkspaceWire,
} from "../ipc/appShell.js";
import type { AppearanceConfig, TerminalPalette } from "./config.js";
import type { CoordinatorReplay } from "./coordinator.js";

/** A projection that cannot be represented on the wire is a bug, not a state. */
export class SnapshotWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotWireError";
  }
}

function paletteWire(palette: TerminalPalette) {
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
    cursorText: palette.cursorText,
    selectionBackground: palette.selectionBackground,
    selectionForeground: palette.selectionForeground,
    ansi: [...palette.ansi],
  };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function paletteIsValid(palette: TerminalPalette): boolean {
  return (
    palette.ansi.length === 16 &&
    [
      palette.background,
      palette.foreground,
      palette.cursor,
      palette.cursorText,
      palette.selectionBackground,
      palette.selectionForeground,
      ...palette.ansi,
    ].every((color) => HEX_COLOR.test(color))
  );
}

export function appearanceWire(
  config: AppearanceConfig,
  sequence: number,
): AppAppearanceWire {
  const wire: AppAppearanceWire = {
    sequence,
    colorScheme: "light",
    sidebarDensity:
      config.sidebarDensity === "comfortable" ? "comfortable" : "compact",
    terminalFontFamily: config.terminalFontFamily,
    terminalFontSize: config.terminalFontSize,
    terminalLineHeight: config.terminalLineHeight,
    terminalMargin: config.terminalMargin,
    terminalTheme: {
      light: paletteWire(config.terminalTheme.light),
      dark: paletteWire(config.terminalTheme.dark),
    },
  };
  validateAppearanceWire(wire, config);
  return wire;
}

function validateAppearanceWire(
  wire: AppAppearanceWire,
  config: AppearanceConfig,
): void {
  if (wire.sequence === 0 || wire.sequence > MAX_SAFE_JS_INTEGER) {
    throw new SnapshotWireError(
      "appearance sequence is outside the safe range",
    );
  }
  if (
    wire.terminalFontFamily.trim().length === 0 ||
    [...wire.terminalFontFamily].length > 128 ||
    wire.terminalFontSize < 9 ||
    wire.terminalFontSize > 24 ||
    !Number.isFinite(wire.terminalLineHeight) ||
    wire.terminalLineHeight < 1 ||
    wire.terminalLineHeight > 2 ||
    wire.terminalMargin > 64 ||
    !paletteIsValid(config.terminalTheme.light) ||
    !paletteIsValid(config.terminalTheme.dark)
  ) {
    throw new SnapshotWireError(
      "appearance projection is outside the supported range",
    );
  }
}

export function agentProfilesWire(
  profiles: readonly AgentProfile[],
  sequence: number,
): AgentProfilesWire {
  if (sequence === 0 || sequence > MAX_SAFE_JS_INTEGER) {
    throw new SnapshotWireError("profile sequence is outside the safe range");
  }
  const projected: AgentProfileWire[] = profiles.map((profile) => ({
    id: profile.id,
    displayName: profile.displayName,
    kind: profile.kind,
  }));
  return {
    sequence,
    availability: "available",
    profiles: projected,
  };
}

export function unavailableAgentProfiles(
  sequence: number,
  diagnostic: AgentProfilesWire["diagnostic"],
): AgentProfilesWire {
  return {
    sequence: Math.max(1, sequence),
    availability: "unavailable",
    diagnostic,
    profiles: [],
  };
}

function resolutionWire(resolution: SurfaceResolution): ResolutionWire {
  return resolution.kind === "enabled"
    ? { kind: "enabled", surfaceKey: surfaceKeyName(resolution.surfaceKey) }
    : { kind: "disabled", reason: resolution.reason };
}

function contextWire(
  context: AppSnapshot["selection"]["context"],
): ContextWire {
  switch (context.kind) {
    case "global":
      return { kind: "global" };
    case "workspace":
      return { kind: "workspace", workspaceId: context.workspaceId };
    case "agent":
      return { kind: "agent", agentId: context.agentId };
  }
}

function workspaceStateName(
  state: WorkspaceSnapshot["state"],
): WorkspaceStateWire {
  return state.kind;
}

/** The reason behind a state that has one; nothing for the states that do not. */
function workspaceStateDiagnostic(
  state: WorkspaceSnapshot["state"],
): CloseDiagnosticWire | undefined {
  switch (state.kind) {
    case "unavailable":
      return state.reason;
    case "closing-failed":
      return state.diagnostic;
    default:
      return undefined;
  }
}

function agentWire(agent: AgentSnapshot): AgentWire {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    profileId: agent.profileId,
    displayName: agent.displayName,
    ordinal: agent.ordinal,
    status: agent.status,
    runtimeHealth: agent.runtimeHealth,
    controlState: agent.controlState.kind,
  };
}

function editorHostWire(state: EditorHostState): EditorHostWire {
  switch (state.kind) {
    case "starting":
      return { status: "starting" };
    case "ready":
      return { status: "ready" };
    case "failed":
      return { status: "failed", summary: state.summary, detail: state.detail };
  }
}

export function snapshotWire(
  snapshot: AppSnapshot,
  readiness: AppReadiness,
): AppSnapshotWire {
  if (snapshot.revision > MAX_SAFE_JS_INTEGER) {
    throw new SnapshotWireError("snapshot revision is outside the safe range");
  }
  const activities: ActivityWire[] = snapshot.activities.map((activity) => ({
    activity: activity.activity,
    resolution: resolutionWire(activity.resolution),
  }));
  const workspaces: WorkspaceWire[] = snapshot.workspaces.map((workspace) => ({
    id: workspace.id,
    label: workspace.label,
    root: workspace.root,
    selectedPath: workspace.selectedPath,
    state: workspaceStateName(workspace.state),
    stateDiagnostic: workspaceStateDiagnostic(workspace.state),
    aggregateStatus: workspace.aggregateStatus,
    agents: workspace.agents.map(agentWire),
    canCreateAgent: workspace.canCreateAgent,
  }));
  const wire: AppSnapshotWire = {
    schemaVersion: APP_SHELL_SCHEMA_VERSION,
    revision: snapshot.revision,
    readiness,
    editorHost: editorHostWire(snapshot.editorHost),
    selection: {
      context: contextWire(snapshot.selection.context),
      activity: snapshot.selection.activity,
    },
    activities,
    workspaces,
    sidebar: {
      width: snapshot.sidebar.width,
      visible: snapshot.sidebar.visible,
      expandedWorkspaceIds: [...snapshot.sidebar.expandedWorkspaceIds],
    },
  };
  if (
    wire.sidebar.width < SIDEBAR_MIN_WIDTH ||
    wire.sidebar.width > SIDEBAR_MAX_WIDTH
  ) {
    throw new SnapshotWireError("sidebar width is outside the App Shell range");
  }
  return wire;
}

function closeResourceWire(value: ResourceInspection): CloseResourceWire {
  switch (value.kind) {
    case "clean":
      return { kind: "clean" };
    case "busy":
      return { kind: "busy", count: value.count };
    case "unknown":
      return { kind: "unknown", diagnostic: value.diagnostic };
  }
}

function closeInspectionWire(
  projection: CloseInspectionProjection,
): CloseInspectionWire {
  return {
    workspaceId: projection.workspaceId,
    workspaceLabel: projection.workspaceLabel,
    agents: closeResourceWire(projection.agents),
    terminalProcesses: closeResourceWire(projection.terminalProcesses),
    terminalPanes: closeResourceWire(projection.terminalPanes),
    terminalWindows: closeResourceWire(projection.terminalWindows),
    unsavedEditors: closeResourceWire(projection.unsavedEditors),
  };
}

function confirmationPurposeWire(
  purpose: ConfirmationOutcomePurpose,
): ConfirmationPurposeWire {
  return purpose.kind === "workspace_close"
    ? {
        kind: "workspace_close",
        inspection: closeInspectionWire(purpose.inspection),
      }
    : { kind: "agent_stop" };
}

export function outcomeWire(
  outcome: IntentOutcome,
  readiness: AppReadiness,
): AppOutcomeWire {
  const snapshot = snapshotWire(outcome.snapshot, readiness);
  switch (outcome.kind) {
    case "noop":
      return { kind: "noop", snapshot };
    case "updated":
      return { kind: "updated", snapshot };
    case "confirmation_required":
      return {
        kind: "confirmation_required",
        confirmationId: outcome.confirmationId,
        snapshot,
        purpose: confirmationPurposeWire(outcome.purpose),
      };
    case "deferred":
      return {
        kind: "deferred",
        operationId: outcome.operationId,
        snapshot,
      };
    case "detached":
      return { kind: "detached", snapshot };
    case "persistence_degraded":
      return { kind: "persistence_degraded", snapshot };
  }
}

export function replayWire(
  replay: CoordinatorReplay,
  readiness: AppReadiness,
): ReplayWire {
  const events = replay.events.flatMap((event) => {
    const kind: ReplayEventKindWire | undefined =
      event.event.kind === "snapshot"
        ? "snapshot"
        : event.event.kind === "noop"
          ? "noop"
          : event.event.kind === "error"
            ? "error"
            : event.event.kind === "operation_completed"
              ? "operation_completed"
              : undefined;
    return kind ? [{ sequence: event.sequence, kind }] : [];
  });
  return {
    cursor: replay.cursor,
    historyGap: replay.historyGap,
    snapshot: snapshotWire(replay.snapshot, readiness),
    events,
  };
}

const SAFE_ERROR_SUMMARY: Readonly<Record<AppErrorCodeWire, string>> = {
  invalid_intent: "The requested action is not available.",
  activity_disabled: "This activity is unavailable in the current context.",
  unknown_context: "The selected context is no longer available.",
  workspace_unavailable: "The workspace is unavailable.",
  workspace_closing: "The workspace is already closing.",
  workspace_close_failed: "The workspace could not be closed cleanly.",
  operation_pending: "Another operation is still in progress.",
  persistence_degraded: "Changes could not be saved.",
  native_unavailable: "The native app shell is unavailable.",
  editor_provider_missing: "Visual Studio Code was not found.",
  editor_port_unavailable: "The editor's port is already in use.",
  editor_unavailable: "The editor could not start.",
};

function defaultErrorModule(code: AppErrorCodeWire): AppErrorModuleWire {
  switch (code) {
    case "persistence_degraded":
      return "state";
    case "editor_provider_missing":
    case "editor_port_unavailable":
    case "editor_unavailable":
      return "editor";
    default:
      return "app";
  }
}

const RUNTIME_VERSION_FALLBACK = "0.1.0";
let runtimeVersion = RUNTIME_VERSION_FALLBACK;

/** Stamped once at startup so every error carries the same build identity. */
export function setRuntimeVersion(version: string): void {
  runtimeVersion =
    version.length > 0 ? version.slice(0, 64) : RUNTIME_VERSION_FALLBACK;
}

function truncateDetail(detail: string): string {
  return detail.length <= 4096 ? detail : `${detail.slice(0, 4096)}…`;
}

export function errorWireAt(
  code: AppErrorCodeWire,
  timestampMs = 0,
): AppErrorWire {
  const actions: AppErrorActionWire[] =
    code === "native_unavailable" ||
    code === "persistence_degraded" ||
    code === "editor_provider_missing" ||
    code === "editor_port_unavailable" ||
    code === "editor_unavailable"
      ? ["retry", "open_settings"]
      : ["retry"];
  return {
    code,
    summary: SAFE_ERROR_SUMMARY[code],
    module: defaultErrorModule(code),
    timestampMs: timestampMs === 0 ? Date.now() : timestampMs,
    runtimeVersion,
    actions,
  };
}

export function withDetail(error: AppErrorWire, detail: string): AppErrorWire {
  return detail.length === 0
    ? error
    : { ...error, detail: truncateDetail(detail) };
}

export function withSummary(
  error: AppErrorWire,
  summary: string,
): AppErrorWire {
  return {
    ...error,
    summary: summary.length === 0 ? SAFE_ERROR_SUMMARY[error.code] : summary,
  };
}

export function nativeUnavailable(): AppErrorWire {
  return errorWireAt("native_unavailable");
}

/**
 * Turn any failure into the stable algebra the App Shell renders.
 *
 * A failure that is not an `AppError` is a broken invariant, not a user-facing
 * condition — it becomes `native_unavailable` with its message as the detail,
 * so it is visible rather than swallowed, and the summary stays a sentence the
 * reader can act on.
 */
export function errorWire(error: unknown): AppErrorWire {
  if (!(error instanceof AppError)) {
    return withDetail(
      errorWireAt("native_unavailable"),
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
  let code: AppErrorCodeWire;
  switch (error.code) {
    case AppErrorCode.Domain:
      switch (error.domainCode) {
        case DomainErrorCode.ActivityDisabled:
          code = "activity_disabled";
          break;
        case DomainErrorCode.UnknownWorkspace:
        case DomainErrorCode.UnknownAgent:
          code = "unknown_context";
          break;
        case DomainErrorCode.WorkspaceUnavailable:
          code = "workspace_unavailable";
          break;
        case DomainErrorCode.WorkspaceClosing:
          code = "workspace_closing";
          break;
        case DomainErrorCode.WorkspaceClosingFailed:
          code = "workspace_close_failed";
          break;
        default:
          code = "invalid_intent";
      }
      break;
    case AppErrorCode.ConfirmationRequired:
    case AppErrorCode.OperationInProgress:
    case AppErrorCode.OperationGenerationExhausted:
      code = "operation_pending";
      break;
    case AppErrorCode.PersistenceDegraded:
      code = "persistence_degraded";
      break;
    case AppErrorCode.PortUnavailable:
      code = "native_unavailable";
      break;
    default:
      code = "invalid_intent";
  }
  return errorWireAt(code);
}

/** A wire intent that carries no valid domain command. */
export class InvalidIntent extends Error {
  constructor() {
    super("INVALID_INTENT");
    this.name = "InvalidIntent";
  }
}

function invalid(): never {
  throw new InvalidIntent();
}

function tryParse<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DomainError) {
      invalid();
    }
    throw error;
  }
}

/**
 * Decode one wire intent into a domain command.
 *
 * Everything the page can send is validated here, once, before it reaches the
 * coordinator: an identity that is not a canonical UUID, a slug that is not a
 * slug, a width outside the sidebar range are all rejected at this line rather
 * than somewhere deeper with less context.
 */
export function intentFromWire(wire: AppIntentWire): UserIntent {
  switch (wire.type) {
    case "select_context": {
      const context = wire.context;
      switch (context.kind) {
        case "global":
          return { type: "select_context", context: { kind: "global" } };
        case "workspace":
          return {
            type: "select_context",
            context: {
              kind: "workspace",
              workspaceId: tryParse(() =>
                parseWorkspaceId(context.workspaceId),
              ),
            },
          };
        case "agent":
          return {
            type: "select_context",
            context: {
              kind: "agent",
              agentId: tryParse(() => parseAgentId(context.agentId)),
            },
          };
      }
      break;
    }
    case "select_activity":
      return { type: "select_activity", activity: wire.activity };
    case "toggle_workspace_disclosure":
      return {
        type: "toggle_workspace_disclosure",
        workspaceId: tryParse(() => parseWorkspaceId(wire.workspaceId)),
        expanded: wire.expanded,
      };
    case "resize_sidebar":
      if (
        !Number.isInteger(wire.width) ||
        wire.width < SIDEBAR_MIN_WIDTH ||
        wire.width > SIDEBAR_MAX_WIDTH
      ) {
        invalid();
      }
      return { type: "resize_sidebar", width: wire.width };
    case "set_sidebar_visible":
      if (typeof wire.visible !== "boolean") {
        invalid();
      }
      return { type: "set_sidebar_visible", visible: wire.visible };
    case "open_workspace_picker":
      // The picker is a shell-side dialog; it never reaches the model.
      return invalid();
    case "retry_workspace":
      return {
        type: "retry_workspace",
        workspaceId: tryParse(() => parseWorkspaceId(wire.workspaceId)),
      };
    case "locate_workspace":
      return {
        type: "locate_workspace",
        workspaceId: tryParse(() => parseWorkspaceId(wire.workspaceId)),
        path: tryParse(() => requestedPath(wire.path)),
      };
    case "request_close_workspace":
      return {
        type: "request_close_workspace",
        workspaceId: tryParse(() => parseWorkspaceId(wire.workspaceId)),
      };
    case "confirm_close_workspace":
      return {
        type: "confirm_close_workspace",
        confirmationId: tryParse(() =>
          parseConfirmationId(wire.confirmationId),
        ),
      };
    case "retry_close_workspace":
      return {
        type: "retry_close_workspace",
        workspaceId: tryParse(() => parseWorkspaceId(wire.workspaceId)),
      };
    case "request_create_agent":
      return {
        type: "create_agent",
        workspaceId: tryParse(() => parseWorkspaceId(wire.workspaceId)),
        profileId: tryParse(() => parseAgentProfileId(wire.profileId)),
      };
    case "rename_agent": {
      const displayName = wire.displayName;
      if (
        displayName.trim().length === 0 ||
        displayName.includes("\0") ||
        [...displayName].length > 256
      ) {
        invalid();
      }
      return {
        type: "rename_agent",
        agentId: tryParse(() => parseAgentId(wire.agentId)),
        displayName,
      };
    }
    case "stop_agent":
      return {
        type: "stop_agent",
        agentId: tryParse(() => parseAgentId(wire.agentId)),
      };
    case "confirm_stop_agent":
      return {
        type: "confirm_stop_agent",
        confirmationId: tryParse(() =>
          parseConfirmationId(wire.confirmationId),
        ),
      };
    case "retry_stop_agent":
      return {
        type: "retry_stop_agent",
        agentId: tryParse(() => parseAgentId(wire.agentId)),
      };
    case "reconcile_agent":
      return {
        type: "reconcile_agent",
        agentId: tryParse(() => parseAgentId(wire.agentId)),
      };
  }
  return invalid();
}
