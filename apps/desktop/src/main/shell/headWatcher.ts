/**
 * Noticing a checkout instead of asking about one.
 *
 * Which branch is checked out changes while somebody watches — they run
 * `git switch` and look at the Sidebar — so DevHub used to re-read it every two
 * seconds. That is thirty-eight `git` processes a minute per workspace, four
 * workspaces' worth of forking to learn thirty-eight times that nothing moved.
 * A checkout is an event, and the filesystem already has it: git writes `HEAD`.
 *
 * So the fast clock is gone and a watcher is in its place, with a slow safety
 * poll behind it. The poll is what makes the watcher safe to be wrong about:
 * an event that never arrives costs a minute of staleness, not a branch name
 * that is wrong forever, and a watcher that could not be armed at all says so
 * rather than quietly becoming a poll nobody knows they are running.
 *
 * What is watched is the git directory and its `refs/`, not the working tree.
 * `HEAD` and `packed-refs` are direct children of the git directory, `refs/`
 * holds the loose ones, and none of them move when somebody merely edits a
 * file — which is the whole point, because a watcher on the working tree of a
 * repository being built would fire thousands of times for a branch that never
 * changed. Which directory that is, and how it is watched, belong to the
 * checkout's `Runtime` — locally two `fs.watch`es, across a network a poll —
 * because there is no honest local imitation of the remote answer. Everything
 * in this file is above that line: the debounce, the re-arm rule and the
 * record of what could not be watched read the same either way.
 */

import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import type { Runtime, Watcher } from "../runtime/runtime.js";

/**
 * How long after the last filesystem event the branch is read.
 *
 * A single checkout is a handful of writes in a few milliseconds, and reading
 * once at the end of them is one `git` instead of five. Short enough that
 * nobody watching the Sidebar sees it arrive late.
 */
export const HEAD_DEBOUNCE_MS = 250;

/**
 * The longest a burst of events may hold the read off.
 *
 * A `git fetch` on a large repository writes for seconds, and a debounce with
 * no ceiling would wait for all of it — so the first event of a burst is a
 * deadline as well as a delay. This is the number the promise "a checkout is
 * on screen within a second" is made of.
 */
export const HEAD_DEBOUNCE_CEILING_MS = 1000;

/** One checkout to watch: what to call it, and where its git directory is. */
export interface WatchedRepository {
	/** The caller's own name for it, so a re-arm can tell what is unchanged. */
	readonly key: string;
	/** The root of the checkout — the directory whose `.git` is resolved. */
	readonly worktree: string;
	/**
	 * The machine the checkout is on.
	 *
	 * Per repository and not per watcher, because two open Workspaces can sit
	 * on two different machines and the answer to "is this being watched"
	 * has to be one answer per checkout either way. What the runtime does with
	 * it — real events here, a poll across a network — is its business; every
	 * word below this line is the same for both.
	 */
	readonly runtime: Runtime;
}

/** Why one checkout is not being watched, in a sentence a person can read. */
export interface WatchFailure {
	readonly key: string;
	readonly worktree: string;
	readonly reason: string;
}

/** One checkout's watch, and what it took to arm it. */
interface Armed {
	readonly worktree: string;
	readonly watcher: Watcher;
}

/**
 * Every open checkout's `HEAD`, watched.
 *
 * `arm` is the whole interface: it is given the set that should be watched and
 * makes that true, keeping the watchers of the checkouts that are still in it
 * and closing the ones that are not. Callers hand it the set they have rather
 * than telling it what changed, because "what changed" is a second answer to a
 * question the set already answers.
 */
export class HeadWatcher {
	readonly #armed = new Map<string, Armed>();
	readonly #failures = new Map<string, WatchFailure>();
	readonly #onChange: () => void;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** When the burst now being coalesced started, for the ceiling. */
	#burstStartedAt: number | undefined;
	#stopped = false;

	constructor(onChange: () => void) {
		this.#onChange = onChange;
	}

	/**
	 * Watch exactly these checkouts.
	 *
	 * A checkout already armed under the same key and worktree is left alone —
	 * re-arming it would tear down a working watcher and take a window in which
	 * a checkout goes unseen — and anything else is closed and armed again.
	 */
	async arm(repositories: readonly WatchedRepository[]): Promise<void> {
		if (this.#stopped) return;
		const wanted = new Map(
			repositories.map((repository) => [repository.key, repository]),
		);
		for (const [key, armed] of [...this.#armed]) {
			if (wanted.get(key)?.worktree === armed.worktree) continue;
			this.#close(key);
		}
		for (const [key, repository] of wanted) {
			if (this.#armed.has(key)) continue;
			this.#failures.delete(key);
			try {
				this.#armed.set(key, {
					worktree: repository.worktree,
					watcher: await repository.runtime.watchGitDirectory(
						repository.worktree,
						() => this.#touched(),
					),
				});
				activityCounters.record(COUNTER.repositoryHeadWatch);
			} catch (error: unknown) {
				// Not a swallow: a checkout that cannot be watched is exactly what
				// this class is asked about, and the caller shows it. The safety
				// poll keeps the branch true meanwhile, a minute at a time.
				activityCounters.record(COUNTER.repositoryHeadWatchFailed);
				this.#failures.set(key, {
					key,
					worktree: repository.worktree,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** The checkouts that are not being watched, and why. */
	failures(): readonly WatchFailure[] {
		return [...this.#failures.values()];
	}

	/** How many checkouts are watched right now. */
	get armedCount(): number {
		return this.#armed.size;
	}

	stop(): void {
		this.#stopped = true;
		for (const key of [...this.#armed.keys()]) this.#close(key);
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#burstStartedAt = undefined;
	}

	#close(key: string): void {
		const armed = this.#armed.get(key);
		if (!armed) return;
		armed.watcher.close();
		this.#armed.delete(key);
	}

	/**
	 * Something under a git directory moved.
	 *
	 * Coalesced twice over: the read happens once the writing stops, and once a
	 * second has passed however long the writing goes on for.
	 */
	#touched(): void {
		if (this.#stopped) return;
		const now = Date.now();
		this.#burstStartedAt ??= now;
		const wait = Math.max(
			0,
			Math.min(
				HEAD_DEBOUNCE_MS,
				this.#burstStartedAt + HEAD_DEBOUNCE_CEILING_MS - now,
			),
		);
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#burstStartedAt = undefined;
			this.#onChange();
		}, wait);
	}
}
