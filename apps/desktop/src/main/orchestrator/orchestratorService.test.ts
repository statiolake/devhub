import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { EscalationStore } from "./escalationStore.js";
import { escalationState } from "../../model/escalations.js";
import { OrchestratorService, type LiveAgent } from "./orchestratorService.js";

const ORCH = "orch-0000";
const WORKER = "a1b2c3d4-0000-4000-8000-000000000000";

/** A service whose orchestrator is busy until `free()`, and its live agents. */
function world() {
	const clock = { now: 1_000_000 };
	const sent: string[] = [];
	const state = { busy: true };
	const agents: LiveAgent[] = [
		{
			id: ORCH,
			name: "orchestrator",
			workspaceId: "w0",
			workspaceLabel: "orchestrator",
			status: "idle",
			stopping: false,
		},
		{
			id: WORKER,
			name: "API fix",
			workspaceId: "w1",
			workspaceLabel: "api",
			status: "idle",
			stopping: false,
		},
	];
	const store = EscalationStore.inMemory();
	const service = new OrchestratorService({
		store,
		agents: () => agents,
		settings: () => ({ ...DEFAULT_ORCHESTRATOR, events: ["*"] }),
		startProblem: () => undefined,
		deliver: (_agent, text) => sent.push(text),
		busy: () => state.busy,
		publish: () => undefined,
		now: () => clock.now,
	});
	service.setGrace(0);
	service.assign(ORCH);
	const worker = agents[1]!;
	return {
		service,
		sent,
		worker,
		clock,
		free() {
			state.busy = false;
			service.events.flush();
		},
		fates: () =>
			service.events.recent(20).map((one) => [one.event.type, one.fate]),
	};
}

describe("the orchestrator's events, re-read before they go", () => {
	it("tells nothing of an idle agent no escalation names: there is no 不明", () => {
		const run = world();
		run.clock.now += 10 * 60_000;
		run.service.observe();
		run.free();
		expect(run.fates().map(([type]) => type)).toEqual(["init"]);
		expect("unaccounted" in run.service.wire()).toBe(false);
	});

	it("drops a turn whose agent is working again, and keeps one still idle", () => {
		const run = world();
		const turn = { type: "agent.turn_ended" as const, agent: { id: WORKER } };
		run.service.events.dispatch(turn);
		(run.worker as { status: string }).status = "working";
		run.free();
		expect(run.fates()).toContainEqual(["agent.turn_ended", "dropped-stale"]);
		const again = world();
		again.service.events.dispatch(turn);
		again.free();
		expect(again.sent[0]).toContain("[agent.turn_ended]");
	});

	it("drops a question already answered", () => {
		const run = world();
		(run.worker as { status: string }).status = "waiting";
		run.service.events.dispatch({
			type: "agent.asked",
			agent: { id: WORKER },
			request: "q1",
			headers: ["順番"],
		});
		(run.worker as { status: string }).status = "working";
		run.free();
		expect(run.fates()).toContainEqual(["agent.asked", "dropped-stale"]);
	});

	it("drops an answer to an escalation that is closed since", () => {
		const run = world();
		const one = run.service.raise({ title: "承認", markdown: "?" });
		run.service.answer(one.id, "OK");
		run.service.close(one.id, undefined);
		run.free();
		expect(run.fates()).toContainEqual([
			"escalation_answered",
			"dropped-stale",
		]);
		expect(run.sent[0]).not.toContain("[escalation_answered]");
	});
});

/** Past the cursor read: its promise and what it sets off. */
const tick = () => new Promise((done) => setTimeout(done, 0));

describe("an escalation's agent going back to work", () => {
	const OTHER = "e5f6a7b8-0000-4000-8000-000000000000";

	/** `world()`, its worker idle and seen so, the orchestrator free. */
	function settled(cursor: { value?: string } = { value: "e39" }) {
		const clock = { now: 1_000_000 };
		const sent: string[] = [];
		const agents: LiveAgent[] = [ORCH, WORKER, OTHER].map((id) => ({
			id,
			name: id === ORCH ? "orchestrator" : `agent ${id.slice(0, 2)}`,
			workspaceId: "w",
			workspaceLabel: "w",
			status: "idle",
			stopping: false,
		}));
		const store = EscalationStore.inMemory();
		const service = new OrchestratorService({
			store,
			agents: () => agents,
			settings: () => DEFAULT_ORCHESTRATOR,
			startProblem: () => undefined,
			deliver: (_agent, text) => sent.push(text),
			publish: () => undefined,
			personCursor: () => Promise.resolve(cursor.value),
			now: () => clock.now,
		});
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
		const direct = () =>
			service.events
				.recent(50)
				.filter((one) => one.event.type === "escalation.human_direct");
		return { service, store, sent, status, direct, clock };
	}

	it("moves a needs_answer one to in_progress on the person's own words, and tells the orchestrator once", async () => {
		const run = settled();
		const one = run.service.raise({
			title: "本番DBマイグレーション承認",
			markdown: "?",
			agents: [WORKER],
		});
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
		expect(run.direct()).toHaveLength(1);
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain(
			`[escalation.human_direct] esc=${String(one.id)}「本番DBマイグレーション承認」 agent=a1b2c3d4 (agent a1) since=e39 — 人がエージェントと直接やりとりしました`,
		);
		// Still working: nothing more.
		run.status(WORKER, "working");
		expect(run.direct()).toHaveLength(1);
		// The orchestrator asks again: back to 要回答.
		run.service.ask(one.id, "staging も?", undefined);
		expect(escalationState(run.store.require(one.id))).toBe("needs_answer");
	});

	it("waits for the turn a message held mid-turn starts", async () => {
		const run = settled();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.status(WORKER, "working");
		// Working on something else already: the running turn left 要回答 …
		expect(run.store.require(one.id).entries.at(-1)?.kind).toBe("resumed");
		run.service.personSent(WORKER);
		run.status(WORKER, "working");
		expect(run.direct()).toHaveLength(0);
		run.status(WORKER, "idle");
		run.status(WORKER, "working");
		await tick();
		// … and an in_progress one is still told, but not written to.
		expect(run.direct()).toHaveLength(1);
		expect(
			run.store.require(one.id).entries.filter((entry) => entry.kind),
		).toHaveLength(1);
	});

	it("moves it for any other cause too, with a resumed note and no event", () => {
		for (const how of ["agent send", "an injected event", "a resume"]) {
			const run = settled();
			const one = run.service.raise({
				title: how,
				markdown: "?",
				agents: [WORKER],
			});
			// None of these comes through `personSent`.
			run.status(WORKER, "working");
			const now = run.store.require(one.id);
			expect(escalationState(now)).toBe("in_progress");
			expect(now.entries.at(-1)).toMatchObject({
				kind: "resumed",
				agent: WORKER,
			});
			expect(run.direct()).toHaveLength(0);
			expect(run.sent).toEqual([]);
			run.service.ask(one.id, "もう一度", undefined);
			expect(escalationState(run.store.require(one.id))).toBe("needs_answer");
		}
	});

	it("stays 要回答 through a compaction or a keep-warm /compact: no note, no event", async () => {
		for (const how of [
			"DevHub's keep-warm /compact",
			"the person's /compact",
		]) {
			const run = settled();
			const one = run.service.raise({
				title: how,
				markdown: "?",
				agents: [WORKER],
			});
			if (how === "the person's /compact") run.service.personSent(WORKER);
			run.status(WORKER, "working", true);
			run.status(WORKER, "working", true);
			run.status(WORKER, "idle");
			await tick();
			expect(escalationState(run.store.require(one.id))).toBe("needs_answer");
			expect(run.store.require(one.id).entries).toHaveLength(1);
			expect(run.direct()).toHaveLength(0);
			expect(run.sent).toEqual([]);
			// The person's /compact took its mark with it: what the
			// orchestrator sends next is not the person's.
			run.status(WORKER, "working");
			await tick();
			expect(run.store.require(one.id).entries.at(-1)?.kind).toBe("resumed");
			expect(run.direct()).toHaveLength(0);
		}
	});

	it("still counts a real turn right after a compaction, with no idle seen between", async () => {
		const run = settled();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.status(WORKER, "working", true);
		// The person writes meanwhile: held until the compaction ends.
		run.service.personSent(WORKER);
		run.status(WORKER, "working", true);
		run.status(WORKER, "working");
		await tick();
		expect(run.store.require(one.id).entries.at(-1)).toMatchObject({
			kind: "direct",
			agent: WORKER,
		});
		expect(run.direct()).toHaveLength(1);
	});

	it("leaves alone an escalation about other agents, and a closed one", () => {
		const run = settled();
		const elsewhere = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [OTHER],
		});
		const closed = run.service.raise({
			title: "c",
			markdown: "?",
			agents: [WORKER],
		});
		run.service.close(closed.id, undefined);
		run.service.personSent(WORKER);
		run.status(WORKER, "working");
		expect(run.store.require(elsewhere.id).entries).toHaveLength(1);
		expect(run.store.require(closed.id).entries).toHaveLength(1);
		expect(run.direct()).toHaveLength(0);
		expect(run.sent).toEqual([]);
	});

	it("drops the event when the escalation is closed before it goes", async () => {
		const run = settled();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
		});
		run.service.events.pause();
		run.service.personSent(WORKER);
		run.status(WORKER, "working");
		await tick();
		run.service.close(one.id, "直接決まった");
		await run.service.events.resume();
		expect(run.direct()[0]?.fate).toBe("dropped-stale");
		expect(run.sent).toEqual([]);
	});

	it("says one line per escalation, read from the person's first message", async () => {
		const cursor = { value: "e10" };
		const run = settled(cursor);
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER, OTHER],
		});
		run.service.events.pause();
		run.service.personSent(WORKER);
		run.status(WORKER, "working");
		await tick();
		run.status(WORKER, "idle");
		cursor.value = "e20";
		run.service.personSent(WORKER);
		run.status(WORKER, "working");
		await tick();
		run.service.personSent(OTHER);
		run.status(OTHER, "working");
		await tick();
		const lines = run.service.events.heldLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]!.event).toMatchObject({
			type: "escalation.human_direct",
			escalationId: one.id,
			agent: { id: OTHER },
		});
		expect(lines[0]!.also).toEqual([
			expect.objectContaining({
				agent: expect.objectContaining({ id: WORKER }),
				since: "e10",
			}),
		]);
		expect(
			run.service.events
				.recent(50)
				.filter((entry) => entry.fate === "coalesced"),
		).toHaveLength(1);
		await run.service.events.resume();
		expect(run.sent).toHaveLength(1);
		expect(
			run.sent[0]!.split("\n").filter((line) => line.includes("esc=")),
		).toHaveLength(1);
	});
});

describe("escalation hold", () => {
	it("moves it to in_progress and tells nobody; the person has no 対応中にする", () => {
		const run = world();
		const two = run.service.raise({ title: "調査", markdown: "?" });
		run.service.hold(two.id, "B に依頼");
		expect(escalationState(run.service.escalations()[0]!)).toBe("in_progress");
		run.free();
		expect(run.fates().map(([type]) => type)).not.toContain("escalation.held");
		expect("take" in run.service).toBe(false);
	});
});

describe("停滞: 対応中 with no agent working on it (escalation.stalled)", () => {
	const OTHER = "c3d4e5f6-0000-4000-8000-000000000000";
	const GRACE = 60_000;

	/** The orchestrator free, two workers idle, the real grace. */
	function stalledWorld() {
		const clock = { now: 1_000_000 };
		const sent: string[] = [];
		const agents: LiveAgent[] = [ORCH, WORKER, OTHER].map((id) => ({
			id,
			name: id === ORCH ? "orchestrator" : `agent ${id.slice(0, 2)}`,
			workspaceId: "w",
			workspaceLabel: "w",
			status: "idle",
			stopping: false,
		}));
		const service = new OrchestratorService({
			store: EscalationStore.inMemory(),
			agents: () => agents,
			settings: () => ({ ...DEFAULT_ORCHESTRATOR, events: ["*"] }),
			startProblem: () => undefined,
			deliver: (_agent, text) => sent.push(text),
			publish: () => undefined,
			now: () => clock.now,
		});
		service.assign(ORCH);
		service.observe();
		const set = (id: string, change: Partial<LiveAgent>) => {
			const index = agents.findIndex((one) => one.id === id);
			agents[index] = { ...agents[index]!, ...change };
			service.observe();
		};
		const later = (ms: number) => {
			clock.now += ms;
			service.observe();
		};
		/** Raised, answered and read: 対応中, the clock running. */
		const answered = (agents: readonly string[] = [WORKER, OTHER]) => {
			const one = service.raise({
				title: "本番DBマイグレーション承認",
				markdown: "?",
				agents,
			});
			service.answer(one.id, "OK");
			service.acknowledge(one.id, 2);
			return one.id;
		};
		const stalled = () =>
			service.events
				.recent(200)
				.filter((entry) => entry.event.type === "escalation.stalled");
		return { service, sent, clock, set, later, answered, stalled };
	}

	it("is told once the grace is up, with its agents and how long", () => {
		const run = stalledWorld();
		run.answered();
		run.later(GRACE - 1_000);
		expect(run.stalled()).toHaveLength(0);
		run.later(2 * 60_000);
		expect(run.stalled()).toHaveLength(1);
		expect(run.sent.at(-1)).toContain(
			"[escalation.stalled] esc=1「本番DBマイグレーション承認」 agents=a1b2c3d4,c3d4e5f6 idle 3m — 対応中だが動いているエージェントがいない",
		);
	});

	it("says nothing while one of its agents works", () => {
		const run = stalledWorld();
		run.answered();
		run.set(OTHER, { status: "working" });
		run.later(10 * GRACE);
		expect(run.stalled()).toHaveLength(0);
		run.set(OTHER, { status: "background" });
		run.later(10 * GRACE);
		expect(run.stalled()).toHaveLength(0);
	});

	it("does not count a maintenance turn as work", () => {
		const run = stalledWorld();
		run.answered();
		run.later(GRACE / 2);
		run.set(WORKER, { status: "working", maintenance: true });
		run.later(GRACE / 2);
		expect(run.stalled()).toHaveLength(1);
	});

	it("is told once per stretch, and again after an agent worked or a new entry", () => {
		const run = stalledWorld();
		const id = run.answered();
		run.later(GRACE);
		run.later(5 * GRACE);
		expect(run.stalled()).toHaveLength(1);
		run.set(WORKER, { status: "working" });
		run.set(WORKER, { status: "idle" });
		run.later(GRACE / 2);
		expect(run.stalled()).toHaveLength(1);
		run.later(GRACE);
		expect(run.stalled()).toHaveLength(2);
		run.service.ask(id, "もう一つ", []);
		run.service.answer(id, "それも OK");
		run.service.acknowledge(id, 4);
		run.later(GRACE);
		expect(run.stalled()).toHaveLength(3);
	});

	it("says agents=none, and to link one, when it names none", () => {
		const run = stalledWorld();
		run.answered([]);
		run.later(GRACE);
		expect(run.sent.at(-1)).toContain(
			"[escalation.stalled] esc=1「本番DBマイグレーション承認」 agents=none idle 1m — 対応中だが関連エージェントがいない (escalation link で紐づける)",
		);
	});

	it("is dropped before it goes when an agent works again, it is asked again or closed", () => {
		for (const move of ["work", "ask", "close"] as const) {
			const run = stalledWorld();
			const id = run.answered();
			run.service.events.pause();
			run.later(GRACE);
			expect(run.stalled()).toHaveLength(1);
			if (move === "work") run.set(WORKER, { status: "working" });
			if (move === "ask") run.service.ask(id, "もう一つ", []);
			if (move === "close") run.service.close(id, undefined);
			void run.service.events.resume();
			expect(run.stalled()[0]!.fate).toBe("dropped-stale");
		}
	});

	it("waits for an answer the orchestrator has not read: escalation_answered says it", () => {
		const run = stalledWorld();
		const one = run.service.raise({
			title: "承認",
			markdown: "?",
			agents: [WORKER],
		});
		run.service.answer(one.id, "OK");
		run.later(10 * GRACE);
		expect(run.stalled()).toHaveLength(0);
		expect(run.service.wire().inProgress[0]!.stalledSince).toBeUndefined();
		run.service.acknowledge(one.id, 2);
		run.later(GRACE / 2);
		expect(run.stalled()).toHaveLength(0);
		run.later(GRACE / 2);
		expect(run.stalled()).toHaveLength(1);
	});

	it("marks the card on the board", () => {
		const run = stalledWorld();
		run.answered();
		expect(run.service.wire().inProgress[0]!.stalledSince).toBeUndefined();
		run.later(GRACE);
		expect(run.service.wire().inProgress[0]!.stalledSince).toBe(1_000_000);
		run.set(WORKER, { status: "working" });
		expect(run.service.wire().inProgress[0]!.stalledSince).toBeUndefined();
	});
});

describe("待機中 (escalation wait)", () => {
	const HOUR = 3_600_000;

	function waitWorld() {
		const clock = { now: 1_000_000 };
		const sent: string[] = [];
		const agents: LiveAgent[] = [ORCH, WORKER].map((id) => ({
			id,
			name: id === ORCH ? "orchestrator" : "API fix",
			workspaceId: "w",
			workspaceLabel: "w",
			status: "idle",
			stopping: false,
		}));
		const service = new OrchestratorService({
			store: EscalationStore.inMemory(),
			agents: () => agents,
			settings: () => ({ ...DEFAULT_ORCHESTRATOR, events: ["*"] }),
			startProblem: () => undefined,
			deliver: (_agent, text) => sent.push(text),
			publish: () => undefined,
			now: () => clock.now,
		});
		service.assign(ORCH);
		service.observe();
		const later = (ms: number) => {
			clock.now += ms;
			service.observe();
		};
		const set = (change: Partial<LiveAgent>) => {
			agents[1] = { ...agents[1]!, ...change };
			service.observe();
		};
		const of = (type: string) =>
			service.events.recent(200).filter((entry) => entry.event.type === type);
		return { service, sent, clock, later, set, of };
	}

	it("tells wait_due once when --at passes, and drops it once it left 待機中", () => {
		const run = waitWorld();
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
			"[escalation.wait_due] esc=1「再開」 — 待機条件の時刻になりました: 11/10 以降に再開",
		);
		// Waiting anew on a time already past: once more; then resumed while held.
		const two = run.service.raise({ title: "後で", markdown: "?" });
		run.service.events.pause();
		run.service.wait(two.id, { trigger: "x", dueAt: run.clock.now - 1 });
		expect(run.of("escalation.wait_due")).toHaveLength(2);
		run.service.resume(two.id, undefined);
		void run.service.events.resume();
		expect(run.of("escalation.wait_due")[1]!.fate).toBe("dropped-stale");
	});

	it("reminds of every 待機中 one in one line, and of nothing when none waits", () => {
		const run = waitWorld();
		run.service.remindWaiting();
		expect(run.of("escalation.waiting_reminder")).toHaveLength(0);
		const one = run.service.raise({ title: "返事待ち", markdown: "?" });
		run.service.wait(one.id, { trigger: "Bob から Slack で返事が来たら" });
		const two = run.service.raise({
			title: "日付",
			markdown: "?",
			wait: { trigger: "11/10 以降", dueAt: run.clock.now + 3 * 86_400_000 },
		});
		run.service.remindWaiting();
		expect(run.sent.at(-1)).toContain(
			`[escalation.waiting_reminder] 待機中 2 件 — esc=${String(two.id)}「日付」: 11/10 以降 (あと 3日) / esc=1「返事待ち」: Bob から Slack で返事が来たら`,
		);
		// Said again an hour later: a reminder is never a repeat.
		run.service.remindWaiting();
		expect(
			run.of("escalation.waiting_reminder").map((entry) => entry.fate),
		).toEqual(["delivered", "delivered"]);
	});

	it("holds reminders while paused, coalesced to the latest", async () => {
		const run = waitWorld();
		const one = run.service.raise({ title: "t", markdown: "?" });
		run.service.wait(one.id, { trigger: "a" });
		run.service.events.pause();
		run.service.remindWaiting();
		run.service.wait(one.id, { trigger: "b" });
		run.service.remindWaiting();
		expect(run.service.events.heldLines()).toHaveLength(1);
		const before = run.sent.length;
		await run.service.events.resume();
		expect(run.sent).toHaveLength(before + 1);
		expect(run.sent.at(-1)).toContain("esc=1「t」: b");
		expect(run.sent.at(-1)).not.toContain(": a");
		expect(run.of("escalation.waiting_reminder")[0]!.fate).toBe("coalesced");
	});

	it("leaves 待機中 when an agent of it goes working, but not on a maintenance turn", () => {
		const run = waitWorld();
		const one = run.service.raise({
			title: "t",
			markdown: "?",
			agents: [WORKER],
			wait: { trigger: "x" },
		});
		run.set({ status: "working", maintenance: true });
		expect(escalationState(run.service.escalations()[0]!)).toBe("waiting");
		run.set({ status: "idle", maintenance: false });
		run.set({ status: "working" });
		expect(escalationState(run.service.escalations()[0]!)).toBe("in_progress");
		expect(run.service.escalations()[0]!.entries.at(-1)).toMatchObject({
			kind: "resumed",
			agent: WORKER,
		});
		expect(one.id).toBe(1);
	});

	it("lays the board's 待機中 lane out, and never calls one stalled", () => {
		const run = waitWorld();
		const one = run.service.raise({ title: "a", markdown: "?" });
		run.service.answer(one.id, "OK");
		run.service.acknowledge(one.id, 2);
		run.service.wait(one.id, { trigger: "x" });
		run.later(10 * 60_000);
		expect(run.of("escalation.stalled")).toHaveLength(0);
		expect(run.service.wire().waiting.map((e) => e.id)).toEqual([1]);
		expect(run.service.wire().inProgress).toEqual([]);
		expect(run.service.wire().waiting[0]!.entries.at(-1)).toMatchObject({
			kind: "wait",
			markdown: "x",
		});
	});
});
