/**
 * The conversation engine as an Electron utility process: `engine.ts` on the
 * port to main, with this machine's runtime for the hosts of the Agents on
 * it. Main starts it (`client.ts`) and starts it again if it ends.
 */

import { LocalRuntime } from "../runtime/local.js";
import { ConversationEngine, type EnginePort } from "./engine.js";
import type { ToEngine } from "./protocol.js";

interface ParentPort {
	on(
		event: "message",
		listener: (event: { data: unknown; ports: readonly EnginePort[] }) => void,
	): void;
	postMessage(message: unknown): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent === undefined) {
	throw new Error(
		"the conversation engine runs only as an Electron utility process",
	);
}
const port: ParentPort = parent;
let runtime: LocalRuntime | undefined;
const engine = new ConversationEngine({
	post: (message) => port.postMessage(message),
	localRuntime: () => (runtime ??= new LocalRuntime()),
});

port.on("message", ({ data, ports }) => {
	engine.receive(data as ToEngine, ports);
});

// A failure nobody caught is the engine's end: main sees it exit, says so on
// every conversation, and starts a new one that replays them from their
// journals. Going on with a conversation half-updated would be worse.
process.on("uncaughtException", (error) => {
	console.error(
		"[devhub] the conversation engine stopped on a failure:",
		error.stack ?? error.message,
	);
	process.exit(70);
});
