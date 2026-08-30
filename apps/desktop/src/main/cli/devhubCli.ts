/**
 * The `devhub` command.
 *
 * It runs under the app's own Electron binary with `ELECTRON_RUN_AS_NODE=1`,
 * which is what the generated launcher in the PATH directory arranges — so
 * there is no dependency on a system Node, in a checkout or in a packaged app.
 * Nothing here imports Electron, or anything from the app: this file is a
 * socket client and an argument parser, and the whole of DevHub's behaviour
 * lives on the other side of the socket.
 *
 * When DevHub is not running the command says so and stops. Launching the app
 * from the CLI is a later feature; doing it badly — starting a second instance
 * against a user-data directory the first one owns — is the failure mode the
 * whole single-instance design exists to avoid.
 */

import { connect } from "node:net";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { expandPath } from "./resolve.js";
import type { ControlRequest, ControlResponse } from "./protocol.js";

export const USAGE = `devhub — drive the running DevHub from a terminal.

usage:
  devhub <folder>                  make the folder a workspace, show it, and
                                   bring DevHub to the front
  devhub <file>                    open the file in the workspace whose root
                                   contains it, or in the Scratch editor when
                                   no open workspace does
  devhub --agent <profile> [-- <args>...]
                                   add an agent with that profile to the
                                   workspace containing the current directory
                                   and select it; <args> are appended to the
                                   profile's own arguments
  devhub --help                    show this text

The command talks to a running DevHub over its control socket. If DevHub is
not running, start it and try again.`;

export type Command =
	| { readonly kind: "usage"; readonly exitCode: number }
	| { readonly kind: "open"; readonly path: string }
	| {
			readonly kind: "add-agent";
			readonly profileId: string;
			readonly args: readonly string[];
	  };

/**
 * What the arguments asked for.
 *
 * `--` is the boundary and nothing else is: every argument after it belongs to
 * the agent, including ones that look like DevHub's own options. That is the
 * only way `devhub --agent claude -- --help` can mean "ask claude for its
 * help" rather than "print mine".
 */
export function parseArguments(argv: readonly string[]): Command {
	if (argv.length === 0) return { kind: "usage", exitCode: 2 };
	if (argv[0] === "--help" || argv[0] === "-h") {
		return { kind: "usage", exitCode: 0 };
	}
	if (argv[0] === "--agent") {
		const profileId = argv[1];
		if (profileId === undefined || profileId.startsWith("-")) {
			return { kind: "usage", exitCode: 2 };
		}
		const rest = argv.slice(2);
		if (rest.length === 0) return { kind: "add-agent", profileId, args: [] };
		if (rest[0] !== "--") return { kind: "usage", exitCode: 2 };
		return { kind: "add-agent", profileId, args: rest.slice(1) };
	}
	if (argv.length !== 1 || argv[0] === undefined || argv[0].startsWith("-")) {
		return { kind: "usage", exitCode: 2 };
	}
	return { kind: "open", path: argv[0] };
}

export function requestFor(
	command: Command,
	cwd: string,
	home: string,
): ControlRequest | undefined {
	switch (command.kind) {
		case "usage":
			return undefined;
		case "open":
			return { kind: "open", path: expandPath(command.path, cwd, home), cwd };
		case "add-agent":
			return {
				kind: "add-agent",
				profileId: command.profileId,
				args: command.args,
				cwd,
			};
	}
}

async function ask(
	socketPath: string,
	request: ControlRequest,
): Promise<ControlResponse> {
	return new Promise<ControlResponse>((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			reject(
				error.code === "ENOENT" || error.code === "ECONNREFUSED"
					? new Error(
							"DevHub is not running. Start DevHub and run this command again.",
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

export async function main(argv: readonly string[]): Promise<number> {
	const command = parseArguments(argv);
	if (command.kind === "usage") {
		if (command.exitCode === 0) {
			console.log(USAGE);
		} else {
			console.error(USAGE);
		}
		return command.exitCode;
	}
	const socketPath = process.env["DEVHUB_CONTROL_SOCKET"];
	if (!socketPath) {
		console.error(
			"DEVHUB_CONTROL_SOCKET is not set. Run \"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette to write a launcher that sets it.",
		);
		return 1;
	}
	const request = requestFor(command, process.cwd(), homedir());
	if (!request) return 2;
	const response = await ask(socketPath, request);
	if (response.ok) {
		console.log(response.message);
		return 0;
	}
	console.error(response.message);
	return 1;
}

// `import.meta.url` is the module's own path; `process.argv[1]` is the script
// the runtime was given. They are the same file exactly when this module is
// the entry point, which is how an ESM module knows it is being run rather
// than imported by its own tests.
if (
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === resolvePath(process.argv[1])
) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
