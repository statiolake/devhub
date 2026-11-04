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
	systemProcessDeps,
	windowUtilitiesOf,
	type ProcessDeps,
} from "./workbenchProcesses.js";

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
