/**
 * The pty host as an Electron utility process: `host.ts` on the port to
 * main, opening PTYs with the submodule's node-pty. Main starts it
 * (`client.ts`) and starts it again if it ends; the tmux sessions are the
 * tmux server's, so a host that ends takes only its clients with it.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
/** A tmux control client on pipes: no terminal, so nothing echoes or wraps. */
function spawnPipes(launch: PtyLaunch): ControlProcess {
	const child = spawn(launch.file, [...launch.args], {
		cwd: launch.cwd,
		env: launch.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
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
