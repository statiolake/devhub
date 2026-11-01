import { describe, expect, it } from "vitest";
import { WorkbenchAbsence } from "./workbenchAbsence.js";

describe("how long a workbench has been off screen", () => {
	const a = { name: "a" };
	const b = { name: "b" };

	it("answers how long a workbench has been away, never-shown ones included", () => {
		const absence = new WorkbenchAbsence<object>();
		absence.observe([a, b], (v) => v === a, 0);
		expect(absence.awayMs(a, 5_000)).toBeUndefined();
		expect(absence.awayMs(b, 5_000)).toBe(5_000);
		absence.observe([a, b], (v) => v === b, 10_000);
		expect(absence.awayMs(a, 70_000)).toBe(60_000);
		expect(absence.awayMs(b, 70_000)).toBeUndefined();
	});

	it("counts from leaving the screen, not from the passes after", () => {
		const absence = new WorkbenchAbsence<object>();
		absence.observe([a, b], (v) => v === a, 0);
		absence.observe([a, b], (v) => v === b, 1_000);
		absence.observe([a, b], (v) => v === b, 5_000);
		absence.observe([a, b], () => false, 6_000);
		expect(absence.awayMs(a, 61_000)).toBe(60_000);
	});

	it("forgets a workbench that is gone", () => {
		const absence = new WorkbenchAbsence<object>();
		absence.observe([a], () => false, 0);
		absence.observe([], () => false, 2_000);
		expect(absence.awayMs(a, 3_000)).toBeUndefined();
	});
});
