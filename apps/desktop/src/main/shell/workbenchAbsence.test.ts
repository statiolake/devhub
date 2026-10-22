import { describe, expect, it } from "vitest";
import { WorkbenchAbsence } from "./workbenchAbsence.js";

describe("how long a workbench was off screen", () => {
	const a = { name: "a" };
	const b = { name: "b" };

	it("says nothing the first time a workbench is shown", () => {
		const absence = new WorkbenchAbsence<object>();
		expect(absence.observe([a, b], (v) => v === b, 0)).toEqual([]);
		// a was never on screen: its first showing is not a return.
		expect(absence.observe([a, b], (v) => v === a, 1_000)).toEqual([]);
	});

	it("reports the time from leaving the screen to coming back", () => {
		const absence = new WorkbenchAbsence<object>();
		absence.observe([a, b], (v) => v === a, 0);
		absence.observe([a, b], (v) => v === b, 1_000);
		// Passes in between that change nothing do not move the start.
		absence.observe([a, b], (v) => v === b, 5_000);
		absence.observe([a, b], () => false, 6_000);
		expect(absence.observe([a, b], (v) => v === a, 61_000)).toEqual([
			{ view: a, awayMs: 60_000 },
		]);
		// Staying on screen is not another return.
		expect(absence.observe([a, b], (v) => v === a, 99_000)).toEqual([]);
	});

	it("forgets a workbench that is gone", () => {
		const absence = new WorkbenchAbsence<object>();
		absence.observe([a], () => true, 0);
		absence.observe([a], () => false, 1_000);
		absence.observe([], () => false, 2_000);
		expect(absence.observe([a], () => true, 3_000)).toEqual([]);
	});
});
