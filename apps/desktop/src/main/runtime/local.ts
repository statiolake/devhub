/**
 * This machine, behind the `Runtime` interface.
 *
 * Every method here is code that already existed somewhere else, moved rather
 * than rewritten: `exec` is `runBounded`, `spawnPty` is `openPty`, the probes
 * are the `node:fs/promises` calls the callers used to make inline, and
 * `watchGitDirectory` is the pair of `fs.watch`es `HeadWatcher` used to arm for
 * itself. That is deliberate, and it is the property that makes the seam
 * boring: if a local Workspace behaves differently after this file exists,
 * something was rewritten that should not have been.
 *
 * There is exactly one instance (`registry.ts`), because there is exactly one
 * of this machine. It keeps no connection and can lose nothing, so unlike the
 * remote arm it has no reconnect and no cache to rebuild — its `reading()` is
 * a count and a latency that will read as zero, which is the true answer.
 */

import { Buffer } from "node:buffer";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { REPOSITORY_FOCUS_REFRESH_MIN_INTERVAL_MS } from "./cadence.js";
import {
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { RollingTally } from "../diagnostics/rollingTally.js";
import { runBounded } from "../terminal/command.js";
import { openPty, type Pty, type PtyPlan } from "../terminal/pty.js";
import { gitDirectoryOf } from "./gitDirectory.js";
import { bundledBash, bundledBashMissing } from "./bundledBash.js";
import { claudeShellEnvironment } from "./agentShell.js";
import { openByteStream } from "./byteStream.js";
import { resolveExecutable } from "../shell/runtimes.js";
import { launchEnvironment } from "../shell/loginEnvironment.js";
import {
	bundledNeovim,
	bundledNeovimMissing,
} from "../editor/bundledNeovim.js";
import { bundledTmux, bundledTmuxMissing } from "../terminal/bundledTmux.js";
import { type SettingsResolvedRuntimeWire } from "../../ipc/settings.js";
import {
	NO_USER_TMUX_CONFIG,
	RuntimeFileError,
	userTmuxConfigDigest,
	type ByteStream,
	type DirEntry,
	type ExecRequest,
	type ExecResult,
	type FileKind,
	type LoopbackForward,
	type PtyRequest,
	type Runtime,
	type RuntimeCadence,
	type MachineCommand,
	type RuntimeId,
	type RuntimeReading,
	type StreamRequest,
	type TerminalLauncher,
	type TerminalLauncherSpec,
	type NeovimProgram,
	type TmuxProgram,
	type UserTmuxConfig,
	type Watcher,
} from "./runtime.js";
import { failureText } from "../../model/wire.js";

/**
 * What the loops cost on this machine.
 *
 * The numbers are the ones the loops have always used — `agentReconciler.ts`'s
 * 300 ms and `repositoryStatus.ts`'s minute — and `headWatchPollMs` is
 * `undefined` because a local `HEAD` is a real filesystem event and not
 * something anybody has to ask about. Until the loops are taught to read a
 * cadence they still hold their own copies of these two numbers; when they are,
 * these are the copies that survive.
 *
 * `repositoryFocusRefreshMinIntervalMs` is the odd one out: it is not how often
 * a loop runs but how recently one must have run for focusing the window to
 * skip its own round, and it is stated in `cadence.ts` rather than here because
 * the remote arm needs the same rule with a different number.
 */
export const LOCAL_CADENCE: RuntimeCadence = {
	reconcileIntervalMs: 300,
	repositoryPollMs: 60 * 1000,
	repositoryFocusRefreshMinIntervalMs: REPOSITORY_FOCUS_REFRESH_MIN_INTERVAL_MS,
	headWatchPollMs: undefined,
};

/** How many recent round trips a median is taken over. */
const LATENCY_SAMPLES = 16;
const A_MINUTE = 60 * 1000;

/** The errnos that mean "there is nothing at this path", and only those. */
function meansAbsent(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** The variables that have a value, which is all a shell's environment is. */
function definedOnly(
	environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const defined: Record<string, string> = {};
	for (const [name, value] of Object.entries(environment)) {
		if (value !== undefined) defined[name] = value;
	}
	return defined;
}

function fileError(path: string, error: unknown): RuntimeFileError {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return new RuntimeFileError(path, code ?? failureText(error), {
		cause: error,
	});
}

export class LocalRuntime implements Runtime {
	#scratchDirectory: string | undefined;
	#environment: Readonly<Record<string, string>> | undefined;

	readonly id: RuntimeId = "local";
	readonly where = "";
	readonly cadence = LOCAL_CADENCE;

	/** Round-trip times of the last few execs, newest last. */
	readonly #latencies: number[] = [];
	/**
	 * Execs of the last minute, counted rather than listed: a rate is a count,
	 * and a list of every exec since launch is what this used to be. See
	 * `diagnostics/rollingTally.ts`.
	 */
	readonly #recentExecs = new RollingTally(A_MINUTE);
	#lastFailure: string | undefined;

	home(): Promise<string> {
		return Promise.resolve(homedir());
	}

	/**
	 * What a command on this machine runs in: the frozen launch environment.
	 *
	 * The same one every DevHub child has always had — this Mac's login
	 * environment with DevHub's own runtime variables taken back out
	 * (`loginEnvironment.ts`) — read from `process.env`, which is where the
	 * import landed. Read once and kept, because a terminal must not observe an
	 * environment that changed under it.
	 *
	 * The undefined values `process.env` can hold are dropped rather than
	 * carried: "this machine's environment" is what a shell here would have, and
	 * a shell has no variable whose value is undefined.
	 */
	environment(): Promise<Readonly<Record<string, string>>> {
		this.#environment ??= Object.freeze(
			definedOnly(launchEnvironment(process.env)),
		);
		return Promise.resolve(this.#environment);
	}

	/**
	 * Look the configured name up the way a shell on this machine would.
	 *
	 * The same resolver the Settings window's Runtimes section shows, so "what
	 * DevHub will run" and "what DevHub says it will run" cannot come to
	 * disagree.
	 */
	resolveProgram(
		configured: string,
		searchPath: string,
	): Promise<SettingsResolvedRuntimeWire> {
		return resolveExecutable(configured, searchPath);
	}

	/**
	 * The tmux inside the app (`terminal/bundledTmux.ts`), never the PATH's —
	 * as on a host, where DevHub delivers the same version and ignores the
	 * host's. Nothing to install and nothing to add to the environment: the
	 * terminfo it reads is this machine's own.
	 */
	tmuxProgram(): Promise<TmuxProgram> {
		const path = bundledTmux();
		return Promise.resolve(
			path === undefined
				? { kind: "unavailable", reason: bundledTmuxMissing() }
				: { kind: "resolved", path, environment: {} },
		);
	}

	/** The Neovim inside the app (`editor/bundledNeovim.ts`), never the PATH's. */
	neovimProgram(): Promise<NeovimProgram> {
		const path = bundledNeovim();
		return Promise.resolve(
			path === undefined
				? { kind: "unavailable", reason: bundledNeovimMissing() }
				: { kind: "resolved", path },
		);
	}

	/**
	 * DevHub's own bash (`out/bash`, `bundledBash.ts`) as `CLAUDE_CODE_SHELL`,
	 * for the Agent's process alone (`agentShell.ts`): Claude Code runs its Bash
	 * tool in the bash DevHub carries, never in whatever bash or zsh the PATH
	 * happens to have (`docs/bundled-binaries.md`). The person's own login
	 * shell, tmux's `default-shell` and every terminal keep theirs.
	 */
	claudeShell(): Promise<Readonly<Record<string, string>>> {
		const bash = bundledBash();
		if (bash === undefined)
			return Promise.reject(new Error(bundledBashMissing()));
		return Promise.resolve(claudeShellEnvironment(bash));
	}

	/**
	 * The config file itself, because this is the machine it is on.
	 *
	 * The whole of the local arm: DevHub's config directory is here, so the path
	 * a person edits is the path tmux sources. The remote arm answers the same
	 * question with a copy, which is the only difference between them.
	 */
	async userTmuxConfig(localPath: string): Promise<UserTmuxConfig> {
		// Read and not `stat`: the answer carries which config this is, and
		// nothing but the bytes can say that. It is a few hundred bytes on this
		// machine, and a path that is a directory or unreadable is the same
		// "there is no config here" as a path with nothing at it.
		const text = await readFile(localPath, "utf8").catch(() => undefined);
		if (text === undefined) return NO_USER_TMUX_CONFIG;
		return { path: localPath, digest: userTmuxConfigDigest(text) };
	}

	async exec(request: ExecRequest): Promise<ExecResult> {
		const file = request.argv[0];
		if (file === undefined) {
			throw new Error("a runtime exec needs a program to run");
		}
		// Every command DevHub runs is a fork and an exec. They live for
		// milliseconds, so nothing outside the process can see how many there
		// are; counted here, the rate is a fact rather than a guess.
		activityCounters.record(COUNTER.process(basename(file)));
		const startedAt = Date.now();
		this.#recentExecs.record();
		try {
			const output = await runBounded(
				{
					file,
					args: request.argv.slice(1),
					cwd: request.cwd,
					env: request.env ?? {},
				},
				request.deadline,
				request.cancel,
				request.limits,
				request.stdin,
				request.onOutput,
			);
			this.#record(startedAt);
			return output;
		} catch (failure: unknown) {
			this.#record(startedAt);
			this.#lastFailure = failureText(failure);
			throw failure;
		}
	}

	spawnPty(request: PtyRequest): Pty {
		return openPty(request);
	}

	/** Here a PTY is the program itself, and nothing is held for it. */
	ptyPlan(request: PtyRequest): PtyPlan {
		return { launch: request, ended: () => undefined };
	}

	spawnStream(request: StreamRequest): ByteStream {
		const file = request.argv[0];
		if (file === undefined) {
			throw new Error("a runtime stream needs a program to run");
		}
		activityCounters.record(COUNTER.process(basename(file)));
		return openByteStream(
			() =>
				Promise.resolve({
					file,
					args: request.argv.slice(1),
					cwd: request.cwd,
					env: request.env ?? {},
				}),
			request.cancel,
			request.to,
		);
	}

	/**
	 * This DevHub's own user-data directory, or the system temp directory
	 * before anything has said which profile is running.
	 *
	 * Beside its own state rather than in `/tmp`, because that is where it has
	 * always been written and because two DevHub profiles must not be able to
	 * pick each other's names. The fallback is what the PTY test program gets:
	 * it runs without a profile, and a directory it can write is all this
	 * promises.
	 */
	async scratchDirectory(): Promise<string> {
		return this.#scratchDirectory ?? tmpdir();
	}

	/**
	 * Say where this machine's own files go. Called once, by `setRuntimeProfile`.
	 */
	keepFilesUnder(userDataDirectory: string): void {
		this.#scratchDirectory = userDataDirectory;
	}

	async stat(path: string): Promise<FileKind> {
		try {
			return (await stat(path)).isDirectory() ? "directory" : "file";
		} catch (error: unknown) {
			if (meansAbsent(error)) return "absent";
			throw fileError(path, error);
		}
	}

	/**
	 * Read at most `maxBytes` of a file, as UTF-8.
	 *
	 * Bounded rather than whole, because every caller of this reads a marker —
	 * a `.git` file, a config — and a marker that turned out to be a gigabyte
	 * is a fact about the file, not an amount of memory to spend on it.
	 */
	async readTextFile(path: string, maxBytes: number): Promise<string> {
		let handle;
		try {
			handle = await open(path, "r");
		} catch (error: unknown) {
			throw fileError(path, error);
		}
		try {
			const buffer = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} catch (error: unknown) {
			throw fileError(path, error);
		} finally {
			await handle.close();
		}
	}

	async writeTextFile(path: string, text: string, mode: number): Promise<void> {
		try {
			await writeFile(path, text, { mode });
		} catch (error: unknown) {
			throw fileError(path, error);
		}
	}

	async writeNewTextFile(
		path: string,
		text: string,
		mode: number,
	): Promise<boolean> {
		try {
			await writeFile(path, text, { mode, flag: "wx" });
			return true;
		} catch (error: unknown) {
			if (
				typeof error === "object" &&
				error !== null &&
				(error as { code?: string }).code === "EEXIST"
			) {
				return false;
			}
			throw fileError(path, error);
		}
	}

	async readdir(path: string): Promise<readonly DirEntry[]> {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				directory: entry.isDirectory(),
			}));
		} catch (error: unknown) {
			throw fileError(path, error);
		}
	}

	async removeTree(path: string): Promise<void> {
		try {
			await rm(path, { recursive: true, force: true });
		} catch (error: unknown) {
			throw fileError(path, error);
		}
	}

	async makeDirectory(path: string): Promise<void> {
		try {
			await mkdir(path, { recursive: true });
		} catch (error: unknown) {
			throw fileError(path, error);
		}
	}

	async realpath(path: string): Promise<string> {
		try {
			return await realpath(path);
		} catch (error: unknown) {
			throw fileError(path, error);
		}
	}

	/**
	 * The git directory and its `refs/`, watched.
	 *
	 * The git directory itself, not `HEAD`: git replaces `HEAD` by writing a
	 * temporary file and renaming it over the old one, and a watcher on the
	 * file follows the inode that was renamed away. The directory sees the
	 * rename, and sees `packed-refs` too.
	 */
	async watchGitDirectory(
		worktree: string,
		onChange: () => void,
	): Promise<Watcher> {
		const gitDirectory = await gitDirectoryOf(this, worktree);
		const watchers: FSWatcher[] = [];
		try {
			watchers.push(watch(gitDirectory, () => onChange()));
			// A linked worktree's git directory has a `refs/` only for its own
			// per-worktree refs, and an older git (2.43, say) makes none until
			// there is such a ref; its branches live in the common directory.
			const refs = join(gitDirectory, "refs");
			if (existsSync(refs)) {
				watchers.push(watch(refs, { recursive: true }, () => onChange()));
			}
		} catch (failure: unknown) {
			for (const watcher of watchers) watcher.close();
			throw failure;
		}
		for (const watcher of watchers) {
			// A watcher that dies is a checkout that stopped being watched, and
			// the caller has to be able to say so.
			watcher.on("error", () => onChange());
		}
		return {
			close: () => {
				for (const watcher of watchers) watcher.close();
			},
		};
	}

	/**
	 * Nothing to install: this machine is the one the control socket is bound
	 * on. The remote arm does the work; the seam is what lets a caller ask both
	 * the same question.
	 */
	async terminalLauncher(
		_spec: TerminalLauncherSpec,
	): Promise<TerminalLauncher> {
		// No bin directory: `devhub` on this machine is the launcher the person
		// installed on their own PATH, and DevHub does not get to put another
		// one in front of it.
		return {
			unreachable: undefined,
			binDirectory: undefined,
		};
	}

	/** Already here: the port on this Mac is the port. See `Runtime.forwardLoopbackPort`. */
	forwardLoopbackPort(_port: number): Promise<LoopbackForward> {
		return Promise.resolve({ to: undefined, close: () => Promise.resolve() });
	}

	/** Already here: the socket is its own path. See `Runtime.forwardUnixSocket`. */
	forwardUnixSocket(remotePath: string, _localPath: string): Promise<string> {
		return Promise.resolve(remotePath);
	}

	/** Already here. See `Runtime.commandFromHere`. */
	commandFromHere(command: MachineCommand): Promise<MachineCommand> {
		return Promise.resolve(command);
	}

	/** Nothing is multiplexed to this Mac from this Mac. */
	resumed(): void {
		// Deliberately nothing: see `Runtime.resumed`.
	}

	reading(): RuntimeReading {
		const sorted = [...this.#latencies].sort((left, right) => left - right);
		return {
			id: this.id,
			// This machine is where main is running, so the question does not
			// have a second answer.
			connected: true,
			masterPid: undefined,
			medianRoundTripMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
			reconcileIntervalMs: this.cadence.reconcileIntervalMs,
			execsLastMinute: this.#recentExecs.count(),
			// Nothing to multiplex: main is already on this machine.
			muxSessionsHeld: 0,
			muxSessionsWaiting: 0,
			muxFallbacks: 0,
			// Nothing, and that is the answer rather than a gap: a child of this
			// process already inherits the environment DevHub imported from the
			// login shell at startup (`loginEnvironment.ts`), so this machine adds
			// none of its own on the way past.
			loginEnvironmentNames: [],
			lastFailure: this.#lastFailure,
		};
	}

	#record(startedAt: number): void {
		this.#latencies.push(Date.now() - startedAt);
		if (this.#latencies.length > LATENCY_SAMPLES) this.#latencies.shift();
	}
}
