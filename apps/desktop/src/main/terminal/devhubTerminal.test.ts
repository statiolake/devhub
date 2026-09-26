import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { resolveTerminalCommand, workspaceArgument } from "./devhubTerminal.js";
import { terminalCommandLine } from "./launcher.js";

/** A DevHub that answers one `terminal-profile` request, however it likes. */
function answering(
	socketPath: string,
	reply: (root: unknown, machine: unknown, workspace: unknown) => unknown,
): Promise<Server> {
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		socket.once("data", (line: string) => {
			const request = JSON.parse(line.split("\n")[0] ?? "") as {
				root: unknown;
				machine: unknown;
				workspace: unknown;
			};
			socket.end(
				`${JSON.stringify(reply(request.root, request.machine, request.workspace))}\n`,
			);
		});
	});
	return new Promise((resolve) => {
		server.listen(socketPath, () => resolve(server));
	});
}

describe("what a DevHub terminal runs", () => {
	let scratch: string;
	let socketPath: string;
	let server: Server | undefined;

	beforeEach(() => {
		scratch = makeScratchDir("devhub-terminal");
		socketPath = join(scratch, "control.sock");
	});

	afterEach(() => {
		server?.close();
		server = undefined;
		removeScratchDir(scratch);
	});

	it("runs the argv DevHub answers with, for the directory it is in", async () => {
		let asked: unknown;
		server = await answering(socketPath, (root) => {
			asked = root;
			return {
				ok: true,
				message: "tmux attach",
				profile: { file: "/opt/tmux", args: ["-L", "devhub", "attach"] },
			};
		});
		const command = await resolveTerminalCommand(
			socketPath,
			"local",
			"/work/project",
		);
		expect(asked).toBe("/work/project");
		expect(command).toEqual({
			file: "/opt/tmux",
			args: ["-L", "devhub", "attach"],
		});
	});

	it("names the Workspace when the window did, whatever directory it is in", async () => {
		// A window attached to a dev container runs this launcher on this Mac,
		// and the directory it starts in cannot say which Workspace it is for.
		let asked: unknown;
		server = await answering(socketPath, (_root, _machine, workspace) => {
			asked = workspace;
			return {
				ok: true,
				message: "tmux attach",
				profile: { file: "/opt/tmux", args: [] },
			};
		});
		await resolveTerminalCommand(socketPath, "local", "/Users/x", "/src/api");
		expect(asked).toBe("/src/api");
	});

	it("asks for the Scratch session when there is no directory to name", async () => {
		let asked: unknown = "unset";
		server = await answering(socketPath, (root) => {
			asked = root;
			return {
				ok: true,
				message: "tmux attach",
				profile: { file: "/opt/tmux", args: [] },
			};
		});
		await resolveTerminalCommand(socketPath, "local", undefined);
		expect(asked).toBeNull();
	});

	// The whole point of the launcher: no shell is ever started as a
	// consolation prize, because a shell outside tmux looks like it worked.
	it("refuses rather than falling back when DevHub says no", async () => {
		server = await answering(socketPath, () => ({
			ok: false,
			message: "That workspace is not open in DevHub.",
		}));
		await expect(
			resolveTerminalCommand(socketPath, "local", "/work/gone"),
		).rejects.toThrow("That workspace is not open in DevHub.");
	});

	// stdout is the launcher's command substitution: what it prints is what
	// gets `exec`ed, so it has to be shell words and nothing else.
	it("prints the argv as shell words for the launcher to exec", async () => {
		server = await answering(socketPath, () => ({
			ok: true,
			message: "tmux attach",
			profile: {
				file: "/opt/tmux",
				args: ["-L", "devhub", "attach-session", "-t", "ws one"],
			},
		}));
		const command = await resolveTerminalCommand(
			socketPath,
			"local",
			"/work/project",
		);
		expect(terminalCommandLine(command)).toBe(
			"'/opt/tmux' '-L' 'devhub' 'attach-session' '-t' 'ws one'",
		);
	});

	it("says which socket did not answer when DevHub is not running", async () => {
		await expect(
			resolveTerminalCommand(socketPath, "local", "/work/project"),
		).rejects.toThrow(socketPath);
	});

	// Two machines can spell one directory the same way, and only the launcher
	// knows which of them it is on. Without it the answer would be a session on
	// whichever machine happened to have a Workspace at that path.
	it("says which machine the directory is on", async () => {
		let asked: unknown;
		server = await answering(socketPath, (_root, machine) => {
			asked = machine;
			return {
				ok: true,
				message: "tmux attach",
				profile: { file: "/opt/tmux", args: [] },
			};
		});
		await resolveTerminalCommand(
			socketPath,
			"ssh:build-box.example.com",
			"/srv/app",
		);
		expect(asked).toBe("ssh:build-box.example.com");
	});

	it("says so when the launcher did not say which machine it is on", async () => {
		await expect(
			resolveTerminalCommand(socketPath, undefined, "/srv/app"),
		).rejects.toThrow("DEVHUB_TERMINAL_MACHINE");
	});

	it("says so when the launcher did not carry a socket at all", async () => {
		await expect(
			resolveTerminalCommand(undefined, "local", "/work/project"),
		).rejects.toThrow("DEVHUB_CONTROL_SOCKET");
	});
});

describe("the launcher's own arguments", () => {
	it("are nothing, or --workspace and a key", () => {
		expect(workspaceArgument([])).toBeUndefined();
		expect(workspaceArgument(["--workspace", "ssh://build/srv/api"])).toBe(
			"ssh://build/srv/api",
		);
	});

	it("refuse anything else rather than ignore it", () => {
		expect(() => workspaceArgument(["--workspace"])).toThrow(/--workspace/u);
		expect(() => workspaceArgument(["-l"])).toThrow(/--workspace/u);
		expect(() =>
			workspaceArgument(["--workspace", "/a", "--workspace", "/b"]),
		).toThrow(/one --workspace/u);
	});
});
