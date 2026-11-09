/**
 * Every process DevHub has, attributed to the thing a person thinks in.
 *
 * `ps` knows each process's parent and its memory; Electron knows which of
 * them are its own and what each is for; tmux knows which pane is whose. None of them
 * alone can say "this Workspace costs 2 GB" — joining them is this file, and
 * the join is a pure function of one reading of each, so it is tested on a
 * fixture rather than on a machine.
 *
 * # Attribution
 *
 * A process is attributed by the nearest pid DevHub *knows* — an **anchor** —
 * and then by the process tree under it:
 *
 * - every pane of a session DevHub marked: a Workspace's `ws-` session (its
 *   shells, a managed Neovim), an Agent's own session (its CLI, or a GUI
 *   Agent's host and app-server) and an Agent's terminal (`tm-`);
 * - every tmux client, by the session it shows;
 * - the tmux server itself, with whatever else runs on it;
 * - Electron's own processes — main, GPU, utilities, DevHub's pages — as
 *   DevHub, each **without** what it started: main starts everything, so its
 *   subtree is the whole app.
 *
 * A walk down a subtree stops at another anchor, so the most specific owner
 * wins: a CLI is its Agent's even though main is its ancestor. What is left under one of Electron's processes once every anchor
 * has been placed — a `git`, an `ssh`, a helper — is **Other**, said with
 * what started it.
 *
 * # Aggregation
 *
 * A row's memory, CPU and process count are its own plus everything under
 * it, so a Workspace's total is its terminal and its Agents.
 * Memory is two figures: the **footprint**, what a process costs wherever
 * its pages are (macOS's physical footprint, Activity Monitor's "Memory":
 * compressed and swapped pages included, shared frameworks not; Linux's
 * `VmRSS + VmSwap`), and what of it is **in RAM** now. Without a reading of
 * either (`memory` absent for a pid) both are the resident set `ps`
 * reports. See `docs/task-manager.md`.
 *
 * Left out: zombies (they hold no memory, and a `(name)` row is a process
 * already gone) and the processes this reading itself started (`ignore`: the
 * `ps`, the `tmux` client, `vm_stat`).
 */

import {
	formatBytes,
	type MemoryMetricWire,
	type TaskActionWire,
	type TaskRowKind,
	type TaskRowWire,
	type TaskSnapshotWire,
} from "../../ipc/taskManager.js";
import type { ProcessPanes } from "../terminal/tmux.js";
import { HOST_NAME, STREAM_NAME } from "../agent/conversation/hostScript.js";
import {
	processName,
	type ProcessMemory,
	type ProcessRow,
} from "./processTable.js";

/** One of Electron's own processes, with the best name anything has for it. */
export interface ElectronProcess {
	readonly pid: number;
	/** `Browser`, `GPU`, `Utility`, `Tab`, … as `getAppMetrics` says. */
	readonly type: string;
	/** A utility's service name. */
	readonly name?: string;
}

export interface TaskAgent {
	readonly id: string;
	readonly label: string;
	/** What it is: `claude · terminal`. */
	readonly detail: string;
	/** Its own terminal's tmux session (`tm-<id>`), while it has one. */
	readonly terminalSession?: string;
}

export interface TaskWorkspace {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly agents: readonly TaskAgent[];
}

export interface TaskTreeInput {
	readonly takenAt: number;
	readonly processes: readonly ProcessRow[];
	readonly electron: readonly ElectronProcess[];
	/** DevHub's own pages, by renderer pid: the Sidebar, Settings, … */
	readonly pages: readonly { readonly pid: number; readonly name: string }[];
	/** In the Sidebar's order. */
	readonly workspaces: readonly TaskWorkspace[];
	readonly tmux: ProcessPanes;
	/** Each process's footprint and in-RAM memory, where they were read. */
	readonly memory?: ReadonlyMap<number, ProcessMemory>;
	/** Where `memory` came from; `rss` when it is absent. */
	readonly memoryMetric?: MemoryMetricWire;
	/** Processes this reading started itself, which are not DevHub's cost. */
	readonly ignore?: ReadonlySet<number>;
}

export type TaskTree = Omit<TaskSnapshotWire, "system">;

interface Totals {
	memoryBytes: number;
	residentBytes: number;
	cpuPercent: number;
	processCount: number;
}

function totalsOf(rows: readonly TaskRowWire[]): Totals {
	return rows.reduce<Totals>(
		(sum, row) => ({
			memoryBytes: sum.memoryBytes + row.memoryBytes,
			residentBytes: sum.residentBytes + row.residentBytes,
			cpuPercent: sum.cpuPercent + row.cpuPercent,
			processCount: sum.processCount + row.processCount,
		}),
		{ memoryBytes: 0, residentBytes: 0, cpuPercent: 0, processCount: 0 },
	);
}

function group(
	id: string,
	kind: TaskRowKind,
	label: string,
	children: readonly TaskRowWire[],
	extra: Partial<TaskRowWire> = {},
): TaskRowWire {
	return {
		id,
		kind,
		label,
		actions: [],
		...extra,
		...totalsOf(children),
		children,
	};
}

/** Names for the utilities DevHub starts, as a row says them. */
const UTILITY_LABELS: Readonly<Record<string, string>> = {
	"pty-host": "Terminal host (pty)",
};

/**
 * A utility process's name as a row says it: `agent-host` is `Agent host`,
 * and a trailing ` [<id>]` is the row's place in the tree rather than its
 * name.
 */
export function utilityLabel(name: string): string {
	const bare = name.replace(/ \[\d+\]$/u, "");
	const known = UTILITY_LABELS[bare];
	if (known !== undefined) return known;
	if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/u.test(bare)) return bare;
	const words = bare.replace(/[-_]/gu, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What Electron's process is called in the table. */
function electronLabel(
	process: ElectronProcess,
	pages: ReadonlyMap<number, string>,
): string {
	switch (process.type) {
		case "Browser":
			return "Main";
		case "GPU":
			return "GPU";
		case "Tab":
			return pages.get(process.pid) ?? "Renderer";
		default:
			return process.name === undefined
				? process.type
				: utilityLabel(process.name);
	}
}

export function buildTaskTree(input: TaskTreeInput): TaskTree {
	const processes = input.processes.filter(
		(row) => !row.exited && !(input.ignore?.has(row.pid) ?? false),
	);
	const byPid = new Map(processes.map((row) => [row.pid, row]));
	const childrenOf = new Map<number, ProcessRow[]>();
	for (const row of processes) {
		if (row.ppid === row.pid) continue;
		const siblings = childrenOf.get(row.ppid) ?? [];
		siblings.push(row);
		childrenOf.set(row.ppid, siblings);
	}
	const pages = new Map(input.pages.map((page) => [page.pid, page.name]));
	const electron = new Map(input.electron.map((one) => [one.pid, one]));
	const { tmux } = input;

	const anchors = new Set<number>([
		...electron.keys(),
		...tmux.panes.map((pane) => pane.pid),
		...tmux.clients.map((client) => client.pid),
		...(tmux.serverPid === undefined ? [] : [tmux.serverPid]),
	]);
	/** Pids no row may offer to kill: DevHub's own core processes. */
	const core = new Set<number>([
		...electron.keys(),
		...tmux.clients.map((client) => client.pid),
		...(tmux.serverPid === undefined ? [] : [tmux.serverPid]),
	]);

	const memoryOf = (row: ProcessRow): ProcessMemory =>
		input.memory?.get(row.pid) ?? {
			footprintBytes: row.rssKb * 1024,
			residentBytes: row.rssKb * 1024,
		};
	const claimed = new Set<number>();
	const processRow = (
		pid: number,
		options: { label?: string; detail?: string; descendants: boolean },
	): TaskRowWire | undefined => {
		const row = byPid.get(pid);
		if (!row || claimed.has(pid)) return undefined;
		claimed.add(pid);
		const children = options.descendants
			? (childrenOf.get(pid) ?? [])
					.filter((child) => !anchors.has(child.pid))
					.flatMap((child) => {
						const node = processRow(child.pid, { descendants: true });
						return node ? [node] : [];
					})
			: [];
		const below = totalsOf(children);
		const actions: TaskActionWire[] = core.has(pid) ? [] : ["kill"];
		return {
			id: `pid:${String(pid)}`,
			kind: "process",
			label: options.label ?? processName(row),
			detail: options.detail ?? row.args,
			pid,
			memoryBytes: memoryOf(row).footprintBytes + below.memoryBytes,
			residentBytes: memoryOf(row).residentBytes + below.residentBytes,
			cpuPercent: row.cpuPercent + below.cpuPercent,
			processCount: 1 + below.processCount,
			actions,
			children,
		};
	};
	const rowsOf = (
		pids: Iterable<number>,
		options: { label?: string; detail?: string } = {},
	): TaskRowWire[] =>
		[...pids].flatMap((pid) => {
			const node = processRow(pid, { ...options, descendants: true });
			return node ? [node] : [];
		});

	const sessionsOf = (match: (pane: (typeof tmux.panes)[number]) => boolean) =>
		new Set(tmux.panes.filter(match).map((pane) => pane.sessionName));
	const clientsOf = (sessions: ReadonlySet<string>) =>
		tmux.clients.filter((client) => sessions.has(client.session));
	const panePids = (match: (pane: (typeof tmux.panes)[number]) => boolean) =>
		tmux.panes.filter(match);
	const paneRows = (panes: typeof tmux.panes): TaskRowWire[] =>
		panes.flatMap((pane) =>
			rowsOf([pane.pid], {
				detail: `${pane.sessionName} ${pane.paneId} · ${byPid.get(pane.pid)?.args ?? ""}`,
			}),
		);
	const clientRows = (clients: readonly { pid: number; session: string }[]) =>
		clients.flatMap((client) =>
			rowsOf([client.pid], {
				label: "tmux client",
				detail: `shows ${client.session}`,
			}),
		);

	// A GUI Agent's journal is followed by a shell main starts
	// (`hostLink.ts`: `sh -c … devhub-agent-stream <dir> <offset>`, with its
	// `tail -f`, its watchdog's `cat` and its `sleep 1`). It is that Agent's:
	// the one whose host (`devhub-agent-host <dir> …`) runs in its pane.
	// `ps` prints the script's newlines as `\n` or `?`, so the name is found
	// by what follows it: the directory (the script's own messages say
	// `devhub-agent-stream: …`).
	const streamDirectory = new RegExp(`${STREAM_NAME} ([^:].*) \\d+$`, "u");
	const streams = processes.filter(
		(row) => electron.has(row.ppid) && streamDirectory.test(row.args),
	);
	const pidsUnder = (rows: readonly TaskRowWire[]): number[] =>
		rows.flatMap((row) => [
			...(row.pid === undefined ? [] : [row.pid]),
			...pidsUnder(row.children),
		]);
	const journalStreamRows = (agentRows: readonly TaskRowWire[]) => {
		const hosts = pidsUnder(agentRows).flatMap((pid) => {
			const args = byPid.get(pid)?.args ?? "";
			return args.includes(`${HOST_NAME} `) ? [args] : [];
		});
		return streams
			.filter((stream) => {
				const dir = streamDirectory.exec(stream.args)?.[1];
				return (
					dir !== undefined &&
					hosts.some((host) => host.includes(`${HOST_NAME} ${dir} `))
				);
			})
			.flatMap((stream) => rowsOf([stream.pid], { label: "Journal stream" }));
	};

	const workspaceRows = input.workspaces.map((workspace) => {
		const ownPanes = (pane: (typeof tmux.panes)[number]) =>
			pane.context === "workspace" && pane.workspaceId === workspace.id;
		const sessions = sessionsOf(ownPanes);
		const clients = clientsOf(sessions);
		const children: TaskRowWire[] = [];
		const terminal = [...paneRows(panePids(ownPanes)), ...clientRows(clients)];
		if (terminal.length > 0) {
			children.push(
				group(`terminal:${workspace.id}`, "group", "Terminal", terminal, {
					detail: [...sessions].join(", "),
				}),
			);
		}
		for (const agent of workspace.agents) {
			const own = (pane: (typeof tmux.panes)[number]) =>
				pane.agentId === agent.id && pane.context === "agent";
			const itsTerminal = (pane: (typeof tmux.panes)[number]) =>
				pane.context === "terminal" &&
				pane.sessionName === agent.terminalSession;
			const agentChildren = [
				...paneRows(panePids(own)),
				...clientRows(clientsOf(sessionsOf(own))),
			];
			agentChildren.push(...journalStreamRows(agentChildren));
			const terminalRows = [
				...paneRows(panePids(itsTerminal)),
				...clientRows(clientsOf(sessionsOf(itsTerminal))),
			];
			if (terminalRows.length > 0) {
				agentChildren.push(
					group(
						`agent-terminal:${agent.id}`,
						"group",
						"Terminal",
						terminalRows,
					),
				);
			}
			children.push(
				group(`agent:${agent.id}`, "agent", agent.label, agentChildren, {
					detail: agent.detail,
					agentId: agent.id,
					workspaceId: workspace.id,
					actions: ["stop", "reveal"],
				}),
			);
		}
		return group(
			`workspace:${workspace.id}`,
			"workspace",
			workspace.label,
			children,
			{
				...(workspace.detail === undefined ? {} : { detail: workspace.detail }),
				workspaceId: workspace.id,
				actions: ["reveal"],
			},
		);
	});

	// tmux: the server, and whatever on it is nobody's above — the anchor
	// session, a pane of a session whose Workspace or Agent has gone.
	const tmuxChildren = [
		...(tmux.serverPid === undefined
			? []
			: rowsOf([tmux.serverPid], { label: "tmux server" })),
		...paneRows(tmux.panes.filter((pane) => !claimed.has(pane.pid))),
		...clientRows(tmux.clients.filter((client) => !claimed.has(client.pid))),
	];

	// DevHub itself: Electron's processes, without what they started.
	const devhubChildren: TaskRowWire[] = [];
	const unattributedRenderers: TaskRowWire[] = [];
	for (const process of input.electron) {
		const named = process.type !== "Tab" || pages.has(process.pid);
		const node = processRow(process.pid, {
			label: electronLabel(process, pages),
			descendants: false,
		});
		if (node) (named ? devhubChildren : unattributedRenderers).push(node);
	}
	// A journal stream no Agent here owns: a far Agent's (`ssh`, `docker`),
	// or one whose Agent is going. Still DevHub's own work.
	devhubChildren.push(
		...streams.flatMap((stream) =>
			rowsOf([stream.pid], { label: "Agent journal stream" }),
		),
	);

	// Other: what Electron's processes started that no anchor accounts for.
	const other: TaskRowWire[] = [...unattributedRenderers];
	for (const process of input.electron) {
		const parent = electronLabel(process, pages);
		for (const child of childrenOf.get(process.pid) ?? []) {
			if (anchors.has(child.pid)) continue;
			const node = processRow(child.pid, { descendants: true });
			if (node)
				other.push({
					...node,
					detail: `from ${parent} · ${node.detail ?? ""}`,
				});
		}
	}

	const rows = [
		...workspaceRows,
		group("devhub", "devhub", "DevHub", devhubChildren),
		...(tmuxChildren.length > 0
			? [group("tmux", "tmux", "tmux", tmuxChildren)]
			: []),
		...(other.length > 0 ? [group("other", "other", "Other", other)] : []),
	];
	return {
		takenAt: input.takenAt,
		memoryMetric:
			input.memory === undefined ? "rss" : (input.memoryMetric ?? "rss"),
		total: totalsOf(rows),
		rows,
	};
}

/** What the two memory columns are, said in the copied text. */
const MEMORY_SOURCE: Readonly<Record<MemoryMetricWire, string>> = {
	footprint:
		"footprint is phys_footprint (compressed and swapped included); in RAM is the resident set, at most the footprint",
	"rss-swap": "footprint is VmRSS + VmSwap; in RAM is VmRSS",
	rss: "both are ps's resident set (no footprint could be read)",
};

/**
 * The table as text, for pasting into an issue or a conversation: the header,
 * then every row indented by depth, heaviest first at every level.
 */
export function taskSnapshotText(snapshot: TaskSnapshotWire): string {
	const { system, total } = snapshot;
	const parts = system.breakdown;
	const lines = [
		`DevHub Task Manager — ${new Date(snapshot.takenAt).toISOString()}`,
		`System memory: ${formatBytes(system.usedBytes)} used of ${formatBytes(system.totalBytes)} · pressure ${system.pressure} (${system.pressureSource}) · swap ${formatBytes(system.swapUsedBytes)} used of ${formatBytes(system.swapTotalBytes)}`,
		`  app ${formatBytes(parts.appBytes)} · wired ${formatBytes(parts.wiredBytes)} · compressed ${formatBytes(parts.compressedBytes)} (storing ${formatBytes(parts.compressorStoredBytes)}) · cached files ${formatBytes(parts.cachedBytes)} · free ${formatBytes(parts.freeBytes)}`,
		`DevHub: ${formatBytes(total.memoryBytes)} footprint, ${formatBytes(total.residentBytes)} in RAM · ${total.cpuPercent.toFixed(1)}% CPU · ${String(total.processCount)} processes`,
		`Memory: ${MEMORY_SOURCE[snapshot.memoryMetric]}`,
		"",
		`${"Footprint".padStart(10)} ${"In RAM".padStart(10)} ${"CPU".padStart(7)} ${"Procs".padStart(5)}  Name`,
	];
	const walk = (rows: readonly TaskRowWire[], depth: number): void => {
		for (const row of [...rows].sort((a, b) => b.memoryBytes - a.memoryBytes)) {
			const name = [
				row.label,
				row.pid === undefined ? undefined : `[${String(row.pid)}]`,
				row.kind === "process" ? undefined : row.detail,
			]
				.filter((part) => part !== undefined && part !== "")
				.join(" ");
			lines.push(
				`${formatBytes(row.memoryBytes).padStart(10)} ${formatBytes(row.residentBytes).padStart(10)} ${`${row.cpuPercent.toFixed(1)}%`.padStart(7)} ${String(row.processCount).padStart(5)}  ${"  ".repeat(depth)}${name}`,
			);
			walk(row.children, depth + 1);
		}
	};
	walk(snapshot.rows, 0);
	return `${lines.join("\n")}\n`;
}
