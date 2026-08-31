/**
 * The terminal runtime's port vocabulary.
 *
 * Ported from the Rust `devhub_app_core::ports` and `state` types the tmux
 * adapter spoke: the domain values it accepts and the inspection values it
 * returns. Everything tmux — socket names, session names, marker options,
 * process output — stops inside the runtime; nothing here names any of it
 * except the socket, which is a configured value the settings window shows.
 *
 * These types live beside the runtime rather than in the app model because the
 * model must not be able to describe a tmux resource. The model passes targets
 * in and reads inspections out.
 */

import type { ResourceInspection } from "../../model/domain.js";

/** Why a runtime operation could not complete. */
export type PortErrorCode =
	| "unavailable"
	| "conflict"
	| "cancelled"
	| "timed_out"
	| "incompatible"
	| "failed";

/**
 * A runtime failure.
 *
 * It carries a code, and one optional `detail`: provider stdout, stderr,
 * session names and discovered paths are deliberately not part of it, so no
 * error path can leak the inventory of a foreign tmux server into a diagnostic
 * or a UI string.
 *
 * `detail` is bound by that same rule and is not an exception to it. It may
 * only hold a sentence DevHub composed from its **own configuration** before it
 * spoke to any provider — which executable was configured and where it was
 * looked for. Without it a missing tmux reaches the pane as "runtime
 * unavailable", which names neither the tool nor the search, and is the one
 * failure whose whole diagnostic is those two facts.
 */
export class PortFailure extends Error {
	readonly code: PortErrorCode;
	readonly detail: string | undefined;

	constructor(code: PortErrorCode, options?: PortFailureOptions) {
		super(options?.detail ?? `terminal runtime ${code.replaceAll("_", " ")}`, {
			cause: options?.cause,
		});
		this.name = "PortFailure";
		this.code = code;
		this.detail = options?.detail;
	}
}

export interface PortFailureOptions extends ErrorOptions {
	/** A sentence about DevHub's own configuration. Never provider output. */
	readonly detail?: string;
}

export function portFailure(
	code: PortErrorCode,
	options?: PortFailureOptions,
): PortFailure {
	return new PortFailure(code, options);
}

/**
 * Cooperative cancellation for one operation.
 *
 * A child token is cancelled by its parent but not the reverse, which is how a
 * superseded attach cancels only its own provider work.
 */
export class CancellationToken {
	private cancelled = false;
	private readonly children = new Set<CancellationToken>();

	get isCancelled(): boolean {
		return this.cancelled;
	}

	cancel(): void {
		if (this.cancelled) return;
		this.cancelled = true;
		for (const child of this.children) child.cancel();
		this.children.clear();
	}

	child(): CancellationToken {
		const child = new CancellationToken();
		if (this.cancelled) child.cancel();
		else this.children.add(child);
		return child;
	}

	/** Throws if this operation has been abandoned. */
	check(): void {
		if (this.cancelled) throw portFailure("cancelled");
	}
}

const MAX_SOCKET_NAME_BYTES = 64;

/**
 * A tmux socket name (`tmux -L <name>`).
 *
 * The value comes from the config file, so it is validated before it can ever
 * reach argv: a name with a separator or a space would be a different socket,
 * or a different argument entirely.
 */
export type SocketName = string & { readonly __brand: "SocketName" };

export function isValidSocketName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= MAX_SOCKET_NAME_BYTES &&
		/^[A-Za-z0-9_.-]+$/u.test(value)
	);
}

export function socketName(value: string): SocketName {
	if (!isValidSocketName(value)) throw portFailure("failed");
	return value as SocketName;
}

/** The extra tmux arguments the config may set. Only these two are safe. */
export function isSafeTmuxArgument(argument: string): boolean {
	return argument === "-u" || argument === "-2";
}

/** A workspace's terminal: the folder it lives in, named by its workspace id. */
export interface WorkspaceTerminalTarget {
	readonly workspaceId: string;
	/** Absolute, canonical. */
	readonly root: string;
}

/**
 * An Agent's session: one workspace's folder, named by the Agent's own id.
 *
 * An Agent is a tmux session like any other, and that is the entire point of
 * retiring the separate Agent runtime: the same socket, the same markers, the
 * same client. What makes it a different *kind* of target is not its transport
 * but its lifetime — a workspace terminal is a place that is created on
 * demand and outlives whatever runs in it, while an Agent session runs one
 * command and ends when that command ends.
 */
export interface AgentTerminalTarget {
	readonly agentId: string;
	readonly workspaceId: string;
	/** Absolute, canonical: the workspace root the Agent runs in. */
	readonly root: string;
}

/**
 * Which terminal a request is about.
 *
 * `scratch` is the Global context's terminal; it has no workspace and its root
 * is the launch home.
 */
export type TerminalTarget =
	| { readonly kind: "scratch" }
	| ({ readonly kind: "workspace" } & WorkspaceTerminalTarget)
	| ({ readonly kind: "agent" } & AgentTerminalTarget);

export const SCRATCH_TARGET: TerminalTarget = { kind: "scratch" };

export function workspaceTarget(
	workspaceId: string,
	root: string,
): TerminalTarget {
	return { kind: "workspace", workspaceId, root };
}

export function agentTarget(
	agentId: string,
	workspaceId: string,
	root: string,
): TerminalTarget {
	return { kind: "agent", agentId, workspaceId, root };
}

export function sameTarget(
	left: TerminalTarget,
	right: TerminalTarget,
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "scratch") return true;
	if (left.kind === "agent") {
		// The Agent id is the whole identity: a workspace can be reopened at a
		// different root, and the Agent running in it is still that Agent.
		return right.kind === "agent" && left.agentId === right.agentId;
	}
	return (
		right.kind === "workspace" &&
		left.workspaceId === right.workspaceId &&
		left.root === right.root
	);
}

/**
 * What an Agent session is started with.
 *
 * The command is not resolved to an absolute path here. tmux execs it from the
 * server's own environment, which is DevHub's frozen launch environment — the
 * same PATH the workspace terminals get — so a command DevHub can find is a
 * command the Agent can run, and there is no second resolution to disagree
 * with the first.
 */
export interface AgentSessionCommand {
	readonly file: string;
	readonly args: readonly string[];
	/** Extra variables for this Agent only, on top of the server's. */
	readonly env: Readonly<Record<string, string>>;
}

/**
 * A session DevHub owns, as it is written to disk.
 *
 * This is the only durable record of a tmux resource: an unmarked session is
 * counted and never named, so it can never become a kill target after a crash.
 */
export type OwnedSessionRecord =
	| { readonly kind: "scratch"; readonly sessionName: string }
	| {
			readonly kind: "workspace";
			readonly workspaceId: string;
			readonly sessionName: string;
	  }
	| {
			readonly kind: "agent";
			readonly agentId: string;
			readonly workspaceId: string;
			readonly sessionName: string;
	  };

export function ownedSessionName(record: OwnedSessionRecord): string {
	return record.sessionName;
}

export function sameOwnedSession(
	left: OwnedSessionRecord,
	right: OwnedSessionRecord,
): boolean {
	if (left.kind !== right.kind || left.sessionName !== right.sessionName) {
		return false;
	}
	if (left.kind === "scratch") return true;
	if (left.kind === "agent") {
		return (
			right.kind === "agent" &&
			left.agentId === right.agentId &&
			left.workspaceId === right.workspaceId
		);
	}
	return right.kind === "workspace" && left.workspaceId === right.workspaceId;
}

/**
 * The sessions that must exist for the app's persisted workspaces.
 *
 * Session names are deterministic domain values, so this set can be rebuilt
 * from the snapshot alone after a crash.
 */
export interface RequiredTerminalSet {
	readonly sessions: readonly OwnedSessionRecord[];
}

export function requiredTerminalSet(
	sessions: readonly OwnedSessionRecord[],
): RequiredTerminalSet {
	const names = new Set<string>();
	for (const session of sessions) {
		if (names.has(session.sessionName)) throw portFailure("failed");
		names.add(session.sessionName);
	}
	if (!sessions.some((session) => session.kind === "scratch")) {
		throw portFailure("failed");
	}
	return { sessions: [...sessions] };
}

/** What a socket looks like before the app is allowed to adopt it. */
export type SocketTargetPreflightState =
	| "not_checked"
	| "target_absent"
	| "target_devhub_empty"
	| "wrong_marker"
	| "marked_sessions";

export interface TerminalPreflight {
	readonly requestedSocketName: SocketName;
	readonly state: SocketTargetPreflightState;
	readonly ownedSessionCount: number;
	readonly unknownSessionCount: number;
}

export function terminalPreflight(
	requestedSocketName: SocketName,
	state: SocketTargetPreflightState,
	ownedSessionCount: number,
	unknownSessionCount: number,
): TerminalPreflight {
	if (
		(state === "target_absent" &&
			(ownedSessionCount !== 0 || unknownSessionCount !== 0)) ||
		(state === "target_devhub_empty" && ownedSessionCount !== 0)
	) {
		throw portFailure("failed");
	}
	return {
		requestedSocketName,
		state,
		ownedSessionCount,
		unknownSessionCount,
	};
}

export interface TerminalOwnedSessions {
	readonly sessions: readonly OwnedSessionRecord[];
	readonly unknownSessionCount: number;
}

export function terminalOwnedSessions(
	sessions: readonly OwnedSessionRecord[],
	unknownSessionCount: number,
): TerminalOwnedSessions {
	const names = new Set<string>();
	for (const session of sessions) {
		if (names.has(session.sessionName)) throw portFailure("failed");
		names.add(session.sessionName);
	}
	return { sessions, unknownSessionCount };
}

/** What closing a workspace would destroy, per resource kind. */
export interface TerminalInspection {
	readonly process: ResourceInspection;
	readonly extraPanes: ResourceInspection;
	readonly extraWindows: ResourceInspection;
}

/**
 * The environment and home every DevHub child is launched with.
 *
 * Frozen at startup: the terminal must not observe an environment that changed
 * under it, and the same values are what the shell inside tmux inherits.
 */
export interface RuntimeLaunchContext {
	/** Absolute. The client's working directory and the Scratch session's root. */
	readonly home: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}
