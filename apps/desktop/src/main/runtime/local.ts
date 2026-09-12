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
import { watch, type FSWatcher } from "node:fs";
import {
	mkdir,
	open,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { runBounded } from "../terminal/command.js";
import { openPty, type Pty } from "../terminal/pty.js";
import { gitDirectoryOf } from "./gitDirectory.js";
import { resolveExecutable } from "../shell/runtimes.js";
import type { SettingsResolvedRuntimeWire } from "../../ipc/settings.js";
import {
	RuntimeFileError,
	type DirEntry,
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
	type Watcher,
} from "./runtime.js";

/**
 * What the loops cost on this machine.
 *
 * The numbers are the ones the loops have always used — `agentReconciler.ts`'s
 * 300 ms and `repositoryStatus.ts`'s minute — and `headWatchPollMs` is
 * `undefined` because a local `HEAD` is a real filesystem event and not
 * something anybody has to ask about. Until the loops are taught to read a
 * cadence they still hold their own copies of these two numbers; when they are,
 * these are the copies that survive.
 */
export const LOCAL_CADENCE: RuntimeCadence = {
	reconcileIntervalMs: 300,
	repositoryPollMs: 60 * 1000,
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

function fileError(path: string, error: unknown): RuntimeFileError {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return new RuntimeFileError(
		path,
		code ?? (error instanceof Error ? error.message : String(error)),
		{ cause: error },
	);
}

export class LocalRuntime implements Runtime {
	readonly id: RuntimeId = "local";
	readonly where = "";
	readonly cadence = LOCAL_CADENCE;

	/** Round-trip times of the last few execs, newest last. */
	readonly #latencies: number[] = [];
	/** When each exec of the last minute started, so a rate is a count. */
	#recentExecs: number[] = [];
	#lastFailure: string | undefined;

	home(): Promise<string> {
		return Promise.resolve(homedir());
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
		this.#recentExecs.push(startedAt);
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
			);
			this.#record(startedAt);
			return output;
		} catch (failure: unknown) {
			this.#record(startedAt);
			this.#lastFailure =
				failure instanceof Error ? failure.message : String(failure);
			throw failure;
		}
	}

	spawnPty(request: PtyRequest): Pty {
		return openPty(request);
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
			watchers.push(
				watch(join(gitDirectory, "refs"), { recursive: true }, () =>
					onChange(),
				),
			);
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
	 * The launcher DevHub already wrote for itself, at startup.
	 *
	 * Nothing is installed here and nothing is forwarded: this machine is the
	 * one the control socket is bound on, and `bootstrapShell` wrote the script
	 * that names it before any window existed. The remote arm does the work; the
	 * seam is what lets a caller ask both the same question.
	 */
	async terminalLauncher(
		spec: TerminalLauncherSpec,
	): Promise<TerminalLauncher> {
		return { path: spec.localLauncherPath, unreachable: undefined };
	}

	reading(): RuntimeReading {
		const since = Date.now() - A_MINUTE;
		this.#recentExecs = this.#recentExecs.filter((at) => at >= since);
		const sorted = [...this.#latencies].sort((left, right) => left - right);
		return {
			id: this.id,
			// This machine is where main is running, so the question does not
			// have a second answer.
			connected: true,
			masterPid: undefined,
			medianRoundTripMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
			reconcileIntervalMs: this.cadence.reconcileIntervalMs,
			execsLastMinute: this.#recentExecs.length,
			lastFailure: this.#lastFailure,
		};
	}

	#record(startedAt: number): void {
		this.#latencies.push(Date.now() - startedAt);
		if (this.#latencies.length > LATENCY_SAMPLES) this.#latencies.shift();
	}
}
