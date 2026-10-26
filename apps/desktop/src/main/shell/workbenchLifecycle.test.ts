import { describe, expect, it } from "vitest";
import {
	EditorSupervisor,
	MAX_EDITOR_RESTARTS,
	RESTART_BACKOFF_MS,
} from "./editorSupervisor.js";
import {
	HIBERNATE_CHECK_MS,
	OPEN_SETTLE_MS,
	WAKE_DELAY_MS,
	WorkbenchLifecycle,
	placeholderOf,
	type EditorPlaceholder,
	type LifecycleEffect,
	type WorkbenchPhase,
} from "./workbenchLifecycle.js";
import { workspacesWantingWorkbenches } from "./workbenchMode.js";

interface Workspace {
	sleepable: boolean;
	closing: boolean;
	wanted: boolean;
}

/**
 * The executor, as `AppController.reconcileWorkbenches` is, over a fake
 * window: views come and go only through the effects, and the clock only
 * moves when a test says so. An open does not finish by itself — `load`
 * finishes it — so a test can stand in the middle of one.
 */
function harness(
	options: { awakeMax?: number; hibernateAfterMs?: number } = {},
) {
	const logs: string[] = [];
	const life = new WorkbenchLifecycle(new EditorSupervisor(), (line) => {
		logs.push(line);
	});
	const workspaces = new Map<string, Workspace>();
	const views = new Set<string>();
	/** Opens in flight, as the executor's `workbenchOpens` holds them. */
	const loading = new Set<string>();
	/** What each surface was last told, by surface key. */
	const surfaces = new Map<string, EditorPlaceholder>();
	/** A relocated Workspace keeps its slot: folder → surface key. */
	const surfaceOf = new Map<string, string>();
	const leftAt = new Map<string, number>();
	const placeholders = new Map<string, EditorPlaceholder>();
	const told: { surfaceKey: string; placeholder?: EditorPlaceholder }[] = [];
	const effects: LifecycleEffect[] = [];
	let now = 0;
	let selected: string | undefined;
	let awakeMax = options.awakeMax ?? 3;

	const plan = (tick = false) => {
		for (const [folder] of workspaces) {
			if (folder !== selected && !leftAt.has(folder)) leftAt.set(folder, now);
		}
		const done = life.plan({
			now,
			wanted: [...workspaces]
				.filter(([, one]) => one.wanted)
				.map(([folder, one]) => ({
					folder,
					surfaceKey: surfaceOf.get(folder) ?? `surface:${folder}`,
					sleepable: one.sleepable,
					closing: one.closing,
					awayMs:
						folder === selected || !views.has(folder)
							? undefined
							: now - (leftAt.get(folder) ?? now),
				})),
			selected,
			views: [...views],
			loading: [...loading],
			awakeMax,
			hibernateAfterMs: options.hibernateAfterMs ?? 10 * 60_000,
			tick,
		});
		for (const effect of done) {
			if (effect.kind === "dispose") views.delete(effect.folder);
			if (effect.kind === "open") loading.add(effect.folder);
			if (effect.kind === "placeholder") {
				if (effect.placeholder) {
					surfaces.set(effect.surfaceKey, effect.placeholder);
				} else surfaces.delete(effect.surfaceKey);
				const folder = effect.surfaceKey.slice("surface:".length);
				told.push({
					surfaceKey: effect.surfaceKey,
					...(effect.placeholder ? { placeholder: effect.placeholder } : {}),
				});
				if (effect.placeholder) placeholders.set(folder, effect.placeholder);
				else placeholders.delete(folder);
			}
		}
		effects.push(...done);
		return done;
	};

	const app = {
		life,
		logs,
		views,
		placeholders,
		surfaces,
		told,
		effects,
		plan,
		/** The cap moved, then one plan. */
		planWith(change: { awakeMax: number }) {
			awakeMax = change.awakeMax;
			return plan();
		},
		get now() {
			return now;
		},
		get selected() {
			return selected;
		},
		isWanted(folder: string) {
			return workspaces.get(folder)?.wanted === true;
		},
		/** Workspaces, all sleepable but `ssh…` ones (SSH, dev containers). */
		add(...folders: string[]) {
			for (const folder of folders) {
				workspaces.set(folder, {
					sleepable: !folder.startsWith("ssh"),
					closing: false,
					wanted: true,
				});
			}
			return plan();
		},
		set(folder: string, change: Partial<Workspace>) {
			const one = workspaces.get(folder);
			if (one) Object.assign(one, change);
			return plan();
		},
		remove(folder: string) {
			workspaces.delete(folder);
			return plan();
		},
		/** The same Workspace, its folder moved (Locate…): the same slot. */
		relocate(from: string, to: string) {
			const one = workspaces.get(from);
			if (!one) return plan();
			surfaceOf.set(to, surfaceOf.get(from) ?? `surface:${from}`);
			workspaces.delete(from);
			workspaces.set(to, one);
			if (selected === from) selected = to;
			return plan();
		},
		select(folder: string | undefined, passing = false) {
			if (selected !== undefined && selected !== folder) {
				leftAt.set(selected, now);
			}
			if (passing) life.pass(folder, now);
			selected = folder;
			if (folder !== undefined) leftAt.delete(folder);
			return plan();
		},
		advance(ms: number) {
			const until = now + ms;
			for (;;) {
				const deadline = life.nextDeadline();
				if (deadline === undefined || deadline > until) break;
				now = Math.max(now, deadline);
				plan();
			}
			now = until;
		},
		tick() {
			now += HIBERNATE_CHECK_MS;
			return plan(true);
		},
		/** The open finished and its view loaded. */
		load(folder: string) {
			loading.delete(folder);
			views.add(folder);
			life.loaded(folder, now);
			return plan();
		},
		/** Bring every opening workbench up. */
		loadAll() {
			for (const [folder] of workspaces) {
				if (life.phase(folder).kind === "opening") app.load(folder);
			}
		},
		/**
		 * The open finished with its view, and the page had loaded before
		 * anyone listened: no loaded event, ever.
		 */
		arriveUnheard(folder: string) {
			loading.delete(folder);
			views.add(folder);
			return plan();
		},
		/** The open finished with its view, whose page is still loading. */
		arriveLoading(folder: string) {
			views.add(folder);
			return plan();
		},
		/** The open's effect never ran (the executor threw before it). */
		lose(folder: string) {
			loading.delete(folder);
			return plan();
		},
		fail(folder: string, reason = "The workbench process ended.") {
			loading.delete(folder);
			views.delete(folder);
			life.failed(folder, reason, now);
			return plan();
		},
		/** The hibernate effect, carried out: unloaded, or kept awake. */
		sleep(folder: string, frame = `frame:${folder}`) {
			if (!life.mayHibernate(folder)) {
				life.hibernateSkipped(folder, "shown again", now);
			} else {
				life.hibernated(folder, frame);
			}
			return plan();
		},
		refuse(folder: string, reason = "terminal zsh") {
			life.hibernateSkipped(folder, reason, now);
			return plan();
		},
		/** Carry out every pending hibernate effect, all agreeing. */
		sleepAll() {
			for (const [folder] of workspaces) {
				if (life.phase(folder).kind === "hibernating") app.sleep(folder);
			}
		},
		kind(folder: string): WorkbenchPhase["kind"] {
			return life.phase(folder).kind;
		},
		kinds() {
			return Object.fromEntries(
				[...workspaces.keys()].map((folder) => [folder, app.kind(folder)]),
			);
		},
	};
	return app;
}

const opens = (effects: readonly LifecycleEffect[]) =>
	effects.flatMap((effect) =>
		effect.kind === "open" ? [`${effect.folder} ${effect.cause}`] : [],
	);
const hibernations = (effects: readonly LifecycleEffect[]) =>
	effects.flatMap((effect) =>
		effect.kind === "hibernate" ? [`${effect.folder} ${effect.why}`] : [],
	);

/** a, b, c awake with a shown last; then d added and shown, cap 3. */
function fourAwake() {
	const app = harness({ awakeMax: 4 });
	app.add("a", "b", "c", "d");
	app.loadAll();
	for (const folder of ["d", "c", "b", "a"]) {
		app.advance(1_000);
		app.select(folder);
	}
	return app;
}

describe("opening workbenches", () => {
	it("opens every wanted workbench once, the selected one first", () => {
		const app = harness();
		app.select("b");
		const effects = app.add("scratch", "a", "b");
		expect(opens(effects)).toEqual(["b start", "scratch start", "a start"]);
		expect(opens(app.plan())).toEqual([]);
		expect(app.kinds()).toEqual({
			scratch: "opening",
			a: "opening",
			b: "opening",
		});
		app.loadAll();
		expect(app.kinds()).toEqual({ scratch: "awake", a: "awake", b: "awake" });
		// A first open stands in for nothing: the slot has never had a workbench.
		expect(app.told).toEqual([]);
	});

	it("takes down the workbench of a Workspace that left, and forgets it", () => {
		const app = harness();
		app.add("a", "b");
		app.loadAll();
		const effects = app.remove("b");
		expect(effects).toContainEqual({ kind: "dispose", folder: "b" });
		expect(app.views.has("b")).toBe(false);
		expect(app.kind("b")).toBe("absent");
	});

	it("adopts a workbench VS Code opened on its own", () => {
		const app = harness();
		app.views.add("a");
		const effects = app.add("a");
		expect(opens(effects)).toEqual([]);
		expect(app.kind("a")).toBe("awake");
	});

	it("does not reopen a closing Workspace whose view went with the close", () => {
		const app = harness();
		app.add("a");
		app.load("a");
		app.set("a", { closing: true });
		app.views.delete("a");
		app.life.disposed("a");
		expect(opens(app.plan())).toEqual([]);
		// The close failed after the view step: it is wanted again.
		expect(opens(app.set("a", { closing: false }))).toEqual(["a start"]);
	});

	it("starts past the cap asleep rather than opening one to close it", () => {
		const app = harness({ awakeMax: 2 });
		app.select("d");
		const effects = app.add("ssh", "scratch", "a", "b", "c", "d");
		// d is selected and opens; SSH never counts; Scratch fills the cap like
		// any local one, and starts first only because it is first in the list.
		expect(opens(effects)).toEqual(["d start", "ssh start", "scratch start"]);
		expect(app.kinds()).toMatchObject({
			a: "asleep",
			b: "asleep",
			c: "asleep",
		});
		expect(app.placeholders.get("b")).toEqual({ kind: "asleep", frame: "" });
		// Shown, it wakes like any asleep one.
		expect(opens(app.select("b"))).toEqual(["b wake"]);
	});

	it("an open ending with the folder no longer wanted is simply forgotten", () => {
		const app = harness();
		app.add("a");
		app.remove("a");
		app.life.abandoned("a");
		expect(app.kind("a")).toBe("absent");
		// Its view arriving anyway is disposed, not kept.
		app.views.add("a");
		expect(app.plan()).toContainEqual({ kind: "dispose", folder: "a" });
	});
});

describe("waking", () => {
	function oneAsleep() {
		const app = harness();
		app.add("a", "b");
		app.loadAll();
		app.select("a");
		app.select("b");
		app.life.pass(undefined, app.now);
		// Put a to sleep by hand, the way the minute check would.
		app.advance(11 * 60_000);
		expect(hibernations(app.tick())).toEqual(["a away"]);
		app.sleep("a");
		expect(app.kind("a")).toBe("asleep");
		return app;
	}

	it("wakes at once when selected by a click", () => {
		const app = oneAsleep();
		expect(opens(app.select("a"))).toEqual(["a wake"]);
		expect(app.placeholders.get("a")).toEqual({
			kind: "waking",
			frame: "frame:a",
		});
		app.load("a");
		expect(app.placeholders.has("a")).toBe(false);
	});

	it("holds a passing Cmd+Q N/P for WAKE_DELAY_MS, then wakes if still there", () => {
		const app = oneAsleep();
		expect(opens(app.select("a", true))).toEqual([]);
		expect(app.kind("a")).toBe("held");
		expect(app.placeholders.get("a")).toEqual({
			kind: "asleep",
			frame: "frame:a",
		});
		expect(app.life.nextDeadline()).toBe(app.now + WAKE_DELAY_MS);
		app.advance(WAKE_DELAY_MS - 1);
		expect(app.kind("a")).toBe("held");
		app.advance(1);
		expect(app.kind("a")).toBe("opening");
		expect(opens(app.effects)).toContain("a wake");
	});

	it("wakes a held one at once on a typed key", () => {
		const app = oneAsleep();
		app.select("a", true);
		expect(app.life.typed(app.now)).toBe(true);
		expect(opens(app.plan())).toEqual(["a wake"]);
		// No hold, nothing to release.
		expect(app.life.typed(app.now)).toBe(false);
	});

	it("wakes a held one at once when a request needs it (an empty window, a file for Scratch)", () => {
		const app = oneAsleep();
		app.select("a", true);
		expect(app.kind("a")).toBe("held");
		// Needing another folder releases nothing.
		app.life.needed("b", app.now);
		expect(opens(app.plan())).toEqual([]);
		app.life.needed("a", app.now);
		expect(opens(app.plan())).toEqual(["a wake"]);
	});

	it("does not wake one that was only passed through", () => {
		const app = oneAsleep();
		app.select("a", true);
		app.advance(300);
		app.select("b", true);
		expect(app.kind("a")).toBe("asleep");
		app.advance(5 * WAKE_DELAY_MS);
		expect(app.kind("a")).toBe("asleep");
		expect(opens(app.effects)).not.toContain("a wake");
	});
});

describe("the cap on awake workbenches", () => {
	it("puts the least recently shown to sleep the moment a switch goes over it", () => {
		const app = fourAwake();
		app.effects.length = 0;
		// Lowering the cap is the same fact as waking a fifth: over it.
		const effects = harnessCap(app, 3);
		expect(hibernations(effects)).toEqual(["d cap"]);
		expect(app.kind("d")).toBe("hibernating");
		app.sleep("d");
		expect(app.kind("d")).toBe("asleep");
		expect(app.views.has("d")).toBe(false);
		expect(app.placeholders.get("d")).toEqual({
			kind: "asleep",
			frame: "frame:d",
		});
		expect(hibernations(app.plan())).toEqual([]);
	});

	it("evaluates it on the switch that wakes one, putting exactly one other to sleep", () => {
		const app = harness();
		app.add("a", "b", "c", "d");
		// d starts asleep: the cap was full at launch.
		app.loadAll();
		for (const folder of ["c", "b", "a"]) {
			app.advance(1_000);
			app.select(folder);
		}
		expect(app.kind("d")).toBe("asleep");
		app.advance(1_000);
		const effects = app.select("d");
		expect(opens(effects)).toEqual(["d wake"]);
		// Four up or opening: c, shown longest ago, goes now — not d (opening
		// and shown), not a or b.
		expect(hibernations(effects)).toEqual(["c cap"]);
	});

	it("never the shown one, an opening one, a closing one or one that never sleeps", () => {
		const app = harness({ awakeMax: 10 });
		app.add("ssh", "a", "b", "c");
		for (const folder of ["ssh", "a", "b"]) app.load(folder);
		app.select("a");
		app.set("b", { closing: true });
		// a, b up and c opening: three over a cap of one, and not one may go.
		expect(hibernations(harnessCap(app, 1))).toEqual([]);
		expect(app.logs.at(-1)).toBe(
			"[devhub] workbench cap: 3 awake, cap 1, none more may sleep ('a' is shown, 'b' is closing, 'c' is opening)",
		);
		// c up and away: it is the one.
		expect(hibernations(app.load("c"))).toEqual(["c cap"]);
	});

	it("asks the next one when the first says it must stay up, and leaves that one be until the minute check", () => {
		const app = fourAwake();
		expect(hibernations(harnessCap(app, 3))).toEqual(["d cap"]);
		const next = app.refuse("d", "terminal zsh");
		expect(app.kind("d")).toBe("awake");
		expect(hibernations(next)).toEqual(["c cap"]);
		app.sleep("c");
		// Back over the cap (a fifth woken): d is still excused, b is next.
		const again = harnessCap(app, 2);
		expect(hibernations(again)).toEqual(["b cap"]);
		expect(app.logs).toContain(
			"[devhub] workbench 'd' hibernating -> awake: stays awake: terminal zsh",
		);
		app.refuse("b", "debug session");
		expect(app.kind("b")).toBe("awake");
		// Nothing else may go: said once, not on every plan.
		app.plan();
		app.plan();
		expect(
			app.logs.filter((line) => line.startsWith("[devhub] workbench cap:")),
		).toHaveLength(1);
		// The minute check asks the refusers again.
		expect(hibernations(app.tick())).toEqual(["d cap"]);
	});

	it("counts Scratch like any local Workspace, and puts it to sleep", () => {
		const app = harness({ awakeMax: 2 });
		app.select("scratch");
		app.add("scratch", "a", "ssh");
		app.loadAll();
		app.advance(1_000);
		// Scratch, a and SSH up: two counted, at the cap.
		expect(hibernations(app.select("a"))).toEqual([]);
		app.add("b");
		app.advance(1_000);
		// b woken by being shown: three counted, and Scratch, shown least
		// recently, is the one that goes.
		const effects = app.select("b");
		expect(opens(effects)).toEqual(["b wake"]);
		expect(hibernations(effects)).toEqual(["scratch cap"]);
		app.sleep("scratch");
		expect(app.kind("scratch")).toBe("asleep");
		expect(app.kind("ssh")).toBe("awake");
		// Selected again — an empty window asked for — it wakes.
		expect(opens(app.select("scratch"))).toEqual(["scratch wake"]);
	});

	it("has no cap at 0", () => {
		const app = fourAwake();
		expect(hibernations(harnessCap(app, 0))).toEqual([]);
	});

	it("does not thrash when Cmd+Q N/P steps through more Workspaces than the cap", () => {
		const folders = ["a", "b", "c", "d", "e", "f", "g"];
		const app = harness();
		app.add(...folders);
		app.loadAll();
		app.effects.length = 0;
		// Round and round, passing, 300 ms on each: a key repeat, or a person
		// looking for one row.
		for (let lap = 0; lap < 5; lap += 1) {
			for (const folder of folders) {
				app.select(folder, true);
				app.advance(300);
			}
		}
		expect(opens(app.effects)).toEqual([]);
		expect(hibernations(app.effects)).toEqual([]);
		// Stopping on one asleep is the one wake, and it puts one other to
		// sleep: the least recently shown awake one.
		app.select("e", true);
		app.advance(WAKE_DELAY_MS);
		expect(opens(app.effects)).toEqual(["e wake"]);
		expect(hibernations(app.effects)).toHaveLength(1);
	});
});

describe("time-based sleep", () => {
	it("is the minute check's, for one away the configured time", () => {
		const app = harness({ awakeMax: 0, hibernateAfterMs: 10 * 60_000 });
		app.add("a", "b", "scratch", "ssh");
		app.loadAll();
		app.select("b");
		app.advance(10 * 60_000);
		// A switch is not the check.
		expect(hibernations(app.select("b"))).toEqual([]);
		// Scratch sleeps like any local Workspace; SSH does not.
		expect(hibernations(app.tick())).toEqual(["a away", "scratch away"]);
	});

	it("is off at 0", () => {
		const app = harness({ awakeMax: 0, hibernateAfterMs: 0 });
		app.add("a", "b");
		app.loadAll();
		app.select("b");
		app.advance(60 * 60_000);
		expect(hibernations(app.tick())).toEqual([]);
	});
});

describe("overlaps", () => {
	it("a workbench shown while it hibernates is not unloaded", () => {
		const app = fourAwake();
		harnessCap(app, 3);
		app.select("d");
		expect(app.life.mayHibernate("d")).toBe(false);
		app.sleep("d");
		expect(app.kind("d")).toBe("awake");
	});

	it("one shown after its unload began wakes as soon as it is asleep", () => {
		const app = fourAwake();
		harnessCap(app, 3);
		app.select("d");
		// The unload was already past the point of asking.
		app.life.hibernated("d", "frame:d");
		const effects = app.plan();
		expect(effects).toContainEqual({ kind: "dispose", folder: "d" });
		expect(opens(effects)).toEqual(["d wake"]);
	});

	it("…unless it was only passed through, when it is held like any asleep one", () => {
		const app = fourAwake();
		harnessCap(app, 3);
		app.select("d", true);
		app.life.hibernated("d", "frame:d");
		expect(opens(app.plan())).toEqual([]);
		expect(app.kind("d")).toBe("held");
	});

	it("never hibernates one that is opening or waking", () => {
		const app = harness({ awakeMax: 10 });
		app.select("b");
		app.add("a", "b");
		expect(hibernations(harnessCap(app, 1))).toEqual([]);
		expect(app.kinds()).toEqual({ a: "opening", b: "opening" });
		// b loads, and is shown.
		expect(hibernations(app.load("b"))).toEqual([]);
		// a loads, away: now it may.
		expect(hibernations(app.load("a"))).toEqual(["a cap"]);
	});

	it("a crash while asleep is no crash; one while waking restarts it", () => {
		const app = fourAwake();
		harnessCap(app, 3);
		app.sleep("d");
		app.fail("d");
		expect(app.kind("d")).toBe("asleep");
		app.select("d");
		app.fail("d", "renderer gone");
		expect(app.kind("d")).toBe("restart-waiting");
		expect(app.placeholders.get("d")).toEqual({ kind: "restarting" });
		app.advance(RESTART_BACKOFF_MS);
		expect(app.kind("d")).toBe("opening");
		expect(opens(app.effects)).toContain("d restart");
		expect(app.placeholders.get("d")).toEqual({ kind: "restarting" });
		app.load("d");
		expect(app.placeholders.has("d")).toBe(false);
	});

	it("a crash while hibernating is the sleep it was going to", () => {
		const app = fourAwake();
		harnessCap(app, 3);
		app.fail("d");
		expect(app.kind("d")).toBe("asleep");
		expect(app.life.phase("d")).toEqual({ kind: "asleep", frame: "" });
		// The unload's answer, arriving after, only brings the frame it took.
		app.life.hibernateSkipped("d", "late", app.now);
		app.life.hibernated("d", "frame:d");
		expect(app.life.phase("d")).toEqual({ kind: "asleep", frame: "frame:d" });
	});

	it("a restart waiting out its backoff is not hibernated, by the cap or the clock", () => {
		const app = fourAwake();
		app.fail("d");
		expect(app.kind("d")).toBe("restart-waiting");
		// a shown; b and c go, d (least recently shown of all) does not.
		expect(hibernations(harnessCap(app, 1))).toEqual(["c cap", "b cap"]);
		app.sleepAll();
		app.advance(RESTART_BACKOFF_MS);
		expect(app.kind("d")).toBe("opening");
		// Opening, it may not go either.
		expect(hibernations(app.tick())).toEqual([]);
		app.load("d");
		// Up again, away and over the cap: now it is the one to go.
		expect(app.kind("d")).toBe("hibernating");
	});

	it("an open that gave up waiting, then arrived, is adopted rather than opened twice", () => {
		const app = harness();
		app.add("a");
		app.fail("a", "did not open within 30 seconds");
		app.views.add("a");
		expect(opens(app.plan())).toEqual([]);
		expect(app.kind("a")).toBe("awake");
	});
});

describe("giving up", () => {
	function exhausted() {
		const app = harness();
		app.add("a");
		for (let attempt = 0; attempt < MAX_EDITOR_RESTARTS; attempt += 1) {
			app.fail("a");
			app.advance(60_000);
		}
		app.effects.length = 0;
		app.fail("a");
		return app;
	}

	it("stops after the ceiling and reports it once", () => {
		const app = exhausted();
		expect(app.kind("a")).toBe("gave-up");
		expect(
			app.effects.filter((effect) => effect.kind === "report-gave-up"),
		).toEqual([
			{
				kind: "report-gave-up",
				folder: "a",
				reason: "The workbench process ended.",
				attempt: MAX_EDITOR_RESTARTS + 1,
			},
		]);
		for (let i = 0; i < 30; i += 1) app.plan();
		expect(
			app.effects.filter((effect) => effect.kind === "report-gave-up"),
		).toHaveLength(1);
		expect(opens(app.effects)).toEqual([]);
		// Nothing stands in: the Workspace's own unavailable state does.
		expect(app.placeholders.has("a")).toBe(false);
	});

	it("is parked while the Workspace is unavailable, and forgotten when a person brings it back", () => {
		const app = exhausted();
		app.set("a", { wanted: false });
		expect(app.kind("a")).toBe("parked");
		expect(opens(app.plan())).toEqual([]);
		expect(opens(app.set("a", { wanted: true }))).toEqual(["a start"]);
		// The count starts again: the next failure waits the shortest time.
		app.fail("a");
		expect(app.life.phase("a")).toEqual({
			kind: "restart-waiting",
			until: app.now + RESTART_BACKOFF_MS,
		});
	});
});

describe("the placeholder is the phase", () => {
	it("maps each phase to what the slot shows", () => {
		expect(placeholderOf({ kind: "absent" })).toBeUndefined();
		expect(
			placeholderOf({ kind: "opening", cause: "start", frame: "" }),
		).toBeUndefined();
		expect(
			placeholderOf({ kind: "opening", cause: "restart", frame: "" }),
		).toEqual({ kind: "restarting" });
		expect(
			placeholderOf({ kind: "opening", cause: "wake", frame: "f" }),
		).toEqual({ kind: "waking", frame: "f" });
		expect(placeholderOf({ kind: "awake" })).toBeUndefined();
		expect(
			placeholderOf({ kind: "hibernating", why: "cap", shown: false }),
		).toBeUndefined();
		expect(placeholderOf({ kind: "asleep", frame: "f" })).toEqual({
			kind: "asleep",
			frame: "f",
		});
		expect(placeholderOf({ kind: "held", frame: "f", until: 1 })).toEqual({
			kind: "asleep",
			frame: "f",
		});
		expect(placeholderOf({ kind: "restart-waiting", until: 1 })).toEqual({
			kind: "restarting",
		});
		expect(
			placeholderOf({ kind: "gave-up", reason: "", attempt: 6 }),
		).toBeUndefined();
		expect(placeholderOf({ kind: "parked" })).toBeUndefined();
	});

	it("is said when it changes and only then, and taken down when the Workspace goes", () => {
		const app = fourAwake();
		harnessCap(app, 3);
		app.sleep("d");
		app.plan();
		app.plan();
		app.select("d", true);
		app.advance(WAKE_DELAY_MS);
		app.load("d");
		expect(app.told.filter((one) => one.surfaceKey === "surface:d")).toEqual([
			{
				surfaceKey: "surface:d",
				placeholder: { kind: "asleep", frame: "frame:d" },
			},
			{
				surfaceKey: "surface:d",
				placeholder: { kind: "waking", frame: "frame:d" },
			},
			{ surfaceKey: "surface:d" },
		]);
		// One asleep that leaves the model takes its placeholder with it.
		app.sleepAll();
		expect(app.placeholders.get("c")).toEqual({
			kind: "asleep",
			frame: "frame:c",
		});
		app.remove("c");
		expect(app.placeholders.size).toBe(0);
		expect(app.told.at(-1)).toEqual({ surfaceKey: "surface:c" });
	});

	it("never outlives its state, whatever the order of events", () => {
		// A seeded walk through every event there is; at every step the slot
		// says exactly what the phase says.
		let seed = 7;
		const random = (n: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed % n;
		};
		const folders = ["a", "b", "c", "d", "e"];
		const app = harness({ awakeMax: 2, hibernateAfterMs: 120_000 });
		app.add(...folders);
		const visited = new Set<string>();
		for (let step = 0; step < 2_000; step += 1) {
			const folder = folders[random(folders.length)] ?? "a";
			switch (random(9)) {
				case 0:
					app.select(folder, random(2) === 0);
					break;
				case 1:
					if (app.kind(folder) === "opening") app.load(folder);
					break;
				case 2:
					app.fail(folder);
					break;
				case 3:
					if (app.kind(folder) === "hibernating") app.sleep(folder);
					break;
				case 4:
					if (app.kind(folder) === "hibernating") app.refuse(folder);
					break;
				case 5:
					app.advance(random(1_500));
					break;
				case 6:
					app.tick();
					break;
				case 7:
					if (app.life.typed(app.now)) app.plan();
					break;
				case 8:
					app.set(folder, { wanted: random(6) !== 0 });
					break;
			}
			for (const one of folders) {
				expect(app.placeholders.get(one)).toEqual(app.life.placeholder(one));
				visited.add(app.kind(one));
			}
		}
		// The walk went everywhere there is to go.
		expect([...visited].sort()).toEqual([
			"absent",
			"asleep",
			"awake",
			"gave-up",
			"held",
			"hibernating",
			"opening",
			"parked",
			"restart-waiting",
		]);
	});
});

describe("a selected one always comes up", () => {
	/** a, b, c, d awake, cap 3: d asleep, a shown. */
	function dAsleep() {
		const app = fourAwake();
		harnessCap(app, 3);
		app.sleep("d");
		expect(app.kind("d")).toBe("asleep");
		return app;
	}

	it("is up when its page finished loading before anyone listened (no loaded event)", () => {
		const app = dAsleep();
		expect(opens(app.select("d"))).toEqual(["d wake"]);
		app.arriveUnheard("d");
		expect(app.kind("d")).toBe("awake");
		expect(app.placeholders.get("d")).toBeUndefined();
		expect(app.logs).toContain(
			"[devhub] workbench 'd' opening -> awake: adopted: its load was not heard",
		);
	});

	it("is opened again when its open's effect never ran, rather than left opening", () => {
		const app = dAsleep();
		app.select("d");
		app.lose("d");
		expect(app.kind("d")).toBe("restart-waiting");
		app.advance(RESTART_BACKOFF_MS);
		expect(app.kind("d")).toBe("opening");
		app.load("d");
		expect(app.kind("d")).toBe("awake");
	});

	it("is settled when its load is never heard at all, within OPEN_SETTLE_MS", () => {
		const app = dAsleep();
		app.select("d");
		app.arriveLoading("d");
		expect(app.kind("d")).toBe("opening");
		expect(app.life.nextDeadline()).toBeDefined();
		app.advance(OPEN_SETTLE_MS);
		expect(app.kind("d")).toBe("awake");
	});

	it("an opening one with nothing coming does not hold a place under the cap", () => {
		const app = harness({ awakeMax: 2 });
		app.add("a", "b");
		app.select("a");
		app.arriveUnheard("a");
		app.arriveUnheard("b");
		app.add("c");
		// Both settled: c is past the cap, not two phantom opens.
		expect(app.kinds()).toEqual({ a: "awake", b: "awake", c: "asleep" });
	});

	it("closing an asleep Workspace leaves the count as it was", () => {
		const app = harness({ awakeMax: 2 });
		app.add("a", "b", "c", "d");
		app.loadAll();
		for (const folder of ["a", "b", "c", "d"]) {
			app.advance(1_000);
			app.select(folder);
			app.loadAll();
			app.sleepAll();
		}
		expect(app.kind("a")).toBe("asleep");
		// Close a, asleep: its close runs, takes its (absent) view, and it goes.
		app.set("a", { closing: true });
		app.life.disposed("a");
		app.remove("a");
		for (const folder of ["b", "c", "d", "b", "d", "c"]) {
			app.advance(1_000);
			app.select(folder);
			expect(["opening", "awake"]).toContain(app.kind(folder));
			app.loadAll();
			app.sleepAll();
			const up = ["b", "c", "d"].filter((one) =>
				["awake", "opening", "hibernating"].includes(app.kind(one)),
			);
			expect(up.length).toBeLessThanOrEqual(2);
			expect(app.kind(folder)).toBe("awake");
		}
	});

	it("a relocated Workspace that starts asleep keeps its slot's placeholder", () => {
		const app = harness({ awakeMax: 2 });
		app.add("a", "b", "c");
		app.loadAll();
		app.select("a");
		app.select("b");
		app.sleepAll();
		expect(app.kind("c")).toBe("asleep");
		expect(app.surfaces.get("surface:c")?.kind).toBe("asleep");
		// Locate…: the same Workspace at c2, still past the cap.
		app.relocate("c", "c2");
		expect(app.kind("c2")).toBe("asleep");
		expect(app.surfaces.get("surface:c")?.kind).toBe("asleep");
		app.select("c2");
		expect(app.surfaces.get("surface:c")?.kind).toBe("waking");
		app.load("c2");
		expect(app.surfaces.get("surface:c")).toBeUndefined();
	});

	it("says why a selected one is not up yet", () => {
		const app = dAsleep();
		app.select("d", true);
		expect(app.logs).toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/^\[devhub\] workbench 'd' selected, not up: wake held until \d+: passing through$/,
				),
			]),
		);
	});

	it("whatever happens, a selected one is never left asleep, and an open always has a deadline", () => {
		for (const start of [3, 11, 29, 41, 97]) {
			let seed = start;
			const random = (n: number) => {
				seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
				return seed % n;
			};
			const folders = ["a", "b", "c", "d", "ssh-e"];
			const app = harness({ awakeMax: 2, hibernateAfterMs: 120_000 });
			app.add(...folders);
			let moved = 0;
			for (let step = 0; step < 1_500; step += 1) {
				const pick = folders[random(folders.length)] ?? "a";
				const folder = moved > 0 && random(3) === 0 ? `${pick}-moved` : pick;
				switch (random(16)) {
					case 0:
						app.select(folder, random(2) === 0);
						break;
					case 1:
						if (app.kind(folder) === "opening") app.load(folder);
						break;
					case 2:
						if (app.kind(folder) === "opening") app.arriveUnheard(folder);
						break;
					case 3:
						if (app.kind(folder) === "opening") app.lose(folder);
						break;
					case 4:
						app.fail(folder);
						break;
					case 5:
						if (app.kind(folder) === "hibernating") app.sleep(folder);
						break;
					case 6:
						if (app.kind(folder) === "hibernating") app.refuse(folder);
						break;
					case 7:
						app.advance(random(2_000));
						break;
					case 8:
						app.tick();
						break;
					case 9:
						if (app.life.typed(app.now)) app.plan();
						break;
					case 10:
						// Unavailable, and back.
						app.set(folder, { wanted: random(4) !== 0 });
						break;
					case 11:
						// A close: running, its view taken down, then gone.
						app.set(folder, { closing: true });
						app.life.disposed(folder);
						app.views.delete(folder);
						if (random(3) !== 0) app.remove(folder);
						else app.set(folder, { closing: false });
						break;
					case 12:
						// Added back (or for the first time).
						app.add(folder);
						break;
					case 13:
						app.relocate(pick, `${pick}-moved`);
						moved += 1;
						break;
					case 14:
						app.planWith({ awakeMax: random(4) });
						break;
					case 15:
						app.life.needed(folder, app.now);
						app.plan();
						break;
				}
				for (const one of [...folders, ...folders.map((f) => `${f}-moved`)]) {
					const kind = app.kind(one);
					if (
						kind === "opening" ||
						kind === "held" ||
						kind === "restart-waiting"
					) {
						expect(app.life.nextDeadline()).toBeDefined();
					}
				}
				// After the hold's delay and nothing else, the shown one is up or
				// on its way: never still asleep or held.
				app.advance(WAKE_DELAY_MS);
				const shown = app.selected;
				if (shown !== undefined && app.isWanted(shown)) {
					expect(["asleep", "held"]).not.toContain(app.kind(shown));
				}
			}
		}
	});
});

describe("logging", () => {
	it("says every transition and every skip, one line each", () => {
		const app = fourAwake();
		harnessCap(app, 3);
		app.refuse("d", "unsaved main.ts");
		expect(app.logs).toEqual(
			expect.arrayContaining([
				"[devhub] workbench 'a' absent -> opening (start)",
				"[devhub] workbench 'a' opening -> awake",
				"[devhub] workbench 'd' awake -> hibernating: 4 awake, cap 3",
				"[devhub] workbench 'd' hibernating -> awake: stays awake: unsaved main.ts",
			]),
		);
	});

	it("says a held wake and its end", () => {
		const app = fourAwake();
		harnessCap(app, 3);
		app.sleep("d");
		app.select("d", true);
		app.select("a", true);
		expect(app.logs).toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/^\[devhub\] workbench 'd' asleep -> held: wake held 1000 ms/,
				),
				"[devhub] workbench 'd' hold dropped: passed on",
				"[devhub] workbench 'd' held -> asleep",
			]),
		);
	});
});

/** The cap moved to `max` with more than that awake: one plan. */
function harnessCap(app: ReturnType<typeof harness>, max: number) {
	return app.planWith({ awakeMax: max });
}

describe("terminal mode", () => {
	// The executor plans from `workspacesWantingWorkbenches`; in terminal mode
	// it wants none, and that is the whole of "no workbench is created".
	const workspaces = [
		{ key: "scratch", state: { kind: "ready" } },
		{ key: "a", state: { kind: "ready" } },
		{ key: "gone", state: { kind: "unavailable" } },
	];
	const planFor = (mode: "vscode" | "terminal", tick = false) => {
		const life = new WorkbenchLifecycle(new EditorSupervisor(), () => {});
		return life.plan({
			now: 0,
			wanted: workspacesWantingWorkbenches(mode, workspaces).map((one) => ({
				folder: one.key,
				surfaceKey: `workspace-editor:${one.key}`,
				sleepable: true,
				closing: false,
				awayMs: undefined,
			})),
			selected: "a",
			views: [],
			awakeMax: 2,
			hibernateAfterMs: 600_000,
			tick,
		});
	};

	it("wants every Workspace whose folder is there in VS Code mode", () => {
		expect(
			workspacesWantingWorkbenches("vscode", workspaces).map((one) => one.key),
		).toEqual(["scratch", "a"]);
		expect(planFor("vscode").filter((e) => e.kind === "open")).toHaveLength(2);
	});

	it("opens nothing, not even the selected one, and stands nothing in for one", () => {
		expect(workspacesWantingWorkbenches("terminal", workspaces)).toEqual([]);
		expect(planFor("terminal")).toEqual([]);
		expect(planFor("terminal", true)).toEqual([]);
	});
});
