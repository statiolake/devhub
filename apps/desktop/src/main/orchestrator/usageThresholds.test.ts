import { describe, expect, it } from "vitest";
import type { UsageLimitsWire } from "../../ipc/contract.js";
import { DEFAULT_ORCHESTRATOR_EVENTS } from "../../model/orchestratorSettings.js";
import {
	EventDispatcher,
	eventLine,
	type OrchestratorEvent,
} from "./events.js";
import {
	UsageThresholdWatch,
	usageThresholdRelevant,
	usageWindowOf,
	type UsageThresholdEvent,
} from "./usageThresholds.js";

const HOUR = 3_600_000;

function readout(
	windows: Record<string, { pct: number; resetsAt?: number }>,
	cli: "claude" | "codex" = "claude",
): UsageLimitsWire {
	return {
		clis: [
			{
				cli,
				windows: Object.entries(windows).map(([window, one]) => ({
					window,
					usedPercent: one.pct,
					...(one.resetsAt === undefined ? {} : { resetsAt: one.resetsAt }),
				})),
			},
		],
	};
}

function watch(thresholds: readonly number[] = [80, 95]) {
	const fired: UsageThresholdEvent[] = [];
	let now = 1000 * HOUR;
	const source = new UsageThresholdWatch({
		thresholds: () => thresholds,
		dispatch: (event) => fired.push(event),
		now: () => now,
	});
	return {
		fired,
		source,
		get now() {
			return now;
		},
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("usage.threshold", () => {
	it("fires as a window crosses a threshold upward, once per threshold", () => {
		const w = watch();
		const resetsAt = w.now + 3 * HOUR;
		w.source.observe(readout({ "5-hour": { pct: 50, resetsAt } }));
		expect(w.fired).toEqual([]);
		w.source.observe(readout({ "5-hour": { pct: 82, resetsAt } }));
		expect(w.fired).toEqual([
			{
				type: "usage.threshold",
				cli: "claude",
				window: "5-hour",
				threshold: 80,
				usedPercent: 82,
				resetsAt,
			},
		]);
		w.source.observe(readout({ "5-hour": { pct: 85, resetsAt } }));
		w.source.observe(readout({ "5-hour": { pct: 90, resetsAt } }));
		expect(w.fired).toHaveLength(1);
		w.source.observe(readout({ "5-hour": { pct: 96, resetsAt } }));
		expect(w.fired.map((one) => one.threshold)).toEqual([80, 95]);
		w.source.observe(readout({ "5-hour": { pct: 99, resetsAt } }));
		expect(w.fired).toHaveLength(2);
	});

	it("says only the highest of thresholds crossed at once; windows are apart", () => {
		const w = watch();
		const resetsAt = w.now + HOUR;
		w.source.observe(
			readout({
				"5-hour": { pct: 97, resetsAt },
				"7-day": { pct: 81, resetsAt: w.now + 50 * HOUR },
			}),
		);
		expect(
			w.fired.map((one) => [one.window, one.threshold, one.usedPercent]),
		).toEqual([
			["5-hour", 95, 97],
			["7-day", 80, 81],
		]);
	});

	it("re-arms when the window resets: below the threshold, or its reset passed", () => {
		const w = watch([80]);
		const first = w.now + HOUR;
		w.source.observe(readout({ "5-hour": { pct: 85, resetsAt: first } }));
		expect(w.fired).toHaveLength(1);
		// The reset passes: a reading of the old window says nothing.
		w.advance(HOUR + 1000);
		w.source.observe(readout({ "5-hour": { pct: 85, resetsAt: first } }));
		expect(w.fired).toHaveLength(1);
		// The new period climbs again: it fires again.
		const second = w.now + 5 * HOUR;
		w.source.observe(readout({ "5-hour": { pct: 10, resetsAt: second } }));
		w.source.observe(readout({ "5-hour": { pct: 81, resetsAt: second } }));
		expect(w.fired.map((one) => one.resetsAt)).toEqual([first, second]);
		// A drop below it (the window reset early) re-arms it too.
		w.source.observe(readout({ "5-hour": { pct: 5, resetsAt: second } }));
		w.source.observe(readout({ "5-hour": { pct: 80, resetsAt: second } }));
		expect(w.fired).toHaveLength(3);
	});

	it("re-arms on a reading of a later period even before the old reset is seen to pass", () => {
		const w = watch([80]);
		w.source.observe(
			readout({ "5-hour": { pct: 90, resetsAt: w.now + HOUR } }),
		);
		w.source.observe(
			readout({ "5-hour": { pct: 90, resetsAt: w.now + 6 * HOUR } }),
		);
		expect(w.fired).toHaveLength(2);
	});

	it("follows the thresholds as set now; none: never", () => {
		const w = watch([]);
		w.source.observe(
			readout({ "5-hour": { pct: 100, resetsAt: w.now + HOUR } }),
		);
		expect(w.fired).toEqual([]);
	});

	it("is a line in the orchestrator's format", () => {
		const now = new Date(2026, 10, 5, 15, 0).getTime();
		const resetsAt = new Date(2026, 10, 5, 19, 20).getTime();
		expect(
			eventLine(
				{
					type: "usage.threshold",
					cli: "claude",
					window: "5-hour",
					threshold: 80,
					usedPercent: 82.6,
					resetsAt,
				},
				now,
			),
		).toBe(
			"[usage.threshold] cli=claude window=5-hour pct=82 resets=19:20 — 5時間枠が80%を超えました",
		);
		expect(
			eventLine(
				{
					type: "usage.threshold",
					cli: "codex",
					window: "7-day",
					threshold: 95,
					usedPercent: 95,
					resetsAt: new Date(2026, 10, 8, 10, 0).getTime(),
				},
				now,
			),
		).toBe(
			"[usage.threshold] cli=codex window=7-day pct=95 resets=11-08T10:00 — 7日枠が95%を超えました",
		);
	});

	it("is stale once the window has reset below it", () => {
		const event: UsageThresholdEvent = {
			type: "usage.threshold",
			cli: "claude",
			window: "5-hour",
			threshold: 80,
			usedPercent: 82,
			resetsAt: 10 * HOUR,
		};
		expect(usageThresholdRelevant(event, { usedPercent: 85 }, 9 * HOUR)).toBe(
			true,
		);
		expect(usageThresholdRelevant(event, undefined, 9 * HOUR)).toBe(true);
		expect(usageThresholdRelevant(event, { usedPercent: 3 }, 9 * HOUR)).toBe(
			false,
		);
		expect(usageThresholdRelevant(event, { usedPercent: 85 }, 10 * HOUR)).toBe(
			false,
		);
		expect(
			usageWindowOf(readout({ "5-hour": { pct: 3 } }), "claude", "5-hour"),
		).toEqual({ window: "5-hour", usedPercent: 3 });
	});
});

describe("usage.threshold through the dispatcher", () => {
	function dispatcher(current: () => number) {
		const delivered: string[] = [];
		let held = true;
		const events = new EventDispatcher({
			orchestrator: () => "orch",
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: DEFAULT_ORCHESTRATOR_EVENTS,
				delivery_interval: "5m",
			}),
			deliver: (_agent, text) => delivered.push(text),
			busy: () => held,
			relevant: (event: OrchestratorEvent) =>
				event.type !== "usage.threshold" ||
				usageThresholdRelevant(event, { usedPercent: current() }, 0),
		});
		return {
			events,
			delivered,
			release() {
				held = false;
				events.flush();
			},
		};
	}
	const crossing = (threshold: number, usedPercent: number) =>
		({
			type: "usage.threshold",
			cli: "claude",
			window: "5-hour",
			threshold,
			usedPercent,
		}) as const;

	it("is in the default filter, and coalesces per CLI and window to the latest", () => {
		const d = dispatcher(() => 97);
		const first = d.events.dispatch(crossing(80, 82));
		d.events.dispatch({ ...crossing(80, 81), window: "7-day" });
		d.events.dispatch(crossing(95, 97));
		expect(first.fate).toBe("coalesced");
		d.release();
		expect(d.delivered).toHaveLength(1);
		expect(d.delivered[0]!.split("\n")).toEqual([
			"[usage.threshold] cli=claude window=5-hour pct=97 — 5時間枠が95%を超えました",
			"[usage.threshold] cli=claude window=7-day pct=81 — 7日枠が80%を超えました",
		]);
	});

	it("is dropped as stale when the window has reset below it by delivery", () => {
		let pct = 85;
		const d = dispatcher(() => pct);
		const entry = d.events.dispatch(crossing(80, 85));
		pct = 2;
		d.release();
		expect(d.delivered).toEqual([]);
		expect(entry.fate).toBe("dropped-stale");
	});
});
