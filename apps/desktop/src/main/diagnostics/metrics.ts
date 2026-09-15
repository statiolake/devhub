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
import type { TitleBarMode } from "../../model/config.js";
import type { RuntimeId, RuntimeReading } from "../runtime/runtime.js";
import type { NoticesReading } from "./notices.js";
import type { WorkspaceRepositoryRound } from "./rounds.js";

/**
 * What DevHub knows about one of its own renderers.
 *
 * Both kinds: a workbench, and one of DevHub's own chrome pages. It used to be
 * workbenches only, which was the right shape while the window held one page
 * and N workbenches — a reading then named everything it could. The window is
 * becoming a tree of child views, one per region, so a reading that could not
 * name them would answer "did splitting the pages cost anything" with a list
 * of anonymous renderers.
 */
export interface ViewIdentity {
	/** The OS process the renderer runs in. This is what joins it to a metric. */
	readonly pid: number;
	/** The `webContents` id, which is how the rest of DevHub names a view. */
	readonly id: number;
	/**
	 * What this view is showing: a workspace's surface key for a workbench, or
	 * `chrome:<name>` for one of DevHub's own pages. `undefined` is a workbench
	 * the model has no surface for — one being torn down, or one not yet
	 * adopted.
	 */
	readonly surfaceKey: string | undefined;
	/**
	 * Whether this view is on screen.
	 *
	 * For a workbench that is "the one the person is looking at", and at most
	 * one is. For a chrome child it is "in the window's child list" — which for
	 * `toasts` and `picker` is a fact that follows what they have to draw, and
	 * is the one thing worth reading back about them: a layer that is present
	 * with nothing on it is a rectangle taking clicks for no reason.
	 */
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
	 * Which chrome the window was built with — `appearance.title_bar`, as the
	 * window actually took it rather than as the file says it now. `shown` is
	 * the bar DevHub draws itself; `hidden` is no bar, with the traffic lights
	 * on the Sidebar.
	 *
	 * It is here because it changes the geometry of everything else DevHub
	 * draws, and it only changes at launch: a reading that does not name it is
	 * a reading nobody can compare with another taken in the other mode.
	 */
	readonly titleBar: TitleBarMode;
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
	/**
	 * Every renderer DevHub owns, named, whether or not it has a process to
	 * itself.
	 *
	 * `processes` can carry only one name per pid, because that is what a
	 * process metric is — several views share one renderer, and there the one
	 * on screen wins. That rule is right for "what is costing the most" and
	 * wrong for "what exists": two chrome children in one process would leave
	 * one of them unnamed. So the list is reported as well as joined.
	 */
	readonly views: readonly ViewIdentity[];
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
	/**
	 * Whether each machine has a DevHub terminal launcher on it, and where.
	 *
	 * A machine whose launcher could not be installed still gets its windows —
	 * a folder somebody can edit is worth more than no folder — so the only
	 * places that failure showed were one line in a log and one sentence in a
	 * terminal tab, per window. "This DevHub has no terminals, and here is the
	 * sentence saying why" is a fact about DevHub, and this is where facts
	 * about DevHub are read.
	 *
	 * One entry per machine a window has been opened on; a machine nothing has
	 * asked for is simply absent, which is a different answer from failed.
	 */
	readonly terminalLauncher: readonly TerminalLauncherStatus[];
	/**
	 * Machines DevHub still owes a session sweep.
	 *
	 * A machine that did not answer when its stray sessions were to be closed
	 * stays here until one does — DevHub asks it again the moment a runtime for
	 * it connects. Empty is the normal reading. A name that stays in it across
	 * readings is a host DevHub cannot reach with sessions of its own still
	 * running over there, which is otherwise a fact with nowhere to be seen.
	 */
	readonly pendingSweeps: readonly RuntimeId[];
	/**
	 * When each open Workspace's git, pull request and Issue were last read, and
	 * what made that happen.
	 *
	 * "The sidebar feels slow" is not an answerable complaint without this. Four
	 * things can refresh a row — the poll, a write under `.git`, the window
	 * coming to the front, and the refresh chord — and they have wildly
	 * different latencies, so which of them last fired *is* the diagnosis. A
	 * `trigger` that is always `poll` on a machine somebody has been switching
	 * branches on is a `HEAD` watch that is not firing; a `focus` stamp minutes
	 * old on a window in front of you is the focus trigger not arriving.
	 *
	 * A Workspace no round has finished for yet is simply absent.
	 */
	readonly repositoryRounds: readonly WorkspaceRepositoryRound[];
	/**
	 * What the application has been saying for itself, and how often.
	 *
	 * A notice is the one thing DevHub does that a person can watch happen and
	 * still not report: it appears and is gone before it can be read, and every
	 * other reading here would look perfectly healthy while it did. So the
	 * counts are per code — a code with far more raises than retractions in a
	 * minute is a source re-raising into an occupied slot — and `flickering`
	 * names the identities that went up faster than a second could hold them.
	 * An empty `flickering` is the normal reading; a name in it is a bug with a
	 * stack waiting in the main log. See `notices.ts`.
	 */
	readonly notices: NoticesReading;
}

/** One machine's answer to "is there a `devhub-terminal` on it". */
export interface TerminalLauncherStatus {
	readonly machine: RuntimeId;
	readonly installed: boolean;
	/** Where it is, when it is. */
	readonly path: string | undefined;
	/**
	 * Why it is not there, or — with `installed` — why it cannot reach DevHub's
	 * control socket, which is a launcher that will run and then say so.
	 */
	readonly reason: string | undefined;
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
	readonly titleBar: TitleBarMode;
	readonly mainProcessCpu: CpuTime;
	readonly processMetrics: readonly ProcessMetricInput[];
	readonly views: readonly ViewIdentity[];
	readonly counters: CountersReading;
	readonly terminalClients: readonly TerminalClientReading[];
	readonly runtimes: readonly RuntimeReading[];
	readonly terminalLauncher: readonly TerminalLauncherStatus[];
	readonly pendingSweeps: readonly RuntimeId[];
	readonly repositoryRounds: readonly WorkspaceRepositoryRound[];
	readonly notices: NoticesReading;
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
		titleBar: input.titleBar,
		mainProcessCpu: input.mainProcessCpu,
		processes,
		views: input.views,
		totalCpuPercent: processes.reduce(
			(sum, process) => sum + process.cpuPercent,
			0,
		),
		counters: input.counters,
		terminalClients: input.terminalClients,
		terminalLauncher: input.terminalLauncher,
		pendingSweeps: input.pendingSweeps,
		repositoryRounds: input.repositoryRounds,
		notices: input.notices,
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
