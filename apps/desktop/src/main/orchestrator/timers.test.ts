import { describe, expect, it } from "vitest";
import type { OrchestratorTimerConfig } from "../../model/orchestratorSettings.js";
import { EventDispatcher, type OrchestratorEvent } from "./events.js";
import { OrchestratorTimers } from "./timers.js";

function clock() {
	let now = 0;
	const timers: { at: number; run: () => void; live: boolean }[] = [];
	return {
		now: () => now,
		setTimer: (ms: number, run: () => void) => {
			const timer = { at: now + ms, run, live: true };
			timers.push(timer);
			return {
				cancel: () => {
					timer.live = false;
				},
			};
		},
		advance(ms: number) {
			const until = now + ms;
			for (;;) {
				const next = timers
					.filter((one) => one.live && one.at <= until)
					.sort((a, b) => a.at - b.at)[0];
				if (next === undefined) break;
				next.live = false;
				now = next.at;
				next.run();
			}
			now = until;
		},
	};
}

function world(defaults: OrchestratorTimerConfig[]) {
	const time = clock();
	const fired: OrchestratorEvent[] = [];
	const timers = new OrchestratorTimers({
		defaults: () => defaults,
		dispatch: (event) => fired.push(event),
		now: time.now,
		setTimer: time.setTimer,
	});
	timers.sync();
	return { time, fired, timers, defaults };
}

describe("the orchestrator's timers", () => {
	it("fire timer.elapsed with their name, from the settings", () => {
		const { time, fired, timers } = world([{ name: "tick", interval: "1m" }]);
		expect(timers.list()).toEqual([
			{ name: "tick", interval: "1m", source: "settings", nextAt: 60_000 },
		]);
		time.advance(150_000);
		expect(fired).toEqual([
			{ type: "timer.elapsed", name: "tick", interval: "1m" },
			{ type: "timer.elapsed", name: "tick", interval: "1m" },
		]);
	});

	it("are set and cleared for the session, over the settings", () => {
		const { time, fired, timers } = world([{ name: "tick", interval: "1m" }]);
		timers.set("tick", "30s");
		timers.set("sweep", "1h");
		expect(
			timers.list().map((one) => [one.name, one.interval, one.source]),
		).toEqual([
			["sweep", "1h", "session"],
			["tick", "30s", "session"],
		]);
		expect(timers.clear("tick")).toBe(true);
		expect(timers.clear("nope")).toBe(false);
		// Cleared stays cleared, even though the settings still name it.
		timers.sync();
		expect(timers.list().map((one) => one.name)).toEqual(["sweep"]);
		time.advance(3_600_000);
		expect(fired.map((one) => "name" in one && one.name)).toEqual(["sweep"]);
	});

	it("refuse a bad name or interval", () => {
		const { timers } = world([]);
		expect(() => timers.set("no spaces", "1m")).toThrow(/timer name/u);
		expect(() => timers.set("tick", "5")).toThrow(/interval/u);
		expect(() => timers.set("tick", "1s")).toThrow(/at least 10s/u);
	});

	it("follow the settings for the ones nobody set", () => {
		const { timers, defaults } = world([{ name: "tick", interval: "1m" }]);
		defaults.splice(0, 1, { name: "tick", interval: "2m" });
		defaults.push({ name: "sweep", interval: "1h" });
		timers.sync();
		expect(timers.list().map((one) => [one.name, one.interval])).toEqual([
			["sweep", "1h"],
			["tick", "2m"],
		]);
	});

	it("keep at most one pending event each", () => {
		const time = clock();
		const dispatcher = new EventDispatcher({
			orchestrator: () => "orch",
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: ["timer.*"],
			}),
			deliver: () => undefined,
			busy: () => true,
		});
		const timers = new OrchestratorTimers({
			defaults: () => [
				{ name: "tick", interval: "10s" },
				{ name: "sweep", interval: "20s" },
			],
			dispatch: (event) => dispatcher.dispatch(event),
			now: time.now,
			setTimer: time.setTimer,
		});
		timers.sync();
		time.advance(100_000);
		expect(dispatcher.held()).toEqual([
			{ type: "timer.elapsed", name: "tick", interval: "10s" },
			{ type: "timer.elapsed", name: "sweep", interval: "20s" },
		]);
	});
});
