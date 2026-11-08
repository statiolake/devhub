/**
 * One long-lived child whose stdout is read as it arrives: the half of
 * `openByteStream` (`runtime/byteStream.ts`) that touches `child_process`.
 *
 * Like `childRun.ts`, the same code in two places. In DevHub's main process
 * it runs in the process host (`main/processHost/`), so that neither the
 * `spawn` (a fork of main, about 8 ms of its thread) nor the bytes — a remote
 * Agent's journal through `ssh -T`, at whatever rate the Agent writes — are
 * main's. Anywhere else (the conversation engine, the tests, main with
 * `DEVHUB_BYTESTREAMS_IN_MAIN=1` or after the host was given up on) it runs
 * right here.
 *
 * What it does not do is decide what an ending means: the refusal, the
 * session slot a host's stream holds and the cancellation are
 * `openByteStream`'s, on main's side, whichever process the child is a child
 * of.
 */

import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";

import { cleanSpawnArgs } from "./cleanSpawn.js";
import type { ChildError } from "./childRun.js";

/** How much of a stream's stderr is kept: the end of it, where a reason is. */
export const STREAM_STDERR_BYTES = 16 * 1024;

/** What to run, as plain data: it crosses to the process host as it is. */
export interface StreamSpawn {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string | undefined;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Where a stream's bytes go instead of its reader: one end of a
 * `MessagePort`, whose other end is the process that reads them. Each chunk
 * is posted as it is read, then `null` once stdout is over, and the port is
 * closed. Electron's `MessagePortMain` is one.
 */
export interface StreamSink {
	postMessage(message: Uint8Array | null): void;
	close(): void;
}

/** How a stream's child ended. */
export type StreamExit =
	| {
			readonly kind: "closed";
			readonly code: number | null;
			readonly signal: string | null;
			readonly stderr: Uint8Array;
	  }
	/** It could not be started, or failed on its own (the `error` event). */
	| { readonly kind: "spawn-error"; readonly error: ChildError };

export interface StreamRun {
	/** Every byte of stdout, in order; nothing when it was given a sink. */
	readonly stdout: AsyncIterable<Uint8Array>;
	readonly exit: Promise<StreamExit>;
	/** End it, its process group with it. Nothing once its pipes are closed. */
	kill(): void;
}

export interface StreamRunner {
	open(spawn: StreamSpawn, sink?: StreamSink): StreamRun;
}

/**
 * Run one stream here, in this process.
 *
 * Its stdin is a pipe held open and never written (`ByteStream`'s contract),
 * it is its own process group, and it is over when its pipes are — `close`,
 * not `exit`: a descendant still holding stdout is still writing to it.
 */
export function runStreamHere(
	launch: StreamSpawn,
	sink?: StreamSink,
): StreamRun {
	// Nothing of this process's open but its stdio (`cleanSpawn.ts`).
	const program = cleanSpawnArgs(
		launch.file,
		launch.args,
		launch.cwd,
		launch.env,
	);
	const child: ChildProcess = spawn(program.file, [...program.args], {
		cwd: launch.cwd,
		env: launch.env as NodeJS.ProcessEnv,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	/** Its pipes are closed, so its group id may already belong to another. */
	let closed = false;
	let sinkOpen = sink !== undefined;
	const endSink = (): void => {
		if (!sinkOpen) return;
		sinkOpen = false;
		sink?.postMessage(null);
		sink?.close();
	};
	if (sink !== undefined) {
		child.stdout?.on("data", (chunk: Buffer) => {
			// A copy: a chunk's view can be of a larger buffer, and a port
			// clones the whole buffer under it.
			if (sinkOpen) sink.postMessage(new Uint8Array(chunk));
		});
		child.stdout?.on("end", endSink);
	}
	const exit = new Promise<StreamExit>((resolve) => {
		let settled = false;
		let stderr = Buffer.alloc(0);
		const settle = (outcome: StreamExit): void => {
			if (settled) return;
			settled = true;
			endSink();
			resolve(outcome);
		};
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = Buffer.concat([stderr, chunk]);
			if (stderr.byteLength > STREAM_STDERR_BYTES) {
				stderr = stderr.subarray(stderr.byteLength - STREAM_STDERR_BYTES);
			}
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			settle({
				kind: "spawn-error",
				error: { message: error.message, code: error.code },
			});
		});
		child.on("close", (code, signal) => {
			closed = true;
			// Let go of the held stdin too, so that anything of the program's
			// still reading it — a watcher left behind — sees EOF and ends.
			child.stdin?.destroy();
			settle({ kind: "closed", code, signal, stderr });
		});
	});

	async function* read(): AsyncGenerator<Uint8Array> {
		const stdout = child.stdout;
		if (sink !== undefined || stdout === null) return;
		for await (const chunk of stdout) yield chunk as Buffer;
	}

	return {
		stdout: read(),
		exit,
		kill() {
			const pid = child.pid;
			if (pid === undefined || closed) return;
			try {
				// The group, and even when the leader has exited: the program may
				// have started children of its own (a `tail` beside a watchdog),
				// and they hold the pipe too.
				process.kill(-pid, "SIGTERM");
			} catch {
				// Not a swallow: the group is already gone, which is the state
				// this call exists to reach.
			}
		},
	};
}

export const RUN_STREAM_HERE: StreamRunner = { open: runStreamHere };
