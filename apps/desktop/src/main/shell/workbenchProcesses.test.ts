/**
 * Freezing real processes: a stand-in "workbench" (a renderer pid with a
 * child under it, and a listening server) is stopped and continued with real
 * signals, and a connection to its frozen listening socket is seen in the
 * kernel's listen queue — macOS's netstat + lsof on CI, /proc on Linux.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	PS_ARGUMENTS,
	parseProcessTable,
} from "../diagnostics/processTable.js";
import {
	SocketTrafficSampler,
	WorkbenchFreezer,
	foreignPids,
	sharedRendererFolders,
	systemProcessDeps,
	windowUtilitiesOf,
	type ProcessDeps,
} from "./workbenchProcesses.js";
import type { ProcessRow } from "../diagnostics/processTable.js";

const run = promisify(execFile);

// DevHub's "Electron processes" here: only this test runner.
const deps: ProcessDeps = systemProcessDeps(() => [process.pid]);

async function stateOf(pid: number): Promise<string> {
	return (await run("ps", ["-o", "stat=", "-p", String(pid)])).stdout.trim();
}

async function until(check: () => Promise<boolean>, ms = 5_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out");
}

const children: ChildProcess[] = [];
const sockets: Socket[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const child of children.splice(0)) {
		try {
			process.kill(child.pid!, "SIGCONT");
		} catch {
			// gone
		}
		child.kill("SIGKILL");
	}
});

/** A "renderer" (sh) with a child under it (sleep). */
async function tree(): Promise<{ parent: number; child: number }> {
	const sh = spawn("sh", ["-c", "sleep 60 & wait"], { stdio: "ignore" });
	children.push(sh);
	let child: number | undefined;
	await until(async () => {
		const rows = parseProcessTable((await run("ps", [...PS_ARGUMENTS])).stdout);
		child = rows.find((row) => row.ppid === sh.pid)?.pid;
		return child !== undefined;
	});
	return { parent: sh.pid!, child: child! };
}

/** A process listening on a loopback port that never gets to accept while stopped. */
async function server(): Promise<{ pid: number; port: number }> {
	const node = spawn(
		process.execPath,
		[
			"-e",
			"const s=require('net').createServer(c=>c.end());s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
		],
		{
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		},
	);
	children.push(node);
	const port = await new Promise<number>((resolve) => {
		node.stdout!.once("data", (data: Buffer) => resolve(Number(String(data))));
	});
	return { pid: node.pid!, port };
}

describe("freezing real processes", () => {
	it("stops the renderer and its tree, and continues them", async () => {
		const { parent, child } = await tree();
		const freezer = new WorkbenchFreezer(deps);
		await freezer.freeze("a", { renderer: parent, windowUtilities: [] });
		expect(freezer.pidsOf("a")).toEqual([parent, child]);
		// A signal is delivered when its process is next scheduled.
		await until(async () => /T/u.test(await stateOf(parent)));
		await until(async () => /T/u.test(await stateOf(child)));
		freezer.thaw("a");
		expect(freezer.isFrozen("a")).toBe(false);
		await until(async () => !/T/u.test(await stateOf(child)));
		expect(await stateOf(parent)).not.toMatch(/T/u);
	});

	it("a thaw during the freeze leaves the tree running", async () => {
		const { parent, child } = await tree();
		const freezer = new WorkbenchFreezer(deps);
		const freezing = freezer.freeze("a", {
			renderer: parent,
			windowUtilities: [],
		});
		freezer.thaw("a");
		await freezing;
		expect(await stateOf(child)).not.toMatch(/T/u);
		expect(await stateOf(parent)).not.toMatch(/T/u);
	});

	it("refuses a workbench with nothing to stop", () => {
		const freezer = new WorkbenchFreezer(deps);
		expect(() =>
			freezer.freeze("a", { renderer: undefined, windowUtilities: [] }),
		).toThrow();
		expect(freezer.isFrozen("a")).toBe(false);
	});

	it("never signals a process group: a pid of 0 is nothing to stop", () => {
		// `getOSProcessId()` is 0 for contents with no process, and
		// `kill(0, "SIGSTOP")` would stop DevHub's whole process group.
		const signalled: number[] = [];
		const freezer = new WorkbenchFreezer({
			...deps,
			kill: (pid) => {
				signalled.push(pid);
			},
		});
		expect(() =>
			freezer.freeze("a", { renderer: 0, windowUtilities: [] }),
		).toThrow();
		expect(signalled).toEqual([]);
		expect(freezer.isFrozen("a")).toBe(false);
	});

	it("sees a connection waiting on a frozen listening socket", async () => {
		const { pid, port } = await server();
		const freezer = new WorkbenchFreezer(deps);
		await freezer.freeze("a", { renderer: pid, windowUtilities: [] });
		expect(await freezer.waiting()).toEqual([]);
		const socket = connect(port, "127.0.0.1");
		sockets.push(socket);
		await until(async () => (await freezer.waiting()).includes("a"));
		freezer.thaw("a");
		// Accepted once it runs: nothing waits any more.
		await new Promise<void>((resolve) => socket.once("close", resolve));
	}, 15_000);
});

/** A freezer over a fixed process table, recording every signal. */
function fakeFreezer(rows: readonly ProcessRow[], electron: readonly number[]) {
	const signals: string[] = [];
	const freezer = new WorkbenchFreezer({
		...deps,
		processes: () => Promise.resolve(rows),
		electronPids: () => electron,
		fdLinks: () => Promise.resolve([]),
		kill: (pid, signal) => {
			signals.push(`${signal} ${String(pid)}`);
		},
		log: () => {},
	});
	return { freezer, signals };
}

const row = (pid: number, ppid: number): ProcessRow => ({
	pid,
	ppid,
	rssKb: 1,
	cpuPercent: 0,
	comm: `p${String(pid)}`,
	args: `p${String(pid)}`,
});

describe("what a freeze never stops", () => {
	// 100 main, 101 GPU, 110 the Sidebar's renderer, 120 the workbench's
	// renderer, 121 its extension host with 122 under it.
	const rows = [
		row(100, 1),
		row(101, 100),
		row(110, 100),
		row(120, 100),
		row(121, 100),
		row(122, 121),
	];
	const electron = [100, 101, 110, 120, 121];

	it("is main, its parent, the GPU process, or a process hosting other contents", () => {
		expect(
			foreignPids({
				main: 100,
				parent: 1,
				electron: [
					{ pid: 100, type: "Browser" },
					{ pid: 101, type: "GPU" },
					{ pid: 110, type: "Tab" },
					{ pid: 120, type: "Tab" },
					{ pid: 121, type: "Utility" },
				],
				otherContents: [110, 0],
			}).sort((a, b) => a - b),
		).toEqual([1, 100, 101, 110]);
	});

	it("refuses a workbench whose renderer also hosts one of DevHub's pages, stopping nothing", () => {
		const { freezer, signals } = fakeFreezer(rows, electron);
		expect(() =>
			freezer.freeze("a", {
				renderer: 120,
				windowUtilities: [121],
				foreign: [100, 101, 120],
			}),
		).toThrow(/shared/u);
		expect(signals).toEqual([]);
		expect(freezer.isFrozen("a")).toBe(false);
	});

	it("leaves out a foreign process named as one of its utilities", async () => {
		const { freezer, signals } = fakeFreezer(rows, electron);
		await freezer.freeze("a", {
			renderer: 120,
			windowUtilities: [121, 101],
			foreign: [100, 101, 110],
		});
		expect(signals).toEqual(["SIGSTOP 120", "SIGSTOP 121", "SIGSTOP 122"]);
	});

	it("a second freeze of a frozen one continues what the first stopped", async () => {
		const { freezer, signals } = fakeFreezer(rows, electron);
		await freezer.freeze("a", { renderer: 120, windowUtilities: [121] });
		signals.length = 0;
		await freezer.freeze("a", { renderer: 120, windowUtilities: [] });
		expect(signals.slice(0, 3)).toEqual([
			"SIGCONT 122",
			"SIGCONT 121",
			"SIGCONT 120",
		]);
		freezer.thaw("a");
		expect(freezer.pidsOf("a")).toEqual([]);
	});
});

describe("shared renderers", () => {
	it("are the workbenches whose process also hosts another workbench or a page", () => {
		expect(
			sharedRendererFolders([
				{ pid: 110 }, // the Sidebar
				{ pid: 110, folder: "/a" }, // shares with the Sidebar
				{ pid: 130, folder: "/b" },
				{ pid: 130, folder: "/c" }, // two workbenches in one
				{ pid: 140, folder: "/d" }, // alone
				{ pid: 0, folder: "/e" }, // no process up yet
				{ pid: 0 },
				{ pid: 110 },
			]).sort(),
		).toEqual(["/a", "/b", "/c"]);
	});
});

describe("window utilities", () => {
	it("are the utility processes named for that window", () => {
		expect(
			windowUtilitiesOf(
				[
					{ pid: 1, name: "extension-host [3]" },
					{ pid: 2, name: "file-watcher [3]" },
					{ pid: 3, name: "extension-host [13]" },
					{ pid: 4, name: "pty-host" },
					{ pid: 5, name: "shared-process" },
				],
				3,
			),
		).toEqual([1, 2]);
	});
});

describe("socket traffic", () => {
	it("is nothing to say for no workbench", async () => {
		expect(await new SocketTrafficSampler(deps).sample([])).toEqual([]);
	});
});
