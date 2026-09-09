import { describe, expect, it } from "vitest";
import { AgentScreenFreshness } from "./screenFreshness.js";

/** A clock the test moves by hand, in milliseconds. */
function clockFrom(ms: number): {
	now: () => number;
	set: (ms: number) => void;
} {
	let value = ms;
	return {
		now: () => value,
		set: (next) => {
			value = next;
		},
	};
}

const AGENT = "agent-1";

describe("AgentScreenFreshness", () => {
	it("reads an Agent it has never seen", () => {
		const freshness = new AgentScreenFreshness(() => 0);
		expect(freshness.shouldCapture(AGENT, "100")).toBe(true);
	});

	it("stops reading an Agent that has written nothing since the second ended", () => {
		const clock = clockFrom(100_500);
		const freshness = new AgentScreenFreshness(clock.now);
		// Written at second 100, read during second 100: the second is still
		// running, so more may yet land in it.
		freshness.captured(AGENT, "100");
		expect(freshness.shouldCapture(AGENT, "100")).toBe(true);

		// Read again once second 101 has started. Now second 100 is closed.
		clock.set(101_200);
		freshness.captured(AGENT, "100");
		expect(freshness.shouldCapture(AGENT, "100")).toBe(false);
		clock.set(200_000);
		expect(freshness.shouldCapture(AGENT, "100")).toBe(false);
	});

	it("reads again as soon as the Agent writes", () => {
		const clock = clockFrom(101_200);
		const freshness = new AgentScreenFreshness(clock.now);
		freshness.captured(AGENT, "100");
		expect(freshness.shouldCapture(AGENT, "100")).toBe(false);
		expect(freshness.shouldCapture(AGENT, "101")).toBe(true);
	});

	it("reads every round while a marker it cannot compare is all it is given", () => {
		const freshness = new AgentScreenFreshness(() => 500_000);
		freshness.captured(AGENT, undefined);
		expect(freshness.shouldCapture(AGENT, undefined)).toBe(true);
		// And a capture taken with no marker settles nothing, so an Agent that
		// starts reporting one is still read.
		expect(freshness.shouldCapture(AGENT, "400")).toBe(true);
	});

	it("keeps each Agent's answer to itself", () => {
		const clock = clockFrom(101_200);
		const freshness = new AgentScreenFreshness(clock.now);
		freshness.captured(AGENT, "100");
		expect(freshness.shouldCapture(AGENT, "100")).toBe(false);
		expect(freshness.shouldCapture("agent-2", "100")).toBe(true);
	});

	it("forgets an Agent that ended, so a reused id is read afresh", () => {
		const clock = clockFrom(101_200);
		const freshness = new AgentScreenFreshness(clock.now);
		freshness.captured(AGENT, "100");
		expect(freshness.shouldCapture(AGENT, "100")).toBe(false);
		freshness.forget(AGENT);
		expect(freshness.shouldCapture(AGENT, "100")).toBe(true);
	});
});
