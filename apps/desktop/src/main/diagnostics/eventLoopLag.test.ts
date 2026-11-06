import { afterEach, describe, expect, it, vi } from "vitest";
import {
	eventLoopLagLine,
	noteMainActivity,
	startEventLoopLagMonitor,
} from "./eventLoopLag.js";

describe("the blocked-loop line", () => {
	it("says nothing while the loop keeps up", () => {
		expect(eventLoopLagLine(149, 150, ["state save"], undefined)).toBe(
			undefined,
		);
		expect(eventLoopLagLine(150, 150, [], undefined)).toBe(undefined);
	});

	it("names how long and what ran in the window", () => {
		expect(
			eventLoopLagLine(
				812.4,
				150,
				["terminal attach agent:1", "state save"],
				undefined,
			),
		).toBe(
			"[devhub] main event loop blocked for 812 ms (during: terminal attach agent:1, state save)",
		);
	});

	it("falls back to the last thing noted, or says it does not know", () => {
		expect(eventLoopLagLine(400, 150, [], "menu refresh")).toBe(
			"[devhub] main event loop blocked for 400 ms (during: nothing noted; last: menu refresh)",
		);
		expect(eventLoopLagLine(400, 150, [], undefined)).toBe(
			"[devhub] main event loop blocked for 400 ms (during: unknown)",
		);
	});
});

describe("the monitor", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("logs a late tick with the labels noted since the previous one, once", () => {
		vi.useFakeTimers();
		let now = 0;
		const lines: string[] = [];
		const stop = startEventLoopLagMonitor({
			intervalMs: 100,
			thresholdMs: 50,
			now: () => now,
			log: (line) => lines.push(line),
		});
		now = 100;
		vi.advanceTimersByTime(100);
		expect(lines).toEqual([]);
		noteMainActivity("state save");
		noteMainActivity("menu refresh");
		noteMainActivity("state save");
		now = 500; // due at 200, ran at 500
		vi.advanceTimersByTime(100);
		expect(lines).toEqual([
			"[devhub] main event loop blocked for 300 ms (during: menu refresh, state save)",
		]);
		now = 600;
		vi.advanceTimersByTime(100);
		expect(lines).toHaveLength(1);
		stop();
	});
});
