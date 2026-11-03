/**
 * The processes behind each workbench, acted on: frozen (SIGSTOP), thawed
 * (SIGCONT), and watched for the two things the planner needs from outside
 * VS Code — a connection waiting on a frozen workbench's listening socket,
 * and traffic on a running one's sockets.
 *
 * Which processes are a workbench's is `freezeTargets`; how the sockets are
 * read is `listenQueues.ts` and `socketTraffic.ts`. This file runs them.
 *
 * **Freezing** stops the renderer and the window's utility processes at once,
 * from what main already knows (no process listing in the way of the
 * decision), and then, once one `ps` has answered, everything under them. A
 * thaw meanwhile wins: the second half stops nothing for a workbench no
 * longer frozen. The listening sockets of every stopped pid are read last and
 * kept: a stopped process opens none, so they hold until the thaw.
 *
 * **Thawing** continues them in the reverse order — the language servers and
 * extension hosts first, the renderer last — so the renderer resumes to an
 * extension host that already answers. It is synchronous: a thaw is never
 * waiting on anything.
 *
 * **Watching** is two polls, each one reading per tick for every workbench at
 * once, each running only while it has something to watch
 * (`WorkbenchSensors`): listen queues every `CONNECTION_POLL_MS` while
 * anything is frozen, traffic every `TRAFFIC_SAMPLE_MS` while a local
 * workbench runs.
 */

import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { freezeTargets } from "../diagnostics/freezeTargets.js";
import {
	NETSTAT_LISTEN_ARGUMENTS,
	lsofListenArguments,
	parseLsofListening,
	parseNetstatListenQueues,
	parseProcNetTcp,
	pidsWithWaitingConnections,
	socketInodes,
	type ListenQueue,
	type ListeningSocket,
} from "../diagnostics/listenQueues.js";
import {
	PS_ARGUMENTS,
	parseProcessTable,
	type ProcessRow,
} from "../diagnostics/processTable.js";
import {
	NETTOP_ARGUMENTS,
	SS_TRAFFIC_ARGUMENTS,
	parseNettop,
	parseSsTraffic,
	trafficSince,
} from "../diagnostics/socketTraffic.js";

/** A frozen workbench's listen queues are read this often. */
export const CONNECTION_POLL_MS = 500;
/** A running workbench's socket traffic is sampled this often. */
export const TRAFFIC_SAMPLE_MS = 10_000;

/** The processes main knows to be one workbench's. */
export interface WorkbenchPids {
	readonly renderer: number | undefined;
	/** Its window's utility processes: extension hosts, the file watcher. */
	readonly windowUtilities: readonly number[];
}

/** The window utilities of one window, from `UtilityProcess.getAll()`. */
export function windowUtilitiesOf(
	utilities: readonly { readonly pid: number; readonly name: string }[],
	windowId: number,
): number[] {
	const suffix = ` [${String(windowId)}]`;
	return utilities
		.filter((utility) => utility.name.endsWith(suffix))
		.map((utility) => utility.pid);
}

export interface ProcessDeps {
	readonly platform: NodeJS.Platform;
	/** One `ps` reading of every process. */
	processes(): Promise<readonly ProcessRow[]>;
	/** Every Electron process's pid now. */
	electronPids(): readonly number[];
	run(file: string, args: readonly string[]): Promise<string>;
	readText(path: string): Promise<string | undefined>;
	/** What `/proc/<pid>/fd/*` point at (Linux). */
	fdLinks(pid: number): Promise<readonly string[]>;
	kill(pid: number, signal: "SIGSTOP" | "SIGCONT"): void;
	log(line: string): void;
}

const run = promisify(execFile);

/** `ProcessDeps` on this machine: ps, the commands, /proc, real signals. */
export function systemProcessDeps(
	electronPids: () => readonly number[],
): ProcessDeps {
	const output = async (file: string, args: readonly string[]) =>
		(await run(file, [...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
	return {
		platform: process.platform,
		processes: async () => parseProcessTable(await output("ps", PS_ARGUMENTS)),
		electronPids,
		run: output,
		readText: (path) => readFile(path, "utf8").catch(() => undefined),
		fdLinks: async (pid) => {
			const directory = `/proc/${String(pid)}/fd`;
			const names = await readdir(directory);
			return Promise.all(
				names.map((name) => readlink(`${directory}/${name}`).catch(() => "")),
			);
		},
		kill: (pid, signal) => {
			process.kill(pid, signal);
		},
		log: (line) => {
			console.log(line);
		},
	};
}

interface Frozen {
	/** In stopping order. */
	readonly pids: number[];
	sockets: readonly ListeningSocket[];
}

export class WorkbenchFreezer {
	private readonly frozen = new Map<string, Frozen>();

	constructor(private readonly deps: ProcessDeps) {}

	isFrozen(folder: string): boolean {
		return this.frozen.has(folder);
	}

	frozenFolders(): string[] {
		return [...this.frozen.keys()];
	}

	/** The pids stopped for this folder, in stopping order. */
	pidsOf(folder: string): readonly number[] {
		return this.frozen.get(folder)?.pids ?? [];
	}

	/**
	 * Stop the workbench's known processes now, and the rest of its tree when
	 * `ps` has answered. Throws, having stopped nothing, when there is nothing
	 * of it to stop.
	 */
	freeze(folder: string, known: WorkbenchPids): Promise<void> {
		const first = [
			...(known.renderer === undefined ? [] : [known.renderer]),
			...known.windowUtilities,
		];
		if (first.length === 0) {
			throw new Error("it has no processes to stop");
		}
		const record: Frozen = { pids: [], sockets: [] };
		this.frozen.set(folder, record);
		this.stop(record, first);
		return this.freezeTree(folder, record, known);
	}

	private async freezeTree(
		folder: string,
		record: Frozen,
		known: WorkbenchPids,
	): Promise<void> {
		const processes = await this.deps.processes();
		const rest = freezeTargets({
			processes,
			renderer: known.renderer,
			windowUtilities: known.windowUtilities,
			electron: this.deps.electronPids(),
		}).filter((pid) => !record.pids.includes(pid));
		// Thawed while ps ran: what is under it keeps running.
		if (this.frozen.get(folder) !== record) return;
		this.stop(record, rest);
		const sockets = await this.listening(record.pids).catch(
			(error: unknown) => {
				this.deps.log(
					`[devhub] workbench '${folder}' listening sockets unread: ${String(error)}`,
				);
				return [];
			},
		);
		if (this.frozen.get(folder) === record) record.sockets = sockets;
	}

	private stop(record: Frozen, pids: readonly number[]): void {
		for (const pid of pids) {
			try {
				this.deps.kill(pid, "SIGSTOP");
				record.pids.push(pid);
			} catch {
				// Gone already: nothing of it to stop.
			}
		}
	}

	/** Continue every frozen workbench: DevHub is going, and they must be able to end. */
	thawAll(): void {
		for (const folder of this.frozenFolders()) this.thaw(folder);
	}

	/** Continue them, children and extension hosts first, the renderer last. */
	thaw(folder: string): void {
		const record = this.frozen.get(folder);
		if (record === undefined) return;
		this.frozen.delete(folder);
		for (const pid of [...record.pids].reverse()) {
			try {
				this.deps.kill(pid, "SIGCONT");
			} catch {
				// Gone while it was stopped: nothing to continue.
			}
		}
	}

	private async listening(pids: readonly number[]): Promise<ListeningSocket[]> {
		if (pids.length === 0) return [];
		if (this.deps.platform === "darwin") {
			// lsof exits 1 when none of them listens on anything.
			const out = await this.deps
				.run("lsof", lsofListenArguments(pids))
				.catch(() => "");
			return parseLsofListening(out);
		}
		const sockets: ListeningSocket[] = [];
		for (const pid of pids) {
			const links = await this.deps.fdLinks(pid).catch(() => []);
			for (const key of socketInodes(links)) sockets.push({ pid, key });
		}
		return sockets;
	}

	private async queues(): Promise<ListenQueue[]> {
		if (this.deps.platform === "darwin") {
			return parseNetstatListenQueues(
				await this.deps.run("netstat", NETSTAT_LISTEN_ARGUMENTS),
			);
		}
		const texts = await Promise.all(
			["/proc/net/tcp", "/proc/net/tcp6"].map((path) =>
				this.deps.readText(path),
			),
		);
		return texts.flatMap((text) =>
			text === undefined ? [] : parseProcNetTcp(text),
		);
	}

	/** The frozen folders somebody is waiting to connect to, from one reading. */
	async waiting(): Promise<string[]> {
		const watched = [...this.frozen].filter(
			([, one]) => one.sockets.length > 0,
		);
		if (watched.length === 0) return [];
		const queues = await this.queues();
		return watched.flatMap(([folder, one]) =>
			// Thawed while the queues were read: nothing to say about it.
			this.frozen.get(folder) === one &&
			pidsWithWaitingConnections(one.sockets, queues).size > 0
				? [folder]
				: [],
		);
	}
}

/** Traffic on running workbenches' sockets, one reading for all of them. */
export class SocketTrafficSampler {
	/** macOS: the last nettop totals, to compare the next with. */
	private previous: ReadonlyMap<number, number> | undefined;

	constructor(private readonly deps: ProcessDeps) {}

	/** The folders whose processes' sockets carried traffic since the last sample. */
	async sample(
		workbenches: readonly {
			readonly folder: string;
			readonly pids: WorkbenchPids;
		}[],
	): Promise<string[]> {
		if (workbenches.length === 0) {
			this.previous = undefined;
			return [];
		}
		const processes = await this.deps.processes();
		const electron = this.deps.electronPids();
		const trees = workbenches.map(({ folder, pids }) => ({
			folder,
			pids: new Set(
				freezeTargets({
					processes,
					renderer: pids.renderer,
					windowUtilities: pids.windowUtilities,
					electron,
				}),
			),
		}));
		const talking = await this.talkingPids();
		return trees
			.filter(({ pids }) => [...pids].some((pid) => talking.has(pid)))
			.map(({ folder }) => folder);
	}

	private async talkingPids(): Promise<Set<number>> {
		if (this.deps.platform === "darwin") {
			const totals = parseNettop(
				await this.deps.run("nettop", NETTOP_ARGUMENTS),
			);
			const previous = this.previous;
			this.previous = totals;
			return previous === undefined
				? new Set()
				: trafficSince(previous, totals);
		}
		const quiet = parseSsTraffic(
			await this.deps.run("ss", SS_TRAFFIC_ARGUMENTS),
		);
		return new Set(
			[...quiet].filter(([, ms]) => ms < TRAFFIC_SAMPLE_MS).map(([pid]) => pid),
		);
	}
}

/**
 * The two polls, each on only while it has something to watch, one reading
 * in flight at a time. `update` is called after every plan.
 */
export class WorkbenchSensors {
	private connectionTimer: ReturnType<typeof setTimeout> | undefined;
	private trafficTimer: ReturnType<typeof setTimeout> | undefined;
	/** A failure said once per reason, not every tick. */
	private lastFailure = "";

	constructor(
		private readonly freezer: WorkbenchFreezer,
		private readonly sampler: SocketTrafficSampler,
		private readonly sources: {
			/** The local workbenches running now (not frozen), with their pids. */
			running(): readonly {
				readonly folder: string;
				readonly pids: WorkbenchPids;
			}[];
			connectionArrived(folder: string): void;
			traffic(folders: readonly string[], at: number): void;
			log(line: string): void;
		},
	) {}

	update(): void {
		if (this.freezer.frozenFolders().length > 0) {
			this.connectionTimer ??= this.schedule(CONNECTION_POLL_MS, () =>
				this.pollConnections(),
			);
		}
		if (this.sources.running().length > 0) {
			this.trafficTimer ??= this.schedule(TRAFFIC_SAMPLE_MS, () =>
				this.sampleTraffic(),
			);
		}
	}

	dispose(): void {
		if (this.connectionTimer) clearTimeout(this.connectionTimer);
		if (this.trafficTimer) clearTimeout(this.trafficTimer);
		this.connectionTimer = undefined;
		this.trafficTimer = undefined;
	}

	private schedule(
		ms: number,
		run: () => Promise<void>,
	): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			void run();
		}, ms);
		(timer as unknown as { unref?: () => void }).unref?.();
		return timer;
	}

	private async pollConnections(): Promise<void> {
		try {
			for (const folder of await this.freezer.waiting()) {
				this.sources.connectionArrived(folder);
			}
		} catch (error: unknown) {
			this.said(`listen queues unread: ${String(error)}`);
		}
		this.connectionTimer = undefined;
		this.update();
	}

	private async sampleTraffic(): Promise<void> {
		try {
			const folders = await this.sampler.sample(this.sources.running());
			if (folders.length > 0) this.sources.traffic(folders, Date.now());
		} catch (error: unknown) {
			this.said(`socket traffic unread: ${String(error)}`);
		}
		this.trafficTimer = undefined;
		this.update();
	}

	private said(line: string): void {
		if (line === this.lastFailure) return;
		this.lastFailure = line;
		this.sources.log(`[devhub] workbenches: ${line}`);
	}
}
