/**
 * The orchestrator's timers: each fires a `timer.elapsed` carrying its name.
 *
 * `[[orchestrator.timers]]` are the defaults. `devhub --tell orchestrator
 * timer set NAME INTERVAL | clear NAME` changes them for this session only:
 * a set one replaces (or adds to) the settings' one of that name, a cleared
 * one is off until DevHub restarts or `set` turns it on again. Settings that
 * change while DevHub runs move the timers nobody set by hand.
 *
 * At most one `timer.elapsed` per timer is ever pending: the dispatcher
 * folds the next into the one already waiting (`events.ts`, `merge`).
 */

import {
	formatInterval,
	intervalProblem,
	isTimerName,
	MIN_TIMER_INTERVAL_MS,
	parseInterval,
	type OrchestratorTimerConfig,
} from "../../model/orchestratorSettings.js";
import type { OrchestratorEvent } from "./events.js";

export interface TimerView {
	readonly name: string;
	readonly interval: string;
	/** Where it comes from: the settings, or `timer set` in this session. */
	readonly source: "settings" | "session";
	/** When it fires next, ms since the epoch. */
	readonly nextAt: number;
}

export interface TimerPorts {
	readonly defaults: () => readonly OrchestratorTimerConfig[];
	readonly dispatch: (event: OrchestratorEvent) => void;
	readonly now?: () => number;
	readonly setTimer: (ms: number, run: () => void) => { cancel(): void };
}

interface Running {
	readonly interval: string;
	readonly ms: number;
	readonly source: "settings" | "session";
	nextAt: number;
	handle: { cancel(): void };
}

export class OrchestratorTimers {
	/** `timer set` in this session: an interval, or `null` for cleared. */
	readonly #overrides = new Map<string, string | null>();
	readonly #running = new Map<string, Running>();
	#stopped = false;

	constructor(private readonly ports: TimerPorts) {}

	#now(): number {
		return (this.ports.now ?? Date.now)();
	}

	/** What should run: the settings' timers, with this session's changes. */
	#wanted(): Map<string, { interval: string; source: Running["source"] }> {
		const wanted = new Map<
			string,
			{ interval: string; source: Running["source"] }
		>();
		for (const timer of this.ports.defaults())
			wanted.set(timer.name, { interval: timer.interval, source: "settings" });
		for (const [name, interval] of this.#overrides) {
			if (interval === null) wanted.delete(name);
			else wanted.set(name, { interval, source: "session" });
		}
		return wanted;
	}

	/** Start, stop and re-arm timers to match. Idempotent; call on settings changes. */
	sync(): void {
		if (this.#stopped) return;
		const wanted = this.#wanted();
		for (const [name, running] of [...this.#running]) {
			const want = wanted.get(name);
			if (
				want === undefined ||
				want.interval !== running.interval ||
				want.source !== running.source
			) {
				running.handle.cancel();
				this.#running.delete(name);
			}
		}
		for (const [name, want] of wanted) {
			if (this.#running.has(name)) continue;
			const ms = parseInterval(want.interval);
			if (ms === undefined) continue;
			const running: Running = {
				interval: want.interval,
				ms,
				source: want.source,
				nextAt: this.#now() + ms,
				handle: { cancel: () => undefined },
			};
			this.#running.set(name, running);
			this.#arm(name, running);
		}
	}

	#arm(name: string, running: Running): void {
		running.handle = this.ports.setTimer(running.ms, () => {
			if (this.#running.get(name) !== running) return;
			running.nextAt = this.#now() + running.ms;
			this.#arm(name, running);
			this.ports.dispatch({
				type: "timer.elapsed",
				name,
				interval: running.interval,
			});
		});
	}

	list(): readonly TimerView[] {
		return [...this.#running]
			.map(([name, running]) => ({
				name,
				interval: running.interval,
				source: running.source,
				nextAt: running.nextAt,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Set (or add) `name` for this session. Refused with the rule it breaks. */
	set(name: string, interval: string): TimerView {
		if (!isTimerName(name))
			throw new Error(
				`${JSON.stringify(name)} is not a timer name: letters, digits, - and _, at most 40.`,
			);
		if (intervalProblem(interval, MIN_TIMER_INTERVAL_MS))
			throw new Error(
				`${JSON.stringify(interval)} is not an interval: like 30s, 5m or 1h30m, at least ${formatInterval(MIN_TIMER_INTERVAL_MS)}.`,
			);
		this.#overrides.set(name, interval.trim());
		this.sync();
		return this.list().find((one) => one.name === name)!;
	}

	/** Turn `name` off for this session; false when no such timer runs. */
	clear(name: string): boolean {
		const had = this.#running.has(name);
		const inSettings = this.ports.defaults().some((one) => one.name === name);
		if (inSettings) this.#overrides.set(name, null);
		else this.#overrides.delete(name);
		this.sync();
		return had;
	}

	stop(): void {
		this.#stopped = true;
		for (const running of this.#running.values()) running.handle.cancel();
		this.#running.clear();
	}
}
