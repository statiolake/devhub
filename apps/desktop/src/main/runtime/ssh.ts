/**
 * Another machine, behind the same `Runtime` interface.
 *
 * Everything here is one OpenSSH client process per operation, multiplexed over
 * one connection per host. That is the whole architecture, and the two
 * consequences worth stating up front are the two things that make the rest of
 * the file read the way it does.
 *
 * **`ssh host -- a b c` does not deliver an argv.** OpenSSH joins its remaining
 * words with spaces and hands the string to the remote login shell. So every
 * operation composes a POSIX shell script itself, with `shellQuote` (`quote.ts`)
 * and nothing else, and hands ssh exactly one word. A branch name with a space,
 * a quote or a `;` in it survives, exactly as it does locally through `spawn`.
 *
 * **There is no remote `fs`.** `stat`, `readdir`, `realpath` and the rest are
 * one exec each of a small POSIX script — not `sftp`, which would be a second
 * connection kind, a second auth surface and a second way to fail for no
 * capability the scripts lack. The price is that a failure arrives as a
 * *message* rather than as an errno, so there is one place that turns the one
 * back into the other (`errnoFromMessage`), because `worktreeFolder.ts` reads
 * `EACCES` and "already gone" differently and must keep doing so on both
 * machines.
 *
 * What is *not* here is a second copy of the bounding logic: `exec` composes an
 * ssh command line and hands it to `runBounded`, the same function
 * `LocalRuntime` uses, so the byte caps, the silence watchdog, the cancellation
 * and the process-group kill are one implementation rather than two that agree
 * for now. Killing the local ssh client's process group is also what a deadline
 * *means* across a network: the client dies, the channel closes, and the remote
 * command gets its `SIGHUP` from sshd.
 *
 * **Secrets never appear in argv.** Argv is world-readable in `ps` on the remote
 * as much as on this Mac, and the composed script *is* the remote argv of the
 * login shell. So nothing secret is ever composed into it — that is what
 * `ExecRequest.stdin` is for, and it is why `writeTextFile` pipes its content
 * instead of echoing it.
 */

import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { errorWireAt, TypedFailure, withSummary } from "../../model/wire.js";
import { OperationDeadline, runBounded } from "../terminal/command.js";
import { CancellationToken, portFailure } from "../terminal/ports.js";
import { openPty, type Pty, type PtyFactory } from "../terminal/pty.js";
import { gitDirectoryOf } from "./gitDirectory.js";
import { shellQuote } from "./quote.js";
import {
	RuntimeFileError,
	type DirEntry,
	type ExecLimits,
	type ExecRequest,
	type ExecResult,
	type FileKind,
	type PtyRequest,
	type Runtime,
	type RuntimeCadence,
	type RuntimeId,
	type RuntimeReading,
	type Watcher,
} from "./runtime.js";

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
 * How often a remote `HEAD` is asked about.
 *
 * There is no inotify across a network, so this is a poll, and a poll's
 * interval is a trade a constant has to make once: two seconds is under the
 * time it takes a person to look away from a checkout they have just switched,
 * and one exec every two seconds over a multiplexed connection is nothing next
 * to the reconcile loop above it.
 */
const HEAD_WATCH_POLL_MS = 2000;

/** A minute between repository polls, remote or not: the number is the same. */
const REPOSITORY_POLL_MS = 60 * 1000;

/** The bounds the derived reconcile cadence is held between. */
const RECONCILE_FLOOR_MS = 500;
const RECONCILE_CEILING_MS = 3000;

/**
 * What one reconcile round is allowed to cost, as a multiple of a round trip.
 *
 * Eight bounds the duty cycle at 12.5 % by construction, which is the property
 * worth having — not the number. A 5 ms LAN host lands on the floor; a 300 ms
 * satellite link on the ceiling.
 */
const RECONCILE_ROUND_TRIPS = 8;

/**
 * The prefix every message this file writes into a remote script carries.
 *
 * A remote command may legitimately exit 127, and a remote command's own stderr
 * may legitimately say "not found". Neither can say this, because DevHub wrote
 * it, which is what makes "the program was not there" distinguishable from "the
 * program ran and was unhappy" over a transport that only returns a number.
 */
const SCRIPT_MARKER = "devhub-exec:";

/** What `ExecRequest.env` keys may look like, because they become shell names. */
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Bounds for the small answers the filesystem scripts give. */
const PROBE_LIMITS: ExecLimits = {
	stdoutBytes: 1024 * 1024,
	stderrBytes: 8 * 1024,
	overflow: { kind: "truncate" },
};

/** How long a filesystem probe may go without an answer. */
const PROBE_TIMEOUT_MS = 20_000;

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
	home: string = homedir(),
): string {
	const preferred = join(userDataDirectory, "ssh");
	if (fitsControlPath(preferred)) return preferred;
	const fallback = join(home, ".devhub", "ssh");
	if (fitsControlPath(fallback)) return fallback;
	throw new Error(
		`no ssh control socket fits: ${controlPathOf(preferred)} and ` +
			`${controlPathOf(fallback)} are both longer than ${String(
				CONTROL_PATH_LIMIT,
			)} bytes`,
	);
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
export function sshOptionArgv(controlDirectory: string): string[] {
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPath=${join(controlDirectory, "%C")}`,
		"-o",
		`ControlPersist=${CONTROL_PERSIST}`,
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"ConnectTimeout=10",
	];
}

/**
 * One remote command line, as one shell word.
 *
 * The shape is fixed so that every failure it can have is one DevHub wrote:
 * a working directory that is not there and a program that is not there both
 * end at `SCRIPT_MARKER` and exit 127, which is how `exec` gives the same
 * `unavailable` answer `spawn`'s `ENOENT` gives locally. Everything after that
 * is the caller's command, `exec`'d so that the shell is replaced and the exit
 * status is the command's own.
 *
 * `cd -P` and not `cd`: `chdir` is what `spawn` does locally, and it resolves
 * symlinks, so a `pwd` in the command sees the physical path on both machines.
 * A logical `cd` would leave `$PWD` naming a symlink and make the same command
 * answer two different things depending on which machine it ran on.
 *
 * The environment is *added* to the remote login shell's, not substituted for
 * it — `export K=V` and never `ssh -o SendEnv`, which needs the far end's
 * `AcceptEnv` and produces a variable that silently does not arrive.
 */
export function remoteScript(request: {
	readonly argv: readonly string[];
	readonly cwd?: string | undefined;
	readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}): string {
	const program = request.argv[0];
	if (program === undefined) {
		throw new Error("a runtime exec needs a program to run");
	}
	const lines: string[] = [];
	if (request.cwd !== undefined) {
		lines.push(
			`cd -P -- ${shellQuote(request.cwd)} 2>/dev/null || ` +
				`{ echo ${shellQuote(`${SCRIPT_MARKER} no directory ${request.cwd}`)} >&2; exit 127; }`,
		);
	}
	for (const [key, value] of Object.entries(request.env ?? {})) {
		if (value === undefined) continue;
		if (!ENVIRONMENT_NAME.test(key)) {
			throw new Error(`${key} is not a name a shell can export`);
		}
		lines.push(`export ${key}=${shellQuote(value)}`);
	}
	lines.push(
		`command -v -- ${shellQuote(program)} >/dev/null 2>&1 || ` +
			`{ echo ${shellQuote(`${SCRIPT_MARKER} no program ${program}`)} >&2; exit 127; }`,
	);
	lines.push(`exec ${request.argv.map(shellQuote).join(" ")}`);
	return lines.join("\n");
}

/**
 * The errno behind a POSIX tool's complaint.
 *
 * `stat`, `ls` and `head` all print `strerror` at the end of their message, on
 * GNU and on BSD alike — the two differ in what comes *before* it (`ls: cannot
 * access 'p': …` against `ls: p: …`), which is exactly the part this does not
 * read. So there is one table rather than one per platform, and a message it
 * does not recognise keeps its own words instead of being rounded to the
 * nearest errno: `RuntimeFileError` carries "could not look", and a wrong errno
 * is worse than an unfamiliar sentence.
 */
export function errnoFromMessage(message: string): string | undefined {
	const text = message.toLowerCase();
	if (text.includes("no such file or directory")) return "ENOENT";
	if (text.includes("permission denied")) return "EACCES";
	if (text.includes("operation not permitted")) return "EPERM";
	if (text.includes("not a directory")) return "ENOTDIR";
	if (text.includes("is a directory")) return "EISDIR";
	if (text.includes("directory not empty")) return "ENOTEMPTY";
	if (text.includes("file name too long")) return "ENAMETOOLONG";
	if (text.includes("file exists")) return "EEXIST";
	if (text.includes("no space left on device")) return "ENOSPC";
	if (text.includes("read-only file system")) return "EROFS";
	if (
		text.includes("too many levels of symbolic links") ||
		text.includes("symbolic link loop")
	) {
		return "ELOOP";
	}
	return undefined;
}

function lastLine(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines[lines.length - 1] ?? "";
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
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
	return new TypedFailure(
		withSummary(
			errorWireAt("workspace_unavailable"),
			`DevHub cannot run commands on ${host} without a password. The editor ` +
				`connects because the SSH extension can ask you for one; DevHub's own ` +
				`git, terminals and Agents cannot ask. Set up a key for ${host} — ` +
				`ssh-copy-id ${host} — and reopen the workspace.`,
		),
	);
}

export function hostKeyFailure(host: string): TypedFailure {
	return new TypedFailure(
		withSummary(
			errorWireAt("workspace_unavailable"),
			`The host key for ${host} is not known to DevHub. Run ssh ${host} once ` +
				`in a terminal to accept it.`,
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

export function unsupportedPlatformFailure(
	host: string,
	uname: string,
): TypedFailure {
	return new TypedFailure(
		withSummary(
			errorWireAt("workspace_unavailable"),
			`DevHub supports Linux and macOS hosts, and ${host} reports ` +
				`${uname.length === 0 ? "nothing" : uname}.`,
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

export class SshRuntime implements Runtime {
	readonly id: RuntimeId;
	readonly where: string;

	readonly #host: string;
	readonly #controlDirectory: string;
	readonly #sshPath: string;
	readonly #ptyFactory: PtyFactory;
	readonly #localEnvironment: Readonly<Record<string, string | undefined>>;

	readonly #latencies: number[] = [];
	#recentExecs: number[] = [];
	#lastFailure: string | undefined;
	#connected = false;
	#masterPid: number | undefined;
	#askedForMasterPid = false;
	#remote: Promise<{ home: string; platform: string }> | undefined;
	#controlDirectoryMade: Promise<unknown> | undefined;

	constructor(options: SshRuntimeOptions) {
		this.#host = options.host;
		this.id = `ssh:${options.host}`;
		this.where = ` on ${options.host}`;
		this.#controlDirectory = options.controlDirectory;
		this.#sshPath = options.sshPath ?? "ssh";
		this.#ptyFactory = options.ptyFactory ?? openPty;
		this.#localEnvironment = options.localEnvironment ?? process.env;
		if (!fitsControlPath(this.#controlDirectory)) {
			throw new Error(
				`the ssh control socket ${controlPathOf(this.#controlDirectory)} is ` +
					`longer than the ${String(CONTROL_PATH_LIMIT)} bytes a unix socket ` +
					`path may be`,
			);
		}
	}

	get cadence(): RuntimeCadence {
		return {
			// A number rather than a constant, because the constant that is right
			// for a fork on this Mac is an ssh flood on a host across an ocean.
			reconcileIntervalMs: clamp(
				RECONCILE_ROUND_TRIPS * this.#medianRoundTripMs(),
				RECONCILE_FLOOR_MS,
				RECONCILE_CEILING_MS,
			),
			repositoryPollMs: REPOSITORY_POLL_MS,
			headWatchPollMs: HEAD_WATCH_POLL_MS,
		};
	}

	/**
	 * `$HOME` on that machine, and the check that it is a machine DevHub speaks.
	 *
	 * Both come from one exec because both are asked once and cached for the life
	 * of the runtime, and because the first use is the honest moment to refuse a
	 * host DevHub cannot compose POSIX shell for. Every command in this file is
	 * POSIX shell and tmux does not run on Windows, so the refusal is a fact
	 * about the design rather than an untested path.
	 */
	async home(): Promise<string> {
		return (await this.#describeRemote()).home;
	}

	async platform(): Promise<string> {
		return (await this.#describeRemote()).platform;
	}

	#describeRemote(): Promise<{ home: string; platform: string }> {
		this.#remote ??= (async () => {
			const result = await this.#sh(
				`printf '%s\\n%s\\n' "$HOME" "$(uname -s)"`,
			);
			const [home = "", platform = ""] = result.stdout
				.toString("utf8")
				.split("\n");
			if (platform !== "Linux" && platform !== "Darwin") {
				throw unsupportedPlatformFailure(this.#host, platform);
			}
			return { home, platform };
		})();
		return this.#remote;
	}

	/**
	 * One command on the other machine.
	 *
	 * The composition is here; the bounding is `runBounded`, the same function
	 * the local runtime hands its children to. What is bounded is the *local ssh
	 * client*, and that is the right subject: the deadline kills its process
	 * group, the channel closes, and sshd sends the remote command its `SIGHUP`.
	 */
	async exec(request: ExecRequest): Promise<ExecResult> {
		const script = remoteScript(request);
		// The remote fork is invisible to `getAppMetrics`, so the count is the
		// only place it exists. Named with the host, so a reading says where.
		activityCounters.record(
			COUNTER.process(`${this.id}/${basenameOf(request.argv[0] ?? "")}`),
		);
		await this.#ensureControlDirectory();
		const startedAt = Date.now();
		this.#recentExecs.push(startedAt);
		let result: ExecResult;
		try {
			result = await runBounded(
				{
					file: this.#sshPath,
					args: [
						...sshOptionArgv(this.#controlDirectory),
						this.#host,
						"--",
						script,
					],
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
		} catch (failure: unknown) {
			this.#record(startedAt);
			this.#connected = false;
			this.#lastFailure =
				failure instanceof Error ? failure.message : String(failure);
			throw failure;
		}
		this.#record(startedAt);
		const refused = clientFailure(this.#host, result);
		if (refused) {
			this.#connected = false;
			this.#lastFailure = refused.message;
			throw refused;
		}
		this.#connected = true;
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
		const script = remoteScript({
			argv: [request.file, ...request.args],
			cwd: request.cwd,
			env: request.env,
		});
		return this.#ptyFactory({
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
	}

	/**
	 * What is at a path: directory, file, or nothing there.
	 *
	 * `test` rather than `stat`, because the two `stat`s take different flags
	 * (`-c` and `-f`) and the answer needed is three words wide, not a format
	 * string. The `ls` in the last branch is the part that is not obvious: `test`
	 * cannot tell "there is nothing there" from "I was not allowed to look", and
	 * those are the two answers `worktreeFolder.ts` must never confuse — a close
	 * that reads `EACCES` as "already gone" deletes git's record of a worktree
	 * whose folder is still sitting there with work in it. So the absent branch
	 * asks once more, and only then.
	 */
	async stat(path: string): Promise<FileKind> {
		const quoted = shellQuote(path);
		const result = await this.#sh(
			[
				`if [ -d ${quoted} ]; then printf d`,
				`elif [ -e ${quoted} ]; then printf f`,
				`else`,
				`  why=$(ls -ld -- ${quoted} 2>&1 >/dev/null) || :`,
				`  case "$why" in *[Pp]ermission*) printf '%s' "$why" >&2; exit 1;; esac`,
				`  printf n`,
				`fi`,
			].join("\n"),
		);
		if (result.code !== 0) throw this.#fileError(path, result);
		switch (result.stdout.toString("utf8").trim()) {
			case "d":
				return "directory";
			case "f":
				return "file";
			default:
				return "absent";
		}
	}

	/** At most `maxBytes` of a file, as UTF-8. `head -c` is the whole of it. */
	async readTextFile(path: string, maxBytes: number): Promise<string> {
		const result = await this.#sh(
			`exec head -c ${String(maxBytes)} -- ${shellQuote(path)}`,
			{ stdoutBytes: maxBytes },
		);
		if (result.code !== 0) throw this.#fileError(path, result);
		return result.stdout.toString("utf8");
	}

	/**
	 * A file, written through the connection rather than into the command line.
	 *
	 * The mode is set on an empty file *before* the content arrives, so there is
	 * no window in which a 0600 file exists at 0644 with its contents in it. The
	 * content itself travels as stdin because the composed script is the remote
	 * shell's argv, and argv is world-readable in `ps`.
	 */
	async writeTextFile(path: string, text: string, mode: number): Promise<void> {
		const quoted = shellQuote(path);
		const result = await this.#sh(
			`: > ${quoted} && chmod ${mode.toString(8).padStart(4, "0")} ${quoted} && exec cat > ${quoted}`,
			{ stdin: Buffer.from(text, "utf8") },
		);
		if (result.code !== 0) throw this.#fileError(path, result);
	}

	/**
	 * One directory, one round trip.
	 *
	 * `ls -A1p`: `-p` puts a `/` after a directory, which is the answer that
	 * would otherwise cost a `stat` per entry. It marks only real directories, so
	 * a symlink to one reads as a file — which is what `Dirent#isDirectory` says
	 * locally, so the two agree. A name with a newline in it would tear a line in
	 * two; that is the known limit of a line-oriented listing, and no format
	 * `ls` has avoids it.
	 */
	async readdir(path: string): Promise<readonly DirEntry[]> {
		const quoted = shellQuote(path);
		const result = await this.#sh(
			[
				`if [ -d ${quoted} ]; then exec ls -A1p -- ${quoted}; fi`,
				`if [ -e ${quoted} ]; then echo "ls: ${path}: Not a directory" >&2; exit 1; fi`,
				`echo "ls: ${path}: No such file or directory" >&2; exit 1`,
			].join("\n"),
		);
		if (result.code !== 0) throw this.#fileError(path, result);
		return result.stdout
			.toString("utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) =>
				line.endsWith("/")
					? { name: line.slice(0, -1), directory: true }
					: { name: line, directory: false },
			);
	}

	/** `rm -rf`, on a path the caller has already validated — as locally. */
	async removeTree(path: string): Promise<void> {
		const result = await this.#sh(`exec rm -rf -- ${shellQuote(path)}`);
		if (result.code !== 0) throw this.#fileError(path, result);
	}

	async makeDirectory(path: string): Promise<void> {
		const result = await this.#sh(`exec mkdir -p -- ${shellQuote(path)}`);
		if (result.code !== 0) throw this.#fileError(path, result);
	}

	/**
	 * A path with its symlinks resolved.
	 *
	 * `cd && pwd -P` rather than `realpath` or `readlink -f`, because the shell
	 * has done this since before either tool existed and neither is on every
	 * host — `realpath` is not in macOS before 12.3 and `readlink -f` is not in
	 * BSD's `readlink` at all. One code path on every host beats two that are
	 * chosen by a probe.
	 */
	async realpath(path: string): Promise<string> {
		const quoted = shellQuote(path);
		const result = await this.#sh(
			[
				`if [ -d ${quoted} ]; then cd -- ${quoted} && exec pwd -P; fi`,
				`if [ ! -e ${quoted} ]; then echo "realpath: ${path}: No such file or directory" >&2; exit 1; fi`,
				`cd -- "$(dirname -- ${quoted})" || exit 1`,
				`printf '%s/%s\\n' "$(pwd -P)" "$(basename -- ${quoted})"`,
			].join("\n"),
		);
		if (result.code !== 0) throw this.#fileError(path, result);
		return result.stdout.toString("utf8").trim();
	}

	/**
	 * The honest replacement for `fs.watch`: a poll, said out loud.
	 *
	 * What is polled is the *content* of `HEAD`, `packed-refs` and every loose
	 * ref, reduced to a `cksum` on the far side so that the answer is one short
	 * line however many refs there are. Content rather than mtime because
	 * `ls`-grade timestamps are minute-resolution on some hosts, and a `HEAD`
	 * that changed twice inside a minute is exactly the case a checkout produces.
	 *
	 * A poll that cannot run fires the callback, which is the same rule the local
	 * watcher follows for a watcher that dies: a checkout that stopped being
	 * watched is news, and the caller re-reads and finds out why.
	 */
	async watchGitDirectory(
		worktree: string,
		onChange: () => void,
	): Promise<Watcher> {
		const gitDirectory = await gitDirectoryOf(this, worktree);
		let previous = await this.#refsDigest(gitDirectory);
		let closed = false;
		let inFlight = false;
		const timer = setInterval(() => {
			if (inFlight) return;
			inFlight = true;
			void this.#refsDigest(gitDirectory)
				.then((digest) => {
					if (closed || digest === previous) return;
					previous = digest;
					onChange();
				})
				.catch((failure: unknown) => {
					this.#lastFailure =
						failure instanceof Error ? failure.message : String(failure);
					if (!closed) onChange();
				})
				.finally(() => {
					inFlight = false;
				});
		}, HEAD_WATCH_POLL_MS);
		return {
			close: () => {
				closed = true;
				clearInterval(timer);
			},
		};
	}

	async #refsDigest(gitDirectory: string): Promise<string> {
		const result = await this.#sh(
			[
				`cd -- ${shellQuote(gitDirectory)} 2>/dev/null || { echo gone; exit 0; }`,
				`{ printf 'HEAD '; cat HEAD 2>/dev/null; printf '\\npacked-refs ';`,
				`  cat packed-refs 2>/dev/null; printf '\\n';`,
				`  find refs -type f -exec sh -c 'for f do printf "%s " "$f"; cat -- "$f"; done' sh {} + 2>/dev/null;`,
				`} | cksum`,
			].join("\n"),
		);
		if (result.code !== 0) throw this.#fileError(gitDirectory, result);
		return result.stdout.toString("utf8").trim();
	}

	reading(): RuntimeReading {
		const since = Date.now() - A_MINUTE;
		this.#recentExecs = this.#recentExecs.filter((at) => at >= since);
		return {
			id: this.id,
			connected: this.#connected,
			masterPid: this.#masterPid,
			medianRoundTripMs: this.#medianRoundTripMs(),
			reconcileIntervalMs: this.cadence.reconcileIntervalMs,
			execsLastMinute: this.#recentExecs.length,
			lastFailure: this.#lastFailure,
		};
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
		this.#remote = undefined;
		const result = await runBounded(
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
		const said = result.stderr.toString("utf8");
		if (result.code !== 0 && !/no such file|no controlpath/iu.test(said)) {
			this.#lastFailure = lastLine(said);
		}
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
				this.#lastFailure =
					failure instanceof Error ? failure.message : String(failure);
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

	/** One small POSIX script on the other machine, bounded like everything else. */
	#sh(
		script: string,
		extra: {
			stdin?: Uint8Array;
			stdoutBytes?: number;
		} = {},
	): Promise<ExecResult> {
		return this.exec({
			argv: ["/bin/sh", "-c", script],
			deadline: OperationDeadline.in(PROBE_TIMEOUT_MS),
			cancel: new CancellationToken(),
			limits:
				extra.stdoutBytes === undefined
					? PROBE_LIMITS
					: { ...PROBE_LIMITS, stdoutBytes: extra.stdoutBytes },
			stdin: extra.stdin,
		});
	}

	#fileError(path: string, result: ExecResult): RuntimeFileError {
		const said = lastLine(result.stderr.toString("utf8"));
		return new RuntimeFileError(path, errnoFromMessage(said) ?? said);
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

function basenameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
