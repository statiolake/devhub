/**
 * One Task Manager reading, taken from the running app.
 *
 * The join is `buildTaskTree`'s (`diagnostics/taskTree.ts`), a pure function;
 * this is only where each of its inputs is read, once per refresh:
 *
 * - two `ps` runs for every process's parent, resident set, CPU, executable
 *   and command line (`processTable.ts`);
 * - each process's footprint and what of it is in RAM: on macOS one
 *   `devhub-footprint` (`main/native/footprint.c`: `ri_phys_footprint` and
 *   `ri_resident_size`), on Linux each DevHub process's `/proc/<pid>/status`
 *   (`VmRSS + VmSwap`, `VmRSS`); `ps`'s resident set for both where neither
 *   can be read;
 * - `app.getAppMetrics()` for which processes are Electron's own, with VS
 *   Code's own names for the utility processes it started
 *   (`UtilityProcess.getAll()`), which is what says which extension host is
 *   which workbench's: `extension-host [<window id>]` and `file-watcher
 *   [<window id>]`, and a workbench's window id is its view's id
 *   (`WorkbenchView.id`);
 * - one tmux client for every marked pane's pid and every client's
 *   (`TmuxTerminalRuntime.processPanes`);
 * - the system's memory (`systemMemory.ts`).
 *
 * Every process those commands are while they run is left out
 * (`TaskTreeInput.ignore`): a reading is not DevHub's cost.
 *
 * Only this Mac's processes: a workbench on an ssh host or in a container
 * has its renderer here and everything else there, and only the renderer is
 * shown.
 */

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { UtilityProcess } from "code-oss-dev/out/vs/platform/utilityProcess/electron-main/utilityProcess.js";
import { electron } from "../electron.js";
import type { TaskSnapshotWire } from "../../ipc/taskManager.js";
import {
	parseFootprints,
	parseProcessTables,
	parseProcStatus,
	type ProcessMemory,
	type ProcessRow,
	PS_ARGS_ARGUMENTS,
	PS_STAT_ARGUMENTS,
} from "../diagnostics/processTable.js";
import { readSystemMemory } from "../diagnostics/systemMemory.js";
import {
	buildTaskTree,
	type ElectronProcess,
	type TaskWorkspace,
	utilitiesByWindow,
} from "../diagnostics/taskTree.js";
import type { ProcessPanes } from "../terminal/tmux.js";
import { nativeHelperPath } from "./appRoot.js";

const FOOTPRINT_HELPER = nativeHelperPath("devhub-footprint");

/**
 * A command's stdout, with its pid noted in `spawned` the moment it starts,
 * so the reading it is part of can leave it out.
 */
function outputOf(
	spawned: Set<number>,
): (file: string, args: readonly string[]) => Promise<string> {
	return (file, args) =>
		new Promise((resolve, reject) => {
			const child = execFile(
				file,
				[...args],
				{ maxBuffer: 16 * 1024 * 1024 },
				(error, stdout) => {
					if (error) reject(error);
					else resolve(stdout);
				},
			);
			if (child.pid !== undefined) spawned.add(child.pid);
		});
}

let lastFootprintFailure: string | undefined;

/** The footprints on macOS; nothing elsewhere, or when the helper fails. */
async function readFootprints(
	run: (file: string, args: readonly string[]) => Promise<string>,
): Promise<Map<number, ProcessMemory> | undefined> {
	if (process.platform !== "darwin") return undefined;
	try {
		await access(FOOTPRINT_HELPER);
		return parseFootprints(await run(FOOTPRINT_HELPER, []));
	} catch (error: unknown) {
		const reason = error instanceof Error ? error.message : String(error);
		if (reason !== lastFootprintFailure) {
			console.warn(
				`[devhub] task manager: no footprints, showing the resident set: ${reason}`,
			);
		}
		lastFootprintFailure = reason;
		return undefined;
	}
}

/**
 * Linux: each DevHub process's `/proc/<pid>/status` (`VmRSS`, `VmSwap`) —
 * only those under main and the tmux server, a few dozen small reads.
 */
async function readProcStatuses(
	processes: readonly ProcessRow[],
	roots: readonly number[],
): Promise<Map<number, ProcessMemory>> {
	const childrenOf = new Map<number, number[]>();
	for (const row of processes) {
		if (row.ppid === row.pid) continue;
		childrenOf.set(row.ppid, [...(childrenOf.get(row.ppid) ?? []), row.pid]);
	}
	const pids = new Set<number>();
	const walk = (pid: number) => {
		if (pids.has(pid)) return;
		pids.add(pid);
		for (const child of childrenOf.get(pid) ?? []) walk(child);
	};
	for (const root of roots) walk(root);
	const memory = new Map<number, ProcessMemory>();
	await Promise.all(
		[...pids].map(async (pid) => {
			const text = await readFile(`/proc/${String(pid)}/status`, "utf8").catch(
				() => undefined,
			);
			const one = text === undefined ? undefined : parseProcStatus(text);
			if (one) memory.set(pid, one);
		}),
	);
	return memory;
}

export interface TaskReadingSources {
	/** The model's Workspaces, in the Sidebar's order, with view ids. */
	workspaces(): readonly (Omit<TaskWorkspace, "workbench"> & {
		readonly workbench?: Omit<
			NonNullable<TaskWorkspace["workbench"]>,
			"utilities"
		> & { readonly viewId: number };
	})[];
	/** DevHub's own pages, by renderer pid. */
	pages(): readonly { readonly pid: number; readonly name: string }[];
	/** This Mac's tmux, or nothing to say when it is not up. */
	tmux(): Promise<ProcessPanes>;
}

let lastTmuxFailure: string | undefined;

const NO_TMUX: ProcessPanes = { serverPid: undefined, panes: [], clients: [] };

export async function takeTaskReading(
	sources: TaskReadingSources,
): Promise<TaskSnapshotWire> {
	const spawned = new Set<number>();
	const output = outputOf(spawned);
	const [stat, args, footprints, system, tmux] = await Promise.all([
		output("ps", PS_STAT_ARGUMENTS),
		output("ps", PS_ARGS_ARGUMENTS),
		readFootprints(output),
		readSystemMemory({
			platform: process.platform,
			run: output,
			read: (path) => readFile(path, "utf8").catch(() => undefined),
		}),
		sources.tmux().catch((error: unknown) => {
			// Every pane is then shown under nobody, so the reason is said —
			// once per reason, not every two seconds.
			const reason = error instanceof Error ? error.message : String(error);
			if (reason !== lastTmuxFailure) {
				console.warn(
					`[devhub] task manager: tmux could not be read: ${reason}`,
				);
			}
			lastTmuxFailure = reason;
			return NO_TMUX;
		}),
	]);
	const utilities = UtilityProcess.getAll();
	const names = new Map(utilities.map((one) => [one.pid, one.name]));
	const windowUtilities = utilitiesByWindow(utilities);
	const electronProcesses: ElectronProcess[] = electron.app
		.getAppMetrics()
		.map((metric) => ({
			pid: metric.pid,
			type: metric.type,
			name: names.get(metric.pid) ?? metric.name ?? metric.serviceName,
		}));
	const processes = parseProcessTables(stat, args);
	// The tmux client `processPanes` runs is this reading too; it is started
	// beside `ps` without a pid this can note, and is known by what it asks.
	for (const row of processes) {
		if (row.ppid === process.pid && row.args.includes("process-pane")) {
			spawned.add(row.pid);
		}
	}
	const memory =
		footprints ??
		(process.platform === "linux"
			? await readProcStatuses(processes, [
					process.pid,
					...(tmux.serverPid === undefined ? [] : [tmux.serverPid]),
				])
			: undefined);
	const tree = buildTaskTree({
		takenAt: Date.now(),
		processes,
		...(memory === undefined
			? {}
			: {
					memory,
					memoryMetric:
						footprints === undefined
							? ("rss-swap" as const)
							: ("footprint" as const),
				}),
		ignore: spawned,
		electron: electronProcesses,
		pages: sources.pages(),
		workspaces: sources.workspaces().map(({ workbench, ...workspace }) => ({
			...workspace,
			...(workbench === undefined
				? {}
				: {
						workbench: {
							state: workbench.state,
							sleepable: workbench.sleepable,
							renderers: workbench.renderers,
							utilities: windowUtilities.get(workbench.viewId) ?? [],
						},
					}),
		})),
		tmux,
	});
	return { ...tree, system };
}

/** The command line a pid runs now, or nothing when it has gone. */
export async function commandOf(pid: number): Promise<string | undefined> {
	try {
		const args = (
			await outputOf(new Set())("ps", ["-o", "args=", "-p", String(pid)])
		).trim();
		return args.length > 0 ? args : undefined;
	} catch {
		return undefined;
	}
}
