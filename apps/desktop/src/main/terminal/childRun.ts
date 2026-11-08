/**
 * One child process, run to its close: the half of `runBounded` that touches
 * `child_process`.
 *
 * It is the same code in two places. In DevHub's main process it runs in the
 * process host (`main/processHost/`), a utility process whose only work is
 * this, because `spawn` is synchronous on the thread that calls it and on
 * Linux it forks: from main, with its hundreds of megabytes mapped, a spawn
 * held main's thread for about 8 ms, and main spawned tmux, git and the
 * Agents' host scripts several times a second (docs/process-model.md).
 * Anywhere else — the tests, the `devhub` CLI, the terminal bundle, main
 * before the host is up — it runs right here.
 *
 * What it does not do is decide anything about time: the deadline, the
 * cancellation and which failure wins are `runBounded`'s, which ends a run by
 * `kill`. That keeps the one rule set in one place, on main's side, whichever
 * process the child happens to be a child of.
 */

import { spawn } from "node:child_process";

import { cleanSpawnArgs } from "./cleanSpawn.js";

/** What to run, as plain data: it crosses to the process host as it is. */
export interface ChildRequest {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string | undefined;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Uint8Array | undefined;
	/** Kept of each stream; what is past it is dropped, or fails the run. */
	readonly stdoutBytes: number;
	readonly stderrBytes: number;
	/** `fail`: the first byte past a cap ends the run with `overflow`. */
	readonly overflow: "truncate" | "fail";
	/** Whether the caller wants each chunk as it arrives (`onOutput`). */
	readonly streamOutput: boolean;
}

/** How a run ended. */
export type ChildOutcome =
	| {
			readonly kind: "closed";
			readonly code: number | null;
			readonly signal: string | null;
			readonly stdout: Uint8Array;
			readonly stderr: Uint8Array;
	  }
	/** It could not be started, or failed on its own (the `error` event). */
	| { readonly kind: "spawn-error"; readonly error: ChildError }
	/** It stopped reading its input before all of it was written. */
	| { readonly kind: "stdin-error"; readonly error: ChildError }
	/** A stream went past its cap under `overflow: "fail"`. */
	| { readonly kind: "overflow" };

/** An `ErrnoException`, as data. */
export interface ChildError {
	readonly message: string;
	readonly code: string | undefined;
}

export interface ChildRun {
	readonly outcome: Promise<ChildOutcome>;
	/** End it, its process group with it. Nothing once it has ended. */
	kill(): void;
}

export interface ChildRunner {
	run(request: ChildRequest, onOutput?: (chunk: Uint8Array) => void): ChildRun;
}

function childError(error: NodeJS.ErrnoException): ChildError {
	return { message: error.message, code: error.code };
}

/**
 * Run one child here, in this process.
 *
 * The child is its own process group, so a provider that forks (tmux does)
 * can be terminated as a whole rather than leaving a descendant holding a pipe.
 */
export function runChildHere(
	request: ChildRequest,
	onOutput?: (chunk: Uint8Array) => void,
): ChildRun {
	// Started with nothing of this process's open but its stdio
	// (`cleanSpawn.ts`): what it starts in turn — the tmux server — lives far
	// longer than this process's descriptors should.
	const program = cleanSpawnArgs(
		request.file,
		request.args,
		request.cwd,
		request.env,
	);
	const child = spawn(program.file, [...program.args], {
		cwd: request.cwd,
		env: request.env as NodeJS.ProcessEnv,
		stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		detached: true,
	});
	// Both are pipes by construction, three lines above. If they are not, the
	// child is not the child this function was asked to run and there is
	// nothing to read: say so rather than reading nothing for the whole budget
	// and calling it a timeout.
	const outPipe = child.stdout;
	const errPipe = child.stderr;
	if (outPipe === null || errPipe === null) {
		throw new Error("a bounded command was spawned without pipes to read");
	}
	let settled = false;
	let settle: (outcome: ChildOutcome) => void = () => undefined;
	const outcome = new Promise<ChildOutcome>((resolve) => {
		settle = resolve;
	});
	const terminate = () => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			// Not a swallow: the group is already gone, which is the state this
			// call exists to reach.
		}
		child.kill("SIGKILL");
	};
	const finish = (ending: ChildOutcome) => {
		if (settled) return;
		settled = true;
		if (ending.kind !== "closed") terminate();
		settle(ending);
	};

	if (request.stdin !== undefined) {
		// A program that stops reading before its input is all written has not
		// been given what the caller handed it — and without a listener the
		// EPIPE that says so is an uncaught exception. After the run has
		// settled (it was killed at its deadline, say), `finish` ignores it:
		// the settled answer already says why.
		child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			finish({ kind: "stdin-error", error: childError(error) });
		});
		child.stdin?.end(Buffer.from(request.stdin));
	}
	child.on("error", (error: NodeJS.ErrnoException) => {
		finish({ kind: "spawn-error", error: childError(error) });
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	// One rule for both streams, so a cap that is right for one of them cannot
	// be quietly wrong for the other.
	const capped = (
		chunks: Buffer[],
		seen: number,
		chunk: Buffer,
		cap: number,
	): number => {
		const total = seen + chunk.byteLength;
		if (seen >= cap) return total;
		if (total <= cap) {
			chunks.push(chunk);
			return total;
		}
		if (request.overflow === "fail") {
			finish({ kind: "overflow" });
			return total;
		}
		chunks.push(chunk.subarray(0, cap - seen));
		return total;
	};
	// Both streams, as they arrive, to a caller showing a long command's
	// progress — whole, before any cap: the cap bounds what is held here, and
	// what the caller keeps is the caller's business.
	outPipe.on("data", (chunk: Buffer) => {
		onOutput?.(chunk);
		stdoutBytes = capped(stdout, stdoutBytes, chunk, request.stdoutBytes);
	});
	errPipe.on("data", (chunk: Buffer) => {
		onOutput?.(chunk);
		stderrBytes = capped(stderr, stderrBytes, chunk, request.stderrBytes);
	});
	// `close` rather than `exit`: the drain is part of the same budget, so a
	// descendant holding a pipe open cannot be mistaken for completion.
	child.on("close", (code, signal) => {
		finish({
			kind: "closed",
			code,
			signal,
			stdout: Buffer.concat(stdout),
			stderr: Buffer.concat(stderr),
		});
	});
	return {
		outcome,
		kill: () => {
			if (settled) return;
			settled = true;
			terminate();
		},
	};
}

/** The runner of this process: children are its own. */
export const RUN_HERE: ChildRunner = { run: runChildHere };
