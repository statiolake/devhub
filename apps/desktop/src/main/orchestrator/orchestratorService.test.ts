import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { TaskStore } from "./taskStore.js";
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
	const read: [string, number][] = [];
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
	const store = TaskStore.inMemory();
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
		acknowledged: (agentId, id) => read.push([agentId, id]),
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

const BODY =
	"## 決めてほしいこと\nどうするか\n\n## 人に聞く理由\n本番の挙動が変わり、取り消せない";

describe("a task", () => {
	it("is born 待機, goes 処理中 when a bound agent works, and stays so when it stops: then it needs action", () => {
		const run = world({ managed: true });
		const task = run.service.newTask({ title: "ログイン修正" });
		expect(run.service.statusOf(task)).toBe("waiting");
		run.service.bindTask(task.id, [WORKER]);
		run.status(WORKER, "working");
		expect(run.service.statusOf(run.service.task(task.id)!)).toBe(
			"in_progress",
		);
		expect(run.service.wire().inProgress.map((one) => one.id)).toEqual([
			task.id,
		]);
		run.status(WORKER, "idle");
		expect(run.service.taskWire(run.service.task(task.id)!).needsAction).toBe(
			"idle",
		);
		// Past the pickup wait for the init the orchestrator was sent.
		run.later(61_000);
		expect(run.sent.join("\n")).toContain(
			"[needs_action] task=1「ログイン修正」 ws=w — idle",
		);
	});

	it("is 回答待ち exactly while a question on it is open; the answer makes it 処理中", () => {
		const run = world();
		const task = run.service.newTask({ title: "移行" });
		run.service.setTaskStatus(task.id, "waiting", { note: "待つ" });
		const one = run.service.raise({
			taskId: task.id,
			title: "本番DB",
			markdown: BODY,
			options: ["承認する", "見送る"],
		});
		expect(run.service.statusOf(run.service.task(task.id)!)).toBe("answer");
		expect(run.service.wire().answer.map((t) => t.id)).toEqual([task.id]);
		run.service.answer(one.id, "承認する");
		const now = run.service.task(task.id)!;
		expect(run.service.statusOf(now)).toBe("in_progress");
		expect(now.waitNote).toBeUndefined();
		expect(run.service.escalation(one.id)?.answer).toMatchObject({
			markdown: "承認する",
			option: "承認する",
		});
		// A follow-up is a new escalation, never the old one again.
		expect(() => run.service.answer(one.id, "もう一度")).toThrow(/follow-up/u);
		const two = run.service.raise({
			taskId: task.id,
			title: "追加",
			markdown: BODY,
		});
		expect(two.id).toBe(one.id + 1);
		expect(run.service.statusOf(run.service.task(task.id)!)).toBe("answer");
		run.service.withdraw(two.id, "不要になった");
		expect(run.service.statusOf(run.service.task(task.id)!)).toBe(
			"in_progress",
		);
	});

	it("never moves on a question by time: a 待機 task's --check-at only wakes the orchestrator", () => {
		const run = world();
		const task = run.service.newTask({ title: "移行" });
		const one = run.service.raise({
			taskId: task.id,
			title: "q",
			markdown: BODY,
		});
		run.later(30 * 24 * 3_600_000);
		expect(run.service.escalation(one.id)?.answer).toBeUndefined();
		expect(run.service.statusOf(run.service.task(task.id)!)).toBe("answer");
	});

	it("done withdraws a question still open on it, and leaves the board's open lanes", () => {
		const run = world();
		const task = run.service.newTask({ title: "移行" });
		const one = run.service.raise({
			taskId: task.id,
			title: "q",
			markdown: BODY,
		});
		run.service.completeTask(task.id, "やめた");
		expect(run.service.escalation(one.id)?.withdrawn?.note).toBe(
			"タスク完了で取り下げ",
		);
		expect(run.service.wire().done.map((t) => t.id)).toEqual([task.id]);
		expect(() =>
			run.service.raise({ taskId: task.id, title: "q", markdown: BODY }),
		).toThrow(/is done/u);
	});

	it("binds an agent to one open task at a time; resume finds the task's latest", () => {
		const run = world();
		const a = run.service.newTask({ title: "A" });
		const b = run.service.newTask({ title: "B" });
		run.service.bindTask(a.id, [WORKER]);
		run.service.bindTask(b.id, [WORKER]);
		expect(run.service.task(a.id)!.agents).toEqual([]);
		expect(run.service.taskOfAgent(WORKER)?.id).toBe(b.id);
		expect(run.service.resumeTarget(`task=${String(b.id)}`)).toMatchObject({
			task: { id: b.id },
			agent: { agentId: WORKER },
			live: WORKER,
		});
		expect(() => run.service.resumeTarget(`task=${String(a.id)}`)).toThrow(
			/no agent has worked on task/u,
		);
		// A session id names no task's agent: the caller resumes it as a session.
		expect(run.service.resumeTarget("ses-1234")).toBeUndefined();
	});

	it("keeps a stopped agent's sessions, and takes a resumed one in its place", () => {
		const run = world();
		const task = run.service.newTask({ title: "A" });
		run.service.bindTask(task.id, [WORKER]);
		const live = {
			agentId: WORKER,
			name: "fix",
			named: true,
			profileId: "claude",
			kind: "claude",
			presentation: "gui" as const,
			machine: "local",
			folder: "/w",
			session: "s1",
		};
		run.service.observeWork([live]);
		run.service.observeWork([]);
		const stopped = run.service.task(task.id)!.agents[0]!;
		expect(stopped).toMatchObject({ sessions: ["s1"], folder: "/w" });
		expect(stopped.stoppedAt).toBeDefined();
		run.service.observeWork([{ ...live, agentId: "new-id", session: "s1" }]);
		expect(run.service.task(task.id)!.agents.map((one) => one.agentId)).toEqual(
			["new-id"],
		);
	});
});

describe("the person's words", () => {
	it("an answer goes at once as their own words, not in the template, and counts as read", () => {
		const run = world({ prompt: "TEMPLATE {EVENT}" });
		const task = run.service.newTask({ title: "移行" });
		const one = run.service.raise({
			taskId: task.id,
			title: "本番DB",
			markdown: BODY,
		});
		run.service.answer(one.id, "月曜に");
		expect(run.sent).toEqual([
			"task=1「移行」 esc=1「本番DB」 への人の回答:\n月曜に",
		]);
		expect(run.read).toEqual([[ORCH, one.id]]);
	});

	it("an answer goes while off, as in full", () => {
		const run = world();
		run.service.setMode("off");
		const task = run.service.newTask({ title: "移行" });
		const one = run.service.raise({
			taskId: task.id,
			title: "q",
			markdown: BODY,
		});
		run.service.answer(one.id, "はい");
		expect(run.sent).toEqual(["task=1「移行」 esc=1「q」 への人の回答:\nはい"]);
	});

	it("to an agent of a task with an open question, from its own composer, are told; the question stays open", async () => {
		const run = world({
			cursor: { value: "e39", text: "やっぱり staging だけで" },
		});
		const task = run.service.newTask({ title: "移行" });
		run.service.bindTask(task.id, [WORKER]);
		const one = run.service.raise({
			taskId: task.id,
			title: "q",
			markdown: BODY,
		});
		run.service.personSent(WORKER);
		run.status(WORKER, "working");
		await tick();
		expect(run.sent).toEqual([
			"task=1「移行」 agent=a1b2c3d4 に人が直接送ったメッセージ:\nやっぱり staging だけで",
		]);
		expect(run.service.escalation(one.id)?.answer).toBeUndefined();
		expect(run.service.statusOf(run.service.task(task.id)!)).toBe("answer");
	});

	it("are not told for a maintenance turn, or for an agent the orchestrator set going", async () => {
		const run = world();
		const task = run.service.newTask({ title: "移行" });
		run.service.bindTask(task.id, [WORKER]);
		run.service.raise({ taskId: task.id, title: "q", markdown: BODY });
		run.service.personSent(WORKER);
		run.status(WORKER, "working", true);
		run.status(WORKER, "idle");
		run.status(WORKER, "working");
		await tick();
		expect(run.of("task.human_direct")).toEqual([]);
	});
});

describe("待機 with a time to look again", () => {
	it("says task.changed due once when --check-at passes", () => {
		const run = world();
		const task = run.service.newTask({ title: "移行" });
		run.service.setTaskStatus(task.id, "waiting", {
			note: "15:00 に",
			checkAt: run.clock.now + 60_000,
		});
		run.later(59_000);
		expect(run.of("task.changed")).toEqual([]);
		run.later(2_000);
		run.later(60_000);
		expect(run.of("task.changed").map((entry) => entry.fate)).toEqual([
			"delivered",
		]);
		expect(run.sent.join("\n")).toContain("[task.changed] task=1 — due");
	});

	it("is left for 処理中 when a bound agent goes working, not on a maintenance turn", () => {
		const run = world();
		const task = run.service.newTask({ title: "移行" });
		run.service.bindTask(task.id, [WORKER]);
		run.status(WORKER, "working", true);
		expect(run.service.task(task.id)!.status).toBe("waiting");
		run.status(WORKER, "idle");
		run.status(WORKER, "working");
		expect(run.service.task(task.id)!.status).toBe("in_progress");
	});
});

describe("the invariant", () => {
	it("asks for a task for an item of mine no task links, and is settled by one", () => {
		const run = world({ items: [issue()] });
		run.later(61_000);
		expect(run.sent.join("\n")).toContain(
			"[needs_action] issue=acme/app#123 — no_task",
		);
		run.sent.length = 0;
		const task = run.service.newTask({ title: "API整理", links: [ISSUE_URL] });
		run.service.setTaskStatus(task.id, "waiting", { note: "後で" });
		run.later(61_000);
		expect(run.sent.join("\n")).not.toContain("acme/app#123");
	});

	it("asks for a task for a managed agent on none, and shows it on its row", () => {
		const run = world({ managed: true });
		expect(run.service.wire().agentStates[WORKER]).toEqual({
			needsAction: "no_task",
		});
		const task = run.service.newTask({ title: "A", status: "in_progress" });
		run.service.bindTask(task.id, [WORKER]);
		expect(run.service.wire().agentStates[WORKER]).toEqual({
			task: { id: task.id, title: "A", status: "in_progress" },
			needsAction: "idle",
		});
		expect(run.service.status({ agentId: WORKER })).toMatchObject({
			subject: "agent",
			task: { id: task.id },
			needsAction: { clause: "idle" },
		});
	});

	it("reads a task's whole state in one status call", () => {
		const run = world({ items: [issue()] });
		const task = run.service.newTask({
			title: "API整理",
			links: [ISSUE_URL],
			memo: "CI が通ったら頼む",
		});
		expect(run.service.status({ task: task.id })).toMatchObject({
			subject: "task",
			task: { id: task.id, memo: { text: "CI が通ったら頼む" } },
			items: [{ ref: "issue=acme/app#123", state: "open" }],
		});
		expect(run.service.status({ item: "acme/app#123" })).toMatchObject({
			subject: "item",
			tasks: [{ id: task.id, status: "waiting" }],
		});
	});
});

describe("an agent the person hands over from the window", () => {
	it("tells the orchestrator at once who it is, where, what it was doing, and to adopt it", async () => {
		const run = world({
			cursor: { value: "e7", text: "ログインの 500 を直して" },
		});
		run.invariant.managed.add(WORKER);
		await run.service.handedOver(WORKER, true, "fix/login");
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain(
			`人がエージェント agent=a1b2c3d4 (agent a1, ws=w, branch=fix/login) をあなたの管理下に移しました。devhub:agent/${WORKER}`,
		);
		expect(run.sent[0]).toContain("状態: idle。");
		expect(run.sent[0]).toContain(
			"人からの最後の依頼:「ログインの 500 を直して」",
		);
		expect(run.sent[0]).toContain("どのタスクにも紐づいていません");
		expect(run.sent[0]).toContain("task new");
		expect(run.of("agent_managed")[0]?.fate).toBe("delivered");
	});

	it("tells it to let go of one taken back, naming the task to unbind", async () => {
		const run = world({ managed: true });
		const task = run.service.newTask({ title: "ログイン修正" });
		run.service.bindTask(task.id, [WORKER]);
		run.sent.length = 0;
		run.invariant.managed.delete(WORKER);
		await run.service.handedOver(WORKER, false);
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain("をあなたの管理から外しました");
		expect(run.sent[0]).toContain(
			`task=${String(task.id)}「ログイン修正」 に紐づいています`,
		);
		expect(run.sent[0]).toContain(
			`devhub --tell task unbind ${String(task.id)} a1b2c3d4`,
		);
	});

	it("says nothing about the orchestrator itself", async () => {
		const run = world();
		await run.service.handedOver(ORCH, true);
		expect(run.sent).toEqual([]);
		expect(run.of("agent_managed")).toEqual([]);
	});

	it("is not held by saving, and dropped while off (the agent is no_task once on)", async () => {
		const run = world();
		run.invariant.managed.add(WORKER);
		run.service.setMode("saving");
		run.sent.length = 0;
		await run.service.handedOver(WORKER, true);
		expect(
			run.sent.filter((text) => text.includes("管理下に移しました")),
		).toHaveLength(1);
		run.service.setMode("off");
		run.sent.length = 0;
		await run.service.handedOver(WORKER, true);
		expect(run.sent).toEqual([]);
		expect(run.of("agent_managed").at(-1)).toMatchObject({
			fate: "dropped",
			reason: "off",
		});
	});
});
