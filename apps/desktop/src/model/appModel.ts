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
  type SurfaceLayout,
  type WorkspaceId,
  type WorkspaceRoot,
  type WorkspaceState,
} from "./domain.js";

export const APP_SNAPSHOT_SCHEMA_VERSION = 1;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_DEFAULT_WIDTH = 248;
/**
 * How much of the content area the workbench takes when an Agent is selected.
 *
 * A ratio rather than a width: the split is between two panes of one area, and
 * the area changes size with the window while the person's sense of "a bit more
 * than half for the editor" does not. The bounds are what leaves both panes
 * usable — a workbench narrower than a quarter has no editor left in it, and an
 * Agent pane narrower than that cannot hold a terminal's eighty columns.
 */
export const SPLIT_MIN_RATIO = 0.25;
export const SPLIT_MAX_RATIO = 0.85;
export const SPLIT_DEFAULT_RATIO = 0.55;

function fail(code: DomainErrorCode): never {
  throw new DomainError(code);
}

/**
 * The selection, which is the context and nothing else.
 *
 * It carried an Activity beside the context until the Activity ring was
 * retired. The wrapper stays because the persisted record and the wire both
 * name a `selection`, and because a selection is a thing the model has one of
 * — but there is now exactly one field, and `sameSelection` is `sameContext`.
 */
export interface NavigationSelection {
  readonly context: NavigationContext;
}

export function sameSelection(
  left: NavigationSelection,
  right: NavigationSelection,
): boolean {
  return sameContext(left.context, right.context);
}

export interface SidebarSnapshot {
  readonly width: number;
  /**
   * Whether the sidebar is the full pane rather than the icon rail.
   *
   * The sidebar is never absent: collapsed, it is a rail of one glyph per
   * Workspace, so this says which of its two forms is on screen and not
   * whether it exists. Separate from the width on purpose: collapsing must not
   * forget how wide the person made the pane, and a width of zero is not a
   * legal width.
   */
  readonly expanded: boolean;
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
  /** The Agent asked for attention and nobody has opened it since. */
  readonly unread: boolean;
}

export interface WorkspaceSnapshot {
  readonly id: WorkspaceId;
  readonly label: string;
  readonly root: WorkspaceRoot;
  readonly selectedPath: DisplayPath;
  readonly repositoryId: RepositoryId | undefined;
  readonly state: WorkspaceState;
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
  /** What the content area holds for that selection. */
  readonly layout: SurfaceLayout;
  readonly workspaces: readonly WorkspaceSnapshot[];
  readonly sidebar: SidebarSnapshot;
  /** Where the divider sits when the layout is a split. */
  readonly splitRatio: number;
  readonly editorHost: EditorHostState;
}

/** What a rolled-back close has to put back, exactly where it was. */
export interface WorkspaceCloseRollback {
  readonly workspace: Workspace;
  readonly index: number;
  readonly selectionBefore: NavigationSelection;
  readonly selectionAfter: NavigationSelection;
}

function sameEditorHost(
  left: EditorHostState,
  right: EditorHostState,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "failed" && right.kind === "failed") {
    return left.summary === right.summary && left.detail === right.detail;
  }
  return true;
}

export class AppModel {
  private readonly workspaceList: Workspace[] = [];
  private readonly repositoryMap = new Map<RepositoryId, Repository>();
  private readonly nextAgentOrdinals = new Map<string, number>();
  private selectionValue: NavigationSelection = { context: GLOBAL_CONTEXT };
  private sidebarWidthValue = SIDEBAR_DEFAULT_WIDTH;
  private splitRatioValue = SPLIT_DEFAULT_RATIO;
  private sidebarExpandedValue = true;
  private editorHost: EditorHostState = { kind: "starting" };
  private revision = 0;

  snapshot(): AppSnapshot {
    return {
      schemaVersion: APP_SNAPSHOT_SCHEMA_VERSION,
      revision: this.revision,
      selection: this.selectionValue,
      layout: this.resolveLayout(this.selectionValue.context),
      workspaces: this.workspaceSnapshots(),
      sidebar: {
        width: this.sidebarWidthValue,
        expanded: this.sidebarExpandedValue,
      },
      splitRatio: this.splitRatioValue,
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

  restoreSidebar(width: number, expanded = true): boolean {
    if (width < SIDEBAR_MIN_WIDTH || width > SIDEBAR_MAX_WIDTH) {
      fail(DomainErrorCode.InvalidSidebarWidth);
    }
    const changed =
      this.sidebarWidthValue !== width ||
      this.sidebarExpandedValue !== expanded;
    if (changed) {
      this.sidebarWidthValue = width;
      this.sidebarExpandedValue = expanded;
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

  get splitRatio(): number {
    return this.splitRatioValue;
  }

  /**
   * Move the divider. Out-of-range is a bug in the caller, not a value to
   * clamp quietly: the page clamps a pointer before it crosses the seam, the
   * same way it does for the sidebar's width.
   */
  setSplitRatio(ratio: number): boolean {
    if (ratio < SPLIT_MIN_RATIO || ratio > SPLIT_MAX_RATIO) {
      fail(DomainErrorCode.InvalidSplitRatio);
    }
    if (this.splitRatioValue === ratio) {
      return false;
    }
    this.splitRatioValue = ratio;
    this.bumpRevision();
    return true;
  }

  /** Restoring is setting, minus the revision bump on an unchanged value. */
  restoreSplitRatio(ratio: number): boolean {
    return this.setSplitRatio(ratio);
  }

  get sidebarExpanded(): boolean {
    return this.sidebarExpandedValue;
  }

  setSidebarExpanded(expanded: boolean): boolean {
    if (this.sidebarExpandedValue === expanded) {
      return false;
    }
    this.sidebarExpandedValue = expanded;
    this.bumpRevision();
    return true;
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
      if (
        repository.aliases.some((remote) => candidate.matchesRemote(remote))
      ) {
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

  addAgent(owner: WorkspaceId, id: AgentId, profile: AgentProfile): void {
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
    this.selectionValue = { context: { kind: "agent", agentId: id } };
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

  /**
   * Set an Agent's status, and raise its unread flag if it just asked for you.
   *
   * The rule is one rule, stated once, here — where both the status and the
   * selection live. An Agent becomes unread when it *enters* `waiting` and it
   * is not the thing on screen; if it is on screen, you are already looking at
   * the question, so there is nothing to come back to. Nothing else in the app
   * decides this, so a new caller of `setAgentStatus` cannot get it wrong.
   */
  setAgentStatus(id: AgentId, status: AgentStatus): void {
    const agent = this.requireAgent(id);
    const entered = agent.status !== "waiting" && status === "waiting";
    let changed = agent.setStatus(status);
    if (entered && !this.isSelectedAgent(id) && agent.setUnread(true)) {
      changed = true;
    }
    if (changed) {
      this.bumpRevision();
    }
  }

  /**
   * Put an Agent back in the unread pile by hand.
   *
   * The counterpart to opening one, and the reason unread is not simply
   * "waiting and not selected": having looked at something is a decision, and
   * so is deciding you have not finished with it.
   */
  markAgentUnread(id: AgentId): void {
    if (this.requireAgent(id).setUnread(true)) {
      this.bumpRevision();
    }
  }

  private isSelectedAgent(id: AgentId): boolean {
    const context = this.selectionValue.context;
    return context.kind === "agent" && context.agentId === id;
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
      this.setAgentRuntimeHealth(
        observation.agentId,
        observation.runtimeHealth,
      );
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
    // Opening an Agent is reading it. This is the only place that clears the
    // flag automatically, so "it went away and I do not know why" has one
    // answer.
    const read =
      context.kind === "agent" &&
      this.agent(context.agentId)?.setUnread(false) === true;
    const next: NavigationSelection = { context };
    if (!sameSelection(this.selectionValue, next)) {
      this.selectionValue = next;
      this.bumpRevision();
    } else if (read) {
      // Re-selecting what is already selected still reads it: an Agent marked
      // unread by hand while it was on screen is read again by clicking it.
      this.bumpRevision();
    }
  }

  /**
   * The one place that decides what the content area holds, and what it points
   * at. Everything the page draws in it comes from here.
   */
  resolveLayout(context: NavigationContext): SurfaceLayout {
    if (context.kind === "global") {
      return { kind: "workbench", editor: { kind: "global-editor" } };
    }

    if (context.kind === "workspace") {
      const workspace = this.workspace(context.workspaceId);
      if (!workspace || !isWorkspaceAvailable(workspace.state)) {
        return { kind: "unavailable" };
      }
      return {
        kind: "workbench",
        editor: { kind: "workspace-editor", workspaceId: workspace.id },
      };
    }

    const agent = this.agent(context.agentId);
    const workspace = agent ? this.workspace(agent.workspaceId) : undefined;
    if (!agent || !workspace || !isWorkspaceAvailable(workspace.state)) {
      return { kind: "unavailable" };
    }
    // An Agent is not a place of its own: it is a pane beside the workbench of
    // the Workspace it runs in, and selecting it must not take that workbench
    // away. That is the whole of what the split is for.
    return {
      kind: "split",
      editor: { kind: "workspace-editor", workspaceId: workspace.id },
      agent: { kind: "agent", agentId: agent.id },
    };
  }

  agentExited(id: AgentId): void {
    const position = this.findAgentPosition(id);
    const workspace = this.workspaceList[position.workspaceIndex];
    const nextAgent = workspace.agents[position.agentIndex + 1]?.id;
    workspace.removeAgent(id);
    if (
      this.selectionValue.context.kind === "agent" &&
      this.selectionValue.context.agentId === id
    ) {
      this.selectionValue = nextAgent
        ? { context: { kind: "agent", agentId: nextAgent } }
        : { context: { kind: "workspace", workspaceId: workspace.id } };
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
    if (ownsSelection) {
      const successor = next ?? previous;
      this.selectionValue = successor
        ? { context: { kind: "workspace", workspaceId: successor } }
        : { context: GLOBAL_CONTEXT };
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
    this.closeWorkspace(id, inspection);
    return {
      workspace,
      index,
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
        unread: agent.unread,
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
