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
 * It holds no timers, reads no clock of its own and keeps no verdict: the
 * caller passes `now`, and what a folder's workbench is doing — waiting out a
 * backoff, given up on, parked — is its phase in `workbenchLifecycle.ts`,
 * which owns this counter and is the one place that decides when a workbench
 * is built.
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
		if (
			record.loadedAtMs !== undefined &&
			nowMs - record.loadedAtMs >= this.healthyMs
		) {
			record.failures = 0;
		}
		record.loadedAtMs = undefined;
		record.failures += 1;
		if (record.failures > this.maxRestarts) {
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
		this.record(key).loadedAtMs = nowMs;
	}

	/** How many failures stand against this folder right now. */
	failures(key: string): number {
		return this.records.get(key)?.failures ?? 0;
	}

	/**
	 * Forget this folder entirely.
	 *
	 * The one way out of giving up, and it is reached only by a person: the
	 * workspace is retried, relocated, or closed. A counter that reset itself
	 * would be the restart loop again with a longer period.
	 */
	forget(key: string): void {
		this.records.delete(key);
	}

	private record(key: string): EditorRecord {
		const existing = this.records.get(key);
		if (existing) return existing;
		const fresh: EditorRecord = { failures: 0, loadedAtMs: undefined };
		this.records.set(key, fresh);
		return fresh;
	}
}
