/**
 * Every process attributed to the thing a person thinks in, from one `ps`
 * snapshot of a Mac running DevHub — the fixture beside this file — and the
 * sums that make a Workspace's total.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TaskRowWire } from "../../ipc/taskManager.js";
import { parseProcessTable } from "./processTable.js";
import {
	buildTaskTree,
	taskSnapshotText,
	type TaskTreeInput,
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
				state: "awake",
				sleepable: true,
				renderers: [120],
				extensionHosts: [121],
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
						{ "claude[210]": ["server.mjs[211]"] },
						"tmux client[150]",
						{ Terminal: ["zsh[220]"] },
					],
				},
			],
		});
	});

	it("says what a workbench is doing, and what it offers", () => {
		const workbench = find(tree.rows, "workbench:w1");
		expect(workbench.state).toBe("awake");
		expect(workbench.actions).toEqual(["sleep", "reveal"]);
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
				"pty-host[130]",
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
		expect(text).toContain("  widget ~/src/widget\n");
		expect(text).toContain("VS Code (awake)");
		expect(text).toMatch(/ {6}rust-analyzer \[122\]\n/u);
		// Heaviest first: the Workspace with rust-analyzer before DevHub.
		expect(text.indexOf("widget")).toBeLessThan(text.indexOf("DevHub\n"));
	});
});
