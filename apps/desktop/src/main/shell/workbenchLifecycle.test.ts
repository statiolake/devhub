/**
 * The lifecycle driving the planner: facts in, effects out, over a fake
 * executor whose views come and go only through the effects and whose clock
 * moves only when a test says so. The rules themselves are tested on fact
 * fixtures in `workbenchPlan.test.ts`; this is the bookkeeping around them —
 * that the events become the facts the rules read, and that the phases
 * follow the effects, so nothing is asked twice.
 */

import { describe, expect, it } from "vitest";
import {
	EditorSupervisor,
	MAX_EDITOR_RESTARTS,
	RESTART_BACKOFF_MS,
} from "./editorSupervisor.js";
import {
	OPEN_SETTLE_MS,
	WorkbenchLifecycle,
	type EditorPlaceholder,
	type LifecycleEffect,
	type ProbeAnswer,
	type WakeReason,
	type WorkbenchPhase,
} from "./workbenchLifecycle.js";
import { FREEZE_GRACE_MS, QUIET_MS, SETTLE_PROBE_MS } from "./workbenchPlan.js";

const HOUR = 60 * 60_000;
const QUIET: ProbeAnswer = { busy: [], ready: true, cpuPercent: 1 };

interface Workspace {
	freezable: boolean;
	closing: boolean;
	wanted: boolean;
}

function harness(
	options: { discardAfterMs?: number; freezing?: boolean } = {},
) {
	let freezing = options.freezing ?? true;
	const logs: string[] = [];
	const life = new WorkbenchLifecycle(new EditorSupervisor(), (line) => {
		logs.push(line);
	});
	const workspaces = new Map<string, Workspace>();
	const views = new Set<string>();
	const loading = new Set<string>();
	const requests = new Set<string>();
	const placeholders = new Map<string, EditorPlaceholder>();
	const effects: LifecycleEffect[] = [];
	/** Probes asked for and not yet answered. */
	const probes = new Set<string>();
	/** The fake freezer: folders whose processes the effects stopped. */
	const stopped = new Set<string>();
	let now = 1_000;
	let selected: string | undefined;

	const plan = (
		extra: { ask?: { folder: string; why: WakeReason }; freeze?: string } = {},
	) => {
		const done = life.plan({
			now,
			wanted: [...workspaces]
				.filter(([, one]) => one.wanted)
				.map(([folder, one]) => ({
					folder,
					surfaceKey: `surface:${folder}`,
					freezable: one.freezable,
					closing: one.closing,
				})),
			selected,
			views: [...views],
			loading: [...loading],
			discardAfterMs: options.discardAfterMs ?? HOUR,
			freezing,
			requests: [...requests],
			stopped: [...stopped],
			...extra,
		});
		for (const effect of done) {
			if (effect.kind === "freeze") stopped.add(effect.folder);
			if (effect.kind === "thaw") stopped.delete(effect.folder);
			if (effect.kind === "dispose") views.delete(effect.folder);
			if (effect.kind === "open") loading.add(effect.folder);
			if (effect.kind === "probe") probes.add(effect.folder);
			if (effect.kind === "placeholder") {
				const folder = effect.surfaceKey.slice("surface:".length);
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
		effects,
		placeholders,
		probes,
		stopped,
		plan,
		get now() {
			return now;
		},
		add(...folders: string[]) {
			for (const folder of folders) {
				workspaces.set(folder, {
					freezable: !folder.startsWith("ssh"),
					closing: false,
					wanted: true,
				});
			}
			return plan();
		},
		set(folder: string, change: Partial<Workspace>) {
			Object.assign(workspaces.get(folder)!, change);
			return plan();
		},
		select(folder: string | undefined) {
			selected = folder;
			return plan();
		},
		ask(folder: string, why: WakeReason = "asked") {
			return plan({ ask: { folder, why } });
		},
		request(folder: string) {
			requests.add(folder);
			return plan();
		},
		release(folder: string) {
			requests.delete(folder);
			return plan();
		},
		freeze(folder: string) {
			return plan({ freeze: folder });
		},
		/** `general.workbench_freeze` changed. */
		setFreezing(on: boolean) {
			freezing = on;
			return plan();
		},
		advance(ms: number) {
			now += ms;
			return plan();
		},
		/** Show `other`, and let the grace after hiding the previous run out. */
		hideFor(other: string) {
			app.select(other);
			return app.advance(FREEZE_GRACE_MS);
		},
		load(folder: string) {
			loading.delete(folder);
			views.add(folder);
			life.loaded(folder, now);
			return plan();
		},
		/** Answer the folder's probe; answer it quiet until it has settled. */
		answer(folder: string, answer: ProbeAnswer = QUIET) {
			probes.delete(folder);
			life.probed(folder, answer, now);
			return plan();
		},
		/** Load, then answer probes a second apart until it has settled. */
		settle(folder: string) {
			if (life.phase(folder).kind === "starting") app.load(folder);
			for (let i = 0; i <= QUIET_MS / SETTLE_PROBE_MS + 1; i += 1) {
				if (probes.has(folder)) app.answer(folder);
				now += SETTLE_PROBE_MS;
				plan();
			}
		},
		/** DevHub took its view down itself (`disposeEditorView`). */
		takeDown(folder: string) {
			views.delete(folder);
			life.disposed(folder);
			return plan();
		},
		fail(folder: string, reason = "The workbench process ended.") {
			loading.delete(folder);
			views.delete(folder);
			life.failed(folder, reason, now);
			return plan();
		},
		kind(folder: string): WorkbenchPhase["kind"] {
			return life.phase(folder).kind;
		},
	};
	return app;
}

const of = (
	effects: readonly LifecycleEffect[],
	kind: LifecycleEffect["kind"],
) => effects.flatMap((effect) => (effect.kind === kind ? [effect.folder] : []));

describe("launch", () => {
	it("starts the shown workbench first, then the others one at a time", () => {
		const app = harness();
		app.select("b");
		expect(of(app.add("a", "b", "c"), "open")).toEqual(["b"]);
		expect(of(app.plan(), "open")).toEqual([]);
		app.settle("b");
		expect(app.kind("a")).toBe("starting");
		expect(app.kind("c")).toBe("absent");
		app.settle("a");
		expect(app.kind("c")).toBe("starting");
	});

	it("freezes a background one once it has settled, unless it was shown meanwhile", () => {
		const app = harness();
		app.select("a");
		app.add("a", "b", "c");
		app.settle("a");
		app.settle("b");
		// b settled hidden: frozen on the quiet probe that settled it.
		expect(app.kind("b")).toBe("frozen");
		// c is starting in the background; the person goes to it.
		expect(app.kind("c")).toBe("starting");
		app.select("c");
		app.settle("c");
		expect(app.kind("c")).toBe("running");
	});

	it("starts a workbench the person goes to ahead of its turn", () => {
		const app = harness();
		app.select("a");
		app.add("a", "b", "c", "d");
		app.settle("a");
		expect(app.kind("b")).toBe("starting");
		expect(of(app.select("d"), "open")).toEqual(["d"]);
		expect(app.kind("c")).toBe("absent");
	});

	it("never preloads a remote workbench, and starts it when shown", () => {
		const app = harness();
		app.select("a");
		app.add("a", "ssh-host");
		app.settle("a");
		app.advance(HOUR);
		expect(app.kind("ssh-host")).toBe("absent");
		expect(of(app.select("ssh-host"), "open")).toEqual(["ssh-host"]);
	});
});

describe("freezing and thawing", () => {
	function twoRunning() {
		const app = harness();
		app.select("a");
		app.add("a", "b");
		app.settle("a");
		app.select("b");
		app.settle("b");
		return app;
	}

	it("probes a workbench once the grace after hiding it is over, and freezes it on a quiet answer", () => {
		const app = twoRunning();
		expect(app.kind("a")).toBe("running");
		app.select("a");
		expect(app.probes.has("b")).toBe(false);
		app.advance(FREEZE_GRACE_MS - 1);
		expect(app.probes.has("b")).toBe(false);
		expect(app.life.nextDeadline()).toBe(app.now + 1);
		app.advance(1);
		expect(app.probes.has("b")).toBe(true);
		expect(app.kind("b")).toBe("running");
		expect(of(app.answer("b"), "freeze")).toEqual(["b"]);
		expect(app.kind("b")).toBe("frozen");
	});

	it("does not freeze one whose probe lands after it was shown again", () => {
		const app = twoRunning();
		app.hideFor("a");
		app.select("b");
		expect(of(app.answer("b"), "freeze")).toEqual([]);
		expect(app.kind("b")).toBe("running");
	});

	it("keeps a busy one up, and looks again later", () => {
		const app = twoRunning();
		app.hideFor("a");
		app.answer("b", { ...QUIET, busy: ["debug session"] });
		expect(app.kind("b")).toBe("running");
		expect(app.logs.some((l) => l.includes("stays up: debug session"))).toBe(
			true,
		);
		const deadline = app.life.nextDeadline()!;
		app.advance(deadline - app.now);
		expect(app.probes.has("b")).toBe(true);
		expect(of(app.answer("b"), "freeze")).toEqual(["b"]);
	});

	it("thaws at once when shown, and when a request needs it", () => {
		const app = twoRunning();
		app.hideFor("a");
		app.answer("b");
		expect(of(app.select("b"), "thaw")).toEqual(["b"]);
		expect(app.kind("b")).toBe("running");
		app.hideFor("a");
		app.answer("b");
		expect(app.kind("b")).toBe("frozen");
		expect(of(app.request("b"), "thaw")).toEqual(["b"]);
		// Kept up while the request waits; looked at again when it is done.
		expect(app.kind("b")).toBe("running");
		app.release("b");
		expect(app.probes.has("b")).toBe(true);
	});

	it("thaws for a connection, and keeps it up for the grace", () => {
		const app = twoRunning();
		app.hideFor("a");
		app.answer("b");
		app.life.connectionArrived("b", app.now);
		expect(of(app.plan(), "thaw")).toEqual(["b"]);
		expect(of(app.plan(), "probe")).toEqual([]);
		expect(app.kind("b")).toBe("running");
	});

	it("the Task Manager's Sleep freezes a busy hidden one, never the shown", () => {
		const app = twoRunning();
		app.select("a");
		app.answer("b", { ...QUIET, busy: ["task build"] });
		expect(of(app.freeze("b"), "freeze")).toEqual(["b"]);
		expect(of(app.freeze("a"), "freeze")).toEqual([]);
		expect(app.logs.at(-1)).toContain("asked to freeze, not frozen: shown");
	});

	it("a freeze that could not be carried out leaves it running", () => {
		const app = twoRunning();
		app.select("a");
		app.answer("b");
		app.life.freezeFailed("b", "no processes", app.now);
		expect(app.kind("b")).toBe("running");
		expect(of(app.plan(), "freeze")).toEqual([]);
	});
});

describe("stopped processes", () => {
	function frozenB() {
		const app = harness();
		app.select("a");
		app.add("a", "b");
		app.settle("a");
		app.settle("b");
		expect(app.kind("b")).toBe("frozen");
		expect(app.stopped.has("b")).toBe(true);
		return app;
	}

	it("a frozen one that fails is thawed before it is opened again", () => {
		const app = frozenB();
		const done = app.fail("b");
		expect(of(done, "thaw")).toEqual(["b"]);
		expect(app.stopped.has("b")).toBe(false);
		expect(app.logs.join("\n")).toContain(
			"thawed: its processes were stopped while restart-waiting",
		);
	});

	it("a frozen one taken down by DevHub is thawed", () => {
		const app = frozenB();
		expect(of(app.takeDown("b"), "thaw")).toEqual(["b"]);
		expect(app.stopped.has("b")).toBe(false);
	});

	it("a frozen one that is no longer wanted is thawed once", () => {
		const app = frozenB();
		expect(of(app.set("b", { wanted: false }), "thaw")).toEqual(["b"]);
		expect(of(app.plan(), "thaw")).toEqual([]);
	});

	it("nothing is thawed that the lifecycle knows to be frozen", () => {
		const app = frozenB();
		expect(of(app.plan(), "thaw")).toEqual([]);
		expect(app.kind("b")).toBe("frozen");
	});
});

describe("discarding", () => {
	function frozenB() {
		const app = harness({ discardAfterMs: HOUR });
		app.select("a");
		app.add("a", "b");
		app.settle("a");
		app.settle("b");
		expect(app.kind("b")).toBe("frozen");
		return app;
	}

	it("discards after the discard time, and shows the not-running placeholder", () => {
		const app = frozenB();
		expect(of(app.advance(HOUR), "discard")).toEqual(["b"]);
		expect(app.life.mayDiscard("b")).toBe(true);
		app.life.discarded("b", "frame:b");
		expect(of(app.plan(), "dispose")).toEqual(["b"]);
		expect(app.placeholders.get("b")).toEqual({
			kind: "discarded",
			frame: "frame:b",
		});
		// Shown, it waits; Enter starts it.
		expect(of(app.select("b"), "open")).toEqual([]);
		expect(of(app.ask("b"), "open")).toEqual(["b"]);
		expect(app.placeholders.get("b")).toEqual({
			kind: "waking",
			frame: "frame:b",
		});
	});

	it("is called off when the workbench is shown or asked for meanwhile", () => {
		const app = frozenB();
		app.advance(HOUR);
		app.request("b");
		expect(app.life.mayDiscard("b")).toBe(false);
		app.life.discardSkipped("b", "asked for", app.now);
		expect(app.kind("b")).toBe("running");
	});

	it("a request that arrives once it is discarded starts it again", () => {
		const app = frozenB();
		app.advance(HOUR);
		app.life.discarded("b", "");
		app.plan();
		expect(of(app.request("b"), "open")).toEqual(["b"]);
	});

	it("never discards with a discard time of 0", () => {
		const app = harness({ discardAfterMs: 0 });
		app.select("a");
		app.add("a", "b");
		app.settle("a");
		app.settle("b");
		app.advance(100 * HOUR);
		expect(app.kind("b")).toBe("frozen");
	});
});

describe("with freezing off", () => {
	it("freezes nothing hidden, refuses a Sleep, and so discards nothing", () => {
		const app = harness({ freezing: false });
		app.select("a");
		app.add("a", "b");
		app.settle("a");
		app.settle("b");
		app.hideFor("b");
		app.advance(FREEZE_GRACE_MS);
		expect(app.kind("a")).toBe("running");
		expect(of(app.freeze("a"), "freeze")).toEqual([]);
		expect(app.logs.at(-1)).toContain(
			"asked to freeze, not frozen: freezing is off",
		);
		app.advance(2 * HOUR);
		expect(app.kind("a")).toBe("running");
		expect(of(app.effects, "freeze")).toEqual([]);
		expect(of(app.effects, "discard")).toEqual([]);
	});

	it("thaws a frozen one when it turns off, and freezes again when it turns on", () => {
		const app = harness();
		app.select("a");
		app.add("a", "b");
		app.settle("a");
		app.settle("b");
		expect(app.kind("b")).toBe("frozen");
		expect(of(app.setFreezing(false), "thaw")).toEqual(["b"]);
		expect(app.kind("b")).toBe("running");
		app.advance(2 * HOUR);
		expect(app.kind("b")).toBe("running");
		app.setFreezing(true);
		if (app.probes.has("b")) app.answer("b");
		expect(app.kind("b")).toBe("frozen");
	});
});

describe("closing and going", () => {
	it("thaws a frozen workbench whose Workspace is closing", () => {
		const app = harness();
		app.select("a");
		app.add("a", "b");
		app.settle("a");
		app.settle("b");
		expect(of(app.set("b", { closing: true }), "thaw")).toEqual(["b"]);
	});

	it("thaws a frozen one whose Workspace went, so its processes can end", () => {
		const app = harness();
		app.select("a");
		app.add("a", "b");
		app.settle("a");
		app.settle("b");
		const effects = app.set("b", { wanted: false });
		expect(of(effects, "thaw")).toEqual(["b"]);
		expect(of(effects, "dispose")).toEqual(["b"]);
	});
});

describe("failures", () => {
	it("restarts after a backoff, and settles an open nobody reported", () => {
		const app = harness();
		app.select("a");
		app.add("a");
		app.fail("a");
		expect(app.life.phase("a")).toEqual({
			kind: "restart-waiting",
			until: app.now + RESTART_BACKOFF_MS,
		});
		expect(of(app.advance(RESTART_BACKOFF_MS), "open")).toEqual(["a"]);
		expect(app.placeholders.get("a")).toEqual({ kind: "restarting" });
		app.advance(OPEN_SETTLE_MS);
		expect(app.kind("a")).toBe("restart-waiting");
	});

	it("gives up after the ceiling, reports once, and parks until wanted again", () => {
		const app = harness();
		app.select("a");
		app.add("a");
		for (let attempt = 0; attempt <= MAX_EDITOR_RESTARTS; attempt += 1) {
			app.fail("a");
			app.advance(60_000);
		}
		expect(app.kind("a")).toBe("gave-up");
		expect(of(app.effects, "report-gave-up")).toEqual(["a"]);
		app.set("a", { wanted: false });
		expect(app.kind("a")).toBe("parked");
		expect(of(app.set("a", { wanted: true }), "open")).toEqual(["a"]);
	});
});

describe("placeholders", () => {
	it("are what each slot was last told, for a page that starts listening late", () => {
		const app = harness();
		app.select("a");
		app.add("a", "b");
		expect(app.life.standing()).toEqual([
			{ surfaceKey: "surface:a", placeholder: { kind: "starting" } },
			{ surfaceKey: "surface:b", placeholder: { kind: "starting" } },
		]);
		app.load("a");
		expect(app.life.standing().map((one) => one.surfaceKey)).toEqual([
			"surface:b",
		]);
	});
});
