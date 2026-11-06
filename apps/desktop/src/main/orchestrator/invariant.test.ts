import { describe, expect, it } from "vitest";
import { eventLine, type OrchestratorEvent } from "./events.js";
import {
	findItem,
	InvariantWatch,
	readInvariant,
	type InvariantAgent,
	type InvariantEscalation,
	type ItemFacts,
	type KeptAgent,
} from "./invariant.js";

const URL = "https://github.com/acme/app/issues/123";
const PR = "https://github.com/acme/app/pull/9";

function issue(
	overrides: Partial<ItemFacts> & { lane?: string } = {},
): ItemFacts {
	const { lane = "In Progress", ...rest } = overrides;
	return {
		item: { repo: "acme/app", number: 123, title: "API整理", url: URL },
		kind: "issue",
		state: "open",
		assignedToMe: true,
		projects: [{ project: "acme/7", lane }],
		...rest,
	};
}

function agent(overrides: Partial<InvariantAgent> = {}): InvariantAgent {
	return {
		id: "a1b2c3d4-0000",
		name: "API fix",
		ws: "api",
		workspaceId: "w1",
		managed: true,
		status: "working",
		stopping: false,
		issue: URL,
		...overrides,
	};
}

function escalation(
	overrides: Partial<InvariantEscalation> = {},
): InvariantEscalation {
	return {
		id: 12,
		title: "レビュー待ち",
		state: "waiting",
		links: [],
		agents: ["a1b2c3d4-0000"],
		trigger: "approve されたら",
		waitSince: 7,
		...overrides,
	};
}

const keys = (reading: ReturnType<typeof readInvariant>) =>
	reading.needsAction.map((one) => one.key);
const clauses = (reading: ReturnType<typeof readInvariant>) =>
	reading.needsAction.map((one) => [one.key, one.breach]);

describe("the invariant", () => {
	it("is held by a working linked agent, a 要回答 or a 待機中 escalation", () => {
		expect(
			keys(
				readInvariant({
					items: [issue()],
					agents: [agent()],
					escalations: [],
				}),
			),
		).toEqual([]);
		for (const state of ["needs_answer", "waiting"] as const)
			expect(
				keys(
					readInvariant({
						items: [issue()],
						agents: [agent({ status: "idle" })],
						escalations: [escalation({ state })],
					}),
				),
			).toEqual([]);
	});

	it("says an item nobody is on, or whose agent stopped, by the clause it fails", () => {
		expect(
			clauses(readInvariant({ items: [issue()], agents: [], escalations: [] })),
		).toEqual([[`item ${URL}`, { clause: "no_agent" }]]);
		const idle = readInvariant({
			items: [issue()],
			agents: [agent({ status: "idle" })],
			escalations: [escalation({ state: "in_progress" })],
		});
		expect(clauses(idle)).toEqual([
			[`item ${URL}`, { clause: "idle_no_escalation" }],
			["agent a1b2c3d4-0000", { clause: "idle_no_escalation" }],
		]);
		expect(idle.needsAction[0]?.ws).toBe("api");
	});

	it("leaves out an item whose linked agent is the person's own", () => {
		expect(
			keys(
				readInvariant({
					items: [issue()],
					agents: [agent({ managed: false, status: "idle" })],
					escalations: [],
				}),
			),
		).toEqual([]);
	});

	it("links by meta issue= only, never by branch", () => {
		expect(
			clauses(
				readInvariant({
					items: [issue()],
					agents: [agent({ issue: undefined })],
					escalations: [],
				}),
			),
		).toEqual([
			[`item ${URL}`, { clause: "no_agent" }],
			[
				"agent a1b2c3d4-0000",
				{ clause: "outside_population", outside: "no_item" },
			],
		]);
	});

	it("says a managed agent whose item left the population, working or not, and why", () => {
		for (const [facts, outside] of [
			[{ state: "closed" }, "closed"],
			[{ state: "merged" }, "closed"],
			[{ assignedToMe: false }, "unassigned"],
		] as const) {
			const reading = readInvariant({
				items: [issue(facts)],
				agents: [agent()],
				escalations: [],
			});
			expect(clauses(reading)).toEqual([
				["agent a1b2c3d4-0000", { clause: "outside_population", outside }],
			]);
		}
		// On no registered Project (or none registered: the population is empty).
		const off = readInvariant({
			items: [],
			agents: [agent()],
			escalations: [],
		});
		expect(off.needsAction[0]?.breach).toEqual({
			clause: "outside_population",
			outside: "not_in_project",
		});
	});

	it("treats a pull request item as an Issue", () => {
		const pr = issue({
			item: { repo: "acme/app", number: 9, title: "設定画面", url: PR },
			kind: "pr",
		});
		const nobody = readInvariant({ items: [pr], agents: [], escalations: [] });
		expect(nobody.needsAction.map((one) => [one.key, one.kind])).toEqual([
			[`item ${PR}`, "pr"],
		]);
		expect(
			keys(
				readInvariant({
					items: [pr],
					agents: [agent({ issue: PR })],
					escalations: [],
				}),
			),
		).toEqual([]);
		expect(findItem(nobody, "acme/app#9")?.facts.kind).toBe("pr");
		expect(findItem(nobody, `${PR}/`)?.inPopulation).toBe(true);
	});

	it("applies only the status rule while the population is not known", () => {
		expect(
			keys(
				readInvariant({
					items: undefined,
					agents: [agent({ issue: undefined })],
					escalations: [],
				}),
			),
		).toEqual([]);
		expect(
			keys(
				readInvariant({
					items: undefined,
					agents: [agent({ status: "idle" })],
					escalations: [],
				}),
			),
		).toEqual(["agent a1b2c3d4-0000"]);
	});

	it("finds an escalation about an item by its link, or by a linked agent", () => {
		expect(
			keys(
				readInvariant({
					items: [issue()],
					agents: [],
					escalations: [escalation({ agents: [], links: [`${URL}/`] })],
				}),
			),
		).toEqual([]);
		expect(
			keys(
				readInvariant({
					items: [issue()],
					agents: [agent({ status: "idle" })],
					escalations: [
						escalation({ agents: [], links: ["devhub:agent/a1b2c3d4"] }),
					],
				}),
			),
		).toEqual([]);
	});

	it("tells each agent on a 待機中 escalation what it waits on, and its item", () => {
		const reading = readInvariant({
			items: [issue()],
			agents: [agent({ status: "idle", managed: false })],
			escalations: [escalation()],
		});
		const standing = reading.agents.get("a1b2c3d4-0000");
		expect(standing?.waiting).toEqual({
			escalationId: 12,
			trigger: "approve されたら",
		});
		expect(standing?.item?.item.number).toBe(123);
		expect(standing?.escalations).toEqual([12]);
		expect(reading.items.get(URL)?.agents).toEqual(["a1b2c3d4-0000"]);
	});
});

describe("the watch", () => {
	function watch() {
		const said: OrchestratorEvent[] = [];
		const clock = { now: 0 };
		const made = new InvariantWatch({
			dispatch: (event) => said.push(event),
			now: () => clock.now,
			reminderMs: () => 3_600_000,
			graceMs: 60_000,
		});
		return { watch: made, said, clock };
	}
	const idle = (lane = "In Progress") =>
		readInvariant({
			items: [issue({ lane })],
			agents: [agent({ status: "idle" })],
			escalations: [],
		});

	it("says a subject after the grace by its clause, never its state", () => {
		const { watch: made, said, clock } = watch();
		made.observe(idle(), true);
		expect(said).toEqual([]);
		clock.now = 60_000;
		made.observe(idle(), true);
		expect(said.map((one) => eventLine(one, 0))).toEqual([
			"[needs_action] issue=acme/app#123 ws=api — idle_no_escalation",
			"[needs_action] agent=a1b2c3d4 (API fix) ws=api — idle_no_escalation",
		]);
		expect(made.needsAction()[0]).toMatchObject({
			line: "issue=acme/app#123 ws=api — idle_no_escalation",
			clause: "idle_no_escalation",
			since: 0,
			toldAt: 60_000,
		});
	});

	it("says it again when its state changes, and as a reminder", () => {
		const { watch: made, said, clock } = watch();
		made.observe(idle(), true);
		clock.now = 60_000;
		made.observe(idle(), true);
		made.observe(idle(), true);
		expect(said).toHaveLength(2);
		clock.now = 70_000;
		made.observe(idle("In Review"), true);
		expect(said).toHaveLength(4);
		clock.now = 70_000 + 3_600_000;
		made.observe(idle("In Review"), true);
		expect(said).toHaveLength(6);
	});

	it("forgets a subject that settles: needing action again is a new grace", () => {
		const { watch: made, said, clock } = watch();
		made.observe(idle(), true);
		clock.now = 30_000;
		made.observe(
			readInvariant({ items: [issue()], agents: [agent()], escalations: [] }),
			true,
		);
		clock.now = 70_000;
		made.observe(idle(), true);
		expect(said).toEqual([]);
	});

	it("keeps an agent as it is, with its note, until its state changes", () => {
		const { watch: made, said, clock } = watch();
		const outside = (status: string) =>
			readInvariant({
				items: [issue({ assignedToMe: false })],
				agents: [agent({ status })],
				escalations: [],
			});
		made.observe(outside("working"), true);
		const kept = made.keep("a1b2c3d4-0000", "他チームの依頼で続ける");
		expect(kept.note).toBe("他チームの依頼で続ける");
		clock.now = 60_000 + 3_600_000;
		made.observe(outside("working"), true);
		expect(said).toEqual([]);
		expect(made.needsAction()[0]?.kept?.note).toBe("他チームの依頼で続ける");
		// It went idle: its state moved, the keeping is over.
		made.observe(outside("idle"), true);
		expect(said.map((one) => one.type)).toEqual(["needs_action"]);
		expect(made.kept("a1b2c3d4-0000")).toBeUndefined();
		expect(() => made.keep("nobody", "x")).toThrow(/does not need action/u);
	});

	it("keeps a keeping across a restart, judged again once the state is known", () => {
		const stored = new Map<string, KeptAgent>();
		const store = {
			load: () => new Map(stored),
			save: (kept: ReadonlyMap<string, KeptAgent>) => {
				stored.clear();
				for (const [id, one] of kept) stored.set(id, one);
			},
		};
		const make = () =>
			new InvariantWatch({
				dispatch: () => undefined,
				now: () => 0,
				reminderMs: () => 3_600_000,
				kept: store,
			});
		const outside = (status: string, known = true) =>
			readInvariant({
				items: known ? [issue({ assignedToMe: false })] : undefined,
				agents: [agent({ status })],
				escalations: [],
			});
		const before = make();
		before.observe(outside("working"), true);
		before.keep("a1b2c3d4-0000", "他チームの依頼で続ける");
		expect([...stored.keys()]).toEqual(["a1b2c3d4-0000"]);
		// DevHub restarts: GitHub not read yet, the agent not read yet.
		const after = make();
		after.observe(outside("working", false), true);
		after.observe(outside("unknown"), true);
		expect(after.kept("a1b2c3d4-0000")?.note).toBe("他チームの依頼で続ける");
		// Read again as it was: still kept.
		after.observe(outside("working"), true);
		expect(after.needsAction()[0]?.kept?.note).toBe("他チームの依頼で続ける");
		// Its state moved: over, on disk too.
		after.observe(outside("idle"), true);
		expect(after.kept("a1b2c3d4-0000")).toBeUndefined();
		expect(stored.size).toBe(0);
	});

	it("says a wait whose subject moved, never its first look", () => {
		const { watch: made, said } = watch();
		const waiting = (review: "none" | "approved") =>
			readInvariant({
				items: [
					issue({
						pull: {
							number: 130,
							state: "open",
							review,
							unresolved: 0,
							checks: "passing",
						},
					}),
				],
				agents: [agent({ status: "idle" })],
				escalations: [escalation()],
			});
		made.observe(waiting("none"), true);
		made.observe(waiting("none"), true);
		expect(said).toEqual([]);
		made.observe(waiting("approved"), true);
		expect(said).toEqual([
			{
				type: "waiting.changed",
				escalationId: 12,
				reasons: ["subjects_changed"],
				waitSince: 7,
			},
		]);
	});

	it("says nothing with nobody to tell, and everything again after a reset", () => {
		const { watch: made, said, clock } = watch();
		made.observe(idle(), false);
		clock.now = 60_000;
		made.observe(idle(), false);
		expect(said).toEqual([]);
		made.observe(idle(), true);
		expect(said).toHaveLength(2);
		made.reset();
		made.observe(idle(), true);
		clock.now = 120_000;
		made.observe(idle(), true);
		expect(said).toHaveLength(4);
	});
});
