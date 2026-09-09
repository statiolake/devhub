/**
 * What DevHub did, counted where it happens.
 *
 * The complaint this exists for is "DevHub is warmer than the editors it
 * replaces", and a complaint about heat is a question about rates: how many
 * processes a minute does an idle DevHub start, how many rounds does a loop
 * run, how often is a repository asked about itself. None of that is visible
 * from the outside — the processes DevHub starts live for milliseconds, so a
 * `ps` that samples at thirty hertz sees none of them and reports an app that
 * is doing nothing while it forks ten times a second.
 *
 * So the counting happens at the choke points themselves: one `record` where a
 * child process is spawned, one where a loop completes a round. A counter that
 * lived anywhere else would be a second answer to "did this happen", free to
 * disagree with the first.
 *
 * Reading is deliberately non-destructive. Two readings and the elapsed time
 * between them is a rate, and any number of readers can take one without
 * taking it away from another — a `read` that reset the counters would make
 * the answer depend on who asked last.
 */

/** One counter, as of a reading. */
export interface CounterReading {
	readonly name: string;
	/** How many times it happened since the process started. */
	readonly total: number;
	/** That total spread over the process's life, for a first look. */
	readonly perMinuteSinceStart: number;
}

export interface CountersReading {
	/** How long the counters have been counting. */
	readonly elapsedMs: number;
	/** Every counter that has fired at least once, by name. */
	readonly counters: readonly CounterReading[];
}

/**
 * The names, spelled once.
 *
 * A counter named at its call site is a counter that is one typo away from
 * being a second counter nobody adds up, so every name DevHub records lives
 * here and is imported.
 */
export const COUNTER = {
	/** A child process DevHub started, by program: `process.tmux`, `.git`, `.gh`. */
	process: (program: string): string => `process.${program}`,
	/** One completed round of the Agent reconciler. */
	agentReconcileRound: "agent.reconcile.round",
	/** One `capture-pane` of one Agent's screen. */
	agentScreenCapture: "agent.screen.capture",
	/** One `list-sessions` on the Agent socket. */
	tmuxListSessions: "tmux.list-sessions",
	/** One slow round of the repository watcher: git status and GitHub. */
	repositoryStatusRound: "repository.status.round",
	/** One fast round of the repository watcher: which branch is checked out. */
	repositoryBranchRound: "repository.branch.round",
	/** One checkout whose git directory DevHub is watching for a checkout. */
	repositoryHeadWatch: "repository.head.watch",
	/**
	 * One checkout DevHub could not watch, and is therefore only polling.
	 *
	 * Here because "the branch is a minute stale on this row and nowhere else"
	 * is otherwise indistinguishable from DevHub working: the fallback is meant
	 * to be safe, not invisible.
	 */
	repositoryHeadWatchFailed: "repository.head.watch.failed",
} as const;

export class ActivityCounters {
	readonly #totals = new Map<string, number>();
	readonly #clock: () => number;
	#startedAt: number;

	constructor(clock: () => number = Date.now) {
		this.#clock = clock;
		this.#startedAt = clock();
	}

	record(name: string): void {
		this.#totals.set(name, (this.#totals.get(name) ?? 0) + 1);
	}

	read(): CountersReading {
		// A clock that has not moved yet is a real state — a reading taken in
		// the same millisecond the process started — and a rate over zero time
		// is not a number. It is reported as zero rather than as infinity,
		// because the only honest thing to say about a rate nobody has had time
		// to observe is that it has not been observed.
		const elapsedMs = Math.max(0, this.#clock() - this.#startedAt);
		const minutes = elapsedMs / 60_000;
		const counters = [...this.#totals]
			.map(([name, total]) => ({
				name,
				total,
				perMinuteSinceStart: minutes === 0 ? 0 : total / minutes,
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
		return { elapsedMs, counters };
	}
}

/**
 * The process's one registry.
 *
 * A module-level value rather than something passed down: the choke points
 * that record are `spawn` call sites three layers below anything that could
 * hand them a dependency, and threading one through them would be a parameter
 * on every intermediate signature that exists only to be forwarded. Tests
 * construct their own `ActivityCounters` and never touch this one.
 */
export const activityCounters = new ActivityCounters();
