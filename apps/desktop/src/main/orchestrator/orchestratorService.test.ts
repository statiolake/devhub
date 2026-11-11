import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { EscalationStore } from "./escalationStore.js";
import { escalationState } from "../../model/escalations.js";
import type { InvariantAgent, ItemFacts } from "./invariant.js";
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
		items?: ItemFacts[];
		managed?: boolean;
		/** WORKER as the first reading finds it (a restart restoring it). */
		worker?: { status: string; maintenance?: boolean };
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
		...(id === WORKER ? options.worker : {}),
	}));
	const invariant = {
		items: options.items as ItemFacts[] | undefined,
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
			items: invariant.items,
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
		// On, as the tests below were written; a launch starts off.
		mode: "full",
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

function issue(overrides: Partial<ItemFacts> = {}): ItemFacts {
	return {
		item: { repo: "acme/app", number: 123, title: "API整理", url: ISSUE_URL },
		kind: "issue",
		state: "open",
		assignedToMe: true,
		projects: [{ project: "acme/7", lane: "Todo" }],
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

	it("stays 要回答 through the CLI started again on its session (/resume, Restart Session, a wake)", () => {
		const run = world();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.service.wait(one.id, { trigger: "x" });
		// Its `rewinding` turn: working, and upkeep.
		run.status(WORKER, "working", true);
		run.status(WORKER, "idle");
		expect(escalationState(run.store.require(one.id))).toBe("waiting");
	});

	it("is not moved by a restart of DevHub: the replayed past, and what follows it, are not going back to work", () => {
		// Restored mid-replay: first seen working, restoring.
		const run = world({ worker: { status: "working", maintenance: true } });
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		// The replay ends on a turn still running in the CLI.
		run.status(WORKER, "working");
		run.status(WORKER, "idle");
		expect(escalationState(run.store.require(one.id))).toBe("needs_answer");
		expect(run.store.require(one.id).entries).toHaveLength(1);
		// A real turn after it is work again.
		run.status(WORKER, "working");
		expect(escalationState(run.store.require(one.id))).toBe("in_progress");
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

	it("is on the board's next delivery while paused, as resume sends it", () => {
		const run = world();
		const one = run.service.raise({ title: "t", markdown: "?" });
		run.service.events.pause();
		run.service.answer(one.id, "はい");
		const next = run.service.wire().nextDelivery;
		expect(next).toEqual({
			human: ["esc=1「t」 への人の回答:\nはい"],
			lines: 0,
			more: 0,
			when: { kind: "paused" },
		});
		expect(run.service.events.held()).toHaveLength(1);
		run.service.events.resume();
		expect(run.sent).toEqual(next?.human);
		expect(run.service.wire().nextDelivery).toEqual({
			human: [],
			lines: 0,
			more: 0,
		});
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

	it("says waiting.changed due once when --at passes, and drops it once it left 待機中", async () => {
		const run = world();
		const one = run.service.raise({ title: "再開", markdown: "?" });
		run.service.wait(one.id, {
			trigger: "11/10 以降に再開",
			dueAt: run.clock.now + HOUR,
		});
		run.later(HOUR - 1000);
		expect(run.of("waiting.changed")).toHaveLength(0);
		run.later(2000);
		run.later(HOUR);
		expect(run.of("waiting.changed")).toHaveLength(1);
		// The orchestrator's own wake-up: at its time, as a message alone.
		expect(
			run.sent.filter((text) => text.includes("[waiting.changed]")),
		).toEqual(["[waiting.changed] esc=1 — due"]);
		const two = run.service.raise({ title: "後で", markdown: "?" });
		run.service.events.pause();
		run.service.wait(two.id, { trigger: "x", dueAt: run.clock.now - 1 });
		expect(run.of("waiting.changed")).toHaveLength(2);
		run.service.resume(two.id, undefined);
		await run.service.events.resume();
		expect(run.of("waiting.changed")[1]!.fate).toBe("dropped-stale");
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
	it("reads an escalation linked to the item at once: a 待機中 one about it stops no_agent", () => {
		const run = world({ items: [issue()] });
		run.later(61_000);
		expect(run.sent).toEqual(["[needs_action] issue=acme/app#123 — no_agent"]);
		const one = run.service.raise({ title: "待ち", markdown: "?" });
		run.service.wait(one.id, { trigger: "B の返事" });
		run.service.link(one.id, { links: [ISSUE_URL] });
		expect(run.service.wire().needsAction).toEqual([]);
		run.later(61_000);
		expect(run.sent.filter((line) => line.includes("[needs_action]"))).toEqual([
			"[needs_action] issue=acme/app#123 — no_agent",
		]);
	});

	it("says an open item of mine nobody is on at once, and again at every delivery while it stays so", () => {
		const run = world({ items: [issue()] });
		// No grace: every delivery while it stands carries it — the start's
		// with init, then one per delivery (each waits to see the last one
		// taken, at most a minute here).
		run.later(61_000);
		expect(run.sent).toEqual(["[needs_action] issue=acme/app#123 — no_agent"]);
		run.later(61_000);
		expect(run.sent).toEqual([
			"[needs_action] issue=acme/app#123 — no_agent",
			"[needs_action] issue=acme/app#123 — no_agent",
		]);
		// The start's delivery (with init) carries it too: the invariant is
		// read whenever the escalations change, so it is read before then.
		expect(run.of("needs_action").map((one) => one.fate)).toEqual([
			"delivered",
			"delivered",
			"delivered",
		]);
		expect(run.service.wire().needsAction).toEqual([
			expect.objectContaining({
				kind: "issue",
				key: `item ${ISSUE_URL}`,
				clause: "no_agent",
			}),
		]);
	});

	it("is settled by a working linked agent, and by a 待機中 escalation about the Issue", () => {
		const run = world({ items: [issue()], managed: true });
		run.invariant.links.set(WORKER, ISSUE_URL);
		run.status(WORKER, "working");
		run.later(120_000);
		// Nothing needs action: nothing is sent at all.
		expect(run.sent).toEqual([]);
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			links: [ISSUE_URL],
		});
		run.service.wait(one.id, { trigger: "レビュー待ち" });
		run.status(WORKER, "idle");
		run.later(120_000);
		// The Issue waits; the idle managed agent is on no escalation.
		expect(run.sent.at(-1)).toBe(
			"[needs_action] agent=a1b2c3d4 (agent a1) ws=w — idle_no_escalation",
		);
		expect(run.service.wire().agentStates[WORKER]?.needsAction).toBe(
			"idle_no_escalation",
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

	it("says a managed agent whose Issue is closed or not mine, and leaves out one kept with a reason until its facts change", () => {
		const run = world({
			items: [issue({ assignedToMe: false })],
			managed: true,
		});
		run.invariant.links.set(WORKER, ISSUE_URL);
		run.status(WORKER, "working");
		run.later(61_000);
		expect(run.of("needs_action").at(-1)?.event).toMatchObject({
			breach: { clause: "outside_population", outside: "unassigned" },
		});
		const kept = run.service.keep(WORKER, "他チームの依頼で続ける");
		expect(kept.note).toBe("他チームの依頼で続ける");
		expect(run.service.standing(WORKER)?.kept?.note).toBe(
			"他チームの依頼で続ける",
		);
		expect(run.service.wire().agentStates[WORKER]?.kept?.note).toBe(
			"他チームの依頼で続ける",
		);
		const said = run.of("needs_action").length;
		run.sent.length = 0;
		for (let index = 0; index < 5; index += 1) run.later(61_000);
		// Kept, and nothing else to say: no delivery at all.
		expect(run.of("needs_action")).toHaveLength(said);
		expect(run.sent).toEqual([]);
		// Its Issue closed: the facts moved, it is said again.
		run.invariant.items = [issue({ assignedToMe: false, state: "closed" })];
		run.later(61_000);
		expect(run.of("needs_action")).toHaveLength(said + 1);
		expect(run.service.standing(WORKER)?.kept).toBeUndefined();
	});

	it("carries the standing lines beside what is pending, as one message", () => {
		const run = world({ items: [issue()] });
		run.later(61_000);
		run.sent.length = 0;
		run.service.emit("custom.deploy", "staging");
		run.later(61_000);
		expect(run.sent).toEqual([
			"[custom.deploy] — staging\n[needs_action] issue=acme/app#123 — no_agent",
		]);
	});
});
