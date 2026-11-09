/**
 * The Neovim editor on a machine that is not this Mac.
 *
 * The socket lives on the host — `${TMPDIR:-/tmp}/devhub-nvim-<uid>/`, made
 * `0700` — and is reached from here through the host's ControlMaster: `ssh
 * -O forward -L <here>:<there>` (`Runtime.forwardUnixSocket`) to a socket in
 * DevHub's own directory, then connected to like a local one. A dropped
 * connection takes the forward with it, and the next attach forwards again;
 * the Neovim itself is kept by the host's tmux and is adopted as it is.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { CancellationToken } from "../terminal/ports.js";
import { OperationDeadline } from "../terminal/command.js";
import type { Runtime, RuntimeId } from "../runtime/runtime.js";
import { PROBE_LIMITS } from "../runtime/remoteShellRuntime.js";
import type { NeovimFiles, NeovimSockets } from "./managedNeovim.js";

/** What a Workspace whose machine cannot have DevHub's Neovim is told. */
export function neovimMissingMessage(
	machine: RuntimeId,
	reason: string,
): string {
	const host = machine === "local" ? "this Mac" : machine.replace(/^ssh:/, "");
	return `DevHub's Neovim cannot run on ${host}: ${reason}`;
}

/** The shell script that answers this machine's socket directory. */
export const SOCKET_DIRECTORY_SCRIPT =
	'd="${TMPDIR:-/tmp}"; d="${d%/}/devhub-nvim-$(id -u)"; mkdir -p "$d" && chmod 700 "$d" && printf %s "$d"';

/** Where a host's socket is forwarded to on this Mac: short, one per path. */
export function forwardedSocketPath(
	directory: string,
	machine: RuntimeId,
	remotePath: string,
): string {
	const digest = createHash("sha256")
		.update(`${machine}\0${remotePath}`)
		.digest("hex")
		.slice(0, 12);
	return join(directory, `${digest}.sock`);
}

async function run(runtime: Runtime, argv: readonly string[]) {
	return runtime.exec({
		argv,
		deadline: OperationDeadline.in(20_000),
		cancel: new CancellationToken(),
		limits: PROBE_LIMITS,
	});
}

export async function remoteNeovimSockets(
	runtime: Runtime,
	forwardDirectory: string,
): Promise<NeovimSockets> {
	const made = await run(runtime, ["/bin/sh", "-c", SOCKET_DIRECTORY_SCRIPT]);
	const directory = made.stdout.toString("utf8").trim();
	if (made.code !== 0 || directory.length === 0) {
		throw new Error(
			`DevHub could not make a directory for Neovim's socket${runtime.where}: ${made.stderr.toString("utf8").trim()}`,
		);
	}
	const files: NeovimFiles = {
		async exists(path) {
			return (await run(runtime, ["test", "-S", path])).code === 0;
		},
		async remove(path) {
			await run(runtime, ["rm", "-f", path]);
		},
		async ensurePrivateDirectory() {
			// Made above, with the answer.
		},
	};
	return {
		directory,
		files,
		reach: async (socketPath) => {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(forwardDirectory, { recursive: true, mode: 0o700 });
			return runtime.forwardUnixSocket(
				socketPath,
				forwardedSocketPath(forwardDirectory, runtime.id, socketPath),
			);
		},
	};
}
