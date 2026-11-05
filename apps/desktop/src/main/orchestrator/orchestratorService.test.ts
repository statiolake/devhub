import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { EscalationStore } from "./escalationStore.js";
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
