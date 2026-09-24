/**
 * The one way a `spawnStream` becomes a process, on every machine.
 *
 * Each runtime says *what* to run — this Mac runs the argv itself, a host runs
 * an `ssh -T` whose remote command is the argv, a container a `docker exec -i`
 * — and this file does the rest once: the pipes, the stdin that is held open
 * and never written, the process group, the kill, the bounded stderr, and the
 * rule that decides whether an ending is an answer or a refusal. Three copies
 * of that would be three streams that end in three slightly different ways.
 */

import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { portFailure, type CancellationToken } from "../terminal/ports.js";
import type { ByteStream, StreamEnd } from "./runtime.js";

/** How much of a stream's stderr is kept: the end of it, where a reason is. */
export const STREAM_STDERR_BYTES = 16 * 1024;

/** What one runtime says a stream is, once it knows. */
export interface StreamLaunch {
	/** The program run on *this* Mac: the command itself, `ssh`, or `docker`. */
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string | undefined;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Run once, when the process is gone (or never started). */
	readonly release?: () => void;
	/**
	 * Whether this ending is the transport refusing rather than the program
	 * answering. `undefined` for an answer.
	 */
	readonly refusal?: (end: StreamEnd) => Error | undefined;
}

/**
 * A stream whose launch may have to wait for the machine first.
 *
 * `prepare` is where a far machine's login environment or container is waited
 * for; its failure is the stream's failure and arrives through `ended`.
 */
export function openByteStream(
	prepare: () => Promise<StreamLaunch>,
	cancel: CancellationToken,
): ByteStream {
	let child: ChildProcess | undefined;
	let stopped = false;
	/** Its pipes are closed, so its group id may already belong to another. */
	let closed = false;
	const kill = (): void => {
		stopped = true;
		const pid = child?.pid;
		if (pid === undefined || closed) return;
		try {
			// The group, and even when the leader has exited: the program may
			// have started children of its own (a `tail` beside a watchdog), and
			// they hold the pipe too.
			process.kill(-pid, "SIGTERM");
		} catch {
			// Not a swallow: the group is already gone, which is the state this
			// call exists to reach.
		}
	};

	const started: Promise<{ child: ChildProcess; launch: StreamLaunch }> =
		(async () => {
			const launch = await prepare();
			if (stopped) {
				launch.release?.();
				throw portFailure("cancelled", {
					detail: `${launch.file} was stopped before it started`,
				});
			}
			const spawned = spawn(launch.file, [...launch.args], {
				cwd: launch.cwd,
				env: launch.env as NodeJS.ProcessEnv,
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			});
			child = spawned;
			return { child: spawned, launch };
		})();

	const ended = started.then(
		({ child: running, launch }) =>
			new Promise<StreamEnd>((resolve, reject) => {
				let settled = false;
				let stderr = Buffer.alloc(0);
				const settle = (outcome: () => void): void => {
					if (settled) return;
					settled = true;
					launch.release?.();
					outcome();
				};
				running.stderr?.on("data", (chunk: Buffer) => {
					stderr = Buffer.concat([stderr, chunk]);
					if (stderr.byteLength > STREAM_STDERR_BYTES) {
						stderr = stderr.subarray(stderr.byteLength - STREAM_STDERR_BYTES);
					}
				});
				running.on("error", (error: NodeJS.ErrnoException) => {
					settle(() =>
						reject(
							portFailure(
								error.code === "ENOENT" || error.code === "EACCES"
									? "unavailable"
									: "failed",
								{
									detail: `${launch.file} could not be started: ${error.message}`,
									cause: error,
								},
							),
						),
					);
				});
				// `close`, not `exit`: the stream is over when its pipes are, and a
				// descendant still holding stdout is still writing to it.
				running.on("close", (code, signal) => {
					closed = true;
					// Let go of the held stdin too, so that anything of the program's
					// still reading it — a watcher left behind — sees EOF and ends.
					running.stdin?.destroy();
					const end: StreamEnd = { code, signal, stderr };
					const refused = launch.refusal?.(end);
					settle(() => (refused ? reject(refused) : resolve(end)));
				});
			}),
	);

	// The contract is "read stdout, then await `ended`", so a program that
	// failed to start rejects `ended` while its caller is still, correctly,
	// reading an empty stdout. That rejection is not unhandled — the caller
	// reads it a moment later from this same promise — and without this Node
	// would report it as if nobody ever would.
	ended.then(
		() => undefined,
		() => undefined,
	);
	cancel.onCancelled(kill);

	async function* read(): AsyncGenerator<Buffer> {
		// A stream that never started has no bytes; why it did not start is
		// `ended`'s to say, and saying it here as well would be two failures
		// for one fact.
		const running = await started.then(
			({ child: spawned }) => spawned,
			() => undefined,
		);
		const stdout = running?.stdout;
		if (stdout === undefined || stdout === null) return;
		for await (const chunk of stdout) yield chunk as Buffer;
	}

	return { stdout: read(), ended, kill };
}
