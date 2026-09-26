/**
 * A machine that is not this one, reached by running POSIX `sh` on it.
 *
 * Everything DevHub does to another machine it does by composing a small
 * POSIX shell script and getting its output back. That is true of a host
 * behind `ssh` and it is true of anything else DevHub might one day run a
 * shell in — the transport differs, the scripts do not. So the scripts live
 * here, once, and the transport is the one thing a subclass supplies.
 *
 * The seam is deliberately narrow, and it is narrow in a way that is checkable:
 * a subclass says how to *run* one composed script (`run`), what to call the
 * machine in a sentence (`machineName`), where its tmux comes from
 * (`delivery`), and how to make DevHub's control socket answerable over there
 * (`publishControlSocket`). Everything else on `Runtime` — `$HOME`, the login
 * environment, the eight filesystem operations, the `HEAD` poll, the terminal
 * launcher, the tmux install — is composed from those four and is identical on
 * every machine, because a `cd -P && pwd -P` does not know what carried it.
 *
 * Three rules travel with the scripts and are the reason they read as they do.
 *
 * **A remote command line is one shell word, not an argv.** `ssh host -- a b c`
 * joins its words with spaces and hands the string to a login shell, and a
 * `docker exec sh -c` is the same shape. So every operation composes the script
 * itself, with `shellQuote` (`quote.ts`) and nothing else. A branch name with a
 * space, a quote or a `;` in it survives, exactly as it does locally through
 * `spawn`.
 *
 * **There is no remote `fs`.** `stat`, `readdir`, `realpath` and the rest are
 * one exec each of a small POSIX script — not `sftp`, which would be a second
 * connection kind, a second auth surface and a second way to fail for no
 * capability the scripts lack. The price is that a failure arrives as a
 * *message* rather than as an errno, so there is one place that turns the one
 * back into the other (`errnoFromMessage`), because `worktreeFolder.ts` reads
 * `EACCES` and "already gone" differently and must keep doing so on every
 * machine.
 *
 * **Secrets never appear in argv.** Argv is world-readable in `ps` on the far
 * machine as much as on this Mac, and the composed script *is* the far argv of
 * the shell that runs it. So nothing secret is ever composed into it — that is
 * what `ExecRequest.stdin` is for, and it is why `writeTextFile` pipes its
 * content instead of echoing it.
 */

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { errorWireAt, TypedFailure, withSummary } from "../../model/wire.js";
import { OperationDeadline } from "../terminal/command.js";
import { CancellationToken, portFailure } from "../terminal/ports.js";
import type { Pty } from "../terminal/pty.js";
import {
	remoteTerminalPaths,
	remoteCliScript,
	terminalLauncherScript,
} from "../terminal/launcher.js";
import type { SettingsResolvedRuntimeWire } from "../../ipc/settings.js";
import { gitDirectoryOf } from "./gitDirectory.js";
import { openByteStream, type StreamLaunch } from "./byteStream.js";
import { permanent } from "./remoteServer.js";
import { shellQuote } from "./quote.js";
import {
	NO_USER_TMUX_CONFIG,
	RuntimeFileError,
	userTmuxConfigDigest,
	type ByteStream,
	type DirEntry,
	type ExecLimits,
	type ExecRequest,
	type ExecResult,
	type FileKind,
	type PtyRequest,
	type RuntimeCadence,
	type ShellMachineId,
	type RuntimeReading,
	type StreamEnd,
	type StreamRequest,
	type TerminalLauncher,
	type TerminalLauncherSpec,
	type TmuxProgram,
	type UserTmuxConfig,
	type Watcher,
} from "./runtime.js";
import type { TmuxDelivery } from "./tmuxDelivery.js";

/**
 * The prefix every message composed into a remote script carries.
 *
 * A remote command may legitimately exit 127, and a remote command's own stderr
 * may legitimately say "not found". Neither can say this, because DevHub wrote
 * it, which is what makes "the program was not there" distinguishable from "the
 * program ran and was unhappy" over a transport that only returns a number.
 */
export const SCRIPT_MARKER = "devhub-exec:";

/** What `ExecRequest.env` keys may look like, because they become shell names. */
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Bounds for the small answers the filesystem scripts give. */
export const PROBE_LIMITS: ExecLimits = {
	stdoutBytes: 1024 * 1024,
	stderrBytes: 8 * 1024,
	overflow: { kind: "truncate" },
};

/** How long a filesystem probe may go without an answer. */
export const PROBE_TIMEOUT_MS = 20_000;

/**
 * How much of a login environment DevHub will read.
 *
 * A profile that exports a megabyte is a profile with a bug in it, and reading
 * it would put that megabyte on the command line of every command afterwards.
 */
const LOGIN_ENVIRONMENT_BYTES = 256 * 1024;

/**
 * How often a remote `HEAD` is asked about.
 *
 * There is no inotify across a network, so this is a poll, and a poll's
 * interval is a trade a constant has to make once: two seconds is under the
 * time it takes a person to look away from a checkout they have just switched,
 * and one exec every two seconds over a multiplexed connection is nothing next
 * to the reconcile loop above it.
 */
export const HEAD_WATCH_POLL_MS = 2000;

/**
 * The variables a login shell sets that a connection must not carry.
 *
 * Every one of them describes *the login that was read*, not the command about
 * to run: which socket it came in on, which tty it had, how deep its shell was
 * nested, which directory it happened to start in. Carrying them across would
 * tell a program on the far machine it is attached to a terminal that closed
 * minutes ago, and would override the ones the transport, tmux and the pty each
 * set correctly for themselves. What is wanted from a login shell is the part a
 * person put there — `PATH` above all — and this is the list of everything that
 * is not that.
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
export interface RemoteMachine {
	readonly home: string;
	readonly platform: string;
	/** `uname -m`, as the tarball names it: `x64` or `arm64`. */
	readonly architecture: string;
	readonly login: Readonly<Record<string, string>>;
}

/** `uname -s` as the download URL spells it. */
export function platformName(uname: string): string {
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
export function architectureName(uname: string): string {
	if (uname === "x86_64" || uname === "amd64") return "x64";
	if (uname === "aarch64" || uname === "arm64") return "arm64";
	return uname;
}

export function describeFailure(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
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

export function lastLine(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines[lines.length - 1] ?? "";
}

/**
 * A stream whose program was never there, in the words `exec` uses for it.
 *
 * Only the marker counts, for the reason `SCRIPT_MARKER` exists: a program
 * that ran and exited 127 of its own accord is an answer, not a refusal.
 */
function scriptRefusal(end: StreamEnd): Error | undefined {
	if (end.code !== 127) return undefined;
	const stderr = end.stderr.toString("utf8");
	if (!stderr.includes(SCRIPT_MARKER)) return undefined;
	return portFailure("unavailable", { detail: lastLine(stderr) });
}

export function unsupportedPlatformFailure(
	machine: string,
	uname: string,
): TypedFailure {
	// Permanent: an architecture is not a thing that changes while a workbench
	// waits, so a resolve that retried this would retry it five times and then
	// say the same sentence.
	return permanent(
		new TypedFailure(
			withSummary(
				errorWireAt("workspace_unavailable"),
				`DevHub supports Linux and macOS hosts, and ${machine} reports ` +
					`${uname.length === 0 ? "nothing" : uname}.`,
			),
		),
	);
}

/**
 * The half of a `Runtime` that is the same on every machine DevHub shells into.
 *
 * What a subclass owes is below, and nothing else: four members, of which two
 * are one line each. What it gets is the other twenty-odd, written once.
 */
export abstract class RemoteShellRuntime {
	abstract readonly id: ShellMachineId;
	abstract readonly where: string;
	abstract readonly cadence: RuntimeCadence;
	abstract reading(): RuntimeReading;
	abstract resumed(): void;
	abstract spawnPty(request: PtyRequest): Pty;

	/**
	 * One composed script on the far machine, however it gets there.
	 *
	 * The whole of the transport. It is handed a fully-formed `ExecRequest` —
	 * the caller's argv, cwd and environment, already merged with the login
	 * environment — and owes an `ExecResult`; how it becomes a command line over
	 * there is the subclass's business and nothing above this line's.
	 */
	protected abstract run(request: ExecRequest): Promise<ExecResult>;

	/**
	 * How one composed script becomes a long-lived process on this Mac that
	 * runs it over there, with its stdin and stdout as pipes.
	 *
	 * The stream's half of `run`: the transport, and nothing else. What the
	 * script is, the environment it runs in and what a 127 means are composed
	 * once, in `spawnStream`, for every machine.
	 */
	protected abstract streamLaunch(script: string): Promise<StreamLaunch>;

	/** What to call this machine in a sentence: a host name, a container label. */
	protected abstract get machineName(): string;

	/**
	 * Where this machine's tmux comes from — an invariant, not a case.
	 *
	 * The registry is the only thing that builds a runtime and it always passes
	 * one, so a runtime without one is a construction bug and nothing the far
	 * machine did. A subclass that has none throws rather than falling back to
	 * the path it *would* have been given: a guessed install directory is a
	 * second statement of a product fact, and the failure it produces would
	 * arrive as "that machine has no tmux" — a sentence about the wrong machine
	 * entirely.
	 */
	protected abstract delivery(): TmuxDelivery;

	/**
	 * DevHub's control socket, made answerable at `remoteSocketPath`.
	 *
	 * `undefined` when it is answerable; the sentence saying why it is not,
	 * otherwise. The far machine's launcher and `devhub` shim are written either
	 * way — run from over there they say the same fact in the place a person is
	 * actually looking — so this is never a throw.
	 *
	 * The mechanism is the one thing that cannot be shared: ssh reverse-forwards
	 * it onto the host, and anything without a reverse forward has to relay it.
	 */
	protected abstract publishControlSocket(
		remoteSocketPath: string,
		localSocketPath: string,
	): Promise<string | undefined>;

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
	protected login: Readonly<Record<string, string>> | undefined;
	/** The last thing that went wrong on this machine, for `devhub --metrics`. */
	protected lastFailure: string | undefined;

	#remote: Promise<RemoteMachine> | undefined;
	#launcher: Promise<TerminalLauncher> | undefined;
	#tmux: Promise<TmuxProgram> | undefined;

	/**
	 * `$HOME` on that machine, and the check that it is a machine DevHub speaks.
	 *
	 * Both come from one exec because both are asked once and cached for the life
	 * of the runtime, and because the first use is the honest moment to refuse a
	 * machine DevHub cannot compose POSIX shell for. Every command in this file is
	 * POSIX shell and tmux does not run on Windows, so the refusal is a fact
	 * about the design rather than an untested path.
	 */
	async home(): Promise<string> {
		return (await this.describeRemote()).home;
	}

	/**
	 * What a command on this machine runs in: the machine's own login
	 * environment.
	 *
	 * Read once from its own login shell (`#readLoginEnvironment`) and already
	 * the base of every `exec` and every pty here — this is that same answer,
	 * said out loud, so that a caller who needs to *compose* something on top of
	 * it (a pane's PATH, a tmux server's environment) builds it from the far
	 * machine's own and never from this Mac's. See `Runtime.environment`.
	 */
	async environment(): Promise<Readonly<Record<string, string>>> {
		return (await this.describeRemote()).login;
	}

	async platform(): Promise<string> {
		return (await this.describeRemote()).platform;
	}

	protected describeRemote(): Promise<RemoteMachine> {
		if (this.#remote) return this.#remote;
		const pending = (async () => {
			const result = await this.sh(
				`printf '%s\\n%s\\n%s\\n%s\\n' "$HOME" "$(uname -s)" "$(uname -m)" "$SHELL"`,
			);
			const [home = "", platform = "", machine = "", shell = ""] = result.stdout
				.toString("utf8")
				.split("\n");
			if (platform !== "Linux" && platform !== "Darwin") {
				throw unsupportedPlatformFailure(this.machineName, platform);
			}
			const login = await this.#readLoginEnvironment(shell);
			this.login = login;
			return {
				home,
				platform,
				architecture: architectureName(machine),
				login,
			};
		})();
		// A machine that was down when the first command went out must be asked
		// again by the second: a rejected promise left in the field would answer
		// every later command with the failure of the first one, and a machine
		// that came back would never be tried again.
		pending.catch(() => {
			if (this.#remote === pending) this.#remote = undefined;
		});
		this.#remote = pending;
		return pending;
	}

	/** Ask the far machine again: a reconnection, or a profile somebody fixed. */
	protected forgetRemote(): void {
		this.#remote = undefined;
		this.login = undefined;
	}

	/**
	 * What a program on this machine runs inside.
	 *
	 * The environment a non-login shell gives a command is not the one a person
	 * gets when they log in: `~/.profile` has not run and `PATH` is whatever the
	 * default is — typically `/bin:/usr/bin` and the system directories, and
	 * nothing a person has added. Every "works in my terminal, not in DevHub"
	 * report about a far machine is that one fact. So the login environment is
	 * read once, from the login shell itself, and every command DevHub runs there
	 * is given it.
	 *
	 * Three ways of asking, in order, because the answer matters more than the
	 * spelling: the person's own `$SHELL` with `-lc 'env -0'`, then `/bin/sh`
	 * with the same, then `/bin/sh -lc 'env'` for an `env` with no `-0`. The
	 * first that answers with a `PATH` is the answer; a machine where none of
	 * them does is a machine DevHub refuses, by name, rather than running
	 * commands in an environment it could not read.
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
			const result = await this.sh(attempt.script, {
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
			`DevHub could not read the login environment on ${this.machineName}: ` +
				`neither ${shell === "" ? "the login shell" : shell} nor /bin/sh ` +
				`answered 'env' with a PATH, so it cannot tell where the programs it ` +
				`runs there are.`,
		);
	}

	/**
	 * One command on the other machine, in that machine's own environment.
	 *
	 * The caller's own variables win over the person's, and DevHub's own
	 * `DEVHUB_*` are the caller's: a runtime that let a profile's `PATH`
	 * override the one a command was given would be answering a question the
	 * caller had already answered.
	 */
	async exec(request: ExecRequest): Promise<ExecResult> {
		const { login } = await this.describeRemote();
		return this.run({ ...request, env: { ...login, ...request.env } });
	}

	/**
	 * A long-lived program on the other machine, in its own environment.
	 *
	 * The same composed script `exec` sends — so a missing program or
	 * directory is the same `unavailable`, in the same words — handed to the
	 * transport's long-lived form instead of its one-shot one. The login
	 * environment is waited for inside the stream, which is why this can be
	 * synchronous where `spawnPty` has to find it already read.
	 */
	spawnStream(request: StreamRequest): ByteStream {
		return openByteStream(async () => {
			const { login } = await this.describeRemote();
			const launch = await this.streamLaunch(
				remoteScript({
					argv: request.argv,
					cwd: request.cwd,
					env: { ...login, ...request.env },
				}),
			);
			return {
				...launch,
				refusal: (end) => launch.refusal?.(end) ?? scriptRefusal(end),
			};
		}, request.cancel);
	}

	/**
	 * What a configured name means on the far machine, asked of the far machine.
	 *
	 * `command -v` under the *login* environment, which is the whole point: the
	 * `PATH` a non-interactive command gets does not have the person's
	 * `~/.local/bin` or their Homebrew in it, so a lookup under it would answer
	 * "not there" for a program that is plainly there when they type its name.
	 * One round trip per configured program per machine per DevHub start, and the
	 * answer is an absolute path — the same shape the local runtime gives, so
	 * the Settings window prints one thing and the launcher runs the same thing.
	 *
	 * A name that cannot be found is `unavailable` with the directories that
	 * were searched, in that machine's own `PATH` order, because a search nobody
	 * can see is a search nobody can correct — and the directories are the far
	 * machine's, which is the fact a person is missing when the local answer
	 * looked fine.
	 */
	async resolveProgram(
		configured: string,
		// This machine's PATH, which is not this question's answer: the search
		// happens over there, under the environment read from over there.
		_searchPath?: string,
	): Promise<SettingsResolvedRuntimeWire> {
		const { login } = await this.describeRemote();
		const path = login["PATH"] ?? "";
		const result = await this.run({
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
			where: this.where,
			lookup: configured.includes("/")
				? { kind: "explicit", path: configured }
				: {
						kind: "path",
						directories: path.split(":").filter((entry) => entry.length > 0),
					},
		};
	}

	/**
	 * The tmux DevHub put on this machine, put there now if it is not already.
	 *
	 * `runtimes.tmux` is not consulted and the far machine's own tmux is never
	 * used. That is a decision and not an oversight: tmux's control output — the
	 * `list-sessions` format, `capture-pane -e`, `display-message -p` — differs
	 * between versions in ways that surface as an Agent whose output is subtly
	 * wrong rather than as an error, and this adapter is written against one
	 * version. The machine that made this necessary has no tmux at all and no way
	 * for its owner to install one. One version, published by DevHub, is the
	 * version the tests are about.
	 *
	 * The install is four steps and every one of them names the machine when it
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
		// which tmux runs on a far machine is not a thing a person configures per
		// machine, and the search path here names nothing there.
		_configured?: string,
		_searchPath?: string,
	): Promise<TmuxProgram> {
		// Outside the catch below: a missing delivery is not something the next
		// window should retry, and reporting it as "tmux is unavailable on that
		// machine" would send whoever reads it to look at the machine.
		const delivery = this.delivery();
		this.#tmux ??= this.#installTmux(delivery);
		try {
			return await this.#tmux;
		} catch (failure: unknown) {
			// Tried again by the next window: a machine that had no route to the
			// release when the first one opened may have one by the second.
			this.#tmux = undefined;
			return { kind: "unavailable", reason: describeFailure(failure) };
		}
	}

	async #installTmux(delivery: TmuxDelivery): Promise<TmuxProgram> {
		const { home, platform, architecture } = await this.describeRemote();
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
					`${this.machineName} (${target}): ${describeFailure(failure)}`,
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
		const unpack = await this.sh(
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
					`on ${this.machineName}: ${lastLine(unpack.stderr.toString("utf8"))}`,
			);
		}
		if (!(await this.#tmuxAnswers(program))) {
			throw new Error(
				`DevHub unpacked tmux ${delivery.version} into ${directory} on ` +
					`${this.machineName}, but ${program} -V did not answer — the binary ` +
					`that came out cannot run on that machine`,
			);
		}
		return { kind: "resolved", path: program, environment };
	}

	/** Whether there is a tmux at this path that this machine can run. */
	async #tmuxAnswers(program: string): Promise<boolean> {
		const result = await this.sh(`exec ${shellQuote(program)} -V`);
		return result.code === 0;
	}

	/**
	 * DevHub's tmux config, carried across on every connection.
	 *
	 * The file lives on this Mac — it is beside `settings.toml`, where a person
	 * edits it — and tmux reads it on the far machine, so it has to be *there*.
	 * Copied rather than cached: it is a few hundred bytes over a connection that
	 * is already open, and the alternative is a rule about when a copy has gone
	 * stale, which is a rule that will be wrong the first time somebody edits
	 * their config and reconnects to find nothing changed.
	 *
	 * A config that is no longer here is removed from over there for the same
	 * reason. "Always current" has to mean both directions or it means neither.
	 */
	async userTmuxConfig(localPath: string): Promise<UserTmuxConfig> {
		const { home } = await this.describeRemote();
		const directory = posix.join(home, this.delivery().directory);
		const remotePath = posix.join(directory, "tmux.conf");
		const text = await readFile(localPath, "utf8").catch(() => undefined);
		if (text === undefined) {
			await this.removeTree(remotePath);
			return NO_USER_TMUX_CONFIG;
		}
		await this.makeDirectory(directory);
		await this.writeTextFile(remotePath, text, 0o600);
		return { path: remotePath, digest: userTmuxConfigDigest(text) };
	}

	/**
	 * `~/.devhub/tmp` on the far machine, made 0700 the first time it is asked
	 * for.
	 *
	 * Under the home directory rather than `/tmp`, for the reason everything
	 * else DevHub writes over there is: `/tmp` on a shared machine is a directory
	 * other people can write, and a bootstrap config another account could
	 * replace is a tmux server another account could configure.
	 */
	async scratchDirectory(): Promise<string> {
		const { home } = await this.describeRemote();
		const path = posix.join(home, ".devhub", "tmp");
		const result = await this.sh(`exec mkdir -p -m 700 -- ${shellQuote(path)}`);
		if (result.code !== 0) throw this.fileError(path, result);
		return path;
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
		const result = await this.sh(
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
		if (result.code !== 0) throw this.fileError(path, result);
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
		const result = await this.sh(
			`exec head -c ${String(maxBytes)} -- ${shellQuote(path)}`,
			{ stdoutBytes: maxBytes },
		);
		if (result.code !== 0) throw this.fileError(path, result);
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
		const result = await this.sh(
			`: > ${quoted} && chmod ${mode.toString(8).padStart(4, "0")} ${quoted} && exec cat > ${quoted}`,
			{ stdin: Buffer.from(text, "utf8") },
		);
		if (result.code !== 0) throw this.fileError(path, result);
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
		const result = await this.sh(
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
		if (result.code !== 0) throw this.fileError(path, result);
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
		const result = await this.sh(
			[
				`if [ -d ${quoted} ]; then exec ls -A1p -- ${quoted}; fi`,
				`if [ -e ${quoted} ]; then echo "ls: ${path}: Not a directory" >&2; exit 1; fi`,
				`echo "ls: ${path}: No such file or directory" >&2; exit 1`,
			].join("\n"),
		);
		if (result.code !== 0) throw this.fileError(path, result);
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
		const result = await this.sh(`exec rm -rf -- ${shellQuote(path)}`);
		if (result.code !== 0) throw this.fileError(path, result);
	}

	async makeDirectory(path: string): Promise<void> {
		const result = await this.sh(`exec mkdir -p -- ${shellQuote(path)}`);
		if (result.code !== 0) throw this.fileError(path, result);
	}

	/**
	 * A path with its symlinks resolved.
	 *
	 * `cd && pwd -P` rather than `realpath` or `readlink -f`, because the shell
	 * has done this since before either tool existed and neither is on every
	 * machine — `realpath` is not in macOS before 12.3 and `readlink -f` is not
	 * in BSD's `readlink` at all. One code path on every machine beats two that
	 * are chosen by a probe.
	 */
	async realpath(path: string): Promise<string> {
		const quoted = shellQuote(path);
		const result = await this.sh(
			[
				`if [ -d ${quoted} ]; then cd -- ${quoted} && exec pwd -P; fi`,
				`if [ ! -e ${quoted} ]; then echo "realpath: ${path}: No such file or directory" >&2; exit 1; fi`,
				`cd -- "$(dirname -- ${quoted})" || exit 1`,
				`printf '%s/%s\\n' "$(pwd -P)" "$(basename -- ${quoted})"`,
			].join("\n"),
		);
		if (result.code !== 0) throw this.fileError(path, result);
		return result.stdout.toString("utf8").trim();
	}

	/**
	 * The honest replacement for `fs.watch`: a poll, said out loud.
	 *
	 * What is polled is the *content* of `HEAD`, `packed-refs` and every loose
	 * ref, reduced to a `cksum` on the far side so that the answer is one short
	 * line however many refs there are. Content rather than mtime because
	 * `ls`-grade timestamps are minute-resolution on some machines, and a `HEAD`
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
					this.lastFailure = describeFailure(failure);
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
		const result = await this.sh(
			[
				`cd -- ${shellQuote(gitDirectory)} 2>/dev/null || { echo gone; exit 0; }`,
				`{ printf 'HEAD '; cat HEAD 2>/dev/null; printf '\\npacked-refs ';`,
				`  cat packed-refs 2>/dev/null; printf '\\n';`,
				`  find refs -type f -exec sh -c 'for f do printf "%s " "$f"; cat -- "$f"; done' sh {} + 2>/dev/null;`,
				`} | cksum`,
			].join("\n"),
		);
		if (result.code !== 0) throw this.fileError(gitDirectory, result);
		return result.stdout.toString("utf8").trim();
	}

	/**
	 * The `devhub-terminal` a workbench *on that machine* runs, installed once.
	 *
	 * The problem this solves, stated exactly: a remote window's pty host runs on
	 * the far machine, so the profile's `path` is a path over there, and the
	 * process it starts can reach neither DevHub's launcher nor DevHub's control
	 * socket. Both halves are carried across rather than reinvented — the
	 * launcher script is `terminalLauncherScript`, the same text, with the far
	 * machine's own paths in it, and the socket is DevHub's own, made answerable
	 * over there by `publishControlSocket`. So there is one protocol and one
	 * answering side, and "a terminal is a session DevHub named" is one sentence
	 * rather than two implementations that agree for now.
	 *
	 * The Node that runs it is the REH's own (`~/<serverDataFolderName>/bin/
	 * <commit>/node`). It is the one Node a machine with a workbench on it is
	 * certain to have, it is the same commit the client states, and it needs no
	 * probing — a `command -v node` would find whatever a login shell happened
	 * to have on its PATH, which is a different Node on every machine and none at
	 * all on some.
	 *
	 * The program is one bundled file (`readTerminalEntryBundle`), so this is
	 * three writes at the first window on a machine, once per DevHub start, on a
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
				`this DevHub was built from a source checkout and states no commit, so there is no ${spec.serverDataFolderName} directory on ${this.machineName} it can name — which is the same reason it can open no workbench there`,
			);
		}
		const paths = remoteTerminalPaths({
			home: await this.home(),
			serverDataFolderName: spec.serverDataFolderName,
			serverCommit: spec.serverCommit,
			controlSocketPath: spec.controlSocketPath,
			entryName: spec.entryName,
			cliEntryName: spec.cliEntryName,
		});
		// 0700, like the control directory on this Mac and for the same reason:
		// what is under it is a path to a socket that runs commands as this user.
		const made = await this.sh(
			`mkdir -p -- ${shellQuote(paths.entryRoot)} ${shellQuote(paths.cliBinDirectory)} && chmod 700 ${shellQuote(paths.directory)} ${shellQuote(paths.entryRoot)} ${shellQuote(paths.cliBinDirectory)}`,
		);
		if (made.code !== 0) throw this.fileError(paths.directory, made);
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
		// The `devhub` command, beside the asking program and run by the same
		// Node, over the same socket. Two files rather than one because they
		// are two programs — the launcher prints an argv and exits, `devhub`
		// opens a file and may wait for it — and bundling them together would
		// be one program with two entry points and a flag to choose.
		await this.writeTextFile(paths.cliEntry, spec.cliText, 0o600);
		await this.writeTextFile(
			paths.cli,
			remoteCliScript({
				execPath: paths.node,
				cliScript: paths.cliEntry,
				socketPath: paths.socket,
				machine: this.id,
			}),
			0o755,
		);
		return {
			path: paths.launcher,
			unreachable: await this.publishControlSocket(
				paths.socket,
				spec.controlSocketPath,
			),
			binDirectory: paths.cliBinDirectory,
		};
	}

	/** Forget the launcher install, so the next window does it again. */
	protected forgetLauncher(): void {
		this.#launcher = undefined;
	}

	/**
	 * One small POSIX script on the other machine, bounded like everything else.
	 *
	 * Deliberately `run` and not `exec`: these are DevHub's own scripts, made of
	 * POSIX tools named the same everywhere, so they need nothing a person's
	 * profile adds — and reading that profile is itself one of them, which would
	 * otherwise be a command waiting on its own answer.
	 */
	protected sh(
		script: string,
		extra: {
			stdin?: Uint8Array;
			stdoutBytes?: number;
		} = {},
	): Promise<ExecResult> {
		return this.run({
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

	protected fileError(path: string, result: ExecResult): RuntimeFileError {
		const said = lastLine(result.stderr.toString("utf8"));
		return new RuntimeFileError(path, errnoFromMessage(said) ?? said);
	}
}
