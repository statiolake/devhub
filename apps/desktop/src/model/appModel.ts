/**
 * The revision-numbered application model and its immutable projection.
 *
 * A port of `crates/devhub-app-core/src/snapshot.rs`. `AppModel` owns the
 * Workspaces, their Agents, the selection and the sidebar; `snapshot()` is the
 * only way anything else reads them. Every mutation that changes anything bumps
 * the revision, which is what lets the App Shell drop a projection it has
 * already seen.
 */

import {
  Agent,
  AgentProfile,
  AVAILABLE,
  DomainError,
  DomainErrorCode,
  GLOBAL_CONTEXT,
  isWorkspaceAvailable,
  rootBasename,
  rootParentComponents,
  sameContext,
  Workspace,
  type Activity,
  type AgentControlState,
  type AgentId,
  type AgentProfileId,
  type AgentReconciliation,
  type AgentRestoreRecord,
  type AgentStatus,
  type CleanupProgress,
  type CloseInspection,
  type DiagnosticCode,
  type DisplayPath,
  type NavigationContext,
  type RepositoryId,
  type Repository,
  type RuntimeHealth,
  type SurfaceResolution,
  type WorkspaceId,
  type WorkspaceRoot,
  type WorkspaceState,
} from "./domain.js";

export const APP_SNAPSHOT_SCHEMA_VERSION = 1;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_DEFAULT_WIDTH = 248;

function fail(code: DomainErrorCode): never {
  throw new DomainError(code);
}

export interface NavigationSelection {
  readonly context: NavigationContext;
  readonly activity: Activity;
}

export function sameSelection(
  left: NavigationSelection,
  right: NavigationSelection,
): boolean {
  return (
    left.activity === right.activity && sameContext(left.context, right.context)
  );
}

export interface ActivitySnapshot {
  readonly activity: Activity;
  readonly resolution: SurfaceResolution;
}

export interface SidebarSnapshot {
  readonly width: number;
  readonly expandedWorkspaceIds: readonly WorkspaceId[];
}

export interface AgentSnapshot {
  readonly id: AgentId;
  readonly workspaceId: WorkspaceId;
  readonly profile: AgentProfile;
  readonly profileId: AgentProfileId;
  readonly profileKind: AgentProfile["kind"];
  readonly profileDisplayName: string;
  readonly displayName: string;
  readonly ordinal: number;
  readonly status: AgentStatus;
  readonly runtimeHealth: RuntimeHealth;
  readonly controlState: AgentControlState;
}

export type WorkspaceAggregateStatus = AgentStatus;

export interface WorkspaceSnapshot {
  readonly id: WorkspaceId;
  readonly label: string;
  readonly root: WorkspaceRoot;
  readonly selectedPath: DisplayPath;
  readonly repositoryId: RepositoryId | undefined;
  readonly state: WorkspaceState;
  readonly aggregateStatus: WorkspaceAggregateStatus;
  readonly agents: readonly AgentSnapshot[];
  readonly canCreateAgent: boolean;
}

/**
 * Whether the app has an editor host to draw against.
 *
 * In the Tauri app this tracked a VS Code Server that had to be started and
 * could refuse to. The workbench is a native view here, so `ready` is the
 * normal state — the type is kept because the App Shell renders all three and
 * a future host failure has to have somewhere to land.
 */
export type EditorHostState =
  | { readonly kind: "starting" }
  | { readonly kind: "ready" }
  | {
      readonly kind: "failed";
      readonly summary: string;
      readonly detail?: string;
    };

export interface AppSnapshot {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly selection: NavigationSelection;
  readonly activities: readonly ActivitySnapshot[];
  readonly workspaces: readonly WorkspaceSnapshot[];
  readonly sidebar: SidebarSnapshot;
  readonly editorHost: EditorHostState;
}

/** What a rolled-back close has to put back, exactly where it was. */
export interface WorkspaceCloseRollback {
  readonly workspace: Workspace;
  readonly index: number;
  readonly expanded: boolean;
  readonly selectionBefore: NavigationSelection;
  readonly selectionAfter: NavigationSelection;
}

function sameEditorHost(left: EditorHostState, right: EditorHostState): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "failed" && right.kind === "failed") {
    return left.summary === right.summary && left.detail === right.detail;
  }
  return true;
}

function aggregateStatus(workspace: Workspace): WorkspaceAggregateStatus {
  const agents = workspace.agents;
  if (agents.some((agent) => agent.status === "error")) return "error";
  if (agents.some((agent) => agent.status === "waiting")) return "waiting";
  if (agents.some((agent) => agent.status === "working")) return "working";
  return "idle";
}

export class AppModel {
  private readonly workspaceList: Workspace[] = [];
  private readonly repositoryMap = new Map<RepositoryId, Repository>();
  private readonly nextAgentOrdinals = new Map<string, number>();
  private readonly expandedWorkspaces = new Set<WorkspaceId>();
  private selectionValue: NavigationSelection = {
    context: GLOBAL_CONTEXT,
    activity: "terminal",
  };
  private sidebarWidthValue = SIDEBAR_DEFAULT_WIDTH;
  private editorHost: EditorHostState = { kind: "starting" };
  private revision = 0;

  snapshot(): AppSnapshot {
    return {
      schemaVersion: APP_SNAPSHOT_SCHEMA_VERSION,
      revision: this.revision,
      selection: this.selectionValue,
      activities: [...["editor", "agent", "terminal"] as const].map(
        (activity) => ({
          activity,
          resolution: this.resolveSurface(this.selectionValue.context, activity),
        }),
      ),
      workspaces: this.workspaceSnapshots(),
      sidebar: {
        width: this.sidebarWidthValue,
        expandedWorkspaceIds: [...this.expandedWorkspaces].sort(),
      },
      editorHost: this.editorHost,
    };
  }

  setEditorHostState(state: EditorHostState): boolean {
    if (sameEditorHost(this.editorHost, state)) {
      return false;
    }
    this.editorHost = state;
    return true;
  }

  get editorHostState(): EditorHostState {
    return this.editorHost;
  }

  get selection(): NavigationSelection {
    return this.selectionValue;
  }

  get sidebarWidth(): number {
    return this.sidebarWidthValue;
  }

  get workspaces(): readonly Workspace[] {
    return this.workspaceList;
  }

  get expandedWorkspaceIds(): readonly WorkspaceId[] {
    return [...this.expandedWorkspaces].sort();
  }

  restoreSidebar(
    width: number,
    expandedWorkspaceIds: Iterable<WorkspaceId>,
  ): boolean {
    if (width < SIDEBAR_MIN_WIDTH || width > SIDEBAR_MAX_WIDTH) {
      fail(DomainErrorCode.InvalidSidebarWidth);
    }
    const restored = new Set<WorkspaceId>();
    for (const id of expandedWorkspaceIds) {
      const workspace = this.workspace(id);
      if (!workspace) {
        fail(DomainErrorCode.UnknownWorkspace);
      }
      if (workspace.agents.length > 0) {
        restored.add(id);
      }
    }
    const changed =
      this.sidebarWidthValue !== width ||
      restored.size !== this.expandedWorkspaces.size ||
      [...restored].some((id) => !this.expandedWorkspaces.has(id));
    if (changed) {
      this.sidebarWidthValue = width;
      this.expandedWorkspaces.clear();
      for (const id of restored) {
        this.expandedWorkspaces.add(id);
      }
      this.bumpRevision();
    }
    return changed;
  }

  setSidebarWidth(width: number): boolean {
    if (width < SIDEBAR_MIN_WIDTH || width > SIDEBAR_MAX_WIDTH) {
      fail(DomainErrorCode.InvalidSidebarWidth);
    }
    if (this.sidebarWidthValue === width) {
      return false;
    }
    this.sidebarWidthValue = width;
    this.bumpRevision();
    return true;
  }

  setWorkspaceDisclosure(id: WorkspaceId, expanded: boolean): boolean {
    const workspace = this.workspace(id);
    if (!workspace) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    if (workspace.agents.length === 0) {
      return false;
    }
    const changed = expanded
      ? !this.expandedWorkspaces.has(id) && Boolean(this.expandedWorkspaces.add(id))
      : this.expandedWorkspaces.delete(id);
    if (changed) {
      this.bumpRevision();
    }
    return changed;
  }

  registerRepository(repository: Repository): void {
    const existing = this.repositoryMap.get(repository.id);
    if (existing) {
      if (existing.equals(repository)) {
        return;
      }
      fail(DomainErrorCode.RepositoryIdentityConflict);
    }
    for (const candidate of this.repositoryMap.values()) {
      if (repository.aliases.some((remote) => candidate.matchesRemote(remote))) {
        fail(DomainErrorCode.RepositoryRemoteConflict);
      }
    }
    this.repositoryMap.set(repository.id, repository);
  }

  repository(id: RepositoryId): Repository | undefined {
    return this.repositoryMap.get(id);
  }

  workspace(id: WorkspaceId): Workspace | undefined {
    return this.workspaceList.find((workspace) => workspace.id === id);
  }

  workspaceForAgent(id: AgentId): Workspace | undefined {
    return this.workspaceList.find((workspace) => workspace.agent(id));
  }

  addWorkspace(workspace: Workspace): void {
    if (this.workspace(workspace.id)) {
      fail(DomainErrorCode.DuplicateWorkspace);
    }
    if (
      this.workspaceList.some((candidate) => candidate.root === workspace.root)
    ) {
      fail(DomainErrorCode.DuplicateWorkspaceRoot);
    }
    if (
      workspace.repositoryId !== undefined &&
      !this.repositoryMap.has(workspace.repositoryId)
    ) {
      fail(DomainErrorCode.UnknownRepository);
    }
    this.workspaceList.push(workspace);
    this.bumpRevision();
  }

  associateRepository(
    id: WorkspaceId,
    repository: RepositoryId | undefined,
  ): void {
    if (repository !== undefined && !this.repositoryMap.has(repository)) {
      fail(DomainErrorCode.UnknownRepository);
    }
    const workspace = this.workspace(id);
    if (!workspace) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    if (workspace.setRepositoryId(repository)) {
      this.bumpRevision();
    }
  }

  addAgent(
    owner: WorkspaceId,
    id: AgentId,
    profile: AgentProfile,
  ): void {
    if (this.agent(id)) {
      fail(DomainErrorCode.DuplicateAgent);
    }
    const key = ordinalKey(owner, profile.id);
    const ordinal = this.nextAgentOrdinals.get(key) ?? 1;
    if (ordinal === Number.MAX_SAFE_INTEGER) {
      fail(DomainErrorCode.OrdinalExhausted);
    }
    const workspace = this.workspace(owner);
    if (!workspace) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    workspace.addAgent(Agent.create(id, owner, profile, ordinal));
    this.nextAgentOrdinals.set(key, ordinal + 1);
    this.selectionValue = { context: { kind: "agent", agentId: id }, activity: "agent" };
    this.bumpRevision();
  }

  restoreAgent(record: AgentRestoreRecord): void {
    const workspace = this.workspace(record.workspaceId);
    if (!workspace) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    if (this.agent(record.id)) {
      fail(DomainErrorCode.DuplicateAgent);
    }
    const agent = Agent.restore(record);
    if (agent.workspaceId !== record.workspaceId) {
      fail(DomainErrorCode.AgentWorkspaceMismatch);
    }
    if (agent.ordinal === Number.MAX_SAFE_INTEGER) {
      fail(DomainErrorCode.OrdinalExhausted);
    }
    const key = ordinalKey(record.workspaceId, agent.profile.id);
    workspace.restoreAgent(agent);
    const next = agent.ordinal + 1;
    this.nextAgentOrdinals.set(
      key,
      Math.max(this.nextAgentOrdinals.get(key) ?? next, next),
    );
    this.bumpRevision();
  }

  renameAgent(id: AgentId, displayName: string): void {
    const agent = this.requireAgent(id);
    if (agent.rename(displayName)) {
      this.bumpRevision();
    }
  }

  resetAgentName(id: AgentId): void {
    if (this.requireAgent(id).resetName()) {
      this.bumpRevision();
    }
  }

  setAgentStatus(id: AgentId, status: AgentStatus): void {
    if (this.requireAgent(id).setStatus(status)) {
      this.bumpRevision();
    }
  }

  setAgentRuntimeHealth(id: AgentId, health: RuntimeHealth): void {
    if (this.requireAgent(id).setRuntimeHealth(health)) {
      this.bumpRevision();
    }
  }

  reconcileAgents(reconciliation: AgentReconciliation): void {
    for (const observation of reconciliation.observations) {
      if (!this.agent(observation.agentId)) {
        fail(DomainErrorCode.UnknownAgent);
      }
    }
    const exited = new Set(reconciliation.exited);
    for (const id of exited) {
      if (!this.agent(id)) {
        fail(DomainErrorCode.UnknownAgent);
      }
    }
    for (const observation of reconciliation.observations) {
      if (exited.has(observation.agentId)) {
        continue;
      }
      this.setAgentStatus(observation.agentId, observation.status);
      this.setAgentRuntimeHealth(observation.agentId, observation.runtimeHealth);
    }
    for (const id of [...exited].sort()) {
      this.agentExited(id);
    }
  }

  requestAgentStop(id: AgentId): void {
    if (this.requireAgent(id).requestStop()) {
      this.bumpRevision();
    }
  }

  retryAgentStop(id: AgentId): void {
    const agent = this.requireAgent(id);
    if (agent.controlState.kind === "stopping") {
      return;
    }
    if (!agent.canRetryStop) {
      fail(DomainErrorCode.InvalidAgentControlTransition);
    }
    if (agent.requestStop()) {
      this.bumpRevision();
    }
  }

  markAgentStopFailed(id: AgentId, diagnostic: DiagnosticCode): void {
    if (this.requireAgent(id).markStopFailed(diagnostic)) {
      this.bumpRevision();
    }
  }

  returnAgentToRunning(id: AgentId): void {
    if (this.requireAgent(id).returnToRunning()) {
      this.bumpRevision();
    }
  }

  selectContext(context: NavigationContext): void {
    this.ensureContextExists(context);
    const activity: Activity =
      context.kind === "global"
        ? "terminal"
        : context.kind === "workspace"
          ? "editor"
          : "agent";
    const next: NavigationSelection = { context, activity };
    if (!sameSelection(this.selectionValue, next)) {
      this.selectionValue = next;
      this.bumpRevision();
    }
  }

  selectActivity(activity: Activity): void {
    if (
      this.resolveSurface(this.selectionValue.context, activity).kind !==
      "enabled"
    ) {
      fail(DomainErrorCode.ActivityDisabled);
    }
    if (this.selectionValue.activity !== activity) {
      this.selectionValue = { ...this.selectionValue, activity };
      this.bumpRevision();
    }
  }

  /**
   * The one place that decides whether an Activity is reachable, and what it
   * points at when it is. Every enable/disable in the UI comes from here.
   */
  resolveSurface(
    context: NavigationContext,
    activity: Activity,
  ): SurfaceResolution {
    if (context.kind === "global") {
      if (activity === "editor") {
        return { kind: "enabled", surfaceKey: { kind: "global-editor" } };
      }
      if (activity === "terminal") {
        return { kind: "enabled", surfaceKey: { kind: "global-terminal" } };
      }
      return { kind: "disabled", reason: "global-agent-not-applicable" };
    }

    if (context.kind === "workspace") {
      const workspace = this.workspace(context.workspaceId);
      if (!workspace) {
        return { kind: "disabled", reason: "workspace-unavailable" };
      }
      if (activity === "agent") {
        return {
          kind: "disabled",
          reason: "workspace-agent-requires-agent-selection",
        };
      }
      switch (workspace.state.kind) {
        case "available":
          return {
            kind: "enabled",
            surfaceKey:
              activity === "editor"
                ? { kind: "workspace-editor", workspaceId: context.workspaceId }
                : { kind: "workspace-terminal", workspaceId: context.workspaceId },
          };
        case "unavailable":
          return { kind: "disabled", reason: "workspace-unavailable" };
        case "closing":
          return { kind: "disabled", reason: "workspace-closing" };
        case "closing-failed":
          return { kind: "disabled", reason: "workspace-closing-failed" };
      }
    }

    const agent = this.agent(context.agentId);
    if (!agent) {
      return { kind: "disabled", reason: "workspace-unavailable" };
    }
    const workspace = this.workspace(agent.workspaceId);
    if (!workspace) {
      return { kind: "disabled", reason: "workspace-unavailable" };
    }
    if (activity === "agent") {
      return {
        kind: "enabled",
        surfaceKey: { kind: "agent", agentId: context.agentId },
      };
    }
    switch (workspace.state.kind) {
      case "available":
        return {
          kind: "enabled",
          surfaceKey:
            activity === "editor"
              ? { kind: "workspace-editor", workspaceId: agent.workspaceId }
              : { kind: "workspace-terminal", workspaceId: agent.workspaceId },
        };
      case "closing":
        return { kind: "disabled", reason: "workspace-closing" };
      case "unavailable":
        return { kind: "disabled", reason: "workspace-unavailable" };
      case "closing-failed":
        return { kind: "disabled", reason: "workspace-closing-failed" };
    }
  }

  agentExited(id: AgentId): void {
    const position = this.findAgentPosition(id);
    const workspace = this.workspaceList[position.workspaceIndex];
    const nextAgent = workspace.agents[position.agentIndex + 1]?.id;
    workspace.removeAgent(id);
    if (workspace.agents.length === 0) {
      this.expandedWorkspaces.delete(workspace.id);
    }
    if (
      this.selectionValue.context.kind === "agent" &&
      this.selectionValue.context.agentId === id
    ) {
      this.selectionValue = nextAgent
        ? { context: { kind: "agent", agentId: nextAgent }, activity: "agent" }
        : {
            context: { kind: "workspace", workspaceId: workspace.id },
            activity: "editor",
          };
    }
    this.bumpRevision();
  }

  closeWorkspace(id: WorkspaceId, inspection: CloseInspection): void {
    if (inspection.kind !== "clean") {
      fail(DomainErrorCode.WorkspaceNotClean);
    }
    const index = this.workspaceList.findIndex(
      (workspace) => workspace.id === id,
    );
    if (index < 0) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    if (this.workspaceList[index].agents.length > 0) {
      fail(DomainErrorCode.WorkspaceHasLiveAgents);
    }
    const next = this.workspaceList[index + 1]?.id;
    const previous = index > 0 ? this.workspaceList[index - 1]?.id : undefined;
    const context = this.selectionValue.context;
    const ownsSelection =
      context.kind === "workspace"
        ? context.workspaceId === id
        : context.kind === "agent"
          ? this.agent(context.agentId)?.workspaceId === id
          : false;
    this.workspaceList.splice(index, 1);
    this.expandedWorkspaces.delete(id);
    if (ownsSelection) {
      const successor = next ?? previous;
      this.selectionValue = successor
        ? {
            context: { kind: "workspace", workspaceId: successor },
            activity: "editor",
          }
        : { context: GLOBAL_CONTEXT, activity: "terminal" };
    }
    this.bumpRevision();
  }

  /** Close, but keep everything needed to put it back if the save fails. */
  closeWorkspaceForPersistence(
    id: WorkspaceId,
    inspection: CloseInspection,
  ): WorkspaceCloseRollback {
    const index = this.workspaceList.findIndex(
      (workspace) => workspace.id === id,
    );
    if (index < 0) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    const workspace = this.workspaceList[index].clone();
    const selectionBefore = this.selectionValue;
    const expanded = this.expandedWorkspaces.has(id);
    this.closeWorkspace(id, inspection);
    return {
      workspace,
      index,
      expanded,
      selectionBefore,
      selectionAfter: this.selectionValue,
    };
  }

  rollbackWorkspaceClose(rollback: WorkspaceCloseRollback): void {
    if (this.workspace(rollback.workspace.id)) {
      fail(DomainErrorCode.DuplicateWorkspaceRoot);
    }
    if (
      this.workspaceList.some(
        (workspace) => workspace.root === rollback.workspace.root,
      )
    ) {
      fail(DomainErrorCode.DuplicateWorkspaceRoot);
    }
    const index = Math.min(rollback.index, this.workspaceList.length);
    this.workspaceList.splice(index, 0, rollback.workspace);
    if (rollback.expanded) {
      this.expandedWorkspaces.add(this.workspaceList[index].id);
    }
    if (sameSelection(this.selectionValue, rollback.selectionAfter)) {
      this.selectionValue = rollback.selectionBefore;
    }
    this.bumpRevision();
  }

  relocateWorkspace(
    id: WorkspaceId,
    root: WorkspaceRoot,
    selectedPath: DisplayPath,
  ): void {
    const index = this.workspaceList.findIndex(
      (workspace) => workspace.id === id,
    );
    if (index < 0) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    const workspace = this.workspaceList[index];
    if (workspace.state.kind !== "unavailable") {
      fail(DomainErrorCode.WorkspaceNotUnavailable);
    }
    if (
      this.workspaceList.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index && candidate.root === root,
      )
    ) {
      fail(DomainErrorCode.DuplicateWorkspaceRoot);
    }
    if (workspace.root === root && workspace.selectedPath === selectedPath) {
      if (workspace.markAvailable()) {
        this.bumpRevision();
      }
      return;
    }
    workspace.relocate(root, selectedPath);
    this.bumpRevision();
  }

  markWorkspaceUnavailable(id: WorkspaceId, reason: DiagnosticCode): void {
    if (this.requireWorkspace(id).markUnavailable(reason)) {
      this.bumpRevision();
    }
  }

  markWorkspaceAvailable(id: WorkspaceId): void {
    if (this.requireWorkspace(id).markAvailable()) {
      this.bumpRevision();
    }
  }

  markWorkspaceClosingFailed(
    id: WorkspaceId,
    diagnostic: DiagnosticCode,
    progress: CleanupProgress,
  ): void {
    if (this.requireWorkspace(id).markClosingFailed(diagnostic, progress)) {
      this.bumpRevision();
    }
  }

  markWorkspaceClosing(id: WorkspaceId, progress: CleanupProgress): void {
    if (this.requireWorkspace(id).markClosing(progress)) {
      this.bumpRevision();
    }
  }

  updateWorkspaceClosingProgress(
    id: WorkspaceId,
    progress: CleanupProgress,
  ): void {
    if (this.requireWorkspace(id).updateClosingProgress(progress)) {
      this.bumpRevision();
    }
  }

  agent(id: AgentId): Agent | undefined {
    for (const workspace of this.workspaceList) {
      const agent = workspace.agent(id);
      if (agent) {
        return agent;
      }
    }
    return undefined;
  }

  private requireAgent(id: AgentId): Agent {
    const agent = this.agent(id);
    if (!agent) {
      fail(DomainErrorCode.UnknownAgent);
    }
    return agent;
  }

  private requireWorkspace(id: WorkspaceId): Workspace {
    const workspace = this.workspace(id);
    if (!workspace) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    return workspace;
  }

  private ensureContextExists(context: NavigationContext): void {
    if (context.kind === "workspace" && !this.workspace(context.workspaceId)) {
      fail(DomainErrorCode.UnknownWorkspace);
    }
    if (context.kind === "agent" && !this.agent(context.agentId)) {
      fail(DomainErrorCode.UnknownAgent);
    }
  }

  private findAgentPosition(id: AgentId): {
    workspaceIndex: number;
    agentIndex: number;
  } {
    for (const [workspaceIndex, workspace] of this.workspaceList.entries()) {
      const agentIndex = workspace.agents.findIndex((agent) => agent.id === id);
      if (agentIndex >= 0) {
        return { workspaceIndex, agentIndex };
      }
    }
    return fail(DomainErrorCode.UnknownAgent);
  }

  private bumpRevision(): void {
    this.revision += 1;
  }

  private workspaceSnapshots(): WorkspaceSnapshot[] {
    return this.workspaceList.map((workspace) => ({
      id: workspace.id,
      label: this.labelFor(workspace),
      root: workspace.root,
      selectedPath: workspace.selectedPath,
      repositoryId: workspace.repositoryId,
      state: workspace.state,
      aggregateStatus: aggregateStatus(workspace),
      canCreateAgent: isWorkspaceAvailable(workspace.state),
      agents: workspace.agents.map((agent) => ({
        id: agent.id,
        workspaceId: agent.workspaceId,
        profile: agent.profile,
        profileId: agent.profile.id,
        profileKind: agent.profile.kind,
        profileDisplayName: agent.profile.displayName,
        displayName: agent.displayName,
        ordinal: agent.ordinal,
        status: agent.status,
        runtimeHealth: agent.runtimeHealth,
        controlState: agent.controlState,
      })),
    }));
  }

  /**
   * The shortest label that tells two Workspaces apart: the folder name, and
   * only as much of the path above it as the collision needs.
   */
  private labelFor(workspace: Workspace): string {
    const basename = rootBasename(workspace.root);
    const collisions = this.workspaceList.filter(
      (candidate) => rootBasename(candidate.root) === basename,
    );
    if (collisions.length === 1) {
      return basename;
    }
    const parents = rootParentComponents(workspace.root);
    for (let depth = 1; depth <= parents.length; depth += 1) {
      const suffix = parents.slice(0, depth).join("/");
      const matching = collisions.filter((candidate) => {
        const candidateParents = rootParentComponents(candidate.root);
        return (
          candidateParents.length >= depth &&
          candidateParents.slice(0, depth).join("/") === suffix
        );
      }).length;
      if (matching === 1) {
        return `${basename} — ${parents.slice(0, depth).reverse().join("/")}`;
      }
    }
    return `${basename} — ${workspace.root}`;
  }
}

function ordinalKey(owner: WorkspaceId, profile: AgentProfileId): string {
  return `${owner} ${profile}`;
}

export { AVAILABLE };
