/**
 * The Task Manager window's contract with the main process.
 *
 * The page asks for a snapshot while it is visible, about every two seconds,
 * and draws it; everything it can do to what it shows is one request here,
 * carried out by main through the same path the rest of DevHub uses (Stop is
 * an Agent's stop). See
 * `docs/task-manager.md`.
 */

/** How hard the OS says memory is pressed; `unknown` where it cannot say. */
export type MemoryPressureWire = "normal" | "warning" | "critical" | "unknown";

export const TASK_MANAGER_CHANNELS = {
	snapshot: "devhub-task-manager:snapshot",
	stopAgent: "devhub-task-manager:stop-agent",
	reveal: "devhub-task-manager:reveal",
	kill: "devhub-task-manager:kill",
	copy: "devhub-task-manager:copy",
	close: "devhub-task-manager:close",
} as const;

export type TaskRowKind =
	| "workspace"
	| "agent"
	| "group"
	| "process"
	| "devhub"
	| "tmux"
	| "other";

/** What a row offers. Main decides; the page only draws what it is given. */
export type TaskActionWire = "stop" | "reveal" | "kill";

export interface TaskRowWire {
	/** Stable across refreshes, so a collapsed row stays collapsed. */
	readonly id: string;
	readonly kind: TaskRowKind;
	readonly label: string;
	/** What the row is, said more exactly: a session, a command line. */
	readonly detail?: string;
	/** A process row's own pid. */
	readonly pid?: number;
	/**
	 * The footprint of the row and everything under it: what it costs
	 * wherever its pages are, compressed and swapped out included.
	 */
	readonly memoryBytes: number;
	/** What of `memoryBytes` is in RAM now. */
	readonly residentBytes: number;
	readonly cpuPercent: number;
	readonly processCount: number;
	readonly actions: readonly TaskActionWire[];
	readonly workspaceId?: string;
	readonly agentId?: string;
	readonly children: readonly TaskRowWire[];
}

/**
 * Where the machine's memory is, the way Activity Monitor breaks it down.
 * The five parts add up to the total. See `docs/task-manager.md`.
 */
export interface MemoryBreakdownWire {
	/** Processes' own (anonymous) memory, purgeable excluded. */
	readonly appBytes: number;
	/** Wired down: the kernel's, never compressed or paged. */
	readonly wiredBytes: number;
	/** RAM the compressor occupies. */
	readonly compressedBytes: number;
	/** What the compressor holds, uncompressed: what `compressedBytes` stores. */
	readonly compressorStoredBytes: number;
	/** File-backed and purgeable: given back as soon as something needs it. */
	readonly cachedBytes: number;
	/** Not used for anything. */
	readonly freeBytes: number;
}

export interface SystemMemoryWire {
	readonly totalBytes: number;
	/** App, wired and compressed: Activity Monitor's "Memory Used". */
	readonly usedBytes: number;
	readonly breakdown: MemoryBreakdownWire;
	readonly swapUsedBytes: number;
	readonly swapTotalBytes: number;
	readonly pressure: MemoryPressureWire;
	readonly pressureSource: string;
}

/**
 * Where a row's two memory figures come from: macOS's physical footprint
 * (`devhub-footprint`) with the resident set as in RAM; Linux's `VmRSS +
 * VmSwap` with `VmRSS`; or, where neither could be read, `ps`'s resident set
 * for both.
 */
export type MemoryMetricWire = "footprint" | "rss-swap" | "rss";

export interface TaskSnapshotWire {
	readonly takenAt: number;
	readonly memoryMetric: MemoryMetricWire;
	readonly system: SystemMemoryWire;
	/** Every row added up: what DevHub costs this machine. */
	readonly total: {
		readonly memoryBytes: number;
		readonly residentBytes: number;
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
