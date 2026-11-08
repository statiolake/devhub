/**
 * The process host: a utility process that starts DevHub's children.
 *
 * Main asks (`client.ts`); this runs each bounded command with
 * `runChildHere` and each long-lived stream with `runStreamHere`, the same
 * code that runs them anywhere else, and sends back what they printed and how
 * they ended — a stream's bytes to the port it came with, when it came with
 * one. It holds nothing between runs and decides nothing: deadlines,
 * cancellation and what a failure means stay in main (`runBounded`,
 * `openByteStream`).
 *
 * It exists because `spawn` is synchronous on the calling thread, and from
 * main it held the thread every pane's keys and every page's IPC wait on
 * (docs/process-model.md).
 */

import { runChildHere, type ChildRun } from "../terminal/childRun.js";
import {
	runStreamHere,
	type StreamRun,
	type StreamSink,
} from "../terminal/streamRun.js";
import type { FromHost, ToHost } from "./protocol.js";

interface ParentPort {
	on(
		event: "message",
		listener: (event: { data: unknown; ports?: readonly StreamSink[] }) => void,
	): void;
	postMessage(message: unknown): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent === undefined) {
	throw new Error("the process host runs only as an Electron utility process");
}
const port: ParentPort = parent;
const runs = new Map<number, ChildRun>();
const streams = new Map<number, StreamRun>();
const say = (message: FromHost) => port.postMessage(message);
const failureText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

function stream(id: number, run: StreamRun, sink: StreamSink | undefined) {
	streams.set(id, run);
	if (sink === undefined) {
		void (async () => {
			for await (const chunk of run.stdout)
				say({ type: "stream-data", id, chunk: new Uint8Array(chunk) });
		})();
	}
	void run.exit.then((exit) => {
		streams.delete(id);
		say({ type: "stream-ended", id, exit });
	});
}

port.on("message", ({ data, ports }) => {
	const message = data as ToHost;
	switch (message.type) {
		case "kill":
			runs.get(message.id)?.kill();
			runs.delete(message.id);
			return;
		case "stream-kill":
			streams.get(message.id)?.kill();
			return;
		case "stream": {
			const sink = ports?.[0];
			try {
				stream(message.id, runStreamHere(message.spawn, sink), sink);
			} catch (error: unknown) {
				sink?.postMessage(null);
				sink?.close();
				say({
					type: "stream-ended",
					id: message.id,
					exit: {
						kind: "spawn-error",
						error: { message: failureText(error), code: undefined },
					},
				});
			}
			return;
		}
		case "run":
			break;
	}
	const { id, request } = message;
	let run: ChildRun;
	try {
		run = runChildHere(
			request,
			request.streamOutput
				? (chunk) => say({ type: "output", id, chunk: new Uint8Array(chunk) })
				: undefined,
		);
	} catch (error: unknown) {
		say({ type: "threw", id, message: failureText(error) });
		return;
	}
	runs.set(id, run);
	void run.outcome.then((outcome) => {
		if (!runs.delete(id)) return;
		say({ type: "ended", id, outcome });
	});
});
