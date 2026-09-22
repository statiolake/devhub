import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { MidnightTimer, scratchDay } from "./scratchDay.js";

describe("today's Scratch folder", () => {
	let home: string;
	beforeEach(() => {
		home = makeScratchDir("scratch-day");
	});
	afterEach(() => {
		removeScratchDir(home);
	});

	it("is made on demand, under ~, and resolved", async () => {
		const day = await scratchDay(
			"~/junk/YYYYMMDD",
			new Date(2026, 8, 23, 9, 30),
			home,
		);
		expect(day.failure).toBeUndefined();
		const expected = join(realpathSync(home), "junk", "20260923");
		expect(statSync(expected).isDirectory()).toBe(true);
		expect(day.workspace.root).toBe(expected);
		expect(day.workspace.location).toEqual({ kind: "local", path: expected });
	});

	it("uses the folder that is already there", async () => {
		mkdirSync(join(home, "junk", "20260923"), { recursive: true });
		writeFileSync(join(home, "junk", "20260923", "notes.txt"), "kept");
		const day = await scratchDay(
			`${home}/junk/YYYYMMDD`,
			new Date(2026, 8, 23),
			"/nowhere",
		);
		expect(day.failure).toBeUndefined();
		expect(statSync(join(day.workspace.root, "notes.txt")).isFile()).toBe(true);
	});

	it("says why, and still names the folder, when it cannot be made", async () => {
		// A file where the parent folder has to be.
		writeFileSync(join(home, "junk"), "not a folder");
		const day = await scratchDay(
			"~/junk/YYYYMMDD",
			new Date(2026, 8, 23),
			home,
		);
		expect(day.failure).toContain(`${home}/junk/20260923`);
		expect(day.workspace.root).toBe(`${home}/junk/20260923`);
	});
});

describe("MidnightTimer", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires at the next local midnight, and at the one after", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 22, 23, 59, 0));
		const fired: string[] = [];
		const timer = new MidnightTimer(() => {
			const now = new Date();
			fired.push(`${String(now.getDate())} ${String(now.getHours())}`);
		});
		timer.arm();
		vi.advanceTimersByTime(59_000);
		expect(fired).toEqual([]);
		vi.advanceTimersByTime(1_000);
		expect(fired).toEqual(["23 0"]);
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		expect(fired).toEqual(["23 0", "24 0"]);
		timer.stop();
	});

	it("catches up on a re-arm after a sleep across midnight", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 22, 22, 0));
		let fired = 0;
		const timer = new MidnightTimer(() => {
			fired += 1;
		});
		timer.arm();
		// The clock jumps past midnight without the timer running, as a sleep does.
		vi.setSystemTime(new Date(2026, 8, 23, 7, 0));
		timer.rearm();
		expect(fired).toBe(1);
		// And it is aimed at the next midnight from the new now, not the old one.
		// The stale timer, aimed two hours on from 22:00, is gone.
		vi.advanceTimersByTime(17 * 60 * 60 * 1000 - 1);
		expect(fired).toBe(1);
		vi.advanceTimersByTime(1);
		expect(fired).toBe(2);
		timer.stop();
	});
});
