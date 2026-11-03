/**
 * The planner on fact fixtures: what each workbench should do, given only
 * what is true now — including the races, which are only facts arriving in
 * an unlucky order.
 */

import { describe, expect, it } from "vitest";
import {
	AWAKE_RULES,
	CONNECTION_GRACE_MS,
	NETWORK_ACTIVE_MS,
	PROBE_FRESH_MS,
	SETTLE_PROBE_MS,
	SETTLE_TIMEOUT_MS,
	awakeReasons,
	decide,
	nextDecision,
	placeholderOf,
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
	return { now, discardAfterMs, workbenches };
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
		expect(kinds(plan([wb("a", { phase: frozen(NOW - HOUR) })]))).toEqual([
			"discard a",
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
		).toEqual([
			{ kind: "start", folder: "a", cause: "wake", background: false },
		]);
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

	it("is never started again in the background", () => {
		expect(
			kinds(plan([wb("a", { phase: { kind: "discarded", frame: "" } })])),
		).toEqual([]);
	});
});

describe("starting, one at a time", () => {
	it("starts the shown workbench first, and nothing else meanwhile", () => {
		expect(
			decide(
				plan([
					wb("a", { phase: absent }),
					wb("b", { phase: absent, shown: true }),
					wb("c", { phase: absent }),
				]),
			),
		).toEqual([
			{ kind: "start", folder: "b", cause: "start", background: false },
		]);
	});

	it("starts the next in the background once the previous has settled", () => {
		const facts = [
			wb("a", { phase: running(NOW - 5_000), shown: true }),
			wb("b", { phase: absent }),
			wb("c", { phase: absent }),
		];
		expect(decide(plan(facts))).toEqual([
			{ kind: "start", folder: "b", cause: "start", background: true },
		]);
	});

	it("waits while a start is in flight or has not settled", () => {
		expect(
			kinds(
				plan([
					wb("a", { phase: starting, shown: true }),
					wb("b", { phase: absent }),
				]),
			),
		).toEqual([]);
		expect(
			kinds(
				plan([
					wb("a", {
						phase: running(NOW - 5_000),
						shown: true,
						settled: false,
						probing: true,
					}),
					wb("b", { phase: absent }),
				]),
			),
		).toEqual([]);
	});

	it("does not wait for ever on a start that never says it settled", () => {
		expect(
			kinds(
				plan([
					wb("a", {
						phase: running(NOW - SETTLE_TIMEOUT_MS),
						shown: true,
						settled: false,
						probing: true,
					}),
					wb("b", { phase: absent }),
				]),
			),
		).toEqual(["start b"]);
	});

	it("goes by recency, then by the Sidebar's order", () => {
		expect(
			kinds(
				plan([
					wb("a", { phase: absent }),
					wb("b", { phase: absent }),
					wb("c", { phase: absent, lastShownAt: NOW - 100 }),
				]),
			),
		).toEqual(["start c"]);
		expect(
			kinds(plan([wb("a", { phase: absent }), wb("b", { phase: absent })])),
		).toEqual(["start a"]);
	});

	it("does not start a remote or closing one in the background", () => {
		expect(
			kinds(
				plan([
					wb("ssh", { phase: absent, freezable: false }),
					wb("c", { phase: absent, closing: true }),
				]),
			),
		).toEqual([]);
	});

	it("the user's choice preempts a background start in flight", () => {
		// b is starting in the background; the person switches to c.
		expect(
			decide(
				plan([
					wb("a", { phase: running(), shown: false }),
					wb("b", { phase: starting }),
					wb("c", { phase: absent, shown: true }),
					wb("d", { phase: absent }),
				]),
			),
		).toEqual([
			{ kind: "freeze", folder: "a", why: "hidden" },
			{ kind: "start", folder: "c", cause: "start", background: false },
		]);
	});

	it("a request starts an absent workbench at once, shown or not", () => {
		expect(
			decide(
				plan([
					wb("a", { phase: starting }),
					wb("b", { phase: absent, asked: true }),
				]),
			),
		).toEqual([
			{ kind: "start", folder: "b", cause: "start", background: false },
		]);
	});
});

describe("the races", () => {
	it("switching to a workbench during its background start: it is not frozen when it settles", () => {
		const settledWhileShown = wb("b", {
			phase: running(NOW - 4_000),
			shown: true,
			hiddenSince: undefined,
		});
		expect(kinds(plan([settledWhileShown]))).toEqual([]);
	});

	it("a background workbench that settles hidden is probed, then frozen", () => {
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

	it("a probe taken before it was hidden again does not count", () => {
		expect(
			kinds(
				plan([
					wb("a", {
						hiddenSince: NOW - 100,
						probe: { at: NOW - 200, busy: [] },
					}),
				]),
			),
		).toEqual(["probe a"]);
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
	it("a frozen or running workbench has no placeholder; a discarded one does", () => {
		expect(placeholderOf(frozen())).toBeUndefined();
		expect(placeholderOf(running())).toBeUndefined();
		expect(placeholderOf({ kind: "discarded", frame: "f" })).toEqual({
			kind: "discarded",
			frame: "f",
		});
		expect(placeholderOf(absent)).toEqual({ kind: "starting" });
	});

	it("the Task Manager says frozen and discarded", () => {
		expect(workbenchStateOf(frozen())).toBe("frozen");
		expect(workbenchStateOf({ kind: "discarded", frame: "" })).toBe(
			"discarded",
		);
		expect(workbenchStateOf(running())).toBe("running");
	});
});
