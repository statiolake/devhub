/**
 * The command algebra and the effect seam.
 *
 * A port of `crates/devhub-app-core/src/application/{types,error,intent}.rs`.
 * Two things are deliberately separate here and must stay separate:
 *
 * - `UserIntent` is what a person asked for. It can never carry a provider
 *   observation, a canonical root, a generated identity, an inspection or a
 *   profile — those are results, and results do not arrive through the UI.
 * - `ProviderEvent` is what an adapter finished doing, and it is accepted only
 *   against the exact operation generation that asked for it.
 */

import type {
  AgentId,
  AgentProfile,
  AgentProfileId,
  AgentReconciliation,
  AgentStatus,
  CleanupProgress,
  CloseInspectionInputs,
  CloseInspectionProjection,
  DiagnosticCode,
  DisplayPath,
  DomainErrorCode,
  NavigationContext,
  SurfacePresentation,
  RuntimeHealth,
  WorkspaceId,
  WorkspaceRoot,
} from "./domain.js";
import {
  DomainError,
  DomainErrorCode as Code,
  isCanonicalUuid,
} from "./domain.js";
import type { AppSnapshot } from "./appModel.js";

/** Native application lifecycle readiness owned by the coordinator. */
export type AppReadiness = "starting" | "ready" | "unavailable";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type IntentId = Brand<string, "IntentId">;
export type OperationId = Brand<string, "OperationId">;
export type ConfirmationId = Brand<string, "ConfirmationId">;
export type ProviderEventId = Brand<string, "ProviderEventId">;

function canonicalUuid<T extends string>(raw: string): Brand<string, T> {
  if (!isCanonicalUuid(raw)) {
    throw new DomainError(Code.InvalidId);
  }
  return raw as Brand<string, T>;
}

export const intentId = (raw: string): IntentId =>
  canonicalUuid<"IntentId">(raw);
export const operationId = (raw: string): OperationId =>
  canonicalUuid<"OperationId">(raw);
export const confirmationId = (raw: string): ConfirmationId =>
  canonicalUuid<"ConfirmationId">(raw);
export const providerEventId = (raw: string): ProviderEventId =>
  canonicalUuid<"ProviderEventId">(raw);

/**
 * A completion is accepted only for the exact operation generation that asked
 * for it, so a late adapter answer cannot mutate a newer operation that reused
 * the same domain identity.
 */
export interface OperationToken {
  readonly operationId: OperationId;
  readonly generation: number;
}

export function operationToken(
  id: OperationId,
  generation: number,
): OperationToken {
  return { operationId: id, generation };
}

export function sameToken(
  left: OperationToken,
  right: OperationToken,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.generation === right.generation
  );
}

export function tokenKey(token: OperationToken): string {
  return `${token.operationId}#${String(token.generation)}`;
}

/** Stable, content-free application error codes. */
export enum AppErrorCode {
  Domain = "DOMAIN_ERROR",
  DuplicateIntent = "DUPLICATE_INTENT",
  InvalidIntent = "INVALID_INTENT",
  UnknownIntent = "UNKNOWN_INTENT",
  UnknownOperation = "UNKNOWN_OPERATION",
  StaleCompletion = "STALE_COMPLETION",
  ConfirmationRequired = "CONFIRMATION_REQUIRED",
  ConfirmationExpired = "CONFIRMATION_EXPIRED",
  OperationInProgress = "OPERATION_IN_PROGRESS",
  OperationGenerationExhausted = "OPERATION_GENERATION_EXHAUSTED",
  PersistenceDegraded = "PERSISTENCE_DEGRADED",
  PortUnavailable = "PORT_UNAVAILABLE",
}

/**
 * Application failure. User content, provider identifiers, paths and command
 * output never enter this type.
 */
/**
 * Which side of DevHub could not do the thing.
 *
 * A port failure is the same failure everywhere in the model, and it has to
 * become a different sentence on screen depending on what was unreachable —
 * "the agent runtime is unavailable" is something a person can act on, and
 * "the app shell is unavailable" is not, when it was the Agent's own runtime
 * that did not answer. The model carries which port, and the projection picks
 * the words.
 */
export type PortName = "app" | "agent" | "terminal" | "editor" | "state";

export class AppError extends Error {
  domainCode: DomainErrorCode | undefined;
  port: PortName | undefined;
  /** What the failing side said, for the reader; never for a branch. */
  detail: string | undefined;
  intentId: IntentId | undefined;
  operationId: OperationId | undefined;
  providerEventId: ProviderEventId | undefined;

  constructor(readonly code: AppErrorCode) {
    super(code);
    this.name = "AppError";
  }

  static from(error: unknown): AppError {
    if (error instanceof AppError) {
      return error;
    }
    if (error instanceof DomainError) {
      return new AppError(AppErrorCode.Domain).withDomain(error.code);
    }
    throw error;
  }

  withPort(port: PortName): AppError {
    this.port = port;
    return this;
  }

  withDetail(detail: string | undefined): AppError {
    this.detail = detail;
    return this;
  }

  withDomain(code: DomainErrorCode): AppError {
    this.domainCode = code;
    return this;
  }

  withIntent(id: IntentId): AppError {
    this.intentId = id;
    return this;
  }

  withOperation(id: OperationId): AppError {
    this.operationId = id;
    return this;
  }

  withProviderEvent(id: ProviderEventId): AppError {
    this.providerEventId = id;
    return this;
  }
}

/**
 * A path exactly as a caller requested it. It is not a canonical Workspace
 * Root; only a resolver completion may create that domain value.
 */
export type RequestedPath = Brand<string, "RequestedPath">;

export function requestedPath(raw: string): RequestedPath {
  if (raw.trim().length === 0 || raw.includes("\0") || raw.length > 32768) {
    throw new DomainError(Code.InvalidPath);
  }
  return raw as RequestedPath;
}

export type UserIntent =
  | {
      readonly type: "select_context";
      readonly context: NavigationContext;
      /** How much of the content area it should take. Only Agents have two. */
      readonly presentation: SurfacePresentation;
    }
  | { readonly type: "resize_sidebar"; readonly width: number }
  | { readonly type: "resize_split"; readonly ratio: number }
  | { readonly type: "open_folder"; readonly path: RequestedPath }
  | { readonly type: "new_window"; readonly path?: RequestedPath }
  | { readonly type: "retry_workspace"; readonly workspaceId: WorkspaceId }
  | {
      readonly type: "locate_workspace";
      readonly workspaceId: WorkspaceId;
      readonly path: RequestedPath;
    }
  | {
      readonly type: "create_agent";
      readonly workspaceId: WorkspaceId;
      readonly profileId: AgentProfileId;
      /**
       * Arguments to append to the profile's own, for this Agent only.
       *
       * They are what a person typed after `--` on the `devhub` command line,
       * so they are a user intent like everything else here. The page has
       * nowhere to type them and therefore never sets this; the one read site
       * treats absent and empty as the same thing, so there is still exactly
       * one rule about how a launch's arguments are composed.
       */
      readonly extraArgs?: readonly string[];
      /**
       * How the new Agent should be shown once it is running.
       *
       * Creating an Agent selects it, so the same choice applies as when one is
       * selected from a row — and it is made here, with the request, rather
       * than by a second command afterwards that could arrive late enough to be
       * seen as a jump.
       */
      readonly presentation: SurfacePresentation;
    }
  | {
      readonly type: "rename_agent";
      readonly agentId: AgentId;
      readonly displayName: string;
    }
  | { readonly type: "stop_agent"; readonly agentId: AgentId }
  | {
      readonly type: "confirm_stop_agent";
      readonly confirmationId: ConfirmationId;
    }
  | { readonly type: "retry_stop_agent"; readonly agentId: AgentId }
  /**
   * Put an Agent back in the unread pile.
   *
   * Opening one reads it, which is right almost always and wrong exactly when
   * you looked, could not deal with it, and want the app to keep telling you.
   */
  | { readonly type: "mark_agent_unread"; readonly agentId: AgentId }
  | { readonly type: "reconcile_agent"; readonly agentId: AgentId }
  /**
   * Ask the provider about every Agent at once. DevHub raises this on its own
   * cadence; the page has no way to send it, because nothing about it is a
   * thing a person asks for.
   */
  | { readonly type: "reconcile_agents" }
  | {
      readonly type: "request_close_workspace";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly type: "confirm_close_workspace";
      readonly confirmationId: ConfirmationId;
    }
  | {
      readonly type: "retry_close_workspace";
      readonly workspaceId: WorkspaceId;
    }
  | { readonly type: "window_closed" }
  | { readonly type: "quit" };

export interface IntentEnvelope {
  readonly intentId: IntentId;
  readonly operationId: OperationId | undefined;
  readonly intent: UserIntent;
}

export type AgentStopResult =
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly diagnostic: DiagnosticCode };

export type AgentLaunchResult =
  | { readonly kind: "started" }
  | {
      readonly kind: "failed";
      readonly diagnostic: DiagnosticCode;
      /**
       * What the adapter could say about the failure, in its own words.
       *
       * The diagnostic is the model's vocabulary and stays closed; this is the
       * sentence the person reads underneath it. It is optional because an
       * adapter that genuinely knows nothing more must not be made to invent
       * something, and never carries user content — only the runtime's own
       * refusal.
       */
      readonly detail?: string;
    };

export type CleanupStep = "agents" | "terminal" | "editor" | "state_committed";

export type WorkspaceCleanupResult =
  | { readonly kind: "step_completed"; readonly step: CleanupStep }
  | {
      readonly kind: "failed";
      readonly step: CleanupStep;
      readonly diagnostic: DiagnosticCode;
    };

export type ProviderEvent =
  | {
      readonly type: "workspace_path_resolved";
      readonly token: OperationToken;
      readonly root: WorkspaceRoot;
      readonly selectedPath: DisplayPath;
    }
  | {
      readonly type: "workspace_id_generated";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly type: "workspace_inspection_completed";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
      readonly inspection: CloseInspectionInputs;
    }
  | {
      readonly type: "agent_stop_completed";
      readonly token: OperationToken;
      readonly agentId: AgentId;
      readonly result: AgentStopResult;
    }
  | {
      readonly type: "agent_termination_completed";
      readonly token: OperationToken;
      readonly agentId: AgentId;
      readonly result: AgentStopResult;
    }
  | {
      readonly type: "workspace_cleanup_completed";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
      readonly result: WorkspaceCleanupResult;
    }
  | {
      readonly type: "confirmation_id_generated";
      readonly token: OperationToken;
      readonly confirmationId: ConfirmationId;
    }
  | {
      readonly type: "profile_resolved";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
      readonly profile: AgentProfile;
    }
  | {
      readonly type: "agent_id_generated";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
      readonly agentId: AgentId;
    }
  | {
      readonly type: "agent_launch_completed";
      readonly token: OperationToken;
      readonly workspaceId: WorkspaceId;
      readonly agentId: AgentId;
      readonly result: AgentLaunchResult;
    }
  | {
      readonly type: "agents_reconciled";
      readonly token: OperationToken;
      readonly reconciliation: AgentReconciliation;
    }
  | {
      readonly type: "agent_status_changed";
      readonly token: OperationToken;
      readonly agentId: AgentId;
      readonly status: AgentStatus;
      readonly runtimeHealth: RuntimeHealth;
    }
  | {
      readonly type: "agent_exited";
      readonly token: OperationToken;
      readonly agentId: AgentId;
    }
  | { readonly type: "state_persisted"; readonly token: OperationToken }
  | {
      readonly type: "state_persistence_failed";
      readonly token: OperationToken;
      /**
       * What the store said, in the words the reader gets: which file, and
       * what happened to it. It travels with the completion because the
       * coordinator is where the failure becomes the error the page draws,
       * and an error that only says "changes could not be saved" leaves the
       * person with nothing to check.
       */
      readonly reason: string;
    }
  /**
   * The adapter could not complete an operation. This consumes the token, so a
   * failed call cannot strand the coordinator in an indefinitely pending state.
   */
  | { readonly type: "operation_failed"; readonly token: OperationToken };

export interface ProviderEventEnvelope {
  readonly eventId: ProviderEventId;
  readonly event: ProviderEvent;
}

export type ConfirmationOutcomePurpose =
  | {
      readonly kind: "workspace_close";
      readonly inspection: CloseInspectionProjection;
    }
  | { readonly kind: "agent_stop" };

export type IntentOutcome =
  | { readonly kind: "noop"; readonly snapshot: AppSnapshot }
  | { readonly kind: "updated"; readonly snapshot: AppSnapshot }
  | {
      readonly kind: "confirmation_required";
      readonly confirmationId: ConfirmationId;
      readonly snapshot: AppSnapshot;
      readonly purpose: ConfirmationOutcomePurpose;
    }
  | {
      readonly kind: "deferred";
      readonly operationId: OperationId;
      readonly snapshot: AppSnapshot;
    }
  | { readonly kind: "detached"; readonly snapshot: AppSnapshot }
  | { readonly kind: "persistence_degraded"; readonly snapshot: AppSnapshot };

export type ConfirmationPurpose =
  | { readonly kind: "stop_agent"; readonly agentId: AgentId }
  | {
      readonly kind: "workspace_close";
      readonly workspaceId: WorkspaceId;
      readonly progress: CleanupProgress;
    };

export type DetachReason = "window_closed" | "quit";
