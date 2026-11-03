/**
 * One Task Manager reading, taken from the running app.
 *
 * The join is `buildTaskTree`'s (`diagnostics/taskTree.ts`), a pure function;
 * this is only where each of its inputs is read, once per refresh:
 *
 * - one `ps` for every process's parent, memory and CPU;
 * - `app.getAppMetrics()` for which processes are Electron's own, with VS
 *   Code's own names for the utility processes it started
 *   (`UtilityProcess.getAll()`), which is what says which extension host is
 *   which workbench's: `extension-host [<window id>]`, and a workbench's
 *   window id is its view's id (`WorkbenchView.id`);
 * - one tmux client for every marked pane's pid and every client's
 *   (`TmuxTerminalRuntime.processPanes`);
 * - the system's memory (`systemMemory.ts`).
 *
 * Only this Mac's processes: a workbench on an ssh host or in a container
 * has its renderer here and everything else there, and only the renderer is
 * shown.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { UtilityProcess } from "code-oss-dev/out/vs/platform/utilityProcess/electron-main/utilityProcess.js";
import { electron } from "../electron.js";
import type { TaskSnapshotWire } from "../../ipc/taskManager.js";
import {
	parseProcessTable,
	PS_ARGUMENTS,
} from "../diagnostics/processTable.js";
import { readSystemMemory } from "../diagnostics/systemMemory.js";
import {
	buildTaskTree,
	type ElectronProcess,
	type TaskWorkspace,
} from "../diagnostics/taskTree.js";
import type { ProcessPanes } from "../terminal/tmux.js";

const run = promisify(execFile);

async function output(file: string, args: readonly string[]): Promise<string> {
	return (await run(file, [...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
}

export interface TaskReadingSources {
	/** The model's Workspaces, in the Sidebar's order, with view ids. */
	workspaces(): readonly (Omit<TaskWorkspace, "workbench"> & {
		readonly workbench?: Omit<
			NonNullable<TaskWorkspace["workbench"]>,
			"extensionHosts"
		> & { readonly viewId: number };
	})[];
	/** DevHub's own pages, by renderer pid. */
	pages(): readonly { readonly pid: number; readonly name: string }[];
	/** This Mac's tmux, or nothing to say when it is not up. */
	tmux(): Promise<ProcessPanes>;
}

let lastTmuxFailure: string | undefined;

const NO_TMUX: ProcessPanes = { serverPid: undefined, panes: [], clients: [] };

/** Which extension hosts each workbench window has, by window id. */
export function extensionHostsByWindow(
	utilities: readonly { readonly pid: number; readonly name: string }[],
): Map<number, number[]> {
	const hosts = new Map<number, number[]>();
	for (const utility of utilities) {
		const match = /^extension-host \[(\d+)\]$/u.exec(utility.name);
		if (!match) continue;
		const window = Number(match[1]);
		hosts.set(window, [...(hosts.get(window) ?? []), utility.pid]);
	}
	return hosts;
}

export async function takeTaskReading(
	sources: TaskReadingSources,
): Promise<TaskSnapshotWire> {
	const [ps, system, tmux] = await Promise.all([
		output("ps", PS_ARGUMENTS),
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
	const hosts = extensionHostsByWindow(utilities);
	const electronProcesses: ElectronProcess[] = electron.app
		.getAppMetrics()
		.map((metric) => ({
			pid: metric.pid,
			type: metric.type,
			name: names.get(metric.pid) ?? metric.name ?? metric.serviceName,
		}));
	const tree = buildTaskTree({
		takenAt: Date.now(),
		processes: parseProcessTable(ps),
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
							extensionHosts: hosts.get(workbench.viewId) ?? [],
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
			await output("ps", ["-o", "args=", "-p", String(pid)])
		).trim();
		return args.length > 0 ? args : undefined;
	} catch {
		return undefined;
	}
}
