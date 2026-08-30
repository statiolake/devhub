/**
 * The slice of the DevHub domain model this adapter needs.
 *
 * In the Tauri app these types lived in `crates/devhub-app-core`
 * (`AgentId`, `AgentProfile`, `PortError`, `CancellationToken`, …). In the
 * Electron app workstream A owns the ported model. Until A lands it, the
 * adapter carries the exact subset it consumes so the port is complete and
 * testable on its own; the intent is that A's module replaces this file and
 * every import below is redirected to it, unchanged in shape.
 *
 * Everything here is a value type: ids are validated strings rather than
 * newtypes, because TypeScript cannot make a newtype that survives IPC.
 */

/** Stable, bounded failure categories at the core/adapter seam. */
import type {
	AgentProfileKind as DomainAgentProfileKind,
	AgentStatus as DomainAgentStatus,
	RuntimeHealth as DomainRuntimeHealth,
} from "../../model/domain.js";

export enum PortErrorCode {
	Failed = "failed",
	Unavailable = "unavailable",
	/**
	 * The provider affirmatively has no such resource: nothing in its snapshot
	 * carries this Agent. Distinct from `Unavailable`, which says the thing may
	 * well be there and could not be reached — the difference between "it
	 * ended" and "it did not answer", and the two must never be shown as the
	 * same sentence.
	 */
	Gone = "gone",
	Incompatible = "incompatible",
	Conflict = "conflict",
	TimedOut = "timedOut",
	Cancelled = "cancelled",
}

/** The only error the core sees from a port. It carries no provider text. */
export class PortError extends Error {
	readonly code: PortErrorCode;

	constructor(code: PortErrorCode) {
		super(code);
		this.name = "PortError";
		this.code = code;
	}
}

export function failedPort(): PortError {
	return new PortError(PortErrorCode.Failed);
}

export function unavailablePort(): PortError {
	return new PortError(PortErrorCode.Unavailable);
}

export function gonePort(): PortError {
	return new PortError(PortErrorCode.Gone);
}

export function conflictPort(): PortError {
	return new PortError(PortErrorCode.Conflict);
}

export function cancelledPort(): PortError {
	return new PortError(PortErrorCode.Cancelled);
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
	return UUID.test(value);
}

/** A domain Agent identity. Always a v4 UUID in canonical lowercase form. */
export type AgentId = string;
/** A domain Workspace identity. Always a v4 UUID. */
export type WorkspaceId = string;
/** A cancellable operation's identity. Always a v4 UUID. */
export type OperationId = string;

export function parseAgentId(value: string): AgentId {
	if (!isUuid(value)) {
		throw new PortError(PortErrorCode.Failed);
	}
	return value;
}

export function parseWorkspaceId(value: string): WorkspaceId {
	if (!isUuid(value)) {
		throw new PortError(PortErrorCode.Failed);
	}
	return value;
}

/** An absolute folder path a Workspace is rooted at. */
export type WorkspaceRoot = string;

export function workspaceRoot(value: string): WorkspaceRoot {
	if (value.length === 0 || !value.startsWith("/") || value.includes("\0")) {
		throw new PortError(PortErrorCode.Failed);
	}
	return value;
}

/**
 * The vocabulary below is the model's, not this adapter's.
 *
 * Status, health and profile kind are product-level facts that the Sidebar
 * draws and the state file persists, so there is one definition of each and it
 * lives in `src/model/domain.ts`. These enums exist only so the adapter can
 * keep writing `AgentStatus.Working`: each member is typed as the model's own
 * union member, so a value that drifts stops compiling here rather than
 * arriving in the model as a string it does not recognise.
 */
export const AgentProfileKind = {
	Codex: "codex",
	Claude: "claude",
} as const satisfies Record<string, DomainAgentProfileKind>;
export type AgentProfileKind = DomainAgentProfileKind;

/** A launchable agent configuration, as it appears in `config.toml`. */
export interface AgentProfile {
	readonly id: string;
	readonly displayName: string;
	readonly kind: AgentProfileKind;
	readonly args: readonly string[];
	/** Sorted by key: the wire budget must not depend on iteration order. */
	readonly env: Readonly<Record<string, string>>;
}

export const AgentStatus = {
	Working: "working",
	Waiting: "waiting",
	Idle: "idle",
	Error: "error",
} as const satisfies Record<string, DomainAgentStatus>;
export type AgentStatus = DomainAgentStatus;

export const RuntimeHealth = {
	Starting: "starting",
	Healthy: "healthy",
	Degraded: "degraded",
	Unavailable: "unavailable",
	Failed: "failed",
} as const satisfies Record<string, DomainRuntimeHealth>;
export type RuntimeHealth = DomainRuntimeHealth;

/**
 * The opaque value the core persists on the Agent's behalf. Its contents are
 * private to this adapter; the core stores and returns it without reading it.
 */
export interface OpaqueProviderMapping {
	readonly value: string;
}

export const MAX_OPAQUE_MAPPING_BYTES = 16 * 1024;

export function opaqueProviderMapping(value: string): OpaqueProviderMapping {
	if (value.length === 0 || value.length > MAX_OPAQUE_MAPPING_BYTES) {
		throw new PortError(PortErrorCode.Failed);
	}
	return {
		value,
		// A mapping must never render its provider identifiers in a log line.
		toString: () => "<redacted>",
		toJSON: () => "<redacted>",
	} as OpaqueProviderMapping;
}

export interface AgentLaunchReceipt {
	readonly agentId: AgentId;
	readonly providerMapping: OpaqueProviderMapping;
}

export interface AgentObservation {
	readonly agentId: AgentId;
	readonly status: AgentStatus;
	readonly runtimeHealth: RuntimeHealth;
}

export interface AgentReconciliation {
	readonly observations: readonly AgentObservation[];
	readonly exited: readonly AgentId[];
}

/**
 * Cooperative cancellation. Every adapter loop checks it; a dropped operation
 * cancels its token so provider I/O in flight stops at its next checkpoint.
 */
export class CancellationToken {
	readonly operationId: OperationId;
	#cancelled = false;

	constructor(operationId: OperationId) {
		this.operationId = operationId;
	}

	get isCancelled(): boolean {
		return this.#cancelled;
	}

	cancel(): void {
		this.#cancelled = true;
	}
}
