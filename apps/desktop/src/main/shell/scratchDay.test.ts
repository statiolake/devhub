import {
	existsSync,
	mkdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import type { AppErrorWire } from "../../ipc/appShell.js";
import { localWorkspace } from "../../model/testWorkspaces.js";
import { errorWireAt } from "../../model/wire.js";
import {
	type ScratchDay,
	ScratchFollower,
	scratchDay,
	scratchRefusal,
} from "./scratchDay.js";

const SETTINGS = "/scratch-test/settings.toml";

function daily(template: string) {
	return { daily: template, settingsFile: SETTINGS };
}

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
			daily("~/junk/YYYYMMDD"),
			new Date(2026, 8, 23, 9, 30),
			home,
		);
		expect(day.unavailable).toBeUndefined();
		const expected = join(realpathSync(home), "junk", "20260923");
		expect(statSync(expected).isDirectory()).toBe(true);
		expect(day.workspace.root).toBe(expected);
		expect(day.workspace.location).toEqual({ kind: "local", path: expected });
	});

	it("uses the folder that is already there", async () => {
		mkdirSync(join(home, "junk", "20260923"), { recursive: true });
		writeFileSync(join(home, "junk", "20260923", "notes.txt"), "kept");
		const day = await scratchDay(
			daily(`${home}/junk/YYYYMMDD`),
			new Date(2026, 8, 23),
			"/nowhere",
		);
		expect(day.unavailable).toBeUndefined();
		expect(statSync(join(day.workspace.root, "notes.txt")).isFile()).toBe(true);
	});

	it("says why, and still names the folder, when it cannot be made", async () => {
		// A file where the parent folder has to be.
		writeFileSync(join(home, "junk"), "not a folder");
		const day = await scratchDay(
			daily("~/junk/YYYYMMDD"),
			new Date(2026, 8, 23),
			home,
		);
		expect(day.unavailable).toEqual({
			reason: "root_inaccessible",
			report: expect.stringContaining(`${home}/junk/20260923`),
		});
		expect(day.workspace.root).toBe(`${home}/junk/20260923`);
	});

	it("makes no folder at all when DevHub runs on no settings, and says so at the settings file", async () => {
		const day = await scratchDay(
			{ daily: undefined, settingsFile: SETTINGS },
			new Date(2026, 8, 23),
			home,
		);
		// Not the default's folder, and nothing under home: the default is a
		// value nobody configured.
		expect(existsSync(join(home, "junk"))).toBe(false);
		expect(day.workspace.root).toBe(SETTINGS);
		// No report of its own: the reason is the settings refusal, which is
		// reported as itself.
		expect(day.unavailable).toEqual({ reason: "settings_refused" });
	});
});

describe("what lands in Scratch without selecting it", () => {
	// `devhub -`, `devhub --wait`, an open no Workspace contains and a request
	// for an empty window all go through Scratch's workbench, and this is what
	// decides whether there is one to give.
	const refusal = (): AppErrorWire => errorWireAt("settings_refused");

	it("goes ahead when Scratch is a folder that is there", () => {
		expect(
			scratchRefusal(localWorkspace("/scratch-test/day"), refusal),
		).toBeUndefined();
	});

	it("is refused with the settings refusal itself while Scratch is the stand-in", () => {
		const standIn = localWorkspace(SETTINGS);
		standIn.markUnavailable("settings_refused");
		const settings = refusal();
		expect(scratchRefusal(standIn, () => settings)).toBe(settings);
	});

	it("is refused, naming the folder, when the day's folder could not be made", () => {
		const day = localWorkspace("/scratch-test/day");
		day.markUnavailable("root_inaccessible");
		const refused = scratchRefusal(day, refusal);
		expect(refused?.code).toBe("workspace_unavailable");
		expect(refused?.detail).toContain("/scratch-test/day");
	});
});

describe("ScratchFollower", () => {
	let home: string;
	let adopted: ScratchDay[];
	let waiting: { count: number; resolve: () => void }[];
	beforeEach(() => {
		home = makeScratchDir("scratch-follower");
		adopted = [];
		waiting = [];
	});
	afterEach(() => {
		vi.useRealTimers();
		removeScratchDir(home);
	});

	function follower(template: string | undefined): ScratchFollower {
		return new ScratchFollower(template, {
			settingsFile: SETTINGS,
			home,
			adopt: (day) => {
				adopted.push(day);
				for (const waiter of waiting.filter((w) => w.count <= adopted.length)) {
					waiter.resolve();
				}
				return Promise.resolve();
			},
		});
	}

	/**
	 * A midnight's adoption makes a folder, which is real I/O a fake timer
	 * does not wait for; this does.
	 */
	function adoptions(count: number): Promise<void> {
		if (adopted.length >= count) return Promise.resolve();
		return new Promise((resolve) => waiting.push({ count, resolve }));
	}

	const roots = (): string[] => adopted.map((day) => day.workspace.root);

	it("moves Scratch to the folder a new daily names for today, the moment it is accepted", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(new Date(2026, 8, 23, 9, 0));
		const scratch = follower("~/a/YYYYMMDD");
		scratch.start();
		await scratch.settingsAccepted("~/b/YYYY/MMDD");
		expect(roots()).toEqual([join(realpathSync(home), "b", "2026", "0923")]);
		// The same daily again is not a change.
		await scratch.settingsAccepted("~/b/YYYY/MMDD");
		expect(adopted).toHaveLength(1);
		scratch.stop();
	});

	it("follows the daily it was last given at midnight, not the one it started with", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(new Date(2026, 8, 23, 23, 0));
		const scratch = follower("~/a/YYYYMMDD");
		scratch.start();
		await scratch.settingsAccepted("~/b/YYYYMMDD");
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		await adoptions(2);
		expect(roots()).toEqual([
			join(realpathSync(home), "b", "20260923"),
			join(realpathSync(home), "b", "20260924"),
		]);
		expect(existsSync(join(home, "a"))).toBe(false);
		scratch.stop();
	});

	it("makes nothing while there are no settings, and moves to today's folder when they are accepted", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(new Date(2026, 8, 23, 23, 0));
		const scratch = follower(undefined);
		scratch.start();
		// Midnight and a wake, with nothing to make a folder from.
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		await adoptions(1);
		await scratch.resumed();
		expect(roots()).toEqual([SETTINGS, SETTINGS]);
		expect(
			adopted.every((day) => day.unavailable?.reason === "settings_refused"),
		).toBe(true);
		expect(existsSync(join(home, "junk"))).toBe(false);
		await scratch.settingsAccepted("~/daily/YYYYMMDD");
		expect(roots().at(-1)).toBe(join(realpathSync(home), "daily", "20260924"));
		expect(adopted.at(-1)?.unavailable).toBeUndefined();
		scratch.stop();
	});

	it("fires at the next local midnight, and at the one after", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(new Date(2026, 8, 22, 23, 59, 0));
		const scratch = follower("~/d/YYYYMMDD");
		scratch.start();
		await vi.advanceTimersByTimeAsync(59_000);
		expect(roots()).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_000);
		await adoptions(1);
		expect(roots().map((root) => root.slice(-8))).toEqual(["20260923"]);
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		await adoptions(2);
		expect(roots().map((root) => root.slice(-8))).toEqual([
			"20260923",
			"20260924",
		]);
		scratch.stop();
	});

	it("catches up on a wake after a sleep across midnight, and aims from the new now", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(new Date(2026, 8, 22, 22, 0));
		const scratch = follower("~/d/YYYYMMDD");
		scratch.start();
		// The clock jumps past midnight without the timer running, as a sleep does.
		vi.setSystemTime(new Date(2026, 8, 23, 7, 0));
		await scratch.resumed();
		expect(adopted).toHaveLength(1);
		// The stale timer, aimed two hours on from 22:00, is gone.
		await vi.advanceTimersByTimeAsync(17 * 60 * 60 * 1000 - 1);
		expect(adopted).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await adoptions(2);
		expect(adopted).toHaveLength(2);
		scratch.stop();
	});
});
