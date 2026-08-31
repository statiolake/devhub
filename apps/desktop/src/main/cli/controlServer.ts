/**
 * The socket the `devhub` command talks to.
 *
 * One request per connection: a line of JSON in, a line of JSON out, close.
 * Nothing is streamed and nothing is kept, so a client that dies mid-request
 * costs one socket and no state.
 *
 * Every failure becomes `{ ok: false, message }` and is *printed by the CLI* —
 * that is the report, not a log line nobody reads. A handler that throws is
 * reported with its own message; the connection is never left hanging and the
 * error is never swallowed.
 */

import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
	parseControlRequest,
	type ControlPosition,
	type ControlRequest,
	type ControlResponse,
	type TerminalProfileAnswer,
} from "./protocol.js";

/** Longer than any request DevHub sends; short enough that nothing accumulates. */
const MAX_REQUEST_BYTES = 64 * 1024;

export interface ControlHandlers {
	/** A folder or a file. Answers with the text the CLI prints. */
	open(
		path: string,
		cwd: string,
		position: ControlPosition | undefined,
	): Promise<string>;
	addAgent(
		profileId: string,
		args: readonly string[],
		cwd: string,
	): Promise<string>;
	installExtensions(
		targets: readonly string[],
		force: boolean,
		cwd: string,
	): Promise<string>;
	uninstallExtensions(ids: readonly string[], force: boolean): Promise<string>;
	listExtensions(showVersions: boolean): Promise<string>;
	version(): Promise<string>;
	installCli(): Promise<string>;
	/**
	 * The command line the workbench rooted at `root` — or the folderless one,
	 * for `null` — starts its integrated terminal with.
	 */
	terminalProfile(root: string | null): Promise<TerminalProfileAnswer>;
}

export interface ControlServer {
	readonly socketPath: string;
	close(): Promise<void>;
}

/**
 * Take the socket path over, or refuse.
 *
 * A socket file left behind by a crash answers nothing; a socket file with a
 * live DevHub behind it means two mains share one user-data directory, which
 * is the state the single-instance claim exists to prevent. The first is
 * cleared, the second is a startup failure and says so.
 */
async function claimSocketPath(socketPath: string): Promise<void> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	const alive = await new Promise<boolean>((resolve) => {
		const probe = connect(socketPath);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => {
			probe.destroy();
			resolve(false);
		});
	});
	if (alive) {
		throw new Error(
			`another DevHub is already listening on ${socketPath} — two instances cannot share one user-data directory`,
		);
	}
	try {
		unlinkSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function startControlServer(
	socketPath: string,
	handlers: ControlHandlers,
): Promise<ControlServer> {
	await claimSocketPath(socketPath);

	const server: Server = createServer((socket) => {
		serve(socket, handlers);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	// Per-user, and only this user: the directory is 0700 and the socket 0600.
	chmodSync(socketPath, 0o600);
	console.log(`[devhub] control socket listening on ${socketPath}`);

	return {
		socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			}),
	};
}

function serve(socket: Socket, handlers: ControlHandlers): void {
	let buffer = "";
	let answered = false;

	const answer = (response: ControlResponse) => {
		if (answered) return;
		answered = true;
		socket.end(`${JSON.stringify(response)}\n`);
	};

	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (buffer.length > MAX_REQUEST_BYTES) {
			answer({ ok: false, message: "the request is too large" });
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline);
		buffer = "";
		void handle(line, handlers).then(answer);
	});
	socket.on("error", (error) => {
		// A client that vanished is not DevHub's failure to report; anything
		// else about this socket is, and the log is where a socket lives.
		if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
		console.error(`[devhub] control socket: ${error.message}`);
	});
}

async function handle(
	line: string,
	handlers: ControlHandlers,
): Promise<ControlResponse> {
	let request: ControlRequest;
	try {
		request = parseControlRequest(line);
	} catch (error) {
		return { ok: false, message: messageOf(error) };
	}
	try {
		switch (request.kind) {
			case "open":
				return {
					ok: true,
					message: await handlers.open(
						request.path,
						request.cwd,
						request.position,
					),
				};
			case "add-agent":
				return {
					ok: true,
					message: await handlers.addAgent(
						request.profileId,
						request.args,
						request.cwd,
					),
				};
			case "install-extensions":
				return {
					ok: true,
					message: await handlers.installExtensions(
						request.targets,
						request.force,
						request.cwd,
					),
				};
			case "uninstall-extensions":
				return {
					ok: true,
					message: await handlers.uninstallExtensions(
						request.ids,
						request.force,
					),
				};
			case "list-extensions":
				return {
					ok: true,
					message: await handlers.listExtensions(request.showVersions),
				};
			case "version":
				return { ok: true, message: await handlers.version() };
			case "install-cli":
				return { ok: true, message: await handlers.installCli() };
			case "terminal-profile": {
				const profile = await handlers.terminalProfile(request.root);
				return {
					ok: true,
					// The sentence is for a log and for a person who sends this
					// request by hand; the profile is the answer.
					message: `${profile.file} ${profile.args.join(" ")}`,
					profile,
				};
			}
		}
	} catch (error) {
		return { ok: false, message: messageOf(error) };
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
