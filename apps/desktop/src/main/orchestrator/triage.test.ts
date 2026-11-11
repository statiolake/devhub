/**
 * Priority triage (`triage.ts`): the schedule, saving's priority gate in the
 * dispatcher, the store, and the person's requests (`requests.ts`).
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { EscalationStore } from "./escalationStore.js";
import {
	EventDispatcher,
	subjectOf,
	type OrchestratorEvent,
} from "./events.js";
import { OrchestratorService } from "./orchestratorService.js";
import { RequestBook } from "./requests.js";
import {
	PriorityBook,
	SAVING_TRIAGE_INTERVAL_MS,
	TRIAGE_INTERVAL_MS,
	nextTriageAt,
	parseSubject,
	type Priority,
} from "./triage.js";

const MINUTE = 60_000;

function needsAction(n: number): OrchestratorEvent {
	return {
		type: "needs_action",
		subject: {
			kind: "issue",
			item: { repo: "acme/app", number: n, url: `https://x/${String(n)}` },
		},
		breach: { clause: "no_agent" },
	};
}

/** A dispatcher in `mode`, the invariant standing with issues 1 and 2. */
function dispatcher(
	mode: "full" | "saving",
	priorities: Record<string, Priority>,
	more: {
		readonly standing?: readonly OrchestratorEvent[];
		readonly tasks?: number;
	} = {},
) {
	const sent: string[] = [];
	const events = new EventDispatcher({
		mode,
		orchestrator: () => "orch",
		settings: () => ({
			event_prompt: "{EVENT}",
			init_prompt: undefined,
			events: ["*"],
			delivery_interval: "5m",
		}),
		deliver: (_agent, text) => sent.push(text),
		standing: () => [needsAction(1), needsAction(2), ...(more.standing ?? [])],
		high: (subject) => priorities[subject] === "high",
		inProgress: () => more.tasks ?? 0,
		now: () => 0,
	});
	return { events, sent };
}

describe("saving's priority gate", () => {
	it("sends only the lines about subjects ranked high", () => {
		const run = dispatcher("saving", { "item acme/app#2": "high" });
		run.events.flush();
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain("acme/app#2");
		expect(run.sent[0]).not.toContain("acme/app#1");
	});

	it("holds a pending line about a subject not ranked high, one per subject, until a triage takes everything", () => {
		const run = dispatcher("saving", {});
		run.events.dispatch({
			type: "timer.elapsed",
			name: "sweep",
			interval: "30m",
		});
		expect(run.sent).toHaveLength(0);
		expect(run.events.held()).toHaveLength(1);
		run.events.dispatch({ type: "triage" });
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain("[triage]");
		expect(run.sent[0]).toContain("[timer.elapsed] sweep");
		expect(run.sent[0]).toContain("acme/app#1");
		expect(run.sent[0]).toContain("acme/app#2");
		expect(run.events.held()).toHaveLength(0);
	});

	it("is no gate in full: everything goes whatever its priority", () => {
		const run = dispatcher("full", {});
		run.events.flush();
		expect(run.sent[0]).toContain("acme/app#1");
		expect(run.sent[0]).toContain("acme/app#2");
	});

	it("never holds the person's words, nor a request", () => {
		const run = dispatcher("saving", {});
		run.events.dispatch({
			type: "request",
			requestId: 3,
			text: "CSV を直して",
		});
		expect(run.sent).toEqual([
			expect.stringMatching(/^req=3 人からの依頼 .*\nCSV を直して$/su),
		]);
	});

	it("lets the held lines go when full comes back", () => {
		const run = dispatcher("saving", {});
		run.events.flush();
		expect(run.sent).toHaveLength(0);
		run.events.setMode("full");
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain("acme/app#1");
	});

	it("lets a state change through whatever its priority: an agent that stopped, with 2 in progress", () => {
		const run = dispatcher(
			"saving",
			{ "agent ab12cd34": "low" },
			{
				tasks: 2,
				standing: [
					{
						type: "needs_action",
						subject: { kind: "agent", agent: { id: "ab12cd34" } },
						breach: { clause: "idle_no_escalation" },
					},
				],
			},
		);
		run.events.flush();
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain("agent=ab12cd34");
		// The unstarted items are nudges, not high: they wait.
		expect(run.sent[0]).not.toContain("acme/app#");
	});

	it("holds a nudge about an unstarted low item until the triage", () => {
		const run = dispatcher("saving", { "item acme/app#1": "low" });
		run.events.flush();
		expect(run.sent).toHaveLength(0);
		expect(run.events.preview().when).toEqual({
			kind: "saving_held",
			lines: 2,
		});
		run.events.dispatch({ type: "triage" });
		expect(run.sent[0]).toContain("acme/app#1");
	});

	it("shows in the preview only what would go", () => {
		const run = dispatcher("saving", { "item acme/app#1": "high" });
		const preview = run.events.preview();
		expect(preview.events.map(subjectOf)).toEqual(["item acme/app#1"]);
	});
});

describe("the triage schedule", () => {
	it("is every 30 minutes in full, every hour in saving, never while off", () => {
		expect(TRIAGE_INTERVAL_MS).toBe(30 * MINUTE);
		expect(SAVING_TRIAGE_INTERVAL_MS).toBe(60 * MINUTE);
		expect(nextTriageAt("full", 1000)).toBe(1000 + 30 * MINUTE);
		expect(nextTriageAt("saving", 1000)).toBe(1000 + 60 * MINUTE);
		expect(nextTriageAt("off", 1000)).toBeUndefined();
		expect(nextTriageAt("full", undefined)).toBeUndefined();
	});

	function service(mode: "full" | "saving" | "off" = "full") {
		const clock = { now: 1_000_000 };
		const sent: string[] = [];
		const run = new OrchestratorService({
			store: EscalationStore.inMemory(),
			agents: () => [
				{
					id: "orch",
					name: "orchestrator",
					workspaceId: "w",
					workspaceLabel: "w",
					status: "idle",
					stopping: false,
				},
			],
			settings: () => ({ ...DEFAULT_ORCHESTRATOR, event_prompt: "{EVENT}" }),
			startProblem: () => undefined,
			deliver: (_agent, text) => sent.push(text),
			publish: () => undefined,
			now: () => clock.now,
			mode,
		});
		run.assign("orch");
		run.observe();
		sent.length = 0;
		const later = (ms: number) => {
			clock.now += ms;
			run.observe();
		};
		const triages = () => sent.filter((text) => text.includes("[triage]"));
		return { run, sent, clock, later, triages };
	}

	it("asks for a triage 30 minutes after the start in full, and again 30 after that", () => {
		const { run, later, triages, clock } = service("full");
		expect(run.nextTriageAt).toBe(clock.now + 30 * MINUTE);
		later(30 * MINUTE - 1);
		expect(triages()).toHaveLength(0);
		later(1);
		expect(triages()).toHaveLength(1);
		expect(run.triagedAt).toBe(clock.now);
		later(30 * MINUTE);
		expect(triages()).toHaveLength(2);
	});

	it("waits an hour in saving", () => {
		const { later, triages } = service("saving");
		later(45 * MINUTE);
		expect(triages()).toHaveLength(0);
		later(15 * MINUTE);
		expect(triages()).toHaveLength(1);
	});

	it("asks for none while off, and counts from when it is turned on", () => {
		const { run, later, triages } = service("off");
		expect(run.nextTriageAt).toBeUndefined();
		later(3 * 60 * MINUTE);
		expect(triages()).toHaveLength(0);
		run.setMode("full");
		later(29 * MINUTE);
		expect(triages()).toHaveLength(0);
		later(MINUTE);
		expect(triages()).toHaveLength(1);
	});

	it("keeps priorities, an escalation's as its rank, and shows them on the board", () => {
		const { run } = service("full");
		const esc = run.raise({
			title: "本番DBマイグレーション承認",
			markdown: "?",
			agents: [],
			links: [],
			options: [],
		} as unknown as Parameters<typeof run.raise>[0]);
		expect(run.setPriority({ kind: "esc", id: esc.id }, "high")).toBe(
			`esc ${String(esc.id)}`,
		);
		expect(run.priorityOf(`esc ${String(esc.id)}`)).toBe("high");
		run.setPriority({ kind: "agent", id: "orch" }, "low", "様子見");
		expect(run.priorityOf("agent orch")).toBe("low");
		expect(run.wire().agentPriorities).toEqual({ orch: "low" });
		expect(run.clearPriority({ kind: "agent", id: "orch" })).toBe(true);
		expect(run.priorityOf("agent orch")).toBeUndefined();
		expect(() => run.setPriority({ kind: "req", id: 9 }, "high")).toThrow(
			/no request #9/u,
		);
	});
});

describe("the person's requests", () => {
	function service(mode: "full" | "off") {
		const sent: string[] = [];
		const run = new OrchestratorService({
			store: EscalationStore.inMemory(),
			agents: () => [
				{
					id: "orch",
					name: "orchestrator",
					workspaceId: "w",
					workspaceLabel: "w",
					status: "idle",
					stopping: false,
				},
			],
			settings: () => ({ ...DEFAULT_ORCHESTRATOR, event_prompt: "{EVENT}" }),
			startProblem: () => undefined,
			deliver: (_agent, text) => sent.push(text),
			publish: () => undefined,
			now: () => 5_000,
			mode,
		});
		run.assign("orch");
		sent.length = 0;
		return { run, sent };
	}

	it("is on the board at once, and goes as the person's own message", () => {
		const { run, sent } = service("full");
		const made = run.request("請求書 CSV の文字化けを直す");
		expect(sent).toEqual([
			`req=${String(made.id)} 人からの依頼 (タスクとして登録し、devhub --tell orchestrator request done ${String(made.id)} --note "<登録先>" で受付済みにしてください):\n請求書 CSV の文字化けを直す`,
		]);
		expect(run.wire().requests).toEqual([
			{
				id: made.id,
				text: "請求書 CSV の文字化けを直す",
				at: 5_000,
				state: "sent",
			},
		]);
	});

	it("waits as 送信待ち while off, and goes when turned on", () => {
		const { run, sent } = service("off");
		run.request("ログを調べる");
		expect(sent).toHaveLength(0);
		expect(run.wire().requests?.[0]?.state).toBe("held");
		run.setMode("full");
		expect(sent.some((text) => text.includes("ログを調べる"))).toBe(true);
		expect(run.wire().requests?.[0]?.state).toBe("sent");
	});

	it("sent with no orchestrator running, waits for one, and goes once it starts", () => {
		const sent: string[] = [];
		let assigned = false;
		const run = new OrchestratorService({
			store: EscalationStore.inMemory(),
			agents: () =>
				assigned
					? [
							{
								id: "orch",
								name: "orchestrator",
								workspaceId: "w",
								workspaceLabel: "w",
								status: "idle",
								stopping: false,
							},
						]
					: [],
			settings: () => ({ ...DEFAULT_ORCHESTRATOR, event_prompt: "{EVENT}" }),
			startProblem: () => undefined,
			deliver: (_agent, text) => sent.push(text),
			publish: () => undefined,
			now: () => 5_000,
			mode: "full",
		});
		run.request("まだ誰もいない");
		expect(sent).toHaveLength(0);
		expect(run.wire().requests?.[0]?.state).toBe("held");
		assigned = true;
		run.assign("orch");
		expect(sent.filter((text) => text.includes("まだ誰もいない"))).toHaveLength(
			1,
		);
		expect(run.wire().requests?.[0]?.state).toBe("sent");
		// Seen again on the next projection: not sent twice.
		run.observe();
		expect(sent.filter((text) => text.includes("まだ誰もいない"))).toHaveLength(
			1,
		);
	});

	it("is filed by the orchestrator, with where", () => {
		const { run } = service("full");
		const made = run.request("A");
		run.fileRequest(made.id, "https://github.com/acme/app/issues/40");
		expect(run.wire().requests).toEqual([
			expect.objectContaining({
				id: made.id,
				state: "filed",
				filed: { at: 5_000, note: "https://github.com/acme/app/issues/40" },
			}),
		]);
		expect(() => run.fileRequest(99, undefined)).toThrow(/no request #99/u);
	});

	it("numbers requests on from the highest kept", () => {
		const book = new RequestBook({
			load: () => [{ id: 7, text: "x", at: 1, state: "filed" }],
			save: () => undefined,
		});
		expect(book.add("y", 2).id).toBe(8);
	});
});

describe("the store", () => {
	it("keeps the newest, and says each change to its storage", () => {
		const saved: number[] = [];
		const book = new PriorityBook({
			load: () => new Map([["agent a", { priority: "low", at: 1 }]]),
			save: (entries) => saved.push(entries.size),
		});
		expect(book.get("agent a")?.priority).toBe("low");
		book.set("item acme/app#1", { priority: "high", at: 2 });
		expect(saved).toEqual([2]);
		expect(book.clear("agent a")).toBe(true);
		expect(book.clear("agent a")).toBe(false);
		expect(saved).toEqual([2, 1]);
	});

	it("reads a subject as the event lines name it", () => {
		expect(parseSubject("esc=12")).toEqual({ kind: "esc", id: 12 });
		expect(parseSubject("issue=acme/app#3")).toEqual({
			kind: "item",
			ref: "acme/app#3",
		});
		expect(parseSubject("pr=acme/app#9")).toEqual({
			kind: "item",
			ref: "acme/app#9",
		});
		expect(parseSubject("agent=ab12cd34")).toEqual({
			kind: "agent",
			id: "ab12cd34",
		});
		expect(parseSubject("req=2")).toEqual({ kind: "req", id: 2 });
		expect(parseSubject("issue=12")).toBeUndefined();
		expect(parseSubject("nope")).toBeUndefined();
	});
});
