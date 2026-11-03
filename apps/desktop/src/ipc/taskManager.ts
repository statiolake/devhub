/**
 * The Task Manager window's contract with the main process.
 *
 * The page asks for a snapshot while it is visible, about every two seconds,
 * and draws it; everything it can do to what it shows is one request here,
 * carried out by main through the same path the rest of DevHub uses (Sleep is
 * the workbench lifecycle's hibernation, Stop is an Agent's stop). See
 * `docs/task-manager.md`.
 */

/** How hard the OS says memory is pressed; `unknown` where it cannot say. */
export type MemoryPressureWire = "normal" | "warning" | "critical" | "unknown";

export const TASK_MANAGER_CHANNELS = {
	snapshot: "devhub-task-manager:snapshot",
	sleepWorkbench: "devhub-task-manager:sleep-workbench",
	stopAgent: "devhub-task-manager:stop-agent",
	reveal: "devhub-task-manager:reveal",
	kill: "devhub-task-manager:kill",
	copy: "devhub-task-manager:copy",
	close: "devhub-task-manager:close",
} as const;

/** Where a Workspace's workbench is in its life, in the words a row shows. */
export type WorkbenchStateWire =
	| "awake"
	| "starting"
	| "going to sleep"
	| "sleeping"
	| "not started"
	| "restarting"
	| "failed";

export type TaskRowKind =
	| "workspace"
	| "workbench"
	| "agent"
	| "group"
	| "process"
	| "devhub"
	| "tmux"
	| "other";

/** What a row offers. Main decides; the page only draws what it is given. */
export type TaskActionWire = "sleep" | "stop" | "reveal" | "kill";

export interface TaskRowWire {
	/** Stable across refreshes, so a collapsed row stays collapsed. */
	readonly id: string;
	readonly kind: TaskRowKind;
	readonly label: string;
	/** What the row is, said more exactly: a session, a command line. */
	readonly detail?: string;
	/** A process row's own pid. */
	readonly pid?: number;
	/** Resident memory of the row and everything under it. */
	readonly memoryBytes: number;
	readonly cpuPercent: number;
	readonly processCount: number;
	/** A workbench row's state. */
	readonly state?: WorkbenchStateWire;
	readonly actions: readonly TaskActionWire[];
	readonly workspaceId?: string;
	readonly agentId?: string;
	readonly children: readonly TaskRowWire[];
}

export interface SystemMemoryWire {
	readonly totalBytes: number;
	readonly usedBytes: number;
	readonly swapUsedBytes: number;
	readonly swapTotalBytes: number;
	readonly pressure: MemoryPressureWire;
	readonly pressureSource: string;
}

export interface TaskSnapshotWire {
	readonly takenAt: number;
	readonly system: SystemMemoryWire;
	/** Every row added up: what DevHub costs this machine. */
	readonly total: {
		readonly memoryBytes: number;
		readonly cpuPercent: number;
		readonly processCount: number;
	};
	readonly rows: readonly TaskRowWire[];
}

/** What Reveal goes to. */
export type TaskRevealWire =
	| { readonly kind: "workspace"; readonly workspaceId: string }
	| { readonly kind: "agent"; readonly agentId: string };

/** `window.devhubTaskManager`, as the preload builds it. */
export interface TaskManagerApi {
	snapshot(): Promise<TaskSnapshotWire>;
	sleepWorkbench(workspaceId: string): Promise<void>;
	stopAgent(agentId: string): Promise<void>;
	reveal(target: TaskRevealWire): Promise<void>;
	/** Asks first, natively; `false` when the person said no. */
	kill(pid: number): Promise<boolean>;
	/** The table as text, on the clipboard. */
	copy(): Promise<void>;
	close(): Promise<void>;
}

/**
 * Bytes as the Task Manager writes them: MB below a gigabyte, GB from there,
 * with a fixed number of decimals so a column of them lines up.
 */
export function formatBytes(bytes: number): string {
	const mb = bytes / 1024 ** 2;
	if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
	return `${(mb / 1024).toFixed(mb < 10 * 1024 ? 2 : 1)} GB`;
}
