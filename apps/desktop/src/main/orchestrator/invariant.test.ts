import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "./events.js";
import {
	InvariantWatch,
	readInvariant,
	type InvariantAgent,
	type InvariantEscalation,
	type ItemFacts,
} from "./invariant.js";

const URL = "https://github.com/acme/app/issues/123";

function issue(
	overrides: Partial<ItemFacts> & { lane?: string } = {},
): ItemFacts {
	const { lane = "In Progress", ...rest } = overrides;
	return {
		item: { repo: "acme/app", number: 123, title: "API整理", url: URL },
		kind: "issue",
		open: true,
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
		...overrides,
	};
}

const keys = (reading: ReturnType<typeof readInvariant>) =>
	reading.unsettled.map((one) => one.key);

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

	it("says an Issue nobody is on, and an idle managed agent nothing settles", () => {
		const reading = readInvariant({
			items: [issue()],
			agents: [agent({ status: "idle" })],
			escalations: [escalation({ state: "in_progress" })],
		});
		expect(keys(reading)).toEqual([`item ${URL}`, "agent a1b2c3d4-0000"]);
		expect(reading.unsettled[0]?.facts).toEqual([
			"state=open",
			"assigned=yes",
			'lane="In Progress"',
			"pr=none",
			"agents=a1b2c3d4:idle",
			"esc=12:in_progress",
		]);
		const none = readInvariant({
			items: [issue()],
			agents: [],
			escalations: [],
		});
		expect(none.unsettled[0]?.facts).toContain("agents=none");
	});

	it("leaves out an Issue whose linked agent is the person's own", () => {
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
			keys(
				readInvariant({
					items: [issue()],
					agents: [agent({ issue: undefined })],
					escalations: [],
				}),
			),
		).toEqual([`item ${URL}`, "agent a1b2c3d4-0000"]);
	});

	it("says a managed agent whose Issue left the population, working or not, with the facts", () => {
		for (const [facts, word] of [
			[{ open: false }, "state=closed"],
			[{ assignedToMe: false }, "assigned=no"],
		] as const) {
			const reading = readInvariant({
				items: [issue(facts)],
				agents: [agent()],
				escalations: [],
			});
			expect(keys(reading)).toEqual(["agent a1b2c3d4-0000"]);
			expect(reading.unsettled[0]?.facts).toContain(word);
		}
		// Not looked up yet: only the status rule.
		expect(
			keys(readInvariant({ items: [], agents: [agent()], escalations: [] })),
		).toEqual([]);
		const gone = readInvariant({
			items: [],
			missing: () => true,
			agents: [agent()],
			escalations: [],
		});
		expect(gone.unsettled[0]?.facts).toContain("item=none");
		const noIssue = readInvariant({
			items: [],
			agents: [agent({ issue: undefined })],
			escalations: [],
		});
		expect(noIssue.unsettled[0]?.facts).toContain("issue=none");
	});

	it("treats a pull request item as an Issue", () => {
		const PR = "https://github.com/acme/app/pull/9";
		const pr = issue({
			item: { repo: "acme/app", number: 9, title: "設定画面", url: PR },
			kind: "pr",
		});
		const nobody = readInvariant({ items: [pr], agents: [], escalations: [] });
		expect(nobody.unsettled.map((one) => [one.key, one.kind])).toEqual([
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

	it("finds an escalation about an Issue by its link, or by a linked agent", () => {
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

	it("tells each agent on a 待機中 escalation what it waits on", () => {
		const reading = readInvariant({
			items: [issue()],
			agents: [agent({ status: "idle", managed: false })],
			escalations: [escalation()],
		});
		expect(reading.agents.get("a1b2c3d4-0000")?.waiting).toEqual({
			escalationId: 12,
			trigger: "approve されたら",
		});
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
	const idle = () =>
		readInvariant({
			items: [issue()],
			agents: [agent({ status: "idle" })],
			escalations: [],
		});

	it("says a subject after the grace, again when its facts change, and as a reminder", () => {
		const { watch: made, said, clock } = watch();
		made.observe(idle(), true);
		expect(said).toEqual([]);
		clock.now = 60_000;
		made.observe(idle(), true);
		expect(said.map((one) => one.type)).toEqual(["unsettled", "unsettled"]);
		made.observe(idle(), true);
		expect(said).toHaveLength(2);
		clock.now = 70_000;
		made.observe(
			readInvariant({
				items: [issue({ lane: "In Review" })],
				agents: [agent({ status: "idle" })],
				escalations: [],
			}),
			true,
		);
		expect(said).toHaveLength(4);
		clock.now = 70_000 + 3_600_000;
		made.observe(
			readInvariant({
				items: [issue({ lane: "In Review" })],
				agents: [agent({ status: "idle" })],
				escalations: [],
			}),
			true,
		);
		expect(said).toHaveLength(6);
	});

	it("forgets a subject that settles: unsettled again is a new grace", () => {
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

	it("keeps an agent as it is, with its note, until its facts change", () => {
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
		expect(made.unsettled()[0]?.kept?.note).toBe("他チームの依頼で続ける");
		// It went idle: its facts moved, the keeping is over.
		made.observe(outside("idle"), true);
		expect(said.map((one) => one.type)).toEqual(["unsettled"]);
		expect(made.kept("a1b2c3d4-0000")).toBeUndefined();
		expect(() => made.keep("nobody", "x")).toThrow(/not unsettled/u);
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
			expect.objectContaining({
				type: "waiting.changed",
				escalationId: 12,
				facts: expect.arrayContaining(["review=approved"]) as unknown,
			}),
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
