/**
 * Main's `requestIdleCallback`, for work that is worth doing after launch
 * but on nobody's way: run once main has stopped being busy with starting
 * up, after the window has shown.
 *
 * Main has no idle callback of its own, so idleness is read off its event
 * loop: a timer of `sliceMs` is set again and again, and a slice that fires
 * within `slackMs` of when it was due is a quiet one. `quietSlices` quiet
 * slices in a row, no sooner than `settleMs` after it was asked, is idle;
 * `maxMs` after it was asked it runs whatever main is doing, so a main that
 * never settles still gets it. The cost is a timer every `sliceMs` for those
 * first seconds.
 */

export interface LaunchIdleOptions {
	/** The least time from being asked to running: the start-up's tail. */
	readonly settleMs?: number;
	readonly sliceMs?: number;
	/** How late a slice may fire and still be quiet. */
	readonly slackMs?: number;
	readonly quietSlices?: number;
	readonly maxMs?: number;
	readonly now?: () => number;
	readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

export const LAUNCH_IDLE_DEFAULTS = {
	settleMs: 500,
	sliceMs: 50,
	slackMs: 10,
	quietSlices: 4,
	maxMs: 10_000,
} as const;

/** Run `work` once main is idle; the returned function cancels it. */
export function whenIdleAfterLaunch(
	work: () => void,
	options: LaunchIdleOptions = {},
): () => void {
	const settleMs = options.settleMs ?? LAUNCH_IDLE_DEFAULTS.settleMs;
	const sliceMs = options.sliceMs ?? LAUNCH_IDLE_DEFAULTS.sliceMs;
	const slackMs = options.slackMs ?? LAUNCH_IDLE_DEFAULTS.slackMs;
	const quietSlices = options.quietSlices ?? LAUNCH_IDLE_DEFAULTS.quietSlices;
	const maxMs = options.maxMs ?? LAUNCH_IDLE_DEFAULTS.maxMs;
	const now = options.now ?? (() => performance.now());
	const setTimer =
		options.setTimer ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			return {
				cancel: () => {
					clearTimeout(timer);
				},
			};
		});
	const asked = now();
	let quiet = 0;
	let timer: { cancel(): void } | undefined;
	const slice = (): void => {
		const due = now() + sliceMs;
		timer = setTimer(() => {
			timer = undefined;
			const at = now();
			quiet = at - due <= slackMs ? quiet + 1 : 0;
			if (
				at - asked >= maxMs ||
				(quiet >= quietSlices && at - asked >= settleMs)
			) {
				work();
				return;
			}
			slice();
		}, sliceMs);
	};
	slice();
	return () => {
		timer?.cancel();
		timer = undefined;
	};
}
