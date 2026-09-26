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
	type ControlOpenRequest,
	type ControlRequest,
	type ControlResponse,
	type RemoteEndpointAnswer,
	type TerminalProfileAnswer,
} from "./protocol.js";

/** Longer than any request DevHub sends; short enough that nothing accumulates. */
const MAX_REQUEST_BYTES = 64 * 1024;

export interface ControlHandlers {
	/**
	 * The person started an operation: this is a command they typed. Called
	 * before it is answered, as a dispatch from the window is.
	 */
	personStarted(): void;
	/** Bring DevHub to the front, and change nothing else. */
	activate(): Promise<string>;
	/** A folder or a file. Answers with the text the CLI prints. */
	open(request: ControlOpenRequest): Promise<string>;
	/**
	 * A `--wait` ended: its editor was closed. Answers with the text the CLI
	 * would print if anyone were reading it.
	 */
	waitEnded(waitMarkerPath: string): Promise<string>;
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
	/** One reading of the app's own cost, as JSON. */
	metrics(): Promise<string>;
	installCli(): Promise<string>;
	/**
	 * The command line the workbench rooted at `root` — or the folderless one,
	 * for `null` — starts its integrated terminal with.
	 *
	 * `machine` is the `RuntimeId` of the computer that `root` is a path on, so
	 * that a path is matched against the Workspaces that are actually on it.
	 */
	terminalProfile(
		machine: string,
		root: string | null,
		workspace: string | undefined,
	): Promise<TerminalProfileAnswer>;
	/**
	 * Where a workbench on `machine` connects, and with what token.
	 *
	 * It answers rather than throws, and that is the one thing about this
	 * handler that is not like the others. Every other request here fails into
	 * one shape — a sentence — because there is one thing to do with a failed
	 * `devhub open`. A failed resolve has *two*, and VS Code picks between them
	 * from the error class the extension throws: a `TemporarilyNotAvailable` is
	 * retried by both of its loops, a `NotAvailable` makes it give up at once.
	 * Whether asking again could help is known where the failure happened and
	 * nowhere else — a host that is asleep against a host that is not a machine
	 * DevHub supports — so it travels with the failure instead of being guessed
	 * at from its wording downstream.
	 */
	resolveRemote(machine: string, attempt: number): Promise<RemoteResolution>;
}

/** What `resolveRemote` answers: an endpoint, or a refusal that says whether
 * it is worth asking again. */
export type RemoteResolution =
	| { readonly ok: true; readonly remote: RemoteEndpointAnswer }
	| { readonly ok: false; readonly message: string; readonly retry: boolean };

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
		void answerControlRequest(line, handlers).then(answer);
	});
	socket.on("error", (error) => {
		// A client that vanished is not DevHub's failure to report; anything
		// else about this socket is, and the log is where a socket lives.
		if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
		console.error(`[devhub] control socket: ${error.message}`);
	});
}

/**
 * One request, answered — the whole protocol, with no socket in it.
 *
 * Exported because it is the part worth testing on its own: everything the
 * dispatch decides (which handler, what a thrown handler becomes, how a
 * resolve's two outcomes are spelled on the wire) is a function of a line of
 * text and a set of handlers, and a test that had to bind a unix socket to
 * reach it would be a test about unix sockets. The socket's own properties —
 * the framing, its mode, a stale file — are tested through the real one, which
 * is the other half of the same file.
 */
export async function answerControlRequest(
	line: string,
	handlers: ControlHandlers,
): Promise<ControlResponse> {
	let request: ControlRequest;
	try {
		request = parseControlRequest(line);
	} catch (error) {
		return { ok: false, message: messageOf(error) };
	}
	if (typedByPerson(request)) handlers.personStarted();
	try {
		switch (request.kind) {
			// Answered here rather than by a handler, and that is the point: what
			// is being asked is whether there is a DevHub behind this socket, and
			// an answer that depended on the app being able to do something would
			// be a different question with the same name. See `protocol.ts`.
			case "ping":
				return { ok: true, message: "DevHub is running." };
			case "activate":
				return { ok: true, message: await handlers.activate() };
			case "open":
				return { ok: true, message: await handlers.open(request) };
			case "wait-ended":
				return {
					ok: true,
					message: await handlers.waitEnded(request.waitMarkerPath),
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
			case "metrics":
				return { ok: true, message: await handlers.metrics() };
			case "install-cli":
				return { ok: true, message: await handlers.installCli() };
			case "resolve-remote": {
				// Caught here rather than by the `catch` below, because that one
				// produces a failure with no `retry` on it — which the resolver
				// reads as "permanent" and VS Code acts on by giving up. A
				// failure DevHub did not anticipate is the one case where it has
				// no opinion, and the safer of the two answers is the one that
				// lets the workbench try again: a resolve that keeps failing
				// stops on VS Code's own attempt limit, where a resolve that
				// wrongly gave up needs the window reopening by hand.
				let resolution: RemoteResolution;
				try {
					resolution = await handlers.resolveRemote(
						request.machine,
						request.attempt,
					);
				} catch (error) {
					return { ok: false, message: messageOf(error), retry: true };
				}
				return resolution.ok
					? {
							ok: true,
							// The sentence is for a log and for whoever sends this
							// by hand; the endpoint is the answer.
							message: `127.0.0.1:${String(resolution.remote.port)}`,
							remote: resolution.remote,
						}
					: {
							ok: false,
							message: resolution.message,
							retry: resolution.retry,
						};
			}
			case "terminal-profile": {
				const profile = await handlers.terminalProfile(
					request.machine,
					request.root,
					request.workspace,
				);
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

/**
 * Whether a person typed this — `devhub …` in a terminal — or DevHub's own
 * machinery sent it.
 *
 * A typed command is the person's next operation, exactly as a click in the
 * window is, and it retires what their last one left on screen by the same
 * rule. A ping, a `--wait` ending, and a workbench asking for its host or its
 * terminal are nobody's next operation. Total, so a new request is a compile
 * error here until somebody says which it is.
 */
function typedByPerson(request: ControlRequest): boolean {
	switch (request.kind) {
		case "activate":
		case "open":
		case "add-agent":
		case "install-extensions":
		case "uninstall-extensions":
		case "list-extensions":
		case "version":
		case "metrics":
		case "install-cli":
			return true;
		case "ping":
		case "wait-ended":
		case "resolve-remote":
		case "terminal-profile":
			return false;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
