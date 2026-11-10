/**
 * The Task Manager window.
 *
 * A window of its own, made the way Settings is (`settingsWindow.ts`): its
 * own entry (`task-manager.html`), its own preload, a singleton, and the same
 * chord that opens it closes it while it is the window in front.
 *
 * Main keeps no timer for it. The page asks for a snapshot while it is
 * visible (`document.visibilityState`, which a minimised or covered window
 * loses), one at a time, about every two seconds; a hidden window costs
 * nothing. What main keeps is the last snapshot it answered with, because a
 * kill is allowed only for a process that snapshot offered it for, and only
 * while that pid still runs the same command line — a pid reused in between is
 * somebody else's process.
 *
 * Everything else a row can do is the host's: Sleep is the workbench
 * lifecycle's own freeze, Stop is an Agent's stop with its question, and
 * Reveal is a selection like any other, with the main window brought forward.
 */

import { electron } from "../electron.js";
import { supervisePage } from "./pageRecovery.js";
import { isQuitting } from "./shellWindow.js";
import { WINDOW_TITLES } from "../../ipc/windowTitles.js";
import {
	formatBytes,
	TASK_MANAGER_CHANNELS,
	type TaskRevealWire,
	type TaskRowWire,
	type TaskSnapshotWire,
} from "../../ipc/taskManager.js";
import type { ShellPalette } from "../../ipc/palette.js";
import { CHANNELS } from "../../ipc/contract.js";
import { taskSnapshotText } from "../diagnostics/taskTree.js";
import { SHELL_ORIGIN } from "./shellPageProtocol.js";
import { shellThemeIfInstalled } from "./shellTheme.js";
import { menuBarOptions } from "./menuBar.js";

export interface TaskManagerHost {
	readonly preloadPath: string;
	/** One reading: `ps`, Electron, tmux and the model, joined. */
	snapshot(): Promise<TaskSnapshotWire>;
	/** The command line a pid runs now; undefined when it has gone. */
	commandOf(pid: number): Promise<string | undefined>;
	stopAgent(agentId: string): void;
	reveal(target: TaskRevealWire): void;
	/** `process.kill`, injected so a test kills nothing. */
	signal(pid: number): void;
}

let host: TaskManagerHost | undefined;
let window: Electron.BrowserWindow | undefined;
let last: TaskSnapshotWire | undefined;

export function installTaskManagerWindow(next: TaskManagerHost): void {
	host = next;
	registerIpc();
}

function requireHost(): TaskManagerHost {
	if (!host) {
		throw new Error("the Task Manager was used before it was installed");
	}
	return host;
}

/** Open the Task Manager — or, when it is the window in front, close it. */
export function openTaskManagerWindow(): void {
	const taskManager = requireHost();
	if (window && !window.isDestroyed()) {
		if (window.isFocused()) {
			window.close();
			return;
		}
		window.show();
		window.focus();
		return;
	}
	window = new electron.BrowserWindow({
		// Wide enough for a name, a bar and three columns of numbers; tall
		// enough for a few Workspaces open at once.
		width: 760,
		height: 600,
		minWidth: 560,
		minHeight: 320,
		title: WINDOW_TITLES.taskManager,
		titleBarStyle: "hiddenInset",
		...menuBarOptions(),
		backgroundColor: shellThemeIfInstalled()?.palette().canvas,
		show: false,
		webPreferences: {
			preload: taskManager.preloadPath,
			sandbox: false,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	void window.loadURL(`${SHELL_ORIGIN}/task-manager.html`);
	supervisePage(window.webContents, "task-manager", isQuitting);
	window.once("ready-to-show", () => {
		window?.show();
	});
	window.on("closed", () => {
		window = undefined;
		last = undefined;
	});
}

/** The theme changed: the window's ground and its page follow. */
export function applyTaskManagerPalette(palette: ShellPalette): void {
	if (!window || window.isDestroyed()) return;
	window.setBackgroundColor(palette.canvas);
	window.webContents.send(CHANNELS.themeChanged, palette);
}

export function taskManagerWindowIsFocused(): boolean {
	return window !== undefined && !window.isDestroyed() && window.isFocused();
}

export function taskManagerWindowContents(): Electron.WebContents | undefined {
	return window === undefined || window.isDestroyed()
		? undefined
		: window.webContents;
}

function findRow(
	rows: readonly TaskRowWire[],
	pid: number,
): TaskRowWire | undefined {
	for (const row of rows) {
		if (row.kind === "process" && row.pid === pid) return row;
		const found = findRow(row.children, pid);
		if (found) return found;
	}
	return undefined;
}

/**
 * Kill one process, after asking.
 *
 * Only a row the last snapshot offered Kill on — never DevHub's own core
 * processes, which no row offers it for — and only while the pid runs the
 * command line that row showed. SIGTERM, to that one process.
 */
export async function killFromTaskManager(pid: number): Promise<boolean> {
	const taskManager = requireHost();
	const row = last === undefined ? undefined : findRow(last.rows, pid);
	if (!row?.actions.includes("kill")) {
		throw new Error(
			`process ${String(pid)} is not one the Task Manager may end`,
		);
	}
	const question: Electron.MessageBoxOptions = {
		type: "warning",
		message: `End “${row.label}”?`,
		detail: `Process ${String(pid)}, ${formatBytes(row.memoryBytes)}${row.processCount > 1 ? `, with ${String(row.processCount - 1)} more under it` : ""}. It is sent SIGTERM, and whatever it was doing is lost.\n\n${row.detail ?? ""}`,
		buttons: ["End Process", "Cancel"],
		defaultId: 1,
		cancelId: 1,
	};
	const { response } =
		window && !window.isDestroyed()
			? await electron.dialog.showMessageBox(window, question)
			: await electron.dialog.showMessageBox(question);
	if (response !== 0) return false;
	const now = await taskManager.commandOf(pid);
	if (now === undefined) return true;
	if (row.detail !== undefined && !row.detail.endsWith(now)) {
		throw new Error(
			`process ${String(pid)} is running something else now, and was left alone`,
		);
	}
	taskManager.signal(pid);
	return true;
}

function registerIpc(): void {
	const handle = electron.ipcMain.handle.bind(electron.ipcMain);
	handle(TASK_MANAGER_CHANNELS.snapshot, async () => {
		last = await requireHost().snapshot();
		return last;
	});
	handle(TASK_MANAGER_CHANNELS.stopAgent, (_event, id: unknown) => {
		requireHost().stopAgent(String(id));
	});
	handle(TASK_MANAGER_CHANNELS.reveal, (_event, target: TaskRevealWire) => {
		requireHost().reveal(target);
	});
	handle(TASK_MANAGER_CHANNELS.kill, (_event, pid: unknown) =>
		killFromTaskManager(Number(pid)),
	);
	handle(TASK_MANAGER_CHANNELS.copy, async () => {
		const snapshot = last ?? (await requireHost().snapshot());
		electron.clipboard.writeText(taskSnapshotText(snapshot));
	});
	handle(TASK_MANAGER_CHANNELS.close, () => {
		window?.close();
	});
}
