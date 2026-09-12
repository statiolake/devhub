import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	installTerminalLauncher,
	readTerminalEntryBundle,
	remoteTerminalPaths,
	terminalEntryBundlePath,
	terminalLauncherPath,
	terminalCommandLine,
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
			machine: "local",
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
		expect(script).toContain("DEVHUB_TERMINAL_MACHINE='local'");
		expect(script).toContain("ELECTRON_RUN_AS_NODE=1");
		expect(script).toContain(
			`'${request.execPath}' '${request.entryScript}' "$@")`,
		);
	});

	// The one property the whole launcher exists to have: what VS Code's pty
	// holds is tmux, so hanging up the pty hangs up the client. Asking DevHub
	// is a command substitution — a child that has exited by then — and the
	// answer is `exec`ed, never run.
	it("becomes the command DevHub answers with rather than running it", () => {
		const script = terminalLauncherScript(request);
		expect(script).toContain('eval "exec $devhub_argv"');
		expect(script).toMatch(/devhub_argv=\$\(/);
	});

	// A shell that execs nothing does not exit; it reads its input, which on a
	// pty is a bare shell wearing the terminal's name.
	it("refuses to exec nothing when the answer is empty", () => {
		expect(terminalLauncherScript(request)).toContain('if [ -z "$devhub_argv"');
	});

	it("quotes the argv it hands the shell, one word per argument", () => {
		expect(
			terminalCommandLine({
				file: "/opt/tmux",
				args: ["-L", "devhub", "attach-session", "-t", "ws with space"],
			}),
		).toBe("'/opt/tmux' '-L' 'devhub' 'attach-session' '-t' 'ws with space'");
	});

	// Not a reading of the script but a run of it: the process that ends up
	// running the answer is the launcher's own, which is what "the pty holds
	// tmux" means when VS Code is the one holding the pty.
	it("leaves no process of its own between the caller and the answer", () => {
		const fakeApp = join(scratch, "DevHub");
		// Stands in for Electron-as-Node: it prints one shell-quoted argv, and
		// that argv reports the pid of the process it ends up running as.
		writeFileSync(
			fakeApp,
			"#!/bin/sh\necho \"'/bin/sh' '-c' 'echo \\$\\$'\"\n",
			{
				mode: 0o755,
			},
		);
		const path = installTerminalLauncher(
			terminalLauncherPath(join(scratch, "user-data")),
			{ ...request, execPath: fakeApp },
		);
		const output = execFileSync(
			"/bin/sh",
			["-c", 'echo "$$"; exec "$1"', "sh", path],
			{ encoding: "utf8" },
		)
			.trim()
			.split("\n");
		expect(output).toHaveLength(2);
		expect(output[1]).toBe(output[0]);
	});

	it("stops with what DevHub said when DevHub answers with nothing", () => {
		const fakeApp = join(scratch, "DevHub");
		writeFileSync(fakeApp, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const path = installTerminalLauncher(
			terminalLauncherPath(join(scratch, "user-data")),
			{ ...request, execPath: fakeApp },
		);
		const result = spawnSync(path, { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("without a command line");
	});

	// The machine is baked in for the same reason the socket is: a launcher on
	// another machine is another launcher, and a directory without a machine
	// names a different folder on each of them.
	it("names the machine it was written for", () => {
		expect(
			terminalLauncherScript({
				...request,
				machine: "ssh:build-box.example.com",
			}),
		).toContain("DEVHUB_TERMINAL_MACHINE='ssh:build-box.example.com'");
	});

	// The likeliest failure on a machine DevHub had to install itself onto: the
	// launcher can be written before the server whose Node runs it is there.
	it("says which binary is missing rather than letting /bin/sh say it", () => {
		const path = installTerminalLauncher(
			terminalLauncherPath(join(scratch, "user-data")),
			{ ...request, execPath: join(scratch, "no-such-node") },
		);
		const result = spawnSync(path, { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(join(scratch, "no-such-node"));
		expect(result.stderr).toContain("no terminal session to attach to");
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

	// A machine that has no DevHub on it needs the asking program itself. It
	// used to be shipped as a closure — the compiled entry plus every compiled
	// file it imported, discovered by reading the `.js` as text. That walker
	// could not tell an `import` from the word in a doc comment, and
	// `launcher.js`'s own comment about import specifiers made the packaged app
	// refuse to ship the program at all: every window opened with no terminal
	// launcher, here and on every host. One bundled file has no graph to walk.
	describe("the one file the asking program is", () => {
		// APP_ROOT as `appController.ts` computes it: src/main/terminal -> the
		// package. The bundle is a build output, so this is the built one.
		const appRoot = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"..",
		);

		it("is produced by the build, beside the compiled main process", () => {
			expect(statSync(terminalEntryBundlePath(appRoot)).isFile()).toBe(true);
		});

		it("imports no file, so there is nothing else to ship", () => {
			const text = readTerminalEntryBundle(appRoot);
			// Everything the program needs is inside it; `node:` is on every
			// machine that has a Node at all.
			for (const match of text.matchAll(
				/^\s*(?:import|export)\s[^\n]*?from\s*["']([^"']+)["']/gmu,
			)) {
				expect(match[1]).toMatch(/^node:/u);
			}
			expect(text).not.toMatch(/\bfrom\s*["']\.{1,2}\//u);
		});

		// The one failure that is worth a sentence: a checkout where the build
		// step has not run has no terminals anywhere, and "…is not there" with
		// no cause named is a morning spent looking at ssh.
		it("says which build step makes it when it is not there", () => {
			expect(() => readTerminalEntryBundle(scratch)).toThrow(/build:terminal/u);
		});
	});

	describe("where all of it goes on another machine", () => {
		const paths = {
			home: "/home/dev",
			serverDataFolderName: ".devhub-server",
			serverCommit: "abc123",
			controlSocketPath: "/data/devhub/devhub/control.sock",
			entryName: "devhub-terminal.bundle.js",
		};

		it("runs on the Node the connection already installed there", () => {
			expect(remoteTerminalPaths(paths).node).toBe(
				"/home/dev/.devhub-server/bin/abc123/node",
			);
		});

		it("keeps DevHub's files in one directory of its own", () => {
			const remote = remoteTerminalPaths(paths);
			expect(remote.directory).toBe("/home/dev/.devhub/terminal");
			expect(remote.launcher.startsWith(`${remote.directory}/`)).toBe(true);
			expect(remote.entry).toBe(
				"/home/dev/.devhub/terminal/js/devhub-terminal.bundle.js",
			);
		});

		// Two DevHub profiles on one Mac reaching one host must not adopt each
		// other's socket, and the socket path is the one thing that tells them
		// apart before anything has been written.
		it("gives each DevHub its own socket and launcher on the host", () => {
			const other = remoteTerminalPaths({
				...paths,
				controlSocketPath: "/data/devhub-second/devhub/control.sock",
			});
			expect(other.socket).not.toBe(remoteTerminalPaths(paths).socket);
			expect(other.launcher).not.toBe(remoteTerminalPaths(paths).launcher);
		});
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
