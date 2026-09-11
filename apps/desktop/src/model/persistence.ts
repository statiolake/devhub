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
 * - the whole document is *decoded* before any of it is adopted: every enum
 *   checked for membership and every number checked for being one, so nothing
 *   the file says reaches the model as a shape the model does not have.
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
  AGENT_PROFILE_KINDS,
  AGENT_STATUSES,
  DIAGNOSTIC_CODES,
  RUNTIME_HEALTHS,
  agentProfileId as parseAgentProfileId,
  agentId as parseAgentId,
  workspaceId as parseWorkspaceId,
  displayPath,
  isCanonicalUuid,
  isEnvironmentName,
  isSlug,
  DomainError,
  validDisplayName,
  Workspace,
  workspaceRoot,
  type AgentControlState,
  type DiagnosticCode,
  type AgentProfileKind,
  type AgentStatus,
  type UnreadReason,
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
 * Version 4 took the close out of the file entirely; version 3 made a close's
 * Agents step one value; version 2 retired
 * `navigation.activity` and added `split`.
 *
 * Older files still load. A version-1 file's activity is a field this build
 * has no use for and drops on the next save, and a missing `split` is the
 * default ratio. A version-2 or version-3 file's `closing` /
 * `closing_failed` lifecycle loads as an ordinary open Workspace, because it
 * was never closed: nothing about a close is written down while it runs any
 * more, and resuming one from a persisted midpoint is what this version exists
 * to stop. Closing it again repeats the steps, which are idempotent, and finds
 * the ones that finished already done.
 *
 * The bump is always for the other direction, and that is the guarantee this
 * number exists to make: an older DevHub reading a file written here would
 * find no activity to restore, or no `agents_step_completed`, and would have
 * to invent one or refuse the file as corrupt — which quarantines the session.
 * `newer_version` is the refusal that does neither.
 *
 * `sidebar.expanded` was retired *without* a bump, for the same reason those
 * needed one and it did not. It is read like the activity — ignored on load,
 * dropped on the next save — and in the other direction a build that still
 * collapses the sidebar finds the field missing, which it already reads as
 * "expanded", the only state there is now. Nothing has to be invented, so
 * nothing has to refuse.
 */
export const STATE_SCHEMA_VERSION = 4;
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

/** What each code means, in the words the person using DevHub gets to read. */
const STATE_ERROR_REASON: Readonly<Record<StateErrorCode, string>> = {
  STATE_IO: "the file could not be written",
  STATE_PERMISSION_DENIED: "permission was denied",
  STATE_UNSAFE_PATH: "the path is not a private regular file",
  STATE_CORRUPT: "the file on disk could not be parsed",
  STATE_INVALID: "the state DevHub was about to write is not valid",
  STATE_NEWER_VERSION: "the file on disk was written by a newer DevHub",
  STATE_INVALID_TRANSITION: "the state changed in a way the store forbids",
  STATE_CANCELLED: "the write was cancelled",
};

/**
 * A failure of the state store, said in full.
 *
 * The code alone is what the app branches on; `describe()` is what a person
 * reads, and it names the file and what happened to it. A message that says
 * only "changes could not be saved" leaves the reader with nothing to check,
 * so the path and the operating system's own words travel with the failure
 * from here to the alert instead of being dropped at the boundary.
 */
export class StateError extends Error {
  readonly path: string | undefined;

  constructor(
    readonly code: StateErrorCode,
    options?: { readonly path?: string; readonly cause?: unknown },
  ) {
    super(
      code,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "StateError";
    this.path = options?.path;
  }

  /**
   * `fallbackPath` is for the failures raised before the store is reached —
   * validation of the record about to be written knows what is wrong but not
   * where it was going, and the caller that holds the store knows the file.
   */
  describe(fallbackPath?: string): string {
    const where = this.path ?? fallbackPath ?? "DevHub's state";
    const cause =
      this.cause instanceof Error && this.cause.message.length > 0
        ? ` (${this.cause.message})`
        : "";
    return `${where}: ${STATE_ERROR_REASON[this.code]}${cause}`;
  }
}

function fail(code: StateErrorCode, path?: string): never {
  throw new StateError(code, { path });
}

/**
 * Refuse a record the *document* got wrong, and let a bug through.
 *
 * Projection used to be six `try { ... } catch { return fail("STATE_INVALID") }`
 * blocks, and `fail` dropped the cause. So a `DomainError` refusing a record, a
 * `TypeError` from a value that slipped past the decoder, and a programming
 * error inside `AppModel.addWorkspace` all came out as "your file is corrupt" —
 * which quarantines the person's session and blames the file for a bug in the
 * code.
 *
 * `DomainError` is the one that genuinely means "this record is not valid":
 * the domain looked at the value and said no. Everything else propagates,
 * because a bug is a crash with the cause attached and not a lost session.
 */
function refuseRecord<T>(where: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof DomainError) {
      throw new StateError("STATE_INVALID", {
        cause: new Error(`${where}: ${error.message}`, { cause: error }),
      });
    }
    throw error;
  }
}

export type RecoveryReason =
  | "missing"
  | "corrupt_primary"
  | "corrupt_primary_and_backup";
export type StateOrigin = "primary" | "backup" | "fresh";

export interface LoadMetadata {
  readonly origin: StateOrigin;
  readonly recoveryReason?: RecoveryReason;
  /**
   * Why the primary file would not load, in the words a person can act on.
   *
   * Present exactly when a file was refused: which field it was and what was
   * in it. `recoveryReason` says *that* the file was rejected; this says what
   * was wrong with it, and without it a quarantined state file is a session
   * that vanished for no stated reason.
   */
  readonly corruptionDetail?: string;
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

/**
 * The same list as the model's, and now literally the same list.
 *
 * It was spelled out twice — once here and once as `DiagnosticCode` — and the
 * decoder needs a membership list, which is exactly the thing two copies of a
 * union cannot safely provide.
 */
export type PersistedDiagnosticCode = DiagnosticCode;

/**
 * A Workspace's availability, and nothing about a close.
 *
 * `closing` and `closing_failed` were here and are gone. A file is only read
 * by a launch that is not the one that wrote it, so a close named in a file is
 * a close nothing is running — and starting one again from its middle is what
 * produced closes that never ended. Version 3's two close variants are still
 * *read* (`decodeLifecycle`), as `available`.
 */
export type WorkspaceLifecycleRecord =
  | { kind: "available" }
  | { kind: "unavailable"; reason: PersistedDiagnosticCode };

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
  /**
   * Why this Agent is owed a look, or absent if it has been read.
   *
   * DevHub used to write `true` here, when entering `waiting` was the only way
   * to become unread. A file from that DevHub loads as `"waiting"` — the
   * reason it would have had — so an old state file comes back saying what it
   * meant, rather than losing the mark or inventing a reason for it.
   */
  unread?: UnreadReason | boolean;
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
  /**
   * The Agent this workspace was last selected in, if any.
   *
   * What `Cmd+Q Cmd+J` comes back to. It is written down because "the Agent I
   * was in here" is a fact about the person, and a restart is exactly when
   * they most want it back. An id whose Agent did not come back is dropped on
   * the first read (`AppModel.lastAgentIn`), and a file from an older DevHub
   * has no key here and loads as "none remembered" — the chord then opens the
   * workspace's first Agent, which is its rule with nothing remembered.
   */
  last_agent_id?: string;
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

function decodeControlState(
  where: string,
  value: unknown,
): PersistedAgentControlState {
  const object = decodeObject(where, value);
  const kind = decodeMember(
    `${where}.kind`,
    object["kind"],
    CONTROL_STATE_KINDS,
  );
  return kind === "stop_failed"
    ? {
        kind,
        diagnostic: decodeDiagnostic(
          `${where}.diagnostic`,
          object["diagnostic"],
        ),
      }
    : { kind };
}

/** See `AgentStateRecord.unread`: `true` is the old spelling of "waiting". */
function unreadFrom(
  value: UnreadReason | boolean | undefined,
): UnreadReason | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  return value === true ? "waiting" : value;
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

function validateWorkspaceRecord(record: WorkspaceStateRecord): void {
  validateUuid(record.workspace_id);
  validateAbsolutePath(record.selected_path);
  validateAbsolutePath(record.canonical_path);
  if (record.repository_id !== undefined) {
    validateUuid(record.repository_id);
  }
  if (record.last_agent_id !== undefined) {
    validateUuid(record.last_agent_id);
  }
  const ids = new Set<string>();
  for (const agent of record.agents) {
    validateAgentRecord(agent);
    if (agent.workspace_id !== record.workspace_id || ids.has(agent.agent_id)) {
      fail("STATE_INVALID");
    }
    ids.add(agent.agent_id);
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
  return refuseRecord(`agent ${record.agent_id}'s profile`, () =>
    AgentProfile.create(
      parseAgentProfileId(record.profile_id),
      displayName,
      kind,
      command,
      args,
      env,
    ),
  );
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
    const where = `workspace ${record.workspace_id}`;
    const { id, root, selected } = refuseRecord(where, () => ({
      id: parseWorkspaceId(record.workspace_id),
      root: workspaceRoot(record.canonical_path),
      selected: displayPath(record.selected_path),
    }));
    refuseRecord(where, () => {
      model.addWorkspace(new Workspace(id, root, selected));
    });
    refuseRecord(`${where}'s lifecycle`, () => {
      switch (record.lifecycle.kind) {
        case "available":
          break;
        case "unavailable":
          model.markWorkspaceUnavailable(id, record.lifecycle.reason);
          break;
      }
    });

    for (const agentRecord of record.agents) {
      const configured = profileById.get(agentRecord.profile_id);
      const profile = launchProfile(agentRecord, configured);
      const status: AgentStatus = configured ? agentRecord.status : "waiting";
      const runtimeHealth: RuntimeHealth = configured
        ? agentRecord.runtime_health
        : "unavailable";
      refuseRecord(`agent ${agentRecord.agent_id}`, () => {
        model.restoreAgent({
          id: parseAgentId(agentRecord.agent_id),
          workspaceId: id,
          profile,
          ordinal: agentRecord.ordinal,
          temporaryName: agentRecord.temporary_name,
          status,
          unread: unreadFrom(agentRecord.unread),
          runtimeHealth,
          controlState: controlStateFrom(agentRecord.control_state),
        });
      });
    }

    if (record.last_agent_id !== undefined) {
      const lastAgentId = record.last_agent_id;
      refuseRecord(`${where}'s last agent`, () => {
        model.restoreLastAgent(id, parseAgentId(lastAgentId));
      });
    }
  }

  refuseRecord("the sidebar and the split", () => {
    model.restoreSidebar(state.sidebar.width);
    model.restoreSplitRatio(state.split.ratio);
  });

  const navigation = restoreNavigation(state);
  refuseRecord("the selection", () => {
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
  });
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
      last_agent_id: workspace.lastAgentId,
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
  }
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

function mapIoError(error: unknown, path: string): StateError {
  const code =
    error instanceof Error &&
    "code" in error &&
    (error as { code: unknown }).code === "EACCES"
      ? "STATE_PERMISSION_DENIED"
      : "STATE_IO";
  return new StateError(code, { path, cause: error });
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
    throw mapIoError(error, path);
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
    throw mapIoError(error, path);
  }
}

// ---------------------------------------------------------------- decoding

/**
 * Where untyped bytes become typed values, and the only place they do.
 *
 * Everything below `decodeState` used to be `as`: `object["sidebar"] as
 * SidebarState` asserted a shape nothing had checked, and the checks that
 * follow are written against the types those assertions claimed. So
 * `"width": "300"` passed `"300" < 200 || "300" > 400` — both false — and
 * reached the model and the wire as a string; `"status": "banana"` hydrated
 * into an Agent whose row drew nothing, arbitrarily far from the file that
 * caused it.
 *
 * The rule here: a decoder that returns `AgentStatus` rejects everything that
 * is not one, and a field typed `number` is `typeof`-checked before anybody
 * compares it. Ranges stay in `validateState` — it already owns them, and one
 * owner per fact is the point — so a decoded document is *well-typed*, and
 * `validateState` then says whether it is *well-formed*.
 *
 * Unknown keys are ignored, deliberately and as before: `navigation.activity`,
 * `sidebar.expanded` and `issue_url` are all fields a past DevHub wrote and
 * this one has no use for, and refusing them would make every retired key a
 * file this build cannot open. What is *present* under a key this build reads
 * has to be what that key means.
 *
 * A refusal names the path and the value, and travels as the `cause` of a
 * `STATE_INVALID` — which `StateError.describe` already renders next to the
 * file name, so the person reading the alert is told which field it was.
 */

/** The offending value, said back short enough to read in one line. */
function render(value: unknown): string {
  if (value === undefined) return "nothing";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function refuse(where: string, expected: string, value: unknown): never {
  throw new StateError("STATE_INVALID", {
    cause: new Error(
      `${where} should be ${expected}, and the file has ${render(value)}`,
    ),
  });
}

function decodeObject(where: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse(where, "an object", value);
  }
  return value as Record<string, unknown>;
}

function decodeArray(where: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) refuse(where, "an array", value);
  return value;
}

function decodeString(where: string, value: unknown): string {
  if (typeof value !== "string") refuse(where, "a string", value);
  return value;
}

function decodeNumber(where: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    refuse(where, "a number", value);
  }
  return value;
}

function decodeBoolean(where: string, value: unknown): boolean {
  if (typeof value !== "boolean") refuse(where, "true or false", value);
  return value;
}

function decodeMember<T extends string>(
  where: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    refuse(where, `one of ${allowed.join(", ")}`, value);
  }
  return value as T;
}

/** A key that may be absent, decoded once into the model's own type. */
function decodeOptional<T>(
  value: unknown,
  decode: (value: unknown) => T,
): T | undefined {
  return value === undefined || value === null ? undefined : decode(value);
}

function decodeStringArray(where: string, value: unknown): string[] {
  return decodeArray(where, value).map((entry, index) =>
    decodeString(`${where}[${index}]`, entry),
  );
}

function decodeStringMap(
  where: string,
  value: unknown,
): Record<string, string> {
  const object = decodeObject(where, value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
    out[key] = decodeString(`${where}.${key}`, entry);
  }
  return out;
}

const CONTROL_STATE_KINDS = ["running", "stopping", "stop_failed"] as const;
/**
 * Every lifecycle a file can name, including the two this build no longer
 * writes. They are decoded so a version-3 file is not refused, and land on
 * `available`: a close named in a file is a close nothing is running.
 */
const LIFECYCLE_KINDS = [
  "available",
  "unavailable",
  "closing",
  "closing_failed",
] as const;
const NAVIGATION_KINDS = ["global", "workspace", "agent"] as const;
const OWNED_SESSION_KINDS = ["scratch", "workspace"] as const;
const CLEANUP_SESSION_STATUSES = [
  "pending",
  "completed",
  "failed",
  "conflict",
] as const;
const RECREATION_SESSION_STATUSES = ["pending", "completed", "failed"] as const;
const SOCKET_TARGET_PREFLIGHT_STATES = [
  "not_checked",
  "target_absent",
  "target_devhub_empty",
  "wrong_marker",
  "marked_sessions",
] as const;
const SOCKET_TRANSITION_KINDS = [
  "stable",
  "pending",
  "cleaning_old",
  "old_cleaned",
  "recreation_pending",
] as const;

function decodeDiagnostic(
  where: string,
  value: unknown,
): PersistedDiagnosticCode {
  return decodeMember(where, value, DIAGNOSTIC_CODES);
}

/** See `AgentStateRecord.unread`: `true` is the old spelling of "waiting". */
function decodeUnread(where: string, value: unknown): UnreadReason | boolean {
  if (typeof value === "boolean") return value;
  return decodeMember(where, value, AGENT_STATUSES);
}

function decodeAgentRecord(where: string, value: unknown): AgentStateRecord {
  const object = decodeObject(where, value);
  const at = (key: string): string => `${where}.${key}`;
  return {
    agent_id: decodeString(at("agent_id"), object["agent_id"]),
    workspace_id: decodeString(at("workspace_id"), object["workspace_id"]),
    profile_id: decodeString(at("profile_id"), object["profile_id"]),
    profile_kind: decodeOptional(object["profile_kind"], (entry) =>
      decodeMember(at("profile_kind"), entry, AGENT_PROFILE_KINDS),
    ),
    profile_display_name: decodeOptional(
      object["profile_display_name"],
      (entry) => decodeString(at("profile_display_name"), entry),
    ),
    profile_command: decodeOptional(object["profile_command"], (entry) =>
      decodeString(at("profile_command"), entry),
    ),
    profile_args: decodeOptional(object["profile_args"], (entry) =>
      decodeStringArray(at("profile_args"), entry),
    ),
    profile_env: decodeOptional(object["profile_env"], (entry) =>
      decodeStringMap(at("profile_env"), entry),
    ),
    ordinal: decodeNumber(at("ordinal"), object["ordinal"]),
    temporary_name: decodeOptional(object["temporary_name"], (entry) =>
      decodeString(at("temporary_name"), entry),
    ),
    status: decodeMember(at("status"), object["status"], AGENT_STATUSES),
    unread: decodeOptional(object["unread"], (entry) =>
      decodeUnread(at("unread"), entry),
    ),
    runtime_health: decodeMember(
      at("runtime_health"),
      object["runtime_health"],
      RUNTIME_HEALTHS,
    ),
    control_state: decodeControlState(
      at("control_state"),
      object["control_state"],
    ),
    provider_mapping: decodeOptional(object["provider_mapping"], (entry) =>
      decodeString(at("provider_mapping"), entry),
    ),
  };
}

function decodeLifecycle(
  where: string,
  value: unknown,
): WorkspaceLifecycleRecord {
  const object = decodeObject(where, value);
  const kind = decodeMember(`${where}.kind`, object["kind"], LIFECYCLE_KINDS);
  switch (kind) {
    case "available":
      return { kind };
    case "unavailable":
      return {
        kind,
        reason: decodeDiagnostic(`${where}.reason`, object["reason"]),
      };
    // A version-3 file mid-close. The close was never finished and cannot be
    // resumed, so the Workspace comes back exactly as it is: open.
    case "closing":
    case "closing_failed":
      return { kind: "available" };
  }
}

function decodeWorkspaceRecord(
  where: string,
  value: unknown,
): WorkspaceStateRecord {
  const object = decodeObject(where, value);
  const at = (key: string): string => `${where}.${key}`;
  return {
    workspace_id: decodeString(at("workspace_id"), object["workspace_id"]),
    selected_path: decodeString(at("selected_path"), object["selected_path"]),
    canonical_path: decodeString(
      at("canonical_path"),
      object["canonical_path"],
    ),
    repository_id: decodeOptional(object["repository_id"], (entry) =>
      decodeString(at("repository_id"), entry),
    ),
    last_agent_id: decodeOptional(object["last_agent_id"], (entry) =>
      decodeString(at("last_agent_id"), entry),
    ),
    lifecycle: decodeLifecycle(at("lifecycle"), object["lifecycle"]),
    agents: decodeArray(at("agents"), object["agents"]).map((entry, index) =>
      decodeAgentRecord(`${at("agents")}[${index}]`, entry),
    ),
  };
}

function decodeNavigation(where: string, value: unknown): NavigationState {
  const object = decodeObject(where, value);
  const context = decodeObject(`${where}.context`, object["context"]);
  const kind = decodeMember(
    `${where}.context.kind`,
    context["kind"],
    NAVIGATION_KINDS,
  );
  switch (kind) {
    case "global":
      return { context: { kind } };
    case "workspace":
      return {
        context: {
          kind,
          workspace_id: decodeString(
            `${where}.context.workspace_id`,
            context["workspace_id"],
          ),
        },
      };
    case "agent":
      return {
        context: {
          kind,
          agent_id: decodeString(
            `${where}.context.agent_id`,
            context["agent_id"],
          ),
        },
      };
  }
}

function decodeOwnedSession(where: string, value: unknown): OwnedSessionRecord {
  const object = decodeObject(where, value);
  const kind = decodeMember(
    `${where}.kind`,
    object["kind"],
    OWNED_SESSION_KINDS,
  );
  const sessionName = decodeString(
    `${where}.session_name`,
    object["session_name"],
  );
  return kind === "scratch"
    ? { kind, session_name: sessionName }
    : {
        kind,
        workspace_id: decodeString(
          `${where}.workspace_id`,
          object["workspace_id"],
        ),
        session_name: sessionName,
      };
}

function decodeOwnedSessions(
  where: string,
  value: unknown,
): OwnedSessionRecord[] {
  return decodeArray(where, value).map((entry, index) =>
    decodeOwnedSession(`${where}[${index}]`, entry),
  );
}

function decodeSessionStatuses<T extends string>(
  where: string,
  value: unknown,
  allowed: readonly T[],
): { session: OwnedSessionRecord; status: T }[] {
  return decodeArray(where, value).map((entry, index) => {
    const at = `${where}[${index}]`;
    const object = decodeObject(at, entry);
    return {
      session: decodeOwnedSession(`${at}.session`, object["session"]),
      status: decodeMember(`${at}.status`, object["status"], allowed),
    };
  });
}

function decodeTransition(
  where: string,
  value: unknown,
): SocketTransitionState {
  const object = decodeObject(where, value);
  const at = (key: string): string => `${where}.${key}`;
  const kind = decodeMember(
    at("kind"),
    object["kind"],
    SOCKET_TRANSITION_KINDS,
  );
  switch (kind) {
    case "stable":
      return { kind };
    case "pending":
      return {
        kind,
        requested_socket_name: decodeString(
          at("requested_socket_name"),
          object["requested_socket_name"],
        ),
        required: decodeOwnedSessions(at("required"), object["required"]),
        preflight: decodeMember(
          at("preflight"),
          object["preflight"],
          SOCKET_TARGET_PREFLIGHT_STATES,
        ),
        verified_old_sessions: decodeOptional(
          object["verified_old_sessions"],
          (entry) => decodeOwnedSessions(at("verified_old_sessions"), entry),
        ),
      };
    case "cleaning_old":
      return {
        kind,
        old_socket_name: decodeString(
          at("old_socket_name"),
          object["old_socket_name"],
        ),
        requested_socket_name: decodeString(
          at("requested_socket_name"),
          object["requested_socket_name"],
        ),
        required: decodeOwnedSessions(at("required"), object["required"]),
        target_preflight: decodeMember(
          at("target_preflight"),
          object["target_preflight"],
          SOCKET_TARGET_PREFLIGHT_STATES,
        ),
        sessions: decodeSessionStatuses(
          at("sessions"),
          object["sessions"],
          CLEANUP_SESSION_STATUSES,
        ),
      };
    case "old_cleaned":
      return {
        kind,
        old_socket_name: decodeString(
          at("old_socket_name"),
          object["old_socket_name"],
        ),
        new_socket_name: decodeString(
          at("new_socket_name"),
          object["new_socket_name"],
        ),
        required: decodeOwnedSessions(at("required"), object["required"]),
      };
    case "recreation_pending":
      return {
        kind,
        effective_socket_name: decodeString(
          at("effective_socket_name"),
          object["effective_socket_name"],
        ),
        required: decodeOwnedSessions(at("required"), object["required"]),
        sessions: decodeSessionStatuses(
          at("sessions"),
          object["sessions"],
          RECREATION_SESSION_STATUSES,
        ),
      };
  }
}

function decodeTmux(where: string, value: unknown): TmuxState {
  const object = decodeObject(where, value);
  return {
    effective_socket_name: decodeString(
      `${where}.effective_socket_name`,
      object["effective_socket_name"],
    ),
    transition: decodeTransition(`${where}.transition`, object["transition"]),
  };
}

function decodeWindow(where: string, value: unknown): WindowState {
  const object = decodeObject(where, value);
  const frame = decodeObject(`${where}.frame`, object["frame"]);
  const at = (key: string): string => `${where}.frame.${key}`;
  return {
    frame: {
      x: decodeNumber(at("x"), frame["x"]),
      y: decodeNumber(at("y"), frame["y"]),
      width: decodeNumber(at("width"), frame["width"]),
      height: decodeNumber(at("height"), frame["height"]),
      maximized: decodeBoolean(at("maximized"), frame["maximized"]),
    },
  };
}

function decodeShutdown(where: string, value: unknown): ShutdownMetadata {
  const object = decodeObject(where, value);
  return {
    clean: decodeBoolean(`${where}.clean`, object["clean"]),
    launch_generation: decodeNumber(
      `${where}.launch_generation`,
      object["launch_generation"],
    ),
  };
}

/**
 * What a file turned out to be.
 *
 * `corrupt` carries the reason it is corrupt. It used to be a bare string, and
 * the reason — which field, and what was in it — was computed and dropped one
 * line later, leaving "the file on disk could not be parsed" as the whole of
 * what a person was told about a file DevHub had just quarantined.
 */
type Decoded =
  | { kind: "state"; state: PersistedAppState; migrated: boolean }
  | { kind: "corrupt"; detail: string }
  | { kind: "newer_version" };

/** The words a decode refusal contributes to what the person reads. */
function detailOf(error: unknown): string {
  if (error instanceof StateError) {
    return error.cause instanceof Error && error.cause.message.length > 0
      ? error.cause.message
      : STATE_ERROR_REASON[error.code];
  }
  return error instanceof Error ? error.message : String(error);
}

function decodeState(bytes: Buffer): Decoded {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { kind: "corrupt", detail: detailOf(error) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "corrupt", detail: "the document is not a JSON object" };
  }
  const object = value as Record<string, unknown>;
  const schema = object["schema_version"];
  const legacy = object["version"];
  let version: number;
  if (typeof schema === "number" && typeof legacy === "number") {
    if (schema !== legacy) {
      return {
        kind: "corrupt",
        detail: `schema_version is ${schema} and version is ${legacy}`,
      };
    }
    version = schema;
  } else if (typeof schema === "number") {
    version = schema;
  } else if (typeof legacy === "number") {
    version = legacy;
  } else {
    return { kind: "corrupt", detail: "the document has no schema_version" };
  }
  if (version > STATE_SCHEMA_VERSION) {
    return { kind: "newer_version" };
  }
  const migrated = version < STATE_SCHEMA_VERSION || legacy !== undefined;
  const fresh = freshState();
  // A key this build reads and the file does not have is the default; a key
  // the file *does* have has to mean what this build reads it as.
  let state: PersistedAppState;
  try {
    state = {
      schema_version: STATE_SCHEMA_VERSION,
      workspaces: decodeArray("workspaces", object["workspaces"] ?? []).map(
        (entry, index) => decodeWorkspaceRecord(`workspaces[${index}]`, entry),
      ),
      navigation:
        object["navigation"] === undefined
          ? fresh.navigation
          : decodeNavigation("navigation", object["navigation"]),
      sidebar:
        object["sidebar"] === undefined
          ? fresh.sidebar
          : {
              width: decodeNumber(
                "sidebar.width",
                decodeObject("sidebar", object["sidebar"])["width"],
              ),
            },
      split:
        object["split"] === undefined
          ? fresh.split
          : {
              ratio: decodeNumber(
                "split.ratio",
                decodeObject("split", object["split"])["ratio"],
              ),
            },
      window:
        object["window"] === undefined
          ? fresh.window
          : decodeWindow("window", object["window"]),
      tmux:
        object["tmux"] === undefined
          ? fresh.tmux
          : decodeTmux("tmux", object["tmux"]),
      shutdown:
        object["shutdown"] === undefined
          ? fresh.shutdown
          : decodeShutdown("shutdown", object["shutdown"]),
    };
  } catch (error) {
    if (error instanceof StateError && error.code === "STATE_INVALID") {
      return { kind: "corrupt", detail: detailOf(error) };
    }
    throw error;
  }
  try {
    validateState(state);
  } catch (error) {
    if (error instanceof StateError && error.code === "STATE_NEWER_VERSION") {
      return { kind: "newer_version" };
    }
    return { kind: "corrupt", detail: detailOf(error) };
  }
  return { kind: "state", state, migrated };
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
    if (decoded.kind === "newer_version") {
      fail("STATE_NEWER_VERSION");
    }
    if (decoded.kind === "corrupt") {
      const quarantined = await quarantine(this.path);
      return this.loadBackupOrFresh(
        "corrupt_primary",
        quarantined,
        decoded.detail,
      );
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
    primaryDetail?: string,
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
          corruptionDetail: primaryDetail,
          primaryQuarantined,
          backupQuarantined: false,
          migrated: false,
        },
      };
    }
    const decoded = decodeState(backup.bytes);
    if (decoded.kind === "newer_version") {
      fail("STATE_NEWER_VERSION");
    }
    if (decoded.kind === "corrupt") {
      const backupQuarantined = await quarantine(this.backupPath);
      return {
        state: freshState(),
        metadata: {
          origin: "fresh",
          recoveryReason: "corrupt_primary_and_backup",
          corruptionDetail: primaryDetail ?? decoded.detail,
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
        corruptionDetail: primaryDetail,
        primaryQuarantined,
        backupQuarantined: false,
        migrated: decoded.migrated,
      },
    };
  }

  private async saveStateLocked(state: PersistedAppState): Promise<void> {
    validateState(state);
    const parent = dirname(this.path);
    // The directory is part of the write. It used to be made outside the
    // mapping, so a state directory that could not be created came out as a
    // bare `EACCES` and was reported as an unexplained app failure rather
    // than as the file DevHub could not save.
    await mkdir(parent, { recursive: true, mode: 0o700 }).catch(
      (error: unknown) => {
        throw mapIoError(error, this.path);
      },
    );
    const text = `${JSON.stringify(state, undefined, 2)}\n`;
    const temporary = `${this.path}.tmp.${String(process.pid)}.${String(Date.now())}`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    ).catch((error: unknown) => {
      throw mapIoError(error, this.path);
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
      throw mapIoError(error, this.path);
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
    if (decoded.kind === "newer_version") {
      fail("STATE_NEWER_VERSION");
    }
    if (decoded.kind === "corrupt") {
      await quarantine(this.path);
      return;
    }
    const temporary = `${this.backupPath}.tmp.${String(process.pid)}.${String(Date.now())}`;
    try {
      await copyFile(this.path, temporary, constants.COPYFILE_EXCL);
      await rename(temporary, this.backupPath);
    } catch (error) {
      throw mapIoError(error, this.path);
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
