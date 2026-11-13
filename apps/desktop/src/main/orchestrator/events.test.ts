import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR_EVENTS } from "../../model/orchestratorSettings.js";
import {
	EventDispatcher,
	MAX_DELIVERY_LINES,
	composeDelivery,
	eventLine,
	eventsMessage,
	humanMessages,
	merge,
	shortId,
	subjectOf,
	workspaceToken,
	type OrchestratorEvent,
} from "./events.js";

const AGENT = { id: "a1b2c3d4-0000-4000-8000-000000000000", name: "API fix" };
const ORCH = "0rc4e57r-0000";
const ISSUE = {
	repo: "acme/app",
	number: 123,
	title: "API整理",
	url: "https://github.com/acme/app/issues/123",
};

function needsActionIssue(): OrchestratorEvent {
	return {
		type: "needs_action",
		subject: { kind: "issue", item: ISSUE },
		breach: { clause: "no_task" },
	};
}

function needsActionTask(): OrchestratorEvent {
	return {
		type: "needs_action",
		subject: { kind: "task", task: { id: 7, title: "ログイン修正" } },
		ws: "web",
		breach: { clause: "idle" },
	};
}

const TASK = { id: 7, title: "ログイン修正" };

function world(
	options: {
		events?: readonly string[];
		event_prompt?: string;
		init_prompt?: string;
		busy?: boolean;
		interval?: string;
		relevant?: (event: OrchestratorEvent) => boolean;
		standing?: () => readonly OrchestratorEvent[];
		orchestrator?: () => string | undefined;
	} = {},
) {
	const sent: string[] = [];
	const delivered: OrchestratorEvent[] = [];
	const state = { busy: options.busy ?? false, now: 1_000_000 };
	const timers: { at: number; run: () => void }[] = [];
	const dispatcher = new EventDispatcher({
		orchestrator: options.orchestrator ?? (() => ORCH),
		settings: () => ({
			event_prompt: options.event_prompt ?? "handle: {EVENT}",
			init_prompt: options.init_prompt,
			events: options.events ?? DEFAULT_ORCHESTRATOR_EVENTS,
			delivery_interval: options.interval ?? "5m",
		}),
		deliver: (_agent, text) => {
			sent.push(text);
		},
		delivered: (events) => {
			delivered.push(...events);
		},
		busy: () => state.busy,
		...(options.relevant === undefined ? {} : { relevant: options.relevant }),
		...(options.standing === undefined ? {} : { standing: options.standing }),
		now: () => state.now,
		setTimer: (ms, run) => {
			const timer = { at: state.now + ms, run };
			timers.push(timer);
			return {
				cancel: () => {
					timers.splice(timers.indexOf(timer), 1);
				},
			};
		},
	});
	/** Move the clock and run what is due. */
	const advance = (ms: number) => {
		state.now += ms;
		for (const timer of timers.filter((one) => one.at <= state.now)) {
			timers.splice(timers.indexOf(timer), 1);
			timer.run();
		}
	};
	return { dispatcher, sent, delivered, state, advance };
}

describe("an event's line", () => {
	const now = Date.UTC(2026, 10, 5, 3, 0);
	it("names a task, an item and the clause it fails, no state", () => {
		expect(eventLine(needsActionIssue(), now)).toBe(
			"[needs_action] issue=acme/app#123 — no_task",
		);
		expect(eventLine(needsActionTask(), now)).toBe(
			"[needs_action] task=7「ログイン修正」 ws=web — idle",
		);
		expect(
			eventLine(
				{
					type: "needs_action",
					subject: {
						kind: "pr",
						item: { ...ISSUE, number: 9, url: `${ISSUE.url}9` },
					},
					breach: { clause: "no_task" },
				},
				now,
			),
		).toBe("[needs_action] pr=acme/app#9 — no_task");
	});

	it("names an agent with no task by the id --tell takes", () => {
		expect(
			eventLine(
				{
					type: "needs_action",
					subject: { kind: "agent", agent: AGENT },
					ws: "api",
					breach: { clause: "no_task" },
				},
				now,
			),
		).toBe("[needs_action] agent=a1b2c3d4 (API fix) ws=api — no_task");
	});

	it("says which 待機 task may be ready and why, nothing more", () => {
		const changed = {
			type: "task.changed",
			taskId: 12,
			reasons: ["subjects_changed"],
		} as const;
		expect(eventLine(changed, now)).toBe(
			"[task.changed] task=12 — subjects_changed",
		);
		const due = { ...changed, reasons: ["due"], checkAt: 5 } as const;
		expect(eventLine(due, now)).toBe("[task.changed] task=12 — due");
		// Both, for the same task, are one line saying both.
		expect(eventLine(merge(changed, due), now)).toBe(
			"[task.changed] task=12 — due, subjects_changed",
		);
	});

	it("lists the open tasks under a triage, the stale ones with why", () => {
		expect(
			eventLine(
				{
					type: "triage",
					tasks: [
						{ id: 3, title: "A", status: "in_progress", priority: "high" },
						{
							id: 4,
							title: "B",
							status: "waiting",
							stale: ["PR acme/app#9 はマージ済み"],
							overdue: true,
						},
					],
				},
				now,
			)
				.split("\n")
				.slice(1),
		).toEqual([
			"  task=3「A」 処理中 優先度=high",
			"  task=4「B」 待機 — 古いかも: PR acme/app#9 はマージ済み (前回の triage から: この triage で解決する)",
		]);
	});

	it("names ids the way --tell takes them", () => {
		expect(shortId(AGENT.id)).toBe("a1b2c3d4");
		expect(workspaceToken("api", "w-1")).toBe("api");
		expect(workspaceToken("my app", "w-1")).toBe("w-1");
	});
});

describe("the person's words", () => {
	it("go as their own message: one naming line, then the text as typed", () => {
		const text = "承認する\n\n> 引用も [type] もそのまま\n```\nfence\n```";
		expect(
			humanMessages({
				type: "escalation_answered",
				task: TASK,
				escalationId: 12,
				title: "本番DB",
				agents: [AGENT],
				answers: [{ text, option: "承認する" }],
			}),
		).toEqual([
			`task=7「ログイン修正」 esc=12「本番DB」 への人の回答 (選択肢「承認する」):\n${text}`,
		]);
		expect(
			humanMessages({
				type: "task.human_direct",
				task: TASK,
				agent: AGENT,
				since: "e39",
				messages: [{ text: "月曜の朝に流して" }],
			}),
		).toEqual([
			[
				"task=7「ログイン修正」 agent=a1b2c3d4 に人が直接送ったメッセージ:",
				"月曜の朝に流して",
				"",
				"整理してください (人の判断です。agent=a1b2c3d4 には届いているので、同じ指示を送り直さない):",
				"- 人の判断として記録する: task edit 7 --memo の「決めたこと」に (エスカレーションへの回答と同じ扱い)、ほかの仕事にも効くなら decisions.md にも",
				"- タスクを指示に合わせる: メモの次にすること、状態 (task status 7 …)、方針が変わったなら題名 (task edit 7 --title) とリンク",
				"- 同じタスクのほかのエージェントはいません",
			].join("\n"),
		]);
	});

	it("to an agent directly: a burst is one message, in order, then what to tidy up", () => {
		const [message] = humanMessages({
			type: "task.human_direct",
			task: TASK,
			agent: AGENT,
			since: "e39",
			messages: [{ text: "staging だけで" }, { text: "あ、本番は来週" }],
			escalations: [{ id: 12, title: "本番DB" }],
			others: [{ id: "e5f6a7b8-0000-4000-8000-000000000000", name: "UI" }],
		});
		expect(message!.split("\n")).toEqual([
			"task=7「ログイン修正」 agent=a1b2c3d4 に人が直接送ったメッセージ (2 通、送った順):",
			"[1]",
			"staging だけで",
			"[2]",
			"あ、本番は来週",
			"",
			"整理してください (人の判断です。agent=a1b2c3d4 には届いているので、同じ指示を送り直さない):",
			'- 開いている質問 esc=12「本番DB」: この指示が答えている・覆しているなら devhub --tell escalation resolve 12 --note "人が agent=a1b2c3d4 に直接指示: <要点>" で閉じる (取り下げない)。関係なければ開いたまま',
			"- 人の判断として記録する: task edit 7 --memo の「決めたこと」に (エスカレーションへの回答と同じ扱い)、ほかの仕事にも効くなら decisions.md にも",
			"- タスクを指示に合わせる: メモの次にすること、状態 (task status 7 …)、方針が変わったなら題名 (task edit 7 --title) とリンク",
			"- 同じタスクのほかのエージェント (agent=e5f6a7b8 (UI)) の作業がこの指示と食い違うなら、止めるか指示し直す",
		]);
	});

	it("to an agent on no task: it is bound or given a task, keyed on the agent", () => {
		const event = {
			type: "task.human_direct" as const,
			agent: AGENT,
			messages: [{ text: "README を直して" }],
		};
		expect(subjectOf(event)).toBe(`agent ${AGENT.id}`);
		const lines = humanMessages(event)[0]!.split("\n");
		expect(lines.slice(0, 2)).toEqual([
			"agent=a1b2c3d4 に人が直接送ったメッセージ:",
			"README を直して",
		]);
		expect(lines[4]).toContain("どのタスクにも紐づいていません");
		expect(lines[4]).toContain("task bind <タスク> a1b2c3d4");
	});

	it("are sent at once, whatever is pending or busy, and never in the template", () => {
		const { dispatcher, sent, delivered, state } = world({ busy: true });
		dispatcher.dispatch(needsActionIssue());
		state.busy = true;
		dispatcher.dispatch({
			type: "escalation_answered",
			task: TASK,
			escalationId: 3,
			title: "t",
			agents: [],
			answers: [{ text: "はい" }],
		});
		expect(sent).toEqual([
			"task=7「ログイン修正」 esc=3「t」 への人の回答:\nはい",
		]);
		expect(delivered.map((one) => one.type)).toEqual(["escalation_answered"]);
		expect(dispatcher.held()).toHaveLength(1);
	});

	it("go while off, each alone, as in full; a request is held, and goes first on resume", async () => {
		const { dispatcher, sent } = world();
		dispatcher.pause();
		dispatcher.dispatch(needsActionIssue());
		for (const text of ["一つ目", "二つ目"])
			dispatcher.dispatch({
				type: "escalation_answered",
				task: TASK,
				escalationId: 3,
				title: "t",
				agents: [],
				answers: [{ text }],
			});
		dispatcher.dispatch({
			type: "request",
			task: { id: 4, title: "依頼" },
			text: "依頼",
		});
		expect(sent).toEqual([
			"task=7「ログイン修正」 esc=3「t」 への人の回答:\n一つ目",
			"task=7「ログイン修正」 esc=3「t」 への人の回答:\n二つ目",
		]);
		await dispatcher.resume();
		expect(sent.slice(2)).toEqual([
			expect.stringMatching(/^task=4「依頼」 人からの依頼 .*\n依頼$/u),
			expect.stringContaining("[needs_action] issue=acme/app#123"),
		]);
	});
});

describe("the dispatcher", () => {
	it("delivers a batch at most once per delivery_interval", () => {
		const { dispatcher, sent, advance } = world({ interval: "5m" });
		dispatcher.dispatch({ type: "init" });
		advance(300);
		expect(sent).toHaveLength(1);
		dispatcher.dispatch(needsActionIssue());
		advance(60_000);
		expect(sent).toHaveLength(1);
		advance(240_000);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("[needs_action] issue=acme/app#123");
	});

	it("holds a batch while the orchestrator is in a foreground turn", () => {
		const { dispatcher, sent, state, advance } = world({ busy: true });
		dispatcher.dispatch(needsActionIssue());
		advance(300);
		expect(sent).toEqual([]);
		state.busy = false;
		dispatcher.flush();
		expect(sent).toHaveLength(1);
	});

	it("keeps one line per subject: the latest says how it stands", () => {
		const { dispatcher, sent, state, advance } = world({ busy: true });
		dispatcher.dispatch({
			...needsActionTask(),
			breach: { clause: "no_agent" },
		} as OrchestratorEvent);
		dispatcher.dispatch(needsActionTask());
		state.busy = false;
		advance(300);
		expect(sent).toEqual([
			"handle: [needs_action] task=7「ログイン修正」 ws=web — idle",
		]);
	});

	it("keeps one pending event per timer", () => {
		const { dispatcher, state, advance, sent } = world({ busy: true });
		dispatcher.dispatch({ type: "timer.elapsed", name: "t", interval: "5m" });
		dispatcher.dispatch({ type: "timer.elapsed", name: "t", interval: "5m" });
		state.busy = false;
		advance(300);
		expect(sent[0]?.match(/\[timer\.elapsed\]/gu)).toHaveLength(1);
	});

	it("drops what no longer needs attention when it would go", () => {
		const { dispatcher, sent, advance } = world({ relevant: () => false });
		dispatcher.dispatch(needsActionIssue());
		advance(300);
		expect(sent).toEqual([]);
		expect(dispatcher.recent(1)[0]?.fate).toBe("dropped-stale");
	});

	it("applies the events filter", () => {
		const { dispatcher, sent, advance } = world({
			events: ["*", "!timer.*"],
		});
		dispatcher.dispatch({ type: "timer.elapsed", name: "t", interval: "5m" });
		dispatcher.dispatch(needsActionIssue());
		advance(300);
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toContain("timer.elapsed");
	});

	it("caps a backlog at one line per subject and counts the rest", () => {
		const { dispatcher, sent, state, advance } = world({ busy: true });
		for (let index = 0; index < MAX_DELIVERY_LINES + 3; index += 1)
			dispatcher.dispatch({
				type: "needs_action",
				subject: {
					kind: "issue",
					item: {
						...ISSUE,
						number: index,
						url: `${ISSUE.url}${String(index)}`,
					},
				},
				breach: { clause: "no_agent" },
			});
		state.busy = false;
		advance(300);
		expect(sent[0]).toContain("…ほか 3 件");
	});

	it("drops events with nobody to tell", () => {
		const dispatcher = new EventDispatcher({
			orchestrator: () => undefined,
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: ["*"],
				delivery_interval: "5m",
			}),
			deliver: () => {
				throw new Error("nobody to tell");
			},
		});
		expect(dispatcher.dispatch(needsActionIssue()).fate).toBe("dropped");
	});
});

describe("the standing lines (needs_action)", () => {
	it("carries them at every delivery while they stand, once per delivery_interval, and nothing when there is nothing", () => {
		const standing = { now: [needsActionIssue()] };
		const { dispatcher, sent, advance } = world({
			interval: "5m",
			standing: () => standing.now,
		});
		// No grace: the first look delivers.
		dispatcher.flush();
		expect(sent).toEqual([
			"handle: [needs_action] issue=acme/app#123 — no_task",
		]);
		advance(60_000);
		dispatcher.flush();
		expect(sent).toHaveLength(1);
		// The nag: again at the next delivery, by its own timer.
		advance(240_000);
		expect(sent).toHaveLength(2);
		advance(300_000);
		expect(sent).toHaveLength(3);
		// Settled: the next delivery has nothing, and nothing is sent.
		standing.now = [];
		advance(300_000);
		dispatcher.flush();
		expect(sent).toHaveLength(3);
		expect(
			dispatcher.recent(10).map((entry) => [entry.event.type, entry.fate]),
		).toEqual([
			["needs_action", "delivered"],
			["needs_action", "delivered"],
			["needs_action", "delivered"],
		]);
	});

	it("goes with what is pending, as one message, and waits for a busy orchestrator", () => {
		const { dispatcher, sent, state, advance } = world({
			busy: true,
			standing: () => [needsActionTask()],
		});
		dispatcher.dispatch({ type: "custom.t", text: "t" });
		advance(300);
		expect(sent).toEqual([]);
		state.busy = false;
		dispatcher.flush();
		expect(sent).toEqual([
			"handle: [custom.t] — t\n[needs_action] task=7「ログイン修正」 ws=web — idle",
		]);
	});

	it("is held by a pause, and goes on resume", async () => {
		const { dispatcher, sent } = world({
			standing: () => [needsActionIssue()],
		});
		dispatcher.pause();
		dispatcher.flush();
		expect(sent).toEqual([]);
		expect(await dispatcher.resume()).toBe(1);
		expect(sent).toHaveLength(1);
	});

	it("follows the events filter", () => {
		const { dispatcher, sent } = world({
			events: ["*", "!needs_action"],
			standing: () => [needsActionIssue()],
		});
		dispatcher.flush();
		expect(sent).toEqual([]);
	});
});

describe("the message", () => {
	it("renders {EVENT_JSON} only when the template has it, and init_prompt for init", () => {
		const now = 0;
		const events: OrchestratorEvent[] = [{ type: "init" }];
		expect(
			eventsMessage(
				events,
				{ event_prompt: "e {EVENT_JSON}", init_prompt: undefined },
				now,
			),
		).toBe('e [{"type":"init"}]');
		expect(
			eventsMessage(
				events,
				{ event_prompt: "e {EVENT}", init_prompt: "i {EVENT}" },
				now,
			),
		).toMatch(/^i \[init\]/u);
	});
});

describe("the preview", () => {
	const answer = (text: string): OrchestratorEvent => ({
		type: "escalation_answered",
		task: TASK,
		escalationId: 3,
		title: "t",
		agents: [],
		answers: [{ text }],
	});

	it("is exactly what the next delivery sends, and changes nothing", () => {
		const standing = [needsActionTask()];
		const { dispatcher, sent, advance } = world({
			standing: () => standing,
			relevant: (event) => event.type !== "task.changed",
		});
		dispatcher.dispatch({ type: "init" });
		advance(300);
		sent.length = 0;
		dispatcher.dispatch({ type: "custom.t", text: "t" });
		dispatcher.dispatch({
			type: "task.changed",
			taskId: 4,
			reasons: ["due"],
			checkAt: 1,
		});
		const log = dispatcher.recent(200).map((entry) => ({ ...entry }));
		const held = dispatcher.held();
		const preview = dispatcher.preview();
		// Nothing marked, logged or dropped by looking.
		expect(dispatcher.recent(200)).toEqual(log);
		expect(dispatcher.held()).toEqual(held);
		expect(dispatcher.preview()).toEqual(preview);
		expect(preview.human).toEqual([]);
		expect(preview.batch).toBe(
			"handle: [custom.t] — t\n[needs_action] task=7「ログイン修正」 ws=web — idle",
		);
		// The interval since the init delivery holds it till then.
		expect(preview.when).toEqual({ kind: "at", at: 1_000_300 + 300_000 });
		advance(300_000);
		expect(sent).toEqual([preview.batch]);
		expect(dispatcher.preview()).toMatchObject({
			batch: "handle: [needs_action] task=7「ログイン修正」 ws=web — idle",
		});
	});

	it("says nothing to send, and no time, when nothing would go", () => {
		const { dispatcher } = world();
		expect(dispatcher.preview()).toEqual({ human: [], events: [], more: 0 });
	});

	it("while paused: the person's held requests each alone, then the batch, as resume sends them", () => {
		const { dispatcher, sent } = world({
			standing: () => [needsActionIssue()],
		});
		dispatcher.pause();
		dispatcher.dispatch(answer("一つ目"));
		expect(sent).toEqual([
			"task=7「ログイン修正」 esc=3「t」 への人の回答:\n一つ目",
		]);
		sent.length = 0;
		dispatcher.dispatch({
			type: "request",
			task: { id: 1, title: "依頼" },
			text: "一つ目",
		});
		dispatcher.dispatch({
			type: "request",
			task: { id: 2, title: "依頼" },
			text: "二つ目",
		});
		dispatcher.dispatch({ type: "custom.x", text: "y" });
		const preview = dispatcher.preview();
		expect(preview.when).toEqual({ kind: "paused" });
		expect(preview.human).toEqual([
			expect.stringMatching(/^task=1「依頼」 .*\n一つ目$/u),
			expect.stringMatching(/^task=2「依頼」 .*\n二つ目$/u),
		]);
		expect(sent).toEqual([]);
		dispatcher.resume();
		expect(sent).toEqual([...preview.human, preview.batch]);
	});

	it("is composed by the delivery's own composer, cut at the cap", () => {
		const lines = Array.from(
			{ length: MAX_DELIVERY_LINES + 2 },
			(_, index): OrchestratorEvent => ({
				type: "custom.x",
				text: String(index),
			}),
		);
		const plan = composeDelivery(
			[],
			lines,
			{ event_prompt: "{EVENT}", init_prompt: undefined },
			0,
		);
		expect(plan.events).toHaveLength(MAX_DELIVERY_LINES);
		expect(plan.more).toBe(2);
		expect(plan.batch?.split("\n").at(-1)).toMatch(/ほか 2 件/u);
	});
});

describe("turning events on", () => {
	it("delivers at once, past the interval and a busy orchestrator, and the interval counts from there", () => {
		const { dispatcher, sent, state, advance } = world({ interval: "5m" });
		dispatcher.dispatch({ type: "init" });
		advance(300);
		expect(sent).toHaveLength(1);
		dispatcher.pause();
		dispatcher.dispatch({ type: "custom.a", text: "a" });
		advance(10_000);
		state.busy = true;
		expect(dispatcher.resume()).toBe(1);
		expect(sent).toEqual([expect.any(String), "handle: [custom.a] — a"]);
		state.busy = false;
		dispatcher.dispatch({ type: "custom.b", text: "b" });
		advance(299_000);
		expect(sent).toHaveLength(2);
		advance(1_000);
		expect(sent.at(-1)).toBe("handle: [custom.b] — b");
	});

	it("sends the standing needs_action lines at once with nothing pending", () => {
		const { dispatcher, sent } = world({
			standing: () => [needsActionIssue()],
		});
		dispatcher.flush();
		sent.length = 0;
		dispatcher.pause();
		dispatcher.resume();
		expect(sent).toEqual([
			"handle: [needs_action] issue=acme/app#123 — no_task",
		]);
	});

	it("off sends nothing", () => {
		const { dispatcher, sent } = world({
			standing: () => [needsActionIssue()],
		});
		dispatcher.dispatch({ type: "custom.a", text: "a" });
		dispatcher.flush();
		sent.length = 0;
		dispatcher.dispatch({ type: "custom.b", text: "b" });
		dispatcher.pause();
		dispatcher.flush();
		expect(sent).toEqual([]);
	});
});

describe("an agent the person hands over, or takes back", () => {
	const handed: OrchestratorEvent = {
		type: "agent_managed",
		agent: AGENT,
		ws: "web",
		branch: "fix/login",
		status: "idle",
		request: "ログインの 500 を直して",
	};
	const taken: OrchestratorEvent = {
		type: "agent_unmanaged",
		agent: AGENT,
		ws: "web",
		branch: "fix/login",
		status: "working",
		task: TASK,
	};

	it("says who and where it is, its link, what it was doing, and to adopt it", () => {
		const [text] = humanMessages(handed as never);
		expect(text).toBe(
			[
				`人がエージェント agent=a1b2c3d4 (API fix, ws=web, branch=fix/login) をあなたの管理下に移しました。devhub:agent/${AGENT.id}`,
				"状態: idle。人からの最後の依頼:「ログインの 500 を直して」。どのタスクにも紐づいていません。",
				"引き取ってください: 中身を devhub --tell agent read a1b2c3d4 で確かめ、合う開いたタスクがあれば devhub --tell task bind <タスク> a1b2c3d4、なければ devhub --tell task new --title … --status in_progress で作って task bind a1b2c3d4 し、次の一手を決める。",
			].join("\n"),
		);
		const [bound] = humanMessages({ ...handed, task: TASK } as never);
		expect(bound).toContain("task=7「ログイン修正」 に紐づいています");
		expect(bound).toContain("そのタスクのまま進めるか");
	});

	it("tells it to let go of one taken back: not to resume it, and to unbind its task", () => {
		const [text] = humanMessages(taken as never);
		expect(text).toContain(
			"人がエージェント agent=a1b2c3d4 (API fix, ws=web, branch=fix/login) をあなたの管理から外しました。人が自分で進めます。",
		);
		expect(text).toContain(`devhub:agent/${AGENT.id}`);
		expect(text).toContain("再開もしないでください");
		expect(text).toContain("devhub --tell task unbind 7 a1b2c3d4");
		expect(eventLine(taken, 0)).toBe(
			"[agent_unmanaged] agent=a1b2c3d4 (API fix) ws=web task=7「ログイン修正」 — 人が管理から外しました",
		);
	});

	it("goes at once as its own message, in full and in saving, never in a batch", () => {
		const { dispatcher, sent } = world({ busy: true });
		dispatcher.dispatch(handed);
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toContain("handle:");
		dispatcher.setMode("saving");
		dispatcher.dispatch(taken);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("管理から外しました");
	});

	it("while off: one handed over is dropped (the board's no_task says it), one taken back waits for on", () => {
		const { dispatcher, sent } = world();
		dispatcher.pause();
		expect(dispatcher.dispatch(handed)).toMatchObject({
			fate: "dropped",
			reason: "off",
		});
		dispatcher.dispatch(taken);
		expect(sent).toEqual([]);
		dispatcher.resume();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("管理から外しました");
	});

	it("with no orchestrator: one handed over has nobody, one taken back waits for one", () => {
		const running: { id?: string } = {};
		const { dispatcher, sent } = world({ orchestrator: () => running.id });
		expect(dispatcher.dispatch(handed).fate).toBe("dropped");
		dispatcher.dispatch(taken);
		expect(sent).toEqual([]);
		running.id = ORCH;
		dispatcher.flush();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("管理から外しました");
	});

	it("drops one taken back that was handed over again while it waited", () => {
		let managed = false;
		const { dispatcher, sent } = world({
			relevant: (event) => event.type !== "agent_unmanaged" || !managed,
		});
		dispatcher.pause();
		const entry = dispatcher.dispatch(taken);
		managed = true;
		dispatcher.resume();
		expect(sent).toEqual([]);
		expect(entry.fate).toBe("dropped-stale");
	});
});
