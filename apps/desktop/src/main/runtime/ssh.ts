/**
 * A host behind OpenSSH, as a `Runtime`.
 *
 * What is *here* is only the transport and the things that are true of ssh and
 * of nothing else: one client process per operation, multiplexed over one
 * connection per host; the control socket and its 104-byte path arithmetic; the
 * session limit sshd imposes on a multiplexed connection; the forwards added to
 * a master that is already up; and the failures ssh itself has, as opposed to
 * the failures of the command it carried. Everything a machine does when you
 * run POSIX `sh` on it — the login environment, the filesystem operations, the
 * `HEAD` poll, the tmux install, the terminal launcher — is in
 * `remoteShellRuntime.ts`, because none of it knows what carried it.
 *
 * Two consequences of the architecture are worth stating up front, because they
 * are why `RemoteShellRuntime` composes scripts rather than argvs.
 *
 * **`ssh host -- a b c` does not deliver an argv.** OpenSSH joins its remaining
 * words with spaces and hands the string to the remote login shell. So every
 * operation composes a POSIX shell script itself, with `shellQuote`
 * (`quote.ts`) and nothing else, and hands ssh exactly one word.
 *
 * **What is bounded is the local ssh client.** `#send` hands `runBounded` — the
 * same function `LocalRuntime` uses for its children — an ssh command line, so
 * the byte caps, the silence watchdog, the cancellation and the process-group
 * kill are one implementation rather than two that agree for now. Killing the
 * client's process group is also what a deadline *means* across a network: the
 * client dies, the channel closes, and the remote command gets its `SIGHUP`
 * from sshd.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { RollingTally } from "../diagnostics/rollingTally.js";
import { errorWireAt, TypedFailure, withSummary } from "../../model/wire.js";
import {
	OperationDeadline,
	runBounded,
	type CommandOutput,
} from "../terminal/command.js";
import { CancellationToken, portFailure } from "../terminal/ports.js";
import { openPty, type Pty, type PtyFactory } from "../terminal/pty.js";
import {
	REMOTE_REPOSITORY_FOCUS_REFRESH_MIN_INTERVAL_MS,
	remoteReconcileIntervalMs,
} from "./cadence.js";
import type { StreamLaunch } from "./byteStream.js";
import { runtimeConnected } from "./connectivity.js";
import { shellQuote } from "./quote.js";
import {
	describeFailure,
	HEAD_WATCH_POLL_MS,
	lastLine,
	platformName,
	PROBE_LIMITS,
	PROBE_TIMEOUT_MS,
	RemoteShellRuntime,
	remoteScript,
	SCRIPT_MARKER,
} from "./remoteShellRuntime.js";
import {
	isPermanent,
	newConnectionToken,
	permanent,
	parseStartedServer,
	remoteServerPaths,
	sourceBuildRefusal,
	startServerScript,
	unpackServerScript,
	type RehDelivery,
	type RemoteServerEndpoint,
	type RemoteServerHost,
} from "./remoteServer.js";
import type {
	ExecRequest,
	ExecResult,
	PtyRequest,
	Runtime,
	RuntimeCadence,
	RuntimeId,
	RuntimeReading,
} from "./runtime.js";
import type { TmuxDelivery } from "./tmuxDelivery.js";

export {
	errnoFromMessage,
	parseLoginEnvironment,
	remoteScript,
	unsupportedPlatformFailure,
} from "./remoteShellRuntime.js";

/** How many recent round trips a median is taken over. */
const LATENCY_SAMPLES = 16;
const A_MINUTE = 60 * 1000;

/**
 * The longest a control socket's path may be.
 *
 * `sun_path` is 104 bytes on macOS, including the terminating NUL, and OpenSSH
 * fails per-command with `unix_listener: path too long` when the expanded path
 * does not fit. Four bytes of headroom under 104 is the margin, and the check is
 * arithmetic at construction rather than a connection that goes wrong later.
 */
export const CONTROL_PATH_LIMIT = 100;

/**
 * How long OpenSSH expands `%C` to.
 *
 * A SHA-1 of `(local host, remote host, port, user)` in hex. It is a constant
 * because the length of the path is decided before any host is contacted.
 */
const CONTROL_TOKEN_LENGTH = 40;

/** How long the multiplexed connection outlives the last command on it. */
const CONTROL_PERSIST = "10m";

/**
 * How many commands may be in flight through one ControlMaster at once.
 *
 * sshd's `MaxSessions` is 10 per connection by default, and a multiplexed
 * client that asks for an eleventh does not queue — it fails, with
 * `mux_client_request_session: send fds failed`, and OpenSSH exits 255 with
 * nothing on stdout, which is indistinguishable from the host being down. That
 * is what a packaged run measured: a close that failed twice at the terminal
 * step saying `DevHub cannot reach <host>` while the master was alive and
 * DevHub was running 155 execs a minute through it.
 *
 * Six rather than ten, because the master is shared with things DevHub did not
 * count: the reverse-forwarded control socket's channel, the local forward of
 * the remote extension host, the person's own `ssh` if they reuse it, and the
 * pty of every terminal and Agent, each of which holds a session for as long as
 * it is open. The headroom is the point — a limit that is exactly the server's
 * is a limit that is exceeded whenever anything else uses the connection.
 */
const MUX_SESSION_LIMIT = 6;

/**
 * The sessions in flight through one host's ControlMaster.
 *
 * A counting semaphore, and it is here rather than in a general utility
 * because the thing it counts is specific: sshd's per-connection session
 * limit. Two ways in, because there are two kinds of caller and only one of
 * them can wait.
 *
 * `acquire` is for `exec`, which is a promise already and is the flood — the
 * reconcile loop, the repository poll, the head watch. It queues, in order,
 * and that queueing is the whole fix: a bounded number of round trips takes
 * marginally longer and always arrives, where an unbounded number fails and
 * reports the host as unreachable.
 *
 * `take` is for `spawnPty`, which is synchronous and must not wait: a person
 * pressed Ctrl+` and a terminal that queues behind a reconcile round is a
 * terminal that appears to hang. So a pty takes a slot whether or not one is
 * free — it may push the count over the limit — and holds it for its whole
 * life. The effect is that terminals and Agents are always served and execs
 * give way to them, which is the right order: one is a person waiting and the
 * other is a poll.
 */
export class MuxSessions {
	readonly #limit: number;
	readonly #waiting: (() => void)[] = [];
	#held = 0;

	constructor(limit: number = MUX_SESSION_LIMIT) {
		this.#limit = limit;
	}

	/** How many sessions are open through the master right now. */
	get held(): number {
		return this.#held;
	}

	/** How many commands are queued for a slot. */
	get waiting(): number {
		return this.#waiting.length;
	}

	/** A slot, when there is one. Release exactly once, in a `finally`. */
	async acquire(): Promise<() => void> {
		if (this.#held >= this.#limit) {
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		}
		return this.#hold();
	}

	/** A slot now, free or not. See the class comment. */
	take(): () => void {
		return this.#hold();
	}

	#hold(): () => void {
		this.#held += 1;
		let released = false;
		return () => {
			// Idempotent because a pty's exit can be reported more than once and
			// a release that ran twice would let two extra sessions through.
			if (released) return;
			released = true;
			this.#held -= 1;
			this.#waiting.shift()?.();
		};
	}
}

/**
 * Whether ssh's own multiplexing is what refused, rather than the host.
 *
 * OpenSSH's mux client writes these to stderr and exits 255 with no stdout,
 * which `clientFailure` would otherwise read as "the host is unreachable" —
 * and that sentence sent a person to check a host that was answering fine.
 * The strings are the mux client's own (`mux_client_*`), plus the two the
 * master writes when it is going away underneath a command.
 */
export function isMuxFailure(result: ExecResult): boolean {
	if (result.code !== 255 || result.stdout.byteLength > 0) return false;
	const said = result.stderr.toString("utf8").toLowerCase();
	return (
		said.includes("mux_client") ||
		said.includes("control socket connect") ||
		said.includes("multiplexing") ||
		said.includes("session open refused")
	);
}

/** A minute between repository polls, remote or not: the number is the same. */
const REPOSITORY_POLL_MS = 60 * 1000;

export interface SshRuntimeOptions {
	/** The host as a person wrote it: usually an alias from `~/.ssh/config`. */
	readonly host: string;
	/**
	 * The directory the control socket is created under, already length-checked.
	 *
	 * Passed in rather than derived here because it is a property of the DevHub
	 * profile, not of the host, and because a test must be able to name a
	 * directory without one existing.
	 */
	readonly controlDirectory: string;
	/** The ssh client to run. A path, or a name to find on `PATH`. */
	readonly sshPath?: string;
	/** For tests: the pty factory, defaulting to the real one. */
	readonly ptyFactory?: PtyFactory;
	/** For tests: the environment the local ssh client starts with. */
	readonly localEnvironment?: Readonly<Record<string, string | undefined>>;
	/**
	 * Where the tmux DevHub installs on this host comes from.
	 *
	 * Injected rather than read from `product.json` here, so that this module
	 * stays importable by things that have no app around them — the PTY test
	 * program among them — for the same reason the control directory is.
	 */
	readonly tmux?: TmuxDelivery;
	/** For tests: how a local port for a `-L` forward is picked. */
	readonly freePort?: () => Promise<number>;
}

/**
 * Where the control socket for a profile lives, or why it cannot.
 *
 * `<userData>/ssh/%C` is the first choice, because every other resource DevHub
 * keys on the profile and a second DevHub must not adopt the first one's
 * connection. On macOS that is around a hundred characters under
 * `~/Library/Application Support/…`, which is under the limit but not
 * comfortably, so `~/.devhub/ssh/%C` is the named fallback — short on any
 * machine. If even that does not fit, this throws and says both numbers,
 * because the alternative is `ssh` failing on every command with a message
 * about a listener nobody asked for.
 */
export function chooseControlDirectory(
	userDataDirectory: string,
	home: string,
): string {
	const preferred = join(userDataDirectory, "ssh");
	if (fitsControlPath(preferred)) return preferred;
	const fallback = join(home, ".devhub", "ssh", profileTag(userDataDirectory));
	if (fitsControlPath(fallback)) return fallback;
	throw new Error(
		`no ssh control socket fits: ${controlPathOf(preferred)} and ` +
			`${controlPathOf(fallback)} are both longer than ${String(
				CONTROL_PATH_LIMIT,
			)} bytes`,
	);
}

/**
 * Which DevHub a fallback control directory belongs to.
 *
 * `%C` hashes the *connection* — local host, remote host, port, user — and
 * nothing about DevHub, so two profiles reaching the same host expand to the
 * same socket name. Under `<userData>/ssh` that is harmless, because the
 * directory is already the profile's; under the shared `~/.devhub/ssh` it
 * meant a second DevHub adopting the first one's master, which is the one
 * thing the preferred path exists to prevent. So the fallback carries the
 * profile too — eight hex characters of the user data directory, because the
 * whole reason this branch exists is that the full path was too long.
 */
function profileTag(userDataDirectory: string): string {
	return createHash("sha256")
		.update(userDataDirectory)
		.digest("hex")
		.slice(0, 8);
}

/** The path OpenSSH will actually bind, with `%C` at its expanded length. */
export function controlPathOf(directory: string): string {
	return join(directory, "C".repeat(CONTROL_TOKEN_LENGTH));
}

function fitsControlPath(directory: string): boolean {
	return (
		Buffer.byteLength(controlPathOf(directory), "utf8") <= CONTROL_PATH_LIMIT
	);
}

/**
 * The options DevHub sets on every ssh it runs, and why each one is here.
 *
 * `-F` is deliberately absent: the default `~/.ssh/config` is exactly what must
 * be read, because the host is usually an alias and not a hostname.
 * `StrictHostKeyChecking` is deliberately absent too — that is the person's
 * decision, and a runtime that quietly set it to `no` would be answering a
 * security question on their behalf. `ProxyCommand` and `ProxyJump` are left
 * alone because they are how a lot of real hosts are reached.
 *
 * `BatchMode=yes` is not a hardening flag, it is load-bearing: DevHub's own ssh
 * has no pane to prompt in, so it must fail rather than sit at a password
 * prompt no one can see.
 */
export function sshOptionArgv(
	// `undefined` is the one-off connection: no master, and said out loud
	// rather than left out, because a `~/.ssh/config` that sets `ControlMaster`
	// would otherwise put DevHub back on the master this call exists to avoid.
	// See `#run`'s mux retry.
	controlDirectory: string | undefined,
): string[] {
	return [
		"-o",
		"BatchMode=yes",
		...(controlDirectory === undefined
			? ["-o", "ControlMaster=no", "-o", "ControlPath=none"]
			: [
					"-o",
					"ControlMaster=auto",
					"-o",
					`ControlPath=${join(controlDirectory, "%C")}`,
					"-o",
					`ControlPersist=${CONTROL_PERSIST}`,
				]),
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"ConnectTimeout=10",
	];
}

/**
 * The sentence a host DevHub cannot log into gets, composed once.
 *
 * It is one sentence in one place because the state it describes is a real and
 * confusing one — the editor connects, because the SSH extension has a window
 * to ask for a password in, and git, terminals and Agents do not — and a reader
 * who meets it twice in two wordings will conclude they are two problems.
 */
export function unauthenticatedFailure(host: string): TypedFailure {
	// Permanent: DevHub's ssh runs with `BatchMode=yes` and has no pane to
	// prompt in, so a second attempt asks the same question of the same closed
	// mouth. What changes it is a key, which is a thing a person does.
	return permanent(
		new TypedFailure(
			withSummary(
				errorWireAt("workspace_unavailable"),
				`DevHub cannot run commands on ${host} without a password. Set up a ` +
					`key for ${host} — ssh-copy-id ${host} — and reopen the workspace.`,
			),
		),
	);
}

export function hostKeyFailure(host: string): TypedFailure {
	// Permanent, for the same reason: accepting a host key is something a
	// person does in a terminal, not something the next attempt does.
	return permanent(
		new TypedFailure(
			withSummary(
				errorWireAt("workspace_unavailable"),
				`The host key for ${host} is not known to DevHub. Run ssh ${host} ` +
					`once in a terminal to accept it.`,
			),
		),
	);
}

export function unreachableFailure(host: string, stderr: string): TypedFailure {
	const said = lastLine(stderr);
	return new TypedFailure(
		withSummary(
			errorWireAt("workspace_unavailable"),
			`DevHub cannot reach ${host}${said.length === 0 ? "" : `: ${said}`}.`,
		),
	);
}

/**
 * What ssh itself said went wrong, as opposed to what the command said.
 *
 * ssh exits 255 for its own failures, and a remote command may also exit 255,
 * so the code alone is not the test: the client's failures are the ones that
 * produced no output at all and wrote something recognisable to stderr. Getting
 * this wrong in the safe direction means a strange remote exit status is
 * reported as a strange remote exit status, which is true.
 */
function clientFailure(
	host: string,
	result: ExecResult,
): TypedFailure | undefined {
	if (result.code !== 255 || result.stdout.byteLength > 0) return undefined;
	const stderr = result.stderr.toString("utf8");
	if (stderr.trim().length === 0) return undefined;
	const text = stderr.toLowerCase();
	if (
		text.includes("permission denied") ||
		text.includes("no supported authentication") ||
		text.includes("too many authentication failures")
	) {
		return unauthenticatedFailure(host);
	}
	if (
		text.includes("host key verification failed") ||
		text.includes("remote host identification has changed")
	) {
		return hostKeyFailure(host);
	}
	return unreachableFailure(host, stderr);
}

/**
 * A `-L` forward DevHub is holding open on this host's ControlMaster.
 *
 * It is a *held* thing and not a fact that was true once, which is the whole
 * reason there is a registry: the forward dies with the master, `resumed()`
 * exists to kill the master, and VS Code asks for the endpoint again on every
 * reconnect. So each of those three has to be able to see the other two.
 */
interface HeldForward {
	readonly port: number;
	readonly remotePath: string;
}

/** How long a probe of a local forward waits before calling it dead. */
const FORWARD_PROBE_MS = 3000;

export class SshRuntime
	extends RemoteShellRuntime
	implements Runtime, RemoteServerHost
{
	readonly id: RuntimeId;
	readonly where: string;

	readonly #host: string;
	readonly #controlDirectory: string;
	readonly #sshPath: string;
	readonly #ptyFactory: PtyFactory;
	readonly #localEnvironment: Readonly<Record<string, string | undefined>>;
	readonly #tmuxDelivery: TmuxDelivery | undefined;
	readonly #freePort: () => Promise<number>;

	readonly #latencies: number[] = [];
	/**
	 * Execs of the last minute, counted rather than listed: a rate is a count,
	 * and a list of every exec since launch is what this used to be. See
	 * `diagnostics/rollingTally.ts`.
	 */
	readonly #recentExecs = new RollingTally(A_MINUTE);
	#connected = false;
	#masterPid: number | undefined;
	#askedForMasterPid = false;
	/** Sessions in flight through this host's ControlMaster. */
	readonly #sessions = new MuxSessions();
	/** How many commands the master refused and a one-off connection ran. */
	#muxFallbacks = 0;
	/** The `-L` forwards this runtime is holding, by their far end's path. */
	readonly #forwards = new Map<string, HeldForward>();
	#server: Promise<RemoteServerEndpoint> | undefined;
	#controlDirectoryMade: Promise<unknown> | undefined;

	constructor(options: SshRuntimeOptions) {
		super();
		this.#host = options.host;
		this.id = `ssh:${options.host}`;
		this.where = ` on ${options.host}`;
		this.#controlDirectory = options.controlDirectory;
		this.#sshPath = options.sshPath ?? "ssh";
		this.#ptyFactory = options.ptyFactory ?? openPty;
		this.#localEnvironment = options.localEnvironment ?? process.env;
		this.#tmuxDelivery = options.tmux;
		this.#freePort = options.freePort ?? freeLocalPort;
		if (!fitsControlPath(this.#controlDirectory)) {
			throw new Error(
				`the ssh control socket ${controlPathOf(this.#controlDirectory)} is ` +
					`longer than the ${String(CONTROL_PATH_LIMIT)} bytes a unix socket ` +
					`path may be`,
			);
		}
	}

	protected override get machineName(): string {
		return this.#host;
	}

	get cadence(): RuntimeCadence {
		return {
			// A number rather than a constant, because the constant that is
			// right for a fork on this Mac is an ssh flood on a host across an
			// ocean. The rule itself is `cadence.ts`'s and not this file's: the
			// reconciler's tests assert the bound it states, and two copies of
			// one line of arithmetic is one copy that will drift.
			reconcileIntervalMs: remoteReconcileIntervalMs(this.#medianRoundTripMs()),
			repositoryPollMs: REPOSITORY_POLL_MS,
			repositoryFocusRefreshMinIntervalMs:
				REMOTE_REPOSITORY_FOCUS_REFRESH_MIN_INTERVAL_MS,
			headWatchPollMs: HEAD_WATCH_POLL_MS,
		};
	}

	/**
	 * Where this host's tmux comes from — an invariant, not a case.
	 *
	 * `runtimeFor` is the only thing that builds an `SshRuntime` and it always
	 * passes one, so a runtime without one is a construction bug and nothing a
	 * host did. It throws rather than falling back to the path it *would* have
	 * been given: a guessed `~/.devhub-server/tmux` is a second statement of a
	 * product fact, and the failure it produces would arrive as "that host has
	 * no tmux" — a sentence about the wrong machine entirely.
	 */
	protected override delivery(): TmuxDelivery {
		const delivery = this.#tmuxDelivery;
		if (delivery === undefined) {
			throw new Error(
				`the runtime for ${this.#host} was built without a tmux delivery, ` +
					`which is a bug in DevHub and not a fact about that host`,
			);
		}
		return delivery;
	}

	/**
	 * One ssh, through the master or beside it.
	 *
	 * The only difference between the two is the option set, which is why they
	 * are one function: a retry that composed its own argv would be a second
	 * place the remote command line is built, and the two would drift.
	 */
	#send(
		controlDirectory: string | undefined,
		script: string,
		request: ExecRequest,
	): Promise<ExecResult> {
		return runBounded(
			{
				file: this.#sshPath,
				args: [...sshOptionArgv(controlDirectory), this.#host, "--", script],
				// The client's own working directory is nobody's business: the
				// caller's `cwd` is a `cd` in the script, on the other machine.
				cwd: undefined,
				env: this.#localEnvironment,
			},
			request.deadline,
			request.cancel,
			request.limits,
			request.stdin,
		);
	}

	protected override async run(request: ExecRequest): Promise<ExecResult> {
		const script = remoteScript(request);
		// The remote fork is invisible to `getAppMetrics`, so the count is the
		// only place it exists. Named with the host, so a reading says where.
		activityCounters.record(
			COUNTER.process(`${this.id}/${basenameOf(request.argv[0] ?? "")}`),
		);
		await this.#ensureControlDirectory();
		const startedAt = Date.now();
		this.#recentExecs.record();
		let result: ExecResult;
		// Queued behind the other commands on this master, because sshd counts
		// sessions per connection and refuses the one over its limit. See
		// `MuxSessions`.
		const release = await this.#sessions.acquire();
		try {
			result = await this.#send(this.#controlDirectory, script, request);
		} catch (failure: unknown) {
			this.#record(startedAt);
			this.#connected = false;
			this.lastFailure = describeFailure(failure);
			throw failure;
		} finally {
			release();
		}
		// The master refused, not the host. One more try, on a connection of its
		// own, so that a limit DevHub cannot see from here costs a slower command
		// rather than a workspace that reports its machine as down. Once: a
		// second failure is a fact about the connection and belongs to the
		// caller.
		if (isMuxFailure(result)) {
			this.#muxFallbacks += 1;
			activityCounters.record(COUNTER.sshMuxFallback);
			console.warn(
				`[devhub] ${this.id}: the ssh ControlMaster refused a session ` +
					`(${lastLine(result.stderr.toString("utf8"))}); retrying without ` +
					`it`,
			);
			try {
				result = await this.#send(undefined, script, request);
			} catch (failure: unknown) {
				this.#record(startedAt);
				this.#connected = false;
				this.lastFailure = describeFailure(failure);
				throw failure;
			}
		}
		this.#record(startedAt);
		const refused = clientFailure(this.#host, result);
		if (refused) {
			this.#connected = false;
			this.lastFailure = refused.message;
			throw refused;
		}
		this.#markConnected();
		// A program that is not there is `ENOENT` locally and a marker here; both
		// arrive at the caller as `unavailable`, which is the point of having a
		// contract rather than two runtimes that mostly agree.
		if (result.code === 127) {
			const stderr = result.stderr.toString("utf8");
			if (stderr.includes(SCRIPT_MARKER)) {
				throw portFailure("unavailable", { detail: lastLine(stderr) });
			}
		}
		this.#learnMasterPid();
		return result;
	}

	/**
	 * A pseudo-terminal on the other machine.
	 *
	 * The same `node-pty` that runs a local tmux client, running an ssh client
	 * instead — so resize, data and exit are the same three events they were, and
	 * everything above `Pty` neither knows nor needs to know which happened.
	 * `-tt` forces a tty on the remote side even though ssh's own stdin is
	 * already one; without it a non-interactive remote command gets no pty and
	 * tmux refuses to attach.
	 */
	spawnPty(request: PtyRequest): Pty {
		const login = this.login;
		if (login === undefined) {
			throw new Error(
				`a pseudo-terminal was asked for on ${this.#host} before DevHub had ` +
					`read that machine's login environment, so the program in it would ` +
					`run without the PATH the person's own shell has`,
			);
		}
		const script = remoteScript({
			argv: [request.file, ...request.args],
			cwd: request.cwd,
			env: { ...login, ...request.env },
		});
		// A pty holds a session for as long as it is open, so it holds a slot
		// for as long as it is open. It takes one without waiting — see
		// `MuxSessions` — because a person pressed a key and an exec did not.
		const release = this.#sessions.take();
		const pty = this.#ptyFactory({
			file: this.#sshPath,
			args: [
				...sshOptionArgv(this.#controlDirectory),
				"-tt",
				this.#host,
				"--",
				script,
			],
			// The ssh client runs here; the remote `cd` is in the script.
			cwd: homedir(),
			cols: request.cols,
			rows: request.rows,
			pixelWidth: request.pixelWidth,
			pixelHeight: request.pixelHeight,
			env: this.#localEnvironment,
		});
		pty.onExit(release);
		return pty;
	}

	/**
	 * A long-lived remote command over a session of this host's master.
	 *
	 * `-T` where `spawnPty` has `-tt`, and that is the whole difference: no
	 * tty on the far side, so the bytes arrive as they were written. The
	 * session holds a slot for its whole life and takes it without waiting,
	 * for the reason a pty does (`MuxSessions`): a stream is somebody reading
	 * an Agent, and a poll can give way to it.
	 *
	 * A refusal is read with `clientFailure`, so a stream that could not reach
	 * the host says the same sentence an `exec` would have.
	 */
	protected override async streamLaunch(script: string): Promise<StreamLaunch> {
		await this.#ensureControlDirectory();
		activityCounters.record(COUNTER.process(`${this.id}/stream`));
		const release = this.#sessions.take();
		return {
			file: this.#sshPath,
			args: [
				...sshOptionArgv(this.#controlDirectory),
				"-T",
				this.#host,
				"--",
				script,
			],
			// The client's own working directory is nobody's business: the
			// caller's `cwd` is a `cd` in the script, on the other machine.
			cwd: undefined,
			env: this.#localEnvironment,
			release,
			refusal: (end) =>
				clientFailure(this.#host, { ...end, stdout: Buffer.alloc(0) }),
		};
	}

	/**
	 * The remote extension host on this host, and a local port that reaches it.
	 *
	 * Four steps, and the order is the whole of it: install the server if it is
	 * not there, start it (or adopt the one that is running) and read its token
	 * back out of its own file, forward its socket to a local port, and check
	 * that the port answers. The check is not ceremony — `ssh -O forward` can
	 * report success and bind nothing, which is the same failure
	 * `publishControlSocket` learned the hard way about `-R`.
	 *
	 * Cached, and that is load-bearing rather than thrift. VS Code calls
	 * `resolve()` again on every reconnect, so without this a laptop lid closed
	 * and opened would restart the extension host on the far machine, and every
	 * language server and every extension's state with it. What is cached is
	 * *verified* on each ask: the held forward is probed, and a forward that no
	 * longer answers is cancelled and made again rather than handed back.
	 */
	async remoteServer(delivery: RehDelivery): Promise<RemoteServerEndpoint> {
		const held = this.#server;
		if (held !== undefined) {
			const endpoint = await held.catch(() => undefined);
			if (endpoint !== undefined && (await this.#portAnswers(endpoint.port))) {
				return endpoint;
			}
			// It was ours and it is not answering, so it is ours to take away:
			// leaving it registered would make `resumed()` go on refusing to drop
			// a master that is already a corpse.
			await this.#dropForwards();
			this.#server = undefined;
		}
		const pending = this.#openRemoteServer(delivery);
		pending.catch(() => {
			if (this.#server === pending) this.#server = undefined;
		});
		this.#server = pending;
		return pending;
	}

	async #openRemoteServer(
		delivery: RehDelivery,
	): Promise<RemoteServerEndpoint> {
		const commit = delivery.commit;
		// Permanent for as long as this DevHub is running: a source build cannot
		// be given a commit, so there is nothing a later attempt would find.
		if (commit === undefined) {
			throw permanent(new Error(sourceBuildRefusal(this.#host)));
		}
		const { home, platform, architecture, login } = await this.describeRemote();
		const paths = remoteServerPaths({
			home,
			dataFolderName: delivery.dataFolderName,
			applicationName: delivery.applicationName,
			commit,
		});
		await this.#installServer(delivery, paths, platform, architecture);
		const started = await this.sh(startServerScript(paths), {
			stdin: Buffer.from(newConnectionToken(), "utf8"),
		});
		if (started.code !== 0) {
			throw new Error(
				`DevHub could not start the remote extension host on ${this.#host}: ` +
					`${lastLine(started.stderr.toString("utf8"))}`,
			);
		}
		const answer = parseStartedServer(started.stdout.toString("utf8"));
		if (answer === undefined) {
			throw new Error(
				`DevHub started the remote extension host on ${this.#host} but could ` +
					`not read the socket and token back from it, so there is nothing ` +
					`to connect to`,
			);
		}
		const port = await this.#forward(answer.socket);
		return {
			port,
			connectionToken: answer.token,
			// Only what the person's own ssh config already forwards. DevHub
			// opens no agent channel of its own: an agent socket is a key, and
			// forwarding one is the person's decision to make in their config
			// rather than DevHub's to make on their behalf.
			extensionHostEnv:
				login["SSH_AUTH_SOCK"] === undefined
					? undefined
					: { SSH_AUTH_SOCK: login["SSH_AUTH_SOCK"] },
		};
	}

	/**
	 * The server tarball, fetched here and unpacked there — once.
	 *
	 * Idempotent by the question it starts with, exactly as the tmux install is:
	 * a `bin/<commit>/bin/<serverApplicationName>` that is executable is an
	 * install that has happened, whether this DevHub did it, an older one did,
	 * or somebody unpacked the tarball by hand (`docs/remote-ssh.md` tells them
	 * how, for a host with no route to the release).
	 */
	async #installServer(
		delivery: RehDelivery,
		paths: ReturnType<typeof remoteServerPaths>,
		platform: string,
		architecture: string,
	): Promise<void> {
		const present = await this.sh(`test -x ${shellQuote(paths.server)}`);
		if (present.code === 0) return;
		const target = `${platformName(platform)}-${architecture}`;
		let tarball;
		try {
			tarball = await delivery.tarball(target);
		} catch (failure: unknown) {
			// The delivery knows whether what refused was the release (permanent)
			// or this Mac's network (not), and that opinion has to survive being
			// wrapped in a sentence that names the host.
			const wrapped = new Error(
				`DevHub could not get the remote extension host it installs on ` +
					`${this.#host} (${target}): ${describeFailure(failure)}`,
				{ cause: failure },
			);
			throw isPermanent(failure) ? permanent(wrapped) : wrapped;
		}
		const unpack = await this.sh(
			unpackServerScript(paths, tarball.topLevelDirectory),
			{ stdin: tarball.bytes },
		);
		if (unpack.code !== 0) {
			throw new Error(
				`DevHub could not unpack the remote extension host into ` +
					`${paths.install} on ${this.#host}: ` +
					`${lastLine(unpack.stderr.toString("utf8"))}`,
			);
		}
		const runnable = await this.sh(`test -x ${shellQuote(paths.server)}`);
		if (runnable.code !== 0) {
			// Permanent: the bytes that arrived are not the ones this DevHub is
			// built to unpack, and the next attempt unpacks the same bytes.
			throw permanent(
				new Error(
					`DevHub unpacked the remote extension host into ${paths.install} on ` +
						`${this.#host}, but ${paths.server} is not there to run — the ` +
						`tarball that came out is not the one this DevHub expects`,
				),
			);
		}
	}

	/**
	 * A local port that reaches a socket on the host, made and checked.
	 *
	 * `ssh -O forward -L <port>:<remote socket>` on the master that is already
	 * up, so no second connection and no reconnect. `-L` to a *unix socket* on
	 * the far end is OpenSSH's own (6.7 and later), and it is why nothing here
	 * has to scrape a port number out of the server's log: the socket's name is
	 * one DevHub chose.
	 *
	 * Cancel-first for the same reason `publishControlSocket` cancels first: a
	 * ControlMaster outlives the DevHub that started it, and OpenSSH answers a
	 * second `-O forward` for a pair it already forwards with success while
	 * binding nothing. The pair is the forward's *name* to OpenSSH, so the
	 * cancel has to name it identically or it cancels nothing and reports that
	 * it has.
	 */
	async #forward(remoteSocketPath: string): Promise<number> {
		const port = await this.#freePort();
		const spec = `${String(port)}:${remoteSocketPath}`;
		await this.#mux("cancel", "-L", spec);
		const forwarded = await this.#mux("forward", "-L", spec);
		if (forwarded.code !== 0) {
			const said = lastLine(forwarded.stderr.toString("utf8"));
			this.lastFailure = said;
			throw new Error(
				`DevHub could not forward ${remoteSocketPath} on ${this.#host} to a ` +
					`local port: ${said}`,
			);
		}
		if (!(await this.#portAnswers(port))) {
			await this.#mux("cancel", "-L", spec);
			const said =
				`ssh reported the forward of ${remoteSocketPath} on ${this.#host} ` +
				`succeeded, but nothing answers on 127.0.0.1:${String(port)}`;
			this.lastFailure = said;
			throw new Error(said);
		}
		this.#forwards.set(remoteSocketPath, {
			port,
			remotePath: remoteSocketPath,
		});
		return port;
	}

	/** Whether something on this Mac answers on a forwarded port. */
	async #portAnswers(port: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const done = (answer: boolean, socket: Socket): void => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolve(answer);
			};
			const socket = connect({ host: "127.0.0.1", port });
			socket.setTimeout(FORWARD_PROBE_MS);
			socket.on("connect", () => {
				done(true, socket);
			});
			socket.on("timeout", () => {
				done(false, socket);
			});
			socket.on("error", () => {
				done(false, socket);
			});
		});
	}

	/** Take away every forward this runtime is holding, and forget them. */
	async #dropForwards(): Promise<void> {
		const held = [...this.#forwards.values()];
		this.#forwards.clear();
		for (const forward of held) {
			await this.#mux(
				"cancel",
				"-L",
				`${String(forward.port)}:${forward.remotePath}`,
			).catch(() => undefined);
		}
	}

	/**
	 * DevHub's control socket, made answerable on the host.
	 *
	 * `ssh -O forward -R <remote>:<local>` adds the forward to the master that
	 * is already up, so no second connection and no reconnect: the socket
	 * appears on the host and every connection to it comes back down this one.
	 *
	 * The `rm -f` first is not tidying. A unix socket left behind by a previous
	 * DevHub is a *file*, and sshd will not bind over one unless the host's
	 * sshd was configured with `StreamLocalBindUnlink yes` — which is the
	 * host's business and not something DevHub may assume or set. Removing it
	 * from this side needs neither, and it is safe for exactly the reason the
	 * name was chosen: the name is a digest of this DevHub's own socket path,
	 * so the file being removed is this DevHub's and nobody else's.
	 *
	 * The `-O cancel` first is what makes a restart work. A ControlMaster
	 * outlives the DevHub that started it — that is what a master is for — so a
	 * DevHub that comes back to a live one finds the *previous* DevHub's
	 * forward of this same remote path still registered on it, pointing at a
	 * local socket nothing is behind any more. OpenSSH answers a second
	 * `-O forward` for a path it already forwards with success and binds
	 * nothing, so the `test -S` below failed, the window came up with no
	 * launcher, and the only way back was to kill the master by hand.
	 *
	 * The `test -S` afterwards is the point of the whole function. `-O forward`
	 * can report success and leave nothing bound, and a launcher pointed at a
	 * socket that is not there is precisely the silent failure this file exists
	 * to prevent. So the forward is *checked*, and a check that fails is a
	 * sentence — recorded here, so `devhub --metrics` says it, and returned, so
	 * whoever asked for the launcher can say it too. The launcher is still
	 * written: run from the host it says "DevHub is not listening on <socket>",
	 * which is the same fact in the place a person is actually looking.
	 */
	protected override async publishControlSocket(
		remoteSocketPath: string,
		localSocketPath: string,
	): Promise<string | undefined> {
		const spec = `${remoteSocketPath}:${localSocketPath}`;
		await this.#mux("cancel", "-R", spec);
		const removed = await this.sh(
			`exec rm -f -- ${shellQuote(remoteSocketPath)}`,
		);
		if (removed.code !== 0) {
			return `${remoteSocketPath} could not be removed on ${this.#host}, so DevHub's control socket could not be forwarded there: ${lastLine(removed.stderr.toString("utf8"))}`;
		}
		const forwarded = await this.#mux("forward", "-R", spec);
		if (forwarded.code !== 0) {
			const said = lastLine(forwarded.stderr.toString("utf8"));
			this.lastFailure = said;
			return `DevHub's control socket could not be forwarded to ${remoteSocketPath} on ${this.#host}: ${said}`;
		}
		const bound = await this.sh(`test -S ${shellQuote(remoteSocketPath)}`);
		if (bound.code !== 0) {
			const said = `ssh reported the forward of ${remoteSocketPath} on ${this.#host} succeeded, but nothing is listening there`;
			this.lastFailure = said;
			return said;
		}
		return undefined;
	}

	/**
	 * One forward request to the ControlMaster: `forward`, or `cancel`.
	 *
	 * The direction and the pair are the forward's *name* to OpenSSH, so a
	 * cancel that named either differently would cancel nothing and report that
	 * it had. One function for both directions and both operations, because
	 * four places that compose this argv are four places for the name to drift.
	 */
	#mux(
		operation: "forward" | "cancel",
		direction: "-R" | "-L",
		spec: string,
	): Promise<CommandOutput> {
		return runBounded(
			{
				file: this.#sshPath,
				args: [
					...sshOptionArgv(this.#controlDirectory),
					"-O",
					operation,
					direction,
					spec,
					this.#host,
				],
				cwd: undefined,
				env: this.#localEnvironment,
			},
			OperationDeadline.in(PROBE_TIMEOUT_MS),
			new CancellationToken(),
			PROBE_LIMITS,
		);
	}

	reading(): RuntimeReading {
		return {
			id: this.id,
			connected: this.#connected,
			masterPid: this.#masterPid,
			medianRoundTripMs: this.#medianRoundTripMs(),
			reconcileIntervalMs: this.cadence.reconcileIntervalMs,
			execsLastMinute: this.#recentExecs.count(),
			muxSessionsHeld: this.#sessions.held,
			muxSessionsWaiting: this.#sessions.waiting,
			muxFallbacks: this.#muxFallbacks,
			// Names and never values. A reading is written into a log and pasted
			// into an issue, and a person's login environment is where their
			// tokens are — but "which variables DevHub is putting on every remote
			// command" is exactly the question a wrong `PATH` or a missing
			// `LANG` raises, and it is answerable without reading one of them.
			loginEnvironmentNames: Object.keys(this.login ?? {}).sort(),
			lastFailure: this.lastFailure,
		};
	}

	/**
	 * The Mac woke up, so the ControlMaster is suspect until proven otherwise.
	 *
	 * A master that slept through a suspend usually has a dead TCP connection
	 * under a live local socket: `ssh` happily hands new commands to it and
	 * every one of them hangs and then fails, for as long as `ControlPersist`
	 * keeps the corpse around — which is minutes of rounds that cannot work,
	 * and (before `machineConditions`) minutes of a notice flapping about it.
	 * Nothing DevHub can ask distinguishes that master from a healthy one
	 * without paying a round trip, so it is not asked: the master is dropped,
	 * and the next command builds a new one, which costs one connection on a
	 * machine DevHub is about to talk to anyway.
	 *
	 * Only when nothing is in flight through it, and a held `-L` forward counts.
	 * Killing a master with an attached pty under it would take a person's
	 * terminal down to save a connection — the wrong trade every time — and a
	 * busy master is a master that is demonstrably working. A forward is the
	 * same kind of thing said about a different channel: a workbench is talking
	 * down it, and the ordering is real — a power event delivered *after* the
	 * workbench has already reconnected through a brand-new forward would
	 * otherwise destroy the very thing the reconnection just built. A forward
	 * that has stopped answering is not held for long: `remoteServer` probes it
	 * on the next `resolve()` and cancels it when it does not answer, which is
	 * what lets this go back to dropping the master.
	 */
	resumed(): void {
		if (this.#sessions.held > 0 || this.#sessions.waiting > 0) return;
		if (this.#forwards.size > 0) return;
		this.#connected = false;
		this.#masterPid = undefined;
		this.#askedForMasterPid = false;
		void this.#exitMaster().catch((failure: unknown) => {
			// No master to exit is the state this call wants, not a failure; a
			// master that refused to go is a line in `devhub --metrics`.
			this.lastFailure = describeFailure(failure);
		});
	}

	#markConnected(): void {
		const was = this.#connected;
		this.#connected = true;
		if (!was) runtimeConnected(this.id);
	}

	/**
	 * Let go of the connection.
	 *
	 * `ssh -O exit` rather than waiting out `ControlPersist`, because a host no
	 * Workspace uses any more should not be holding a socket open for ten
	 * minutes. No master is not a failure — it is the state this call exists to
	 * reach — so only a master that refused to exit is reported.
	 */
	async dispose(): Promise<void> {
		this.#connected = false;
		this.#masterPid = undefined;
		// Read again on the next connection rather than remembered across one: a
		// person who fixes their `~/.profile` and reconnects has fixed it.
		this.forgetRemote();
		this.forgetLauncher();
		await this.#dropForwards();
		this.#server = undefined;
		const result = await this.#exitMaster();
		const said = result.stderr.toString("utf8");
		if (result.code !== 0 && !/no such file|no controlpath/iu.test(said)) {
			this.lastFailure = lastLine(said);
		}
	}

	#exitMaster(): Promise<CommandOutput> {
		return runBounded(
			{
				file: this.#sshPath,
				args: [
					...sshOptionArgv(this.#controlDirectory),
					"-O",
					"exit",
					this.#host,
				],
				cwd: undefined,
				env: this.#localEnvironment,
			},
			OperationDeadline.in(PROBE_TIMEOUT_MS),
			new CancellationToken(),
			PROBE_LIMITS,
		);
	}

	/**
	 * The multiplexed connection's pid, asked once.
	 *
	 * `ssh -O check` answers "Master running (pid=N)" without a round trip to the
	 * host — it talks to the local socket — which is why it can be afforded at
	 * all, and why it is not used to measure latency: it never leaves this Mac.
	 * The round-trip figure comes from the execs themselves, which do.
	 */
	#learnMasterPid(): void {
		if (this.#askedForMasterPid) return;
		this.#askedForMasterPid = true;
		void runBounded(
			{
				file: this.#sshPath,
				args: [
					...sshOptionArgv(this.#controlDirectory),
					"-O",
					"check",
					this.#host,
				],
				cwd: undefined,
				env: this.#localEnvironment,
			},
			OperationDeadline.in(PROBE_TIMEOUT_MS),
			new CancellationToken(),
			PROBE_LIMITS,
		)
			.then((result) => {
				const said =
					result.stdout.toString("utf8") + result.stderr.toString("utf8");
				const pid = /pid=(\d+)/u.exec(said)?.[1];
				this.#masterPid = pid === undefined ? undefined : Number(pid);
			})
			.catch((failure: unknown) => {
				// Not a swallow: the pid is a line in `devhub --metrics`, and the
				// reading it belongs to has a field for what went wrong.
				this.lastFailure = describeFailure(failure);
			});
	}

	/**
	 * The directory the control socket is bound in, made once, 0700.
	 *
	 * A control socket is a capability: anyone who can connect to it can run
	 * commands on the host as this user, without a key. So the directory is the
	 * owner's and nobody else's, and it is created before the first ssh rather
	 * than left to `ssh`, which would refuse with a message about a listener.
	 */
	#ensureControlDirectory(): Promise<unknown> {
		this.#controlDirectoryMade ??= mkdir(this.#controlDirectory, {
			recursive: true,
			mode: 0o700,
		});
		return this.#controlDirectoryMade;
	}

	#medianRoundTripMs(): number {
		const sorted = [...this.#latencies].sort((left, right) => left - right);
		return sorted[Math.floor(sorted.length / 2)] ?? 0;
	}

	#record(startedAt: number): void {
		this.#latencies.push(Date.now() - startedAt);
		if (this.#latencies.length > LATENCY_SAMPLES) this.#latencies.shift();
	}
}

/**
 * A local port nothing is on, as of a moment ago.
 *
 * The kernel is asked for one — bind to port 0, read the number, let it go —
 * rather than a number being picked out of a range and hoped for. There is a
 * window between letting it go and `ssh -O forward` taking it, and nothing
 * closes that window: SO_REUSEADDR means a port in `TIME_WAIT` is handed out,
 * and holding the socket open until ssh binds would make it the thing ssh
 * collides with. What makes it safe is not the window being small but the
 * check afterwards — `#forward` connects to the port it was given, and a
 * forward that did not bind is a failure with a sentence rather than a
 * workbench dialling something else.
 */
function freeLocalPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("the kernel did not name the port it just bound"));
				return;
			}
			const { port } = address;
			server.close(() => {
				resolve(port);
			});
		});
	});
}

function basenameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
