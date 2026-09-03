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
	FIELD_SEPARATOR,
	MAX_ROOT_METADATA_BYTES,
	OperationDeadline,
	RECORD_SEPARATOR,
	isNoServerError,
	parseLines,
	parseOptionValue,
	parseCapture,
	parseRecords,
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
	SCRATCH_TARGET,
	terminalOwnedSessions,
	terminalPreflight,
	type AgentSessionCommand,
	type AgentTerminalTarget,
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
const AGENT_ID_OPTION = "@devhub-agent-id";
const GLOBAL_CONTEXT = "global";
const WORKSPACE_CONTEXT = "workspace";
const AGENT_CONTEXT = "agent";
const GLOBAL_ID = "global";
/** The marker value a session that is not an Agent carries. */
const NO_AGENT = "none";
export const SCRATCH_SESSION = "scratch";
const MIN_TMUX_MAJOR = 3;
const MIN_TMUX_MINOR = 3;
/**
 * One session's whole identity, as tmux expands it: name, then the four
 * markers, with the root last because it is the only value that may contain a
 * newline of its own.
 */
const SESSION_FORMAT =
	[
		"#{session_name}",
		`#{${CONTEXT_OPTION}}`,
		`#{${WORKSPACE_ID_OPTION}}`,
		`#{${AGENT_ID_OPTION}}`,
		`#{${ROOT_OPTION}}`,
	].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
/** Which of the two listings a record of `listWindowsAndPanes` came from. */
const WINDOW_RECORD = "window";
const PANE_RECORD = "pane";
const MAX_SESSIONS = 1024;
const MAX_WINDOWS = 256;
const MAX_PANES = 1024;
const POLL_INTERVAL_MS = 5;
const DEFAULT_TIMEOUT_MS = 3_000;
/**
 * How long to wait between finishing a paste and pressing Return.
 *
 * Not a guess, and not the "about a second" it feels like it should be. A TUI
 * that does not receive the bracketed-paste markers — some terminals never
 * send them — has to work out for itself whether a fast run of characters was
 * typed or pasted, and it does that on a timer. Codex's is in the open:
 * `PASTE_ENTER_SUPPRESS_WINDOW` in `tui/src/bottom_pane/paste_burst.rs` is
 * 120ms, and while that window is open a Return *inserts a newline instead of
 * submitting*. Worse for a multi-line instruction, each newline that lands
 * during the burst re-arms the window, so it runs from the last line rather
 * than the first — which is exactly the report: the text arrived, the Return
 * only added a blank line, and nothing was sent.
 *
 * So the wait has to clear that window with room for scheduling jitter, and
 * nothing is gained by making it longer: this is a race against a heuristic,
 * not against the Agent. Twice the documented window is the value, and when
 * the markers *do* arrive it costs a quarter second and changes nothing —
 * Codex clears its burst state outright on an explicit paste.
 */
const PASTE_SUBMIT_DELAY_MS = 250;
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
	// Every client this server will ever have is an xterm.js in DevHub's own
	// window, and xterm.js renders 24-bit colour. Saying so once, on the server,
	// is what makes a pane's programs emit 24-bit sequences instead of asking
	// terminfo and quantising to 256 — the visible symptom being a colour ramp
	// that comes out in bands.
	//
	// `-a` appends to whatever the user's config just set, so a user who
	// declares features for their own outside terminal keeps them; `-s` because
	// `terminal-features` is a server option. The leading comma is the empty
	// first entry of the list tmux parses, which is how a pattern:feature pair
	// is spelled.
	//
	// No `terminal-overrides Tc` fallback: `terminal-features` arrived in tmux
	// 3.2 and DevHub already refuses anything below 3.3 (`MIN_TMUX_MINOR`), so
	// the older spelling is unreachable and would only be a second way to say
	// the same thing.
	"set -as terminal-features ',*:RGB'",
	// The two variables above are DevHub's, not the user's, and a tmux server
	// hands its whole environment to every shell it ever starts — so left in
	// place they would show up in `env` in every pane, for the life of the
	// server, long after the one command that needed them.
	//
	// Unsetting them here, *before* the session is created, is what keeps that
	// out of the very first pane as well. It costs nothing: tmux expands `$VAR`
	// in a config file from the environment the server was started with, not
	// from the global environment this edits, so the `new-session` below still
	// sees the root.
	[
		`set-environment -gu ${BOOTSTRAP_ENV_ROOT}`,
		`set-environment -gu ${BOOTSTRAP_ENV_USER_CONFIG}`,
	].join(" ; "),
	[
		`new-session -d -s ${SCRATCH_SESSION} -c "$${BOOTSTRAP_ENV_ROOT}"`,
		`set-option -t ${SCRATCH_SESSION} ${CONTEXT_OPTION} ${GLOBAL_CONTEXT}`,
		`set-option -t ${SCRATCH_SESSION} ${WORKSPACE_ID_OPTION} ${GLOBAL_ID}`,
		`set-option -t ${SCRATCH_SESSION} ${ROOT_OPTION} "$${BOOTSTRAP_ENV_ROOT}"`,
		`set-option -t ${SCRATCH_SESSION} ${AGENT_ID_OPTION} ${NO_AGENT}`,
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
	readonly agentId: string | undefined;
}

interface SessionSpec {
	readonly name: string;
	readonly root: string;
	readonly context: string;
	readonly workspaceId: string;
	readonly agentId: string;
	/**
	 * The session's own command, when the session *is* a command.
	 *
	 * Absent means tmux starts the login shell, which is what a workspace or
	 * scratch terminal is. Present means the pane dies when the command exits
	 * and takes the session with it, which is what an Agent is.
	 */
	readonly command?: AgentSessionCommand;
}

/** The identity a target resolves to on a given server. */
export interface TargetIdentity {
	readonly sessionName: string;
	readonly root: string;
	readonly workspaceId: string;
	readonly context: string;
	/** `none` for everything that is not an Agent. */
	readonly agentId: string;
}

/**
 * The tmux options a session carries because of what it is.
 *
 * **The window follows its client.** `window-size latest` is tmux's own
 * default, and DevHub says it out loud because DevHub is the reason a window
 * might not have it. An earlier build resized the session's window explicitly
 * on every client resize, and an explicit `resize-window` latches that window
 * to `window-size manual` for good. The call is gone, but the latch it left
 * is not: it lives in the tmux server, and the server outlives the app. So a
 * window that was ever resized by that build stayed frozen at the size the
 * last DevHub happened to be — a person closed the app, reopened it larger,
 * and got the old geometry with the shell drawing into part of the pane.
 *
 * That is not a preference of the user's being overridden. It is DevHub
 * clearing a value DevHub itself wrote, which is why it is stated for every
 * session rather than only the ones DevHub owns outright, and why it is
 * re-stated on every open rather than only at creation.
 *
 * **An Agent has no status bar.** An Agent session is not a tmux the user
 * drives. Nothing in it switches windows, and its single pane is the Agent's
 * own process, so tmux's status bar is a row of chrome for controls that do
 * not apply — and a row the pane does not get to draw in.
 *
 * Every other session — a workspace's integrated terminal, Scratch — *is* the
 * user's tmux: they may split it, switch windows, and want the bar that says
 * where they are. DevHub declares nothing about *those*, so whatever the
 * user's own config asked for is what they get.
 *
 * tmux resolves an option's scope from its name, so a window option and a
 * session option are set the same way here.
 */
function sessionOptions(
	context: string,
): readonly (readonly [string, string])[] {
	return [
		["window-size", "latest"],
		...(context === AGENT_CONTEXT
			? ([["status", "off"]] as const)
			: ([] as const)),
	];
}

/** An Agent session's name is its id, so it is findable after a restart. */
export function agentSessionName(agentId: string): string {
	return `ag-${agentId}`;
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

/**
 * The agent-id marker, as the rest of this file compares it.
 *
 * `@devhub-agent-id` joined the marker tuple after the other three, and tmux
 * has no way to say "this option was written as empty" — an unset option and
 * an empty one read back the same. So a session DevHub itself created before
 * the marker existed carries `@devhub-context`, `@devhub-workspace-id` and
 * `@devhub-root` exactly, and nothing here. That session is DevHub's own, on
 * DevHub's own socket, under DevHub's own server protocol marker; it is not a
 * foreign resource, and the fact it states about agents is the one `none`
 * states.
 *
 * Reading it that way *here* is deliberate. This is the boundary where a
 * session's markers become the tuple every comparison above uses, so the
 * older spelling is decoded once and `isMarked` and `sessionMatches` stay
 * exact matches on a canonical tuple — rather than each of them growing an
 * "unless it is missing" branch that the next comparison would forget.
 *
 * The absence is not read as permission for anything: an Agent session still
 * has to carry a real id, and `none` is not one, so an agent-context session
 * with no marker stays unowned exactly as before.
 */
/**
 * A marker as read from a format expansion. DevHub never writes an empty
 * marker, so empty is how an unset one arrives — the same answer the
 * per-field `show-options` gave by returning no output at all.
 */
function markerValue(raw: string): string | undefined {
	return raw.length === 0 ? undefined : raw;
}

function agentIdMarker(raw: string | undefined): string {
	return raw === undefined ? NO_AGENT : raw;
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
	const { context, workspaceId, root, agentId } = session;
	if (
		context === undefined ||
		workspaceId === undefined ||
		root === undefined ||
		agentId === undefined
	) {
		return false;
	}
	if (context === GLOBAL_CONTEXT && workspaceId === GLOBAL_ID) {
		return (
			agentId === NO_AGENT &&
			session.name === SCRATCH_SESSION &&
			expectedGlobalRoot === root &&
			isRootMetadata(root)
		);
	}
	if (context === WORKSPACE_CONTEXT) {
		return (
			agentId === NO_AGENT &&
			isUuid(workspaceId) &&
			isRootMetadata(root) &&
			isWorkspaceSessionName(session.name, root)
		);
	}
	if (context === AGENT_CONTEXT) {
		return (
			isUuid(agentId) &&
			isUuid(workspaceId) &&
			isRootMetadata(root) &&
			session.name === agentSessionName(agentId)
		);
	}
	return false;
}

/**
 * Whether a session is the exact one an identity names.
 *
 * The whole marker tuple is compared, never a prefix of it: a session that
 * agrees about three of the four is a different session that happens to share
 * a name, and it must stay intact.
 */
export function sessionMatches(
	session: SessionInfo,
	identity: TargetIdentity,
): boolean {
	return (
		session.context === identity.context &&
		session.workspaceId === identity.workspaceId &&
		session.root === identity.root &&
		session.agentId === identity.agentId
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

/**
 * `new-session -e KEY=VALUE` for each of a command's own variables.
 *
 * Sorted, so the argv a launch produces depends on the profile and nothing
 * else. The server's environment — the app's frozen launch environment — is
 * already what every pane inherits; these are the profile's additions to it.
 */
function envArguments(
	env: Readonly<Record<string, string>> | undefined,
): string[] {
	if (!env) return [];
	const args: string[] = [];
	for (const key of Object.keys(env).sort()) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw portFailure("failed");
		const value = env[key] ?? "";
		if (value.includes("\0")) throw portFailure("failed");
		args.push("-e", `${key}=${value}`);
	}
	return args;
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

/**
 * A configured executable, or the sentence saying why there is none.
 *
 * The reason travels with the absence rather than being re-derived at the
 * point of failure: by the time a pane refuses to attach, the search that
 * failed is many frames away, and a refusal that cannot name it is a refusal
 * nobody can act on.
 */
export type RuntimeExecutable =
	| { readonly kind: "resolved"; readonly value: ResolvedExecutable }
	| { readonly kind: "unavailable"; readonly reason: string };

export interface TmuxTerminalRuntimeOptions {
	readonly context: RuntimeLaunchContext;
	/** The configured `runtimes.tmux`, already resolved; unavailable disables the runtime. */
	readonly tmux: RuntimeExecutable;
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
	private readonly tmux: RuntimeExecutable;
	private readonly shellName: string | undefined;
	private readonly tmuxArgs: readonly string[];
	private effectiveSocket: SocketName | undefined;
	private readonly gate = new RuntimeOperationGate();
	private readonly bootstrapDirectory: string;
	/** One in-flight bring-up per socket, shared by concurrent callers. */
	private readonly serverBootstraps = new Map<SocketName, Promise<void>>();
	/**
	 * The executable whose `tmux -V` this runtime has already accepted.
	 *
	 * Every operation begins by checking the version, and the answer cannot
	 * change under a resolved executable: the path is canonical and the runtime
	 * never re-derives it, so a second `-V` is a process spent re-reading a
	 * constant. A replaced binary still cannot slip past — the very next tmux
	 * command runs the new one, and reports its own failure.
	 */
	private acceptedVersionOf: string | undefined;
	readonly timeoutMs: number;

	constructor(options: TmuxTerminalRuntimeOptions) {
		this.context = options.context;
		// One unsafe argument disables the adapter rather than being filtered
		// out of it: a config that asked for something DevHub will not do must
		// not be silently reinterpreted as one that did not ask.
		const argumentsSafe = options.tmuxArgs.every(isSafeTmuxArgument);
		this.tmux = argumentsSafe
			? options.tmux
			: {
					kind: "unavailable",
					reason:
						"DevHub will not run tmux with the configured tmux_args: one of them is not an argument DevHub passes on.",
				};
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
		return this.tmux.kind === "resolved" && this.effectiveSocket !== undefined;
	}

	get contextHome(): string {
		return this.context.home;
	}

	get environment(): Readonly<Record<string, string | undefined>> {
		return this.context.environment;
	}

	private executable(): ResolvedExecutable {
		if (this.tmux.kind === "unavailable") {
			throw portFailure("unavailable", { detail: this.tmux.reason });
		}
		return this.tmux.value;
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

	/**
	 * After this returns, the target's exact marked session exists.
	 *
	 * A terminal is a *place*: if it is not there it is created, because that
	 * is what asking for a workspace's terminal means. An Agent is a *process*:
	 * its session is created once, by `launchAgent`, with the command that is
	 * the Agent — so a missing Agent session means the Agent ended, and
	 * recreating it here would resurrect it as an empty shell wearing its name.
	 */
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
			if (!sessionMatches(existing, identity)) throw portFailure("conflict");
			// The session is proven DevHub's, so its options are DevHub's to
			// state. Re-stating them here is what migrates a session created by
			// an older build, and it runs on the same path every open takes.
			await this.applySessionOptions(socket, identity, cancel, deadline);
			return;
		}
		if (target.kind === "agent") throw portFailure("conflict");
		await this.createSession(
			socket,
			{
				name: identity.sessionName,
				root: identity.root,
				context: identity.context,
				workspaceId: identity.workspaceId,
				agentId: identity.agentId,
			},
			cancel,
			deadline,
		);
	}

	// --- Agents ------------------------------------------------------------

	/**
	 * Start one Agent: a marked session whose session command is the Agent.
	 *
	 * There is no separate "is it already running" branch. The create is the
	 * claim: if a session with this Agent's name already exists, tmux refuses
	 * and the launch is a conflict, which is the truth — two DevHubs, or a
	 * relaunch of an id that never died.
	 */
	async launchAgent(
		target: AgentTerminalTarget,
		command: AgentSessionCommand,
		cancel = new CancellationToken(),
	): Promise<void> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			const socket = this.socket();
			const deadline = OperationDeadline.in(this.timeoutMs);
			await this.ensureVersion(socket, cancel, deadline);
			await this.ensureServer(socket, cancel, deadline);
			const identity = this.targetIdentity({ kind: "agent", ...target }, []);
			await this.createSession(
				socket,
				{
					name: identity.sessionName,
					root: identity.root,
					context: identity.context,
					workspaceId: identity.workspaceId,
					agentId: identity.agentId,
					command,
				},
				cancel,
				deadline,
			);
			// Read the whole marker tuple back before calling the Agent started.
			// A session that exists but is not this Agent's is somebody else's
			// resource, and the row must not claim it.
			const readBack = await this.listSessions(socket, cancel, deadline);
			const created = readBack.find(
				(session) => session.name === identity.sessionName,
			);
			if (!created || !sessionMatches(created, identity)) {
				throw portFailure("conflict");
			}
		} finally {
			release();
		}
	}

	/**
	 * Every Agent session on the effective socket, by Agent id.
	 *
	 * This is the whole of "which Agents are alive". tmux destroys a session
	 * when its command exits, so an id that is not in this list is an Agent
	 * that has ended — there is no second signal to reconcile against.
	 */
	async listAgents(
		cancel = new CancellationToken(),
	): Promise<readonly OwnedSessionRecord[]> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			const socket = this.socket();
			const deadline = OperationDeadline.in(this.timeoutMs);
			await this.ensureVersion(socket, cancel, deadline);
			const marker = await this.markerState(socket, cancel, deadline);
			if (marker === "absent") return [];
			if (marker === "wrong") throw portFailure("conflict");
			const sessions = await this.listSessions(socket, cancel, deadline);
			return sessions
				.filter(
					(session) =>
						session.context === AGENT_CONTEXT &&
						isMarked(session, this.contextHome),
				)
				.map((session) => this.ownedSessionRecord(session));
		} finally {
			release();
		}
	}

	/**
	 * One Agent's visible screen, and the title its program set.
	 *
	 * `capture-pane` reads the pane whether or not a client is attached, which
	 * is why status detection uses it rather than the attached surface's
	 * stream: the sidebar must be able to say what every Agent is doing with no
	 * surface open at all.
	 *
	 * The ownership check is the first command in the *same* client queue as
	 * the read, rather than a separate `list-sessions` before it. That is both
	 * cheaper — one tmux invocation per Agent per round instead of a full
	 * marker inventory — and stricter: a session that was replaced between a
	 * separate check and the capture could still have been read, and here it
	 * cannot, because the id and the screen come out of one command run.
	 *
	 * There is no OSC-progress equivalent. tmux exposes the pane title (OSC 0
	 * and 2) as `#{pane_title}` and does not expose OSC 9;4 progress at all, so
	 * a rule keyed on progress can never match here. That is stated rather than
	 * worked around: reading it would mean DevHub parsing the pane's byte
	 * stream itself, which is the rendered-screen indirection this transport
	 * exists to remove.
	 */
	async captureAgent(
		record: OwnedSessionRecord,
		cancel = new CancellationToken(),
	): Promise<{ readonly screen: string; readonly oscTitle: string }> {
		if (record.kind !== "agent") throw portFailure("failed");
		const release = await this.gate.acquireOperation(cancel);
		try {
			const socket = this.socket();
			const deadline = OperationDeadline.in(this.timeoutMs);
			const output = await this.runTmux(
				socket,
				[
					"display-message",
					"-p",
					"-t",
					record.sessionName,
					`#{${AGENT_ID_OPTION}}`,
					";",
					"display-message",
					"-p",
					"-t",
					record.sessionName,
					"#{pane_title}",
					";",
					"capture-pane",
					"-p",
					"-J",
					"-t",
					record.sessionName,
				],
				this.contextHome,
				cancel,
				deadline,
			);
			if (!output.success) throw portFailure("conflict");
			// The first two lines are the two `display-message` answers; a pane
			// title cannot contain a newline, because tmux takes it from an OSC
			// string and control characters do not survive that.
			const lines = parseCapture(output.stdout).split("\n");
			if (lines[0] !== record.agentId) throw portFailure("conflict");
			return {
				oscTitle: lines[1] ?? "",
				screen: lines.slice(2).join("\n"),
			};
		} finally {
			release();
		}
	}

	/**
	 * Type text into one Agent's prompt, as a paste, and submit it.
	 *
	 * The bytes are wrapped in the bracketed-paste markers a terminal sends
	 * when a person pastes, because that is what tells the program on the other
	 * end that a block of text arrived together. Without them a CLI reads the
	 * line breaks as Enter and submits every line as its own message; with
	 * them, a multi-line instruction lands in the prompt box as one message and
	 * waits there. Verified against a real Claude Code: three lines went in as
	 * one, and nothing was sent until the Enter that follows.
	 *
	 * The line breaks are carriage returns, not newlines. That is what a
	 * terminal puts on the wire for the Return key, and it is what the program
	 * inside a paste turns back into a line break — a bare newline is dropped,
	 * which was three lines arriving as one run-on sentence until this was
	 * measured.
	 *
	 * The Return goes separately, a beat later — see `PASTE_SUBMIT_DELAY_MS`
	 * for the measured reason it cannot ride along in the same command.
	 *
	 * **Why the identity is read again first.** `captureAgent` reads and then
	 * checks, which is safe for a read: a screen that turned out to be somebody
	 * else's is discarded. This writes, and there is no discarding a keystroke
	 * that has already been typed into the wrong pane. So the check comes
	 * first, in the same held permit, in the same shape `closeOwnedSession`
	 * uses before it destroys anything.
	 */
	async injectAgentText(
		record: OwnedSessionRecord,
		text: string,
		cancel = new CancellationToken(),
	): Promise<void> {
		if (record.kind !== "agent") throw portFailure("failed");
		if (text.trim().length === 0) throw portFailure("failed");
		const release = await this.gate.acquireOperation(cancel);
		try {
			const socket = this.socket();
			const deadline = OperationDeadline.in(this.timeoutMs);
			const identity = await this.runTmux(
				socket,
				[
					"display-message",
					"-p",
					"-t",
					record.sessionName,
					`#{${AGENT_ID_OPTION}}`,
				],
				this.contextHome,
				cancel,
				deadline,
			);
			if (!identity.success) throw portFailure("conflict");
			if (parseCapture(identity.stdout).split("\n")[0] !== record.agentId) {
				throw portFailure("conflict");
			}
			const body = text.replaceAll(/\r\n|\n/gu, "\r");
			const paste = `\u001b[200~${body}\u001b[201~`;
			const typed = await this.runTmux(
				socket,
				["send-keys", "-t", record.sessionName, "-l", "--", paste],
				this.contextHome,
				cancel,
				deadline,
			);
			if (!typed.success) throw portFailure("failed");
			// The Return is a separate command a moment later, not the second
			// half of this one. See `PASTE_SUBMIT_DELAY_MS`.
			await new Promise((resolve) =>
				setTimeout(resolve, PASTE_SUBMIT_DELAY_MS),
			);
			cancel.check();
			const submitted = await this.runTmux(
				socket,
				["send-keys", "-t", record.sessionName, "Enter"],
				this.contextHome,
				cancel,
				deadline,
			);
			if (!submitted.success) throw portFailure("failed");
		} finally {
			release();
		}
	}

	/** Kill one Agent's session, by the same exact-record rule as any other. */
	async closeAgent(
		record: OwnedSessionRecord,
		cancel = new CancellationToken(),
	): Promise<void> {
		const release = await this.gate.acquireOperation(cancel);
		try {
			await this.closeOwnedSessionSync(this.socket(), record, cancel);
		} finally {
			release();
		}
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
		if (
			session.context === AGENT_CONTEXT &&
			session.agentId !== undefined &&
			session.workspaceId !== undefined &&
			isUuid(session.agentId) &&
			isUuid(session.workspaceId)
		) {
			return {
				kind: "agent",
				agentId: session.agentId,
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
		if (session.name !== expected.sessionName) return false;
		if (expected.kind === "scratch") {
			return sessionMatches(session, this.targetIdentity(SCRATCH_TARGET, []));
		}
		const root = session.root;
		if (root === undefined || !isRootMetadata(root)) return false;
		if (expected.kind === "agent") {
			return (
				session.context === AGENT_CONTEXT &&
				session.workspaceId === expected.workspaceId &&
				session.agentId === expected.agentId &&
				expected.sessionName === agentSessionName(expected.agentId)
			);
		}
		return (
			session.context === WORKSPACE_CONTEXT &&
			session.workspaceId === expected.workspaceId &&
			session.agentId === NO_AGENT &&
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
			if (!sessionMatches(session, identity)) {
				return unknownInspection();
			}
			// Without the configured shell's name there is no way to tell a
			// pane that is only a shell from one running the viewer's work.
			if (this.shellName === undefined) return unknownInspection();
			const { windows, panes } = await this.listWindowsAndPanes(
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
		if (!sessionMatches(existing, identity)) {
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
		if (!sessionMatches(current, identity)) {
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
		const identity = this.targetIdentity(SCRATCH_TARGET, []);
		const sessions = await this.listSessions(socket, cancel, deadline);
		const scratch = sessions.find(
			(session) => session.name === SCRATCH_SESSION,
		);
		if (scratch) {
			if (!sessionMatches(scratch, identity)) {
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
				agentId: NO_AGENT,
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
		if (!created || !sessionMatches(created, identity)) {
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
		const executable = this.executable().path;
		if (this.acceptedVersionOf === executable) return;
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
		this.acceptedVersionOf = executable;
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
				agentId: NO_AGENT,
			};
		}
		if (target.kind === "agent") {
			// No fallback name. An Agent id is unique by construction, so a
			// collision is not a name that is taken — it is a second session
			// claiming to be the same Agent, and renaming around it would hide
			// exactly the thing worth stopping for.
			if (!isUuid(target.agentId) || !isAbsolute(target.root)) {
				throw portFailure("failed");
			}
			return {
				sessionName: agentSessionName(target.agentId),
				root: target.root,
				workspaceId: target.workspaceId,
				context: AGENT_CONTEXT,
				agentId: target.agentId,
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
		const identityFor = (name: string): TargetIdentity => ({
			sessionName: name,
			root,
			workspaceId,
			context: WORKSPACE_CONTEXT,
			agentId: NO_AGENT,
		});
		const expected = (name: string): boolean | undefined => {
			const session = sessions.find((candidate) => candidate.name === name);
			return session ? sessionMatches(session, identityFor(name)) : undefined;
		};
		const shortState = expected(short);
		if (shortState === undefined || shortState) return identityFor(short);
		const longState = expected(long);
		if (longState === undefined || longState) return identityFor(long);
		throw portFailure("conflict");
	}

	/** State a marked session's own options on a session already proven owned. */
	private async applySessionOptions(
		socket: SocketName,
		identity: TargetIdentity,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<void> {
		const options = sessionOptions(identity.context);
		if (options.length === 0) return;
		const args = options.flatMap(([option, value], index) => [
			...(index === 0 ? [] : [";"]),
			"set-option",
			"-t",
			identity.sessionName,
			option,
			value,
		]);
		const output = await this.runTmux(
			socket,
			args,
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) throw portFailure("failed");
	}

	private async createSession(
		socket: SocketName,
		spec: SessionSpec,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<void> {
		if (!existsSync(spec.root) || !statSync(spec.root).isDirectory()) {
			throw portFailure("root_missing");
		}
		if ((await this.markerState(socket, cancel, deadline)) !== "owned") {
			throw portFailure("conflict");
		}
		let canonical: string;
		try {
			canonical = realpathSync(spec.root);
		} catch (failure: unknown) {
			throw portFailure("root_inaccessible", { cause: failure });
		}
		// The root is identity. A path that canonicalises to somewhere else is
		// a different directory, and the session must not claim to be its.
		if (canonical !== spec.root) throw portFailure("conflict");
		// One client queue creates the session and writes its whole marker
		// tuple, so a session can never be observed half-owned. The command,
		// where there is one, is the session's own: tmux runs it in the pane
		// and destroys the session when it exits, which is what makes an Agent
		// row disappear the moment its process does.
		const args = [
			"new-session",
			"-d",
			"-s",
			spec.name,
			"-c",
			spec.root,
			...envArguments(spec.command?.env),
			...(spec.command ? ["--", spec.command.file, ...spec.command.args] : []),
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
			";",
			"set-option",
			"-t",
			spec.name,
			AGENT_ID_OPTION,
			spec.agentId,
			// An Agent's pane starts with no title at all.
			//
			// tmux gives a new pane a default title — the host name — and the
			// Agent's own words arrive later, as the OSC its program prints. So
			// "has this Agent said anything?" used to be answered by comparing
			// against whatever the title happened to be the first time DevHub
			// looked, which is a race with the Agent's startup: read a moment
			// early and the host name is the baseline, so everything the Agent
			// ever sets counts as a word; read a moment late and the Agent's
			// own first title becomes the baseline, so it is silent for the
			// rest of its life. Same Agent, opposite behaviour, decided by
			// timing — and re-decided on every restart.
			//
			// Blanking it here states the baseline instead of guessing it: an
			// empty title is an Agent that has not spoken, and anything else is
			// the Agent speaking. Only Agents, because a workspace's window
			// name is `#{pane_title}` under tmux's `automatic-rename`, and the
			// person's own terminals should keep the names tmux gives them.
			...(spec.context === AGENT_CONTEXT
				? [";", "select-pane", "-t", spec.name, "-T", ""]
				: []),
			// The session's own options join the same sequence, so a session is
			// never observed owned but not yet configured.
			...sessionOptions(spec.context).flatMap(([option, value]) => [
				";",
				"set-option",
				"-t",
				spec.name,
				option,
				value,
			]),
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

	/**
	 * Every session on the socket, with its whole marker tuple, in one command.
	 *
	 * The markers are read by `-F` rather than by a `show-options` per field.
	 * That is not only cheaper — it is the difference between an inventory that
	 * costs one process and one that costs `4N + 1`, which on a cold start with
	 * a dozen sessions is what made a single attach spawn dozens of tmuxes —
	 * but also atomic per session: the five values come out of one expansion of
	 * one session, so a tuple can no longer be assembled from a session that
	 * was replaced between two reads of it.
	 *
	 * The four markers are only ever set on a session, never globally, so the
	 * format expands exactly what `show-options -t <session> -qv` answered. An
	 * unset marker expands to the empty string, and DevHub never writes an
	 * empty marker: empty therefore means absent, as it did before.
	 */
	async listSessions(
		socket: SocketName,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<SessionInfo[]> {
		const output = await this.runTmux(
			socket,
			["list-sessions", "-F", SESSION_FORMAT],
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) {
			if (isNoServerError(output.stderr)) return [];
			throw portFailure("failed");
		}
		const records = parseRecords(output.stdout, 5);
		if (records.length > MAX_SESSIONS) throw portFailure("failed");
		return records.map((record) => ({
			name: record[0],
			context: markerValue(record[1]),
			workspaceId: markerValue(record[2]),
			agentId: agentIdMarker(markerValue(record[3])),
			// Last, because it is the field whose value may itself contain a
			// newline; the record separator is what ends it either way.
			root: markerValue(record[4]),
		}));
	}

	/**
	 * The windows and panes of one session, in one command.
	 *
	 * Two listings share a client queue rather than a process each, and each
	 * record says which listing it came from — the two answers arrive on one
	 * stream and would otherwise be indistinguishable.
	 */
	private async listWindowsAndPanes(
		socket: SocketName,
		session: string,
		cancel: CancellationToken,
		deadline: OperationDeadline,
	): Promise<{ windows: number; panes: string[] }> {
		const output = await this.runTmux(
			socket,
			[
				"list-windows",
				"-t",
				session,
				"-F",
				`${WINDOW_RECORD}${FIELD_SEPARATOR}#{window_id}${RECORD_SEPARATOR}`,
				";",
				"list-panes",
				"-t",
				session,
				"-F",
				`${PANE_RECORD}${FIELD_SEPARATOR}#{pane_current_command}${RECORD_SEPARATOR}`,
			],
			this.contextHome,
			cancel,
			deadline,
		);
		if (!output.success) throw portFailure("failed");
		const records = parseRecords(output.stdout, 2);
		const windows = records.filter(
			(record) => record[0] === WINDOW_RECORD,
		).length;
		const panes = records
			.filter((record) => record[0] === PANE_RECORD)
			.map((record) => record[1]);
		if (windows > MAX_WINDOWS || panes.length > MAX_PANES) {
			throw portFailure("failed");
		}
		if (windows + panes.length !== records.length) {
			throw portFailure("failed");
		}
		return { windows, panes };
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
