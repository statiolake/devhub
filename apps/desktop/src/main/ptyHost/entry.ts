/**
 * The pty host as an Electron utility process: `host.ts` on the port to
 * main, opening PTYs with the submodule's node-pty. Main starts it
 * (`client.ts`) and starts it again if it ends; the tmux sessions are the
 * tmux server's, so a host that ends takes only its clients with it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ownedSpawnArgs } from "../terminal/cleanSpawn.js";
import { openPty, type PtyLaunch } from "../terminal/pty.js";
import type { ControlProcess } from "./control/controlClient.js";
import { LibGhosttyVt } from "./vt/libghosttyVt.js";
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
/** Every control client this host started that has not exited. */
const clients = new Set<ChildProcess>();

/**
 * A tmux control client on pipes: no terminal, so nothing echoes or wraps.
 *
 * Started through `devhub-exec-clean --die-with` this host's pid
 * (`ownedSpawnArgs`): the kernel ends it when this host ends, however it
 * ends. Its stdin closing is not enough — tmux does not always let a control
 * client go when it does (`native/execClean.c`) — and such a client stayed
 * attached, at its size, after the host was gone.
 */
function spawnPipes(launch: PtyLaunch): ControlProcess {
	const owned = ownedSpawnArgs(
		launch.file,
		launch.args,
		launch.cwd,
		launch.env,
	);
	const child = spawn(owned.file, [...owned.args], {
		cwd: launch.cwd,
		env: launch.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	clients.add(child);
	child.once("exit", () => clients.delete(child));
	child.once("error", () => clients.delete(child));
	child.stderr.on("data", (chunk: Buffer) => {
		console.error("[devhub] tmux control client:", chunk.toString().trimEnd());
	});
	// A write after the child has gone is the end, said by `exit`, not a failure.
	child.stdin.on("error", () => undefined);
	return {
		write: (text) => {
			child.stdin.write(text);
		},
		onData: (listener) => {
			child.stdout.on("data", (chunk: Buffer) =>
				listener(new Uint8Array(chunk)),
			);
		},
		onExit: (listener) => {
			child.on("exit", (code) => listener(code ?? undefined));
			child.on("error", () => listener(undefined));
		},
		kill: () => {
			child.kill();
		},
	};
}

/** `out/vt/ghostty-vt.wasm`, beside `out/main` (`scripts/build-native.mjs`). */
const VT_WASM = new URL("../../vt/ghostty-vt.wasm", import.meta.url);

const host = new PtyHost({
	post: (message) => port.postMessage(message),
	spawn: openPty,
	spawnPipes,
	loadVt: async () => LibGhosttyVt.load(await readFile(VT_WASM)),
});

port.on("message", ({ data, ports }) => {
	host.receive(data as ToPtyHost, ports);
});

// Main ends this host on quit and on "Restart Terminals" (`client.ts`):
// each client is detached, and whatever is left is told to end as the
// process exits, by any path that runs `exit` (a tmux client ends on SIGTERM
// whatever output it had queued). The paths that run nothing here (SIGKILL,
// a crash of the runtime) are the helper's to cover, and this is all
// there is where no helper started the clients.
process.once("SIGTERM", () => {
	host.stopAll();
	process.exit(0);
});
process.once("exit", () => {
	for (const child of clients) child.kill("SIGTERM");
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
