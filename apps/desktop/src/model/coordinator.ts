/**
 * The application coordinator: the only place domain transitions are combined
 * with adapter-facing operations.
 *
 * A port of `crates/devhub-app-core/src/application/coordinator.rs`. Three
 * properties are the reason this is a state machine and not a pile of async
 * functions, and every one of them survives the move to Electron:
 *
 * - **Nothing here performs an effect.** It emits one, tagged with a token, and
 *   waits for a completion carrying that exact token. A stale answer to a
 *   superseded operation is rejected rather than applied to whatever is current.
 * - **A dispatch is idempotent by identity.** The same `IntentId` replays the
 *   cached result; a different intent under a used id is a duplicate, not a
 *   silent overwrite. A shell page that reloads mid-operation cannot double it.
 * - **Every emitted event is sequenced and retained**, so a page that missed a
 *   window of them replays from its cursor and is told when the gap is real.
 */

import {
  agentIsIdle,
  CLEAN_CLOSE_INSPECTION,
  closeInspectionProjection,
  consolidateCloseInspection,
  DomainErrorCode,
  GLOBAL_CONTEXT,
  Workspace,
  type AgentId,
  type AgentProfile,
  type AgentProfileId,
  type CloseInspectionInputs,
  type CloseInspectionProjection,
  type DisplayPath,
  type SurfacePresentation,
  type WorkspaceId,
  type WorkspaceRoot,
} from "./domain.js";
import {
  AppModel,
  type AppSnapshot,
  type EditorHostState,
  type WorkspaceCloseRollback,
} from "./appModel.js";
import {
  AppError,
  AppErrorCode,
  type PortName,
  operationToken,
  requestedPath,
  sameToken,
  tokenKey,
  type AgentLaunchResult,
  type AgentStopResult,
  type AppReadiness,
  type ConfirmationId,
  type ConfirmationOutcomePurpose,
  type ConfirmationPurpose,
  type DetachReason,
  type IntentEnvelope,
  type IntentId,
  type IntentOutcome,
  type OperationId,
  type OperationToken,
  type ProviderEvent,
  type ProviderEventEnvelope,
  type ProviderEventId,
  type RequestedPath,
  type UserIntent,
  type WorkspaceCloseResult,
  type WorktreeDisposition,
} from "./intents.js";

export const MAX_INTENT_LEDGER_ENTRIES = 1024;
export const MAX_PROVIDER_LEDGER_ENTRIES = 1024;
export const MAX_CONFIRMATION_ID_ENTRIES = 1024;
export const MAX_COMPLETED_TOKEN_ENTRIES = 1024;
export const MAX_RETAINED_EVENTS = 4096;

/** What the coordinator asks an adapter to do. It never does it itself. */
export type Effect =
  | { readonly kind: "noop" }
  | { readonly kind: "detach"; readonly reason: DetachReason }
  | {
      readonly kind: "resolve_workspace_path";
      readonly token: OperationToken;
      readonly path: RequestedPath;
    }
  | {
      readonly kind: "generate_workspace_id";
      readonly token: OperationToken;
      readonly root: WorkspaceRoot;
      readonly selectedPath: DisplayPath;
    }
  | {
      readonly kind: "resolve_agent_profile";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
      readonly profileId: AgentProfileId;
      /** Appended to the resolved profile's arguments, for this Agent only. */
      readonly extraArgs: readonly string[];
    }
  | {
      readonly kind: "generate_confirmation_id";
      readonly token: OperationToken;
      readonly purpose: ConfirmationPurpose;
    }
  | {
      readonly kind: "generate_agent_id";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly kind: "launch_agent";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
      readonly agentId: AgentId;
      readonly profile: AgentProfile;
    }
  | {
      readonly kind: "inspect_workspace";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly kind: "stop_agent";
      readonly token: OperationToken;
      readonly agentId: AgentId;
    }
  | {
      readonly kind: "terminate_agent";
      readonly token: OperationToken;
      readonly agentId: AgentId;
    }
  | { readonly kind: "reconcile_agents"; readonly token: OperationToken }
  | {
      readonly kind: "reconcile_agent";
      readonly token: OperationToken;
      readonly agentId: AgentId;
    }
  | {
      readonly kind: "close_workspace";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
      readonly worktree: WorktreeDisposition;
    }
  | { readonly kind: "persist_state"; readonly token: OperationToken };

export type CoordinatorEvent =
  | { readonly kind: "snapshot"; readonly snapshot: AppSnapshot }
  | { readonly kind: "effect"; readonly effect: Effect }
  | { readonly kind: "noop" }
  | { readonly kind: "error"; readonly error: AppError }
  | { readonly kind: "operation_completed"; readonly token: OperationToken };

export interface SequencedCoordinatorEvent {
  readonly sequence: number;
  readonly event: CoordinatorEvent;
}

export interface CoordinatorSubscription {
  readonly cursor: number;
  readonly events: readonly SequencedCoordinatorEvent[];
  readonly historyGap: boolean;
  readonly snapshot: AppSnapshot;
}

export type CoordinatorReplay = CoordinatorSubscription;

type OperationKind =
  | "resolve_workspace_path"
  | "generate_workspace_id"
  | "resolve_agent_profile"
  | "generate_confirmation_id"
  | "generate_agent_id"
  | "launch_agent"
  | "inspect_workspace"
  | "stop_agent"
  | "reconcile_agent"
  | "reconcile_agents"
  | "terminate_agent"
  | "persist_state"
  | "close_workspace";

/**
 * What an operation was talking to. A port failure means "that side could not
 * do it", and which side it was is exactly what the operation's kind says.
 */
function portFor(kind: OperationKind): PortName {
  switch (kind) {
    case "launch_agent":
    case "stop_agent":
    case "terminate_agent":
    case "reconcile_agent":
    case "reconcile_agents":
      return "agent";
    case "persist_state":
      return "state";
    default:
      return "app";
  }
}

type OperationTarget =
  | { readonly kind: "path"; readonly path: RequestedPath }
  | { readonly kind: "workspace_path"; readonly workspaceId: WorkspaceId }
  | {
      readonly kind: "resolved_path";
      readonly root: WorkspaceRoot;
      readonly selectedPath: DisplayPath;
    }
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "agent"; readonly agentId: AgentId }
  | {
      readonly kind: "agent_launch";
      readonly workspaceId: WorkspaceId;
      readonly agentId: AgentId;
    }
  | {
      readonly kind: "profile";
      readonly workspaceId: WorkspaceId;
      readonly profileId: AgentProfileId;
    }
  | { readonly kind: "application" };

interface PendingOperation {
  readonly token: OperationToken;
  readonly kind: OperationKind;
  readonly target: OperationTarget;
}

interface CachedDispatch {
  readonly fingerprint: string;
  readonly outcome: IntentOutcome | undefined;
  readonly error: AppError | undefined;
}

type PendingConfirmationState =
  | {
      readonly kind: "stop";
      readonly confirmationId: ConfirmationId;
      readonly agentId: AgentId;
    }
  | {
      readonly kind: "workspace_close";
      readonly confirmationId: ConfirmationId;
      readonly workspaceId: WorkspaceId;
      readonly worktree: WorktreeDisposition;
      readonly inspection: CloseInspectionProjection;
    };

type PendingConfirmationRequest =
  | { readonly kind: "stop"; readonly agentId: AgentId }
  | {
      readonly kind: "workspace_close";
      readonly workspaceId: WorkspaceId;
      readonly worktree: WorktreeDisposition;
      readonly inspection: CloseInspectionProjection;
    };

type ActiveReconcile =
  | {
      readonly kind: "agents";
      readonly token: OperationToken;
      readonly epoch: number;
    }
  | {
      readonly kind: "agent";
      readonly token: OperationToken;
      readonly agentId: AgentId;
      readonly epoch: number;
    };

/**
 * A close that has been asked for and is still asking its questions.
 *
 * It holds the answer to the folder question, which was given before the
 * close was asked for at all, so that the answer survives the inspection and
 * the confirmation without either of them having to know about it.
 */
interface CloseRequest {
  readonly workspaceId: WorkspaceId;
  readonly worktree: WorktreeDisposition;
}

/**
 * A dispatch is the same dispatch when everything about it is the same. The
 * only structure that does not compare by value is an `AgentProfile`, which
 * knows how to compare itself.
 */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (raw instanceof Map) {
      return [...raw].sort(([left], [right]) => (left < right ? -1 : 1));
    }
    if (raw instanceof Set) {
      return [...raw].sort();
    }
    return raw;
  });
}

/**
 * The one error a close that did not finish becomes.
 *
 * Every place a workspace lands in `closing-failed` raises this, so the alert
 * reads the same whichever step gave up, and the step itself is on the
 * workspace as its `stateDiagnostic` rather than in three sentences written
 * three times.
 */
function closeFailedError(operationId: OperationId): AppError {
  return new AppError(AppErrorCode.Domain)
    .withDomain(DomainErrorCode.WorkspaceClosingFailed)
    .withOperation(operationId);
}

export class AppCoordinator {
  private readonly events: SequencedCoordinatorEvent[] = [];
  private nextSequence = 0;
  private subscriberCursor = 0;
  private readonly intentCache = new Map<IntentId, CachedDispatch>();
  private readonly intentOrder: IntentId[] = [];
  private readonly providerEventCache = new Map<
    ProviderEventId,
    CachedDispatch
  >();
  private readonly providerEventOrder: ProviderEventId[] = [];
  private readonly confirmationIds = new Set<ConfirmationId>();
  private readonly confirmationIdOrder: ConfirmationId[] = [];
  private readonly pending = new Map<OperationId, PendingOperation>();
  private readonly completedTokens = new Map<OperationId, OperationToken>();
  private readonly completedTokenOrder: [OperationId, OperationToken][] = [];
  private readonly resolvedPaths = new Map<
    OperationId,
    { root: WorkspaceRoot; selectedPath: DisplayPath }
  >();
  // The presentation rides along with the profile from the moment the request
  // is made until the Agent is in the model, because "open it beside the
  // workbench" is part of that one request — not a second command that could
  // arrive after the row already appeared somewhere else.
  private readonly resolvedProfiles = new Map<
    OperationId,
    {
      workspaceId: WorkspaceId;
      profile: AgentProfile;
      presentation: SurfacePresentation;
    }
  >();
  private readonly launchProfiles = new Map<
    OperationId,
    {
      workspaceId: WorkspaceId;
      agentId: AgentId;
      profile: AgentProfile;
      presentation: SurfacePresentation;
    }
  >();
  /** The presentation an agent-creation request asked for, until it lands. */
  private readonly requestedPresentations = new Map<
    OperationId,
    SurfacePresentation
  >();
  /** Closes that are still asking their questions. See `CloseRequest`. */
  private readonly closeRequests = new Map<OperationId, CloseRequest>();
  private readonly confirmationRequests = new Map<
    OperationId,
    PendingConfirmationRequest
  >();
  private confirmations: PendingConfirmationState[] = [];
  private readonly finalizationPending = new Set<OperationId>();
  private readonly finalizationWorkspaces = new Map<OperationId, WorkspaceId>();
  private readonly finalizationRoots = new Map<WorkspaceRoot, OperationId>();
  private readonly finalizationBackups = new Map<
    OperationId,
    WorkspaceCloseRollback
  >();
  private nextGeneration = 0;
  private readonly naturalExitStopTokens = new Map<string, AgentId>();
  private readonly naturalExitStopOrder: string[] = [];
  private activeReconcile: ActiveReconcile | undefined;
  private reconcileEpoch = 0;
  private readinessValue: AppReadiness = "starting";
  private detached: DetachReason | undefined;

  constructor(readonly model: AppModel = new AppModel()) {
    this.emit({ kind: "snapshot", snapshot: model.snapshot() });
  }

  snapshot(): AppSnapshot {
    return this.model.snapshot();
  }

  get readiness(): AppReadiness {
    return this.readinessValue;
  }

  markReady(): void {
    this.readinessValue = "ready";
  }

  get isDetached(): boolean {
    return this.detached !== undefined;
  }

  setEditorHostState(state: EditorHostState): boolean {
    const changed = this.model.setEditorHostState(state);
    if (changed) {
      this.emit({ kind: "snapshot", snapshot: this.snapshot() });
    }
    return changed;
  }

  subscribe(): CoordinatorSubscription {
    const subscription = this.subscribeFrom(this.subscriberCursor);
    this.subscriberCursor = this.nextSequence;
    return subscription;
  }

  subscribeFrom(cursor: number): CoordinatorSubscription {
    return {
      cursor: this.nextSequence,
      events: this.events.filter((event) => event.sequence > cursor),
      historyGap:
        this.events.length > 0 && cursor + 1 < this.events[0].sequence,
      snapshot: this.snapshot(),
    };
  }

  replayFrom(cursor: number): CoordinatorReplay {
    return this.subscribeFrom(cursor);
  }

  // ---------------------------------------------------------------- dispatch

  dispatchUser(envelope: IntentEnvelope): IntentOutcome {
    const { intentId: id, operationId: trustedOperationId, intent } = envelope;
    const print = fingerprint({ operationId: trustedOperationId, intent });
    const cached = this.intentCache.get(id);
    if (cached) {
      if (cached.fingerprint === print) {
        this.emit({ kind: "noop" });
        return this.replayCached(cached);
      }
      const error = new AppError(AppErrorCode.DuplicateIntent).withIntent(id);
      this.emit({ kind: "error", error });
      throw error;
    }

    if (this.detached !== undefined) {
      const outcome: IntentOutcome = {
        kind: "detached",
        snapshot: this.snapshot(),
      };
      this.cacheIntent(id, print, outcome, undefined);
      this.emit({ kind: "noop" });
      return outcome;
    }

    if (trustedOperationId === undefined) {
      const error = new AppError(AppErrorCode.InvalidIntent).withIntent(id);
      this.cacheIntent(id, print, undefined, error);
      this.emit({ kind: "error", error });
      throw error;
    }

    try {
      const outcome = this.dispatchNewIntent(intent, trustedOperationId);
      this.cacheIntent(id, print, outcome, undefined);
      return outcome;
    } catch (raw) {
      const error = AppError.from(raw);
      this.emit({ kind: "error", error });
      this.cacheIntent(id, print, undefined, error);
      throw error;
    }
  }

  acceptProviderEvent(envelope: ProviderEventEnvelope): IntentOutcome {
    const { eventId, event } = envelope;
    const print = fingerprint(event);
    const cached = this.providerEventCache.get(eventId);
    if (cached) {
      if (cached.fingerprint === print) {
        this.emit({ kind: "noop" });
        return this.replayCached(cached);
      }
      const error = new AppError(
        AppErrorCode.DuplicateIntent,
      ).withProviderEvent(eventId);
      this.emit({ kind: "error", error });
      throw error;
    }
    try {
      const outcome = this.applyProviderEvent(event);
      this.cacheProviderEvent(eventId, print, outcome, undefined);
      return outcome;
    } catch (raw) {
      const error = AppError.from(raw);
      this.emit({ kind: "error", error });
      this.cacheProviderEvent(eventId, print, undefined, error);
      throw error;
    }
  }

  private replayCached(cached: CachedDispatch): IntentOutcome {
    if (cached.error) {
      throw cached.error;
    }
    if (!cached.outcome) {
      throw new AppError(AppErrorCode.UnknownIntent);
    }
    return cached.outcome;
  }

  private dispatchNewIntent(
    intent: UserIntent,
    id: OperationId,
  ): IntentOutcome {
    const beforeRevision = this.model.snapshot().revision;
    switch (intent.type) {
      case "select_context":
        this.model.selectContext(intent.context, intent.presentation);
        return this.transitionOutcome(beforeRevision, id);
      case "swap_split_focus":
        this.model.swapSplitFocus();
        return this.transitionOutcome(beforeRevision, id);
      case "resize_split":
        this.model.setSplitRatio(intent.ratio);
        return this.transitionOutcome(beforeRevision, id);
      case "resize_sidebar":
        this.model.setSidebarWidth(intent.width);
        return this.transitionOutcome(beforeRevision, id);
      case "open_folder":
        return this.beginWorkspaceResolution(intent.path, id);
      case "new_window": {
        if (intent.path !== undefined) {
          return this.beginWorkspaceResolution(intent.path, id);
        }
        if (this.model.selection.context.kind !== "global") {
          this.model.selectContext(GLOBAL_CONTEXT);
        }
        return this.transitionOutcome(beforeRevision, id);
      }
      case "retry_workspace":
        return this.beginWorkspaceRetry(intent.workspaceId, id);
      case "workspace_root_missing":
        return this.markWorkspaceRootMissing(
          intent.workspaceId,
          beforeRevision,
          id,
        );
      case "locate_workspace":
        return this.beginWorkspaceRelocation(
          intent.workspaceId,
          intent.path,
          id,
        );
      case "create_agent":
        return this.beginProfileResolution(
          intent.workspaceId,
          intent.profileId,
          intent.extraArgs ?? [],
          intent.presentation,
          id,
        );
      case "rename_agent":
        this.model.renameAgent(intent.agentId, intent.displayName);
        return this.transitionOutcome(beforeRevision, id);
      case "stop_agent":
        return this.beginStopConfirmation(intent.agentId, id);
      case "confirm_stop_agent":
        return this.confirmStop(intent.confirmationId, id);
      case "retry_stop_agent":
        return this.retryStop(intent.agentId, id);
      case "mark_agent_unread":
        this.model.markAgentUnread(intent.agentId);
        return this.transitionOutcome(beforeRevision, id);
      case "reconcile_agent":
        return this.requestAgentReconcile(id, intent.agentId);
      case "reconcile_agents":
        return this.requestAgentsReconcile(id);
      case "request_close_workspace":
        return this.closeWorkspace(intent.workspaceId, intent.worktree, id);
      case "confirm_close_workspace":
        return this.confirmWorkspaceClose(intent.confirmationId, id);
      case "window_focus_changed":
        this.model.setWindowFocused(intent.focused);
        return this.transitionOutcome(beforeRevision, id);
      case "window_closed":
        return this.detach("window_closed");
      case "quit":
        return this.detach("quit");
    }
  }

  private transitionOutcome(
    beforeRevision: number,
    id: OperationId,
  ): IntentOutcome {
    const snapshot = this.snapshot();
    if (snapshot.revision === beforeRevision) {
      this.emit({ kind: "noop" });
      return { kind: "noop", snapshot };
    }
    this.emit({ kind: "snapshot", snapshot });
    this.queuePersist(id);
    return { kind: "updated", snapshot };
  }

  // ------------------------------------------------------------- reconcile

  requestAgentReconcile(id: OperationId, agent: AgentId): IntentOutcome {
    if (this.pending.has(id)) {
      throw new AppError(AppErrorCode.OperationInProgress).withOperation(id);
    }
    if (!this.model.workspaceForAgent(agent)) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownAgent,
      );
    }
    const nextEpoch = this.reconcileEpoch + 1;
    this.invalidateReconciliation();
    const token = this.startOperation(
      "reconcile_agent",
      { kind: "agent", agentId: agent },
      id,
    );
    this.reconcileEpoch = nextEpoch;
    this.activeReconcile = {
      kind: "agent",
      token,
      agentId: agent,
      epoch: this.reconcileEpoch,
    };
    this.emitEffect({ kind: "reconcile_agent", token, agentId: agent });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  requestAgentsReconcile(id: OperationId): IntentOutcome {
    if (this.pending.has(id)) {
      throw new AppError(AppErrorCode.OperationInProgress).withOperation(id);
    }
    const nextEpoch = this.reconcileEpoch + 1;
    this.invalidateReconciliation();
    const token = this.startOperation(
      "reconcile_agents",
      { kind: "application" },
      id,
    );
    this.reconcileEpoch = nextEpoch;
    this.activeReconcile = {
      kind: "agents",
      token,
      epoch: this.reconcileEpoch,
    };
    this.emitEffect({ kind: "reconcile_agents", token });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  // ------------------------------------------------------------- beginnings

  private beginWorkspaceResolution(
    path: RequestedPath,
    id: OperationId,
  ): IntentOutcome {
    const token = this.startOperation(
      "resolve_workspace_path",
      { kind: "path", path },
      id,
    );
    this.emitEffect({ kind: "resolve_workspace_path", token, path });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  /**
   * The folder is not there. The workspace becomes `unavailable`, which is
   * the state the content area already draws with Retry, Locate… and Close.
   *
   * A workspace on its way out is left alone: `closing` is a state the model
   * refuses operations in, and a close that has already failed keeps its own
   * diagnostic — "the folder is missing" is not a better answer than "this
   * step did not finish" to the question of what to do next.
   */
  private markWorkspaceRootMissing(
    workspaceId: WorkspaceId,
    beforeRevision: number,
    id: OperationId,
  ): IntentOutcome {
    const workspace = this.model.workspace(workspaceId);
    if (!workspace) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownWorkspace,
      );
    }
    if (
      workspace.state.kind === "available" ||
      workspace.state.kind === "unavailable"
    ) {
      this.model.markWorkspaceUnavailable(workspaceId, "root_missing");
    }
    return this.transitionOutcome(beforeRevision, id);
  }

  private beginWorkspaceRetry(
    workspaceId: WorkspaceId,
    id: OperationId,
  ): IntentOutcome {
    const workspace = this.model.workspace(workspaceId);
    if (!workspace) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownWorkspace,
      );
    }
    if (workspace.state.kind !== "unavailable") {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.WorkspaceNotUnavailable,
      );
    }
    return this.beginWorkspaceRelocation(
      workspaceId,
      requestedPath(workspace.selectedPath),
      id,
    );
  }

  private beginWorkspaceRelocation(
    workspaceId: WorkspaceId,
    path: RequestedPath,
    id: OperationId,
  ): IntentOutcome {
    const workspace = this.model.workspace(workspaceId);
    if (!workspace) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownWorkspace,
      );
    }
    if (workspace.state.kind !== "unavailable") {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.WorkspaceNotUnavailable,
      );
    }
    const token = this.startOperation(
      "resolve_workspace_path",
      { kind: "workspace_path", workspaceId },
      id,
    );
    this.emitEffect({ kind: "resolve_workspace_path", token, path });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  private beginProfileResolution(
    workspaceId: WorkspaceId,
    profileId: AgentProfileId,
    extraArgs: readonly string[],
    presentation: SurfacePresentation,
    id: OperationId,
  ): IntentOutcome {
    const workspace = this.model.workspace(workspaceId);
    if (!workspace) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownWorkspace,
      );
    }
    if (!workspace.canCreateAgent) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.WorkspaceUnavailable,
      );
    }
    const token = this.startOperation(
      "resolve_agent_profile",
      { kind: "profile", workspaceId, profileId },
      id,
    );
    this.requestedPresentations.set(token.operationId, presentation);
    this.emitEffect({
      kind: "resolve_agent_profile",
      token,
      workspaceId,
      profileId,
      extraArgs,
    });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  /**
   * Stop an Agent, asking first only if stopping it would interrupt anything.
   *
   * `agentIsIdle` is the whole of the rule and it lives in one place — the
   * same one the workspace close reads, so "this Agent is busy" cannot mean
   * two things. An Agent sitting at its prompt is stopped where it stands: a
   * question whose answer is always yes is what teaches people to dismiss the
   * ones that matter.
   */
  private beginStopConfirmation(
    agent: AgentId,
    id: OperationId,
  ): IntentOutcome {
    const found = this.model.agent(agent);
    if (!found || !this.model.workspaceForAgent(agent)) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownAgent,
      );
    }
    if (agentIsIdle(found.status)) return this.startAgentStop(agent, id);
    const token = this.startOperation(
      "generate_confirmation_id",
      { kind: "agent", agentId: agent },
      id,
    );
    this.confirmationRequests.set(id, { kind: "stop", agentId: agent });
    this.emitEffect({
      kind: "generate_confirmation_id",
      token,
      purpose: { kind: "stop_agent", agentId: agent },
    });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  private confirmStop(
    confirmation: ConfirmationId,
    id: OperationId,
  ): IntentOutcome {
    const index = this.confirmations.findIndex(
      (pending) =>
        pending.kind === "stop" && pending.confirmationId === confirmation,
    );
    if (index < 0) {
      throw new AppError(AppErrorCode.ConfirmationExpired);
    }
    const [state] = this.confirmations.splice(index, 1);
    if (state.kind !== "stop") {
      throw new AppError(AppErrorCode.ConfirmationExpired);
    }
    return this.startAgentStop(state.agentId, id);
  }

  /**
   * Actually stop it. The one second half, whether or not anything was asked.
   */
  private startAgentStop(agent: AgentId, id: OperationId): IntentOutcome {
    this.model.requestAgentStop(agent);
    const token = this.startOperation(
      "stop_agent",
      { kind: "agent", agentId: agent },
      id,
    );
    this.emitEffect({ kind: "stop_agent", token, agentId: agent });
    this.emit({ kind: "snapshot", snapshot: this.snapshot() });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  private retryStop(agent: AgentId, id: OperationId): IntentOutcome {
    const found = this.model.agent(agent);
    if (!found) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownAgent,
      );
    }
    if (!found.canRetryStop) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.InvalidAgentControlTransition,
      );
    }
    this.model.retryAgentStop(agent);
    const token = this.startOperation(
      "stop_agent",
      { kind: "agent", agentId: agent },
      id,
    );
    this.emitEffect({ kind: "stop_agent", token, agentId: agent });
    this.emit({ kind: "snapshot", snapshot: this.snapshot() });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  private beginWorkspaceInspection(
    request: CloseRequest,
    id: OperationId,
  ): IntentOutcome {
    const token = this.startOperation(
      "inspect_workspace",
      { kind: "workspace", workspaceId: request.workspaceId },
      id,
    );
    this.closeRequests.set(id, request);
    this.emitEffect({
      kind: "inspect_workspace",
      token,
      workspaceId: request.workspaceId,
    });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  private confirmWorkspaceClose(
    confirmation: ConfirmationId,
    id: OperationId,
  ): IntentOutcome {
    const index = this.confirmations.findIndex(
      (pending) =>
        pending.kind === "workspace_close" &&
        pending.confirmationId === confirmation,
    );
    if (index < 0) {
      throw new AppError(AppErrorCode.ConfirmationExpired);
    }
    const [state] = this.confirmations.splice(index, 1);
    if (state.kind !== "workspace_close") {
      throw new AppError(AppErrorCode.ConfirmationExpired);
    }
    return this.startClose(
      { workspaceId: state.workspaceId, worktree: state.worktree },
      id,
    );
  }

  /**
   * Close a Workspace. One function, one act, first attempt or fifth.
   *
   * **1. Ask everything first; do nothing until it is answered.** The busy-Agent
   * confirmation, the dirty-worktree three-way (answered before the close is
   * asked for at all, and carried here as `worktree`) and the editor's own
   * unsaved-work dialog — VS Code's `unload` — are all resolved before the
   * first destructive step. Cancel any of them and nothing has changed.
   *
   * **2. Then run a fixed sequence of idempotent steps**, each of which treats
   * "already gone" as success: stop the Workspace's Agent sessions, close its
   * own tmux session, dispose its workbench view, remove the worktree if it is
   * one and the answer was delete, forget the Workspace in the model, persist
   * once. A `kill-session` on a session somebody killed from outside is done,
   * not failed; so is a view whose renderer already died, and a worktree
   * folder that is not there.
   *
   * **3. Nothing about a close is persisted while it runs.** There is no
   * progress record, no resumable midpoint and no persisted `closing` state —
   * resuming a close from a persisted midpoint was itself the source of the
   * errors. A state file written by an older build that names a close comes
   * back as an ordinary open Workspace: it was never closed.
   *
   * **4. Failure is visible and final for that attempt.** A step that fails —
   * an unreachable tmux socket, a `git worktree remove` that errors, an unload
   * ask that runs out of time — stops the close there. The row stays, and one
   * failure names the step and the cause. The steps already done stay done;
   * because they are idempotent, the next attempt repeats them and finds them
   * done. There is no "resume" and no separate failed state: a Workspace is
   * either open — possibly with a last-failure note on it — or gone.
   *
   * **5. One deadline per external call**, so a hung process cannot hang the
   * close forever. A deadline that is hit is a step failure like any other.
   */
  private closeWorkspace(
    workspaceId: WorkspaceId,
    worktree: WorktreeDisposition,
    id: OperationId,
  ): IntentOutcome {
    const workspace = this.model.workspace(workspaceId);
    if (!workspace) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownWorkspace,
      );
    }
    if (workspace.close.kind === "running") {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.WorkspaceClosing,
      );
    }
    return this.beginWorkspaceInspection({ workspaceId, worktree }, id);
  }

  // ------------------------------------------------------------ completions

  private applyProviderEvent(event: ProviderEvent): IntentOutcome {
    switch (event.type) {
      case "workspace_path_resolved":
        return this.completeWorkspacePath(
          event.token,
          event.root,
          event.selectedPath,
        );
      case "workspace_id_generated":
        return this.completeWorkspaceId(event.token, event.workspaceId);
      case "workspace_inspection_completed":
        return this.completeWorkspaceInspection(
          event.token,
          event.workspaceId,
          event.inspection,
        );
      case "agent_stop_completed":
        return this.completeAgentStop(event.token, event.agentId, event.result);
      case "agent_termination_completed":
        return this.completeAgentTermination(
          event.token,
          event.agentId,
          event.result,
        );
      case "workspace_close_completed":
        return this.completeWorkspaceClose(
          event.token,
          event.workspaceId,
          event.result,
        );
      case "confirmation_id_generated":
        return this.completeConfirmationId(event.token, event.confirmationId);
      case "profile_resolved":
        return this.completeProfileResolved(
          event.token,
          event.workspaceId,
          event.profile,
        );
      case "agent_id_generated":
        return this.completeAgentId(
          event.token,
          event.workspaceId,
          event.agentId,
        );
      case "agent_launch_completed":
        return this.completeAgentLaunch(
          event.token,
          event.workspaceId,
          event.agentId,
          event.result,
        );
      case "agents_reconciled":
        return this.completeAgentsReconcile(event.token, event.reconciliation);
      case "agent_status_changed":
        return this.reconcileAgent(
          event.token,
          event.agentId,
          event.status,
          event.runtimeHealth,
        );
      case "agent_exited":
        return this.handleAgentExited(event.token, event.agentId);
      case "state_persisted":
        return this.completePersist(event.token);
      case "state_persistence_failed":
        return this.completePersistFailed(event.token, event.reason);
      case "operation_failed":
        return this.completeOperationFailed(event.token);
    }
  }

  private completeOperationFailed(token: OperationToken): IntentOutcome {
    const pending = this.pending.get(token.operationId);
    if (!pending) {
      throw new AppError(
        this.completedTokens.has(token.operationId)
          ? AppErrorCode.StaleCompletion
          : AppErrorCode.UnknownOperation,
      ).withOperation(token.operationId);
    }
    if (!sameToken(pending.token, token)) {
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    this.pending.delete(token.operationId);
    this.clearOperationAuxiliaryState(token);
    this.rememberCompleted(token);
    throw new AppError(AppErrorCode.PortUnavailable)
      .withPort(portFor(pending.kind))
      .withOperation(token.operationId);
  }

  private clearOperationAuxiliaryState(token: OperationToken): void {
    const id = token.operationId;
    this.resolvedPaths.delete(id);
    this.requestedPresentations.delete(id);
    this.resolvedProfiles.delete(id);
    this.launchProfiles.delete(id);
    this.closeRequests.delete(id);
    this.confirmationRequests.delete(id);
    this.finalizationPending.delete(id);
    const workspaceId = this.finalizationWorkspaces.get(id);
    if (workspaceId !== undefined) {
      this.finalizationWorkspaces.delete(id);
      this.finalizationBackups.delete(id);
      for (const [root, owner] of [...this.finalizationRoots]) {
        if (owner === id) {
          this.finalizationRoots.delete(root);
        }
      }
    }
    if (this.activeReconcile && sameToken(this.activeReconcile.token, token)) {
      this.activeReconcile = undefined;
    }
  }

  private completeWorkspacePath(
    token: OperationToken,
    root: WorkspaceRoot,
    selectedPath: DisplayPath,
  ): IntentOutcome {
    const pending = this.takePending(
      token,
      "resolve_workspace_path",
      (target) => target.kind === "path" || target.kind === "workspace_path",
    );
    if (pending.target.kind === "workspace_path") {
      const workspaceId = pending.target.workspaceId;
      this.model.relocateWorkspace(workspaceId, root, selectedPath);
      this.model.selectContext({ kind: "workspace", workspaceId });
      const snapshot = this.snapshot();
      this.emit({ kind: "snapshot", snapshot });
      this.emit({ kind: "operation_completed", token });
      this.queuePersist(token.operationId);
      return { kind: "updated", snapshot };
    }

    const previousId = pending.token.operationId;
    const nextToken = this.startOperation(
      "generate_workspace_id",
      { kind: "resolved_path", root, selectedPath },
      previousId,
    );
    this.resolvedPaths.set(nextToken.operationId, { root, selectedPath });
    this.emitEffect({
      kind: "generate_workspace_id",
      token: nextToken,
      root,
      selectedPath,
    });
    return {
      kind: "deferred",
      operationId: nextToken.operationId,
      snapshot: this.snapshot(),
    };
  }

  private completeWorkspaceId(
    token: OperationToken,
    workspaceId: WorkspaceId,
  ): IntentOutcome {
    this.takePending(
      token,
      "generate_workspace_id",
      (target) => target.kind === "resolved_path",
    );
    const resolved = this.resolvedPaths.get(token.operationId);
    this.resolvedPaths.delete(token.operationId);
    if (!resolved) {
      throw new AppError(AppErrorCode.UnknownOperation).withOperation(
        token.operationId,
      );
    }
    if (this.finalizationRoots.has(resolved.root)) {
      throw new AppError(AppErrorCode.Domain)
        .withDomain(DomainErrorCode.DuplicateWorkspaceRoot)
        .withOperation(token.operationId);
    }
    const existing = this.model.workspaces.find(
      (workspace) =>
        workspace.state.kind === "available" &&
        workspace.root === resolved.root,
    );
    if (existing) {
      const beforeRevision = this.model.snapshot().revision;
      this.model.selectContext({
        kind: "workspace",
        workspaceId: existing.id,
      });
      const snapshot = this.snapshot();
      if (snapshot.revision !== beforeRevision) {
        this.emit({ kind: "snapshot", snapshot });
        this.emit({ kind: "operation_completed", token });
        this.queuePersist(token.operationId);
        return { kind: "updated", snapshot };
      }
      this.emit({ kind: "operation_completed", token });
      this.emit({ kind: "noop" });
      return { kind: "noop", snapshot };
    }
    this.model.addWorkspace(
      new Workspace(workspaceId, resolved.root, resolved.selectedPath),
    );
    const snapshot = this.snapshot();
    this.emit({ kind: "snapshot", snapshot });
    this.emit({ kind: "operation_completed", token });
    this.queuePersist(token.operationId);
    return { kind: "updated", snapshot };
  }

  private completeProfileResolved(
    token: OperationToken,
    workspaceId: WorkspaceId,
    profile: AgentProfile,
  ): IntentOutcome {
    this.takePending(
      token,
      "resolve_agent_profile",
      (target) =>
        target.kind === "profile" &&
        target.workspaceId === workspaceId &&
        target.profileId === profile.id,
    );
    const id = token.operationId;
    if (!this.workspaceAllowsAgentCreation(workspaceId)) {
      this.resolvedProfiles.delete(id);
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(id);
    }
    const nextToken = this.startOperation(
      "generate_agent_id",
      { kind: "profile", workspaceId, profileId: profile.id },
      id,
    );
    const presentation = this.requestedPresentations.get(id) ?? "full";
    this.requestedPresentations.delete(id);
    this.resolvedProfiles.set(nextToken.operationId, {
      workspaceId,
      profile,
      presentation,
    });
    this.emitEffect({
      kind: "generate_agent_id",
      token: nextToken,
      workspaceId,
    });
    return {
      kind: "deferred",
      operationId: nextToken.operationId,
      snapshot: this.snapshot(),
    };
  }

  private completeAgentId(
    token: OperationToken,
    workspaceId: WorkspaceId,
    agentId: AgentId,
  ): IntentOutcome {
    this.takePending(
      token,
      "generate_agent_id",
      (target) =>
        target.kind === "profile" && target.workspaceId === workspaceId,
    );
    if (!this.workspaceAllowsAgentCreation(workspaceId)) {
      this.resolvedProfiles.delete(token.operationId);
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    const resolved = this.resolvedProfiles.get(token.operationId);
    this.resolvedProfiles.delete(token.operationId);
    if (!resolved) {
      throw new AppError(AppErrorCode.UnknownOperation).withOperation(
        token.operationId,
      );
    }
    this.launchProfiles.set(token.operationId, {
      workspaceId,
      agentId,
      profile: resolved.profile,
      presentation: resolved.presentation,
    });
    const launchToken = this.startOperation(
      "launch_agent",
      { kind: "agent_launch", workspaceId, agentId },
      token.operationId,
    );
    this.emitEffect({
      kind: "launch_agent",
      token: launchToken,
      workspaceId,
      agentId,
      profile: resolved.profile,
    });
    return {
      kind: "deferred",
      operationId: launchToken.operationId,
      snapshot: this.snapshot(),
    };
  }

  private completeAgentLaunch(
    token: OperationToken,
    workspaceId: WorkspaceId,
    agentId: AgentId,
    result: AgentLaunchResult,
  ): IntentOutcome {
    if (!this.workspaceAllowsAgentCreation(workspaceId)) {
      this.cancelWorkspaceAgentOperations(workspaceId);
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    const expected = this.launchProfiles.get(token.operationId);
    if (!expected) {
      throw new AppError(
        this.pending.has(token.operationId) ||
        this.completedTokens.has(token.operationId)
          ? AppErrorCode.StaleCompletion
          : AppErrorCode.UnknownOperation,
      ).withOperation(token.operationId);
    }
    if (expected.workspaceId !== workspaceId || expected.agentId !== agentId) {
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    this.takePending(
      token,
      "launch_agent",
      (target) =>
        target.kind === "agent_launch" &&
        target.workspaceId === workspaceId &&
        target.agentId === agentId,
    );
    const profile = expected.profile;
    const presentation = expected.presentation;
    this.launchProfiles.delete(token.operationId);

    if (result.kind === "failed") {
      throw new AppError(AppErrorCode.PortUnavailable)
        .withPort("agent")
        .withDetail(result.detail)
        .withOperation(token.operationId);
    }

    try {
      this.model.addAgent(workspaceId, agentId, profile, presentation);
    } catch (raw) {
      const error = AppError.from(raw);
      const terminateToken = this.startOperation(
        "terminate_agent",
        { kind: "agent", agentId },
        token.operationId,
      );
      this.emitEffect({
        kind: "terminate_agent",
        token: terminateToken,
        agentId,
      });
      throw error;
    }
    this.model.selectContext({ kind: "agent", agentId }, presentation);
    const snapshot = this.snapshot();
    this.emit({ kind: "snapshot", snapshot });
    this.emit({ kind: "operation_completed", token });
    this.queuePersist(token.operationId);
    return { kind: "updated", snapshot };
  }

  private completeAgentTermination(
    token: OperationToken,
    agentId: AgentId,
    result: AgentStopResult,
  ): IntentOutcome {
    this.takePending(
      token,
      "terminate_agent",
      (target) => target.kind === "agent" && target.agentId === agentId,
    );
    const snapshot = this.snapshot();
    this.emit({ kind: "operation_completed", token });
    if (result.kind === "failed") {
      const error = new AppError(AppErrorCode.PortUnavailable)
        .withPort("agent")
        .withOperation(token.operationId);
      this.emit({ kind: "error", error });
      throw error;
    }
    return { kind: "noop", snapshot };
  }

  private completeAgentsReconcile(
    token: OperationToken,
    reconciliation: import("./domain.js").AgentReconciliation,
  ): IntentOutcome {
    const current =
      this.activeReconcile?.kind === "agents" &&
      sameToken(this.activeReconcile.token, token) &&
      this.activeReconcile.epoch === this.reconcileEpoch;
    if (!current) {
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    this.takePending(
      token,
      "reconcile_agents",
      (target) => target.kind === "application",
    );
    this.activeReconcile = undefined;
    for (const observation of reconciliation.observations) {
      if (!this.model.workspaceForAgent(observation.agentId)) {
        throw new AppError(AppErrorCode.Domain)
          .withDomain(DomainErrorCode.UnknownAgent)
          .withOperation(token.operationId);
      }
    }
    for (const agentId of reconciliation.exited) {
      if (!this.model.workspaceForAgent(agentId)) {
        throw new AppError(AppErrorCode.Domain)
          .withDomain(DomainErrorCode.UnknownAgent)
          .withOperation(token.operationId);
      }
    }
    const canceledStopTokens = reconciliation.exited.flatMap((agentId) =>
      this.cancelAgentStopStateAfterExit(agentId),
    );
    const beforeRevision = this.model.snapshot().revision;
    this.model.reconcileAgents(reconciliation);
    const snapshot = this.snapshot();
    if (snapshot.revision === beforeRevision) {
      for (const stopToken of canceledStopTokens) {
        this.emit({ kind: "operation_completed", token: stopToken });
      }
      this.emit({ kind: "operation_completed", token });
      this.emit({ kind: "noop" });
      return { kind: "noop", snapshot };
    }
    this.emit({ kind: "snapshot", snapshot });
    for (const stopToken of canceledStopTokens) {
      this.emit({ kind: "operation_completed", token: stopToken });
    }
    this.emit({ kind: "operation_completed", token });
    this.queuePersist(token.operationId);
    return { kind: "updated", snapshot };
  }

  private completeConfirmationId(
    token: OperationToken,
    confirmation: ConfirmationId,
  ): IntentOutcome {
    if (
      this.confirmationIds.has(confirmation) ||
      this.confirmations.some(
        (pending) => pending.confirmationId === confirmation,
      )
    ) {
      throw new AppError(AppErrorCode.DuplicateIntent).withOperation(
        token.operationId,
      );
    }
    const request = this.confirmationRequests.get(token.operationId);
    if (!request) {
      throw new AppError(
        this.pending.has(token.operationId) ||
        this.completedTokens.has(token.operationId)
          ? AppErrorCode.StaleCompletion
          : AppErrorCode.UnknownOperation,
      ).withOperation(token.operationId);
    }
    if (request.kind === "stop") {
      this.takePending(
        token,
        "generate_confirmation_id",
        (target) =>
          target.kind === "agent" && target.agentId === request.agentId,
      );
    } else {
      this.takePending(
        token,
        "generate_confirmation_id",
        (target) =>
          target.kind === "workspace" &&
          target.workspaceId === request.workspaceId,
      );
    }
    this.confirmationRequests.delete(token.operationId);
    this.confirmationIds.add(confirmation);
    this.confirmationIdOrder.push(confirmation);
    while (this.confirmationIdOrder.length > MAX_CONFIRMATION_ID_ENTRIES) {
      const evicted = this.confirmationIdOrder.shift();
      if (evicted !== undefined) {
        this.confirmationIds.delete(evicted);
      }
    }

    const purpose: ConfirmationOutcomePurpose =
      request.kind === "workspace_close"
        ? { kind: "workspace_close", inspection: request.inspection }
        : { kind: "agent_stop", agentId: request.agentId };

    if (request.kind === "stop") {
      this.confirmations = this.confirmations.filter(
        (pending) =>
          !(pending.kind === "stop" && pending.agentId === request.agentId),
      );
      this.confirmations.push({
        kind: "stop",
        confirmationId: confirmation,
        agentId: request.agentId,
      });
    } else {
      this.confirmations = this.confirmations.filter(
        (pending) =>
          !(
            pending.kind === "workspace_close" &&
            pending.workspaceId === request.workspaceId
          ),
      );
      this.confirmations.push({
        kind: "workspace_close",
        confirmationId: confirmation,
        workspaceId: request.workspaceId,
        worktree: request.worktree,
        inspection: request.inspection,
      });
    }

    this.emit({ kind: "operation_completed", token });
    return {
      kind: "confirmation_required",
      confirmationId: confirmation,
      snapshot: this.snapshot(),
      purpose,
    };
  }

  private completeWorkspaceInspection(
    token: OperationToken,
    workspaceId: WorkspaceId,
    inspection: CloseInspectionInputs,
  ): IntentOutcome {
    this.takePending(
      token,
      "inspect_workspace",
      (target) =>
        target.kind === "workspace" && target.workspaceId === workspaceId,
    );
    // This coordinator put the request here when it started the inspection.
    // Absent means its own bookkeeping disagrees with itself, and inventing a
    // close is the one answer that must not be given.
    const request = this.closeRequests.get(token.operationId);
    if (!request) {
      throw new AppError(AppErrorCode.UnknownOperation).withOperation(
        token.operationId,
      );
    }
    this.closeRequests.delete(token.operationId);

    if (consolidateCloseInspection(inspection).kind === "clean") {
      return this.startClose(request, token.operationId);
    }

    const workspace = this.model.workspace(workspaceId);
    if (!workspace) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownWorkspace,
      );
    }
    const confirmationToken = this.startOperation(
      "generate_confirmation_id",
      { kind: "workspace", workspaceId },
      token.operationId,
    );
    this.confirmationRequests.set(token.operationId, {
      kind: "workspace_close",
      workspaceId,
      worktree: request.worktree,
      inspection: closeInspectionProjection(
        workspaceId,
        this.labelOf(workspaceId),
        inspection,
      ),
    });
    this.emitEffect({
      kind: "generate_confirmation_id",
      token: confirmationToken,
      purpose: { kind: "workspace_close", workspaceId },
    });
    return {
      kind: "deferred",
      operationId: token.operationId,
      snapshot: this.snapshot(),
    };
  }

  /** The label the question puts in the sentence a person reads. */
  private labelOf(workspaceId: WorkspaceId): string {
    const workspace = this.snapshot().workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownWorkspace,
      );
    }
    return workspace.label;
  }

  /**
   * Every question is answered. Hand the whole close to the environment.
   *
   * One effect, not one per step: the steps are fixed, ordered and idempotent,
   * so there is nothing for the model to decide between them and nothing worth
   * writing down while they run.
   */
  private startClose(request: CloseRequest, id: OperationId): IntentOutcome {
    const workspace = this.model.workspace(request.workspaceId);
    if (!workspace) {
      throw new AppError(AppErrorCode.Domain).withDomain(
        DomainErrorCode.UnknownWorkspace,
      );
    }
    const token = this.startOperation(
      "close_workspace",
      { kind: "workspace", workspaceId: request.workspaceId },
      id,
    );
    try {
      this.model.beginWorkspaceClose(request.workspaceId);
    } catch (raw) {
      this.pending.delete(id);
      this.rememberCompleted(token);
      throw AppError.from(raw);
    }
    this.cancelWorkspaceAgentOperations(request.workspaceId);
    this.invalidateReconciliation();
    this.emit({ kind: "snapshot", snapshot: this.snapshot() });
    this.emitEffect({
      kind: "close_workspace",
      token,
      workspaceId: request.workspaceId,
      worktree: request.worktree,
    });
    return { kind: "deferred", operationId: id, snapshot: this.snapshot() };
  }

  private completeAgentStop(
    token: OperationToken,
    agentId: AgentId,
    result: AgentStopResult,
  ): IntentOutcome {
    const naturalExit = this.naturalExitStopTokens.get(tokenKey(token));
    if (naturalExit !== undefined) {
      if (naturalExit !== agentId || this.model.workspaceForAgent(agentId)) {
        throw new AppError(AppErrorCode.StaleCompletion).withOperation(
          token.operationId,
        );
      }
      this.emit({ kind: "operation_completed", token });
      return { kind: "noop", snapshot: this.snapshot() };
    }
    this.takePending(
      token,
      "stop_agent",
      (target) => target.kind === "agent" && target.agentId === agentId,
    );
    if (result.kind === "stopped") {
      if (!this.model.workspaceForAgent(agentId)) {
        this.rememberNaturalExitStop(token, agentId);
        this.emit({ kind: "operation_completed", token });
        return { kind: "noop", snapshot: this.snapshot() };
      }
      this.model.agentExited(agentId);
      this.invalidateReconciliationAfterAgentRemoval(agentId);
    } else {
      this.model.markAgentStopFailed(agentId, result.diagnostic);
    }
    const snapshot = this.snapshot();
    this.emit({ kind: "snapshot", snapshot });
    this.emit({ kind: "operation_completed", token });
    this.queuePersist(token.operationId);
    return { kind: "updated", snapshot };
  }

  /**
   * The close ended. Either the Workspace goes, or one step is named.
   *
   * The last two steps are the model's own — forget the Workspace, persist
   * once — and they are here rather than in the environment because only the
   * model can do them. The Workspace is taken out with a rollback kept, so a
   * save that fails puts it back and says so rather than losing a row that is
   * still in the file.
   */
  private completeWorkspaceClose(
    token: OperationToken,
    workspaceId: WorkspaceId,
    result: WorkspaceCloseResult,
  ): IntentOutcome {
    this.takePending(
      token,
      "close_workspace",
      (target) =>
        target.kind === "workspace" && target.workspaceId === workspaceId,
    );

    if (result.kind === "failed") {
      this.model.markWorkspaceCloseFailed(
        workspaceId,
        result.step,
        result.diagnostic,
      );
      const snapshot = this.snapshot();
      this.emit({ kind: "snapshot", snapshot });
      this.emit({ kind: "operation_completed", token });
      this.emit({ kind: "error", error: closeFailedError(token.operationId) });
      // Not close bookkeeping: the steps that did run changed the model — the
      // Agents they stopped are gone from it — and that is what is saved.
      this.queuePersist(token.operationId);
      return { kind: "updated", snapshot };
    }

    const workspace = this.model.workspace(workspaceId);
    if (!workspace) {
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    for (const agent of [...workspace.agents]) {
      this.model.agentExited(agent.id);
    }
    const backup = this.model.closeWorkspaceForPersistence(
      workspaceId,
      CLEAN_CLOSE_INSPECTION,
    );
    this.finalizationRoots.set(backup.workspace.root, token.operationId);
    this.finalizationPending.add(token.operationId);
    this.finalizationWorkspaces.set(token.operationId, workspaceId);
    this.finalizationBackups.set(token.operationId, backup);
    const snapshot = this.snapshot();
    this.emit({ kind: "snapshot", snapshot });
    this.emit({ kind: "operation_completed", token });
    this.queuePersist(token.operationId);
    return { kind: "deferred", operationId: token.operationId, snapshot };
  }

  private completePersist(token: OperationToken): IntentOutcome {
    this.takePending(
      token,
      "persist_state",
      (target) => target.kind === "application",
    );
    this.emit({ kind: "operation_completed", token });
    if (this.finalizationPending.delete(token.operationId)) {
      this.finalizationWorkspaces.delete(token.operationId);
      const backup = this.finalizationBackups.get(token.operationId);
      if (backup) {
        this.finalizationBackups.delete(token.operationId);
        this.finalizationRoots.delete(backup.workspace.root);
      }
    }
    return { kind: "noop", snapshot: this.snapshot() };
  }

  /**
   * The save that was to make the close final did not happen.
   *
   * The Workspace comes back, and the close is a failure at its last step —
   * the same shape every other step's failure has. Nothing is remembered about
   * the steps that did run: they are idempotent, and the next attempt repeats
   * them.
   */
  private completePersistFailed(
    token: OperationToken,
    reason: string,
  ): IntentOutcome {
    this.takePending(
      token,
      "persist_state",
      (target) => target.kind === "application",
    );
    if (this.finalizationPending.delete(token.operationId)) {
      const workspaceId = this.finalizationWorkspaces.get(token.operationId);
      this.finalizationWorkspaces.delete(token.operationId);
      const backup = this.finalizationBackups.get(token.operationId);
      if (backup) {
        this.finalizationBackups.delete(token.operationId);
        const root = backup.workspace.root;
        this.model.rollbackWorkspaceClose(backup);
        this.finalizationRoots.delete(root);
        if (workspaceId !== undefined) {
          this.model.markWorkspaceCloseFailed(
            workspaceId,
            "state",
            "cleanup_failed",
          );
        }
      }
    }
    const error = new AppError(AppErrorCode.PersistenceDegraded)
      .withPort("state")
      .withDetail(reason)
      .withOperation(token.operationId);
    this.emit({ kind: "snapshot", snapshot: this.snapshot() });
    this.emit({ kind: "error", error });
    this.emit({ kind: "operation_completed", token });
    return { kind: "persistence_degraded", snapshot: this.snapshot() };
  }

  private reconcileAgent(
    token: OperationToken,
    agentId: AgentId,
    status: import("./domain.js").AgentStatus,
    runtimeHealth: import("./domain.js").RuntimeHealth,
  ): IntentOutcome {
    const current =
      this.activeReconcile?.kind === "agent" &&
      sameToken(this.activeReconcile.token, token) &&
      this.activeReconcile.agentId === agentId &&
      this.activeReconcile.epoch === this.reconcileEpoch;
    if (!current) {
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    this.takePending(
      token,
      "reconcile_agent",
      (target) => target.kind === "agent" && target.agentId === agentId,
    );
    this.activeReconcile = undefined;
    const beforeRevision = this.model.snapshot().revision;
    this.model.setAgentStatus(agentId, status);
    this.model.setAgentRuntimeHealth(agentId, runtimeHealth);
    const snapshot = this.snapshot();
    if (snapshot.revision === beforeRevision) {
      this.emit({ kind: "operation_completed", token });
      this.emit({ kind: "noop" });
      return { kind: "noop", snapshot };
    }
    this.emit({ kind: "snapshot", snapshot });
    this.emit({ kind: "operation_completed", token });
    this.queuePersist(token.operationId);
    return { kind: "updated", snapshot };
  }

  private handleAgentExited(
    token: OperationToken,
    agentId: AgentId,
  ): IntentOutcome {
    const current =
      this.activeReconcile?.kind === "agent" &&
      sameToken(this.activeReconcile.token, token) &&
      this.activeReconcile.agentId === agentId &&
      this.activeReconcile.epoch === this.reconcileEpoch;
    if (!current) {
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    this.takePending(
      token,
      "reconcile_agent",
      (target) => target.kind === "agent" && target.agentId === agentId,
    );
    this.activeReconcile = undefined;
    const stopTokens = this.cancelAgentStopStateAfterExit(agentId);
    const removed = this.model.workspaceForAgent(agentId) !== undefined;
    if (removed) {
      this.model.agentExited(agentId);
    }
    const snapshot = this.snapshot();
    if (removed) {
      this.emit({ kind: "snapshot", snapshot });
    }
    for (const stopToken of stopTokens) {
      this.emit({ kind: "operation_completed", token: stopToken });
    }
    this.emit({ kind: "operation_completed", token });
    this.queuePersist(token.operationId);
    return removed ? { kind: "updated", snapshot } : { kind: "noop", snapshot };
  }

  // ------------------------------------------------------------- bookkeeping

  private cancelAgentStopStateAfterExit(agentId: AgentId): OperationToken[] {
    const operationIds = [...this.pending]
      .filter(
        ([, pending]) =>
          pending.target.kind === "agent" &&
          pending.target.agentId === agentId &&
          (pending.kind === "stop_agent" ||
            pending.kind === "generate_confirmation_id"),
      )
      .map(([id]) => id);
    const completedStopTokens: OperationToken[] = [];
    for (const id of operationIds) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      this.rememberCompleted(pending.token);
      this.clearOperationAuxiliaryState(pending.token);
      if (pending.kind === "stop_agent") {
        this.rememberNaturalExitStop(pending.token, agentId);
        completedStopTokens.push(pending.token);
      }
    }
    for (const [id, request] of [...this.confirmationRequests]) {
      if (request.kind === "stop" && request.agentId === agentId) {
        this.confirmationRequests.delete(id);
      }
    }
    this.confirmations = this.confirmations.filter(
      (pending) => !(pending.kind === "stop" && pending.agentId === agentId),
    );
    return completedStopTokens;
  }

  private rememberNaturalExitStop(
    token: OperationToken,
    agentId: AgentId,
  ): void {
    const key = tokenKey(token);
    this.naturalExitStopTokens.set(key, agentId);
    this.naturalExitStopOrder.push(key);
    while (this.naturalExitStopOrder.length > MAX_COMPLETED_TOKEN_ENTRIES) {
      const evicted = this.naturalExitStopOrder.shift();
      if (evicted !== undefined) {
        this.naturalExitStopTokens.delete(evicted);
      }
    }
  }

  private invalidateReconciliationAfterAgentRemoval(agentId: AgentId): void {
    const active = this.activeReconcile;
    if (!active) return;
    const shouldInvalidate =
      active.kind === "agents" ||
      (active.kind === "agent" && active.agentId === agentId);
    if (shouldInvalidate) {
      this.invalidateReconciliation();
    }
  }

  private takePending(
    token: OperationToken,
    kind: OperationKind,
    targetMatches: (target: OperationTarget) => boolean,
  ): PendingOperation {
    const pending = this.pending.get(token.operationId);
    if (!pending) {
      throw new AppError(
        this.completedTokens.has(token.operationId)
          ? AppErrorCode.StaleCompletion
          : AppErrorCode.UnknownOperation,
      ).withOperation(token.operationId);
    }
    if (
      !sameToken(pending.token, token) ||
      pending.kind !== kind ||
      !targetMatches(pending.target)
    ) {
      throw new AppError(AppErrorCode.StaleCompletion).withOperation(
        token.operationId,
      );
    }
    this.pending.delete(token.operationId);
    this.rememberCompleted(token);
    return pending;
  }

  private startOperation(
    kind: OperationKind,
    target: OperationTarget,
    id: OperationId,
  ): OperationToken {
    if (this.pending.has(id)) {
      throw new AppError(AppErrorCode.OperationInProgress).withOperation(id);
    }
    this.nextGeneration += 1;
    if (!Number.isSafeInteger(this.nextGeneration)) {
      throw new AppError(
        AppErrorCode.OperationGenerationExhausted,
      ).withOperation(id);
    }
    const token = operationToken(id, this.nextGeneration);
    this.pending.set(id, { token, kind, target });
    return token;
  }

  /**
   * Drop a reconcile whose answer no longer describes the model.
   *
   * The superseded operation is announced as completed, and that is not a
   * formality: something asked for it and is waiting on the answer. An
   * operation that is removed in silence leaves that caller waiting for as
   * long as its own deadline, and what it is finally told is that time ran
   * out — which is true, and says nothing about what actually happened.
   */
  /** Whether an operation with this identity is still in flight. */
  hasPending(id: OperationId): boolean {
    return this.pending.has(id);
  }

  private invalidateReconciliation(): void {
    const active = this.activeReconcile;
    if (!active) return;
    this.activeReconcile = undefined;
    if (this.pending.delete(active.token.operationId)) {
      this.rememberCompleted(active.token);
      this.emit({ kind: "operation_completed", token: active.token });
    }
  }

  private workspaceAllowsAgentCreation(workspaceId: WorkspaceId): boolean {
    return this.model.workspace(workspaceId)?.canCreateAgent ?? false;
  }

  private cancelWorkspaceAgentOperations(workspaceId: WorkspaceId): void {
    const operationIds = [...this.pending]
      .filter(([, pending]) => {
        const target = pending.target;
        const targetsWorkspace =
          (target.kind === "profile" ||
            target.kind === "agent_launch" ||
            target.kind === "workspace") &&
          target.workspaceId === workspaceId;
        const cancellable =
          pending.kind === "resolve_agent_profile" ||
          pending.kind === "generate_agent_id" ||
          pending.kind === "launch_agent" ||
          pending.kind === "terminate_agent" ||
          pending.kind === "generate_confirmation_id";
        return targetsWorkspace && cancellable;
      })
      .map(([id]) => id);
    for (const id of operationIds) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        this.rememberCompleted(pending.token);
      }
      this.resolvedProfiles.delete(id);
      this.launchProfiles.delete(id);
      this.confirmationRequests.delete(id);
    }
    this.confirmations = this.confirmations.filter((pending) =>
      pending.kind === "stop"
        ? this.model.workspaceForAgent(pending.agentId)?.id !== workspaceId
        : pending.workspaceId !== workspaceId,
    );
  }

  private rememberCompleted(token: OperationToken): void {
    this.completedTokens.set(token.operationId, token);
    this.completedTokenOrder.push([token.operationId, token]);
    while (this.completedTokenOrder.length > MAX_COMPLETED_TOKEN_ENTRIES) {
      const evicted = this.completedTokenOrder.shift();
      if (!evicted) break;
      const [evictedId, evictedToken] = evicted;
      const current = this.completedTokens.get(evictedId);
      if (current && sameToken(current, evictedToken)) {
        this.completedTokens.delete(evictedId);
      }
    }
  }

  /**
   * Schedule the save that follows a mutation.
   *
   * It used to catch. `startOperation` throws `OperationInProgress` or
   * `OperationGenerationExhausted`, and both of those mean this coordinator's
   * own bookkeeping is inconsistent — neither is a condition a caller can do
   * anything about. Caught, the mutation stayed in the model and was never
   * scheduled for persistence, and the failure was reported as
   * `operation_pending`, which reads as "try again" and does not describe
   * "your change exists only in memory". So it throws: the mutation and the
   * save it needs are one act, and an act that cannot be completed is not
   * reported as a hiccup.
   */
  private queuePersist(id: OperationId): void {
    const token = this.startOperation(
      "persist_state",
      { kind: "application" },
      id,
    );
    this.emitEffect({ kind: "persist_state", token });
  }

  private emitEffect(effect: Effect): void {
    this.emit({ kind: "effect", effect });
  }

  private emit(event: CoordinatorEvent): void {
    this.nextSequence += 1;
    this.events.push({ sequence: this.nextSequence, event });
    if (this.events.length > MAX_RETAINED_EVENTS) {
      this.events.shift();
    }
  }

  private cacheIntent(
    id: IntentId,
    print: string,
    outcome: IntentOutcome | undefined,
    error: AppError | undefined,
  ): void {
    if (!this.intentCache.has(id)) {
      this.intentOrder.push(id);
    }
    this.intentCache.set(id, { fingerprint: print, outcome, error });
    while (this.intentOrder.length > MAX_INTENT_LEDGER_ENTRIES) {
      const evicted = this.intentOrder.shift();
      if (evicted !== undefined) {
        this.intentCache.delete(evicted);
      }
    }
  }

  private cacheProviderEvent(
    id: ProviderEventId,
    print: string,
    outcome: IntentOutcome | undefined,
    error: AppError | undefined,
  ): void {
    if (!this.providerEventCache.has(id)) {
      this.providerEventOrder.push(id);
    }
    this.providerEventCache.set(id, { fingerprint: print, outcome, error });
    while (this.providerEventOrder.length > MAX_PROVIDER_LEDGER_ENTRIES) {
      const evicted = this.providerEventOrder.shift();
      if (evicted !== undefined) {
        this.providerEventCache.delete(evicted);
      }
    }
  }

  private detach(reason: DetachReason): IntentOutcome {
    if (this.detached === undefined) {
      this.detached = reason;
      this.emitEffect({ kind: "detach", reason });
    } else {
      this.emit({ kind: "noop" });
    }
    return { kind: "detached", snapshot: this.snapshot() };
  }
}
