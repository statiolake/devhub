/**
 * That the routed sites actually go through the runtime.
 *
 * The main assertion of this step is negative and lives everywhere else: every
 * existing suite still passes, because nothing about a local Workspace
 * changed. What that cannot show is the thing the step was for — that `git`,
 * the folder probes and the `HEAD` watcher now ask a `Runtime` rather than the
 * machine main happens to be on. A site that quietly kept its own `spawn` or
 * its own `stat` would pass every one of those suites and be exactly the bug
 * the seam exists to make impossible, so it is asserted here with a runtime
 * that is not this machine and could not be mistaken for it.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { TypedFailure } from "../../model/wire.js";
import { runGit } from "../shell/git.js";
import { HeadWatcher } from "../shell/headWatcher.js";
import {
	folderIsDirectory,
	readWorktreeFolder,
} from "../shell/worktreeFolder.js";
import { LOCAL_CADENCE } from "./local.js";
import {
	RuntimeFileError,
	type ExecRequest,
	type ExecResult,
	type FileKind,
	type Runtime,
	type TerminalLauncher,
	type TerminalLauncherSpec,
	type Watcher,
} from "./runtime.js";

/**
 * A runtime that answers nothing and remembers everything.
 *
 * It runs no process and touches no disk, so a site that has *not* been routed
 * cannot accidentally pass by doing the real thing on this machine.
 */
class RecordingRuntime implements Runtime {
	readonly id = "local" as const;
	readonly where = " on the fake";
	readonly cadence = LOCAL_CADENCE;
	readonly execs: ExecRequest[] = [];
	readonly stats: string[] = [];
	readonly reads: string[] = [];
	readonly watched: string[] = [];
	readonly removed: string[] = [];
	answer: ExecResult = {
		code: 0,
		signal: null,
		stdout: Buffer.from(""),
		stderr: Buffer.from(""),
	};
	kinds: Record<string, FileKind> = {};
	contents: Record<string, string> = {};

	home(): Promise<string> {
		return Promise.resolve("/home/fake");
	}
	terminalLauncher(spec: TerminalLauncherSpec): Promise<TerminalLauncher> {
		return Promise.resolve({
			path: spec.localLauncherPath,
			unreachable: undefined,
		});
	}
	resolveProgram(configured: string) {
		return Promise.resolve({
			kind: "command_name" as const,
			value: configured,
		});
	}
	exec(request: ExecRequest): Promise<ExecResult> {
		this.execs.push(request);
		return Promise.resolve(this.answer);
	}
	spawnPty(): never {
		throw new Error("not asked for in these cases");
	}
	stat(path: string): Promise<FileKind> {
		this.stats.push(path);
		return Promise.resolve(this.kinds[path] ?? "absent");
	}
	readTextFile(path: string): Promise<string> {
		this.reads.push(path);
		const text = this.contents[path];
		if (text === undefined) {
			return Promise.reject(new RuntimeFileError(path, "ENOENT"));
		}
		return Promise.resolve(text);
	}
	writeTextFile(): Promise<void> {
		return Promise.resolve();
	}
	writeNewTextFile(): Promise<boolean> {
		return Promise.resolve(true);
	}
	scratchDirectory(): Promise<string> {
		return Promise.resolve("/home/fake/.devhub/tmp");
	}
	readdir(): Promise<readonly never[]> {
		return Promise.resolve([]);
	}
	removeTree(path: string): Promise<void> {
		this.removed.push(path);
		return Promise.resolve();
	}
	makeDirectory(): Promise<void> {
		return Promise.resolve();
	}
	realpath(path: string): Promise<string> {
		return Promise.resolve(path);
	}
	watchGitDirectory(worktree: string): Promise<Watcher> {
		this.watched.push(worktree);
		return Promise.resolve({ close: () => {} });
	}
	reading() {
		return {
			id: this.id,
			connected: true,
			masterPid: undefined,
			medianRoundTripMs: 0,
			reconcileIntervalMs: this.cadence.reconcileIntervalMs,
			execsLastMinute: this.execs.length,
			lastFailure: undefined,
		};
	}
}

describe("git", () => {
	it("runs on the machine its command names, as an argv", async () => {
		const runtime = new RecordingRuntime();
		runtime.answer = { ...runtime.answer, stdout: Buffer.from("main\n") };
		const branch = await runGit(
			{ runtime, git: "/opt/git", environment: { PATH: "/nowhere" } },
			["rev-parse", "--abbrev-ref", "it's HEAD"],
			{ cwd: "/srv/app" },
		);
		expect(branch).toBe("main\n");
		expect(runtime.execs).toHaveLength(1);
		expect(runtime.execs[0]?.argv).toEqual([
			"/opt/git",
			"rev-parse",
			"--abbrev-ref",
			// One argument, not three, and nothing quoted into it: the quoting
			// belongs to whichever runtime needs it, not to the caller.
			"it's HEAD",
		]);
		expect(runtime.execs[0]?.cwd).toBe("/srv/app");
		expect(runtime.execs[0]?.env).toEqual({ PATH: "/nowhere" });
	});

	it("still says what git said when git refused", async () => {
		const runtime = new RecordingRuntime();
		runtime.answer = {
			code: 128,
			signal: null,
			stdout: Buffer.from(""),
			stderr: Buffer.from("warning: nothing\nfatal: Repository not found\n"),
		};
		await expect(
			runGit({ runtime, git: "git", environment: {} }, ["fetch"]),
		).rejects.toMatchObject({
			wire: { summary: "fatal: Repository not found" },
		});
	});
});

describe("the folder probes", () => {
	it("ask the runtime, and read the marker through it", async () => {
		const runtime = new RecordingRuntime();
		runtime.kinds["/srv/app/.git"] = "file";
		runtime.contents["/srv/app/.git"] =
			"gitdir: /srv/repo/.git/worktrees/feature\n";
		expect(await readWorktreeFolder(runtime, "/srv/app")).toEqual({
			root: "/srv/app",
			mainWorktree: "/srv/repo",
			gitdir: "/srv/repo/.git/worktrees/feature",
		});
		expect(runtime.stats).toEqual(["/srv/app/.git"]);
		expect(runtime.reads).toEqual(["/srv/app/.git"]);
	});

	it("keep not-there and could-not-look apart across the seam", async () => {
		const runtime = new RecordingRuntime();
		// Nothing there: an answer.
		expect(await folderIsDirectory(runtime, "/srv/gone")).toBe(false);
		// Could not look: a failure, with the errno in it, because a close that
		// read this as "already gone" would delete a worktree that is still
		// sitting there with work in it.
		const refusing = new RecordingRuntime();
		refusing.stat = () => Promise.reject(new RuntimeFileError("/srv/x", "EIO"));
		await expect(folderIsDirectory(refusing, "/srv/x")).rejects.toBeInstanceOf(
			TypedFailure,
		);
		await expect(folderIsDirectory(refusing, "/srv/x")).rejects.toMatchObject({
			wire: { summary: "/srv/x could not be read (EIO)." },
		});
	});
});

describe("the head watcher", () => {
	it("arms through the runtime each checkout names", async () => {
		const first = new RecordingRuntime();
		const second = new RecordingRuntime();
		const watcher = new HeadWatcher(() => {});
		await watcher.arm([
			{ key: "w-1", worktree: "/srv/one", runtime: first },
			{ key: "w-2", worktree: "/srv/two", runtime: second },
		]);
		expect(first.watched).toEqual(["/srv/one"]);
		expect(second.watched).toEqual(["/srv/two"]);
		expect(watcher.armedCount).toBe(2);
		watcher.stop();
	});

	it("reports a checkout whose runtime cannot watch it", async () => {
		const runtime = new RecordingRuntime();
		runtime.watchGitDirectory = () =>
			Promise.reject(new Error("/srv/one/.git does not exist"));
		const watcher = new HeadWatcher(() => {});
		await watcher.arm([{ key: "w-1", worktree: "/srv/one", runtime }]);
		expect(watcher.armedCount).toBe(0);
		expect(watcher.failures()).toEqual([
			{
				key: "w-1",
				worktree: "/srv/one",
				reason: "/srv/one/.git does not exist",
			},
		]);
		watcher.stop();
	});
});
