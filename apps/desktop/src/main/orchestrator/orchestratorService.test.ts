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
	it("drops an unaccounted agent that is working again", () => {
		const run = world();
		run.clock.now += 1_000;
		run.service.observe();
		expect(run.service.events.held()).toEqual([
			expect.objectContaining({ type: "init" }),
			expect.objectContaining({ type: "unaccounted" }),
		]);
		(run.worker as { status: string }).status = "working";
		run.free();
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).not.toContain("[unaccounted]");
		expect(run.fates()).toContainEqual(["unaccounted", "dropped-stale"]);
	});

	it("drops an unaccounted agent an escalation now names", () => {
		const run = world();
		run.clock.now += 1_000;
		run.service.observe();
		run.service.raise({ title: "t", markdown: "m", agents: [WORKER] });
		run.free();
		expect(run.sent[0]).not.toContain("[unaccounted]");
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

	it("keeps an idle agent's stretch of idleness through a compaction: 不明 is not re-armed", () => {
		const run = settled();
		run.service.setGrace(0);
		run.status(WORKER, "idle");
		const told = () =>
			run.service.events
				.recent(50)
				.filter(
					(one) =>
						one.event.type === "unaccounted" && one.event.agent.id === WORKER,
				);
		expect(told()).toHaveLength(1);
		const since = run.service
			.unaccounted()
			.find((one) => one.agentId === WORKER)?.idleSince;
		run.status(WORKER, "working", true);
		expect(
			run.service.unaccounted().find((one) => one.agentId === WORKER)
				?.idleSince,
		).toBe(since);
		run.status(WORKER, "idle");
		expect(told()).toHaveLength(1);
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

describe("対応中にする", () => {
	it("moves it to in_progress and tells the orchestrator, with the note", () => {
		const run = world();
		const one = run.service.raise({ title: "承認", markdown: "?" });
		run.service.take(one.id, "自分で確認する");
		expect(escalationState(run.service.escalations()[0]!)).toBe("in_progress");
		run.free();
		expect(run.sent[0]).toContain(
			"[escalation.taken] esc=1「承認」 — 人が対応中にしました: 自分で確認する",
		);
	});

	it("is dropped when closed before it goes; hold tells nobody", () => {
		const run = world();
		const one = run.service.raise({ title: "承認", markdown: "?" });
		run.service.take(one.id, "");
		run.service.close(one.id, undefined);
		const two = run.service.raise({ title: "調査", markdown: "?" });
		run.service.hold(two.id, "B に依頼");
		run.free();
		expect(run.fates()).toContainEqual(["escalation.taken", "dropped-stale"]);
		expect(run.sent.join("\n")).not.toContain("[escalation.taken]");
		expect(run.fates().map(([type]) => type)).not.toContain("escalation.held");
	});
});
