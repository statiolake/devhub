import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	installTerminalLauncher,
	terminalLauncherPath,
	terminalLauncherScript,
	terminalRoot,
} from "./launcher.js";

describe("the DevHub terminal launcher", () => {
	let scratch: string;
	let request: Parameters<typeof installTerminalLauncher>[1];

	beforeEach(() => {
		scratch = makeScratchDir("terminal-launcher");
		request = {
			execPath: join(scratch, "DevHub"),
			entryScript: join(
				scratch,
				"out",
				"main",
				"terminal",
				"devhubTerminal.js",
			),
			socketPath: join(scratch, "user-data", "devhub", "control.sock"),
		};
	});

	afterEach(() => {
		removeScratchDir(scratch);
	});

	it("is written executable, next to the socket it talks to", () => {
		const path = installTerminalLauncher(
			terminalLauncherPath(join(scratch, "user-data")),
			request,
		);
		expect(path).toBe(join(scratch, "user-data", "devhub", "devhub-terminal"));
		expect(statSync(path).mode & 0o777).toBe(0o755);
	});

	it("carries the socket and runs the entry point as Node", () => {
		const script = terminalLauncherScript(request);
		expect(script).toContain(`DEVHUB_CONTROL_SOCKET='${request.socketPath}'`);
		expect(script).toContain("ELECTRON_RUN_AS_NODE=1");
		expect(script).toContain(
			`exec '${request.execPath}' '${request.entryScript}' "$@"`,
		);
	});

	it("is rewritten rather than appended to, so a moved app leaves no stale paths", () => {
		const path = terminalLauncherPath(join(scratch, "user-data"));
		installTerminalLauncher(path, request);
		installTerminalLauncher(path, {
			...request,
			execPath: "/elsewhere/DevHub",
		});
		const script = readFileSync(path, "utf8");
		expect(script).toContain("'/elsewhere/DevHub'");
		expect(script).not.toContain(request.execPath);
	});

	describe("the root it is given", () => {
		it("is the workspace folder when the window has one", () => {
			expect(terminalRoot("/work/project")).toBe("/work/project");
		});

		// VS Code leaves `${workspaceFolder}` unresolved in the folderless
		// window rather than failing; that window is DevHub's Scratch context.
		it("is Scratch when the profile's variable did not resolve", () => {
			expect(terminalRoot("${workspaceFolder}")).toBeNull();
		});

		it("is Scratch when nothing was passed at all", () => {
			expect(terminalRoot(undefined)).toBeNull();
		});

		it("is Scratch rather than a guess when the path is relative", () => {
			expect(terminalRoot("project")).toBeNull();
		});
	});
});
