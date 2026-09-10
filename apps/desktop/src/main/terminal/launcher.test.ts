import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	installTerminalLauncher,
	terminalLauncherPath,
	terminalLauncherScript,
	terminalRoot,
	enclosingRoot,
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

	describe("the directory it was started in", () => {
		it("is the cwd VS Code gave the terminal", () => {
			expect(terminalRoot("/work/project")).toBe("/work/project");
		});

		it("is Scratch when there is no cwd to speak of", () => {
			expect(terminalRoot(undefined)).toBeNull();
		});

		it("is Scratch rather than a guess when the path is relative", () => {
			expect(terminalRoot("project")).toBeNull();
		});
	});

	// One rule for every window: the Workspace that contains the directory, or
	// Scratch when none does.
	describe("the workspace a directory belongs to", () => {
		const roots = ["/work/app", "/work/app/packages/ui", "/work/app-old"];

		it("is the workspace rooted exactly there", () => {
			expect(enclosingRoot(roots, "/work/app")).toBe("/work/app");
		});

		it("is the workspace a subdirectory is inside", () => {
			expect(enclosingRoot(roots, "/work/app/src/main")).toBe("/work/app");
		});

		it("is the innermost workspace when they nest", () => {
			expect(enclosingRoot(roots, "/work/app/packages/ui/src")).toBe(
				"/work/app/packages/ui",
			);
		});

		// A root of /work/app does not contain /work/app-old: the match is on
		// whole path segments, never on the string.
		it("does not take a sibling whose name merely starts the same", () => {
			expect(enclosingRoot(roots, "/work/app-old/src")).toBe("/work/app-old");
		});

		it("is Scratch when no workspace contains the directory", () => {
			expect(enclosingRoot(roots, "/home/testuser")).toBeNull();
		});

		it("is Scratch when there is no directory at all", () => {
			expect(enclosingRoot(roots, null)).toBeNull();
		});
	});
});
