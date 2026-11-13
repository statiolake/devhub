/**
 * The Neovim host as an Electron utility process: `host.ts` on the port to
 * main, connecting to the Neovims' sockets itself. Main starts it
 * (`client.ts`) and starts it again if it ends; the Neovims are tmux's, so a
 * host that ends takes only the UIs' connections with it.
 */

import { NeovimClient } from "../editor/neovimRpc.js";
import { delayedSocket, neovimDelayMs } from "./delayProxy.js";
import { NeovimHost, type HostPort } from "./host.js";
import type { ToNeovimHost } from "./protocol.js";

interface ParentPort {
	on(
		event: "message",
		listener: (event: { data: unknown; ports: readonly HostPort[] }) => void,
	): void;
	postMessage(message: unknown): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent === undefined) {
	throw new Error("the Neovim host runs only as an Electron utility process");
}
const port: ParentPort = parent;
// A slow link, for measuring the GUI over one (`delayProxy.ts`).
const delayMs = neovimDelayMs(process.env);
const host = new NeovimHost({
	post: (message) => port.postMessage(message),
	connect: async (socketPath) =>
		NeovimClient.connect(
			delayMs > 0 ? await delayedSocket(socketPath, delayMs) : socketPath,
		),
});

port.on("message", ({ data, ports }) => {
	host.receive(data as ToNeovimHost, ports);
});

// A failure nobody caught is the host's end: main sees it exit, the pages
// show their Neovims reconnecting and attach again, to a new host. The
// Neovims are tmux's and are not touched by it.
process.on("uncaughtException", (error) => {
	console.error(
		"[devhub] the Neovim host stopped on a failure:",
		error.stack ?? error.message,
	);
	process.exit(70);
});
