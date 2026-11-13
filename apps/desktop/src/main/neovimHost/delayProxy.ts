/**
 * A Neovim's socket reached through a delay, for measuring how the GUI
 * answers the mouse over a slow link (`docs/neovim-editor.md`, "The
 * pointer"): with `DEVHUB_NEOVIM_DELAY_MS` set, the host reaches every Neovim
 * through a local socket that holds each chunk half that long each way, so a
 * round trip costs what an SSH link of that latency would. Never set in a
 * normal run; the stability suite's `pointer` scenario is run with it.
 */

import { connect, createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The round trip `DEVHUB_NEOVIM_DELAY_MS` asks for, or 0. */
export function neovimDelayMs(env: NodeJS.ProcessEnv): number {
	const value = Number(env["DEVHUB_NEOVIM_DELAY_MS"] ?? "");
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Bytes from `from` to `to`, each chunk `ms` later, in order. */
function delayed(from: Socket, to: Socket, ms: number): void {
	from.on("data", (chunk: Buffer) => {
		setTimeout(() => {
			if (!to.destroyed) to.write(chunk);
		}, ms);
	});
	from.on("close", () => {
		setTimeout(() => to.destroy(), ms);
	});
	from.on("error", () => undefined);
}

/**
 * A socket path that reaches `target` with `roundTripMs` added to every
 * round trip; it serves one connection and goes with it.
 */
export async function delayedSocket(
	target: string,
	roundTripMs: number,
): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "dh-delay-"));
	const path = join(dir, "s");
	const server = createServer((client) => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
		const upstream = connect(target);
		delayed(client, upstream, roundTripMs / 2);
		delayed(upstream, client, roundTripMs / 2);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
	return path;
}
