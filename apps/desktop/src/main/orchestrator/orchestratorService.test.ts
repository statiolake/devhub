import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { EscalationStore } from "./escalationStore.js";
import { escalationState } from "../../model/escalations.js";
import type { InvariantAgent, IssueFacts } from "./invariant.js";
import { OrchestratorService, type LiveAgent } from "./orchestratorService.js";

const ORCH = "orch-0000";
const WORKER = "a1b2c3d4-0000-4000-8000-000000000000";
const OTHER = "e5f6a7b8-0000-4000-8000-000000000000";
const ISSUE_URL = "https://github.com/acme/app/issues/123";
const tick = () => new Promise((done) => setTimeout(done, 0));

/**
 * A service, its orchestrator free unless `busy`, its live agents (idle),
 * and what the invariant reads: the board's Issues and each agent's flag.
 */
function world(
	options: {
		cursor?: { value?: string; text?: string };
		prompt?: string;
		issues?: IssueFacts[];
		managed?: boolean;
	} = {},
) {
	const clock = { now: 1_000_000 };
	const sent: string[] = [];
	const read: [string, number, number][] = [];
	const state = { busy: false };
	const agents: LiveAgent[] = [ORCH, WORKER, OTHER].map((id) => ({
		id,
		name: id === ORCH ? "orchestrator" : `agent ${id.slice(0, 2)}`,
		workspaceId: "w",
		workspaceLabel: "w",
		status: "idle",
		stopping: false,
	}));
	const invariant = {
		issues: options.issues as IssueFacts[] | undefined,
		managed: new Set<string>(options.managed === true ? [WORKER] : []),
		links: new Map<string, string>(),
	};
	const store = EscalationStore.inMemory();
	const cursor = options.cursor ?? { value: "e39" };
	const service = new OrchestratorService({
		store,
		agents: () => agents,
		settings: () => ({
			...DEFAULT_ORCHESTRATOR,
			events: ["*"],
			event_prompt: options.prompt ?? "{EVENT}",
			delivery_interval: "10s",
		}),
		startProblem: () => undefined,
		deliver: (_agent, text) => sent.push(text),
		busy: () => state.busy,
		acknowledged: (agentId, id, entries) => read.push([agentId, id, entries]),
		publish: () => undefined,
		personMessage: () =>
			Promise.resolve({
				...(cursor.value === undefined ? {} : { since: cursor.value }),
				...(cursor.text === undefined ? {} : { text: cursor.text }),
			}),
		invariant: () => ({
			issues: invariant.issues,
			agents: agents.map(
				(agent): InvariantAgent => ({
					id: agent.id,
					name: agent.name,
					ws: agent.workspaceLabel,
					workspaceId: agent.workspaceId,
					managed: invariant.managed.has(agent.id),
					status: agent.status,
					stopping: agent.stopping,
					...(invariant.links.has(agent.id)
						? { issue: invariant.links.get(agent.id)! }
						: {}),
				}),
			),
		}),
		now: () => clock.now,
	});
	service.setGrace(60_000);
	service.assign(ORCH);
	service.observe();
	sent.length = 0;
	const status = (id: string, to: string, maintenance = false) => {
		const agent = agents.find((one) => one.id === id) as {
			status: string;
			maintenance?: boolean;
		};
		agent.status = to;
		if (maintenance) agent.maintenance = true;
		else delete agent.maintenance;
		clock.now += 1_000;
		service.observe();
	};
	const later = (ms: number) => {
		clock.now += ms;
		service.observe();
		service.events.flush();
	};
	const of = (type: string) =>
		service.events.recent(200).filter((entry) => entry.event.type === type);
	return {
		service,
		store,
		sent,
		read,
		state,
		clock,
		status,
		later,
		of,
		invariant,
	};
}

function issue(overrides: Partial<IssueFacts> = {}): IssueFacts {
	return {
		item: { repo: "acme/app", number: 123, title: "API整理", url: ISSUE_URL },
		open: true,
		assignedToMe: true,
		project: "acme/7",
		lane: "Todo",
		...overrides,
	};
}

describe("an escalation's agent going back to work", () => {
	it("moves a needs_answer one to in_progress on the person's own words, and sends their words at once", async () => {
		const run = world({
			cursor: { value: "e39", text: "やっぱり staging だけで" },
		});
		const one = run.service.raise({
			title: "本番DBマイグレーション承認",
			markdown: "?",
			agents: [WORKER],
		});
		run.state.busy = true;
		run.service.personSent(WORKER);
		run.status(WORKER, "working");
		const now = run.store.require(one.id);
		expect(escalationState(now)).toBe("in_progress");
		expect(now.entries.at(-1)).toMatchObject({
			role: "human",
			kind: "direct",
			agent: WORKER,
		});
		await tick();
		expect(run.sent).toEqual([
			`esc=${String(one.id)}「本番DBマイグレーション承認」 agent=a1b2c3d4 に人が直接送ったメッセージ:\nやっぱり staging だけで`,
		]);
		run.status(WORKER, "working");
		expect(run.of("escalation.human_direct")).toHaveLength(1);
		run.service.ask(one.id, "staging も?", undefined);
		expect(escalationState(run.store.require(one.id))).toBe("needs_answer");
	});

	it("moves it for any other cause too, with a resumed note and no event", () => {
		const run = world();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.status(WORKER, "working");
		expect(run.store.require(one.id).entries.at(-1)).toMatchObject({
			kind: "resumed",
			agent: WORKER,
		});
		expect(run.of("escalation.human_direct")).toHaveLength(0);
	});

	it("stays 要回答 through a keep-warm /compact: no note, no event", () => {
		const run = world();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.status(WORKER, "working", true);
		run.status(WORKER, "idle");
		expect(escalationState(run.store.require(one.id))).toBe("needs_answer");
	});
});

describe("the person's answer", () => {
	it("goes at once as their own words, not in the template, and counts as read", () => {
		const run = world({ prompt: "/make-progress {EVENT}" });
		const one = run.service.raise({
			title: "本番DBマイグレーション承認",
			markdown: "流してよい?",
			options: ["承認する", "来週にする"],
			agents: [WORKER],
		});
		run.state.busy = true;
		run.service.answer(one.id, "承認する");
		expect(run.sent).toEqual([
			"esc=1「本番DBマイグレーション承認」 への人の回答 (選択肢「承認する」):\n承認する",
		]);
		expect(run.read).toEqual([[ORCH, one.id, 2]]);
	});

	it("is held by a pause and goes first on resume", async () => {
		const run = world();
		const one = run.service.raise({ title: "t", markdown: "?" });
		run.service.events.pause();
		run.service.answer(one.id, "はい");
		expect(run.sent).toEqual([]);
		await run.service.events.resume();
		expect(run.sent).toEqual(["esc=1「t」 への人の回答:\nはい"]);
	});
});

describe("停滞 on the board", () => {
	it("marks a 対応中 one none of whose agents works, past the grace, and says no event", () => {
		const run = world();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.service.answer(one.id, "OK");
		run.later(30_000);
		expect(
			run.service.toWire(run.store.require(one.id)).stalledSince,
		).toBeUndefined();
		run.later(31_000);
		expect(
			run.service.toWire(run.store.require(one.id)).stalledSince,
		).toBeDefined();
		expect(
			run.service.events.recent(200).map((one) => one.event.type),
		).not.toContain("escalation.stalled");
	});
});

describe("待機中 (escalation wait)", () => {
	const HOUR = 3_600_000;

	it("tells wait_due once when --at passes, and drops it once it left 待機中", async () => {
		const run = world();
		const one = run.service.raise({ title: "再開", markdown: "?" });
		run.service.wait(one.id, {
			trigger: "11/10 以降に再開",
			dueAt: run.clock.now + HOUR,
		});
		run.later(HOUR - 1000);
		expect(run.of("escalation.wait_due")).toHaveLength(0);
		run.later(2000);
		run.later(HOUR);
		expect(run.of("escalation.wait_due")).toHaveLength(1);
		expect(run.sent.at(-1)).toContain(
			"[escalation.wait_due] esc=1「再開」 due=",
		);
		const two = run.service.raise({ title: "後で", markdown: "?" });
		run.service.events.pause();
		run.service.wait(two.id, { trigger: "x", dueAt: run.clock.now - 1 });
		expect(run.of("escalation.wait_due")).toHaveLength(2);
		run.service.resume(two.id, undefined);
		await run.service.events.resume();
		expect(run.of("escalation.wait_due")[1]!.fate).toBe("dropped-stale");
	});

	it("leaves 待機中 when an agent of it goes working, but not on a maintenance turn", () => {
		const run = world();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.service.wait(one.id, { trigger: "x" });
		run.status(WORKER, "working", true);
		expect(escalationState(run.store.require(one.id))).toBe("waiting");
		run.status(WORKER, "idle");
		run.status(WORKER, "working");
		expect(escalationState(run.store.require(one.id))).toBe("in_progress");
	});
});

describe("the invariant", () => {
	it("says an open Issue of mine nobody is on, after the grace, as a batch line", () => {
		const run = world({ issues: [issue()] });
		run.later(30_000);
		expect(run.of("unsettled")).toHaveLength(0);
		run.later(31_000);
		expect(run.of("unsettled")).toHaveLength(1);
		expect(run.sent.at(-1)).toBe(
			"[unsettled] issue=acme/app#123「API整理」 state=open assigned=yes lane=Todo pr=none agents=none esc=none https://github.com/acme/app/issues/123",
		);
		expect(run.service.wire().unsettled).toEqual([
			expect.objectContaining({ kind: "issue", key: `issue ${ISSUE_URL}` }),
		]);
	});

	it("is settled by a working linked agent, and by a 待機中 escalation about the Issue", () => {
		const run = world({ issues: [issue()], managed: true });
		run.invariant.links.set(WORKER, ISSUE_URL);
		run.status(WORKER, "working");
		run.later(120_000);
		expect(run.of("unsettled")).toHaveLength(0);
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			links: [ISSUE_URL],
		});
		run.service.wait(one.id, { trigger: "レビュー待ち" });
		run.status(WORKER, "idle");
		run.later(120_000);
		// The Issue waits; the idle managed agent is on no escalation.
		expect(run.of("unsettled").map((entry) => entry.event)).toEqual([
			expect.objectContaining({
				subject: {
					kind: "agent",
					agent: expect.objectContaining({ id: WORKER }) as unknown,
				},
			}),
		]);
		expect(run.service.wire().agentStates[WORKER]?.unsettled).toContain(
			"status=idle",
		);
	});

	it("shows a 待機中 escalation's agents as waiting, with the trigger", () => {
		const run = world({ managed: true });
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.service.wait(one.id, { trigger: "Bob の返事" });
		expect(run.service.wire().agentStates[WORKER]).toEqual({
			waiting: { escalationId: one.id, trigger: "Bob の返事" },
		});
	});

	it("says a managed agent whose Issue is closed or not mine, and keeps one with a reason", () => {
		const run = world({
			issues: [issue({ assignedToMe: false })],
			managed: true,
		});
		run.invariant.links.set(WORKER, ISSUE_URL);
		run.status(WORKER, "working");
		run.later(61_000);
		expect(run.of("unsettled").at(-1)?.event).toMatchObject({
			facts: expect.arrayContaining([
				"status=working",
				"assigned=no",
			]) as unknown,
		});
		const kept = run.service.keep(WORKER, "他チームの依頼で続ける");
		expect(kept.note).toBe("他チームの依頼で続ける");
		expect(run.service.standing(WORKER)?.kept?.note).toBe(
			"他チームの依頼で続ける",
		);
		expect(run.service.wire().agentStates[WORKER]?.kept?.note).toBe(
			"他チームの依頼で続ける",
		);
		run.later(2 * 3_600_000);
		expect(run.of("unsettled")).toHaveLength(1);
		// Its Issue closed: the facts moved, it is said again.
		run.invariant.issues = [issue({ assignedToMe: false, open: false })];
		run.later(1_000);
		expect(run.of("unsettled")).toHaveLength(2);
		expect(run.service.standing(WORKER)?.kept).toBeUndefined();
	});

	it("says every subject again to a new orchestrator", () => {
		const run = world({ issues: [issue()] });
		run.later(61_000);
		expect(run.of("unsettled")).toHaveLength(1);
		run.service.assign(ORCH);
		run.later(61_000);
		expect(run.of("unsettled")).toHaveLength(2);
	});
});
