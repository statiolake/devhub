/**
 * DevHub's tmux-backed terminal runtime.
 *
 * Ported from the Tauri app's `src-tauri/src/terminal/mod.rs`. This module is
 * the only owner of DevHub's tmux socket, session names and marker options. The
 * app model above it sees domain targets and inspection counts; tmux names,
 * formats, process output and child handles stop here.
 *
 * Why tmux at all: a terminal surface must survive the app. The shell runs in
 * the tmux server, and a surface is a short-lived tmux *client* on a PTY. Closing
 * a window, or quitting DevHub, kills clients — never sessions — so the same
 * shell, with its scrollback and its running command, is there on the next
 * launch. That is the feature; the marker protocol below is what makes it safe.
 *
 * Ownership is never assumed from a name. A session is DevHub's only if the
 * server carries `@devhub-protocol 1` *and* the session carries the full
 * `@devhub-context` / `@devhub-workspace-id` / `@devhub-root` triple that
 * matches the target being asked for. Anything else — a foreign server, a
 * partially created session, a same-named session with different metadata — is
 * an opaque resource: it is counted, never named, and never killed or repaired
 * in place. Every destructive command re-reads the marker and the session list
 * immediately before it runs, and reads the result back afterwards.
 *
 * The Rust ran these probes on worker threads behind a read/write gate. Node
 * runs them as awaited child processes behind the same gate expressed as an
 * async lock: ordinary operations exclude a socket transition, and a transition
 * excludes everything, so no operation can slip between the final inventory of
 * the old socket and the commit of the new effective name.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	CLEAN,
	busy,
	unknownResource,
	type ResourceInspection,
} from "../../model/domain.js";
import {
	MAX_ROOT_METADATA_BYTES,
	OperationDeadline,
	isNoServerError,
	parseLines,
	parseOptionValue,
	runBounded,
	type CommandOutput,
	type ResolvedExecutable,
} from "./command.js";
import {
	CancellationToken,
	isSafeTmuxArgument,
	isValidSocketName,
	portFailure,
	socketName,
	terminalOwnedSessions,
	terminalPreflight,
	type OwnedSessionRecord,
	type RequiredTerminalSet,
	type RuntimeLaunchContext,
	type SocketName,
	type TerminalInspection,
	type TerminalOwnedSessions,
	type TerminalPreflight,
	type TerminalTarget,
	type WorkspaceTerminalTarget,
} from "./ports.js";
import { requiredTerminalSet } from "./ports.js";

const PROTOCOL_OPTION = "@devhub-protocol";
const PROTOCOL_VALUE = "1";
const CONTEXT_OPTION = "@devhub-context";
const WORKSPACE_ID_OPTION = "@devhub-workspace-id";
const ROOT_OPTION = "@devhub-root";
const GLOBAL_CONTEXT = "global";
const WORKSPACE_CONTEXT = "workspace";
const GLOBAL_ID = "global";
export const SCRATCH_SESSION = "scratch";
const MIN_TMUX_MAJOR = 3;
const MIN_TMUX_MINOR = 3;
const MAX_SESSIONS = 1024;
const MAX_WINDOWS = 256;
const MAX_PANES = 1024;
const POLL_INTERVAL_MS = 5;
const DEFAULT_TIMEOUT_MS = 3_000;
const BOOTSTRAP_ENV_ROOT = "DEVHUB_BOOTSTRAP_ROOT";
const BOOTSTRAP_ENV_USER_CONFIG = "DEVHUB_USER_TMUX_CONFIG";

/**
 * The startup config an absent server is created with.
 *
 * `-f` selects this file instead of tmux's normal startup config. The user's
 * own config is sourced by a fixed environment variable, so no user value is
 * ever interpolated into argv. The ownership transaction is one tmux command
 * sequence: a failure creating Scratch — because a trusted user config already
 * made a foreign session with that name, say — stops every following metadata
 * and marker command, so a half-owned server cannot exist.
 */
const BOOTSTRAP_CONFIG = [
	'source-file -q "$DEVHUB_USER_TMUX_CONFIG"',
	[
		`new-session -d -s ${SCRATCH_SESSION} -c "$${BOOTSTRAP_ENV_ROOT}"`,
		`set-option -t ${SCRATCH_SESSION} ${CONTEXT_OPTION} ${GLOBAL_CONTEXT}`,
		`set-option -t ${SCRATCH_SESSION} ${WORKSPACE_ID_OPTION} ${GLOBAL_ID}`,
		`set-option -t ${SCRATCH_SESSION} ${ROOT_OPTION} "$${BOOTSTRAP_ENV_ROOT}"`,
		`set-option -g ${PROTOCOL_OPTION} ${PROTOCOL_VALUE}`,
	].join(" ; "),
	"",
].join("\n");

/** What the server's global marker says about who owns it. */
export type MarkerState = "absent" | "wrong" | "owned";

export interface SessionInfo {
	readonly name: string;
	readonly context: string | undefined;
	readonly workspaceId: string | undefined;
	readonly root: string | undefined;
}

interface SessionSpec {
	readonly name: string;
	readonly root: string;
	readonly context: string;
	readonly workspaceId: string;
}

/** The identity a target resolves to on a given server. */
interface TargetIdentity {
	readonly sessionName: string;
	readonly root: string;
	readonly workspaceId: string;
	readonly context: string;
}

export function workspaceDigest(root: string): string {
	return createHash("sha256").update(root, "utf8").digest("hex");
}

export function isWorkspaceSessionName(name: string, root: string): boolean {
	const digest = workspaceDigest(root);
	return (
		name === `ws-${digest.slice(0, 20)}` || name === `ws-${digest.slice(0, 32)}`
	);
}

export function isRootMetadata(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= MAX_ROOT_METADATA_BYTES &&
		!value.includes("\0") &&
		isAbsolute(value)
	);
}

export function parseNumericPrefix(value: string): number {
	const digits = /^\d*/u.exec(value)?.[0] ?? "";
	return digits.length === 0 ? 0 : Number.parseInt(digits, 10);
}

export function isMarked(
	session: SessionInfo,
	expectedGlobalRoot: string,
): boolean {
	const { context, workspaceId, root } = session;
	if (
		context === undefined ||
		workspaceId === undefined ||
		root === undefined
	) {
		return false;
	}
	if (context === GLOBAL_CONTEXT && workspaceId === GLOBAL_ID) {
		return (
			session.name === SCRATCH_SESSION &&
			expectedGlobalRoot === root &&
			isRootMetadata(root)
		);
	}
	if (context === WORKSPACE_CONTEXT) {
		return (
			isUuid(workspaceId) &&
			isRootMetadata(root) &&
			isWorkspaceSessionName(session.name, root)
		);
	}
	return false;
}

export function sessionMatches(
	session: SessionInfo,
	context: string,
	workspaceId: string,
	root: string,
): boolean {
	return (
		session.context === context &&
		session.workspaceId === workspaceId &&
		session.root === root
	);
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
		value,
	);
}

function resourceCount(count: number): ResourceInspection {
	return count === 0 ? CLEAN : busy(count);
}

function cleanInspection(): TerminalInspection {
	return { process: CLEAN, extraPanes: CLEAN, extraWindows: CLEAN };
}

function unknownInspection(): TerminalInspection {
	const unknown = unknownResource("close_terminal_unknown");
	return { process: unknown, extraPanes: unknown, extraWindows: unknown };
}

/**
 * Inspection is fail-closed. A provider failure — missing executable,
 * malformed output, a version or protocol error, a timeout — is projected as an
 * unknown resource state, so a caller can never treat an unverified terminal as
 * clean. Cancellation stays an error, so lifecycle code can still tell an
 * explicit abort from an unavailable inspection.
 */
function inspectionFailure(failure: unknown): TerminalInspection {
	if (
		failure instanceof Error &&
		"code" in failure &&
		failure.code === "cancelled"
	) {
		throw failure;
	}
	return unknownInspection();
}

/**
 * Logical read/write exclusion for the one terminal owner.
 *
 * An ordinary operation holds a shared permit; a socket transition holds it
 * exclusively. Waiters re-check cancellation on every wake, so an abandoned
 * operation stops waiting instead of holding the transition back.
 */
class RuntimeOperationGate {
	private transitionActive = false;
	private activeOperations = 0;
	private readonly waiters = new Set<() => void>();

	private wake(): void {
		for (const waiter of [...this.waiters]) waiter();
	}

	private async wait(cancel: CancellationToken): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, POLL_INTERVAL_MS);
			function done() {
				clearTimeout(timer);
				waiters.delete(done);
				resolve();
			}
			const waiters = this.waiters;
			waiters.add(done);
		});
		cancel.check();
	}

	async acquireOperation(cancel: CancellationToken): Promise<() => void> {
		for (;;) {
			cancel.check();
			if (!this.transitionActive) {
				this.activeOperations += 1;
				let released = false;
				return () => {
					if (released) return;
					released = true;
					this.activeOperations -= 1;
					this.wake();
				};
			}
			await this.wait(cancel);
		}
	}

	async acquireTransition(cancel: CancellationToken): Promise<() => void> {
		for (;;) {
			cancel.check();
			if (!this.transitionActive && this.activeOperations === 0) {
				this.transitionActive = true;
				let released = false;
				return () => {
					if (released) return;
					released = true;
					this.transitionActive = false;
					this.wake();
				};
			}
			await this.wait(cancel);
		}
	}
}

/**
 * The startup config file, created 0600 and removed as soon as tmux has read it.
 *
 * It is a real product artifact rather than test scratch; the directory is a
 * constructor input so the app can put it beside its own state.
 */
class BootstrapConfig {
	private constructor(readonly path: string) {}

	static create(directory: string): BootstrapConfig {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const path = join(
				directory,
				`devhub-tmux-bootstrap-${process.pid}-${randomBytes(6).toString("hex")}`,
			);
			let handle: number;
			try {
				// Exclusive create: never write through an existing path.
				handle = openSync(path, "wx", 0o600);
			} catch {
				// Not a swallow: a taken name is retried, which is the loop.
				continue;
			}
			try {
				writeFileSync(handle, BOOTSTRAP_CONFIG, { encoding: "utf8" });
			} catch (failure: unknown) {
				closeSync(handle);
				unlinkSync(path);
				throw portFailure("failed", { cause: failure });
			}
			closeSync(handle);
			return new BootstrapConfig(path);
		}
		throw portFailure("failed");
	}

	remove(): void {
		try {
			unlinkSync(this.path);
		} catch {
			// Not a swallow: the file is already gone, which is the goal.
		}
	}
}

export interface TmuxTerminalRuntimeOptions {
	readonly context: RuntimeLaunchContext;
	/** The configured `runtimes.tmux`, already resolved; absent disables the runtime. */
	readonly tmux: ResolvedExecutable | undefined;
	/** The configured `runtimes.shell`; only its basename is used, for inspection. */
	readonly shell: ResolvedExecutable | undefined;
	/** The configured `runtimes.tmux_args`. Anything unsafe disables the runtime. */
	readonly tmuxArgs: readonly string[];
	/** The configured `runtimes.tmux_socket_name`. */
	readonly effectiveSocketName: string;
	readonly timeoutMs?: number;
	/** Where the one-shot bootstrap config is written. */
	readonly bootstrapDirectory?: string;
}

export class TmuxTerminalRuntime {
	private readonly context: RuntimeLaunchContext;
	private readonly tmux: ResolvedExecutable | undefined;
	private readonly shellName: string | undefined;
	private readonly tmuxArgs: readonly string[];
	private effectiveSocket: SocketName | undefined;
	private readonly gate = new RuntimeOperationGate();
	private readonly bootstrapDirectory: string;
	/** One in-flight bring-up per socket, shared by concurrent callers. */
	private readonly serverBootstraps = new Map<SocketName, Promise<void>>();
	readonly timeoutMs: number;

	constructor(options: TmuxTerminalRuntimeOptions) {
		this.context = options.context;
		// One unsafe argument disables the adapter rather than being filtered
		// out of it: a config that asked for something DevHub will not do must
		// not be silently reinterpreted as one that did not ask.
		const argumentsSafe = options.tmuxArgs.every(isSafeTmuxArgument);
		this.tmux = argumentsSafe ? options.tmux : undefined;
		this.tmuxArgs = argumentsSafe ? [...options.tmuxArgs] : [];
		this.shellName = options.shell?.basename;
		this.effectiveSocket = isValidSocketName(options.effectiveSocketName)
			? socketName(options.effectiveSocketName)
			: undefined;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.bootstrapDirectory = options.bootstrapDirectory ?? tmpdir();
	}

	/** True when a tmux executable and a usable socket name are both present. */
	get adapterAvailable(): boolean {
		return this.tmux !== undefined && this.effectiveSocket !== undefined;
	}

	get contextHome(): string {
		return this.context.home;
	}

	get environment(): Readonly<Record<string, string | undefined>> {
		return this.context.environment;
	}

	private executable(): ResolvedExecutable {
		if (!this.tmux) throw portFailure("unavailable");
		return this.tmux;
	}

	private socket(): SocketName {
		if (!this.effectiveSocket) throw portFailure("failed");
		return this.effectiveSocket;
	}

	setEffectiveSocket(socket: SocketName): void {
		this.effectiveSocket = socket;
	}

	/** A fresh read-only health probe: executable, protocol, current socket. */
	async recheckHealth(): Promise<boolean> {
		if (!this.effectiveSocket) return false;
		try {
			await this.preflightSync(this.socket(), new CancellationToken());
			return true;
		} catch {
			// Not a swallow: this call's whole purpose is to answer yes or no,
			// and the caller renders that answer.
			return false;
		}
	}

	/**
	 * The sessions the persisted workspaces require.
	 *
	 * Deterministic from the snapshot alone, so the set can be rebuilt after a
	 * crash without consulting any live server.
	 */
	requiredTerminalSet(
		workspaces: readonly {
			readonly workspaceId: string;
			readonly canonicalPath: string;
		}[],
	): RequiredTerminalSet {
		const sessions: OwnedSessionRecord[] = [
			{ kind: "scratch", sessionName: SCRATCH_SESSION },
		];
		for (const workspace of workspaces) {
			if (!isUuid(workspace.workspaceId)) throw portFailure("failed");
			const digest = workspaceDigest(workspace.canonicalPath);
			sessions.push({
				kind: "workspace",
				workspaceId: workspace.workspaceId,
				sessionName: `ws-${digest.slice(0, 20)}`,
			});
		}
		return requiredTerminalSet(sessions);
	}

	// --- The port surface. Each one takes the gate the Rust took. ----------

	async preflight(
		requestedSocketName: SocketName,
		cancel = new CancellationToken(),
	): Promise<TerminalPreflight> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			return await this.preflightSync(requestedSocketName, cancel);
		} finally {
			release();
		}
	}

	async ensure(
		target: TerminalTarget,
		cancel = new CancellationToken(),
	): Promise<TerminalTarget> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			await this.ensureSyncOnSocket(this.socket(), target, cancel);
			return target;
		} finally {
			release();
		}
	}

	async inspect(
		target: TerminalTarget,
		cancel = new CancellationToken(),
	): Promise<TerminalInspection> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			return await this.inspectSync(target, cancel);
		} finally {
			release();
		}
	}

	async closeWorkspace(
		target: WorkspaceTerminalTarget,
		cancel = new CancellationToken(),
	): Promise<void> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			await this.closeSync(target, cancel);
		} finally {
			release();
		}
	}

	async inspectOwnedSessions(
		socket: SocketName,
		cancel = new CancellationToken(),
	): Promise<TerminalOwnedSessions> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			return await this.inspectOwnedSessionsSync(socket, cancel);
		} finally {
			release();
		}
	}

	async closeOwnedSession(
		socket: SocketName,
		session: OwnedSessionRecord,
		cancel = new CancellationToken(),
	): Promise<void> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			await this.closeOwnedSessionSync(socket, session, cancel);
		} finally {
			release();
		}
	}

	async ensureOnSocket(
		socket: SocketName,
		target: TerminalTarget,
		cancel = new CancellationToken(),
	): Promise<TerminalTarget> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			await this.ensureSyncOnSocket(socket, target, cancel);
			return target;
		} finally {
			release();
		}
	}

	// The transition variants below run *inside* a held transition permit, so
	// they must not take the gate again. They are the only way to touch a
	// socket that is not the effective one, which is what a socket change is.

	async transitionPreflight(
		socket: SocketName,
		cancel: CancellationToken,
	): Promise<TerminalPreflight> {
		return this.preflightSync(socket, cancel);
	}

	async transitionInspectOwnedSessions(
		socket: SocketName,
		cancel: CancellationToken,
	): Promise<TerminalOwnedSessions> {
		return this.inspectOwnedSessionsSync(socket, cancel);
	}

	async transitionCloseOwnedSession(
		socket: SocketName,
		session: OwnedSessionRecord,
		cancel: CancellationToken,
	): Promise<void> {
		return this.closeOwnedSessionSync(socket, session, cancel);
	}

	async transitionEnsureOnSocket(
		socket: SocketName,
		target: TerminalTarget,
		cancel: CancellationToken,
	): Promise<void> {
		return this.ensureSyncOnSocket(socket, target, cancel);
	}

	/**
	 * Exclusive access for a socket change.
	 *
	 * The caller holds this across the whole transition — inventory the old
	 * socket, adopt the new one, commit the effective name — so no ordinary
	 * operation can create a session on the socket being left behind.
	 */
	async beginTransition(cancel = new CancellationToken()): Promise<() => void> {
		return this.gate.acquireTransition(cancel);
	}

	/** Shared access, for a caller that runs its own provider work (attach). */
	async acquireOperation(cancel: CancellationToken): Promise<() => void> {
		return this.gate.acquireOperation(cancel);
	}

	/**
	 * `ensure` for a caller that already holds an operation permit.
	 *
	 * Attaching has to hold one permit across resolving the session *and*
	 * spawning the client, so it cannot take the gate again here.
	 */
	async ensureUnlocked(
		target: TerminalTarget,
		cancel: CancellationToken,
	): Promise<void> {
		await this.ensureSyncOnSocket(this.socket(), target, cancel);
	}

	/** The session list on the effective socket, for a caller holding a permit. */
	async listSessionsUnlocked(
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<SessionInfo[]> {
		return this.listSessions(this.socket(), cancel, deadline);
	}

	// --- Implementation ----------------------------------------------------

	private async preflightSync(
		requestedSocketName: SocketName,
		cancel: CancellationToken,
	): Promise<TerminalPreflight> {
		const deadline = OperationDeadline.in(this.timeoutMs);
		await this.ensureVersion(requestedSocketName, cancel, deadline);
		const marker = await this.markerState(
			requestedSocketName,
			cancel,
			deadline,
		);
		if (marker === "absent") {
			return terminalPreflight(requestedSocketName, "target_absent", 0, 0);
		}
		if (marker === "wrong") {
			return terminalPreflight(requestedSocketName, "wrong_marker", 0, 0);
		}
		const sessions = await this.listSessions(
			requestedSocketName,
			cancel,
			deadline,
		);
		const owned = sessions.filter((session) =>
			isMarked(session, this.contextHome),
		).length;
		const unknown = Math.max(0, sessions.length - owned);
		return terminalPreflight(
			requestedSocketName,
			owned === 0 ? "target_devhub_empty" : "marked_sessions",
			owned,
			unknown,
		);
	}

	private async ensureSyncOnSocket(
		socket: SocketName,
		target: TerminalTarget,
		cancel: CancellationToken,
	): Promise<void> {
		const deadline = OperationDeadline.in(this.timeoutMs);
		await this.ensureVersion(socket, cancel, deadline);
		await this.ensureServer(socket, cancel, deadline);
		const sessions = await this.listSessions(socket, cancel, deadline);
		const identity = this.targetIdentity(target, sessions);
		const existing = sessions.find(
			(session) => session.name === identity.sessionName,
		);
		if (existing) {
			if (
				sessionMatches(
					existing,
					identity.context,
					identity.workspaceId,
					identity.root,
				)
			) {
				return;
			}
			throw portFailure("conflict");
		}
		await this.createSession(
			socket,
			{
				name: identity.sessionName,
				root: identity.root,
				context: identity.context,
				workspaceId: identity.workspaceId,
			},
			cancel,
			deadline,
		);
	}

	/**
	 * The exact marked sessions on a socket.
	 *
	 * This is the only operation that turns provider metadata into durable
	 * cleanup records. Unmarked sessions stay an opaque count and never become
	 * kill targets.
	 */
	private async inspectOwnedSessionsSync(
		socket: SocketName,
		cancel: CancellationToken,
	): Promise<TerminalOwnedSessions> {
		const deadline = OperationDeadline.in(this.timeoutMs);
		await this.ensureVersion(socket, cancel, deadline);
		const marker = await this.markerState(socket, cancel, deadline);
		if (marker === "absent") return terminalOwnedSessions([], 0);
		if (marker === "wrong") throw portFailure("conflict");
		const sessions = await this.listSessions(socket, cancel, deadline);
		const owned: OwnedSessionRecord[] = [];
		for (const session of sessions) {
			if (!isMarked(session, this.contextHome)) continue;
			owned.push(this.ownedSessionRecord(session));
		}
		return terminalOwnedSessions(
			owned,
			Math.max(0, sessions.length - owned.length),
		);
	}

	private ownedSessionRecord(session: SessionInfo): OwnedSessionRecord {
		if (
			session.context === GLOBAL_CONTEXT &&
			session.workspaceId === GLOBAL_ID &&
			session.name === SCRATCH_SESSION
		) {
			return { kind: "scratch", sessionName: SCRATCH_SESSION };
		}
		if (
			session.context === WORKSPACE_CONTEXT &&
			session.workspaceId !== undefined &&
			isUuid(session.workspaceId)
		) {
			return {
				kind: "workspace",
				workspaceId: session.workspaceId,
				sessionName: session.name,
			};
		}
		throw portFailure("conflict");
	}

	private async closeOwnedSessionSync(
		socket: SocketName,
		expected: OwnedSessionRecord,
		cancel: CancellationToken,
	): Promise<void> {
		const deadline = OperationDeadline.in(this.timeoutMs);
		await this.ensureVersion(socket, cancel, deadline);
		const marker = await this.markerState(socket, cancel, deadline);
		if (marker === "absent") return;
		if (marker === "wrong") throw portFailure("conflict");

		const candidate = await this.findOwned(socket, expected, cancel, deadline);
		if (!candidate) return;
		// The first marker/list pair only establishes an idempotent candidate.
		// Re-inspect both immediately before the kill, so a replaced session or
		// a changed server marker cannot turn this exact record into a broad,
		// name-based destructive operation.
		const recheck = await this.markerState(socket, cancel, deadline);
		if (recheck === "absent") return;
		if (recheck === "wrong") throw portFailure("conflict");
		const current = await this.findOwned(socket, expected, cancel, deadline);
		if (!current) return;

		const root = current.root ?? this.contextHome;
		const output = await this.runTmux(
			socket,
			["kill-session", "-t", expected.sessionName],
			root,
			cancel,
			deadline,
		);
		if (!output.success) throw portFailure("failed");
		// Confirm the destructive operation's result: completion stays
		// idempotent across a crash, and a replacement is never mistaken for
		// the session that was meant to be removed.
		const remaining = await this.listSessions(socket, cancel, deadline);
		const survivor = remaining.find(
			(session) => session.name === expected.sessionName,
		);
		if (!survivor) return;
		throw portFailure(
			this.matchesOwnedRecord(survivor, expected) ? "failed" : "conflict",
		);
	}

	/**
	 * The exact session for a record, or nothing when it is already gone.
	 *
	 * A same-named session that is not the record is a conflict: it must stay
	 * intact.
	 */
	private async findOwned(
		socket: SocketName,
		expected: OwnedSessionRecord,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<SessionInfo | undefined> {
		const sessions = await this.listSessions(socket, cancel, deadline);
		const exact = sessions.find(
			(session) =>
				session.name === expected.sessionName &&
				this.matchesOwnedRecord(session, expected),
		);
		if (exact) return exact;
		if (sessions.some((session) => session.name === expected.sessionName)) {
			throw portFailure("conflict");
		}
		return undefined;
	}

	private matchesOwnedRecord(
		session: SessionInfo,
		expected: OwnedSessionRecord,
	): boolean {
		if (expected.kind === "scratch") {
			return (
				session.name === expected.sessionName &&
				sessionMatches(session, GLOBAL_CONTEXT, GLOBAL_ID, this.contextHome)
			);
		}
		const root = session.root;
		if (root === undefined) return false;
		return (
			session.name === expected.sessionName &&
			session.context === WORKSPACE_CONTEXT &&
			session.workspaceId === expected.workspaceId &&
			isRootMetadata(root) &&
			isWorkspaceSessionName(expected.sessionName, root)
		);
	}

	private async inspectSync(
		target: TerminalTarget,
		cancel: CancellationToken,
	): Promise<TerminalInspection> {
		const deadline = OperationDeadline.in(this.timeoutMs);
		try {
			const socket = this.socket();
			await this.ensureVersion(socket, cancel, deadline);
			const marker = await this.markerState(socket, cancel, deadline);
			if (marker === "absent") return cleanInspection();
			if (marker === "wrong") return unknownInspection();
			const sessions = await this.listSessions(socket, cancel, deadline);
			const identity = this.targetIdentity(target, sessions);
			const session = sessions.find(
				(candidate) => candidate.name === identity.sessionName,
			);
			if (!session) return cleanInspection();
			if (
				!sessionMatches(
					session,
					identity.context,
					identity.workspaceId,
					identity.root,
				)
			) {
				return unknownInspection();
			}
			// Without the configured shell's name there is no way to tell a
			// pane that is only a shell from one running the viewer's work.
			if (this.shellName === undefined) return unknownInspection();
			const windows = await this.listCount(
				socket,
				session.name,
				"list-windows",
				"#{window_id}",
				cancel,
				deadline,
			);
			const panes = await this.listPanes(
				socket,
				session.name,
				cancel,
				deadline,
			);
			return {
				process: resourceCount(
					panes.filter((pane) => !this.isConfiguredShellCommand(pane)).length,
				),
				extraPanes: resourceCount(Math.max(0, panes.length - 1)),
				extraWindows: resourceCount(Math.max(0, windows - 1)),
			};
		} catch (failure: unknown) {
			return inspectionFailure(failure);
		}
	}

	private async closeSync(
		target: WorkspaceTerminalTarget,
		cancel: CancellationToken,
	): Promise<void> {
		const socket = this.socket();
		const deadline = OperationDeadline.in(this.timeoutMs);
		await this.ensureVersion(socket, cancel, deadline);
		const marker = await this.markerState(socket, cancel, deadline);
		if (marker === "absent") return;
		if (marker === "wrong") throw portFailure("conflict");
		const sessions = await this.listSessions(socket, cancel, deadline);
		const identity = this.workspaceIdentity(target, sessions);
		const existing = sessions.find(
			(session) => session.name === identity.sessionName,
		);
		if (!existing) return;
		if (
			!sessionMatches(
				existing,
				WORKSPACE_CONTEXT,
				identity.workspaceId,
				identity.root,
			)
		) {
			throw portFailure("conflict");
		}
		// Re-inspect immediately before the destructive command. A session may
		// have been replaced, or its ownership metadata changed, since the
		// first probe; never kill a mismatched resource.
		const recheck = await this.markerState(socket, cancel, deadline);
		if (recheck === "absent") return;
		if (recheck === "wrong") throw portFailure("conflict");
		const currentSessions = await this.listSessions(socket, cancel, deadline);
		const current = currentSessions.find(
			(session) => session.name === identity.sessionName,
		);
		if (!current) return;
		if (
			!sessionMatches(
				current,
				WORKSPACE_CONTEXT,
				identity.workspaceId,
				identity.root,
			)
		) {
			throw portFailure("conflict");
		}
		const output = await this.runTmux(
			socket,
			["kill-session", "-t", identity.sessionName],
			identity.root,
			cancel,
			deadline,
		);
		if (!output.success) throw portFailure("failed");
	}

	/**
	 * tmux keeps a detached session's window at its previous dimensions even
	 * after an attached client reports a new size. Resize the exact marked
	 * target too, so the interactive pane — not only the client PTY — observes
	 * the request.
	 */
	async resizeOwnedWindow(
		target: TerminalTarget,
		size: { readonly cols: number; readonly rows: number },
		cancel: CancellationToken,
	): Promise<void> {
		const socket = this.socket();
		const deadline = OperationDeadline.in(this.timeoutMs);
		await this.ensureVersion(socket, cancel, deadline);
		if ((await this.markerState(socket, cancel, deadline)) !== "owned") {
			throw portFailure("conflict");
		}
		const sessions = await this.listSessions(socket, cancel, deadline);
		const identity = this.targetIdentity(target, sessions);
		const exact = sessions.find(
			(session) =>
				session.name === identity.sessionName &&
				sessionMatches(
					session,
					identity.context,
					identity.workspaceId,
					identity.root,
				),
		);
		if (!exact) throw portFailure("conflict");
		const output = await this.runTmux(
			socket,
			[
				"resize-window",
				"-t",
				exact.name,
				"-x",
				String(size.cols),
				"-y",
				String(size.rows),
			],
			identity.root,
			cancel,
			deadline,
		);
		if (!output.success) throw portFailure("failed");
	}

	/**
	 * Bring the socket up, and do it once at a time.
	 *
	 * Attaching takes a *shared* permit, because two surfaces attaching at once
	 * is normal. Bringing a socket up is not shareable: the second caller sees
	 * a server that exists with its marker not yet written and reads that as
	 * somebody else's tmux — which is how a workspace terminal failed on the
	 * first launch after the socket was empty, while the scratch one succeeded.
	 *
	 * Concurrent callers therefore share one attempt. The result is not cached:
	 * a server can be killed underneath the app between two operations, so the
	 * next operation still verifies for itself.
	 */
	private async ensureServer(
		socket: SocketName,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<void> {
		const inFlight = this.serverBootstraps.get(socket);
		if (inFlight) {
			await inFlight;
			return;
		}
		const attempt = this.bringServerUp(socket, cancel, deadline).finally(() => {
			this.serverBootstraps.delete(socket);
		});
		this.serverBootstraps.set(socket, attempt);
		await attempt;
	}

	private async bringServerUp(
		socket: SocketName,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<void> {
		const marker = await this.markerState(socket, cancel, deadline);
		if (marker === "wrong") throw portFailure("conflict");
		if (marker === "absent") {
			await this.bootstrapAbsentServer(socket, cancel, deadline);
		}
		await this.ensureScratch(socket, cancel, deadline);
	}

	/**
	 * Verify the complete Scratch identity after every bootstrap or attach.
	 *
	 * A marker alone is not ownership: an existing partial or mismatched
	 * `scratch` session is opaque and must never be repaired in place. If the
	 * exact session is absent on an otherwise-owned server, create it through
	 * the same metadata chain and read it back again.
	 */
	private async ensureScratch(
		socket: SocketName,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<void> {
		const home = this.contextHome;
		const sessions = await this.listSessions(socket, cancel, deadline);
		const scratch = sessions.find(
			(session) => session.name === SCRATCH_SESSION,
		);
		if (scratch) {
			if (!sessionMatches(scratch, GLOBAL_CONTEXT, GLOBAL_ID, home)) {
				throw portFailure("conflict");
			}
			if ((await this.markerState(socket, cancel, deadline)) !== "owned") {
				throw portFailure("conflict");
			}
			return;
		}
		await this.createSession(
			socket,
			{
				name: SCRATCH_SESSION,
				root: home,
				context: GLOBAL_CONTEXT,
				workspaceId: GLOBAL_ID,
			},
			cancel,
			deadline,
		);
		if ((await this.markerState(socket, cancel, deadline)) !== "owned") {
			throw portFailure("conflict");
		}
		const readBack = await this.listSessions(socket, cancel, deadline);
		const created = readBack.find(
			(session) => session.name === SCRATCH_SESSION,
		);
		if (!created || !sessionMatches(created, GLOBAL_CONTEXT, GLOBAL_ID, home)) {
			throw portFailure("conflict");
		}
	}

	async markerState(
		socket: SocketName,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<MarkerState> {
		const output = await this.runTmux(
			socket,
			["show-options", "-gqv", PROTOCOL_OPTION],
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) {
			if (isNoServerError(output.stderr)) return "absent";
			// A reachable server without this option is an existing foreign
			// server, not an absent one. A missing marker is the same
			// fail-closed conflict as an explicitly wrong marker.
			return "wrong";
		}
		if (output.stdout.byteLength === 0) return "wrong";
		return parseOptionValue(output.stdout) === PROTOCOL_VALUE
			? "owned"
			: "wrong";
	}

	async ensureVersion(
		socket: SocketName,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<void> {
		const output = await this.runTmux(
			socket,
			["-V"],
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) throw portFailure("unavailable");
		const line = parseLines(output.stdout)[0];
		if (line === undefined || !line.startsWith("tmux ")) {
			throw portFailure("incompatible");
		}
		const parts = line.slice("tmux ".length).split(".");
		const major = parseNumericPrefix(parts[0] ?? "");
		const minor = parseNumericPrefix(parts[1] ?? "");
		if (
			major < MIN_TMUX_MAJOR ||
			(major === MIN_TMUX_MAJOR && minor < MIN_TMUX_MINOR)
		) {
			throw portFailure("incompatible");
		}
	}

	targetIdentity(
		target: TerminalTarget,
		sessions: readonly SessionInfo[],
	): TargetIdentity {
		if (target.kind === "scratch") {
			return {
				sessionName: SCRATCH_SESSION,
				root: this.contextHome,
				workspaceId: GLOBAL_ID,
				context: GLOBAL_CONTEXT,
			};
		}
		return this.workspaceIdentity(target, sessions);
	}

	/**
	 * A workspace session's name is a digest of its root, so it is the same
	 * name on every launch. The longer name exists only for the case where the
	 * short one is already taken by a session that is not this workspace's.
	 */
	private workspaceIdentity(
		target: WorkspaceTerminalTarget,
		sessions: readonly SessionInfo[],
	): TargetIdentity {
		const root = target.root;
		if (!isAbsolute(root)) throw portFailure("failed");
		const workspaceId = target.workspaceId;
		const digest = workspaceDigest(root);
		const short = `ws-${digest.slice(0, 20)}`;
		const long = `ws-${digest.slice(0, 32)}`;
		const expected = (name: string): boolean | undefined => {
			const session = sessions.find((candidate) => candidate.name === name);
			return session
				? sessionMatches(session, WORKSPACE_CONTEXT, workspaceId, root)
				: undefined;
		};
		const shortState = expected(short);
		if (shortState === undefined || shortState) {
			return {
				sessionName: short,
				root,
				workspaceId,
				context: WORKSPACE_CONTEXT,
			};
		}
		const longState = expected(long);
		if (longState === undefined || longState) {
			return {
				sessionName: long,
				root,
				workspaceId,
				context: WORKSPACE_CONTEXT,
			};
		}
		throw portFailure("conflict");
	}

	private async createSession(
		socket: SocketName,
		spec: SessionSpec,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<void> {
		if (!existsSync(spec.root) || !statSync(spec.root).isDirectory()) {
			throw portFailure("unavailable");
		}
		if ((await this.markerState(socket, cancel, deadline)) !== "owned") {
			throw portFailure("conflict");
		}
		let canonical: string;
		try {
			canonical = realpathSync(spec.root);
		} catch (failure: unknown) {
			throw portFailure("unavailable", { cause: failure });
		}
		// The root is identity. A path that canonicalises to somewhere else is
		// a different directory, and the session must not claim to be its.
		if (canonical !== spec.root) throw portFailure("conflict");
		const args = [
			"new-session",
			"-d",
			"-s",
			spec.name,
			"-c",
			spec.root,
			";",
			"set-option",
			"-t",
			spec.name,
			CONTEXT_OPTION,
			spec.context,
			";",
			"set-option",
			"-t",
			spec.name,
			WORKSPACE_ID_OPTION,
			spec.workspaceId,
			";",
			"set-option",
			"-t",
			spec.name,
			ROOT_OPTION,
			spec.root,
		];
		// The last read before creating a session. The earlier check protects
		// path validation; this one keeps a server that changed marker state
		// while argv was being prepared from receiving a mutating command.
		if ((await this.markerState(socket, cancel, deadline)) !== "owned") {
			throw portFailure("conflict");
		}
		const output = await this.runTmux(
			socket,
			args,
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) {
			// Leave a possibly-created session for exact reconciliation. A blind
			// kill could destroy a concurrent or unknown resource.
			throw portFailure("conflict");
		}
	}

	async listSessions(
		socket: SocketName,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<SessionInfo[]> {
		const output = await this.runTmux(
			socket,
			["list-sessions", "-F", "#{session_name}"],
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) {
			if (isNoServerError(output.stderr)) return [];
			throw portFailure("failed");
		}
		const names = parseLines(output.stdout);
		if (names.length > MAX_SESSIONS) throw portFailure("failed");
		const sessions: SessionInfo[] = [];
		for (const name of names) {
			sessions.push({
				name,
				context: await this.showOption(
					socket,
					name,
					CONTEXT_OPTION,
					cancel,
					deadline,
				),
				workspaceId: await this.showOption(
					socket,
					name,
					WORKSPACE_ID_OPTION,
					cancel,
					deadline,
				),
				root: await this.showOption(
					socket,
					name,
					ROOT_OPTION,
					cancel,
					deadline,
				),
			});
		}
		return sessions;
	}

	private async showOption(
		socket: SocketName,
		session: string,
		option: string,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<string | undefined> {
		const output = await this.runTmux(
			socket,
			["show-options", "-t", session, "-qv", option],
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success || output.stdout.byteLength === 0) return undefined;
		return parseOptionValue(output.stdout);
	}

	private async listCount(
		socket: SocketName,
		session: string,
		command: string,
		format: string,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<number> {
		const output = await this.runTmux(
			socket,
			[command, "-t", session, "-F", format],
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) throw portFailure("failed");
		const lines = parseLines(output.stdout);
		if (lines.length > MAX_WINDOWS) throw portFailure("failed");
		return lines.length;
	}

	private async listPanes(
		socket: SocketName,
		session: string,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<string[]> {
		const output = await this.runTmux(
			socket,
			["list-panes", "-t", session, "-F", "#{pane_current_command}"],
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) throw portFailure("failed");
		const lines = parseLines(output.stdout);
		if (lines.length > MAX_PANES) throw portFailure("failed");
		return lines;
	}

	/**
	 * The one user tmux config DevHub will source, by the precedence tmux
	 * itself documents. `/dev/null` when there is none, so the bootstrap
	 * `source-file` always names a real path.
	 */
	userTmuxConfigPath(): string {
		const home = this.contextHome;
		const candidates = [join(home, ".tmux.conf")];
		const xdg = this.context.environment.XDG_CONFIG_HOME;
		candidates.push(
			xdg && isAbsolute(xdg)
				? join(xdg, "tmux", "tmux.conf")
				: join(home, ".config", "tmux", "tmux.conf"),
		);
		for (const candidate of candidates) {
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// Not a swallow: a candidate that is not there is not the answer,
				// and the next one is tried.
			}
		}
		return "/dev/null";
	}

	private isConfiguredShellCommand(command: string): boolean {
		if (this.shellName === undefined) return false;
		const trimmed = command.replace(/^-+/u, "");
		const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
		return name === this.shellName;
	}

	/**
	 * Probe or bootstrap an absent server through a startup config.
	 *
	 * tmux reads `-f` only while creating a new server; against an existing one
	 * this invocation is a read-only `show-options` probe and the config is
	 * ignored. That closes the absent-to-wrong-marker race without ever issuing
	 * a mutating command to a server DevHub does not own.
	 */
	private async bootstrapAbsentServer(
		socket: SocketName,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<void> {
		const config = BootstrapConfig.create(this.bootstrapDirectory);
		let output: CommandOutput;
		try {
			output = await this.runBootstrapProbe(
				config,
				socket,
				this.contextHome,
				cancel,
				deadline,
			);
		} finally {
			config.remove();
		}
		if (output.success) {
			if (output.stdout.byteLength === 0) throw portFailure("conflict");
			if (parseOptionValue(output.stdout) !== PROTOCOL_VALUE) {
				throw portFailure("conflict");
			}
			return;
		}
		// A trusted user config may already have created a session named
		// `scratch` with a foreign or partial identity. That observable
		// collision is a conflict; an actual server startup error is a failure.
		const sessions = await this.listSessions(socket, cancel, deadline).catch(
			() => [] as SessionInfo[],
		);
		if (sessions.some((session) => session.name === SCRATCH_SESSION)) {
			throw portFailure("conflict");
		}
		throw portFailure("failed");
	}

	private async runBootstrapProbe(
		config: BootstrapConfig,
		socket: SocketName,
		root: string,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<CommandOutput> {
		return runBounded(
			{
				file: this.executable().path,
				args: [
					...this.tmuxArgs,
					"-f",
					config.path,
					"-L",
					socket,
					// `show-options` alone does not create a server. Start it and
					// read the marker in one client queue: on an existing server
					// `start-server` is a no-op and the startup config is ignored,
					// so this stays observational; on a new server the config has
					// created the fully marked Scratch session before the read.
					"start-server",
					";",
					"show-options",
					"-gqv",
					PROTOCOL_OPTION,
				],
				cwd: this.contextHome,
				env: {
					...this.tmuxEnvironment(),
					[BOOTSTRAP_ENV_ROOT]: root,
					[BOOTSTRAP_ENV_USER_CONFIG]: this.userTmuxConfigPath(),
				},
			},
			deadline,
			cancel,
		);
	}

	/**
	 * The client's environment.
	 *
	 * A DevHub launched from inside a tmux pane must still create and inspect
	 * its own dedicated server rather than inheriting the parent client's
	 * nested-session hints.
	 */
	private tmuxEnvironment(): Record<string, string | undefined> {
		const env = { ...this.context.environment };
		delete env.TMUX;
		delete env.TMUX_PANE;
		return env;
	}

	async runTmux(
		socket: SocketName,
		args: readonly string[],
		_cwd: string,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<CommandOutput> {
		return runBounded(
			{
				file: this.executable().path,
				args: [...this.tmuxArgs, "-L", socket, ...args],
				// The client's working directory must stay usable even when a
				// workspace has been deleted; session creation still receives its
				// target root through tmux's explicit `-c` argument.
				cwd: this.contextHome,
				env: this.tmuxEnvironment(),
			},
			deadline,
			cancel,
		);
	}

	/** The argv that attaches one PTY client to an exact marked session. */
	attachArgv(sessionName: string): readonly string[] {
		return [
			...this.tmuxArgs,
			"-L",
			this.socket(),
			"attach-session",
			"-t",
			sessionName,
		];
	}

	tmuxPath(): string {
		return this.executable().path;
	}
}
