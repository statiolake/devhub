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
  type AgentInjection,
  type AgentProfileId,
  type AgentReconciliation,
  type AgentRestoreRecord,
  type AgentStatus,
  type CloseStep,
  type WorkspaceClose,
  type CloseInspection,
  type DiagnosticCode,
  type DisplayPath,
  type NavigationContext,
  type RepositoryId,
  type Repository,
  type RuntimeHealth,
  type SurfaceLayout,
  type SurfacePresentation,
  type UnreadReason,
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
 * The selection: what is selected, and how it is being shown.
 *
 * The presentation is here rather than on the context because it is not part
 * of what was selected — the same Agent selected two ways is the same Agent,
 * and the Sidebar highlights the same row either way. It is part of *this*
 * selection, which is why re-selecting what is already selected can still be a
 * change: opening an Agent that is already open, but on its own this time, has
 * to move the layout, and `sameSelection` is what decides whether anything
 * moved.
 */
export interface NavigationSelection {
  readonly context: NavigationContext;
  readonly presentation: SurfacePresentation;
}

export function sameSelection(
  left: NavigationSelection,
  right: NavigationSelection,
): boolean {
  return (
    sameContext(left.context, right.context) &&
    left.presentation === right.presentation
  );
}

export interface SidebarSnapshot {
  readonly width: number;
}

/**
 * A workspace, as much of one as the pair rule reads.
 *
 * Structural rather than a class or a wire type, because the rule is asked in
 * two places that hold two shapes of the same thing — the live model here, and
 * the wire snapshot the chord layer resolves against — and one rule written
 * twice is how the two chords about the pair came to disagree about which
 * Agent they meant.
 */
export interface AgentPairSource<Id extends string> {
  readonly lastAgentId?: Id | undefined;
  readonly agents: readonly { readonly id: Id }[];
}

/**
 * The Agent a workspace is paired with: the one it was last in, else its first.
 *
 * The one answer to "this workspace's other half", shared by everything that
 * asks it — `Cmd+Q Cmd+J`, which switches to it, `Cmd+Q Shift+J`, which puts it
 * beside the editor, and the layout, which has to know what the split's second
 * pane holds. A workspace with no Agents has no other half, and every one of
 * those callers is a no-op there.
 */
export function pairedAgentId<Id extends string>(
  workspace: AgentPairSource<Id>,
): Id | undefined {
  return workspace.lastAgentId ?? workspace.agents[0]?.id;
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
  /**
   * Why this Agent is owed a look, or nothing if it has been read.
   *
   * The reason is the status it went into while nobody was watching, so the
   * Sidebar's dot can be drawn in that status's own colour.
   */
  readonly unread: UnreadReason | undefined;
  /** What the Agent says it is doing, or nothing if it has not said. */
  readonly activity: string | undefined;
  readonly injection: AgentInjection;
}

export interface WorkspaceSnapshot {
  readonly id: WorkspaceId;
  readonly label: string;
  readonly root: WorkspaceRoot;
  readonly selectedPath: DisplayPath;
  readonly repositoryId: RepositoryId | undefined;
  readonly state: WorkspaceState;
  /** What its close has to say. See `WorkspaceClose`. */
  readonly close: WorkspaceClose;
  readonly agents: readonly AgentSnapshot[];
  readonly canCreateAgent: boolean;
  /** The Agent last selected here, if it is still running. */
  readonly lastAgentId: AgentId | undefined;
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

/**
 * Whether a status change is one the person would want to be told about.
 *
 * **One predicate, and this is it.** `setAgentStatus` is its only caller, and
 * the only thing in DevHub that raises an unread mark on its own.
 *
 * The rule is leaving `working`. An Agent that is working is an Agent nobody
 * has to watch; the moment it stops working it is either asking a question,
 * finished, broken, or unreadable, and all four are the person's turn. What
 * matters most is the finish — `working` → `idle` — which the old rule
 * ("entered `waiting`") missed entirely, and which is the case somebody
 * actually waits for.
 *
 * What is deliberately *not* here: anything that does not start from
 * `working`. `unknown` → anything is a first reading of a screen nobody had
 * read, not a change; `idle` → `idle` is nothing; `idle` → `waiting` without a
 * working spell in between is an Agent that never went away. Every one of them
 * would raise a mark for something that did not happen while you were gone.
 */
export function wantsAttention(
  previous: AgentStatus,
  next: AgentStatus,
): boolean {
  return previous === "working" && next !== "working";
}

export class AppModel {
  private readonly workspaceList: Workspace[] = [];
  private readonly repositoryMap = new Map<RepositoryId, Repository>();
  private readonly nextAgentOrdinals = new Map<string, number>();
  private selectionValue: NavigationSelection = {
    context: GLOBAL_CONTEXT,
    presentation: "full",
  };
  private sidebarWidthValue = SIDEBAR_DEFAULT_WIDTH;
  /**
   * Whether the DevHub window has the person in front of it.
   *
   * Main owns this fact — a workbench view can hold the keyboard while the
   * window behind it is deactivated, so nothing inside the page can see it —
   * and it arrives through `setWindowFocused` like any other observation. It
   * starts `true` because the window is created and shown focused, and main
   * republishes it on the first blur; starting `false` would make everything
   * on screen at startup unread the moment it stopped working.
   */
  private windowFocusedValue = true;
  /**
   * The Agent last selected in each workspace, by workspace id.
   *
   * What `toggle_workspace_agent` (`Cmd+Q Cmd+J`) comes back to. It is per
   * workspace because that is the question being asked — "the Agent I was in,
   * *here*" — and one global "last Agent" would send the chord to another
   * folder the first time you changed workspace.
   *
   * Recorded by `selectContext` and by nothing else, so an Agent the model
   * selected on its own (the successor to one that exited) does not become
   * somewhere you asked to be. An entry whose Agent has gone is dropped when it
   * is read, not when it exits: the exit path has enough rules already, and a
   * stale id answers the only question anybody asks of it — "is it still
   * there?" — perfectly well.
   */
  private readonly lastAgentByWorkspace = new Map<WorkspaceId, AgentId>();
  private splitRatioValue = SPLIT_DEFAULT_RATIO;
  private editorHost: EditorHostState = { kind: "starting" };
  private revision = 0;

  snapshot(): AppSnapshot {
    return {
      schemaVersion: APP_SNAPSHOT_SCHEMA_VERSION,
      revision: this.revision,
      selection: this.selectionValue,
      layout: this.resolveLayout(this.selectionValue),
      workspaces: this.workspaceSnapshots(),
      sidebar: { width: this.sidebarWidthValue },
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

  /**
   * The Agent last selected in this workspace, if it is still running.
   *
   * Checked here rather than kept true by every removal path: one reader, one
   * check, and no rule for another caller to forget.
   */
  lastAgentIn(workspaceId: WorkspaceId): AgentId | undefined {
    const remembered = this.lastAgentByWorkspace.get(workspaceId);
    if (remembered === undefined) return undefined;
    if (this.workspace(workspaceId)?.agent(remembered)) return remembered;
    this.lastAgentByWorkspace.delete(workspaceId);
    return undefined;
  }

  /**
   * Put back the Agent a workspace was last in, from the state file.
   *
   * No check that the Agent is still there: `lastAgentIn` already asks that of
   * every entry, so an id whose Agent did not come back is dropped the first
   * time anybody reads it, by the one rule that drops stale ids.
   */
  restoreLastAgent(workspaceId: WorkspaceId, agentId: AgentId): void {
    this.lastAgentByWorkspace.set(workspaceId, agentId);
  }

  get workspaces(): readonly Workspace[] {
    return this.workspaceList;
  }

  restoreSidebar(width: number): boolean {
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

  /**
   * Add an Agent and select it, shown the way the person asked for.
   *
   * Creating an Agent is a way of selecting it, so it takes the presentation
   * for the same reason `selectContext` does — and defaults it the same way,
   * to `full`.
   */
  addAgent(
    owner: WorkspaceId,
    id: AgentId,
    profile: AgentProfile,
    presentation: SurfacePresentation = "full",
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
    this.selectionValue = {
      context: { kind: "agent", agentId: id },
      presentation,
    };
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
   * Set an Agent's status, and raise its unread mark if it wanted you.
   *
   * The rule is one rule, stated once, here — where both the status and the
   * selection live. `wantsAttention` says whether the move is one worth coming
   * back to; `isAgentVisible` says whether you were there to see it. Nothing
   * else in the app decides either half, so a new caller of `setAgentStatus`
   * cannot get it wrong. The reason recorded is the status it moved into, so
   * the Sidebar can say *why* without a second vocabulary.
   */
  setAgentStatus(id: AgentId, status: AgentStatus): void {
    const agent = this.requireAgent(id);
    const attention = wantsAttention(agent.status, status);
    let changed = agent.setStatus(status);
    if (attention && !this.isAgentVisible(id) && agent.setUnread(status)) {
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
   * so is deciding you have not finished with it. The reason is whatever the
   * Agent is doing now, because that is what you are choosing to be reminded
   * of.
   */
  markAgentUnread(id: AgentId): void {
    const agent = this.requireAgent(id);
    if (agent.setUnread(agent.status)) {
      this.bumpRevision();
    }
  }

  /**
   * Whether the person can see this Agent right now.
   *
   * **One predicate, and this is it**, replacing "is it the selected Agent":
   * an Agent is being looked at when it is what the content area is drawing —
   * on its own, or in the side-by-side pane beside its Workspace's workbench —
   * *and* the window is in front. `resolveLayout` already answers the first
   * half for every arrangement there is, so a new arrangement cannot appear
   * with this rule left behind; the second half is why an Agent that finishes
   * while DevHub is behind the browser is still owed a look.
   */
  isAgentVisible(id: AgentId): boolean {
    return this.visibleAgentId() === id;
  }

  private visibleAgentId(): AgentId | undefined {
    if (!this.windowFocusedValue) {
      return undefined;
    }
    const layout = this.resolveLayout(this.selectionValue);
    if (layout.kind !== "agent" && layout.kind !== "split") {
      return undefined;
    }
    return layout.agent.kind === "agent" ? layout.agent.agentId : undefined;
  }

  /**
   * Tell the model whether DevHub is the window in front.
   *
   * Coming back to a visible Agent is reading it — the same event as opening
   * one, arriving the other way round — so it goes through the same one place
   * that clears the mark.
   */
  setWindowFocused(focused: boolean): void {
    if (this.windowFocusedValue === focused) {
      return;
    }
    this.windowFocusedValue = focused;
    this.readVisibleAgent();
    this.bumpRevision();
  }

  get windowFocused(): boolean {
    return this.windowFocusedValue;
  }

  /**
   * Clear the unread mark on whatever is being looked at.
   *
   * The only thing that clears it automatically, called from the two events
   * that can make the visibility predicate become true — a selection, and the
   * window coming forward. Returns whether anything actually changed.
   */
  private readVisibleAgent(): boolean {
    const visible = this.visibleAgentId();
    return (
      visible !== undefined &&
      this.agent(visible)?.setUnread(undefined) === true
    );
  }

  /** What the Agent says it is doing, as of the round that read its pane. */
  setAgentInjection(id: AgentId, injection: AgentInjection): void {
    if (this.requireAgent(id).setInjection(injection)) {
      this.bumpRevision();
    }
  }

  setAgentActivity(id: AgentId, activity: string | undefined): void {
    if (this.requireAgent(id).setActivity(activity)) {
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
      this.setAgentActivity(observation.agentId, observation.activity);
      this.setAgentInjection(observation.agentId, observation.injection);
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

  /**
   * Select something, and say how it should be shown.
   *
   * The presentation defaults to `full`, which is the plain click and the
   * plain Return. A caller that means "beside the workbench" has to say so,
   * because that is the modified gesture — and a caller that forgets cannot
   * accidentally produce the arrangement nobody asked for.
   *
   * `beside` names a split, and a split has two halves that can each be the
   * one in front: the Agent, and the workspace's editor. So a workspace
   * selection carries it too — that is how "the editor half of the split is
   * what I am in" is written down, and it is the same fact `Cmd+Q Shift+J`
   * reads to know which half to leave the split to.
   *
   * Anything with no other half to be beside is recorded as `full` whatever
   * the caller passed: Scratch, and a workspace with no Agents. That keeps the
   * invariant a fact about the stored value rather than a rule every reader has
   * to remember — there is no selection carrying a `beside` nothing would
   * honour.
   */
  selectContext(
    context: NavigationContext,
    presentation: SurfacePresentation = "full",
  ): void {
    this.ensureContextExists(context);
    const next: NavigationSelection = {
      context,
      presentation: this.canPresentBeside(context) ? presentation : "full",
    };
    // Choosing an Agent is what makes it the one this workspace comes back to.
    // Recorded on the way in, whether or not the selection actually moves, so
    // re-selecting the Agent you are already in still answers the question.
    if (context.kind === "agent") {
      const owner = this.agent(context.agentId)?.workspaceId;
      if (owner !== undefined) {
        this.lastAgentByWorkspace.set(owner, context.agentId);
      }
    }
    const moved = !sameSelection(this.selectionValue, next);
    this.selectionValue = next;
    // Selecting an Agent is reading it, because selecting it is what makes it
    // the thing being looked at — asked of the new selection, and answered by
    // the same predicate the window's focus is answered by, so a selection
    // made while DevHub is behind another app reads nothing. Re-selecting what
    // is already selected still reads it: an Agent marked unread by hand while
    // it was on screen is read again by clicking it.
    const read = this.readVisibleAgent();
    if (moved || read) {
      this.bumpRevision();
    }
  }

  /**
   * The Agent this workspace's chords and its split are about.
   *
   * `pairedAgentId`'s one rule, asked of the live model; the chord layer asks
   * the same function of the wire snapshot.
   */
  pairedAgentIn(workspaceId: WorkspaceId): AgentId | undefined {
    const workspace = this.workspace(workspaceId);
    if (!workspace) return undefined;
    return pairedAgentId({
      lastAgentId: this.lastAgentIn(workspaceId),
      agents: workspace.agents,
    });
  }

  /** Whether this context has an other half to be shown beside. */
  private canPresentBeside(context: NavigationContext): boolean {
    if (context.kind === "agent") return true;
    if (context.kind === "global") return false;
    return this.pairedAgentIn(context.workspaceId) !== undefined;
  }

  /**
   * Side by side: put the keyboard in the other half.
   *
   * The half in front *is* the selection — a split with the Agent selected and
   * a split with the workspace selected are the same two panes with the
   * keyboard in a different one — so moving between them is an ordinary
   * selection and not a second notion of focus the layout would have to be
   * reconciled with. Both `Cmd+Q Cmd+J` and `Cmd+Q O` come here, and outside a
   * split there is no other half, so it is a no-op.
   */
  swapSplitFocus(): void {
    const selection = this.selectionValue;
    if (selection.presentation !== "beside") return;
    const context = selection.context;
    if (context.kind === "agent") {
      const workspace = this.agent(context.agentId)?.workspaceId;
      if (workspace === undefined) return;
      this.selectContext(
        { kind: "workspace", workspaceId: workspace },
        "beside",
      );
      return;
    }
    if (context.kind !== "workspace") return;
    const agent = this.pairedAgentIn(context.workspaceId);
    if (agent === undefined) return;
    this.selectContext({ kind: "agent", agentId: agent }, "beside");
  }

  /**
   * The one place that decides what the content area holds, and what it points
   * at. Everything the page draws in it comes from here.
   */
  resolveLayout(selection: NavigationSelection): SurfaceLayout {
    const context = selection.context;
    if (context.kind === "global") {
      return { kind: "workbench", editor: { kind: "global-editor" } };
    }

    if (context.kind === "workspace") {
      const workspace = this.workspace(context.workspaceId);
      if (!workspace || !showable(workspace)) {
        return { kind: "unavailable" };
      }
      const editor = {
        kind: "workspace-editor",
        workspaceId: workspace.id,
      } as const;
      // The editor half of a split: the same two panes an Agent selected
      // `beside` draws, with the keyboard in the other one.
      const paired =
        selection.presentation === "beside"
          ? this.pairedAgentIn(workspace.id)
          : undefined;
      if (paired !== undefined) {
        return {
          kind: "split",
          editor,
          agent: { kind: "agent", agentId: paired },
        };
      }
      return { kind: "workbench", editor };
    }

    const agent = this.agent(context.agentId);
    const workspace = agent ? this.workspace(agent.workspaceId) : undefined;
    if (!agent || !workspace || !showable(workspace)) {
      return { kind: "unavailable" };
    }
    // An Agent is the whole content area, unless the person asked for it
    // beside the workbench. Both arrangements keep the Workspace's workbench
    // running — a full-screen Agent covers it, it is not closed — so moving
    // between them costs nothing and loses nothing.
    if (selection.presentation === "full") {
      return { kind: "agent", agent: { kind: "agent", agentId: agent.id } };
    }
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
      // Whatever the departing Agent was shown as, the successor is shown on
      // its own: `beside` was asked for about an Agent that is gone.
      this.selectionValue = {
        context: nextAgent
          ? { kind: "agent", agentId: nextAgent }
          : { kind: "workspace", workspaceId: workspace.id },
        presentation: "full",
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
    if (ownsSelection) {
      const successor = next ?? previous;
      this.selectionValue = {
        context: successor
          ? { kind: "workspace", workspaceId: successor }
          : GLOBAL_CONTEXT,
        presentation: "full",
      };
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

  beginWorkspaceClose(id: WorkspaceId): void {
    if (this.requireWorkspace(id).beginClose()) {
      this.bumpRevision();
    }
  }

  markWorkspaceCloseFailed(
    id: WorkspaceId,
    step: CloseStep,
    diagnostic: DiagnosticCode,
  ): void {
    if (this.requireWorkspace(id).closeFailed(step, diagnostic)) {
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
      close: workspace.close,
      canCreateAgent: workspace.canCreateAgent,
      lastAgentId: this.lastAgentIn(workspace.id),
      agents: workspace.agents.map((agent) => ({
        id: agent.id,
        workspaceId: agent.workspaceId,
        profile: agent.profile,
        profileId: agent.profile.id,
        profileKind: agent.profile.kind,
        profileDisplayName: agent.profile.displayName,
        displayName: agentLabelFor(agent, workspace.agents),
        ordinal: agent.ordinal,
        status: agent.status,
        runtimeHealth: agent.runtimeHealth,
        controlState: agent.controlState,
        unread: agent.unread,
        activity: agent.activity,
        injection: agent.injection,
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

/**
 * The shortest name that tells two Agents in one Workspace apart.
 *
 * The same rule as `labelFor` one level down, and for the same reason: a name
 * is as long as the collision makes it and no longer. The ordinal exists to
 * separate siblings — "Codex 1" from "Codex 2" — so a Workspace holding one
 * Codex has nothing to separate, and the number is a character every row of
 * the Sidebar carries to say nothing.
 *
 * A name the person typed is theirs, and is neither shortened nor counted: an
 * Agent renamed "Investigator" is not a second Codex the remaining one has to
 * be numbered against.
 *
 * This is the name the whole application shows — the Sidebar row, the window
 * title, the rename sheet — because it is computed where the snapshot is, and
 * the snapshot is what every one of those reads. The Agent's own `displayName`
 * is untouched; it is what gets written down, and a name that shortened itself
 * on disk would come back different when a sibling arrived.
 */
/**
 * Whether there is anything worth drawing in this Workspace's content area.
 *
 * A folder that is not there has nothing to show, and neither has a Workspace
 * whose close is running: its workbench view is being taken down as part of
 * that close, so the pane says the close is happening rather than drawing a
 * workbench that is about to vanish under it.
 */
function showable(workspace: Workspace): boolean {
  return (
    isWorkspaceAvailable(workspace.state) && workspace.close.kind !== "running"
  );
}

function agentLabelFor(agent: Agent, siblings: readonly Agent[]): string {
  const chosen = agent.temporaryName;
  if (chosen !== undefined) return chosen;
  const collisions = siblings.filter(
    (candidate) =>
      candidate.temporaryName === undefined &&
      candidate.profile.id === agent.profile.id,
  );
  return collisions.length === 1
    ? agent.profile.displayName
    : agent.displayName;
}

function ordinalKey(owner: WorkspaceId, profile: AgentProfileId): string {
  return `${owner}\u0000${profile}`;
}

export { AVAILABLE };
