/**
 * Which processes are one workbench's, for freezing it (SIGSTOP) and thawing
 * it (SIGCONT).
 *
 * A workbench is its renderer (`webContents.getOSProcessId()`) and the
 * utility processes VS Code started for that window alone — its extension
 * host(s) and its file watcher, named `<name> [<window id>]`
 * (`UtilityProcess.getAll()`) — each with every process under it: the
 * language servers and helpers an extension started.
 *
 * What is never one workbench's, and so never stopped:
 *
 * - Electron's other processes: DevHub's main, the GPU and network
 *   processes, VS Code's shared process and its pty host, DevHub's own pages.
 *   A walk down a subtree stops at one of them.
 * - Everything under the pty host, which is shared: the integrated terminals'
 *   shells, and the tmux client every DevHub terminal tab is. Freezing a
 *   workbench never stops what runs in its terminals; tmux keeps running.
 * - tmux, wherever it turns up, with everything under it: a tmux started
 *   below an extension host is still a tmux server or client somebody else's
 *   panes depend on.
 * - Anything `foreign`: a process that also serves something that is not this
 *   workbench — a renderer that hosts one of DevHub's own pages as well (Chromium
 *   may put several contents in one process), main, the GPU process — even
 *   when main named it as the workbench's own. Stopping it would stop that
 *   page, or the whole window, with it.
 *
 * The order is the order to stop them in: the renderer first, so it never
 * watches its extension host stop, then each utility with its tree, a parent
 * before its children. Thawing is the reverse — children and extension hosts
 * first, the renderer last — so the renderer resumes to an extension host
 * that already answers.
 *
 * A pure function of one `ps` reading, tested on fixtures.
 */

import type { ProcessRow } from "./processTable.js";

export interface FreezeTargetInput {
	readonly processes: readonly ProcessRow[];
	/** The workbench's renderer, if it has one up. */
	readonly renderer: number | undefined;
	/** Its window's utility processes: extension hosts, the file watcher. */
	readonly windowUtilities: readonly number[];
	/** Every Electron process (main, GPU, utilities, renderers): never walked into. */
	readonly electron: readonly number[];
	/**
	 * Processes that are not exclusively this workbench's (`foreign` above):
	 * never stopped, never walked into, even when named as its own.
	 */
	readonly foreign?: readonly number[];
}

/** Whether a process is tmux, server or client. */
function isTmux(row: ProcessRow): boolean {
	const name = row.comm.slice(row.comm.lastIndexOf("/") + 1).replace(/^-/u, "");
	return name === "tmux" || /^tmux: (server|client)/u.test(row.args);
}

/** The pids to stop, in stopping order; thaw in reverse. */
export function freezeTargets(input: FreezeTargetInput): number[] {
	const byPid = new Map(input.processes.map((row) => [row.pid, row]));
	const childrenOf = new Map<number, ProcessRow[]>();
	for (const row of input.processes) {
		if (row.ppid === row.pid) continue;
		const siblings = childrenOf.get(row.ppid) ?? [];
		siblings.push(row);
		childrenOf.set(row.ppid, siblings);
	}
	// Only real pids: a renderer with no process up is 0, and on macOS pid 0
	// is `kernel_task`, the root every walk down from it reaches everything.
	const foreign = new Set(input.foreign ?? []);
	const own = new Set<number>(
		[
			...(input.renderer === undefined ? [] : [input.renderer]),
			...input.windowUtilities,
		].filter((pid) => pid > 0 && !foreign.has(pid)),
	);
	// An Electron process that is not this workbench's own is a wall, and so
	// is anything foreign.
	const walls = new Set([
		...input.electron.filter((pid) => !own.has(pid)),
		...foreign,
	]);
	const order: number[] = [];
	const seen = new Set<number>();
	const visit = (pid: number) => {
		if (seen.has(pid)) return;
		seen.add(pid);
		const row = byPid.get(pid);
		if (row === undefined || isTmux(row)) return;
		order.push(pid);
		for (const child of childrenOf.get(pid) ?? []) {
			if (walls.has(child.pid) || own.has(child.pid)) continue;
			visit(child.pid);
		}
	};
	// The renderer first (inserted first), then each utility.
	for (const pid of own) visit(pid);
	return order;
}
