/**
 * The pty host as an Electron utility process: `host.ts` on the port to
 * main, opening PTYs with the submodule's node-pty. Main starts it
 * (`client.ts`) and starts it again if it ends; the tmux sessions are the
 * tmux server's, so a host that ends takes only its clients with it.
 */

import { openPty } from "../terminal/pty.js";
import { PtyHost, type HostPort } from "./host.js";
import type { ToPtyHost } from "./protocol.js";

interface ParentPort {
	on(
		event: "message",
		listener: (event: { data: unknown; ports: readonly HostPort[] }) => void,
	): void;
	postMessage(message: unknown): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent === undefined) {
	throw new Error("the pty host runs only as an Electron utility process");
}
const port: ParentPort = parent;
const host = new PtyHost({
	post: (message) => port.postMessage(message),
	spawn: openPty,
});

port.on("message", ({ data, ports }) => {
	host.receive(data as ToPtyHost, ports);
});

// A failure nobody caught is the host's end: main sees it exit, the pages
// show their terminals reconnecting, and the next attach starts a new host.
// The sessions are tmux's and are not touched by it.
process.on("uncaughtException", (error) => {
	console.error(
		"[devhub] the pty host stopped on a failure:",
		error.stack ?? error.message,
	);
	process.exit(70);
});
