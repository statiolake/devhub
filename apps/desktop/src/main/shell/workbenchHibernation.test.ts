import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CAP_MIN_AWAY_MS,
	WAKE_DELAY_MS,
	WorkbenchSleep,
	capCandidates,
	hibernate,
	type Hibernating,
} from "./workbenchHibernation.js";

/** A workbench away for `awayFor` checks, then shown again. */
function workbench(
	options: {
		awayFor?: number;
		reasons?: readonly string[] | Error;
		vetoed?: boolean;
	} = {},
) {
	let checks = 0;
	const calls: string[] = [];
	const fake = {
		calls,
		away: () => ++checks <= (options.awayFor ?? Infinity),
		keepAwake: vi.fn(() => {
			calls.push("keepAwake");
			const reasons = options.reasons ?? [];
			return reasons instanceof Error
				? Promise.reject(reasons)
				: Promise.resolve(reasons);
		}),
		unload: vi.fn(() => {
			calls.push("unload");
			return Promise.resolve(options.vetoed ?? false);
		}),
		sleep: vi.fn(() => {
			calls.push("sleep");
		}),
	} satisfies Hibernating & { calls: string[] };
	return fake;
}

describe("closing a workbench that has been away", () => {
	it("asks, unloads gracefully, then destroys it", async () => {
		const one = workbench();
		expect(await hibernate(one)).toBe(true);
		expect(one.calls).toEqual(["keepAwake", "unload", "sleep"]);
	});

	it("leaves one that is not away long enough alone", async () => {
		const one = workbench({ awayFor: 0 });
		expect(await hibernate(one)).toBe(false);
		expect(one.calls).toEqual([]);
	});

	it("keeps one up that would lose unsaved work, a terminal process or a debug session", async () => {
		const one = workbench({ reasons: ["main.ts", "terminal zsh"] });
		expect(await hibernate(one)).toBe(false);
		expect(one.calls).toEqual(["keepAwake"]);
	});

	it("keeps one up that does not answer", async () => {
		const one = workbench({ reasons: new Error("no reply") });
		expect(await hibernate(one)).toBe(false);
		expect(one.unload).not.toHaveBeenCalled();
	});

	it("keeps one up that came back while it was being asked", async () => {
		const one = workbench({ awayFor: 1 });
		expect(await hibernate(one)).toBe(false);
		expect(one.unload).not.toHaveBeenCalled();
	});

	it("keeps one up whose unload was vetoed", async () => {
		const one = workbench({ vetoed: true });
		expect(await hibernate(one)).toBe(false);
		expect(one.sleep).not.toHaveBeenCalled();
	});
});

/**
 * The controller's side, as `appController.ts` wires it: a projection runs
 * `syncEditorViews` (wake the shown one) and then `syncEditorView` (open the
 * shown one), and a view announces itself loaded a moment after it opens.
 */
function controller() {
	const views = new Set<string>();
	const restarting = new Set<string>();
	let selected: string | undefined;
	const sync = () => {
		if (sleep.shown(selected) && selected !== undefined) {
			restarting.add(selected);
		}
		if (selected !== undefined) open(selected);
	};
	const sleep = new WorkbenchSleep(sync);
	const open = (folder: string) => {
		if (views.has(folder) || !sleep.mayOpen(folder)) return;
		views.add(folder);
		setTimeout(() => {
			restarting.delete(folder);
			sleep.awake(folder);
		}, 300);
	};
	const putToSleep = (folder: string) =>
		sleep.hibernate(folder, {
			away: () => selected !== folder,
			keepAwake: () => Promise.resolve([]),
			unload: () => Promise.resolve(false),
			sleep: () => {
				views.delete(folder);
				sync();
			},
		});
	return {
		sleep,
		views,
		restarting,
		putToSleep,
		select(folder: string | undefined, passing = false) {
			if (passing) sleep.pass(folder);
			selected = folder;
			sync();
		},
	};
}

describe("waking a workbench", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("waits a moment when Cmd+Q N/P lands on an asleep one", async () => {
		const app = controller();
		app.select("a");
		app.select("b");
		await app.putToSleep("a");
		app.select("a", true);
		expect(app.views.has("a")).toBe(false);
		vi.advanceTimersByTime(WAKE_DELAY_MS - 1);
		expect(app.views.has("a")).toBe(false);
		vi.advanceTimersByTime(1);
		expect(app.views.has("a")).toBe(true);
		expect(app.restarting.has("a")).toBe(true);
		vi.advanceTimersByTime(300);
		expect(app.restarting.has("a")).toBe(false);
	});

	it("wakes at once on a typed key, and not at all when passed by", async () => {
		const app = controller();
		app.select("a");
		app.select("c");
		await app.putToSleep("a");
		app.select("a", true);
		app.select("c", true);
		vi.advanceTimersByTime(WAKE_DELAY_MS);
		expect(app.views.has("a")).toBe(false);
		app.select("a", true);
		app.sleep.release();
		expect(app.views.has("a")).toBe(true);
	});

	it("is never left restarting after switching around", async () => {
		const app = controller();
		for (const folder of ["a", "b", "c"]) app.select(folder);
		await app.putToSleep("a");
		await app.putToSleep("b");
		for (const folder of ["a", "b", "c", "a", "b", "a", "c", "a"]) {
			app.select(folder, true);
			vi.advanceTimersByTime(400);
		}
		vi.advanceTimersByTime(5_000);
		expect(app.restarting).toEqual(new Set());
		expect(app.views.has("a")).toBe(true);
	});

	it("does not sleep one that is waking or already going", async () => {
		const app = controller();
		app.select("a");
		app.select("b");
		await app.putToSleep("a");
		app.select("a");
		expect(await app.putToSleep("a")).toBe(false);
		vi.advanceTimersByTime(300);
		app.select("b");
		const first = app.putToSleep("a");
		expect(await app.putToSleep("a")).toBe(false);
		expect(await first).toBe(true);
	});

	it("wakes one shown again while it was unloading", async () => {
		const app = controller();
		app.select("a");
		app.select("b");
		const going = app.sleep.hibernate("a", {
			away: () => true,
			keepAwake: () => Promise.resolve([]),
			unload: () => {
				app.select("a");
				return Promise.resolve(false);
			},
			sleep: () => {
				app.views.delete("a");
				app.select("a");
			},
		});
		expect(await going).toBe(true);
		expect(app.views.has("a")).toBe(true);
		vi.advanceTimersByTime(300);
		expect(app.restarting).toEqual(new Set());
	});
});

describe("the cap on awake workbenches", () => {
	it("closes only ones away a while, least recently shown first", () => {
		const awayMs = new Map([
			["shown", undefined],
			["passed", 400],
			["old", CAP_MIN_AWAY_MS * 5],
			["older", CAP_MIN_AWAY_MS * 9],
		]);
		expect(
			capCandidates([...awayMs.keys()], (key) => awayMs.get(key), 2),
		).toEqual({
			candidates: ["older", "old"],
			excess: 2,
		});
	});

	it("has no excess without a cap", () => {
		expect(capCandidates(["a"], () => 1e9, 0).excess).toBe(0);
	});
});
