import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	callerContext,
	main,
	parseArguments,
	requestFor,
	USAGE,
} from "./devhubCli.js";

describe("what the devhub command was asked to do", () => {
	it("takes a lone path as something to open", () => {
		expect(parseArguments(["src/main.ts"])).toEqual({
			kind: "open",
			path: "src/main.ts",
			position: undefined,
			wait: false,
		});
	});

	it("takes an agent profile, with no arguments of its own", () => {
		expect(parseArguments(["--agent", "claude"])).toEqual({
			kind: "add-agent",
			profileId: "claude",
			args: [],
		});
	});

	it("gives everything after `--` to the agent, options included", () => {
		expect(
			parseArguments(["--agent", "claude", "--", "--help", "-p", "hi"]),
		).toEqual({
			kind: "add-agent",
			profileId: "claude",
			args: ["--help", "-p", "hi"],
		});
	});

	/**
	 * `devhub` with nothing after it is the smallest useful thing the command
	 * does: it brings the app you already have to the front. It is deliberately
	 * not the usage text — a bare command that prints a wall of help is a
	 * command that made you read instead of doing the obvious thing.
	 */
	it("takes no arguments at all as a request to come to the front", () => {
		expect(parseArguments([])).toEqual({ kind: "activate" });
		expect(requestFor(parseArguments([]), "/work", "/home/d")).toEqual({
			kind: "activate",
		});
		expect(USAGE).toContain("bring DevHub to the front");
	});

	/**
	 * A lone `-` is the pipe. It must not be read as an option nobody knows,
	 * and it must not be read as a file named `-`: both would report on
	 * something the person never asked about.
	 */
	it("takes a lone dash as the pipe, and only on its own", () => {
		expect(parseArguments(["-"])).toEqual({ kind: "open-stdin", wait: false });
		expect(parseArguments(["-", "notes.md"])).toEqual({
			kind: "invalid",
			message: "devhub does one of these things at a time.",
		});
		expect(parseArguments(["-", "--version"]).kind).toBe("invalid");
		expect(USAGE).toContain("devhub -  ");
	});

	/**
	 * There is no file yet when `-` is parsed — `main` spools stdin to one and
	 * carries on as an ordinary open of that file. A request built straight
	 * from `open-stdin` would have to invent a path, so it refuses instead.
	 */
	it("has no request to send for a pipe it has not read yet", () => {
		expect(() =>
			requestFor(parseArguments(["-"]), "/work", "/home/d"),
		).toThrowError(/spooled to a file/);
	});

	/**
	 * `--wait` says how to open, not what to open, so it rides along with a
	 * path, a pipe or a `--goto` rather than competing with them. That is what
	 * makes `EDITOR='devhub --wait'` a thing you can set once.
	 */
	it("takes --wait as a way of opening, not a thing to open", () => {
		expect(parseArguments(["--wait", "notes.md"])).toEqual({
			kind: "open",
			path: "notes.md",
			position: undefined,
			wait: true,
		});
		expect(parseArguments(["-w", "notes.md"])).toEqual({
			kind: "open",
			path: "notes.md",
			position: undefined,
			wait: true,
		});
		// Order is not meaning, as it is not for --force.
		expect(parseArguments(["notes.md", "--wait"])).toEqual({
			kind: "open",
			path: "notes.md",
			position: undefined,
			wait: true,
		});
		expect(parseArguments(["--wait", "-g", "a.ts:9:2"])).toEqual({
			kind: "open",
			path: "a.ts",
			position: { line: 9, column: 2 },
			wait: true,
		});
		expect(parseArguments(["--wait", "-"])).toEqual({
			kind: "open-stdin",
			wait: true,
		});
	});

	/** Waiting for nothing is a wait that never ends, so it is refused. */
	it("refuses a --wait with nothing to wait for", () => {
		expect(parseArguments(["--wait"])).toEqual({
			kind: "invalid",
			message:
				"--wait waits for a file to be closed, so it needs a file to open.",
		});
	});

	/**
	 * The marker is made by `main` before the request is built, because the
	 * workbench deletes it to say the editor closed. It reaches the app as part
	 * of the open, since there is no waiting to be done for a file nobody
	 * opened.
	 */
	it("sends the wait marker along with the file it belongs to", () => {
		expect(
			requestFor(
				parseArguments(["--wait", "notes.md"]),
				"/work/a",
				"/home/d",
				"/tmp/devhub-wait-abc/marker",
			),
		).toEqual({
			kind: "open",
			path: "/work/a/notes.md",
			cwd: "/work/a",
			waitMarkerPath: "/tmp/devhub-wait-abc/marker",
		});
		// Without --wait there is no marker, and the message is byte for byte
		// the one devhub has always sent.
		expect(
			requestFor(parseArguments(["notes.md"]), "/work/a", "/home/d"),
		).toEqual({ kind: "open", path: "/work/a/notes.md", cwd: "/work/a" });
	});

	/**
	 * Where the request came from is carried, never worked out. DevHub stated
	 * it on the tmux session when it made the session; this command's job is
	 * to hand it back.
	 */
	it("carries the pane's origin and machine into the open", () => {
		const caller = callerContext({
			DEVHUB_ORIGIN:
				"ssh:build-host\t00000000-0000-4000-8000-000000000001\tnone",
			DEVHUB_MACHINE: "ssh:build-host",
		});

		expect(
			requestFor(
				parseArguments(["notes.md"]),
				"/srv/app",
				"/home/user",
				undefined,
				caller,
			),
		).toEqual({
			kind: "open",
			path: "/srv/app/notes.md",
			cwd: "/srv/app",
			machine: "ssh:build-host",
			origin: "ssh:build-host\t00000000-0000-4000-8000-000000000001\tnone",
		});
	});

	/**
	 * A login shell, a script, a cron job. Absent is the honest unknown, and it
	 * has to stay absent on the wire — a `local` invented here would be a
	 * second place deciding what DevHub already decides in `route.ts`.
	 */
	it("says nothing about an origin it was not given", () => {
		expect(callerContext({})).toEqual({});
		// An empty variable is the shape a shell leaves behind when something
		// exported it and gave it nothing, and it is not an origin.
		expect(callerContext({ DEVHUB_ORIGIN: "", DEVHUB_MACHINE: "" })).toEqual(
			{},
		);
		// Byte for byte the message devhub has always sent from a login shell.
		expect(
			requestFor(parseArguments(["notes.md"]), "/work/a", "/home/d"),
		).toEqual({ kind: "open", path: "/work/a/notes.md", cwd: "/work/a" });
	});

	it("prints its usage on request", () => {
		expect(parseArguments(["--help"])).toEqual({ kind: "usage" });
		expect(parseArguments(["-h"])).toEqual({ kind: "usage" });
		expect(USAGE).toContain("devhub --agent");
		expect(USAGE).toContain("--install-extension");
		expect(USAGE).toContain("--list-extensions");
		expect(USAGE).toContain("--goto");
	});

	it("says what is wrong rather than printing the whole usage at nothing", () => {
		// `devhub` alone is a request, not a mistake — see the activate test.
		// Arguments that add up to no request still are one.
		expect(parseArguments(["--force"])).toEqual({
			kind: "invalid",
			message: "devhub was not asked to do anything.",
		});
		expect(parseArguments(["--agent"])).toEqual({
			kind: "invalid",
			message: "--agent needs the name of an agent profile.",
		});
		expect(parseArguments(["--agent", "--help"])).toEqual({
			kind: "invalid",
			message: "--agent needs the name of an agent profile.",
		});
		// Agent arguments have to be behind `--`, so that a future DevHub option
		// cannot silently start meaning something to the agent instead.
		expect(parseArguments(["--agent", "claude", "--help"]).kind).toBe(
			"invalid",
		);
		expect(parseArguments(["a.txt", "b.txt"])).toEqual({
			kind: "invalid",
			message: "devhub opens one path at a time.",
		});
	});

	/**
	 * The whole point of the refusal: an option nobody implemented must never
	 * become a path, because "no such file or directory: --isntall-extension"
	 * is a report about the wrong thing entirely.
	 */
	it("refuses an option it does not know, and never treats one as a path", () => {
		expect(parseArguments(["--isntall-extension", "a.b"])).toEqual({
			kind: "invalid",
			message: "devhub does not know the option '--isntall-extension'.",
		});
		expect(parseArguments(["-x"])).toEqual({
			kind: "invalid",
			message: "devhub does not know the option '-x'.",
		});
		expect(parseArguments(["--new-window", "/work"])).toEqual({
			kind: "invalid",
			message: "devhub does not know the option '--new-window'.",
		});
	});

	it("reads --goto in every form code reads it", () => {
		expect(parseArguments(["--goto", "src/a.ts:42:7"])).toEqual({
			kind: "open",
			path: "src/a.ts",
			position: { line: 42, column: 7 },
			wait: false,
		});
		// A line without a column is the start of the line.
		expect(parseArguments(["-g", "src/a.ts:42"])).toEqual({
			kind: "open",
			path: "src/a.ts",
			position: { line: 42, column: 1 },
			wait: false,
		});
		// No position at all is a plain open, as `code --goto file` is.
		expect(parseArguments(["--goto", "src/a.ts"])).toEqual({
			kind: "open",
			path: "src/a.ts",
			position: undefined,
			wait: false,
		});
		// A colon can be part of a path; only trailing numbers are a position.
		expect(parseArguments(["--goto", "/w/a:b/c.ts:3"])).toEqual({
			kind: "open",
			path: "/w/a:b/c.ts",
			position: { line: 3, column: 1 },
			wait: false,
		});
	});

	it("refuses a --goto that does not name a place in a file", () => {
		expect(parseArguments(["--goto"]).kind).toBe("invalid");
		expect(parseArguments(["--goto", "a.ts:0"]).kind).toBe("invalid");
		expect(parseArguments(["--goto", "a.ts:2.5"]).kind).toBe("invalid");
		expect(parseArguments(["--goto", "a.ts:"]).kind).toBe("invalid");
	});

	it("collects extensions to install, in any order, with --force", () => {
		expect(
			parseArguments([
				"--install-extension",
				"a.b",
				"--force",
				"--install-extension",
				"./c.vsix",
			]),
		).toEqual({
			kind: "install-extensions",
			targets: ["a.b", "./c.vsix"],
			force: true,
		});
		// `--option=value` means the same thing, as it does for `code`.
		expect(parseArguments(["--install-extension=a.b"])).toEqual({
			kind: "install-extensions",
			targets: ["a.b"],
			force: false,
		});
		expect(parseArguments(["--install-extension"]).kind).toBe("invalid");
	});

	it("collects extensions to uninstall, and lists them", () => {
		expect(
			parseArguments([
				"--uninstall-extension",
				"a.b",
				"--uninstall-extension",
				"c.d",
			]),
		).toEqual({
			kind: "uninstall-extensions",
			ids: ["a.b", "c.d"],
			force: false,
		});
		expect(parseArguments(["--list-extensions"])).toEqual({
			kind: "list-extensions",
			showVersions: false,
		});
		expect(parseArguments(["--list-extensions", "--show-versions"])).toEqual({
			kind: "list-extensions",
			showVersions: true,
		});
	});

	it("prints its versions", () => {
		expect(parseArguments(["--version"])).toEqual({ kind: "version" });
		expect(parseArguments(["-v"])).toEqual({ kind: "version" });
	});

	it("asks the running app what it is costing", () => {
		expect(parseArguments(["--metrics"])).toEqual({ kind: "metrics" });
		expect(
			requestFor(parseArguments(["--metrics"]), "/work/a", "/home/d"),
		).toEqual({ kind: "metrics" });
	});

	it("will not take a reading and do something else in the same run", () => {
		expect(parseArguments(["--metrics", "--version"])).toEqual({
			kind: "invalid",
			message: "devhub does one of these things at a time.",
		});
	});

	it("does one thing at a time", () => {
		expect(
			parseArguments(["--list-extensions", "--install-extension", "a.b"]),
		).toEqual({
			kind: "invalid",
			message: "devhub does one of these things at a time.",
		});
		expect(parseArguments(["--version", "/work"]).kind).toBe("invalid");
		expect(parseArguments(["--goto", "a.ts:2", "b.ts"]).kind).toBe("invalid");
	});

	it("sends an absolute path and the directory it was typed in", () => {
		expect(
			requestFor(parseArguments(["notes.md"]), "/work/a", "/home/d"),
		).toEqual({ kind: "open", path: "/work/a/notes.md", cwd: "/work/a" });
		expect(
			requestFor(parseArguments(["~/notes.md"]), "/work/a", "/home/d"),
		).toEqual({ kind: "open", path: "/home/d/notes.md", cwd: "/work/a" });
		expect(
			requestFor(parseArguments(["-g", "notes.md:9:2"]), "/work/a", "/home/d"),
		).toEqual({
			kind: "open",
			path: "/work/a/notes.md",
			cwd: "/work/a",
			position: { line: 9, column: 2 },
		});
	});

	it("sends the current directory with an agent request, because that is what picks the workspace", () => {
		expect(
			requestFor(
				parseArguments(["--agent", "codex", "--", "-m", "gpt"]),
				"/work/a/sub",
				"/home/d",
			),
		).toEqual({
			kind: "add-agent",
			profileId: "codex",
			args: ["-m", "gpt"],
			cwd: "/work/a/sub",
		});
	});

	/**
	 * A `.vsix` may be a relative path and an id may not, and only VS Code's own
	 * rule knows which a target is. So the targets go over as they were typed,
	 * with the directory they were typed in, and the app decides.
	 */
	it("sends extension targets untouched, with the directory to resolve them against", () => {
		expect(
			requestFor(
				parseArguments(["--install-extension", "a.b", "--force"]),
				"/work/a",
				"/home/d",
			),
		).toEqual({
			kind: "install-extensions",
			targets: ["a.b"],
			force: true,
			cwd: "/work/a",
		});
		expect(
			requestFor(
				parseArguments(["--uninstall-extension", "a.b"]),
				"/work/a",
				"/home/d",
			),
		).toEqual({ kind: "uninstall-extensions", ids: ["a.b"], force: false });
		expect(
			requestFor(parseArguments(["--version"]), "/work/a", "/home/d"),
		).toEqual({ kind: "version" });
	});

	it("has nothing to send when there is nothing to do", () => {
		expect(
			requestFor(parseArguments(["--force"]), "/work", "/home/d"),
		).toBeUndefined();
		expect(
			requestFor(parseArguments(["--help"]), "/work", "/home/d"),
		).toBeUndefined();
	});
});

/**
 * The cold start, end to end and with nothing faked but DevHub itself.
 *
 * `main` is given a socket path with nothing on it and a launch command that
 * puts a one-request server there after a moment, which is the shape of every
 * real cold start: connect, fail, launch, wait, ask. What is checked is that
 * the request which finally arrives is the request that was typed — including
 * the bytes that were piped in, which were read before anything was launched.
 */
describe("devhub when DevHub is not running", () => {
	let scratch: string;
	let previousStdin: PropertyDescriptor | undefined;

	beforeEach(() => {
		scratch = makeScratchDir("cli-cold");
		previousStdin = Object.getOwnPropertyDescriptor(process, "stdin");
	});

	afterEach(() => {
		if (previousStdin !== undefined) {
			Object.defineProperty(process, "stdin", previousStdin);
		}
		removeScratchDir(scratch);
	});

	/** A DevHub that appears `delayMs` after it is started, answers once, and goes. */
	/**
	 * A DevHub that comes up late and then speaks the protocol.
	 *
	 * It answers a `ping` like the real server does — from the socket loop,
	 * saying nothing about itself — because that is how the CLI asks whether it
	 * is there at all. A fake that treated the liveness question as the one
	 * request it was waiting for would be a fake of a different protocol.
	 */
	function fakeDevHub(socketPath: string, recordPath: string): string {
		return `
const { createServer } = require("node:net");
const { writeFileSync } = require("node:fs");
setTimeout(() => {
	const server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\\n")) return;
			const line = buffer.split("\\n")[0];
			if (JSON.parse(line).kind === "ping") {
				socket.end(JSON.stringify({ ok: true, message: "DevHub is running." }) + "\\n");
				return;
			}
			writeFileSync(${JSON.stringify(recordPath)}, line);
			socket.end(JSON.stringify({ ok: true, message: "opened" }) + "\\n");
			server.close();
		});
	});
	server.listen(${JSON.stringify(socketPath)});
}, 300);
`;
	}

	it("starts DevHub, waits for it, and then opens what was piped in", async () => {
		const socketPath = join(scratch, "c.sock");
		const recordPath = join(scratch, "request.json");
		Object.defineProperty(process, "stdin", {
			configurable: true,
			value: Readable.from([Buffer.from("hello from the pipe")]),
		});
		process.env["DEVHUB_CONTROL_SOCKET"] = socketPath;
		process.env["DEVHUB_LAUNCH_COMMAND"] = JSON.stringify([
			process.execPath,
			"-e",
			fakeDevHub(socketPath, recordPath),
		]);
		try {
			expect(await main(["-"])).toBe(0);
		} finally {
			delete process.env["DEVHUB_CONTROL_SOCKET"];
			delete process.env["DEVHUB_LAUNCH_COMMAND"];
		}
		const request = JSON.parse(readFileSync(recordPath, "utf8")) as {
			kind: string;
			path: string;
		};
		expect(request.kind).toBe("open");
		// Read before the launch, so the pipe cannot be lost to a cold start.
		expect(readFileSync(request.path, "utf8")).toBe("hello from the pipe");
	});

	/** A launcher that cannot say how to start DevHub says so, and fails. */
	it("refuses a launcher that does not record how to start DevHub", async () => {
		process.env["DEVHUB_CONTROL_SOCKET"] = join(scratch, "c.sock");
		delete process.env["DEVHUB_LAUNCH_COMMAND"];
		try {
			expect(await main(["--version"])).toBe(1);
		} finally {
			delete process.env["DEVHUB_CONTROL_SOCKET"];
		}
	});
});
