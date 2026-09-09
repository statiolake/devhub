/**
 * What a DevHub terminal actually runs.
 *
 * The generated `devhub-terminal` script (see `launcher.ts`) runs this file
 * with the app's own Electron as Node, handing it the workspace folder VS Code
 * resolved for the window. It asks DevHub for that window's argv over the
 * control socket and becomes it.
 *
 * There is no fallback. A DevHub that does not answer means this window has no
 * session to attach to, and the honest end of that is one line in the terminal
 * and a non-zero exit, which VS Code shows in the tab. Starting a bare shell
 * instead would look like a working terminal and be a shell outside tmux —
 * exactly the failure this launcher exists to make impossible.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlResponse } from "../cli/protocol.js";
import { terminalRoot } from "./launcher.js";

/**
 * Ask DevHub for the command line.
 *
 * Nothing is caught beyond naming the transport failure: a socket that is not
 * there is a DevHub that is not there, and that is the answer, not a case to
 * recover from.
 */
export function requestTerminalProfile(
	socketPath: string,
	root: string | null,
): Promise<ControlResponse> {
	return new Promise<ControlResponse>((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ kind: "terminal-profile", root })}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			reject(
				error.code === "ENOENT" || error.code === "ECONNREFUSED"
					? new Error(
							`DevHub is not listening on ${socketPath}, so this window has no terminal session to attach to.`,
						)
					: error,
			);
		});
		socket.on("close", () => {
			const line = buffer.split("\n")[0] ?? "";
			if (line.length === 0) {
				reject(new Error("DevHub closed the connection without answering."));
				return;
			}
			resolve(JSON.parse(line) as ControlResponse);
		});
	});
}

/** What to run, or the sentence saying why there is nothing to run. */
export async function resolveTerminalCommand(
	socketPath: string | undefined,
	argument: string | undefined,
): Promise<{ readonly file: string; readonly args: readonly string[] }> {
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error(
			"DEVHUB_CONTROL_SOCKET is not set, so this terminal cannot ask DevHub which session it belongs to. The launcher that sets it is written by DevHub on startup; a copy of it kept somewhere else is not one.",
		);
	}
	const answer = await requestTerminalProfile(
		socketPath,
		terminalRoot(argument),
	);
	if (!answer.ok || !answer.profile) {
		throw new Error(answer.message);
	}
	return answer.profile;
}

/**
 * Run it, and exit the way it exited.
 *
 * `stdio: "inherit"` hands tmux this terminal's pty itself, so the resizes,
 * the signals and the exit are the session's own rather than something
 * forwarded through here.
 */
export async function main(argv: readonly string[]): Promise<number> {
	const command = await resolveTerminalCommand(
		process.env["DEVHUB_CONTROL_SOCKET"],
		argv[0],
	);
	return await new Promise<number>((resolve, reject) => {
		const child = spawn(command.file, [...command.args], {
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve(signal === null ? (code ?? 0) : 128);
		});
	});
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// The same entry-point test as `../cli/devhubCli.ts`: this module is the entry
// exactly when the runtime was given its own file.
if (
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === resolvePath(process.argv[1])
) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(`devhub-terminal: ${messageOf(error)}`);
			process.exitCode = 1;
		});
}
