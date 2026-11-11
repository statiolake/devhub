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
import { failureText } from "../../model/wire.js";
import {
	parseControlRequest,
	type ControlOpenRequest,
	type ControlRequest,
	type ControlResponse,
} from "./protocol.js";
import type { TellCommand } from "./tell/command.js";
import { tellFromWords } from "./tell/request.js";

/**
 * Longer than any request DevHub sends — a `tell` carrying its `--attach`
 * files (25 MB at most, as base64) the longest; short enough that nothing
 * accumulates.
 */
const MAX_REQUEST_BYTES = 36 * 1024 * 1024;

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
	version(): Promise<string>;
	/** One reading of the app's own cost, as JSON. */
	metrics(): Promise<string>;
	/** `devhub --tell`: see `tell/service.ts`. */
	tell(
		command: TellCommand,
		origin: string | undefined,
		machine?: string | undefined,
		as?: string | undefined,
	): Promise<{ readonly message: string; readonly data: unknown }>;
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
		return { ok: false, message: failureText(error) };
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
			case "version":
				return { ok: true, message: await handlers.version() };
			case "metrics":
				return { ok: true, message: await handlers.metrics() };
			case "tell":
				return await answerTell(request, handlers);
		}
	} catch (error) {
		return { ok: false, message: failureText(error) };
	}
}

/**
 * `devhub --tell`'s words, parsed here and run.
 *
 * What the command does with each answer is in the answer: `usage` is a
 * refusal of the command line (exit 2), `stdin` asks for what is piped in,
 * and `json` says which of `message` and `data` to print — including for a
 * failure of the operation itself, which is why that is caught here rather
 * than by the caller's catch.
 */
async function answerTell(
	request: Extract<ControlRequest, { kind: "tell" }>,
	handlers: ControlHandlers,
): Promise<ControlResponse> {
	const words = tellFromWords(
		request.argv,
		request.cwd,
		request.home,
		request.stdin,
		request.files,
	);
	switch (words.kind) {
		case "invalid":
			return { ok: false, message: words.message, usage: true };
		case "help":
			return { ok: true, message: words.usage };
		case "needs-stdin":
			return {
				ok: false,
				message: "'-' reads the text from what is piped in.",
				stdin: true,
			};
		case "needs-files":
			return {
				ok: false,
				message: "--attach reads the files where the command runs.",
				files: words.paths,
			};
		case "tell":
			try {
				const answer = await handlers.tell(
					words.command,
					request.origin,
					request.machine,
					words.as,
				);
				return {
					ok: true,
					message: answer.message,
					data: answer.data,
					json: words.json,
				};
			} catch (error) {
				return { ok: false, message: failureText(error), json: words.json };
			}
	}
}

/**
 * Whether a person typed this — `devhub …` in a terminal — or DevHub's own
 * machinery sent it.
 *
 * A typed command is the person's next operation, exactly as a click in the
 * window is, and it retires what their last one left on screen by the same
 * rule. A ping and a `--wait` ending are nobody's next operation, and neither
 * is a `tell`, which is
 * mostly an Agent asking. Total, so a new request is a compile error here
 * until somebody says which it is.
 */
function typedByPerson(request: ControlRequest): boolean {
	switch (request.kind) {
		case "activate":
		case "open":
		case "add-agent":
		case "version":
		case "metrics":
			return true;
		case "ping":
		case "wait-ended":
		case "tell":
			return false;
	}
}
