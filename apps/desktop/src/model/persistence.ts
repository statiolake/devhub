/**
 * DevHub's own state on disk: `state.json` under the app's user-data dir.
 *
 * A port of `crates/devhub-app-core/src/state/mod.rs`. The record shapes are
 * the Rust ones (snake_case, `kind`-tagged), so a state file written by either
 * implementation loads in the other. What the store guarantees is unchanged:
 *
 * - a write is atomic (temp file, fsync, rename) and keeps a `.bak` of the last
 *   file that parsed, so a crash mid-write cannot lose the previous state;
 * - a corrupt file is quarantined rather than deleted, and the load says so;
 * - a file from a newer schema is an error, never a silent downgrade;
 * - the whole document is validated before any of it is adopted.
 *
 * The `tmux` section is what makes a terminal outlive the app. A DevHub
 * terminal is a client attached to a tmux session on DevHub's own socket, so
 * the durable facts are which socket is in effect and which sessions DevHub
 * created — and, if a socket change was interrupted, which phase it stopped in,
 * so the next launch can finish it instead of stranding sessions on a socket
 * nothing points at any more.
 */

import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  Agent,
  AgentProfile,
  agentProfileId as parseAgentProfileId,
  agentId as parseAgentId,
  workspaceId as parseWorkspaceId,
  cleanupProgress,
  cleanupProgressAfterAgents,
  displayPath,
  isCanonicalUuid,
  isEnvironmentName,
  isSlug,
  validDisplayName,
  Workspace,
  workspaceRoot,
  type AgentControlState,
  type AgentProfileKind,
  type AgentStatus,
  type RuntimeHealth,
} from "./domain.js";
import {
  AppModel,
  SIDEBAR_DEFAULT_WIDTH,
  SPLIT_DEFAULT_RATIO,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
} from "./appModel.js";

/**
 * Version 2 retired `navigation.activity` and added `split`.
 *
 * A version-1 file still loads: the activity is a field this build has no use
 * for and drops on the next save, and a missing `split` is the default ratio.
 * The bump is for the other direction — an older DevHub reading a file written
 * here would find no activity to restore and would have to invent one, and
 * refusing is the guarantee this number exists to make.
 *
 * `sidebar.expanded` was retired *without* a bump, for the same reason the
 * activity needed one and this does not. It is read like the activity — a
 * field this build has no use for, ignored on load and dropped on the next
 * save — and in the other direction a build that still collapses the sidebar
 * finds the field missing, which it already reads as "expanded", the only
 * state there is now. Nothing has to be invented, so nothing has to refuse.
 */
export const STATE_SCHEMA_VERSION = 2;
export { SIDEBAR_DEFAULT_WIDTH };

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 400;
const DEFAULT_WINDOW_WIDTH = 1200;
const DEFAULT_WINDOW_HEIGHT = 800;
const MAX_AGENT_NAME_BYTES = 512;
const MAX_AGENT_PROFILE_ARGS = 128;
const MAX_AGENT_PROFILE_ARG_BYTES = 4096;
const MAX_AGENT_PROFILE_ENV_ENTRIES = 128;
const MAX_AGENT_PROFILE_ENV_KEY_BYTES = 256;
const MAX_AGENT_PROFILE_ENV_VALUE_BYTES = 16384;
const MAX_AGENT_PROFILE_SNAPSHOT_BYTES = 256 * 1024;
const MAX_OPAQUE_MAPPING_BYTES = 4096;

export type StateErrorCode =
  | "STATE_IO"
  | "STATE_PERMISSION_DENIED"
  | "STATE_UNSAFE_PATH"
  | "STATE_CORRUPT"
  | "STATE_INVALID"
  | "STATE_NEWER_VERSION"
  | "STATE_INVALID_TRANSITION"
  | "STATE_CANCELLED";

export class StateError extends Error {
  constructor(readonly code: StateErrorCode) {
    super(code);
    this.name = "StateError";
  }
}

function fail(code: StateErrorCode): never {
  throw new StateError(code);
}

export type RecoveryReason =
  | "missing"
  | "corrupt_primary"
  | "corrupt_primary_and_backup";
export type StateOrigin = "primary" | "backup" | "fresh";

export interface LoadMetadata {
  readonly origin: StateOrigin;
  readonly recoveryReason?: RecoveryReason;
  readonly primaryQuarantined: boolean;
  readonly backupQuarantined: boolean;
  readonly migrated: boolean;
}

export interface StateLoad {
  readonly state: PersistedAppState;
  readonly metadata: LoadMetadata;
}

export type NavigationContextRecord =
  | { kind: "global" }
  | { kind: "workspace"; workspace_id: string }
  | { kind: "agent"; agent_id: string };

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface SidebarState {
  width: number;
}

export interface ShutdownMetadata {
  clean: boolean;
  launch_generation: number;
}

export type PersistedAgentControlState =
  | { kind: "running" }
  | { kind: "stopping" }
  | { kind: "stop_failed"; diagnostic: PersistedDiagnosticCode };

export type PersistedDiagnosticCode =
  | "root_missing"
  | "root_inaccessible"
  | "close_agents_unknown"
  | "close_terminal_unknown"
  | "close_editor_unknown"
  | "close_editor_vetoed"
  | "cleanup_failed"
  | "runtime_unavailable";

export interface PersistedCleanupProgress {
  agents_closed: number;
  agents_step_completed: boolean;
  terminal_closed: boolean;
  editor_closed: boolean;
}

export type WorkspaceLifecycleRecord =
  | { kind: "available" }
  | { kind: "unavailable"; reason: PersistedDiagnosticCode }
  | { kind: "closing"; progress: PersistedCleanupProgress }
  | {
      kind: "closing_failed";
      diagnostic: PersistedDiagnosticCode;
      progress: PersistedCleanupProgress;
    };

export interface AgentStateRecord {
  agent_id: string;
  workspace_id: string;
  profile_id: string;
  profile_kind?: AgentProfileKind;
  profile_display_name?: string;
  /** The program the Agent was launched with, as it was at launch. */
  profile_command?: string;
  profile_args?: string[];
  profile_env?: Record<string, string>;
  ordinal: number;
  temporary_name?: string;
  status: AgentStatus;
  unread?: boolean;
  runtime_health: RuntimeHealth;
  control_state: PersistedAgentControlState;
  /** An adapter's own identity for this Agent. Opaque and never interpreted. */
  provider_mapping?: string;
}

export interface WorkspaceStateRecord {
  workspace_id: string;
  selected_path: string;
  canonical_path: string;
  repository_id?: string;
  /**
   * There is deliberately no `issue_url` here any more.
   *
   * DevHub used to write down which Issue a workspace was assigned. A record
   * cannot follow a checkout, so a workspace assigned Issue 128 and then
   * switched to `master` went on claiming 128 — wrong at exactly the moment
   * somebody needed it right. The branch that is checked out is the fact now,
   * read fresh every poll, and nothing about the link is stored.
   *
   * A `state.json` written by an older DevHub still has the key. It is not
   * read and not validated, so it is ignored on load and simply absent from
   * the next file written — no migration, because there is nothing to carry.
   */
  lifecycle: WorkspaceLifecycleRecord;
  agents: AgentStateRecord[];
}

export interface NavigationState {
  context: NavigationContextRecord;
}

/** Where the divider sits when an Agent is selected. */
export interface SplitState {
  ratio: number;
}

export interface WindowState {
  frame: WindowFrame;
}

/**
 * A tmux session DevHub created, and can therefore close.
 *
 * The only durable record of a tmux resource. A session DevHub did not create
 * is counted and never named, so it can never become a kill target after a
 * crash — which is why this is a record of ownership rather than a listing.
 */
export type OwnedSessionRecord =
  | { kind: "scratch"; session_name: string }
  | { kind: "workspace"; workspace_id: string; session_name: string };

export type CleanupSessionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "conflict";
export type RecreationSessionStatus = "pending" | "completed" | "failed";

export type SocketTargetPreflightState =
  | "not_checked"
  | "target_absent"
  | "target_devhub_empty"
  | "wrong_marker"
  | "marked_sessions";

/**
 * Where a socket change got to.
 *
 * A change moves every DevHub session from one socket to another, and each
 * phase is persisted before it is attempted, so an app that dies in the middle
 * knows on the next launch what it had already done. `stable` is the state
 * every healthy run is in.
 */
export type SocketTransitionState =
  | { kind: "stable" }
  | {
      kind: "pending";
      requested_socket_name: string;
      required: OwnedSessionRecord[];
      preflight: SocketTargetPreflightState;
      verified_old_sessions?: OwnedSessionRecord[];
    }
  | {
      kind: "cleaning_old";
      old_socket_name: string;
      requested_socket_name: string;
      required: OwnedSessionRecord[];
      target_preflight: SocketTargetPreflightState;
      sessions: { session: OwnedSessionRecord; status: CleanupSessionStatus }[];
    }
  | {
      kind: "old_cleaned";
      old_socket_name: string;
      new_socket_name: string;
      required: OwnedSessionRecord[];
    }
  | {
      kind: "recreation_pending";
      effective_socket_name: string;
      required: OwnedSessionRecord[];
      sessions: {
        session: OwnedSessionRecord;
        status: RecreationSessionStatus;
      }[];
    };

export interface TmuxState {
  effective_socket_name: string;
  transition: SocketTransitionState;
}

export const DEFAULT_TMUX_SOCKET_NAME = "devhub";

export interface PersistedAppState {
  schema_version: number;
  workspaces: WorkspaceStateRecord[];
  navigation: NavigationState;
  sidebar: SidebarState;
  split: SplitState;
  window: WindowState;
  tmux: TmuxState;
  shutdown: ShutdownMetadata;
}

export function freshState(): PersistedAppState {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    workspaces: [],
    navigation: { context: { kind: "global" } },
    sidebar: { width: SIDEBAR_DEFAULT_WIDTH },
    split: { ratio: SPLIT_DEFAULT_RATIO },
    window: {
      frame: {
        x: 0,
        y: 0,
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
        maximized: false,
      },
    },
    tmux: {
      effective_socket_name: DEFAULT_TMUX_SOCKET_NAME,
      transition: { kind: "stable" },
    },
    shutdown: { clean: true, launch_generation: 0 },
  };
}

// ------------------------------------------------------------- validation

function validateUuid(value: string): void {
  if (!isCanonicalUuid(value)) {
    fail("STATE_INVALID");
  }
}

function validateAbsolutePath(value: string): void {
  if (value.length === 0 || value.includes("\0") || !value.startsWith("/")) {
    fail("STATE_INVALID");
  }
}

function normalizePathString(value: string): string {
  const parts: string[] = [];
  for (const component of value.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      parts.pop();
      continue;
    }
    parts.push(component);
  }
  return `/${parts.join("/")}`;
}

function validateAgentRecord(record: AgentStateRecord): void {
  validateUuid(record.agent_id);
  validateUuid(record.workspace_id);
  if (!isSlug(record.profile_id)) {
    fail("STATE_INVALID");
  }
  if (!Number.isInteger(record.ordinal) || record.ordinal === 0) {
    fail("STATE_INVALID");
  }
  if (
    record.profile_command !== undefined &&
    (record.profile_command.trim().length === 0 ||
      record.profile_command.includes("\0") ||
      Buffer.byteLength(record.profile_command, "utf8") >
        MAX_AGENT_PROFILE_ARG_BYTES)
  ) {
    fail("STATE_INVALID");
  }
  for (const name of [record.temporary_name, record.profile_display_name]) {
    if (name === undefined) continue;
    if (
      !validDisplayName(name) ||
      Buffer.byteLength(name, "utf8") > MAX_AGENT_NAME_BYTES
    ) {
      fail("STATE_INVALID");
    }
  }
  if (record.profile_args) {
    if (
      record.profile_args.length > MAX_AGENT_PROFILE_ARGS ||
      record.profile_args.some(
        (argument) =>
          Buffer.byteLength(argument, "utf8") > MAX_AGENT_PROFILE_ARG_BYTES ||
          argument.includes("\0"),
      )
    ) {
      fail("STATE_INVALID");
    }
  }
  if (record.profile_env) {
    const entries = Object.entries(record.profile_env);
    if (
      entries.length > MAX_AGENT_PROFILE_ENV_ENTRIES ||
      entries.some(
        ([key, value]) =>
          key.length === 0 ||
          Buffer.byteLength(key, "utf8") > MAX_AGENT_PROFILE_ENV_KEY_BYTES ||
          Buffer.byteLength(value, "utf8") >
            MAX_AGENT_PROFILE_ENV_VALUE_BYTES ||
          key.includes("\0") ||
          value.includes("\0") ||
          !isEnvironmentName(key),
      )
    ) {
      fail("STATE_INVALID");
    }
  }
  const snapshotBytes =
    (record.profile_args ?? []).reduce(
      (total, argument) => total + argument.length,
      0,
    ) +
    Object.entries(record.profile_env ?? {}).reduce(
      (total, [key, value]) => total + key.length + value.length,
      0,
    );
  if (snapshotBytes > MAX_AGENT_PROFILE_SNAPSHOT_BYTES) {
    fail("STATE_INVALID");
  }
  if (record.provider_mapping !== undefined) {
    const mapping = record.provider_mapping;
    if (
      mapping.length === 0 ||
      mapping.length > MAX_OPAQUE_MAPPING_BYTES ||
      mapping.includes("\0")
    ) {
      fail("STATE_INVALID");
    }
  }
}

function validateLifecycle(lifecycle: WorkspaceLifecycleRecord): void {
  if (lifecycle.kind === "closing" || lifecycle.kind === "closing_failed") {
    if (
      lifecycle.progress.editor_closed &&
      !lifecycle.progress.terminal_closed
    ) {
      fail("STATE_INVALID");
    }
  }
}

function validateWorkspaceRecord(record: WorkspaceStateRecord): void {
  validateUuid(record.workspace_id);
  validateAbsolutePath(record.selected_path);
  validateAbsolutePath(record.canonical_path);
  if (record.repository_id !== undefined) {
    validateUuid(record.repository_id);
  }
  const ids = new Set<string>();
  for (const agent of record.agents) {
    validateAgentRecord(agent);
    if (agent.workspace_id !== record.workspace_id || ids.has(agent.agent_id)) {
      fail("STATE_INVALID");
    }
    ids.add(agent.agent_id);
  }
  validateLifecycle(record.lifecycle);
  const progress =
    record.lifecycle.kind === "closing" ||
    record.lifecycle.kind === "closing_failed"
      ? record.lifecycle.progress
      : undefined;
  if (progress && progress.agents_closed > record.agents.length) {
    fail("STATE_INVALID");
  }
}

function isValidSocketName(value: string): boolean {
  return (
    value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

function validateOwnedSession(session: OwnedSessionRecord): void {
  const name = session.session_name;
  if (name.length === 0 || name.length > 256 || name.includes("\0")) {
    fail("STATE_INVALID");
  }
  if (session.kind === "scratch") {
    if (name !== "scratch") fail("STATE_INVALID");
    return;
  }
  validateUuid(session.workspace_id);
  // A workspace session is named from a digest of its canonical root, which is
  // what lets the name be rebuilt from the snapshot after a crash.
  const digest = name.startsWith("ws-") ? name.slice(3) : undefined;
  if (
    digest === undefined ||
    (digest.length !== 20 && digest.length !== 32) ||
    !/^[0-9a-f]+$/.test(digest)
  ) {
    fail("STATE_INVALID");
  }
}

/**
 * A required set is exactly one scratch session plus one per workspace, with
 * no duplicate names — the same shape the runtime rebuilds from the snapshot.
 */
function validateRequiredSet(sessions: readonly OwnedSessionRecord[]): void {
  const names = new Set<string>();
  let scratch = 0;
  const workspaces = new Set<string>();
  for (const session of sessions) {
    validateOwnedSession(session);
    if (names.has(session.session_name)) fail("STATE_INVALID");
    names.add(session.session_name);
    if (session.kind === "scratch") scratch += 1;
    else workspaces.add(session.workspace_id);
  }
  if (scratch !== 1 || workspaces.size + 1 !== sessions.length) {
    fail("STATE_INVALID");
  }
}

function requiredOf(
  transition: SocketTransitionState,
): readonly OwnedSessionRecord[] | undefined {
  return transition.kind === "stable" ? undefined : transition.required;
}

function validateTmux(
  tmux: TmuxState,
  workspaceIds: ReadonlySet<string>,
): void {
  if (!isValidSocketName(tmux.effective_socket_name)) fail("STATE_INVALID");
  const transition = tmux.transition;
  switch (transition.kind) {
    case "stable":
      break;
    case "pending": {
      if (!isValidSocketName(transition.requested_socket_name)) {
        fail("STATE_INVALID");
      }
      if (transition.requested_socket_name === tmux.effective_socket_name) {
        fail("STATE_INVALID");
      }
      validateRequiredSet(transition.required);
      if (transition.verified_old_sessions) {
        // Old sessions are only inventoried once the target is known good.
        if (
          transition.preflight !== "target_absent" &&
          transition.preflight !== "target_devhub_empty"
        ) {
          fail("STATE_INVALID");
        }
        const names = new Set<string>();
        for (const session of transition.verified_old_sessions) {
          validateOwnedSession(session);
          if (names.has(session.session_name)) fail("STATE_INVALID");
          names.add(session.session_name);
        }
      }
      break;
    }
    case "cleaning_old": {
      if (
        !isValidSocketName(transition.old_socket_name) ||
        !isValidSocketName(transition.requested_socket_name) ||
        transition.old_socket_name === transition.requested_socket_name ||
        tmux.effective_socket_name !== transition.old_socket_name
      ) {
        fail("STATE_INVALID");
      }
      validateRequiredSet(transition.required);
      const names = new Set<string>();
      for (const record of transition.sessions) {
        validateOwnedSession(record.session);
        if (names.has(record.session.session_name)) fail("STATE_INVALID");
        names.add(record.session.session_name);
      }
      break;
    }
    case "old_cleaned": {
      if (
        !isValidSocketName(transition.old_socket_name) ||
        !isValidSocketName(transition.new_socket_name) ||
        transition.old_socket_name === transition.new_socket_name ||
        tmux.effective_socket_name !== transition.old_socket_name
      ) {
        fail("STATE_INVALID");
      }
      validateRequiredSet(transition.required);
      break;
    }
    case "recreation_pending": {
      if (
        !isValidSocketName(transition.effective_socket_name) ||
        tmux.effective_socket_name !== transition.effective_socket_name
      ) {
        fail("STATE_INVALID");
      }
      validateRequiredSet(transition.required);
      const wanted = new Set(
        transition.required.map((session) => session.session_name),
      );
      const listed = new Set(
        transition.sessions.map((record) => record.session.session_name),
      );
      if (
        wanted.size !== listed.size ||
        [...wanted].some((name) => !listed.has(name))
      ) {
        fail("STATE_INVALID");
      }
      break;
    }
  }

  // A transition's required set names the workspaces the snapshot has. If they
  // disagree, one of the two is from a different run and neither can be
  // trusted to say which sessions DevHub owns.
  const required = requiredOf(transition);
  if (required) {
    const named = new Set(
      required
        .filter((session) => session.kind === "workspace")
        .map((session) => (session as { workspace_id: string }).workspace_id),
    );
    if (
      named.size !== workspaceIds.size ||
      [...named].some((id) => !workspaceIds.has(id))
    ) {
      fail("STATE_INVALID");
    }
  }
}

export function validateState(state: PersistedAppState): void {
  if (state.schema_version !== STATE_SCHEMA_VERSION) {
    fail("STATE_NEWER_VERSION");
  }
  const workspaceIds = new Set<string>();
  const canonicalPaths = new Set<string>();
  const agentIds = new Set<string>();
  for (const workspace of state.workspaces) {
    validateWorkspaceRecord(workspace);
    const canonical = normalizePathString(workspace.canonical_path);
    if (
      workspaceIds.has(workspace.workspace_id) ||
      canonicalPaths.has(canonical)
    ) {
      fail("STATE_INVALID");
    }
    workspaceIds.add(workspace.workspace_id);
    canonicalPaths.add(canonical);
    for (const agent of workspace.agents) {
      if (agentIds.has(agent.agent_id)) {
        fail("STATE_INVALID");
      }
      agentIds.add(agent.agent_id);
    }
  }
  if (
    state.sidebar.width < MIN_SIDEBAR_WIDTH ||
    state.sidebar.width > MAX_SIDEBAR_WIDTH ||
    state.split.ratio < SPLIT_MIN_RATIO ||
    state.split.ratio > SPLIT_MAX_RATIO
  ) {
    fail("STATE_INVALID");
  }
  const frame = state.window.frame;
  if (
    frame.width === 0 ||
    frame.height === 0 ||
    frame.width > 32768 ||
    frame.height > 32768
  ) {
    fail("STATE_INVALID");
  }
  const context = state.navigation.context;
  if (context.kind === "workspace") validateUuid(context.workspace_id);
  if (context.kind === "agent") validateUuid(context.agent_id);
  validateTmux(state.tmux, workspaceIds);
}

// -------------------------------------------------------------- projection

function progressFrom(record: PersistedCleanupProgress) {
  return record.agents_step_completed
    ? cleanupProgressAfterAgents(
        record.agents_closed,
        record.terminal_closed,
        record.editor_closed,
      )
    : cleanupProgress(
        record.agents_closed,
        record.terminal_closed,
        record.editor_closed,
      );
}

function controlStateFrom(
  record: PersistedAgentControlState,
): AgentControlState {
  return record.kind === "stop_failed"
    ? { kind: "stop-failed", diagnostic: record.diagnostic }
    : { kind: record.kind };
}

function controlStateTo(state: AgentControlState): PersistedAgentControlState {
  return state.kind === "stop-failed"
    ? { kind: "stop_failed", diagnostic: state.diagnostic }
    : { kind: state.kind };
}

/**
 * The profile an Agent was launched with.
 *
 * The record's own snapshot wins over the configured profile, because the
 * Agent was started with those arguments and a later config edit must not
 * rewrite what a running session was given.
 */
function launchProfile(
  record: AgentStateRecord,
  fallback: AgentProfile | undefined,
): AgentProfile {
  const kind = record.profile_kind ?? fallback?.kind;
  const displayName = record.profile_display_name ?? fallback?.displayName;
  // A record written before profiles carried a command names its kind, which
  // is exactly what that kind's command defaulted to.
  const command = record.profile_command ?? fallback?.command ?? kind;
  const args = record.profile_args ?? fallback?.args;
  const env =
    record.profile_env !== undefined
      ? new Map(Object.entries(record.profile_env))
      : fallback?.env;
  if (
    kind === undefined ||
    displayName === undefined ||
    command === undefined ||
    args === undefined ||
    env === undefined
  ) {
    fail("STATE_INVALID");
  }
  try {
    return AgentProfile.create(
      parseAgentProfileId(record.profile_id),
      displayName,
      kind,
      command,
      args,
      env,
    );
  } catch {
    return fail("STATE_INVALID");
  }
}

/**
 * Build the live model from a saved state and the configured profiles.
 *
 * An Agent whose profile is no longer configured is not dropped: it comes back
 * as Waiting with an unavailable runtime, because the session may still exist
 * and pretending it never did would lose it silently.
 */
export function hydrateModel(
  state: PersistedAppState,
  profiles: readonly AgentProfile[],
): AppModel {
  validateState(state);
  const profileById = new Map<string, AgentProfile>();
  for (const profile of profiles) {
    const previous = profileById.get(profile.id);
    if (previous && !previous.equals(profile)) {
      fail("STATE_INVALID");
    }
    profileById.set(profile.id, profile);
  }

  const model = new AppModel();
  for (const record of state.workspaces) {
    let id, root, selected;
    try {
      id = parseWorkspaceId(record.workspace_id);
      root = workspaceRoot(record.canonical_path);
      selected = displayPath(record.selected_path);
    } catch {
      return fail("STATE_INVALID");
    }
    try {
      model.addWorkspace(new Workspace(id, root, selected));
    } catch {
      return fail("STATE_INVALID");
    }
    try {
      switch (record.lifecycle.kind) {
        case "available":
          break;
        case "unavailable":
          model.markWorkspaceUnavailable(id, record.lifecycle.reason);
          break;
        case "closing":
          model.markWorkspaceClosing(
            id,
            progressFrom(record.lifecycle.progress),
          );
          break;
        case "closing_failed":
          model.markWorkspaceClosingFailed(
            id,
            record.lifecycle.diagnostic,
            progressFrom(record.lifecycle.progress),
          );
          break;
      }
    } catch {
      return fail("STATE_INVALID");
    }

    for (const agentRecord of record.agents) {
      const configured = profileById.get(agentRecord.profile_id);
      const profile = launchProfile(agentRecord, configured);
      const status: AgentStatus = configured ? agentRecord.status : "waiting";
      const runtimeHealth: RuntimeHealth = configured
        ? agentRecord.runtime_health
        : "unavailable";
      try {
        model.restoreAgent({
          id: parseAgentId(agentRecord.agent_id),
          workspaceId: id,
          profile,
          ordinal: agentRecord.ordinal,
          temporaryName: agentRecord.temporary_name,
          status,
          unread: agentRecord.unread === true,
          runtimeHealth,
          controlState: controlStateFrom(agentRecord.control_state),
        });
      } catch {
        return fail("STATE_INVALID");
      }
    }
  }

  try {
    model.restoreSidebar(state.sidebar.width);
    model.restoreSplitRatio(state.split.ratio);
  } catch {
    return fail("STATE_INVALID");
  }

  const navigation = restoreNavigation(state);
  try {
    switch (navigation.context.kind) {
      case "global":
        model.selectContext({ kind: "global" });
        break;
      case "workspace":
        model.selectContext({
          kind: "workspace",
          workspaceId: parseWorkspaceId(navigation.context.workspace_id),
        });
        break;
      case "agent":
        model.selectContext({
          kind: "agent",
          agentId: parseAgentId(navigation.context.agent_id),
        });
        break;
    }
  } catch {
    return fail("STATE_INVALID");
  }
  return model;
}

export interface NavigationRestore {
  readonly context: NavigationContextRecord;
  readonly changed: boolean;
}

/**
 * Where the app opens when the thing it was last looking at is gone.
 *
 * A missing Agent falls to the next Agent in its Workspace, then to the
 * Workspace, then to Global — the same walk the model does when an Agent exits
 * while the app is running, so a restart lands where a live removal would have.
 */
export function restoreNavigation(
  state: PersistedAppState,
  liveWorkspaceIds?: ReadonlySet<string>,
  liveAgentIds?: ReadonlySet<string>,
): NavigationRestore {
  validateState(state);
  const workspaces =
    liveWorkspaceIds ??
    new Set(state.workspaces.map((workspace) => workspace.workspace_id));
  const agents =
    liveAgentIds ??
    new Set(
      state.workspaces.flatMap((workspace) =>
        workspace.agents.map((agent) => agent.agent_id),
      ),
    );
  const global: NavigationRestore = {
    context: { kind: "global" },
    changed: true,
  };
  const context = state.navigation.context;
  switch (context.kind) {
    case "global":
      return { ...global, changed: false };
    case "workspace":
      return workspaces.has(context.workspace_id)
        ? { context, changed: false }
        : global;
    case "agent": {
      if (agents.has(context.agent_id)) {
        return { context, changed: false };
      }
      const owner = state.workspaces.find((workspace) =>
        workspace.agents.some((agent) => agent.agent_id === context.agent_id),
      );
      if (!owner || !workspaces.has(owner.workspace_id)) {
        return global;
      }
      const index = owner.agents.findIndex(
        (agent) => agent.agent_id === context.agent_id,
      );
      const next = owner.agents
        .slice(index + 1)
        .find((agent) => agents.has(agent.agent_id));
      return next
        ? { context: { kind: "agent", agent_id: next.agent_id }, changed: true }
        : {
            context: { kind: "workspace", workspace_id: owner.workspace_id },
            changed: true,
          };
    }
  }
}

/** Project the live model back into records, ready to write. */
export function stateFromSnapshot(
  snapshot: import("./appModel.js").AppSnapshot,
): PersistedAppState {
  const state: PersistedAppState = {
    ...freshState(),
    workspaces: snapshot.workspaces.map((workspace) => ({
      workspace_id: workspace.id,
      selected_path: workspace.selectedPath,
      canonical_path: workspace.root,
      repository_id: workspace.repositoryId,
      lifecycle: lifecycleFrom(workspace.state),
      agents: workspace.agents.map((agent) => ({
        agent_id: agent.id,
        workspace_id: agent.workspaceId,
        profile_id: agent.profileId,
        profile_kind: agent.profileKind,
        profile_display_name: agent.profileDisplayName,
        profile_command: agent.profile.command,
        profile_args: [...agent.profile.args],
        profile_env: Object.fromEntries(agent.profile.env),
        ordinal: agent.ordinal,
        temporary_name: agent.displayName,
        status: agent.status,
        unread: agent.unread,
        runtime_health: agent.runtimeHealth,
        control_state: controlStateTo(agent.controlState),
      })),
    })),
    navigation: { context: contextRecord(snapshot.selection.context) },
    sidebar: { width: snapshot.sidebar.width },
    split: { ratio: snapshot.splitRatio },
  };
  validateState(state);
  return state;
}

/**
 * Re-project the model onto an existing state, keeping the fields the model
 * does not own: the adapter's provider mapping for each Agent.
 */
export function applySnapshot(
  state: PersistedAppState,
  snapshot: import("./appModel.js").AppSnapshot,
): PersistedAppState {
  const projected = stateFromSnapshot(snapshot);
  for (const workspace of projected.workspaces) {
    const previous = state.workspaces.find(
      (candidate) => candidate.workspace_id === workspace.workspace_id,
    );
    if (!previous) continue;
    for (const agent of workspace.agents) {
      const previousAgent = previous.agents.find(
        (candidate) => candidate.agent_id === agent.agent_id,
      );
      if (!previousAgent) continue;
      agent.provider_mapping = previousAgent.provider_mapping;
    }
  }
  const next: PersistedAppState = {
    ...state,
    workspaces: projected.workspaces,
    navigation: projected.navigation,
    sidebar: projected.sidebar,
    split: projected.split,
  };
  validateState(next);
  return next;
}

function contextRecord(
  context: import("./domain.js").NavigationContext,
): NavigationContextRecord {
  switch (context.kind) {
    case "global":
      return { kind: "global" };
    case "workspace":
      return { kind: "workspace", workspace_id: context.workspaceId };
    case "agent":
      return { kind: "agent", agent_id: context.agentId };
  }
}

function lifecycleFrom(
  state: import("./domain.js").WorkspaceState,
): WorkspaceLifecycleRecord {
  switch (state.kind) {
    case "available":
      return { kind: "available" };
    case "unavailable":
      return { kind: "unavailable", reason: state.reason };
    case "closing":
      return { kind: "closing", progress: progressRecord(state.progress) };
    case "closing-failed":
      return {
        kind: "closing_failed",
        diagnostic: state.diagnostic,
        progress: progressRecord(state.progress),
      };
  }
}

function progressRecord(
  progress: import("./domain.js").CleanupProgress,
): PersistedCleanupProgress {
  return {
    agents_closed: progress.agentsClosed,
    agents_step_completed: progress.agentsStepCompleted,
    terminal_closed: progress.terminalClosed,
    editor_closed: progress.editorClosed,
  };
}

export function markStarting(state: PersistedAppState): boolean {
  const previousGeneration = state.shutdown.launch_generation;
  const wasClean = state.shutdown.clean;
  state.shutdown.clean = false;
  state.shutdown.launch_generation += 1;
  return wasClean || state.shutdown.launch_generation !== previousGeneration;
}

export function markCleanShutdown(state: PersistedAppState): boolean {
  if (state.shutdown.clean) {
    return false;
  }
  state.shutdown.clean = true;
  return true;
}

// ------------------------------------------------------------------- store

type Candidate =
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "bytes"; bytes: Buffer };

function mapIoError(error: unknown): StateError {
  if (
    error instanceof Error &&
    "code" in error &&
    (error as { code: unknown }).code === "EACCES"
  ) {
    return new StateError("STATE_PERMISSION_DENIED");
  }
  return new StateError("STATE_IO");
}

async function readCandidate(path: string): Promise<Candidate> {
  let stats;
  try {
    stats = await stat(path, { bigint: false });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: unknown }).code === "ENOENT"
    ) {
      return { kind: "missing" };
    }
    throw mapIoError(error);
  }
  if (!stats.isFile()) {
    return { kind: "unsafe" };
  }
  if ((stats.mode & 0o077) !== 0) {
    return { kind: "unsafe" };
  }
  try {
    return { kind: "bytes", bytes: await readFile(path) };
  } catch (error) {
    throw mapIoError(error);
  }
}

type DecodeFailure = "corrupt" | "newer_version";

function decodeState(
  bytes: Buffer,
): { state: PersistedAppState; migrated: boolean } | DecodeFailure {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return "corrupt";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "corrupt";
  }
  const object = value as Record<string, unknown>;
  const schema = object["schema_version"];
  const legacy = object["version"];
  let version: number;
  if (typeof schema === "number" && typeof legacy === "number") {
    if (schema !== legacy) return "corrupt";
    version = schema;
  } else if (typeof schema === "number") {
    version = schema;
  } else if (typeof legacy === "number") {
    version = legacy;
  } else {
    return "corrupt";
  }
  if (version > STATE_SCHEMA_VERSION) {
    return "newer_version";
  }
  const migrated = version < STATE_SCHEMA_VERSION || legacy !== undefined;
  const fresh = freshState();
  const state: PersistedAppState = {
    schema_version: STATE_SCHEMA_VERSION,
    workspaces:
      (object["workspaces"] as WorkspaceStateRecord[] | undefined) ?? [],
    navigation:
      (object["navigation"] as NavigationState | undefined) ?? fresh.navigation,
    sidebar: (object["sidebar"] as SidebarState | undefined) ?? fresh.sidebar,
    split: (object["split"] as SplitState | undefined) ?? fresh.split,
    window: (object["window"] as WindowState | undefined) ?? fresh.window,
    tmux: (object["tmux"] as TmuxState | undefined) ?? fresh.tmux,
    shutdown:
      (object["shutdown"] as ShutdownMetadata | undefined) ?? fresh.shutdown,
  };
  try {
    validateState(state);
  } catch (error) {
    return error instanceof StateError && error.code === "STATE_NEWER_VERSION"
      ? "newer_version"
      : "corrupt";
  }
  return { state, migrated };
}

export class JsonStateStore {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  get backupPath(): string {
    return `${this.path}.bak`;
  }

  /** Serialise every write, so two saves cannot interleave their renames. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(work, work);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  loadState(): Promise<StateLoad> {
    return this.serialize(() => this.loadStateLocked());
  }

  async loadOrDefault(): Promise<PersistedAppState> {
    return (await this.loadState()).state;
  }

  saveState(state: PersistedAppState): Promise<void> {
    return this.serialize(() => this.saveStateLocked(state));
  }

  async markStarting(): Promise<PersistedAppState> {
    const state = await this.loadOrDefault();
    markStarting(state);
    await this.saveState(state);
    return state;
  }

  async markCleanShutdown(): Promise<PersistedAppState> {
    const state = await this.loadOrDefault();
    markCleanShutdown(state);
    await this.saveState(state);
    return state;
  }

  private async loadStateLocked(): Promise<StateLoad> {
    const primary = await readCandidate(this.path);
    if (primary.kind === "missing") {
      return this.loadBackupOrFresh("missing", false);
    }
    if (primary.kind === "unsafe") {
      fail("STATE_UNSAFE_PATH");
    }
    const decoded = decodeState(primary.bytes);
    if (decoded === "newer_version") {
      fail("STATE_NEWER_VERSION");
    }
    if (decoded === "corrupt") {
      const quarantined = await quarantine(this.path);
      return this.loadBackupOrFresh("corrupt_primary", quarantined);
    }
    if (decoded.migrated) {
      await this.saveStateLocked(decoded.state);
    }
    return {
      state: decoded.state,
      metadata: {
        origin: "primary",
        primaryQuarantined: false,
        backupQuarantined: false,
        migrated: decoded.migrated,
      },
    };
  }

  private async loadBackupOrFresh(
    reason: RecoveryReason,
    primaryQuarantined: boolean,
  ): Promise<StateLoad> {
    const backup = await readCandidate(this.backupPath);
    if (backup.kind === "unsafe") {
      fail("STATE_UNSAFE_PATH");
    }
    if (backup.kind === "missing") {
      return {
        state: freshState(),
        metadata: {
          origin: "fresh",
          recoveryReason: reason,
          primaryQuarantined,
          backupQuarantined: false,
          migrated: false,
        },
      };
    }
    const decoded = decodeState(backup.bytes);
    if (decoded === "newer_version") {
      fail("STATE_NEWER_VERSION");
    }
    if (decoded === "corrupt") {
      const backupQuarantined = await quarantine(this.backupPath);
      return {
        state: freshState(),
        metadata: {
          origin: "fresh",
          recoveryReason: "corrupt_primary_and_backup",
          primaryQuarantined,
          backupQuarantined,
          migrated: false,
        },
      };
    }
    if (decoded.migrated) {
      await this.saveStateLocked(decoded.state);
    }
    return {
      state: decoded.state,
      metadata: {
        origin: "backup",
        recoveryReason: reason,
        primaryQuarantined,
        backupQuarantined: false,
        migrated: decoded.migrated,
      },
    };
  }

  private async saveStateLocked(state: PersistedAppState): Promise<void> {
    validateState(state);
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify(state, undefined, 2)}\n`;
    const temporary = `${this.path}.tmp.${String(process.pid)}.${String(Date.now())}`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    ).catch((error: unknown) => {
      throw mapIoError(error);
    });
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.prepareBackup();
    try {
      await rename(temporary, this.path);
    } catch (error) {
      throw mapIoError(error);
    }
  }

  /** The `.bak` is only ever a copy of a file that parsed. */
  private async prepareBackup(): Promise<void> {
    const primary = await readCandidate(this.path);
    if (primary.kind === "missing") return;
    if (primary.kind === "unsafe") {
      fail("STATE_UNSAFE_PATH");
    }
    const decoded = decodeState(primary.bytes);
    if (decoded === "newer_version") {
      fail("STATE_NEWER_VERSION");
    }
    if (decoded === "corrupt") {
      await quarantine(this.path);
      return;
    }
    const temporary = `${this.backupPath}.tmp.${String(process.pid)}.${String(Date.now())}`;
    try {
      await copyFile(this.path, temporary, constants.COPYFILE_EXCL);
      await rename(temporary, this.backupPath);
    } catch (error) {
      throw mapIoError(error);
    }
  }
}

/**
 * Move a file that would not parse out of the way instead of deleting it.
 *
 * The user's state is theirs; a corrupt file is evidence and might be
 * recoverable by hand. Returns whether it was moved, because the load result
 * says so and the app can tell the user where it went.
 */
async function quarantine(path: string): Promise<boolean> {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = `${path}.corrupt.${String(suffix)}`;
    try {
      await rename(path, candidate);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code: unknown }).code === "EEXIST"
      ) {
        continue;
      }
      return false;
    }
  }
  return false;
}

/** DevHub's state file, beside the user's other DevHub data. */
export function stateStoreForUserData(userDataDir: string): JsonStateStore {
  return new JsonStateStore(join(userDataDir, "state.json"));
}

export { Agent };
