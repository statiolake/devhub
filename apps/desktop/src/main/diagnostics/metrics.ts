/**
 * One reading of what DevHub is costing, as JSON.
 *
 * Electron knows the CPU and memory of every process in the app but calls a
 * workbench renderer nothing more than "renderer"; DevHub knows which
 * workspace each renderer is and whether the person is looking at it, but
 * knows nothing about CPU. Neither half answers "is the workbench I cannot see
 * still burning a core" — joining them is the whole point of this file, and
 * the join is a pure function so it can be tested without an app.
 */

import type { CountersReading } from "./counters.js";
import type { RuntimeId, RuntimeReading } from "../runtime/runtime.js";

/** What DevHub knows about one of its own workbench renderers. */
export interface ViewIdentity {
	/** The OS process the renderer runs in. This is what joins it to a metric. */
	readonly pid: number;
	/** The `webContents` id, which is how the rest of DevHub names a view. */
	readonly id: number;
	/**
	 * The workspace the view is showing, or `undefined` for one the model has
	 * no surface for — a view being torn down, or one not yet adopted.
	 */
	readonly surfaceKey: string | undefined;
	/** Whether this is the workbench on screen. At most one view is. */
	readonly onScreen: boolean;
}

/** The subset of `Electron.ProcessMetric` a reading needs. */
export interface ProcessMetricInput {
	readonly pid: number;
	readonly type: string;
	readonly name?: string;
	readonly cpu: { readonly percentCPUUsage: number };
	readonly memory: { readonly workingSetSize: number };
}

export interface ProcessReading {
	readonly pid: number;
	readonly type: string;
	readonly name: string | undefined;
	readonly cpuPercent: number;
	readonly memoryKb: number;
	/** Present only for a process DevHub recognises as one of its workbenches. */
	readonly workbench: ViewIdentity | undefined;
}

/** The main process's own CPU time, as the OS has charged it. */
export interface CpuTime {
	readonly userMs: number;
	readonly systemMs: number;
}

export interface MetricsReport {
	readonly takenAt: string;
	/** How long the app has been running, in milliseconds. */
	readonly uptimeMs: number;
	/**
	 * What the OS has charged the main process since it started.
	 *
	 * Electron's own per-process CPU is here too, but it does not see all of
	 * this. Starting a child process is mostly *system* time, and DevHub starts
	 * hundreds of tmux clients a minute: measured against `getAppMetrics`, the
	 * main process looked like it was using a third of a percent while the OS
	 * was charging it two and a half. The counters say how many spawns there
	 * were; this says what they cost.
	 */
	readonly mainProcessCpu: CpuTime;
	/** Every process in the app, heaviest first. */
	readonly processes: readonly ProcessReading[];
	/** Every process's CPU added up, which is what a fan responds to. */
	readonly totalCpuPercent: number;
	readonly counters: CountersReading;
	/**
	 * The tmux clients attached to DevHub's socket.
	 *
	 * One per terminal on screen, and never more. A client is a terminal
	 * somebody is looking at; one that outlived the terminal that showed it is
	 * invisible in every other reading DevHub takes — it owns no window, and
	 * the session it holds looks the same with or without it — so this is where
	 * that leak becomes a number. Compare it with the terminals that are open:
	 * a count that climbs across window reloads is clients being left behind.
	 */
	readonly terminalClients: readonly TerminalClientReading[];
	/**
	 * The machines DevHub is running things on, one entry each.
	 *
	 * There is one today and it is this Mac, which is why it reads as no
	 * latency and no failures. It is a list from the start because the whole
	 * point of the runtime seam is that there will be more of them, and a
	 * remote machine's cost is invisible in every other number here: its
	 * processes are not in `getAppMetrics`, its round trips are not in any
	 * counter, and "why is this slow" would otherwise need a packet capture.
	 */
	readonly runtimes: readonly RuntimeCostReading[];
}

/**
 * One machine's reading, with what a round of it costs worked out.
 *
 * The runtime knows how many commands it ran and how fast they came back; the
 * reconciler knows how many rounds it ran. Neither half answers "why is this
 * slow" on its own — a hundred execs a minute is a different fact at two
 * rounds a minute than at two hundred — so the division happens here, once,
 * rather than in the head of whoever is reading the JSON.
 */
export interface RuntimeCostReading extends RuntimeReading {
	/** Reconcile rounds this machine completed in the last minute. */
	readonly roundsPerMin: number;
	/**
	 * Commands per round, which is the number the batching is about.
	 *
	 * One means a round is one invocation. It was the Agent count plus one, and
	 * over a network it is the number of round trips a person waits for. Zero
	 * rounds in the last minute means no Agents on this machine, and the cost
	 * of a round nobody ran is reported as zero rather than as infinity.
	 */
	readonly execPerRound: number;
}

/** One attached tmux client, as a reading names it. */
export interface TerminalClientReading {
	readonly tty: string;
	readonly session: string;
}

export interface MetricsInput {
	readonly takenAt: number;
	readonly uptimeMs: number;
	readonly mainProcessCpu: CpuTime;
	readonly processMetrics: readonly ProcessMetricInput[];
	readonly views: readonly ViewIdentity[];
	readonly counters: CountersReading;
	readonly terminalClients: readonly TerminalClientReading[];
	readonly runtimes: readonly RuntimeReading[];
	/** Reconcile rounds in the last minute, by machine. See `rounds.ts`. */
	readonly roundsLastMinute: (id: RuntimeId) => number;
}

/**
 * Join Electron's per-process numbers to DevHub's names for them.
 *
 * Sorted heaviest first, because the question a reading is taken to answer is
 * always "what is at the top", and a reader who has to sort it themselves is a
 * reader who will compare the wrong two lines.
 */
export function metricsReport(input: MetricsInput): MetricsReport {
	// Several views can share one renderer process, and which of them a metric
	// is named after would then depend on iteration order. The one on screen
	// wins: it is the one whose cost anybody is asking about.
	const byPid = new Map<number, ViewIdentity>();
	for (const view of input.views) {
		const existing = byPid.get(view.pid);
		if (existing === undefined || (view.onScreen && !existing.onScreen)) {
			byPid.set(view.pid, view);
		}
	}
	const processes = input.processMetrics
		.map((metric) => ({
			pid: metric.pid,
			type: metric.type,
			name: metric.name,
			cpuPercent: metric.cpu.percentCPUUsage,
			memoryKb: metric.memory.workingSetSize,
			workbench: byPid.get(metric.pid),
		}))
		.sort((left, right) => right.cpuPercent - left.cpuPercent);
	return {
		takenAt: new Date(input.takenAt).toISOString(),
		uptimeMs: input.uptimeMs,
		mainProcessCpu: input.mainProcessCpu,
		processes,
		totalCpuPercent: processes.reduce(
			(sum, process) => sum + process.cpuPercent,
			0,
		),
		counters: input.counters,
		terminalClients: input.terminalClients,
		runtimes: input.runtimes.map((runtime) => {
			const roundsPerMin = input.roundsLastMinute(runtime.id);
			return {
				...runtime,
				roundsPerMin,
				execPerRound:
					roundsPerMin === 0 ? 0 : runtime.execsLastMinute / roundsPerMin,
			};
		}),
	};
}
