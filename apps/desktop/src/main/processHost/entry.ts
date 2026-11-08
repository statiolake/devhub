/**
 * The process host: a utility process that starts DevHub's short commands.
 *
 * Main asks (`client.ts`); this runs each child with `runChildHere`, the same
 * code that runs them anywhere else, and sends back what it printed and how
 * it ended. It holds nothing between runs and decides nothing: deadlines,
 * cancellation and what a failure means stay in main (`runBounded`).
 *
 * It exists because `spawn` is synchronous on the calling thread, and from
 * main it held the thread every pane's keys and every page's IPC wait on
 * (docs/process-model.md).
 */

import { runChildHere, type ChildRun } from "../terminal/childRun.js";
import type { FromHost, ToHost } from "./protocol.js";

interface ParentPort {
	on(event: "message", listener: (event: { data: unknown }) => void): void;
	postMessage(message: unknown): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent === undefined) {
	throw new Error("the process host runs only as an Electron utility process");
}
const port: ParentPort = parent;
const runs = new Map<number, ChildRun>();
const say = (message: FromHost) => port.postMessage(message);

port.on("message", ({ data }) => {
	const message = data as ToHost;
	if (message.type === "kill") {
		runs.get(message.id)?.kill();
		runs.delete(message.id);
		return;
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
		say({
			type: "threw",
			id,
			message: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	runs.set(id, run);
	void run.outcome.then((outcome) => {
		if (!runs.delete(id)) return;
		say({ type: "ended", id, outcome });
	});
});
