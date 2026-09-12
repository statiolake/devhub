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
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { errorWireAt, TypedFailure, withSummary } from "../../model/wire.js";
import { OperationDeadline, runBounded } from "../terminal/command.js";
import { CancellationToken, portFailure } from "../terminal/ports.js";
import { openPty, type Pty, type PtyFactory } from "../terminal/pty.js";
import {
	remoteTerminalPaths,
	terminalLauncherScript,
} from "../terminal/launcher.js";
import { remoteReconcileIntervalMs } from "./cadence.js";
import type { SettingsResolvedRuntimeWire } from "../../ipc/settings.js";
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
	type TerminalLauncher,
	type TerminalLauncherSpec,
	type TmuxProgram,
	type Watcher,
} from "./runtime.js";
import type { TmuxDelivery } from "./tmuxDelivery.js";

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

/**
 * How much of a login environment DevHub will read.
 *
 * A profile that exports a megabyte is a profile with a bug in it, and reading
 * it would put that megabyte on the command line of every command afterwards.
 */
const LOGIN_ENVIRONMENT_BYTES = 256 * 1024;

/**
 * The variables a login shell sets that this connection must not carry.
 *
 * Every one of them describes *the login that was read*, not the command about
 * to run: which socket it came in on, which tty it had, how deep its shell was
 * nested, which directory it happened to start in. Carrying them across would
 * tell a program on the host it is attached to a terminal that closed minutes
 * ago, and would override the ones ssh, tmux and the pty each set correctly for
 * themselves. What is wanted from a login shell is the part a person put there
 * — `PATH` above all — and this is the list of everything that is not that.
 */
const CONNECTION_VARIABLES: ReadonlySet<string> = new Set([
	"_",
	"OLDPWD",
	"PWD",
	"SHLVL",
	"SSH_AUTH_SOCK",
	"SSH_CLIENT",
	"SSH_CONNECTION",
	"SSH_TTY",
	"TERM",
	"TMUX",
	"TMUX_PANE",
]);

/**
 * A machine's own environment, as its login shell reports it.
 *
 * `env -0` is asked for first because a NUL-separated listing is the only one
 * that cannot be misread: a value with a newline in it is a value, not two
 * variables. When `-0` is not there — busybox's `env` on an appliance, say —
 * the newline-separated listing is parsed with the one rule that recovers the
 * common case: a line that is not `NAME=…` is the continuation of the value
 * before it. That is a guess, and it is the only guess in this file, so it is
 * confined to the fallback and said out loud here.
 */
export function parseLoginEnvironment(
	text: string,
	separator: string,
): Record<string, string> {
	const found: Record<string, string> = {};
	let last: string | undefined;
	for (const entry of text.split(separator)) {
		if (entry.length === 0) continue;
		const at = entry.indexOf("=");
		const name = at === -1 ? "" : entry.slice(0, at);
		if (at === -1 || !ENVIRONMENT_NAME.test(name)) {
			if (last !== undefined) found[last] = `${found[last] ?? ""}\n${entry}`;
			continue;
		}
		found[name] = entry.slice(at + 1);
		last = name;
	}
	for (const name of CONNECTION_VARIABLES) delete found[name];
	return found;
}

/** What one machine's login environment is, and how it was read. */
interface RemoteMachine {
	readonly home: string;
	readonly platform: string;
	/** `uname -m`, as the tarball names it: `x64` or `arm64`. */
	readonly architecture: string;
	readonly login: Readonly<Record<string, string>>;
}

/** `uname -s` as the download URL spells it. */
function platformName(uname: string): string {
	return uname.toLowerCase();
}

/**
 * `uname -m` as the download URL spells it.
 *
 * The two names each architecture answers to are folded into the one the
 * release uses; anything else keeps its own word, so a machine DevHub has no
 * tarball for says which machine it is rather than being rounded to one that
 * looks close.
 */
function architectureName(uname: string): string {
	if (uname === "x86_64" || uname === "amd64") return "x64";
	if (uname === "aarch64" || uname === "arm64") return "arm64";
	return uname;
}

function describe(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}

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
	readonly #tmuxDelivery: TmuxDelivery | undefined;

	readonly #latencies: number[] = [];
	#recentExecs: number[] = [];
	#lastFailure: string | undefined;
	#connected = false;
	#masterPid: number | undefined;
	#askedForMasterPid = false;
	#remote: Promise<RemoteMachine> | undefined;
	/**
	 * The login environment, once it has been read.
	 *
	 * Kept beside the promise because `spawnPty` is synchronous and cannot wait
	 * for one. Nothing opens a pseudo-terminal on a machine it has not already
	 * asked for `$HOME` and resolved a program on — the adapter that opens it is
	 * built out of those answers — so by then this is set, and a `spawnPty` that
	 * finds it unset is a caller that reached the far machine in an order this
	 * file does not know about, which is a thing to stop on rather than paper
	 * over with an environment that is missing the person's `PATH`.
	 */
	#login: Readonly<Record<string, string>> | undefined;
	#launcher: Promise<TerminalLauncher> | undefined;
	#tmux: Promise<TmuxProgram> | undefined;
	#controlDirectoryMade: Promise<unknown> | undefined;

	constructor(options: SshRuntimeOptions) {
		this.#host = options.host;
		this.id = `ssh:${options.host}`;
		this.where = ` on ${options.host}`;
		this.#controlDirectory = options.controlDirectory;
		this.#sshPath = options.sshPath ?? "ssh";
		this.#ptyFactory = options.ptyFactory ?? openPty;
		this.#localEnvironment = options.localEnvironment ?? process.env;
		this.#tmuxDelivery = options.tmux;
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
			// A number rather than a constant, because the constant that is
			// right for a fork on this Mac is an ssh flood on a host across an
			// ocean. The rule itself is `cadence.ts`'s and not this file's: the
			// reconciler's tests assert the bound it states, and two copies of
			// one line of arithmetic is one copy that will drift.
			reconcileIntervalMs: remoteReconcileIntervalMs(this.#medianRoundTripMs()),
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

	#describeRemote(): Promise<RemoteMachine> {
		if (this.#remote) return this.#remote;
		const pending = (async () => {
			const result = await this.#sh(
				`printf '%s\\n%s\\n%s\\n%s\\n' "$HOME" "$(uname -s)" "$(uname -m)" "$SHELL"`,
			);
			const [home = "", platform = "", machine = "", shell = ""] = result.stdout
				.toString("utf8")
				.split("\n");
			if (platform !== "Linux" && platform !== "Darwin") {
				throw unsupportedPlatformFailure(this.#host, platform);
			}
			const login = await this.#readLoginEnvironment(shell);
			this.#login = login;
			return {
				home,
				platform,
				architecture: architectureName(machine),
				login,
			};
		})();
		// A host that was down when the first command went out must be asked
		// again by the second: a rejected promise left in the field would answer
		// every later command with the failure of the first one, and a machine
		// that came back would never be tried again.
		pending.catch(() => {
			if (this.#remote === pending) this.#remote = undefined;
		});
		this.#remote = pending;
		return pending;
	}

	/**
	 * What a program on this host runs inside.
	 *
	 * The environment `ssh host -- cmd` gives a command is not the one a person
	 * gets when they log in: sshd runs a *non-login, non-interactive* shell, so
	 * `~/.profile` has not run and `PATH` is whatever sshd's default is —
	 * typically `/bin:/usr/bin` and the system directories, and nothing a person
	 * has added. Every "works in my terminal, not in DevHub" report about a
	 * remote host is that one fact. So the login environment is read once, from
	 * the login shell itself, and every command DevHub runs on the host is given
	 * it.
	 *
	 * Three ways of asking, in order, because the answer matters more than the
	 * spelling: the person's own `$SHELL` with `-lc 'env -0'`, then `/bin/sh`
	 * with the same, then `/bin/sh -lc 'env'` for an `env` with no `-0`. The
	 * first that answers with a `PATH` is the answer; a host where none of them
	 * does is a host DevHub refuses, by name, rather than running commands in an
	 * environment it could not read.
	 */
	async #readLoginEnvironment(
		shell: string,
	): Promise<Readonly<Record<string, string>>> {
		const attempts: { readonly script: string; readonly separator: string }[] =
			[];
		if (shell.startsWith("/")) {
			attempts.push({
				script: `exec ${shellQuote(shell)} -lc 'env -0'`,
				separator: "\0",
			});
		}
		attempts.push({ script: `exec /bin/sh -lc 'env -0'`, separator: "\0" });
		attempts.push({ script: `exec /bin/sh -lc 'env'`, separator: "\n" });
		for (const attempt of attempts) {
			const result = await this.#sh(attempt.script, {
				stdoutBytes: LOGIN_ENVIRONMENT_BYTES,
			});
			if (result.code !== 0) continue;
			const found = parseLoginEnvironment(
				result.stdout.toString("utf8"),
				attempt.separator,
			);
			if (found["PATH"] !== undefined) return found;
		}
		throw new Error(
			`DevHub could not read the login environment on ${this.#host}: ` +
				`neither ${shell === "" ? "the login shell" : shell} nor /bin/sh ` +
				`answered 'env' with a PATH, so it cannot tell where the programs it ` +
				`runs there are.`,
		);
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
		const { login } = await this.#describeRemote();
		// The caller's own variables win over the person's, and DevHub's own
		// `DEVHUB_*` are the caller's: a runtime that let a profile's `PATH`
		// override the one a command was given would be answering a question the
		// caller had already answered.
		return this.#run({ ...request, env: { ...login, ...request.env } });
	}

	async #run(request: ExecRequest): Promise<ExecResult> {
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
	/**
	 * What a configured name means on the far machine, asked of the far machine.
	 *
	 * `command -v` under the *login* environment, which is the whole point: the
	 * `PATH` sshd hands a non-interactive command does not have the person's
	 * `~/.local/bin` or their Homebrew in it, so a lookup under it would answer
	 * "not there" for a program that is plainly there when they type its name.
	 * One round trip per configured program per host per DevHub start, and the
	 * answer is an absolute path — the same shape the local runtime gives, so
	 * the Settings window prints one thing and the launcher runs the same thing.
	 *
	 * A name that cannot be found is `unavailable` with the directories that
	 * were searched, in that machine's own `PATH` order, because a search nobody
	 * can see is a search nobody can correct — and the directories are the
	 * host's, which is the fact a person is missing when the local answer looked
	 * fine.
	 */
	async resolveProgram(
		configured: string,
		// This machine's PATH, which is not this question's answer: the search
		// happens over there, under the environment read from over there.
		_searchPath?: string,
	): Promise<SettingsResolvedRuntimeWire> {
		const { login } = await this.#describeRemote();
		const path = login["PATH"] ?? "";
		const result = await this.#run({
			argv: ["/bin/sh", "-c", `command -v -- ${shellQuote(configured)}`],
			env: login,
			deadline: OperationDeadline.in(PROBE_TIMEOUT_MS),
			cancel: new CancellationToken(),
			limits: PROBE_LIMITS,
		});
		const found = result.stdout.toString("utf8").trim();
		if (result.code === 0 && found.startsWith("/")) {
			return { kind: "absolute_path", value: found };
		}
		return {
			kind: "unavailable",
			configured,
			lookup: configured.includes("/")
				? { kind: "explicit", path: configured }
				: {
						kind: "path",
						directories: path.split(":").filter((entry) => entry.length > 0),
					},
		};
	}

	/**
	 * The tmux DevHub put on this host, put there now if it is not already.
	 *
	 * `runtimes.tmux` is not consulted and the host's own tmux is never used.
	 * That is a decision and not an oversight: tmux's control output — the
	 * `list-sessions` format, `capture-pane -e`, `display-message -p` — differs
	 * between versions in ways that surface as an Agent whose output is subtly
	 * wrong rather than as an error, and this adapter is written against one
	 * version. The host that made this necessary has no tmux at all and no way
	 * for its owner to install one. One version, published by DevHub, is the
	 * version the tests are about.
	 *
	 * The install is four steps and every one of them names the host when it
	 * fails, because "tmux did not work" with no machine in it is the least
	 * useful thing to say about two machines: ask the version already there,
	 * fetch the tarball *here*, unpack it *there* from a stream on stdin, and
	 * ask the version again. The last step is the one that makes the first
	 * meaningful — an unpack that wrote something that will not run is caught
	 * on the way in rather than at the first attach.
	 *
	 * Idempotent by the same question it starts with: a version directory whose
	 * `bin/tmux -V` answers is an install that has happened, whether this DevHub
	 * did it, an older one did, or somebody unpacked the tarball by hand.
	 */
	async tmuxProgram(
		// `runtimes.tmux` and this machine's PATH, both deliberately unread:
		// which tmux runs on a host is not a thing a person configures per
		// machine, and the search path here names nothing there.
		_configured?: string,
		_searchPath?: string,
	): Promise<TmuxProgram> {
		// Outside the catch below: a missing delivery is not something the next
		// window should retry, and reporting it as "tmux is unavailable on that
		// host" would send whoever reads it to look at the host.
		const delivery = this.#delivery();
		this.#tmux ??= this.#installTmux(delivery);
		try {
			return await this.#tmux;
		} catch (failure: unknown) {
			// Tried again by the next window: a host that had no route to the
			// release when the first one opened may have one by the second.
			this.#tmux = undefined;
			return {
				kind: "unavailable",
				reason: failure instanceof Error ? failure.message : String(failure),
			};
		}
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
	#delivery(): TmuxDelivery {
		const delivery = this.#tmuxDelivery;
		if (delivery === undefined) {
			throw new Error(
				`the runtime for ${this.#host} was built without a tmux delivery, ` +
					`which is a bug in DevHub and not a fact about that host`,
			);
		}
		return delivery;
	}

	async #installTmux(delivery: TmuxDelivery): Promise<TmuxProgram> {
		const { home, platform, architecture } = await this.#describeRemote();
		const target = `${platformName(platform)}-${architecture}`;
		const directory = posix.join(home, delivery.directory, delivery.version);
		const program = posix.join(directory, "bin", "tmux");
		const environment = { TERMINFO: posix.join(directory, "terminfo") };
		if (await this.#tmuxAnswers(program)) {
			return { kind: "resolved", path: program, environment };
		}
		let tarball;
		try {
			tarball = await delivery.tarball(target);
		} catch (failure: unknown) {
			throw new Error(
				`DevHub could not get the tmux ${delivery.version} it installs on ` +
					`${this.#host} (${target}): ${describe(failure)}`,
				{ cause: failure },
			);
		}
		const staging = `${directory}.unpacking`;
		const unpacked = posix.join(staging, tarball.topLevelDirectory);
		// `tar` reading a stream from stdin, into a directory of its own, and a
		// rename at the end. Not `--strip-components`, which is GNU's and
		// bsdtar's and not POSIX's, and not an unpack straight onto the version
		// directory, which would leave half an install behind a name that means
		// "installed" if the connection dropped in the middle.
		const unpack = await this.#sh(
			[
				`rm -rf -- ${shellQuote(staging)} ${shellQuote(directory)}`,
				`mkdir -p -- ${shellQuote(staging)} || exit 1`,
				`tar xzf - -C ${shellQuote(staging)} || exit 1`,
				`[ -d ${shellQuote(unpacked)} ] || { echo "no ${tarball.topLevelDirectory} in the tarball" >&2; exit 1; }`,
				`mkdir -p -- ${shellQuote(posix.dirname(directory))} || exit 1`,
				`mv -- ${shellQuote(unpacked)} ${shellQuote(directory)} || exit 1`,
				`exec rm -rf -- ${shellQuote(staging)}`,
			].join("\n"),
			{ stdin: tarball.bytes },
		);
		if (unpack.code !== 0) {
			throw new Error(
				`DevHub could not unpack tmux ${delivery.version} into ${directory} ` +
					`on ${this.#host}: ${lastLine(unpack.stderr.toString("utf8"))}`,
			);
		}
		if (!(await this.#tmuxAnswers(program))) {
			throw new Error(
				`DevHub unpacked tmux ${delivery.version} into ${directory} on ` +
					`${this.#host}, but ${program} -V did not answer — the binary that ` +
					`came out cannot run on that machine`,
			);
		}
		return { kind: "resolved", path: program, environment };
	}

	/**
	 * DevHub's tmux config, carried across on every connection.
	 *
	 * The file lives on this Mac — it is beside `settings.toml`, where a person
	 * edits it — and tmux reads it on the host, so it has to be *there*. Copied
	 * rather than cached: it is a few hundred bytes over a connection that is
	 * already open, and the alternative is a rule about when a copy has gone
	 * stale, which is a rule that will be wrong the first time somebody edits
	 * their config and reconnects to find nothing changed.
	 *
	 * A config that is no longer here is removed from over there for the same
	 * reason. "Always current" has to mean both directions or it means neither.
	 */
	async userTmuxConfig(localPath: string): Promise<string> {
		const { home } = await this.#describeRemote();
		const directory = posix.join(home, this.#delivery().directory);
		const remotePath = posix.join(directory, "tmux.conf");
		const text = await readFile(localPath, "utf8").catch(() => undefined);
		if (text === undefined) {
			await this.removeTree(remotePath);
			return "/dev/null";
		}
		await this.makeDirectory(directory);
		await this.writeTextFile(remotePath, text, 0o600);
		return remotePath;
	}

	/** Whether there is a tmux at this path that this machine can run. */
	async #tmuxAnswers(program: string): Promise<boolean> {
		const result = await this.#sh(`exec ${shellQuote(program)} -V`);
		return result.code === 0;
	}

	spawnPty(request: PtyRequest): Pty {
		const login = this.#login;
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
	/**
	 * `~/.devhub/tmp` on the far machine, made 0700 the first time it is asked
	 * for.
	 *
	 * Under the home directory rather than `/tmp`, for the reason everything
	 * else DevHub writes over there is: `/tmp` on a shared host is a directory
	 * other people can write, and a bootstrap config another account could
	 * replace is a tmux server another account could configure.
	 */
	async scratchDirectory(): Promise<string> {
		const { home } = await this.#describeRemote();
		const path = posix.join(home, ".devhub", "tmp");
		const result = await this.#sh(
			`exec mkdir -p -m 700 -- ${shellQuote(path)}`,
		);
		if (result.code !== 0) throw this.#fileError(path, result);
		return path;
	}

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
	 * `set -C` is the remote spelling of `open(…, "wx")`.
	 *
	 * The shell's `noclobber` refuses a redirection onto an existing path, and
	 * it refuses it in the shell that is about to write — so there is no gap
	 * between asking whether the name is free and taking it. Exit 3 is this
	 * command's own word for "it was taken"; every other non-zero exit is a
	 * failure with the far end's own stderr on it, because a caller that
	 * retried those would retry them for ever.
	 */
	async writeNewTextFile(
		path: string,
		text: string,
		mode: number,
	): Promise<boolean> {
		const quoted = shellQuote(path);
		const result = await this.#sh(
			[
				`if (set -C; : > ${quoted}) 2>/dev/null; then :`,
				`elif [ -e ${quoted} ]; then exit 3`,
				`else (set -C; : > ${quoted}); exit 1`,
				`fi`,
				`chmod ${mode.toString(8).padStart(4, "0")} ${quoted} && exec cat > ${quoted}`,
			].join("\n"),
			{ stdin: Buffer.from(text, "utf8") },
		);
		if (result.code === 3) return false;
		if (result.code !== 0) throw this.#fileError(path, result);
		return true;
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

	/**
	 * The `devhub-terminal` a workbench *on this host* runs, installed once.
	 *
	 * The problem this solves, stated exactly: an ssh window's pty host runs on
	 * the host, so the profile's `path` is a path over there, and the process it
	 * starts can reach neither DevHub's launcher nor DevHub's control socket.
	 * Both halves are carried across rather than reinvented — the launcher
	 * script is `terminalLauncherScript`, the same text, with the host's own
	 * paths in it, and the socket is DevHub's own, reverse-forwarded onto the
	 * host by the ControlMaster that is already open. So there is one protocol
	 * and one answering side, and "a terminal is a session DevHub named" is one
	 * sentence rather than two implementations that agree for now.
	 *
	 * The Node that runs it is the REH's own (`~/<serverDataFolderName>/bin/
	 * <commit>/node`). It is the one Node a host with a workbench on it is
	 * certain to have, it is the same commit the client states, and it needs no
	 * probing — a `command -v node` would find whatever a login shell happened
	 * to have on its PATH, which is a different Node on every host and none at
	 * all on some.
	 *
	 * The program is one bundled file (`readTerminalEntryBundle`), so this is
	 * three writes at the first window on a host, once per DevHub start, on a
	 * connection that is already multiplexed. It is written as a file rather
	 * than inlined into a remote shell command because that would put the
	 * program's text into the remote shell's argv where `ps` reads it.
	 */
	async terminalLauncher(
		spec: TerminalLauncherSpec,
	): Promise<TerminalLauncher> {
		this.#launcher ??= this.#installLauncher(spec);
		return this.#launcher;
	}

	async #installLauncher(
		spec: TerminalLauncherSpec,
	): Promise<TerminalLauncher> {
		if (spec.serverCommit === undefined) {
			throw new Error(
				`this DevHub was built from a source checkout and states no commit, so there is no ${spec.serverDataFolderName} directory on ${this.#host} it can name — which is the same reason it can open no workbench there`,
			);
		}
		const paths = remoteTerminalPaths({
			home: await this.home(),
			serverDataFolderName: spec.serverDataFolderName,
			serverCommit: spec.serverCommit,
			controlSocketPath: spec.controlSocketPath,
			entryName: spec.entryName,
		});
		// 0700, like the control directory on this Mac and for the same reason:
		// what is under it is a path to a socket that runs commands as this user.
		const made = await this.#sh(
			`mkdir -p -- ${shellQuote(paths.entryRoot)} && chmod 700 ${shellQuote(paths.directory)} ${shellQuote(paths.entryRoot)}`,
		);
		if (made.code !== 0) throw this.#fileError(paths.directory, made);
		await this.writeTextFile(paths.entry, spec.entryText, 0o600);
		// The bundle is an ES module and none of DevHub's `package.json`
		// travels with it, so without this Node reads it as CommonJS and the
		// first `import` is a syntax error.
		await this.writeTextFile(
			`${paths.entryRoot}/package.json`,
			`${JSON.stringify({ type: "module" }, null, "\t")}\n`,
			0o600,
		);
		await this.writeTextFile(
			paths.launcher,
			terminalLauncherScript({
				execPath: paths.node,
				entryScript: paths.entry,
				socketPath: paths.socket,
				machine: this.id,
			}),
			0o755,
		);
		return {
			path: paths.launcher,
			unreachable: await this.#forwardControlSocket(
				paths.socket,
				spec.controlSocketPath,
			),
		};
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
	 * The `test -S` afterwards is the point of the whole function. `-O forward`
	 * can report success and leave nothing bound, and a launcher pointed at a
	 * socket that is not there is precisely the silent failure this file exists
	 * to prevent. So the forward is *checked*, and a check that fails is a
	 * sentence — recorded here, so `devhub --metrics` says it, and returned, so
	 * whoever asked for the launcher can say it too. The launcher is still
	 * written: run from the host it says "DevHub is not listening on <socket>",
	 * which is the same fact in the place a person is actually looking.
	 */
	async #forwardControlSocket(
		remoteSocketPath: string,
		localSocketPath: string,
	): Promise<string | undefined> {
		const removed = await this.#sh(
			`exec rm -f -- ${shellQuote(remoteSocketPath)}`,
		);
		if (removed.code !== 0) {
			return `${remoteSocketPath} could not be removed on ${this.#host}, so DevHub's control socket could not be forwarded there: ${lastLine(removed.stderr.toString("utf8"))}`;
		}
		const forwarded = await runBounded(
			{
				file: this.#sshPath,
				args: [
					...sshOptionArgv(this.#controlDirectory),
					"-O",
					"forward",
					"-R",
					`${remoteSocketPath}:${localSocketPath}`,
					this.#host,
				],
				cwd: undefined,
				env: this.#localEnvironment,
			},
			OperationDeadline.in(PROBE_TIMEOUT_MS),
			new CancellationToken(),
			PROBE_LIMITS,
		);
		if (forwarded.code !== 0) {
			const said = lastLine(forwarded.stderr.toString("utf8"));
			this.#lastFailure = said;
			return `DevHub's control socket could not be forwarded to ${remoteSocketPath} on ${this.#host}: ${said}`;
		}
		const bound = await this.#sh(`test -S ${shellQuote(remoteSocketPath)}`);
		if (bound.code !== 0) {
			const said = `ssh reported the forward of ${remoteSocketPath} on ${this.#host} succeeded, but nothing is listening there`;
			this.#lastFailure = said;
			return said;
		}
		return undefined;
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
			// Names and never values. A reading is written into a log and pasted
			// into an issue, and a person's login environment is where their
			// tokens are — but "which variables DevHub is putting on every remote
			// command" is exactly the question a wrong `PATH` or a missing
			// `LANG` raises, and it is answerable without reading one of them.
			loginEnvironmentNames: Object.keys(this.#login ?? {}).sort(),
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
		// Read again on the next connection rather than remembered across one: a
		// person who fixes their `~/.profile` and reconnects has fixed it.
		this.#login = undefined;
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

	/**
	 * One small POSIX script on the other machine, bounded like everything else.
	 *
	 * Deliberately `#run` and not `exec`: these are DevHub's own scripts, made of
	 * POSIX tools named the same everywhere, so they need nothing a person's
	 * profile adds — and reading that profile is itself one of them, which would
	 * otherwise be a command waiting on its own answer.
	 */
	#sh(
		script: string,
		extra: {
			stdin?: Uint8Array;
			stdoutBytes?: number;
		} = {},
	): Promise<ExecResult> {
		return this.#run({
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
