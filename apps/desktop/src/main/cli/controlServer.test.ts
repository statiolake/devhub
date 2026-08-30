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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { startControlServer, type ControlServer } from "./controlServer.js";
import type { ControlResponse } from "./protocol.js";

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

describe("the DevHub control socket", () => {
	let scratch: string;
	let socketPath: string;
	let server: ControlServer | undefined;
	let calls: string[];

	beforeEach(async () => {
		scratch = makeScratchDir("cli-control");
		// Short, because a unix socket path is capped at around 104 bytes.
		socketPath = join(scratch, "c.sock");
		calls = [];
		server = await startControlServer(socketPath, {
			open: (path, cwd) => {
				calls.push(`open ${path} ${cwd}`);
				return Promise.resolve(`opened ${path}`);
			},
			addAgent: (profileId, args, cwd) => {
				calls.push(`agent ${profileId} [${args.join(" ")}] ${cwd}`);
				if (profileId === "nowhere") {
					return Promise.reject(new Error("an agent needs a workspace"));
				}
				return Promise.resolve(`agent ${profileId} started`);
			},
			installCli: () => Promise.resolve("installed"),
		});
	});

	afterEach(async () => {
		await server?.close();
		removeScratchDir(scratch);
	});

	it("is readable by its owner and nobody else", () => {
		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
	});

	it("answers an open request with one line and closes", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "open", path: "/work/a/f.txt", cwd: "/work/a" })}\n`,
		);
		expect(answer).toEqual({ ok: true, message: "opened /work/a/f.txt" });
		expect(calls).toEqual(["open /work/a/f.txt /work/a"]);
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
	});

	it("waits for a whole line before answering", async () => {
		const answer = await new Promise<ControlResponse>((resolve, reject) => {
			const socket = connect(socketPath);
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("connect", () => {
				socket.write('{"kind":"ins');
				setTimeout(() => socket.write('tall-cli"}\n'), 20);
			});
			socket.on("data", (chunk: string) => {
				buffer += chunk;
			});
			socket.on("error", reject);
			socket.on("close", () => {
				resolve(JSON.parse(buffer.split("\n")[0] ?? "") as ControlResponse);
			});
		});
		expect(answer).toEqual({ ok: true, message: "installed" });
	});

	it("takes over a socket file a crashed run left behind", async () => {
		await server?.close();
		server = undefined;
		writeFileSync(socketPath, "");
		server = await startControlServer(socketPath, {
			open: () => Promise.resolve("ok"),
			addAgent: () => Promise.resolve("ok"),
			installCli: () => Promise.resolve("ok"),
		});
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "install-cli" })}\n`,
		);
		expect(answer.ok).toBe(true);
	});

	it("refuses to take a socket another DevHub is answering on", async () => {
		await expect(
			startControlServer(socketPath, {
				open: () => Promise.resolve("ok"),
				addAgent: () => Promise.resolve("ok"),
				installCli: () => Promise.resolve("ok"),
			}),
		).rejects.toThrow(/already listening/);
	});
});
