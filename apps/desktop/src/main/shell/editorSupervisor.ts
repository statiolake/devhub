/**
 * How many times a workbench may fall over before DevHub stops standing it up.
 *
 * A crash loop is a bug to report, not a thing to keep feeding.
 */
export const MAX_EDITOR_RESTARTS = 5;

/** The first wait. Every one after it is twice the one before. */
export const RESTART_BACKOFF_MS = 250;

/**
 * How long a workbench has to keep running before its record is torn up.
 *
 * Loading is not recovering. A workbench that starts, paints, and dies again
 * has *finished loading* every time, so a counter that resets on
 * `did-finish-load` counts to one for ever and the backoff never leaves its
 * first step — which is a restart every 250 ms, for ever, per folder. The
 * thing worth believing is not that it loaded but that it stayed, so the
 * record is only forgotten once it has stayed this long.
 */
export const EDITOR_HEALTHY_MS = 60_000;

/**
 * Which views are no longer there, out of the ones main thinks it has.
 *
 * A separate function because the interesting part is the rule — a view that
 * is missing from the window, or present but ended, is a dead workbench — and
 * the caller's part is Electron. Sleep is the event that makes the two differ:
 * the OS kills a renderer, the table still names it, and nothing in main is
 * told. See `AppController.checkEditorHealth`.
 */
export function deadEditorKeys(
	views: Iterable<{ readonly key: string; readonly alive: boolean }>,
): readonly string[] {
	return [...views].filter((view) => !view.alive).map((view) => view.key);
}

/**
 * Where a workbench DevHub has given up on is reported.
 *
 * The subject rule, for this one condition, in one place: a workbench belongs
 * to a Workspace, so its failure is that Workspace's — its row, its surface,
 * its Retry — and every other row still has an editor. Only Scratch, which is
 * no row's, is the application speaking.
 */
export function editorGaveUpFailure(input: {
	readonly workspaceId: string | undefined;
	readonly attempt: number;
	readonly reason: string;
}):
	| {
			readonly subject: "workspace";
			readonly id: string;
			readonly code: "editor_restart_exhausted";
			readonly detail: string;
	  }
	| {
			readonly subject: "app";
			readonly code: "editor_restart_exhausted";
			readonly detail: string;
	  } {
	const detail = `The workbench stopped ${String(input.attempt)} times. ${input.reason}`;
	return input.workspaceId === undefined
		? { subject: "app", code: "editor_restart_exhausted", detail }
		: {
				subject: "workspace",
				id: input.workspaceId,
				code: "editor_restart_exhausted",
				detail,
			};
}

/** What to do about a workbench that just failed. */
export type EditorSupervision =
	| {
			readonly kind: "restart";
			/** Which attempt this is, counting from one. */
			readonly attempt: number;
			readonly delayMs: number;
	  }
	| {
			readonly kind: "gave-up";
			readonly attempt: number;
	  };

interface EditorRecord {
	failures: number;
	/** When this workbench last said it had finished loading. */
	loadedAtMs: number | undefined;
	gaveUp: boolean;
	/** Whether the terminal state has been seen; see `park`. */
	parked: boolean;
}

/**
 * The one answer to "this workbench failed — again?".
 *
 * Every way a workbench can fail to be there comes through here: a renderer
 * the OS killed while the Mac was asleep, a `windows().open()` that rejected,
 * a view that never appeared. They are one fact — there is no workbench for
 * this folder and DevHub's last attempt did not make one — so they share one
 * counter and one ceiling. Counting them separately is how a folder gets two
 * budgets and neither of them runs out.
 *
 * It holds no timers and reads no clock of its own: the caller passes `now`.
 * A supervisor that scheduled its own restarts would be a second place that
 * decides when a workbench is built, and the first one is `ensureEditorView`.
 */
export class EditorSupervisor {
	private readonly records = new Map<string, EditorRecord>();

	constructor(
		private readonly maxRestarts = MAX_EDITOR_RESTARTS,
		private readonly backoffMs = RESTART_BACKOFF_MS,
		private readonly healthyMs = EDITOR_HEALTHY_MS,
	) {}

	/**
	 * Record a failure and say what may be done about it.
	 *
	 * The sustained-health check is made here rather than on a timer because
	 * this is the only moment the answer is used. A workbench that never fails
	 * again does not need its record torn up; one that does is asked, at that
	 * moment, whether the run it just ended was long enough to count as a
	 * recovery. Same rule, no clock of its own, and nothing to leak.
	 */
	failed(key: string, nowMs: number): EditorSupervision {
		const record = this.record(key);
		if (record.gaveUp) {
			return { kind: "gave-up", attempt: record.failures };
		}
		if (
			record.loadedAtMs !== undefined &&
			nowMs - record.loadedAtMs >= this.healthyMs
		) {
			record.failures = 0;
		}
		record.loadedAtMs = undefined;
		record.failures += 1;
		if (record.failures > this.maxRestarts) {
			record.gaveUp = true;
			return { kind: "gave-up", attempt: record.failures };
		}
		return {
			kind: "restart",
			attempt: record.failures,
			delayMs: this.backoffMs * 2 ** (record.failures - 1),
		};
	}

	/**
	 * A workbench said it had finished loading.
	 *
	 * It starts the clock the next failure is measured against, and nothing
	 * else. See `EDITOR_HEALTHY_MS`.
	 */
	loaded(key: string, nowMs: number): void {
		const record = this.record(key);
		if (record.gaveUp) return;
		record.loadedAtMs = nowMs;
	}

	/** Whether DevHub has stopped building this folder's workbench. */
	gaveUp(key: string): boolean {
		return this.records.get(key)?.gaveUp === true;
	}

	/** Every folder DevHub has stopped building a workbench for. */
	gaveUpKeys(): readonly string[] {
		return [...this.records]
			.filter(([, record]) => record.gaveUp)
			.map(([key]) => key);
	}

	/**
	 * Note that this folder's terminal state has been seen by whoever keeps
	 * the workbenches.
	 *
	 * The mark exists so that "wanted again" can mean "a person asked again".
	 * Without it, the tick between giving up and the model catching up reads as
	 * a fresh request and lets the loop straight back out — the counter reset
	 * by a race, which is the bug one step further along.
	 */
	park(key: string): void {
		const record = this.records.get(key);
		if (record) record.parked = true;
	}

	parked(key: string): boolean {
		return this.records.get(key)?.parked === true;
	}

	/** How many failures stand against this folder right now. */
	failures(key: string): number {
		return this.records.get(key)?.failures ?? 0;
	}

	/**
	 * Forget this folder entirely.
	 *
	 * The one way out of `gave-up`, and it is reached only by a person: the
	 * workspace is retried, relocated, or closed. A supervisor that let itself
	 * out would be the restart loop again with a longer period.
	 */
	forget(key: string): void {
		this.records.delete(key);
	}

	private record(key: string): EditorRecord {
		const existing = this.records.get(key);
		if (existing) return existing;
		const fresh: EditorRecord = {
			failures: 0,
			loadedAtMs: undefined,
			gaveUp: false,
			parked: false,
		};
		this.records.set(key, fresh);
		return fresh;
	}
}
