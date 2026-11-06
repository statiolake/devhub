/**
 * The planner on fact fixtures: what each workbench should do, given only
 * what is true now — including the races, which are only facts arriving in
 * an unlucky order.
 */

import { describe, expect, it } from "vitest";
import {
	AWAKE_RULES,
	CONNECTION_GRACE_MS,
	FREEZE_GRACE_MS,
	NETWORK_ACTIVE_MS,
	PROBE_FRESH_MS,
	SETTLE_PROBE_MS,
	awakeReasons,
	decide,
	nextDecision,
	placeholderOf,
	stopRefusal,
	workbenchStateOf,
	type PlanFacts,
	type WorkbenchFacts,
	type WorkbenchPhase,
} from "./workbenchPlan.js";

const NOW = 1_000_000;
const HOUR = 60 * 60_000;

/** A settled, local, running, hidden workbench with nothing going on. */
function wb(
	folder: string,
	overrides: Partial<WorkbenchFacts> = {},
): WorkbenchFacts {
	return {
		folder,
		phase: { kind: "running", since: NOW - HOUR },
		freezable: true,
		shown: false,
		asked: false,
		held: false,
		closing: false,
		lastShownAt: undefined,
		hiddenSince: NOW - 10_000,
		settled: true,
		probe: { at: NOW - 1_000, busy: [] },
		probing: false,
		trafficAt: undefined,
		connectionAt: undefined,
		rendererShared: false,
		freezeAsked: false,
		stopAsked: false,
		...overrides,
	};
}

const running = (since = NOW - HOUR): WorkbenchPhase => ({
	kind: "running",
	since,
});
const absent: WorkbenchPhase = { kind: "absent" };
const frozen = (since = NOW - 60_000): WorkbenchPhase => ({
	kind: "frozen",
	since,
});
const starting: WorkbenchPhase = {
	kind: "starting",
	cause: "start",
	frame: "",
	since: NOW - 1_000,
};

function plan(
	workbenches: WorkbenchFacts[],
	discardAfterMs = HOUR,
	now = NOW,
): PlanFacts {
	return { now, discardAfterMs, freeze: true, workbenches };
}

const kinds = (facts: PlanFacts) =>
	decide(facts).map((action) => `${action.kind} ${action.folder}`);

describe("freezing", () => {
	it("freezes a hidden, settled, idle workbench with a fresh probe", () => {
		expect(decide(plan([wb("a")]))).toEqual([
			{ kind: "freeze", folder: "a", why: "hidden" },
		]);
	});

	it("never freezes the shown workbench, whatever else is true", () => {
		for (const overrides of [
			{},
			{ freezeAsked: true },
			{ probe: undefined },
			{ hiddenSince: undefined },
		]) {
			expect(kinds(plan([wb("a", { ...overrides, shown: true })]))).toEqual([]);
		}
	});

	it("probes first when its probe is older than its hiding, or stale", () => {
		expect(
			kinds(plan([wb("a", { probe: { at: NOW - 20_000, busy: [] } })])),
		).toEqual(["probe a"]);
		expect(
			kinds(
				plan([
					wb("a", {
						hiddenSince: NOW - 5_000,
						probe: { at: NOW - PROBE_FRESH_MS - 1, busy: [] },
					}),
				]),
			),
		).toEqual(["probe a"]);
		expect(kinds(plan([wb("a", { probe: undefined })]))).toEqual(["probe a"]);
	});

	it("does not probe twice at once", () => {
		expect(kinds(plan([wb("a", { probe: undefined, probing: true })]))).toEqual(
			[],
		);
	});

	it.each([
		[
			"a debug session",
			{ probe: { at: NOW - 1_000, busy: ["debug session"] } },
		],
		["a running task", { probe: { at: NOW - 1_000, busy: ["task build"] } }],
		["a busy terminal", { probe: { at: NOW - 1_000, busy: ["terminal npm"] } }],
		["recent network traffic", { trafficAt: NOW - NETWORK_ACTIVE_MS + 1 }],
		["a connection's grace", { connectionAt: NOW - CONNECTION_GRACE_MS + 1 }],
		["a pending request", { asked: true }],
		["DevHub talking to it", { held: true }],
		["its close", { closing: true }],
		["not having settled", { settled: false, probing: true }],
		["a shared renderer", { rendererShared: true }],
		["being remote", { freezable: false }],
	] as const)("keeps it awake for %s", (_, overrides) => {
		expect(kinds(plan([wb("a", overrides)]))).toEqual([]);
	});

	it("network and grace end, and then it freezes", () => {
		expect(
			kinds(plan([wb("a", { trafficAt: NOW - NETWORK_ACTIVE_MS })])),
		).toEqual(["freeze a"]);
		expect(
			kinds(plan([wb("a", { connectionAt: NOW - CONNECTION_GRACE_MS })])),
		).toEqual(["freeze a"]);
	});

	it("a person's Sleep overrides the soft reasons, never the hard ones", () => {
		expect(
			decide(
				plan([
					wb("a", {
						freezeAsked: true,
						probe: { at: NOW - 1_000, busy: ["debug session"] },
						trafficAt: NOW,
					}),
				]),
			),
		).toEqual([{ kind: "freeze", folder: "a", why: "asked" }]);
		expect(kinds(plan([wb("a", { freezeAsked: true, shown: true })]))).toEqual(
			[],
		);
		expect(
			kinds(
				plan([wb("a", { freezeAsked: true, settled: false, probing: true })]),
			),
		).toEqual([]);
	});

	it("says every reason it stays awake, the renderer's own by name", () => {
		expect(
			awakeReasons(
				wb("a", {
					shown: true,
					trafficAt: NOW,
					probe: { at: NOW, busy: ["debug session", "task build"] },
				}),
				NOW,
			),
		).toEqual(["shown", "network traffic", "debug session, task build"]);
		expect(
			AWAKE_RULES.filter((rule) => rule.hard).map((r) => r.reason),
		).toEqual([
			"shown",
			"asked for",
			"in use by DevHub",
			"closing",
			"not local",
			"still starting",
			"shares its renderer",
		]);
	});
});

describe("the grace after hiding", () => {
	const hiddenAt = NOW - 10_000;
	const at = (ms: number) => hiddenAt + ms;
	/** Shown until `hiddenAt`, its last probe from while it was shown. */
	const justHidden = (overrides: Partial<WorkbenchFacts> = {}) =>
		wb("a", {
			lastShownAt: hiddenAt,
			hiddenSince: hiddenAt,
			probe: { at: hiddenAt - 500, busy: [] },
			...overrides,
		});

	it("neither probes nor freezes before the grace is over", () => {
		for (const ms of [0, 1_000, 1_500, FREEZE_GRACE_MS - 1]) {
			expect(kinds(plan([justHidden()], HOUR, at(ms)))).toEqual([]);
			// Not even with a probe from within the grace that says idle.
			expect(
				kinds(
					plan([justHidden({ probe: { at: at(ms), busy: [] } })], HOUR, at(ms)),
				),
			).toEqual([]);
		}
		expect(nextDecision(plan([justHidden()], HOUR, at(1_000)))).toBe(
			at(FREEZE_GRACE_MS),
		);
		expect(awakeReasons(justHidden(), at(1_000))).toEqual(["just hidden"]);
	});

	it("at the grace's end it probes, and a probe from within it does not count", () => {
		expect(kinds(plan([justHidden()], HOUR, at(FREEZE_GRACE_MS)))).toEqual([
			"probe a",
		]);
		expect(
			kinds(
				plan(
					[justHidden({ probe: { at: at(2_000), busy: [] } })],
					HOUR,
					at(FREEZE_GRACE_MS),
				),
			),
		).toEqual(["probe a"]);
	});

	it("a probe after the grace that finds a busy terminal keeps it up", () => {
		expect(
			kinds(
				plan(
					[
						justHidden({
							probe: { at: at(FREEZE_GRACE_MS + 50), busy: ["terminal sleep"] },
						}),
					],
					HOUR,
					at(FREEZE_GRACE_MS + 60),
				),
			),
		).toEqual([]);
	});

	it("a probe after the grace that finds nothing freezes it", () => {
		expect(
			decide(
				plan(
					[justHidden({ probe: { at: at(FREEZE_GRACE_MS + 50), busy: [] } })],
					HOUR,
					at(FREEZE_GRACE_MS + 60),
				),
			),
		).toEqual([{ kind: "freeze", folder: "a", why: "hidden" }]);
	});

	it("shown again within the grace, it is never frozen", () => {
		const back = justHidden({
			shown: true,
			lastShownAt: at(2_000),
			hiddenSince: undefined,
		});
		for (const ms of [2_000, FREEZE_GRACE_MS, FREEZE_GRACE_MS + 60, 60_000]) {
			expect(kinds(plan([back], HOUR, at(ms)))).toEqual([]);
			expect(
				kinds(
					plan([{ ...back, probe: { at: at(ms), busy: [] } }], HOUR, at(ms)),
				),
			).toEqual([]);
		}
		expect(nextDecision(plan([back], HOUR, at(2_000)))).toBeUndefined();
	});

	it("a person's Sleep skips the grace", () => {
		expect(
			decide(plan([justHidden({ freezeAsked: true })], HOUR, at(500))),
		).toEqual([{ kind: "freeze", folder: "a", why: "asked" }]);
	});

	it("a workbench started hidden and never shown has no grace", () => {
		expect(
			kinds(
				plan(
					[
						justHidden({
							lastShownAt: undefined,
							hiddenSince: undefined,
							probe: { at: at(-500), busy: [] },
						}),
					],
					HOUR,
					at(0),
				),
			),
		).toEqual(["freeze a"]);
	});
});

describe("thawing", () => {
	it.each([
		["shown", { shown: true }, "shown"],
		["asked for (a request, Enter)", { asked: true }, "asked for"],
		["held by DevHub (its close asking)", { held: true }, "in use by DevHub"],
		["closing", { closing: true }, "closing"],
		[
			"a connection arrived while frozen",
			{ connectionAt: NOW - 100 },
			"a connection is waiting",
		],
	] as const)("thaws a frozen workbench %s, with no delay", (_, o, why) => {
		expect(decide(plan([wb("a", { phase: frozen(), ...o })]))).toEqual([
			{ kind: "thaw", folder: "a", why },
		]);
	});

	it("a connection from before the freeze is not a reason", () => {
		expect(
			kinds(
				plan([
					wb("a", {
						phase: frozen(NOW - 1_000),
						connectionAt: NOW - 50_000,
					}),
				]),
			),
		).toEqual([]);
	});

	it("thawed by a connection, it is not frozen again within the grace", () => {
		const thawed = wb("a", {
			phase: running(NOW - 100),
			connectionAt: NOW - 100,
		});
		expect(kinds(plan([thawed]))).toEqual([]);
		// Then it is looked at again: probed, and frozen on a quiet answer.
		expect(kinds(plan([thawed], HOUR, NOW + CONNECTION_GRACE_MS))).toEqual([
			"probe a",
		]);
		expect(
			kinds(
				plan(
					[{ ...thawed, probe: { at: NOW + CONNECTION_GRACE_MS, busy: [] } }],
					HOUR,
					NOW + CONNECTION_GRACE_MS,
				),
			),
		).toEqual(["freeze a"]);
	});
});

describe("discarding", () => {
	it("discards a workbench frozen for the discard time", () => {
		expect(decide(plan([wb("a", { phase: frozen(NOW - HOUR) })]))).toEqual([
			{ kind: "discard", folder: "a", stop: false },
		]);
		expect(kinds(plan([wb("a", { phase: frozen(NOW - HOUR + 1) })]))).toEqual(
			[],
		);
	});

	it("never discards with a discard time of 0", () => {
		expect(kinds(plan([wb("a", { phase: frozen(0) })], 0))).toEqual([]);
	});

	it("a request during the discard waits for it, then starts it", () => {
		// Mid-discard nothing is decided: the executor checks `mayDiscard`.
		expect(
			kinds(plan([wb("a", { phase: { kind: "discarding" }, asked: true })])),
		).toEqual([]);
		// The unload won: discarded, still asked for → started again.
		expect(
			decide(
				plan([
					wb("a", { phase: { kind: "discarded", frame: "" }, asked: true }),
				]),
			),
		).toEqual([{ kind: "start", folder: "a", cause: "wake" }]);
	});

	it("a hold never starts a discarded or absent workbench", () => {
		expect(
			kinds(
				plan([
					wb("a", { phase: { kind: "discarded", frame: "" }, held: true }),
				]),
			),
		).toEqual([]);
		expect(
			kinds(plan([wb("a", { phase: absent, held: true, freezable: false })])),
		).toEqual([]);
	});

	it("a discarded workbench that is only shown waits for Enter", () => {
		expect(
			kinds(
				plan([
					wb("a", { phase: { kind: "discarded", frame: "" }, shown: true }),
				]),
			),
		).toEqual([]);
	});

	it("is never started again unasked", () => {
		expect(
			kinds(plan([wb("a", { phase: { kind: "discarded", frame: "" } })])),
		).toEqual([]);
	});
});

describe("starting only when asked", () => {
	it("starts nothing at launch: not the shown one, not the others", () => {
		expect(
			kinds(
				plan([
					wb("a", { phase: absent }),
					wb("b", { phase: absent, shown: true, hiddenSince: undefined }),
					wb("c", { phase: absent, lastShownAt: NOW - 100 }),
				]),
			),
		).toEqual([]);
	});

	it("starts nothing once another has settled, either", () => {
		expect(
			kinds(
				plan([
					wb("a", { phase: running(NOW - 5_000), shown: true }),
					wb("b", { phase: absent }),
				]),
			).filter((kind) => kind.startsWith("start")),
		).toEqual([]);
	});

	it("an ask (Enter, the placeholder's button) starts the shown one", () => {
		expect(
			decide(plan([wb("a", { phase: absent, shown: true, asked: true })])),
		).toEqual([{ kind: "start", folder: "a", cause: "start" }]);
	});

	it("a request starts an absent workbench at once, shown or not", () => {
		expect(
			decide(
				plan([
					wb("a", { phase: starting }),
					wb("b", { phase: absent, asked: true }),
				]),
			),
		).toEqual([{ kind: "start", folder: "b", cause: "start" }]);
	});

	it("starts as many as are asked for, without waiting on each other", () => {
		expect(
			kinds(
				plan([
					wb("a", { phase: starting }),
					wb("b", { phase: absent, asked: true }),
					wb("c", { phase: absent, asked: true, freezable: false }),
				]),
			),
		).toEqual(["start b", "start c"]);
	});

	it("does not start a closing one, even asked", () => {
		expect(
			kinds(plan([wb("a", { phase: absent, asked: true, closing: true })])),
		).toEqual([]);
	});
});

describe("stopping by hand", () => {
	it("stops the shown, running one: discarded, as a person's stop", () => {
		expect(
			decide(
				plan([
					wb("a", { shown: true, hiddenSince: undefined, stopAsked: true }),
				]),
			),
		).toEqual([{ kind: "discard", folder: "a", stop: true }]);
	});

	it("stops a frozen one, and one still settling", () => {
		expect(
			decide(plan([wb("a", { phase: frozen(), stopAsked: true })])),
		).toEqual([{ kind: "discard", folder: "a", stop: true }]);
		expect(
			decide(
				plan([wb("a", { settled: false, probe: undefined, stopAsked: true })]),
			),
		).toEqual([{ kind: "discard", folder: "a", stop: true }]);
	});

	it.each([
		["not running", { phase: absent }, "it is not running"],
		[
			"discarded already",
			{ phase: { kind: "discarded", frame: "" } as WorkbenchPhase },
			"it is not running",
		],
		["starting", { phase: starting }, "it is still starting"],
		[
			"remote",
			{ freezable: false },
			"SSH and dev container editors are not stopped",
		],
		["closing", { closing: true }, "its Workspace is closing"],
		["waited on by a request", { asked: true }, "DevHub is waiting on it"],
		["held by DevHub", { held: true }, "DevHub is talking to it"],
	] as const)("does not stop one %s, and says why", (_, o, why) => {
		const facts = wb("a", { shown: true, stopAsked: true, ...o });
		expect(stopRefusal(facts)).toBe(why);
		expect(
			decide(plan([facts])).filter((action) => action.kind === "discard"),
		).toEqual([]);
	});

	it("Enter after the stop starts it again (a wake)", () => {
		expect(
			decide(
				plan([
					wb("a", {
						phase: { kind: "discarded", frame: "data:f" },
						shown: true,
						asked: true,
					}),
				]),
			),
		).toEqual([{ kind: "start", folder: "a", cause: "wake" }]);
	});
});

describe("the races", () => {
	it("switching to a workbench during its start: it is not frozen when it settles", () => {
		const settledWhileShown = wb("b", {
			phase: running(NOW - 4_000),
			shown: true,
			hiddenSince: undefined,
		});
		expect(kinds(plan([settledWhileShown]))).toEqual([]);
	});

	it("a workbench that settles hidden, never shown, is probed, then frozen", () => {
		const settled = wb("b", {
			phase: running(NOW - 4_000),
			hiddenSince: undefined,
			lastShownAt: undefined,
			probe: { at: NOW - 2_000, busy: [] },
		});
		// Never shown: its last probe counts (it was hidden all along).
		expect(kinds(plan([settled]))).toEqual(["freeze b"]);
	});

	it("a probe that lands after the person came back freezes nothing", () => {
		expect(
			kinds(
				plan([
					wb("a", {
						shown: true,
						hiddenSince: undefined,
						probe: { at: NOW, busy: [] },
					}),
				]),
			),
		).toEqual([]);
	});

	it("a probe taken before it was hidden again, or within the grace, does not count", () => {
		for (const at of [NOW - 6_000, NOW - 4_000]) {
			expect(
				kinds(
					plan([
						wb("a", { hiddenSince: NOW - 5_000, probe: { at, busy: [] } }),
					]),
				),
			).toEqual(["probe a"]);
		}
	});

	it("a connection arriving while frozen thaws it before any discard", () => {
		expect(
			kinds(plan([wb("a", { phase: frozen(NOW - HOUR), connectionAt: NOW })])),
		).toEqual(["thaw a"]);
	});

	it("an unsettled start is probed even while shown", () => {
		expect(
			kinds(
				plan([
					wb("a", {
						phase: running(NOW - 2_000),
						shown: true,
						settled: false,
						probe: { at: NOW - SETTLE_PROBE_MS, busy: [] },
					}),
				]),
			),
		).toEqual(["probe a"]);
	});
});

describe("with freezing off", () => {
	const off = (workbenches: WorkbenchFacts[], now = NOW): PlanFacts => ({
		...plan(workbenches, HOUR, now),
		freeze: false,
	});

	it("never freezes a hidden one, nor probes it for a freeze", () => {
		expect(kinds(off([wb("a")]))).toEqual([]);
		expect(kinds(off([wb("a", { probe: undefined })]))).toEqual([]);
		expect(
			kinds(off([wb("a", { hiddenSince: NOW - FREEZE_GRACE_MS })])),
		).toEqual([]);
	});

	it("ignores a person's Sleep", () => {
		expect(kinds(off([wb("a", { freezeAsked: true })]))).toEqual([]);
	});

	it("thaws one frozen before it turned off, instead of discarding it", () => {
		expect(decide(off([wb("a", { phase: frozen(NOW - 2 * HOUR) })]))).toEqual([
			{ kind: "thaw", folder: "a", why: "freezing is off" },
		]);
		// A stronger reason still names itself.
		expect(decide(off([wb("a", { phase: frozen(), shown: true })]))).toEqual([
			{ kind: "thaw", folder: "a", why: "shown" },
		]);
	});

	it("still probes a start until it has settled, and starts nothing unasked", () => {
		expect(
			kinds(
				off([
					wb("a", {
						settled: false,
						phase: running(NOW - 1_000),
						probe: undefined,
					}),
				]),
			),
		).toEqual(["probe a"]);
		expect(kinds(off([wb("a", { phase: { kind: "absent" } })]))).toEqual([]);
	});

	it("sets no freeze or discard deadline", () => {
		expect(nextDecision(off([wb("a", { phase: frozen(NOW - 1_000) })]))).toBe(
			undefined,
		);
		expect(
			nextDecision(
				off([
					wb("a", {
						trafficAt: NOW - 1_000,
						hiddenSince: NOW - 1_000,
						probe: { at: NOW - 500, busy: [] },
					}),
				]),
			),
		).toBeUndefined();
	});
});

describe("deadlines", () => {
	it("is the earliest moment an answer would change", () => {
		expect(nextDecision(plan([wb("a", { phase: frozen(NOW - 1_000) })]))).toBe(
			NOW - 1_000 + HOUR,
		);
		expect(
			nextDecision(
				plan([
					wb("a", {
						trafficAt: NOW - 1_000,
						probe: { at: NOW - 500, busy: [] },
					}),
				]),
			),
		).toBe(NOW - 500 + PROBE_FRESH_MS);
		expect(
			nextDecision(
				plan([wb("a", { trafficAt: NOW - 20_000, probe: undefined })]),
			),
		).toBe(NOW - 20_000 + NETWORK_ACTIVE_MS);
		expect(nextDecision(plan([wb("a", { shown: true })]))).toBeUndefined();
	});
});

describe("words", () => {
	it("a frozen or running workbench has no placeholder; a discarded or absent one does", () => {
		expect(placeholderOf(frozen())).toBeUndefined();
		expect(placeholderOf(running())).toBeUndefined();
		expect(placeholderOf({ kind: "discarded", frame: "f" })).toEqual({
			kind: "discarded",
			frame: "f",
		});
		// Not started: the same "not running" placeholder, with no frame.
		expect(placeholderOf(absent)).toEqual({ kind: "discarded", frame: "" });
		expect(placeholderOf(starting)).toEqual({ kind: "starting" });
	});

	it("the Task Manager says frozen and discarded", () => {
		expect(workbenchStateOf(frozen())).toBe("frozen");
		expect(workbenchStateOf({ kind: "discarded", frame: "" })).toBe(
			"discarded",
		);
		expect(workbenchStateOf(running())).toBe("running");
	});
});
