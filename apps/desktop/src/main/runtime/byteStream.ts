/**
 * The one way a `spawnStream` becomes a process, on every machine.
 *
 * Each runtime says *what* to run — this Mac runs the argv itself, a host runs
 * an `ssh -T` whose remote command is the argv, a container a `docker exec -i`
 * — and this file does the rest once: the stream runner that starts it, the
 * session it holds released, the cancellation, and the rule that decides
 * whether an ending is an answer or a refusal. Three copies of that would be
 * three streams that end in three slightly different ways.
 *
 * The child itself — pipes, the held stdin, the process group, the bounded
 * stderr — is `terminal/streamRun.ts`'s, run by whichever runner is
 * installed: in main the process host (`setStreamRunner`), so that neither
 * the spawn nor the bytes are on main's thread; anywhere else, here.
 */

import { Buffer } from "node:buffer";

import {
	RUN_STREAM_HERE,
	type StreamExit,
	type StreamRun,
	type StreamRunner,
	type StreamSink,
	type StreamSpawn,
} from "../terminal/streamRun.js";
import { portFailure, type CancellationToken } from "../terminal/ports.js";
import type { ByteStream, StreamEnd } from "./runtime.js";

/** What one runtime says a stream is, once it knows. */
export interface StreamLaunch extends StreamSpawn {
	/** Run once, when the process is gone (or never started). */
	readonly release?: () => void;
	/**
	 * Whether this ending is the transport refusing rather than the program
	 * answering. `undefined` for an answer.
	 */
	readonly refusal?: (end: StreamEnd) => Error | undefined;
}

/**
 * Where streams start their children: here, unless the process host has been
 * installed, which main does once Electron is ready.
 */
let streamRunner: StreamRunner = RUN_STREAM_HERE;

/**
 * Start every stream through `runner` from now on — the process host, in
 * main (`main/processHost/client.ts`). `undefined` goes back to starting them
 * in this process.
 */
export function setStreamRunner(runner: StreamRunner | undefined): void {
	streamRunner = runner ?? RUN_STREAM_HERE;
}

/**
 * A stream whose launch may have to wait for the machine first.
 *
 * `prepare` is where a far machine's login environment or container is waited
 * for; its failure is the stream's failure and arrives through `ended`. With
 * a `sink`, the bytes go there and `stdout` yields none (`StreamRequest.to`).
 */
export function openByteStream(
	prepare: () => Promise<StreamLaunch>,
	cancel: CancellationToken,
	sink?: StreamSink,
): ByteStream {
	let run: StreamRun | undefined;
	let stopped = false;
	/** A sink nobody was handed is ended here, so its reader is not left waiting. */
	const dropSink = (): void => {
		sink?.postMessage(null);
		sink?.close();
	};
	const kill = (): void => {
		stopped = true;
		run?.kill();
	};

	const started: Promise<{ run: StreamRun; launch: StreamLaunch }> =
		(async () => {
			let launch: StreamLaunch;
			try {
				launch = await prepare();
			} catch (failure: unknown) {
				dropSink();
				throw failure;
			}
			if (stopped) {
				launch.release?.();
				dropSink();
				throw portFailure("cancelled", {
					detail: `${launch.file} was stopped before it started`,
				});
			}
			try {
				run = streamRunner.open(
					{
						file: launch.file,
						args: launch.args,
						cwd: launch.cwd,
						env: launch.env,
					},
					sink,
				);
			} catch (failure: unknown) {
				launch.release?.();
				throw failure;
			}
			return { run, launch };
		})();

	const ended = started.then(async ({ run: running, launch }) => {
		let exit: StreamExit;
		try {
			exit = await running.exit;
		} finally {
			launch.release?.();
		}
		if (exit.kind === "spawn-error") {
			const { code, message } = exit.error;
			throw portFailure(
				code === "ENOENT" || code === "EACCES" ? "unavailable" : "failed",
				{
					detail: `${launch.file} could not be started: ${message}`,
					cause: exit.error,
				},
			);
		}
		const end: StreamEnd = {
			code: exit.code,
			signal: exit.signal,
			stderr: Buffer.from(
				exit.stderr.buffer,
				exit.stderr.byteOffset,
				exit.stderr.byteLength,
			),
		};
		const refused = launch.refusal?.(end);
		if (refused !== undefined) throw refused;
		return end;
	});

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
			({ run: opened }) => opened,
			() => undefined,
		);
		if (running === undefined) return;
		for await (const chunk of running.stdout) {
			yield Buffer.isBuffer(chunk)
				? chunk
				: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		}
	}

	return { stdout: read(), ended, kill };
}
