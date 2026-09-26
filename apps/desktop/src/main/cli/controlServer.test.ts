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
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
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
		installExtensions: () => Promise.resolve("ok"),
		uninstallExtensions: () => Promise.resolve("ok"),
		listExtensions: () => Promise.resolve("ok"),
		resolveRemote: () =>
			Promise.resolve({
				ok: true as const,
				remote: { port: 1234, connectionToken: "t" },
			}),
		metrics: () => Promise.resolve("ok"),
		version: () => Promise.resolve("ok"),
		installCli: () => Promise.resolve("ok"),
		terminalProfile: () => Promise.resolve({ file: "tmux", args: [], env: {} }),
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
			metrics: () => {
				calls.push("metrics");
				return Promise.resolve('{"processes":[]}');
			},
			installCli: () => Promise.resolve("installed"),
			terminalProfile: (machine, root, workspace) => {
				calls.push(
					`profile ${machine} ${root ?? "scratch"}${workspace === undefined ? "" : ` for ${workspace}`}`,
				);
				if (root === "/work/gone") {
					return Promise.reject(
						new Error("no DevHub workspace is rooted at /work/gone"),
					);
				}
				return Promise.resolve({
					file: "/usr/bin/tmux",
					args: ["-L", "devhub", "attach-session", "-t", "ws-abc"],
					env: { TERMINFO: "/home/dev/.devhub-server/tmux/3.7c/terminfo" },
				});
			},
			resolveRemote: (machine, attempt) => {
				calls.push(`resolve ${machine} #${String(attempt)}`);
				if (machine === "ssh:asleep") {
					return Promise.resolve({
						ok: false as const,
						message: "DevHub cannot reach asleep.",
						retry: true,
					});
				}
				if (machine === "ssh:vax") {
					return Promise.resolve({
						ok: false as const,
						message:
							"DevHub supports Linux and macOS hosts, and vax reports VMS.",
						retry: false,
					});
				}
				if (machine === "ssh:boom") {
					return Promise.reject(new Error("something nobody wrote a case for"));
				}
				return Promise.resolve({
					ok: true as const,
					remote: {
						port: 51234,
						connectionToken: "0123456789abcdef",
						extensionHostEnv: { SSH_AUTH_SOCK: "/tmp/agent.7" },
					},
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

	it("answers a metrics request with the reading the app assembled", async () => {
		expect(
			await ask(socketPath, `${JSON.stringify({ kind: "metrics" })}\n`),
		).toEqual({ ok: true, message: '{"processes":[]}' });
		expect(calls).toEqual(["metrics"]);
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
			`${JSON.stringify({
				kind: "terminal-profile",
				machine: "local",
				root: "/work/a",
			})}\n`,
		);
		expect(answer.profile).toEqual({
			file: "/usr/bin/tmux",
			args: ["-L", "devhub", "attach-session", "-t", "ws-abc"],
			// What the executable needs to be itself travels with it: a tmux
			// DevHub shipped to a host reads the terminfo database that came
			// with it, and nothing else on that machine knows where it is.
			env: { TERMINFO: "/home/dev/.devhub-server/tmux/3.7c/terminfo" },
		});
		expect(calls).toEqual(["profile local /work/a"]);
	});

	it("takes a folderless workbench as the Scratch context", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "terminal-profile", machine: "local", root: null })}\n`,
		);
		expect(answer.ok).toBe(true);
		expect(calls).toEqual(["profile local scratch"]);
	});

	// A path is a path on one machine. Two hosts with the same `/srv/app` are
	// one root to a matcher that was not told which of them is asking, and the
	// session it would answer with is on the wrong computer — so the field is
	// required rather than defaulted to this one.
	it("refuses a terminal profile that does not say which machine asked", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({ kind: "terminal-profile", root: "/srv/app" })}\n`,
		);
		expect(answer.ok).toBe(false);
		expect(answer.message).toContain("machine");
		expect(calls).toEqual([]);
	});

	it("carries the Workspace a window named through to the answer", async () => {
		await ask(
			socketPath,
			`${JSON.stringify({
				kind: "terminal-profile",
				machine: "local",
				root: "/Users/dev",
				workspace: "ssh://build/srv/app",
			})}\n`,
		);
		expect(calls).toEqual(["profile local /Users/dev for ssh://build/srv/app"]);
	});

	it("carries the machine the launcher is on through to the answer", async () => {
		await ask(
			socketPath,
			`${JSON.stringify({
				kind: "terminal-profile",
				machine: "ssh:build-box.example.com",
				root: "/srv/app",
			})}\n`,
		);
		expect(calls).toEqual(["profile ssh:build-box.example.com /srv/app"]);
	});

	it("reports a workbench DevHub has no session for, with no profile", async () => {
		const answer = await ask(
			socketPath,
			`${JSON.stringify({
				kind: "terminal-profile",
				machine: "local",
				root: "/work/gone",
			})}\n`,
		);
		expect(answer).toEqual({
			ok: false,
			message: "no DevHub workspace is rooted at /work/gone",
		});
	});
});

/**
 * The resolve a remote workbench's resolver makes, and the two shapes its
 * answer can take.
 *
 * No socket: what is under test is the dispatch, and the socket is tested
 * above. See `answerControlRequest`.
 */
describe("resolving where a remote workbench connects", () => {
	const seen: string[] = [];

	function handlers(
		resolveRemote: ControlHandlers["resolveRemote"],
	): ControlHandlers {
		return {
			...everythingSaysOk(),
			resolveRemote: (machine, attempt) => {
				seen.push(`${machine} #${String(attempt)}`);
				return resolveRemote(machine, attempt);
			},
		};
	}

	function ask(machine: unknown, attempt: unknown): string {
		return JSON.stringify({ kind: "resolve-remote", machine, attempt });
	}

	beforeEach(() => {
		seen.length = 0;
	});

	it("carries the machine and the attempt through to DevHub", async () => {
		await answerControlRequest(
			ask("ssh:build-box", 3),
			handlers(() =>
				Promise.resolve({
					ok: true,
					remote: { port: 1, connectionToken: "t" },
				}),
			),
		);
		expect(seen).toEqual(["ssh:build-box #3"]);
	});

	it("answers an endpoint as data, not as a sentence to parse", async () => {
		const response = await answerControlRequest(
			ask("ssh:build-box", 1),
			handlers(() =>
				Promise.resolve({
					ok: true,
					remote: {
						port: 51234,
						connectionToken: "0123456789abcdef",
						extensionHostEnv: { SSH_AUTH_SOCK: "/tmp/agent.7" },
					},
				}),
			),
		);
		expect(response.ok).toBe(true);
		expect(response.remote).toEqual({
			port: 51234,
			connectionToken: "0123456789abcdef",
			extensionHostEnv: { SSH_AUTH_SOCK: "/tmp/agent.7" },
		});
	});

	it("says a transient refusal is worth asking about again", async () => {
		// `retry: true` is what the resolver turns into
		// `TemporarilyNotAvailable`, which both of VS Code's loops retry. A host
		// that is asleep is exactly that.
		const response = await answerControlRequest(
			ask("ssh:asleep", 1),
			handlers(() =>
				Promise.resolve({
					ok: false,
					message: "DevHub cannot reach asleep.",
					retry: true,
				}),
			),
		);
		expect(response).toMatchObject({
			ok: false,
			message: "DevHub cannot reach asleep.",
			retry: true,
		});
		expect(response.remote).toBeUndefined();
	});

	it("says a permanent refusal is not", async () => {
		// `retry: false` becomes `NotAvailable`, which makes VS Code stop and
		// show the sentence rather than try five times and show it anyway.
		const response = await answerControlRequest(
			ask("ssh:vax", 1),
			handlers(() =>
				Promise.resolve({
					ok: false,
					message:
						"DevHub supports Linux and macOS hosts, and vax reports VMS.",
					retry: false,
				}),
			),
		);
		expect(response).toMatchObject({ ok: false, retry: false });
	});

	it("treats a failure nobody wrote a case for as worth retrying", async () => {
		// The one place DevHub has no opinion. The two mistakes are not equal: a
		// resolve that goes on retrying stops on VS Code's own attempt limit and
		// says so, and one that wrongly gave up needs the window reopening by
		// hand. So an unanticipated failure is retried.
		const response = await answerControlRequest(
			ask("ssh:boom", 1),
			handlers(() => Promise.reject(new Error("a thing nobody expected"))),
		);
		expect(response).toMatchObject({
			ok: false,
			message: "a thing nobody expected",
			retry: true,
		});
	});

	it("refuses a request that does not say which machine or which attempt", async () => {
		for (const line of [
			ask("", 1),
			ask("ssh:build-box", -1),
			ask("ssh:build-box", 1.5),
			ask("ssh:build-box", "3"),
			JSON.stringify({ kind: "resolve-remote", machine: "ssh:a" }),
		]) {
			const response = await answerControlRequest(
				line,
				handlers(() =>
					Promise.resolve({
						ok: true,
						remote: { port: 1, connectionToken: "t" },
					}),
				),
			);
			expect(response.ok, line).toBe(false);
		}
		// None of them reached DevHub: a request that cannot be read is refused
		// before anything is asked to act on it.
		expect(seen).toEqual([]);
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
		[
			"install-extensions",
			{
				kind: "install-extensions",
				targets: ["a.b"],
				force: false,
				cwd: "/src",
			},
		],
		[
			"uninstall-extensions",
			{ kind: "uninstall-extensions", ids: ["a.b"], force: false },
		],
		["list-extensions", { kind: "list-extensions", showVersions: false }],
		["version", { kind: "version" }],
		["metrics", { kind: "metrics" }],
		["install-cli", { kind: "install-cli" }],
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
		[
			"terminal-profile",
			{ kind: "terminal-profile", machine: "local", root: null },
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
