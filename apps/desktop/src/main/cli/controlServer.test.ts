/**
 * The control protocol, over a real unix socket.
 *
 * Not a mock: the socket is what the `devhub` command actually talks to, and
 * the things worth testing about it — the framing, the permissions, a stale
 * socket file, a handler that throws — are all properties of the real one.
 */

import { connect } from "node:net";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSocketDir, removeScratchDir } from "../../model/testScratch.js";
import {
	errorWireAt,
	NamedFailure,
	withDetail,
	withSummary,
} from "../../model/wire.js";
import { portFailure } from "../terminal/ports.js";
import {
	answerControlRequest,
	startControlServer,
	type ControlHandlers,
	type ControlServer,
} from "./controlServer.js";
import type { ControlResponse } from "./protocol.js";

/** A server for the tests that are about the socket rather than the handlers. */
function everythingSaysOk(): ControlHandlers {
	return {
		activate: () => Promise.resolve("ok"),
		open: () => Promise.resolve("ok"),
		waitEnded: () => Promise.resolve("ok"),
		addAgent: () => Promise.resolve("ok"),
		metrics: () => Promise.resolve("ok"),
		tell: () => Promise.resolve({ message: "ok", data: {} }),
		version: () => Promise.resolve("ok"),
		personStarted: () => undefined,
	};
}

function ask(socketPath: string, line: string): Promise<ControlResponse> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(line));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
		});
		socket.on("error", reject);
		socket.on("close", () => {
			resolve(JSON.parse(buffer.split("\n")[0] ?? "") as ControlResponse);
		});
	});
}

/**
 * Lines sent one after another on one connection, each once the one before
 * it is answered: the answers, and whether the server closed after the last.
 */
function converse(
	socketPath: string,
	lines: readonly string[],
): Promise<{ answers: ControlResponse[]; closed: boolean }> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const answers: ControlResponse[] = [];
		let buffer = "";
		let closed = false;
		const settle = () => {
			// A moment for a close that follows the last answer to arrive.
			setTimeout(() => {
				socket.destroy();
				resolve({ answers, closed });
			}, 50);
		};
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(lines[0] ?? ""));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				answers.push(JSON.parse(buffer.slice(0, newline)) as ControlResponse);
				buffer = buffer.slice(newline + 1);
				const next = lines[answers.length];
				if (next === undefined) {
					settle();
					return;
				}
				socket.write(next);
			}
		});
		socket.on("end", () => {
			closed = true;
		});
		socket.on("error", reject);
	});
}

describe("the DevHub control socket", () => {
	let scratch: string;
	let socketPath: string;
	let server: ControlServer | undefined;
	let calls: string[];

	beforeEach(async () => {
		scratch = makeSocketDir("cli-control");
		socketPath = join(scratch, "c.sock");
		calls = [];
		server = await startControlServer(socketPath, {
			personStarted: () => undefined,
			activate: () => {
				calls.push("activate");
				return Promise.resolve("DevHub is in front.");
			},
			open: ({ path, cwd, machine, position, waitMarkerPath }) => {
				calls.push(
					`open ${path} ${cwd}${machine ? ` on=${machine}` : ""}${position ? ` @${position.line}:${position.column}` : ""}${waitMarkerPath ? ` wait=${waitMarkerPath}` : ""}`,
				);
				return Promise.resolve(`opened ${path}`);
			},
			waitEnded: (waitMarkerPath) => {
				calls.push(`wait-ended ${waitMarkerPath}`);
				return Promise.resolve("back where it was");
			},
			addAgent: (profileId, args, cwd) => {
				calls.push(`agent ${profileId} [${args.join(" ")}] ${cwd}`);
				if (profileId === "nowhere") {
					return Promise.reject(new Error("an agent needs a workspace"));
				}
				return Promise.resolve(`agent ${profileId} started`);
			},
			version: () => Promise.resolve("DevHub 0.1.0\nabc123"),
			tell: (command, origin) => {
				calls.push(`tell ${command.verb}${origin ? ` from=${origin}` : ""}`);
				if (command.verb === "agent-answer")
					return Promise.reject(new Error("only questions"));
				return Promise.resolve({
					message: "2 agents",
					data: { agents: ["a", "b"] },
				});
			},
			metrics: () => {
				calls.push("metrics");
				return Promise.resolve('{"processes":[]}');
			},
		});
	});

	afterEach(async () => {
		await server?.close();
		removeScratchDir(scratch);
	});

	it("is readable by its owner and nobody else", () => {
		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
	});

	/** `devhub` on its own: the one request that carries nothing with it. */
	it("answers a bare activate request", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "activate" })}\n`,
		);
		expect(answer).toEqual({ ok: true, message: "DevHub is in front." });
		expect(calls).toEqual(["activate"]);
	});

	it("answers an open request with one line and closes", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "open", path: "/work/a/f.txt", cwd: "/work/a" })}\n`,
		);
		expect(answer).toEqual({ ok: true, message: "opened /work/a/f.txt" });
		expect(calls).toEqual(["open /work/a/f.txt /work/a"]);
	});

	/**
	 * Which computer the path is on rides with it, because it is the fact that
	 * keeps `/srv/app` on two hosts from being one root.
	 */
	it("carries the machine an open's path is on through to the handler", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "open",
				path: "/srv/app/f.txt",
				cwd: "/srv/app",
				machine: "ssh:build-host",
			})}\n`,
		);
		expect(answer.ok).toBe(true);
		expect(calls).toEqual(["open /srv/app/f.txt /srv/app on=ssh:build-host"]);
	});

	/** Absent is the honest "this Mac", and it stays absent rather than becoming a default here. */
	it("leaves an open with no machine saying nothing about one", async () => {
		await ask(
			socketPath,
			`${JSON.stringify({ kind: "open", path: "/work/a/f.txt", cwd: "/work/a" })}\n`,
		);
		expect(calls).toEqual(["open /work/a/f.txt /work/a"]);
	});

	it("refuses an open whose machine is not a string", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "open",
				path: "/work/a/f.txt",
				cwd: "/work/a",
				machine: 7,
			})}\n`,
		);
		expect(answer.ok).toBe(false);
		expect(answer.message).toMatch(/machine must be a non-empty string/);
		expect(calls).toEqual([]);
	});

	/** `--wait` reaches the app as part of the open it belongs to. */
	it("carries a wait marker through to the handler", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "open",
				path: "/work/a/COMMIT_EDITMSG",
				cwd: "/work/a",
				waitMarkerPath: "/tmp/devhub-wait-abc/marker",
			})}\n`,
		);
		expect(answer.ok).toBe(true);
		expect(calls).toEqual([
			"open /work/a/COMMIT_EDITMSG /work/a wait=/tmp/devhub-wait-abc/marker",
		]);
	});

	/** The end of a wait is its own request, sent by the CLI that watched it. */
	it("carries the end of a wait through to the handler", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "wait-ended",
				waitMarkerPath: "/tmp/devhub-wait-abc/marker",
			})}\n`,
		);
		expect(answer).toEqual({ ok: true, message: "back where it was" });
		expect(calls).toEqual(["wait-ended /tmp/devhub-wait-abc/marker"]);
	});

	it("refuses the end of a wait whose marker is not an absolute path", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "wait-ended", waitMarkerPath: "marker" })}\n`,
		);
		expect(answer.ok).toBe(false);
		expect(answer.message).toMatch(/waitMarkerPath must be an absolute path/);
		expect(calls).toEqual([]);
	});

	/** A marker that is not an absolute path is not a marker this app made. */
	it("refuses a wait marker that is not an absolute path", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "open",
				path: "/work/a/f.txt",
				cwd: "/work/a",
				waitMarkerPath: "marker",
			})}\n`,
		);
		expect(answer.ok).toBe(false);
		expect(answer.message).toMatch(/waitMarkerPath must be an absolute path/);
		expect(calls).toEqual([]);
	});

	it("carries the agent's own arguments through untouched", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "add-agent",
				profileId: "claude",
				args: ["--help", "--", "-x"],
				cwd: "/work/a",
			})}\n`,
		);
		expect(answer.ok).toBe(true);
		expect(calls).toEqual(["agent claude [--help -- -x] /work/a"]);
	});

	it("reports a handler's refusal instead of pretending it worked", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "add-agent",
				profileId: "nowhere",
				args: [],
				cwd: "/tmp",
			})}\n`,
		);
		expect(answer).toEqual({
			ok: false,
			message: "an agent needs a workspace",
		});
	});

	it("carries a --goto position through to the handler", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "open",
				path: "/work/a/f.txt",
				cwd: "/work/a",
				position: { line: 42, column: 7 },
			})}\n`,
		);
		expect(answer.ok).toBe(true);
		expect(calls).toEqual(["open /work/a/f.txt /work/a @42:7"]);
	});

	it("refuses a position that is not a place in a file", async () => {
		for (const position of [
			{ line: 0, column: 1 },
			{ line: 1, column: 0 },
			{ line: 2.5, column: 1 },
			{ line: "3", column: 1 },
		]) {
			const answer = await ask(
				socketPath,
				`${JSON.stringify({
					kind: "open",
					path: "/work/a/f.txt",
					cwd: "/work/a",
					position,
				})}\n`,
			);
			expect(answer.ok).toBe(false);
			expect(answer.message).toMatch(/whole number from 1 up/);
		}
		expect(calls).toEqual([]);
	});

	it("answers a version request with the lines it was given", async () => {
		expect(
			await ask(socketPath, `${JSON.stringify({ kind: "version" })}\n`),
		).toEqual({ ok: true, message: "DevHub 0.1.0\nabc123" });
	});

	it("answers a metrics request with the reading the app assembled", async () => {
		expect(
			await ask(socketPath, `${JSON.stringify({ kind: "metrics" })}\n`),
		).toEqual({ ok: true, message: '{"processes":[]}' });
		expect(calls).toEqual(["metrics"]);
	});

	const tell = (argv: string[], extra: Record<string, unknown> = {}) =>
		`${JSON.stringify({ kind: "tell", argv, cwd: "/work", home: "/home/d", ...extra })}\n`;

	it("answers a tell request with its sentence and its data", async () => {
		expect(
			await ask(socketPath, tell(["agents"], { origin: "local\tscratch\tA1" })),
		).toEqual({
			ok: true,
			message: "2 agents",
			data: { agents: ["a", "b"] },
			json: false,
		});
		expect(calls).toEqual(["tell agents from=local\tscratch\tA1"]);
	});

	it("says when --json was asked for, on success and on failure", async () => {
		expect(await ask(socketPath, tell(["--json", "agents"]))).toMatchObject({
			ok: true,
			json: true,
		});
		expect(
			await ask(
				socketPath,
				tell(["--json", "agent", "answer", "a", "r", "--option", "1"]),
			),
		).toEqual({ ok: false, message: "only questions", json: true });
	});

	it("reports a tell the app refused, as a failure", async () => {
		const answer = await ask(
			socketPath,
			tell(["agent", "answer", "a", "r", "--option", "1"]),
		);
		expect(answer.ok).toBe(false);
		expect(answer.message).toContain("only questions");
		expect(answer.usage).toBeUndefined();
	});

	it("refuses words that are not a command as a command line, and runs nothing", async () => {
		const answer = await ask(socketPath, tell(["rm", "-rf"]));
		expect(answer).toMatchObject({ ok: false, usage: true });
		expect(calls).toEqual([]);
	});

	it("answers help with the usage, and runs nothing", async () => {
		const answer = await ask(socketPath, tell(["help"]));
		expect(answer.ok).toBe(true);
		expect(answer.message).toContain("devhub --tell");
		expect(calls).toEqual([]);
	});

	it("asks for what is piped in when a '-' is text, then uses it", async () => {
		expect(
			await ask(
				socketPath,
				tell(["agent", "send", "a", "-"], { stdin: "hi\n" }),
			),
		).toMatchObject({ ok: true });
		expect(calls).toEqual(["tell agent-send"]);
	});

	it("asks for the piped text on the connection that will carry it", async () => {
		const { answers, closed } = await converse(socketPath, [
			tell(["agent", "send", "a", "-"]),
			tell(["agent", "send", "a", "-"], { stdin: "hi\n" }),
		]);
		expect(answers).toMatchObject([
			{ ok: false, stdin: true },
			{ ok: true, message: "2 agents" },
		]);
		expect(calls).toEqual(["tell agent-send"]);
		// Answered, it closes as every connection does.
		expect(closed).toBe(true);
	});

	it("closes after an answer that asks for nothing", async () => {
		const { answers, closed } = await converse(socketPath, [
			`${JSON.stringify({ kind: "version" })}\n`,
		]);
		expect(answers).toMatchObject([{ ok: true }]);
		expect(closed).toBe(true);
	});

	it("reads a large request whole, in time linear in its size", async () => {
		const text = "x".repeat(20 * 1024 * 1024);
		const started = performance.now();
		const answer = await ask(
			socketPath,
			tell(["agent", "send", "a", "-"], { stdin: text }),
		);
		expect(answer).toMatchObject({ ok: true });
		expect(calls).toEqual(["tell agent-send"]);
		// Searched from the start on every chunk, 20 MB took tens of seconds.
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("carries the orchestration commands to the app", async () => {
		for (const argv of [
			["agent", "stop", "a"],
			["agent", "restart", "a"],
			["agent", "status", "a"],
			["agent", "wait", "--any"],
			["sessions"],
			["agent", "resume", "abcd"],
		])
			expect(await ask(socketPath, tell(argv))).toMatchObject({ ok: true });
		expect(calls).toEqual([
			"tell agent-stop",
			"tell agent-restart",
			"tell agent-status",
			"tell agent-wait-many",
			"tell sessions",
			"tell agent-resume",
		]);
	});

	it("refuses a tell without the directory its paths were typed in", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "tell", argv: ["agents"] })}\n`,
		);
		expect(answer.ok).toBe(false);
		expect(calls).toEqual([]);
	});

	it("refuses a request it does not understand", async () => {
		const unknown = await ask(
			socketPath,
			`${JSON.stringify({ kind: "eval" })}\n`,
		);
		expect(unknown.ok).toBe(false);
		expect(unknown.message).toContain("unknown control request");

		const relative = await ask(
			socketPath,
			`${JSON.stringify({ kind: "open", path: "f.txt", cwd: "/work" })}\n`,
		);
		expect(relative).toEqual({
			ok: false,
			message: "path must be an absolute path",
		});

		const garbage = await ask(socketPath, "not json\n");
		expect(garbage.ok).toBe(false);

		const retired = await ask(
			socketPath,
			`${JSON.stringify({ kind: "install-extensions", targets: ["a.b"] })}\n`,
		);
		expect(retired.ok).toBe(false);
	});

	it("waits for a whole line before answering", async () => {
		const answer = await new Promise<ControlResponse>((resolve, reject) => {
			const socket = connect(socketPath);
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("connect", () => {
				socket.write('{"kind":"ver');
				setTimeout(() => socket.write('sion"}\n'), 20);
			});
			socket.on("data", (chunk: string) => {
				buffer += chunk;
			});
			socket.on("error", reject);
			socket.on("close", () => {
				resolve(JSON.parse(buffer.split("\n")[0] ?? "") as ControlResponse);
			});
		});
		expect(answer).toEqual({
			ok: true,
			message: "DevHub 0.1.0\nabc123",
		});
	});

	it("takes over a socket file a crashed run left behind", async () => {
		await server?.close();
		server = undefined;
		writeFileSync(socketPath, "");
		server = await startControlServer(socketPath, everythingSaysOk());
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "version" })}\n`,
		);
		expect(answer.ok).toBe(true);
	});

	it("refuses to take a socket another DevHub is answering on", async () => {
		await expect(
			startControlServer(socketPath, everythingSaysOk()),
		).rejects.toThrow(/already listening/);
	});
});

describe("a command the person typed", () => {
	// Their next operation, exactly as a click in the window is: the notice a
	// person closed stays closed until they do something else, and typing
	// `devhub …` is doing something else. What DevHub's own machinery asks —
	// a ping, a `--wait` ending, a workbench resolving its host or its
	// terminal — is nobody's next operation.
	it.each([
		["activate", { kind: "activate" }],
		["open", { kind: "open", path: "/src/api", cwd: "/src" }],
		[
			"add-agent",
			{ kind: "add-agent", profileId: "claude", args: [], cwd: "/src" },
		],
		["version", { kind: "version" }],
		["metrics", { kind: "metrics" }],
	])("starts an operation: %s", async (_kind, request) => {
		const personStarted = vi.fn();
		await answerControlRequest(JSON.stringify(request), {
			...everythingSaysOk(),
			personStarted,
		});
		expect(personStarted).toHaveBeenCalledTimes(1);
	});

	it.each([
		["ping", { kind: "ping" }],
		["wait-ended", { kind: "wait-ended", waitMarkerPath: "/src/.wait" }],
		[
			"resolve-remote",
			{ kind: "resolve-remote", machine: "ssh:build-box", attempt: 1 },
		],
	])("is not what DevHub's own machinery asks: %s", async (_kind, request) => {
		const personStarted = vi.fn();
		await answerControlRequest(JSON.stringify(request), {
			...everythingSaysOk(),
			personStarted,
		});
		expect(personStarted).not.toHaveBeenCalled();
	});
});

/**
 * What `devhub` prints when DevHub refuses: the words the refusal is drawn
 * with on a page — its title and its detail — and never the failure's
 * message, which is its wire on its way across IPC.
 */
describe("a refusal the devhub command prints", () => {
	function refusingOpen(failure: unknown): ControlHandlers {
		return { ...everythingSaysOk(), open: () => Promise.reject(failure) };
	}

	async function printed(failure: unknown): Promise<string> {
		const response = await answerControlRequest(
			JSON.stringify({ kind: "open", path: "/srv/api", cwd: "/srv" }),
			refusingOpen(failure),
		);
		expect(response.ok).toBe(false);
		return response.message;
	}

	it("prints a named failure as its title and its detail", async () => {
		expect(
			await printed(
				new NamedFailure(
					withDetail(
						errorWireAt("workspace_unavailable"),
						"/srv/api is not there any more.",
					),
				),
			),
		).toBe("The workspace is unavailable. /srv/api is not there any more.");
	});

	it("prints a domain's kind under the title its code gives it", async () => {
		expect(
			await printed(
				portFailure("unavailable", { detail: "build-box did not answer." }),
			),
		).toBe("The machine is unavailable. build-box did not answer.");
	});

	it("prints a failure with a title of its own as that title", async () => {
		expect(
			await printed(
				new NamedFailure(
					withSummary(
						errorWireAt("workspace_unavailable"),
						"fatal: repository 'x' not found",
					),
				),
			),
		).toBe("fatal: repository 'x' not found");
	});

	it("prints a failure nobody worded as its own message", async () => {
		expect(await printed(new Error("boom"))).toBe("boom");
	});
});
