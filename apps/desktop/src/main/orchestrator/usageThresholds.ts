/**
 * `usage.threshold`: a plan window's use crossing one of `[orchestrator]
 * usage_thresholds` upward, read off the Sidebar's usage readout
 * (`main/shell/usageLimits.ts`) each time it changes. It never asks a CLI
 * for anything itself.
 *
 * Per CLI and window, each threshold fires **once per window period**: it is
 * armed again when the window resets — its use reads below the threshold, or
 * its reset time passes (or a reading names a later reset, a new period).
 * When several thresholds are crossed at once only the highest is said.
 *
 * A window first seen above a threshold (DevHub just started) is a crossing
 * too: the orchestrator hears it once. A window whose reset has already
 * passed is the last period's, and says nothing.
 *
 * Just before delivery the dispatcher asks `usageThresholdRelevant`: an event
 * whose window has since reset below its threshold is dropped as stale.
 */

import { SAME_RESET_MS } from "../shell/usageLimits.js";
import type { UsageLimitsWire } from "../../ipc/contract.js";
import type { OrchestratorEvent } from "./events.js";

export type UsageThresholdEvent = Extract<
	OrchestratorEvent,
	{ readonly type: "usage.threshold" }
>;

/** A window as the readout has it now. */
export interface UsageWindowNow {
	readonly usedPercent?: number;
	readonly resetsAt?: number;
}

export interface UsageThresholdPorts {
	/** `[orchestrator] usage_thresholds` as DevHub runs on it now. */
	readonly thresholds: () => readonly number[];
	readonly dispatch: (event: UsageThresholdEvent) => void;
	readonly now?: () => number;
}

interface WindowState {
	/** The period's reset, as last read. */
	resetsAt: number | undefined;
	/** The thresholds already said this period. */
	readonly fired: Set<number>;
}

export class UsageThresholdWatch {
	readonly #windows = new Map<string, WindowState>();

	constructor(private readonly ports: UsageThresholdPorts) {}

	/** The readout as it is now; dispatches what crossed since the last look. */
	observe(limits: UsageLimitsWire): void {
		const now = (this.ports.now ?? Date.now)();
		const thresholds = [...this.ports.thresholds()].sort((a, b) => a - b);
		for (const one of limits.clis)
			for (const window of one.windows ?? []) {
				const used = window.usedPercent;
				if (used === undefined) continue;
				// The last period's reading: the window has reset since.
				if (window.resetsAt !== undefined && window.resetsAt <= now) continue;
				const key = `${one.cli}/${window.window}`;
				let state = this.#windows.get(key);
				if (state === undefined) {
					state = { resetsAt: window.resetsAt, fired: new Set() };
					this.#windows.set(key, state);
				} else if (newPeriod(state.resetsAt, window.resetsAt, now)) {
					state.fired.clear();
				}
				state.resetsAt = window.resetsAt;
				// Below a threshold again: it has reset, and may fire again.
				for (const threshold of [...state.fired])
					if (used < threshold) state.fired.delete(threshold);
				const crossed = thresholds.filter(
					(threshold) => used >= threshold && !state.fired.has(threshold),
				);
				for (const threshold of crossed) state.fired.add(threshold);
				const highest = crossed.at(-1);
				if (highest === undefined) continue;
				this.ports.dispatch({
					type: "usage.threshold",
					cli: one.cli,
					window: window.window,
					threshold: highest,
					usedPercent: used,
					...(window.resetsAt === undefined
						? {}
						: { resetsAt: window.resetsAt }),
				});
			}
	}
}

/** Whether a reading with reset `next` is a later period than one with `was`. */
function newPeriod(
	was: number | undefined,
	next: number | undefined,
	now: number,
): boolean {
	if (was === undefined) return false;
	if (now >= was) return true;
	return next !== undefined && next - was > SAME_RESET_MS;
}

/**
 * Whether a pending `usage.threshold` still says something true: its reset
 * has not passed, and the window does not now read below its threshold.
 */
export function usageThresholdRelevant(
	event: UsageThresholdEvent,
	current: UsageWindowNow | undefined,
	now: number,
): boolean {
	if (event.resetsAt !== undefined && now >= event.resetsAt) return false;
	if (current?.resetsAt !== undefined && now >= current.resetsAt) return false;
	return !(
		current?.usedPercent !== undefined && current.usedPercent < event.threshold
	);
}

/** One window of the readout, for `usageThresholdRelevant`. */
export function usageWindowOf(
	limits: UsageLimitsWire,
	cli: string,
	window: string,
): UsageWindowNow | undefined {
	return limits.clis
		.find((one) => one.cli === cli)
		?.windows?.find((one) => one.window === window);
}
