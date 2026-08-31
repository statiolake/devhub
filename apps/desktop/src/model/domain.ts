/**
 * Pure DevHub domain values and lifecycle rules.
 *
 * A port of `crates/devhub-app-core/src/domain.rs`. It has no Electron, no
 * filesystem and no process dependency: adapters hand validated values across
 * this seam, and identity, ownership and lifecycle invariants live here.
 *
 * Rust's newtypes become branded strings. The brand is what makes a
 * `WorkspaceId` refuse to be an `AgentId` at compile time; the runtime value
 * stays a plain string, so it is still a `Map` key and still serialises to the
 * wire without a conversion step.
 */

export enum DomainErrorCode {
  InvalidId = "INVALID_ID",
  InvalidPath = "INVALID_PATH",
  InvalidRemote = "INVALID_REMOTE",
  InvalidDisplayName = "INVALID_DISPLAY_NAME",
  InvalidOrdinal = "INVALID_ORDINAL",
  OrdinalExhausted = "ORDINAL_EXHAUSTED",
  InvalidBusyCount = "INVALID_BUSY_COUNT",
  DuplicateWorkspace = "DUPLICATE_WORKSPACE",
  DuplicateWorkspaceRoot = "DUPLICATE_WORKSPACE_ROOT",
  DuplicateAgent = "DUPLICATE_AGENT",
  UnknownRepository = "UNKNOWN_REPOSITORY",
  RepositoryIdentityConflict = "REPOSITORY_IDENTITY_CONFLICT",
  RepositoryRemoteConflict = "REPOSITORY_REMOTE_CONFLICT",
  UnknownWorkspace = "UNKNOWN_WORKSPACE",
  UnknownAgent = "UNKNOWN_AGENT",
  WorkspaceUnavailable = "WORKSPACE_UNAVAILABLE",
  ActivityDisabled = "ACTIVITY_DISABLED",
  WorkspaceNotClean = "WORKSPACE_NOT_CLEAN",
  GlobalContextCannotClose = "GLOBAL_CONTEXT_CANNOT_CLOSE",
  InvalidProfile = "INVALID_PROFILE",
  AgentWorkspaceMismatch = "AGENT_WORKSPACE_MISMATCH",
  WorkspaceNotUnavailable = "WORKSPACE_NOT_UNAVAILABLE",
  InvalidAgentControlTransition = "INVALID_AGENT_CONTROL_TRANSITION",
  WorkspaceHasLiveAgents = "WORKSPACE_HAS_LIVE_AGENTS",
  WorkspaceClosing = "WORKSPACE_CLOSING",
  WorkspaceClosingFailed = "WORKSPACE_CLOSING_FAILED",
  InvalidSidebarWidth = "INVALID_SIDEBAR_WIDTH",
}

/**
 * A domain operation failure. The code is stable; no provider or user content
 * is ever stored on it.
 */
export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode) {
    super(code);
    this.name = "DomainError";
  }
}

function invalid(code: DomainErrorCode): DomainError {
  return new DomainError(code);
}

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type AgentId = Brand<string, "AgentId">;
export type AgentProfileId = Brand<string, "AgentProfileId">;
export type WorkspaceRoot = Brand<string, "WorkspaceRoot">;
export type DisplayPath = Brand<string, "DisplayPath">;
export type RemoteIdentity = Brand<string, "RemoteIdentity">;

export function isCanonicalUuid(raw: string): boolean {
  return (
    raw.length === 36 &&
    raw === raw.toLowerCase() &&
    [...raw].every((character, index) =>
      index === 8 || index === 13 || index === 18 || index === 23
        ? character === "-"
        : /[0-9a-f]/.test(character),
    )
  );
}

function uuidId<T extends string>(raw: string): Brand<string, T> {
  if (!isCanonicalUuid(raw)) {
    throw invalid(DomainErrorCode.InvalidId);
  }
  return raw as Brand<string, T>;
}

export const workspaceId = (raw: string): WorkspaceId =>
  uuidId<"WorkspaceId">(raw);
export const repositoryId = (raw: string): RepositoryId =>
  uuidId<"RepositoryId">(raw);
export const agentId = (raw: string): AgentId => uuidId<"AgentId">(raw);

export function isSlug(raw: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(raw);
}

/** A validated configuration identifier, distinct from a runtime UUID. */
export function agentProfileId(raw: string): AgentProfileId {
  if (!isSlug(raw)) {
    throw invalid(DomainErrorCode.InvalidId);
  }
  return raw as AgentProfileId;
}

/**
 * Lexical normalisation, exactly as the Rust did it: `.` drops out, `..` pops,
 * and a `..` that would escape the root is rejected rather than clamped.
 */
function normalizeAbsolutePath(path: string): string {
  if (path.length === 0 || path.includes("\0") || !path.startsWith("/")) {
    throw invalid(DomainErrorCode.InvalidPath);
  }
  const parts: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") {
      continue;
    }
    if (component === "..") {
      if (parts.pop() === undefined) {
        throw invalid(DomainErrorCode.InvalidPath);
      }
      continue;
    }
    parts.push(component);
  }
  return `/${parts.join("/")}`;
}

/** Canonical Workspace Root: the duplicate-prevention key. */
export function workspaceRoot(path: string): WorkspaceRoot {
  return normalizeAbsolutePath(path) as WorkspaceRoot;
}

/** A path the user picked, expanded and canonicalised by the adapter first. */
export function displayPath(path: string): DisplayPath {
  return normalizeAbsolutePath(path) as DisplayPath;
}

export function rootBasename(root: WorkspaceRoot): string {
  const name = root.split("/").filter(Boolean).at(-1);
  return name && name.length > 0 ? name : "/";
}

/** Parent directory names, nearest first — the disambiguation source. */
export function rootParentComponents(root: WorkspaceRoot): string[] {
  return root.split("/").filter(Boolean).slice(0, -1).reverse();
}

type RemoteScheme = "bare" | "scp" | "http" | "https" | "ssh";

const DEFAULT_PORTS: Readonly<Record<RemoteScheme, number | undefined>> = {
  bare: undefined,
  scp: undefined,
  http: 80,
  https: 443,
  ssh: 22,
};

function normalizeAuthority(authority: string): [string, number | undefined] {
  const trimmed = authority.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const host = trimmed.slice(0, colon);
    const port = trimmed.slice(colon + 1);
    if (host.length > 0 && port.length > 0 && /^[0-9]+$/.test(port)) {
      return [host, Number.parseInt(port, 10)];
    }
  }
  if (trimmed.length === 0) {
    throw invalid(DomainErrorCode.InvalidRemote);
  }
  return [trimmed, undefined];
}

/**
 * A normalised remote identity. Credentials, scheme, leading slash and a
 * trailing `.git` are deliberately absent, so HTTPS and SSH aliases compare
 * equal without touching Git or the network.
 */
export function remoteIdentity(input: string): RemoteIdentity {
  const raw = input.trim();
  if (raw.length === 0 || raw.includes("\0")) {
    throw invalid(DomainErrorCode.InvalidRemote);
  }
  const withoutQuery = raw.split(/[?#]/)[0] ?? "";

  let authority: string;
  let path: string;
  let scheme: RemoteScheme;
  const schemeMatch = /^(https|http|ssh):\/\/(.*)$/.exec(withoutQuery);
  if (!withoutQuery.includes("://")) {
    const colon = withoutQuery.indexOf(":");
    if (colon >= 0) {
      const at = withoutQuery.slice(0, colon).lastIndexOf("@");
      if (at < 0) {
        throw invalid(DomainErrorCode.InvalidRemote);
      }
      authority = withoutQuery.slice(at + 1, colon);
      path = withoutQuery.slice(colon + 1);
      scheme = "scp";
    } else {
      const slash = withoutQuery.indexOf("/");
      if (slash < 0) {
        throw invalid(DomainErrorCode.InvalidRemote);
      }
      authority = withoutQuery.slice(0, slash);
      path = withoutQuery.slice(slash + 1);
      scheme = "bare";
    }
  } else if (schemeMatch) {
    scheme = schemeMatch[1] as RemoteScheme;
    const rest = schemeMatch[2] ?? "";
    const slash = rest.indexOf("/");
    if (slash < 0) {
      throw invalid(DomainErrorCode.InvalidRemote);
    }
    const rawAuthority = rest.slice(0, slash);
    const at = rawAuthority.lastIndexOf("@");
    authority = at >= 0 ? rawAuthority.slice(at + 1) : rawAuthority;
    path = rest.slice(slash + 1);
  } else {
    throw invalid(DomainErrorCode.InvalidRemote);
  }

  const [rawHost, rawPort] = normalizeAuthority(authority);
  const defaultPort = DEFAULT_PORTS[scheme];
  const port =
    defaultPort !== undefined && rawPort === defaultPort ? undefined : rawPort;

  let normalizedPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  normalizedPath = normalizedPath.replace(/\.git$/, "");
  const host = rawHost.trim();
  if (
    host.length === 0 ||
    normalizedPath.length === 0 ||
    /\s/.test(host) ||
    /\s/.test(normalizedPath) ||
    normalizedPath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw invalid(DomainErrorCode.InvalidRemote);
  }

  const lowerHost = host.toLowerCase();
  const finalPath =
    lowerHost === "github.com" ? normalizedPath.toLowerCase() : normalizedPath;
  const finalAuthority =
    port === undefined ? lowerHost : `${lowerHost}:${port}`;
  return `${finalAuthority}/${finalPath}` as RemoteIdentity;
}

/** A Git remote identity and its normalised aliases. */
export class Repository {
  readonly aliases: readonly RemoteIdentity[];

  constructor(
    readonly id: RepositoryId,
    readonly primaryRemote: RemoteIdentity,
    aliases: Iterable<RemoteIdentity> = [],
  ) {
    this.aliases = [
      ...new Set<RemoteIdentity>([primaryRemote, ...aliases]),
    ].sort();
  }

  matchesRemote(remote: RemoteIdentity): boolean {
    return this.aliases.includes(remote);
  }

  equals(other: Repository): boolean {
    return (
      this.id === other.id &&
      this.primaryRemote === other.primaryRemote &&
      this.aliases.length === other.aliases.length &&
      this.aliases.every((alias, index) => alias === other.aliases[index])
    );
  }
}

/**
 * Whose screen an Agent's program draws.
 *
 * It is not "which program to run" — that is the profile's `command`. It is the
 * only thing status detection can be keyed on, so `custom` is a real member
 * rather than an absence: it says, permanently, that DevHub has no manifest for
 * this screen and will not guess at one. An Agent on a `custom` profile is a
 * live pane with a `?` for a status, which is exactly what attaching an editor
 * or a plain command should get you.
 */
export type AgentProfileKind = "codex" | "claude" | "custom";

export function validDisplayName(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\0");
}

export function isEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * A user-configured profile snapshot. An Agent keeps a copy at launch so later
 * profile edits do not mutate an already-running session.
 *
 * `args` and `env` can carry credentials, so nothing here has a `toString` or
 * an inspection that would print them.
 */
export class AgentProfile {
  private constructor(
    readonly id: AgentProfileId,
    readonly displayName: string,
    readonly kind: AgentProfileKind,
    /**
     * The program to run. It is what makes the Agent an Agent; `kind` only
     * says whose screen it is, so that a detector knows how to read it.
     */
    readonly command: string,
    readonly args: readonly string[],
    readonly env: ReadonlyMap<string, string>,
  ) {}

  static create(
    id: AgentProfileId,
    displayName: string,
    kind: AgentProfileKind,
    command: string,
    args: readonly string[] = [],
    env: ReadonlyMap<string, string> = new Map(),
  ): AgentProfile {
    if (!validDisplayName(displayName)) {
      throw invalid(DomainErrorCode.InvalidDisplayName);
    }
    if (command.trim().length === 0 || command.includes("\0")) {
      throw invalid(DomainErrorCode.InvalidProfile);
    }
    if (
      args.some((argument) => argument.includes("\0")) ||
      [...env].some(
        ([key, value]) =>
          key.length === 0 || key.includes("\0") || value.includes("\0"),
      )
    ) {
      throw invalid(DomainErrorCode.InvalidProfile);
    }
    return new AgentProfile(
      id,
      displayName,
      kind,
      command,
      [...args],
      new Map([...env].sort(([left], [right]) => (left < right ? -1 : 1))),
    );
  }

  equals(other: AgentProfile): boolean {
    if (
      this.id !== other.id ||
      this.displayName !== other.displayName ||
      this.kind !== other.kind ||
      this.command !== other.command ||
      this.args.length !== other.args.length ||
      this.env.size !== other.env.size
    ) {
      return false;
    }
    return (
      this.args.every((argument, index) => argument === other.args[index]) &&
      [...this.env].every(([key, value]) => other.env.get(key) === value)
    );
  }
}

/**
 * What an Agent is doing.
 *
 * `unknown` is not a failure and not a transient. It is the permanent answer
 * for an Agent whose screen DevHub has no detector for — a profile with a
 * command and no manifest — and it is what every Agent reports until a
 * detector for its kind says otherwise. Folding it into `error` would tell
 * somebody who deliberately attached a plain command that something is wrong;
 * folding it into `idle` would claim a reading nobody took.
 */
export type AgentStatus = "working" | "waiting" | "idle" | "error" | "unknown";
export type RuntimeHealth =
  | "starting"
  | "healthy"
  | "degraded"
  | "unavailable"
  | "failed";

/**
 * Why a Workspace is unavailable, or cannot finish cleanup. These are the only
 * diagnostics the UI ever renders.
 */
export type DiagnosticCode =
  | "root_missing"
  | "root_inaccessible"
  | "close_agents_unknown"
  | "close_terminal_unknown"
  | "close_editor_unknown"
  | "close_editor_vetoed"
  | "cleanup_failed"
  | "runtime_unavailable";

/** Product-level control lifecycle, independent of status and health. */
export type AgentControlState =
  | { readonly kind: "running" }
  | { readonly kind: "stopping" }
  | { readonly kind: "stop-failed"; readonly diagnostic: DiagnosticCode };

export const RUNNING: AgentControlState = { kind: "running" };
export const STOPPING: AgentControlState = { kind: "stopping" };

export function isInteractive(state: AgentControlState): boolean {
  return state.kind === "running";
}
export function canRetryStop(state: AgentControlState): boolean {
  return state.kind === "stop-failed";
}

/** Provider-free observation used for one atomic Agent reconciliation. */
export interface AgentObservation {
  readonly agentId: AgentId;
  readonly status: AgentStatus;
  readonly runtimeHealth: RuntimeHealth;
}

/**
 * A complete provider reconciliation. Missing provider Agents are represented
 * by `exited`; both lists are applied atomically once every identity is known.
 */
export interface AgentReconciliation {
  readonly observations: readonly AgentObservation[];
  readonly exited: readonly AgentId[];
}

/** Validated, provider-free restoration record for an existing Agent. */
export interface AgentRestoreRecord {
  readonly id: AgentId;
  readonly workspaceId: WorkspaceId;
  readonly profile: AgentProfile;
  readonly ordinal: number;
  readonly temporaryName?: string;
  readonly status: AgentStatus;
  readonly runtimeHealth: RuntimeHealth;
  readonly controlState: AgentControlState;
  /** Whether this Agent has asked for attention that nobody has looked at. */
  readonly unread?: boolean;
}

export function agentRestoreRecord(
  record: AgentRestoreRecord,
): AgentRestoreRecord {
  if (!Number.isInteger(record.ordinal) || record.ordinal === 0) {
    throw invalid(DomainErrorCode.InvalidOrdinal);
  }
  if (
    record.temporaryName !== undefined &&
    !validDisplayName(record.temporaryName)
  ) {
    throw invalid(DomainErrorCode.InvalidDisplayName);
  }
  return record;
}

/** Agent resource owned by exactly one Workspace. */
export class Agent {
  private nameOverride: string | undefined;

  private constructor(
    readonly id: AgentId,
    readonly workspaceId: WorkspaceId,
    readonly profile: AgentProfile,
    readonly ordinal: number,
    nameOverride: string | undefined,
    private statusValue: AgentStatus,
    private runtimeHealthValue: RuntimeHealth,
    private controlStateValue: AgentControlState,
    /**
     * The Agent asked for something and nobody has looked yet.
     *
     * It is a fact about the *person*, not about the Agent, which is why it is
     * a flag of its own rather than a fifth status: an Agent can be waiting and
     * read (you are looking at it now), or idle and unread (it asked, you never
     * came, and it timed out). Collapsing the two would lose the second, which
     * is the one worth a glow.
     */
    private unreadValue: boolean,
  ) {
    this.nameOverride = nameOverride;
  }

  static create(
    id: AgentId,
    owner: WorkspaceId,
    profile: AgentProfile,
    ordinal: number,
  ): Agent {
    return Agent.restore(
      agentRestoreRecord({
        id,
        workspaceId: owner,
        profile,
        ordinal,
        // Nothing has read this Agent's screen yet, and "idle" would be a
        // reading. The first reconcile replaces it.
        status: "unknown",
        runtimeHealth: "starting",
        controlState: RUNNING,
      }),
    );
  }

  static restore(record: AgentRestoreRecord): Agent {
    const validated = agentRestoreRecord(record);
    return new Agent(
      validated.id,
      validated.workspaceId,
      validated.profile,
      validated.ordinal,
      validated.temporaryName,
      validated.status,
      validated.runtimeHealth,
      validated.controlState,
      validated.unread === true,
    );
  }

  clone(): Agent {
    return new Agent(
      this.id,
      this.workspaceId,
      this.profile,
      this.ordinal,
      this.nameOverride,
      this.statusValue,
      this.runtimeHealthValue,
      this.controlStateValue,
      this.unreadValue,
    );
  }

  get displayName(): string {
    return (
      this.nameOverride ?? `${this.profile.displayName} ${String(this.ordinal)}`
    );
  }

  get temporaryName(): string | undefined {
    return this.nameOverride;
  }

  get status(): AgentStatus {
    return this.statusValue;
  }

  get runtimeHealth(): RuntimeHealth {
    return this.runtimeHealthValue;
  }

  get controlState(): AgentControlState {
    return this.controlStateValue;
  }

  get unread(): boolean {
    return this.unreadValue;
  }

  setUnread(unread: boolean): boolean {
    if (this.unreadValue === unread) return false;
    this.unreadValue = unread;
    return true;
  }

  get isInteractive(): boolean {
    return isInteractive(this.controlStateValue);
  }

  get canRetryStop(): boolean {
    return canRetryStop(this.controlStateValue);
  }

  rename(displayName: string): boolean {
    if (!validDisplayName(displayName)) {
      throw invalid(DomainErrorCode.InvalidDisplayName);
    }
    if (this.nameOverride === displayName) {
      return false;
    }
    this.nameOverride = displayName;
    return true;
  }

  resetName(): boolean {
    if (this.nameOverride === undefined) {
      return false;
    }
    this.nameOverride = undefined;
    return true;
  }

  setStatus(status: AgentStatus): boolean {
    if (this.statusValue === status) {
      return false;
    }
    this.statusValue = status;
    return true;
  }

  setRuntimeHealth(health: RuntimeHealth): boolean {
    if (this.runtimeHealthValue === health) {
      return false;
    }
    this.runtimeHealthValue = health;
    return true;
  }

  requestStop(): boolean {
    if (this.controlStateValue.kind === "stopping") {
      return false;
    }
    this.controlStateValue = STOPPING;
    return true;
  }

  markStopFailed(diagnostic: DiagnosticCode): boolean {
    if (this.controlStateValue.kind === "running") {
      throw invalid(DomainErrorCode.InvalidAgentControlTransition);
    }
    if (
      this.controlStateValue.kind === "stop-failed" &&
      this.controlStateValue.diagnostic === diagnostic
    ) {
      return false;
    }
    this.controlStateValue = { kind: "stop-failed", diagnostic };
    return true;
  }

  returnToRunning(): boolean {
    if (this.controlStateValue.kind === "running") {
      return false;
    }
    this.controlStateValue = RUNNING;
    return true;
  }
}

/** Progress retained when a Workspace close partially fails. */
export interface CleanupProgress {
  readonly agentsClosed: number;
  readonly agentsStepCompleted: boolean;
  readonly terminalClosed: boolean;
  readonly editorClosed: boolean;
}

export function cleanupProgress(
  agentsClosed: number,
  terminalClosed: boolean,
  editorClosed: boolean,
): CleanupProgress {
  return {
    agentsClosed,
    agentsStepCompleted: agentsClosed > 0,
    terminalClosed,
    editorClosed,
  };
}

export function cleanupProgressAfterAgents(
  agentsClosed: number,
  terminalClosed: boolean,
  editorClosed: boolean,
): CleanupProgress {
  return {
    agentsClosed,
    agentsStepCompleted: true,
    terminalClosed,
    editorClosed,
  };
}

export const NO_CLEANUP_PROGRESS: CleanupProgress = cleanupProgress(
  0,
  false,
  false,
);

export function sameProgress(
  left: CleanupProgress,
  right: CleanupProgress,
): boolean {
  return (
    left.agentsClosed === right.agentsClosed &&
    left.agentsStepCompleted === right.agentsStepCompleted &&
    left.terminalClosed === right.terminalClosed &&
    left.editorClosed === right.editorClosed
  );
}

/** Workspace availability/lifecycle state. */
export type WorkspaceState =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: DiagnosticCode }
  | { readonly kind: "closing"; readonly progress: CleanupProgress }
  | {
      readonly kind: "closing-failed";
      readonly diagnostic: DiagnosticCode;
      readonly progress: CleanupProgress;
    };

export const AVAILABLE: WorkspaceState = { kind: "available" };

export function isWorkspaceAvailable(state: WorkspaceState): boolean {
  return state.kind === "available";
}

export function isWorkspaceClosing(state: WorkspaceState): boolean {
  return state.kind === "closing";
}

export function workspaceCleanupProgress(
  state: WorkspaceState,
): CleanupProgress | undefined {
  return state.kind === "closing" || state.kind === "closing-failed"
    ? state.progress
    : undefined;
}

function sameWorkspaceState(
  left: WorkspaceState,
  right: WorkspaceState,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "unavailable" && right.kind === "unavailable") {
    return left.reason === right.reason;
  }
  if (left.kind === "closing" && right.kind === "closing") {
    return sameProgress(left.progress, right.progress);
  }
  if (left.kind === "closing-failed" && right.kind === "closing-failed") {
    return (
      left.diagnostic === right.diagnostic &&
      sameProgress(left.progress, right.progress)
    );
  }
  return true;
}

/**
 * A Workspace is an open context rooted at one canonical folder. Repository
 * identity is optional and never replaces Workspace identity.
 */
export class Workspace {
  private readonly agentList: Agent[] = [];

  constructor(
    readonly id: WorkspaceId,
    private rootValue: WorkspaceRoot,
    private selectedPathValue: DisplayPath,
    private repositoryIdValue: RepositoryId | undefined = undefined,
    private stateValue: WorkspaceState = AVAILABLE,
  ) {}

  clone(): Workspace {
    const copy = new Workspace(
      this.id,
      this.rootValue,
      this.selectedPathValue,
      this.repositoryIdValue,
      this.stateValue,
    );
    for (const agent of this.agentList) {
      copy.agentList.push(agent.clone());
    }
    return copy;
  }

  get root(): WorkspaceRoot {
    return this.rootValue;
  }

  get selectedPath(): DisplayPath {
    return this.selectedPathValue;
  }

  get repositoryId(): RepositoryId | undefined {
    return this.repositoryIdValue;
  }

  get state(): WorkspaceState {
    return this.stateValue;
  }

  get agents(): readonly Agent[] {
    return this.agentList;
  }

  get canCreateAgent(): boolean {
    return isWorkspaceAvailable(this.stateValue);
  }

  setRepositoryId(next: RepositoryId | undefined): boolean {
    if (this.repositoryIdValue === next) {
      return false;
    }
    this.repositoryIdValue = next;
    return true;
  }

  /**
   * Rebind an unavailable Workspace to a newly located canonical root while
   * preserving its WorkspaceId and its live Agents.
   */
  relocate(root: WorkspaceRoot, selectedPath: DisplayPath): void {
    this.rootValue = root;
    this.selectedPathValue = selectedPath;
    this.stateValue = AVAILABLE;
  }

  markUnavailable(reason: DiagnosticCode): boolean {
    const next: WorkspaceState = { kind: "unavailable", reason };
    if (sameWorkspaceState(this.stateValue, next)) {
      return false;
    }
    this.stateValue = next;
    return true;
  }

  markAvailable(): boolean {
    if (this.stateValue.kind === "available") {
      return false;
    }
    this.stateValue = AVAILABLE;
    return true;
  }

  markClosingFailed(
    diagnostic: DiagnosticCode,
    progress: CleanupProgress,
  ): boolean {
    const next: WorkspaceState = {
      kind: "closing-failed",
      diagnostic,
      progress,
    };
    if (sameWorkspaceState(this.stateValue, next)) {
      return false;
    }
    this.stateValue = next;
    return true;
  }

  markClosing(progress: CleanupProgress): boolean {
    switch (this.stateValue.kind) {
      case "available":
      case "closing-failed": {
        const next: WorkspaceState = { kind: "closing", progress };
        if (sameWorkspaceState(this.stateValue, next)) {
          return false;
        }
        this.stateValue = next;
        return true;
      }
      case "closing":
        throw invalid(DomainErrorCode.WorkspaceClosing);
      case "unavailable":
        throw invalid(DomainErrorCode.WorkspaceUnavailable);
    }
  }

  updateClosingProgress(progress: CleanupProgress): boolean {
    switch (this.stateValue.kind) {
      case "closing": {
        if (sameProgress(this.stateValue.progress, progress)) {
          return false;
        }
        this.stateValue = { kind: "closing", progress };
        return true;
      }
      case "closing-failed":
        throw invalid(DomainErrorCode.WorkspaceClosingFailed);
      default:
        throw invalid(DomainErrorCode.WorkspaceUnavailable);
    }
  }

  agent(id: AgentId): Agent | undefined {
    return this.agentList.find((candidate) => candidate.id === id);
  }

  addAgent(agent: Agent): void {
    if (!this.canCreateAgent) {
      throw invalid(DomainErrorCode.WorkspaceUnavailable);
    }
    this.restoreAgent(agent);
  }

  restoreAgent(agent: Agent): void {
    if (agent.workspaceId !== this.id) {
      throw invalid(DomainErrorCode.AgentWorkspaceMismatch);
    }
    if (this.agent(agent.id)) {
      throw invalid(DomainErrorCode.DuplicateAgent);
    }
    this.agentList.push(agent);
  }

  removeAgent(id: AgentId): Agent | undefined {
    const index = this.agentList.findIndex((agent) => agent.id === id);
    return index < 0 ? undefined : this.agentList.splice(index, 1)[0];
  }
}

/** The left-pane Navigation Context, distinct from Activity and SurfaceKey. */
export type NavigationContext =
  | { readonly kind: "global" }
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "agent"; readonly agentId: AgentId };

export const GLOBAL_CONTEXT: NavigationContext = { kind: "global" };

export function sameContext(
  left: NavigationContext,
  right: NavigationContext,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "workspace" && right.kind === "workspace") {
    return left.workspaceId === right.workspaceId;
  }
  if (left.kind === "agent" && right.kind === "agent") {
    return left.agentId === right.agentId;
  }
  return true;
}

/** Fixed top-level choices. Activities are never created or destroyed. */
export type Activity = "editor" | "agent" | "terminal";
export const ALL_ACTIVITIES: readonly Activity[] = [
  "editor",
  "agent",
  "terminal",
];

/** Why an Activity is disabled for a context. */
export type DisabledReason =
  | "global-agent-not-applicable"
  | "workspace-agent-requires-agent-selection"
  | "workspace-unavailable"
  | "workspace-closing"
  | "workspace-closing-failed";

/**
 * Semantic DevHub surface identity. Provider and editor identifiers do not
 * cross this seam.
 */
export type SurfaceKey =
  | { readonly kind: "global-editor" }
  | { readonly kind: "global-terminal" }
  | { readonly kind: "workspace-editor"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "workspace-terminal"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "agent"; readonly agentId: AgentId };

export function surfaceKeyName(key: SurfaceKey): string {
  switch (key.kind) {
    case "global-editor":
      return "global-editor";
    case "global-terminal":
      return "global-terminal";
    case "workspace-editor":
      return `workspace-editor:${key.workspaceId}`;
    case "workspace-terminal":
      return `workspace-terminal:${key.workspaceId}`;
    case "agent":
      return `agent:${key.agentId}`;
  }
}

/** An Activity's availability and semantic target. */
export type SurfaceResolution =
  | { readonly kind: "enabled"; readonly surfaceKey: SurfaceKey }
  | { readonly kind: "disabled"; readonly reason: DisabledReason };

/** One input to the consolidated Workspace close inspection. */
export type ResourceInspection =
  | { readonly kind: "clean" }
  | { readonly kind: "busy"; readonly count: number }
  | { readonly kind: "unknown"; readonly diagnostic: DiagnosticCode };

export const CLEAN: ResourceInspection = { kind: "clean" };

export function busy(count: number): ResourceInspection {
  if (count === 0) {
    throw invalid(DomainErrorCode.InvalidBusyCount);
  }
  return { kind: "busy", count };
}

export function unknownResource(
  diagnostic: DiagnosticCode,
): ResourceInspection {
  return { kind: "unknown", diagnostic };
}

/** Resource counts collected before a Workspace close confirmation. */
export interface CloseInspectionInputs {
  readonly agents: ResourceInspection;
  readonly terminalProcesses: ResourceInspection;
  readonly terminalPanes: ResourceInspection;
  readonly terminalWindows: ResourceInspection;
  readonly unsavedEditors: ResourceInspection;
}

export const CLEAN_INSPECTION: CloseInspectionInputs = {
  agents: CLEAN,
  terminalProcesses: CLEAN,
  terminalPanes: CLEAN,
  terminalWindows: CLEAN,
  unsavedEditors: CLEAN,
};

/** Counted reasons shown in one destructive Workspace confirmation. */
export interface BusyReasons {
  readonly agents: number;
  readonly terminalProcesses: number;
  readonly terminalPanes: number;
  readonly terminalWindows: number;
  readonly unsavedEditors: number;
}

/** The only three consolidated close outcomes. */
export type CloseInspection =
  | { readonly kind: "clean" }
  | {
      readonly kind: "requires-confirmation";
      readonly reasons: BusyReasons;
      readonly unknownDiagnostics: readonly DiagnosticCode[];
    };

export const CLEAN_CLOSE_INSPECTION: CloseInspection = { kind: "clean" };

const INSPECTION_FIELDS = [
  "agents",
  "terminalProcesses",
  "terminalPanes",
  "terminalWindows",
  "unsavedEditors",
] as const;

export function consolidateCloseInspection(
  inputs: CloseInspectionInputs,
): CloseInspection {
  const unknownDiagnostics: DiagnosticCode[] = [];
  for (const field of INSPECTION_FIELDS) {
    const check = inputs[field];
    if (
      check.kind === "unknown" &&
      !unknownDiagnostics.includes(check.diagnostic)
    ) {
      unknownDiagnostics.push(check.diagnostic);
    }
  }
  const reasons: Record<(typeof INSPECTION_FIELDS)[number], number> = {
    agents: 0,
    terminalProcesses: 0,
    terminalPanes: 0,
    terminalWindows: 0,
    unsavedEditors: 0,
  };
  let anyBusy = false;
  for (const field of INSPECTION_FIELDS) {
    const check = inputs[field];
    if (check.kind === "busy") {
      reasons[field] = check.count;
      anyBusy = true;
    }
  }
  if (!anyBusy && unknownDiagnostics.length === 0) {
    return CLEAN_CLOSE_INSPECTION;
  }
  return { kind: "requires-confirmation", reasons, unknownDiagnostics };
}

/**
 * The content-free projection the close confirmation renders. The UI shows
 * these states but never recomputes them.
 */
export interface CloseInspectionProjection extends CloseInspectionInputs {
  readonly workspaceId: WorkspaceId;
  readonly workspaceLabel: string;
}

export function closeInspectionProjection(
  workspace: WorkspaceId,
  workspaceLabel: string,
  inputs: CloseInspectionInputs,
): CloseInspectionProjection {
  return { workspaceId: workspace, workspaceLabel, ...inputs };
}
