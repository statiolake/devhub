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
import {
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
		addAgent: () => Promise.resolve("ok"),
		installExtensions: () => Promise.resolve("ok"),
		uninstallExtensions: () => Promise.resolve("ok"),
		listExtensions: () => Promise.resolve("ok"),
		version: () => Promise.resolve("ok"),
		installCli: () => Promise.resolve("ok"),
		terminalProfile: () => Promise.resolve({ file: "tmux", args: [] }),
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
			activate: () => {
				calls.push("activate");
				return Promise.resolve("DevHub is in front.");
			},
			open: (path, cwd, position) => {
				calls.push(
					`open ${path} ${cwd}${position ? ` @${position.line}:${position.column}` : ""}`,
				);
				return Promise.resolve(`opened ${path}`);
			},
			addAgent: (profileId, args, cwd) => {
				calls.push(`agent ${profileId} [${args.join(" ")}] ${cwd}`);
				if (profileId === "nowhere") {
					return Promise.reject(new Error("an agent needs a workspace"));
				}
				return Promise.resolve(`agent ${profileId} started`);
			},
			installExtensions: (targets, force, cwd) => {
				calls.push(`install [${targets.join(" ")}] force=${force} ${cwd}`);
				if (targets.includes("nope.nothing")) {
					return Promise.reject(
						new Error("Extension 'nope.nothing' not found."),
					);
				}
				return Promise.resolve(`installed ${targets.join(", ")}`);
			},
			uninstallExtensions: (ids, force) => {
				calls.push(`uninstall [${ids.join(" ")}] force=${force}`);
				return Promise.resolve(`uninstalled ${ids.join(", ")}`);
			},
			listExtensions: (showVersions) => {
				calls.push(`list versions=${showVersions}`);
				return Promise.resolve(
					showVersions ? "a.b@1.0.0\nc.d@2.0.0" : "a.b\nc.d",
				);
			},
			version: () => Promise.resolve("DevHub 0.1.0\nVS Code 1.0.0\nabc123"),
			installCli: () => Promise.resolve("installed"),
			terminalProfile: (root) => {
				calls.push(`profile ${root ?? "scratch"}`);
				if (root === "/work/gone") {
					return Promise.reject(
						new Error("no DevHub workspace is rooted at /work/gone"),
					);
				}
				return Promise.resolve({
					file: "/usr/bin/tmux",
					args: ["-L", "devhub", "attach-session", "-t", "ws-abc"],
				});
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

	it("installs, lists and uninstalls extensions", async () => {
		expect(
			await ask(
				socketPath,
				`${JSON.stringify({
					kind: "install-extensions",
					targets: ["publisher.name", "./a.vsix"],
					force: true,
					cwd: "/work/a",
				})}\n`,
			),
		).toEqual({ ok: true, message: "installed publisher.name, ./a.vsix" });

		expect(
			await ask(
				socketPath,
				`${JSON.stringify({ kind: "list-extensions", showVersions: true })}\n`,
			),
		).toEqual({ ok: true, message: "a.b@1.0.0\nc.d@2.0.0" });

		expect(
			await ask(
				socketPath,
				`${JSON.stringify({
					kind: "uninstall-extensions",
					ids: ["publisher.name"],
					force: false,
				})}\n`,
			),
		).toEqual({ ok: true, message: "uninstalled publisher.name" });

		expect(calls).toEqual([
			"install [publisher.name ./a.vsix] force=true /work/a",
			"list versions=true",
			"uninstall [publisher.name] force=false",
		]);
	});

	it("reports an install that failed, with the reason", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "install-extensions",
				targets: ["nope.nothing"],
				force: false,
				cwd: "/work/a",
			})}\n`,
		);
		expect(answer).toEqual({
			ok: false,
			message: "Extension 'nope.nothing' not found.",
		});
	});

	it("answers a version request with the three lines it was given", async () => {
		expect(
			await ask(socketPath, `${JSON.stringify({ kind: "version" })}\n`),
		).toEqual({ ok: true, message: "DevHub 0.1.0\nVS Code 1.0.0\nabc123" });
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

		const nothingToInstall = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "install-extensions",
				targets: [],
				force: false,
				cwd: "/work",
			})}\n`,
		);
		expect(nothingToInstall).toEqual({
			ok: false,
			message: "targets must be a non-empty array of non-empty strings",
		});

		const notABoolean = await ask(
			socketPath,
			`${JSON.stringify({ kind: "list-extensions", showVersions: "yes" })}\n`,
		);
		expect(notABoolean).toEqual({
			ok: false,
			message: "showVersions must be a boolean",
		});
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
		server = await startControlServer(socketPath, everythingSaysOk());
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "install-cli" })}\n`,
		);
		expect(answer.ok).toBe(true);
	});

	it("refuses to take a socket another DevHub is answering on", async () => {
		await expect(
			startControlServer(socketPath, everythingSaysOk()),
		).rejects.toThrow(/already listening/);
	});

	it("answers a workbench's terminal profile with the argv, not a sentence", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "terminal-profile", root: "/work/a" })}\n`,
		);
		expect(answer.profile).toEqual({
			file: "/usr/bin/tmux",
			args: ["-L", "devhub", "attach-session", "-t", "ws-abc"],
		});
		expect(calls).toEqual(["profile /work/a"]);
	});

	it("takes a folderless workbench as the Scratch context", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "terminal-profile", root: null })}\n`,
		);
		expect(answer.ok).toBe(true);
		expect(calls).toEqual(["profile scratch"]);
	});

	it("reports a workbench DevHub has no session for, with no profile", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "terminal-profile", root: "/work/gone" })}\n`,
		);
		expect(answer).toEqual({
			ok: false,
			message: "no DevHub workspace is rooted at /work/gone",
		});
	});
});
