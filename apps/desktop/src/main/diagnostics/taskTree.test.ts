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
	utilityLabel,
} from "./taskTree.js";

/**
 * A VS Code workbench's renderer, extension hosts and what they started
 * (120–125) are in the fixtures, from when a Workspace had one. Nothing in
 * DevHub runs them now, so they are left out of every reading here.
 */
const WORKBENCH_PIDS = new Set([120, 121, 122, 123, 124, 125]);
const withoutWorkbench = <T extends { readonly pid: number }>(
	rows: readonly T[],
): T[] => rows.filter((row) => !WORKBENCH_PIDS.has(row.pid));

const processes = withoutWorkbench(
	parseProcessTable(
		readFileSync(new URL("./fixtures/ps-darwin.txt", import.meta.url), "utf8"),
	),
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
	it("groups a Workspace's terminal and Agents under it", () => {
		expect(shape(find(tree.rows, "workspace:w1"))).toEqual({
			widget: [
				{ Terminal: [{ "zsh[201]": ["nvim[202]"] }, "tmux client[131]"] },
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

	it("says what a Workspace and an Agent offer", () => {
		expect(find(tree.rows, "workspace:w1").actions).toEqual(["reveal"]);
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
		for (const pid of [201, 202, 210, 140]) {
			expect(killable(pid), String(pid)).toBe(true);
		}
		for (const pid of [100, 101, 110, 130, 131, 150, 200]) {
			expect(killable(pid), String(pid)).toBe(false);
		}
	});
});

describe("adding it up", () => {
	it("sums a subtree's memory, CPU and processes", () => {
		const cli = find(tree.rows, "pid:210");
		expect(cli.memoryBytes).toBe((520000 + 80000) * KIB);
		expect(cli.cpuPercent).toBeCloseTo(15 + 0.2);
		expect(cli.processCount).toBe(2);
	});

	it("makes a Workspace's total its terminal and Agents", () => {
		const workspace = find(tree.rows, "workspace:w1");
		const kib =
			7000 +
			140000 +
			4000 + // terminal
			520000 +
			80000 +
			4000 +
			6000; // Agent
		expect(workspace.memoryBytes).toBe(kib * KIB);
		expect(workspace.processCount).toBe(7);
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
		expect(text).toMatch(/ {6}claude \[210\]\n/u);
		// Heaviest first: DevHub's own processes before the Workspace.
		expect(text.indexOf("DevHub\n")).toBeLessThan(text.indexOf("widget"));
	});
});

describe("a GUI Agent, and what is not DevHub's cost", () => {
	// The two-run fixture: 140 a GUI Agent's journal stream (with its tail, watchdog and
	// sleep) for the host 210 runs in the Agent's pane; 150 a zombie, 151 a
	// `(vm_stat)` already ending, 152 this reading's own `ps`.
	const twoRuns = withoutWorkbench(
		parseProcessTables(
			readFileSync(
				new URL("./fixtures/ps-stat-darwin.txt", import.meta.url),
				"utf8",
			),
			readFileSync(
				new URL("./fixtures/ps-args-darwin.txt", import.meta.url),
				"utf8",
			),
		),
	);
	const gui = buildTaskTree({
		takenAt: 0,
		processes: twoRuns,
		electron: [
			{ pid: 100, type: "Browser" },
			{ pid: 101, type: "GPU" },
		],
		pages: [],
		workspaces: [
			{
				id: "w1",
				label: "widget",
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
				212,
				{ footprintBytes: 900 * 1024 ** 2, residentBytes: 100 * 1024 ** 2 },
			],
			[213, { footprintBytes: 1200 * 1024 ** 2, residentBytes: 5 * 1024 ** 2 }],
		]),
		memoryMetric: "footprint",
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
		expect(find(gui.rows, "pid:213")).toMatchObject({
			memoryBytes: 1200 * 1024 ** 2,
			residentBytes: 5 * 1024 ** 2,
		});
		// No reading for 214: its resident set is both.
		expect(find(gui.rows, "pid:214")).toMatchObject({
			memoryBytes: 50000 * KIB,
			residentBytes: 50000 * KIB,
		});
		// Summed over the subtree, each figure on its own.
		expect(find(gui.rows, "pid:212")).toMatchObject({
			memoryBytes: (900 + 1200) * 1024 ** 2 + 50000 * KIB,
			residentBytes: (100 + 5) * 1024 ** 2 + 50000 * KIB,
		});
		expect(tree.memoryMetric).toBe("rss");
	});

	it("says a utility's name as words", () => {
		expect(utilityLabel("pty-host [7]")).toBe("Terminal host (pty)");
		expect(utilityLabel("agent-host")).toBe("Agent host");
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
