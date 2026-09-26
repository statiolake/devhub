/**
 * What a DevHub terminal actually runs.
 *
 * The generated `devhub-terminal` script (see `launcher.ts`) runs this file
 * with the app's own Electron as Node, in the directory VS Code started the
 * terminal in. It asks DevHub which of its sessions that directory belongs to,
 * over the control socket, and prints the argv that attaches to it — one
 * shell-quoted line on stdout, which the launcher `exec`s.
 *
 * Printing rather than running is what puts tmux itself on VS Code's pty. This
 * process is dead by the time tmux starts, so there is no process between the
 * pty and the client: when the terminal goes away the client is hung up on
 * directly, and a tmux client can never outlive the terminal that showed it.
 * Running tmux as a child here would put that guarantee behind this process
 * relaying a signal it may not survive long enough to relay.
 *
 * There is no fallback. A DevHub that does not answer means this window has no
 * session to attach to, and the honest end of that is one line in the terminal
 * and a non-zero exit, which VS Code shows in the tab. Starting a bare shell
 * instead would look like a working terminal and be a shell outside tmux —
 * exactly the failure this launcher exists to make impossible.
 */

import { connect } from "node:net";
import type {
	ControlResponse,
	TerminalProfileAnswer,
} from "../cli/protocol.js";
import {
	DEVHUB_TERMINAL_MACHINE,
	terminalCommandLine,
	terminalRoot,
} from "./launcher.js";

/**
 * Ask DevHub for the command line.
 *
 * Nothing is caught beyond naming the transport failure: a socket that is not
 * there is a DevHub that is not there, and that is the answer, not a case to
 * recover from.
 */
export function requestTerminalProfile(
	socketPath: string,
	machine: string,
	root: string | null,
	workspace?: string,
): Promise<ControlResponse> {
	return new Promise<ControlResponse>((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({
					kind: "terminal-profile",
					machine,
					root,
					...(workspace === undefined ? {} : { workspace }),
				})}\n`,
			);
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

/**
 * The Workspace a window named, when it named one: `--workspace <key>`.
 *
 * A window attached to a dev container starts its DevHub terminal on this Mac
 * with this argument, because the directory it starts in cannot say which
 * Workspace it is for. Anything else on the command line is a launcher this
 * DevHub did not write, and is refused rather than ignored.
 */
export function workspaceArgument(argv: readonly string[]): string | undefined {
	if (argv.length === 0) return undefined;
	const [flag, key, ...rest] = argv;
	if (flag !== "--workspace" || key === undefined || key.length === 0) {
		throw new Error(
			`devhub-terminal takes --workspace <key> and nothing else, and was given: ${argv.join(" ")}`,
		);
	}
	if (rest.length > 0) {
		throw new Error(
			`devhub-terminal takes one --workspace, and was given: ${argv.join(" ")}`,
		);
	}
	return key;
}

/** What to run, or the sentence saying why there is nothing to run. */
export async function resolveTerminalCommand(
	socketPath: string | undefined,
	machine: string | undefined,
	directory: string | undefined,
	workspace?: string,
): Promise<TerminalProfileAnswer> {
	if (socketPath === undefined || socketPath.length === 0) {
		throw new Error(
			"DEVHUB_CONTROL_SOCKET is not set, so this terminal cannot ask DevHub which session it belongs to. The launcher that sets it is written by DevHub on startup; a copy of it kept somewhere else is not one.",
		);
	}
	if (machine === undefined || machine.length === 0) {
		throw new Error(
			`${DEVHUB_TERMINAL_MACHINE} is not set, so this terminal cannot tell DevHub which machine it is on — and a directory without a machine names a different folder on every one of them. The launcher that sets it is written by DevHub on startup; a copy of it kept somewhere else is not one.`,
		);
	}
	const answer = await requestTerminalProfile(
		socketPath,
		machine,
		terminalRoot(directory),
		workspace,
	);
	if (!answer.ok || !answer.profile) {
		throw new Error(answer.message);
	}
	return answer.profile;
}

/**
 * Say what to run, and get out of the way.
 *
 * stdout is the launcher's command substitution and carries nothing but the
 * argv; the failure above goes to stderr, which is the pty, so a person reads
 * it in the tab where the terminal should have been.
 */
export async function main(): Promise<number> {
	const command = await resolveTerminalCommand(
		process.env["DEVHUB_CONTROL_SOCKET"],
		process.env[DEVHUB_TERMINAL_MACHINE],
		process.cwd(),
		workspaceArgument(process.argv.slice(2)),
	);
	process.stdout.write(`${terminalCommandLine(command)}\n`);
	return 0;
}
