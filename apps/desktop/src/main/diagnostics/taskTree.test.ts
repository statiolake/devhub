/**
 * Every process attributed to the thing a person thinks in, from one `ps`
 * snapshot of a Mac running DevHub — the fixture beside this file — and the
 * sums that make a Workspace's total.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TaskRowWire } from "../../ipc/taskManager.js";
import { parseProcessTable, parseProcessTables } from "./processTable.js";
import {
	buildTaskTree,
	taskSnapshotText,
	type TaskTreeInput,
	utilitiesByWindow,
	utilityLabel,
} from "./taskTree.js";

const processes = parseProcessTable(
	readFileSync(new URL("./fixtures/ps-darwin.txt", import.meta.url), "utf8"),
);

const input: TaskTreeInput = {
	takenAt: Date.UTC(2026, 10, 3, 12),
	processes,
	electron: [
		{ pid: 100, type: "Browser" },
		{ pid: 101, type: "GPU" },
		{ pid: 102, type: "Utility", name: "Network Service" },
		{ pid: 110, type: "Tab" },
		{ pid: 111, type: "Tab" },
		{ pid: 120, type: "Tab" },
		{ pid: 121, type: "Utility", name: "extension-host [7]" },
		{ pid: 130, type: "Utility", name: "pty-host" },
	],
	pages: [
		{ pid: 110, name: "Window page" },
		{ pid: 111, name: "Sidebar page" },
	],
	workspaces: [
		{
			id: "w1",
			label: "widget",
			detail: "~/src/widget",
			workbench: {
				state: "running",
				sleepable: true,
				renderers: [120],
				utilities: [{ pid: 121, label: "Extension host" }],
			},
			agents: [
				{
					id: "a1",
					label: "Fix the build",
					detail: "claude · terminal",
					terminalSession: "tm-t1",
				},
			],
		},
		{ id: "w2", label: "notes", agents: [] },
	],
	tmux: {
		serverPid: 200,
		panes: [
			{
				context: "workspace",
				workspaceId: "w1",
				agentId: undefined,
				sessionName: "ws-0123456789abcdef0123",
				paneId: "%1",
				pid: 201,
			},
			{
				context: "agent",
				workspaceId: "w1",
				agentId: "a1",
				sessionName: "ag-a1",
				paneId: "%2",
				pid: 210,
			},
			{
				context: "terminal",
				workspaceId: "w1",
				agentId: undefined,
				sessionName: "tm-t1",
				paneId: "%3",
				pid: 220,
			},
			{
				context: "global",
				workspaceId: "global",
				agentId: undefined,
				sessionName: "scratch",
				paneId: "%0",
				pid: 230,
			},
		],
		clients: [
			{ pid: 131, session: "ws-0123456789abcdef0123" },
			{ pid: 150, session: "ag-a1" },
		],
	},
};

const tree = buildTaskTree(input);

function find(rows: readonly TaskRowWire[], id: string): TaskRowWire {
	const walk = (level: readonly TaskRowWire[]): TaskRowWire | undefined => {
		for (const row of level) {
			if (row.id === id) return row;
			const found = walk(row.children);
			if (found) return found;
		}
		return undefined;
	};
	const found = walk(rows);
	if (!found) throw new Error(`no row ${id}`);
	return found;
}
/** The rows below, as `label[pid]` and their own children. */
function shape(row: TaskRowWire): unknown {
	const name =
		row.pid === undefined ? row.label : `${row.label}[${String(row.pid)}]`;
	return row.children.length === 0 ? name : { [name]: row.children.map(shape) };
}
const KIB = 1024;

describe("attributing processes", () => {
	it("groups a Workspace's workbench, terminal and Agents under it", () => {
		expect(shape(find(tree.rows, "workspace:w1"))).toEqual({
			widget: [
				{
					"VS Code": [
						"Renderer[120]",
						{
							"Extension host[121]": [
								{ "rust-analyzer[122]": ["rust-analyzer-proc-macro-srv[123]"] },
								"tsserver.js[124]",
							],
						},
						"Terminal tab[131]",
					],
				},
				{ Terminal: [{ "zsh[201]": ["nvim[202]"] }] },
				{
					"Fix the build": [
						{ "claude[210]": ["mcp[211]"] },
						"tmux client[150]",
						{ Terminal: ["zsh[220]"] },
					],
				},
			],
		});
	});

	it("says what a workbench is doing, and what it offers", () => {
		const workbench = find(tree.rows, "workbench:w1");
		expect(workbench.state).toBe("running");
		expect(workbench.actions).toEqual(["reveal"]);
		expect(find(tree.rows, "agent:a1").actions).toEqual(["stop", "reveal"]);
	});

	it("gives a Workspace with nothing running a row of its own, empty", () => {
		const notes = find(tree.rows, "workspace:w2");
		expect(notes.children).toEqual([]);
		expect(notes.memoryBytes).toBe(0);
	});

	it("keeps DevHub's own processes as DevHub, without what they started", () => {
		expect(shape(find(tree.rows, "devhub"))).toEqual({
			DevHub: [
				"Main[100]",
				"GPU[101]",
				"Network Service[102]",
				"Window page[110]",
				"Sidebar page[111]",
				"Terminal host (pty)[130]",
			],
		});
	});

	it("puts the server and its anchor session under tmux, and the rest under Other", () => {
		expect(shape(find(tree.rows, "tmux"))).toEqual({
			tmux: ["tmux server[200]", "zsh[230]"],
		});
		const other = find(tree.rows, "other");
		expect(shape(other)).toEqual({ Other: ["git[140]"] });
		expect(other.children[0]!.detail).toBe(
			"from Main · git status --porcelain=v2",
		);
	});

	it("leaves out what DevHub did not start", () => {
		expect(JSON.stringify(tree)).not.toContain("Safari");
		expect(JSON.stringify(tree)).not.toContain("launchd");
	});

	it("offers Kill on what a person started, and never on DevHub's core", () => {
		const killable = (pid: number) =>
			find(tree.rows, `pid:${String(pid)}`).actions.includes("kill");
		for (const pid of [122, 123, 124, 201, 202, 210, 140]) {
			expect(killable(pid), String(pid)).toBe(true);
		}
		for (const pid of [100, 101, 110, 120, 121, 130, 131, 150, 200]) {
			expect(killable(pid), String(pid)).toBe(false);
		}
	});
});

describe("adding it up", () => {
	it("sums a subtree's memory, CPU and processes", () => {
		const host = find(tree.rows, "pid:121");
		expect(host.memoryBytes).toBe((420000 + 1900000 + 60000 + 380000) * KIB);
		expect(host.cpuPercent).toBeCloseTo(6 + 48.5 + 0 + 3);
		expect(host.processCount).toBe(4);
	});

	it("makes a Workspace's total its workbench, terminal and Agents", () => {
		const workspace = find(tree.rows, "workspace:w1");
		const kib =
			650000 +
			420000 +
			1900000 +
			60000 +
			380000 +
			4000 + // workbench
			7000 +
			140000 + // terminal
			520000 +
			80000 +
			4000 +
			6000; // Agent
		expect(workspace.memoryBytes).toBe(kib * KIB);
		expect(workspace.processCount).toBe(12);
	});

	it("counts every process DevHub has exactly once", () => {
		const devhubPids = processes
			.filter((row) => ![1, 300].includes(row.pid))
			.map((row) => row.pid);
		expect(tree.total.processCount).toBe(devhubPids.length);
		expect(tree.total.memoryBytes).toBe(
			processes
				.filter((row) => devhubPids.includes(row.pid))
				.reduce((sum, row) => sum + row.rssKb * KIB, 0),
		);
	});
});

describe("the text snapshot", () => {
	it("is the header and every row, heaviest first, indented by depth", () => {
		const text = taskSnapshotText({
			...tree,
			system: {
				totalBytes: 16 * 1024 ** 3,
				usedBytes: 14 * 1024 ** 3,
				breakdown: {
					appBytes: 9 * 1024 ** 3,
					wiredBytes: 3 * 1024 ** 3,
					compressedBytes: 2 * 1024 ** 3,
					compressorStoredBytes: 6 * 1024 ** 3,
					cachedBytes: 1024 ** 3,
					freeBytes: 1024 ** 3,
				},
				swapUsedBytes: 3 * 1024 ** 3,
				swapTotalBytes: 4 * 1024 ** 3,
				pressure: "warning",
				pressureSource: "kern.memorystatus_vm_pressure_level",
			},
		});
		const lines = text.split("\n");
		expect(lines[1]).toBe(
			"System memory: 14.0 GB used of 16.0 GB · pressure warning (kern.memorystatus_vm_pressure_level) · swap 3.00 GB used of 4.00 GB",
		);
		expect(lines[2]).toBe(
			"  app 9.00 GB · wired 3.00 GB · compressed 2.00 GB (storing 6.00 GB) · cached files 1.00 GB · free 1.00 GB",
		);
		expect(text).toContain("Footprint     In RAM     CPU Procs  Name\n");
		expect(text).toContain("  widget ~/src/widget\n");
		expect(text).toContain("VS Code (running)");
		expect(text).toMatch(/ {6}rust-analyzer \[122\]\n/u);
		// Heaviest first: the Workspace with rust-analyzer before DevHub.
		expect(text.indexOf("widget")).toBeLessThan(text.indexOf("DevHub\n"));
	});
});

describe("a GUI Agent, a file watcher, and what is not DevHub's cost", () => {
	// The two-run fixture: 121 an extension host and 125 its window's file
	// watcher; 140 a GUI Agent's journal stream (with its tail, watchdog and
	// sleep) for the host 210 runs in the Agent's pane; 150 a zombie, 151 a
	// `(vm_stat)` already ending, 152 this reading's own `ps`.
	const twoRuns = parseProcessTables(
		readFileSync(
			new URL("./fixtures/ps-stat-darwin.txt", import.meta.url),
			"utf8",
		),
		readFileSync(
			new URL("./fixtures/ps-args-darwin.txt", import.meta.url),
			"utf8",
		),
	);
	const utilities = utilitiesByWindow([
		{ pid: 121, name: "extension-host [3]" },
		{ pid: 125, name: "file-watcher [3]" },
		{ pid: 126, name: "file-watcher [4]" },
		{ pid: 130, name: "pty-host" },
	]);
	const gui = buildTaskTree({
		takenAt: 0,
		processes: twoRuns,
		electron: [
			{ pid: 100, type: "Browser" },
			{ pid: 101, type: "GPU" },
			{ pid: 120, type: "Tab" },
			{ pid: 121, type: "Utility", name: "extension-host [3]" },
			{ pid: 125, type: "Utility", name: "file-watcher [3]" },
		],
		pages: [],
		workspaces: [
			{
				id: "w1",
				label: "widget",
				workbench: {
					state: "running",
					sleepable: false,
					renderers: [120],
					utilities: utilities.get(3) ?? [],
				},
				agents: [{ id: "a1", label: "Codex", detail: "codex · GUI" }],
			},
		],
		tmux: {
			serverPid: 200,
			panes: [
				{
					context: "agent",
					workspaceId: "w1",
					agentId: "a1",
					sessionName: "ag-a1",
					paneId: "%2",
					pid: 210,
				},
			],
			clients: [],
		},
		ignore: new Set([152]),
		memory: new Map([
			[
				121,
				{ footprintBytes: 900 * 1024 ** 2, residentBytes: 100 * 1024 ** 2 },
			],
			[122, { footprintBytes: 1200 * 1024 ** 2, residentBytes: 5 * 1024 ** 2 }],
		]),
		memoryMetric: "footprint",
	});

	it("finds each window's extension host and file watcher by window id", () => {
		expect(utilities.get(3)).toEqual([
			{ pid: 121, label: "Extension host" },
			{ pid: 125, label: "File watcher" },
		]);
		expect(utilities.get(4)).toEqual([{ pid: 126, label: "File watcher" }]);
	});

	it("puts the file watcher with its workbench", () => {
		expect(shape(find(gui.rows, "workbench:w1"))).toEqual({
			"VS Code": [
				"Renderer[120]",
				{ "Extension host[121]": ["rust-analyzer[122]", "prettier[124]"] },
				"File watcher[125]",
			],
		});
	});

	it("gives a GUI Agent the journal stream main follows it with", () => {
		const agent = find(gui.rows, "agent:a1");
		expect(shape(agent)).toEqual({
			Codex: [
				{
					"sh[210]": [
						"@modelcontextprotocol/server-github[211]",
						{
							"claude[212]": [
								"@playwright/mcp@latest[213]",
								"mcp-server-fetch[214]",
							],
						},
					],
				},
				{
					"Journal stream[140]": [
						"tail[141]",
						{ "sh[142]": ["cat[143]"] },
						"sleep[144]",
					],
				},
			],
		});
		expect(JSON.stringify(gui.rows)).not.toContain('"other"');
	});

	it("leaves out zombies, processes already ending, and its own ps", () => {
		const text = JSON.stringify(gui.rows);
		for (const pid of [150, 151, 152]) {
			expect(text).not.toContain(`"pid:${String(pid)}"`);
		}
	});

	it("counts the footprint where there is one, else the resident set", () => {
		expect(gui.memoryMetric).toBe("footprint");
		expect(find(gui.rows, "pid:122")).toMatchObject({
			memoryBytes: 1200 * 1024 ** 2,
			residentBytes: 5 * 1024 ** 2,
		});
		// No reading for 124: its resident set is both.
		expect(find(gui.rows, "pid:124")).toMatchObject({
			memoryBytes: 120000 * KIB,
			residentBytes: 120000 * KIB,
		});
		// Summed over the subtree, each figure on its own.
		expect(find(gui.rows, "pid:121")).toMatchObject({
			memoryBytes: (900 + 1200) * 1024 ** 2 + 120000 * KIB,
			residentBytes: (100 + 5) * 1024 ** 2 + 120000 * KIB,
		});
		expect(tree.memoryMetric).toBe("rss");
	});

	it("says a VS Code utility's name as words", () => {
		expect(utilityLabel("file-watcher [1000006]")).toBe("File watcher");
		expect(utilityLabel("shared-process")).toBe("Shared process");
		expect(utilityLabel("some-new-thing")).toBe("Some new thing");
		expect(utilityLabel("Network Service")).toBe("Network Service");
	});
});

describe("a journal stream no Agent here owns", () => {
	it("is DevHub's own work, not Other", () => {
		const stray = buildTaskTree({
			takenAt: 0,
			processes: parseProcessTables(
				"  100 1 1000 0.0 S /x/DevHub\n  140 100 2000 0.0 S /bin/sh\n",
				"  100 /x/DevHub\n  140 /bin/sh -c x devhub-agent-stream /h/gone 0\n",
			),
			electron: [{ pid: 100, type: "Browser" }],
			pages: [],
			workspaces: [],
			tmux: { serverPid: undefined, panes: [], clients: [] },
		});
		expect(shape(find(stray.rows, "devhub"))).toEqual({
			DevHub: ["Main[100]", "Agent journal stream[140]"],
		});
	});
});
