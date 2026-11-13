/**
 * Triage (`triage.ts`): the schedule, saving's priority gate in the
 * dispatcher, the open tasks the triage lists (stale ones with why), the
 * tasks' priorities, and the person's requests (the board's +, which make
 * tasks).
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { TaskStore } from "./taskStore.js";
import {
	EventDispatcher,
	subjectOf,
	type OrchestratorEvent,
} from "./events.js";
import { OrchestratorService } from "./orchestratorService.js";
import {
	SAVING_TRIAGE_INTERVAL_MS,
	TRIAGE_INTERVAL_MS,
	nextTriageAt,
} from "./triage.js";

type Priority = "high" | "normal" | "low";

const MINUTE = 60_000;

function needsAction(n: number): OrchestratorEvent {
	return {
		type: "needs_action",
		subject: {
			kind: "issue",
			item: { repo: "acme/app", number: n, url: `https://x/${String(n)}` },
		},
		breach: { clause: "no_task" },
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
		run.events.dispatch({ type: "custom.sweep", text: "掃除" });
		expect(run.sent).toHaveLength(0);
		expect(run.events.held()).toHaveLength(1);
		run.events.dispatch({ type: "triage" });
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain("[triage]");
		expect(run.sent[0]).toContain("[custom.sweep] — 掃除");
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
			task: { id: 3, title: "CSV を直して" },
			text: "CSV を直して",
		});
		expect(run.sent).toEqual([
			expect.stringMatching(
				/^task=3「CSV を直して」 人からの依頼 .*\nCSV を直して$/su,
			),
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
			{ "task 5": "low" },
			{
				tasks: 2,
				standing: [
					{
						type: "needs_action",
						subject: { kind: "task", task: { id: 5, title: "修正" } },
						breach: { clause: "idle" },
					},
				],
			},
		);
		run.events.flush();
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain("task=5");
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
			store: TaskStore.inMemory(),
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

	it("lists the open tasks for the re-check, the maybe-stale ones with why, and says which must be resolved now", () => {
		const PR = "https://github.com/acme/pay/pull/12";
		const items = [
			{
				item: { repo: "acme/pay", number: 12, url: PR },
				kind: "pr" as const,
				state: "merged" as const,
				assignedToMe: true,
				projects: [],
			},
		];
		const clock = { now: 1_000_000 };
		const sent: string[] = [];
		const run = new OrchestratorService({
			store: TaskStore.inMemory(),
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
			invariant: () => ({ items, agents: [] }),
			settings: () => ({ ...DEFAULT_ORCHESTRATOR, event_prompt: "{EVENT}" }),
			startProblem: () => undefined,
			deliver: (_agent, text) => sent.push(text),
			publish: () => undefined,
			now: () => clock.now,
			mode: "full",
		});
		run.assign("orch");
		const old = run.newTask({ title: "決済のタイムアウト", links: [PR] });
		run.newTask({ title: "別件", status: "in_progress", priority: "high" });
		run.newTask({ title: "終わった仕事" });
		run.completeTask(3, undefined);
		const later = (ms: number) => {
			clock.now += ms;
			run.observe();
		};
		const triages = () => sent.filter((text) => text.includes("[triage]"));
		later(30 * MINUTE);
		expect(triages()).toHaveLength(1);
		const lines = triages()[0]!.split("\n");
		expect(lines[0]).toContain("task edit <ID> --priority");
		expect(lines.slice(1, 3)).toEqual([
			`  task=${String(old.id)}「決済のタイムアウト」 待機 — 古いかも: PR acme/pay#12 はマージ済み`,
			"  task=2「別件」 処理中 優先度=high",
		]);
		// The triage takes the standing lines with it: the 処理中 task nobody moves.
		expect(lines.slice(3)).toEqual([
			"[needs_action] task=2「別件」 — no_agent",
		]);
		// The board and the CLI carry the mark too.
		expect(
			run.wire().waiting.find((one) => one.id === old.id)?.mayBeStale?.reasons,
		).toEqual(["PR acme/pay#12 はマージ済み"]);
		// Still marked at the next triage: it was already when the last went.
		later(30 * MINUTE);
		expect(triages()[1]!.split("\n")[1]).toContain(
			"(前回の triage から: この triage で解決する)",
		);
		// Resolved: done, it is off the list and the mark goes.
		run.completeTask(old.id, "マージ済みで完了");
		later(30 * MINUTE);
		expect(triages()[2]).not.toContain(`task=${String(old.id)}「`);
	});

	it("keeps priorities on the tasks, and a high task's nudge goes in saving", () => {
		const { run } = service("full");
		const task = run.newTask({ title: "本番障害" });
		expect(run.taskWire(task).priority).toBe("normal");
		run.editTask(task.id, { priority: "high", priorityNote: "本番" });
		expect(run.taskWire(run.task(task.id)!)).toMatchObject({
			priority: "high",
			priorityNote: "本番",
		});
		run.editTask(task.id, { priority: "normal", priorityNote: "" });
		expect(run.taskWire(run.task(task.id)!).priority).toBe("normal");
		expect(run.taskWire(run.task(task.id)!).priorityNote).toBeUndefined();
	});
});

describe("the person's requests", () => {
	function service(mode: "full" | "off") {
		const sent: string[] = [];
		const run = new OrchestratorService({
			store: TaskStore.inMemory(),
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

	it("is a 待機 task on the board at once, and goes as the person's own message", () => {
		const { run, sent } = service("full");
		const made = run.request(
			"請求書 CSV の文字化けを直す\n\n取引先から報告あり",
		);
		expect(sent).toEqual([
			`task=${String(made.id)}「請求書 CSV の文字化けを直す」 人からの依頼 (この依頼からタスクを作りました。devhub --tell task edit ${String(made.id)} で題名を整え、task link / エージェントの割り当てで進めてください):\n請求書 CSV の文字化けを直す\n\n取引先から報告あり`,
		]);
		expect(run.wire().waiting).toEqual([
			expect.objectContaining({
				id: made.id,
				title: "請求書 CSV の文字化けを直す",
				status: "waiting",
				request: {
					text: "請求書 CSV の文字化けを直す\n\n取引先から報告あり",
					at: 5_000,
					sentAt: 5_000,
				},
			}),
		]);
	});

	it("goes at once while off too: the person asked", () => {
		const { run, sent } = service("off");
		run.request("ログを調べる");
		expect(sent.some((text) => text.includes("ログを調べる"))).toBe(true);
		expect(run.wire().waiting[0]?.request?.sentAt).toBe(5_000);
	});

	it("sent with no orchestrator running, waits for one, and goes once it starts", () => {
		const sent: string[] = [];
		let assigned = false;
		const run = new OrchestratorService({
			store: TaskStore.inMemory(),
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
		assigned = true;
		run.assign("orch");
		expect(sent.filter((text) => text.includes("まだ誰もいない"))).toHaveLength(
			1,
		);
		// Seen again on the next projection: not sent twice.
		run.observe();
		expect(sent.filter((text) => text.includes("まだ誰もいない"))).toHaveLength(
			1,
		);
	});
});
