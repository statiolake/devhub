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

function needsActionIssue(
	clause: "no_agent" | "idle_no_escalation" = "no_agent",
): OrchestratorEvent {
	return {
		type: "needs_action",
		subject: { kind: "issue", item: ISSUE },
		breach: { clause },
	};
}

function world(
	options: {
		events?: readonly string[];
		event_prompt?: string;
		init_prompt?: string;
		busy?: boolean;
		interval?: string;
		relevant?: (event: OrchestratorEvent) => boolean;
		standing?: () => readonly OrchestratorEvent[];
	} = {},
) {
	const sent: string[] = [];
	const delivered: OrchestratorEvent[] = [];
	const state = { busy: options.busy ?? false, now: 1_000_000 };
	const timers: { at: number; run: () => void }[] = [];
	const dispatcher = new EventDispatcher({
		orchestrator: () => ORCH,
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
	it("names an item and the clause it fails, no state", () => {
		expect(eventLine(needsActionIssue(), now)).toBe(
			"[needs_action] issue=acme/app#123 — no_agent",
		);
		expect(
			eventLine(
				{
					type: "needs_action",
					subject: {
						kind: "pr",
						item: { ...ISSUE, number: 9, url: `${ISSUE.url}9` },
					},
					ws: "web",
					breach: { clause: "idle_no_escalation" },
				},
				now,
			),
		).toBe("[needs_action] pr=acme/app#9 ws=web — idle_no_escalation");
	});

	it("names an agent by the id --tell takes, and why it is outside", () => {
		expect(
			eventLine(
				{
					type: "needs_action",
					subject: { kind: "agent", agent: AGENT },
					ws: "api",
					breach: { clause: "outside_population", outside: "closed" },
				},
				now,
			),
		).toBe(
			"[needs_action] agent=a1b2c3d4 (API fix) ws=api — outside_population (closed)",
		);
	});

	it("says which wait may be ready and why, nothing more", () => {
		const changed = {
			type: "waiting.changed",
			escalationId: 12,
			reasons: ["subjects_changed"],
			waitSince: 5,
		} as const;
		expect(eventLine(changed, now)).toBe(
			"[waiting.changed] esc=12 — subjects_changed",
		);
		const due = { ...changed, reasons: ["due"] } as const;
		expect(eventLine(due, now)).toBe("[waiting.changed] esc=12 — due");
		// Both, for the same wait, are one line saying both.
		expect(eventLine(merge(changed, due), now)).toBe(
			"[waiting.changed] esc=12 — due, subjects_changed",
		);
		// A new wait is a new statement.
		expect(eventLine(merge(changed, { ...due, waitSince: 9 }), now)).toBe(
			"[waiting.changed] esc=12 — due",
		);
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
				escalationId: 12,
				title: "本番DB",
				agents: [AGENT],
				answers: [{ text, option: "承認する" }],
			}),
		).toEqual([`esc=12「本番DB」 への人の回答 (選択肢「承認する」):\n${text}`]);
		expect(
			humanMessages({
				type: "escalation.human_direct",
				escalationId: 12,
				title: "本番DB",
				agent: AGENT,
				since: "e39",
				messages: [{ text: "月曜の朝に流して" }],
			}),
		).toEqual([
			"esc=12「本番DB」 agent=a1b2c3d4 に人が直接送ったメッセージ:\n月曜の朝に流して",
		]);
	});

	it("are sent at once, whatever is pending or busy, and never in the template", () => {
		const { dispatcher, sent, delivered, state } = world({ busy: true });
		dispatcher.dispatch(needsActionIssue());
		state.busy = true;
		dispatcher.dispatch({
			type: "escalation_answered",
			escalationId: 3,
			title: "t",
			agents: [],
			answers: [{ text: "はい" }],
		});
		expect(sent).toEqual(["esc=3「t」 への人の回答:\nはい"]);
		expect(delivered.map((one) => one.type)).toEqual(["escalation_answered"]);
		expect(dispatcher.held()).toHaveLength(1);
	});

	it("are held by a pause, and go first, each alone, on resume", async () => {
		const { dispatcher, sent } = world();
		dispatcher.pause();
		dispatcher.dispatch(needsActionIssue());
		for (const text of ["一つ目", "二つ目"])
			dispatcher.dispatch({
				type: "escalation_answered",
				escalationId: 3,
				title: "t",
				agents: [],
				answers: [{ text }],
			});
		expect(sent).toEqual([]);
		await dispatcher.resume();
		expect(sent).toEqual([
			"esc=3「t」 への人の回答:\n一つ目",
			"esc=3「t」 への人の回答:\n二つ目",
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
		dispatcher.dispatch(needsActionIssue("no_agent"));
		dispatcher.dispatch(needsActionIssue("idle_no_escalation"));
		state.busy = false;
		advance(300);
		expect(sent).toEqual([
			"handle: [needs_action] issue=acme/app#123 — idle_no_escalation",
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
			"handle: [needs_action] issue=acme/app#123 — no_agent",
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
			standing: () => [needsActionIssue("idle_no_escalation")],
		});
		dispatcher.dispatch({ type: "timer.elapsed", name: "t", interval: "5m" });
		advance(300);
		expect(sent).toEqual([]);
		state.busy = false;
		dispatcher.flush();
		expect(sent).toEqual([
			"handle: [timer.elapsed] t\n[needs_action] issue=acme/app#123 — idle_no_escalation",
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
		escalationId: 3,
		title: "t",
		agents: [],
		answers: [{ text }],
	});

	it("is exactly what the next delivery sends, and changes nothing", () => {
		const standing = [needsActionIssue("idle_no_escalation")];
		const { dispatcher, sent, advance } = world({
			standing: () => standing,
			relevant: (event) => event.type !== "waiting.changed",
		});
		dispatcher.dispatch({ type: "init" });
		advance(300);
		sent.length = 0;
		dispatcher.dispatch({ type: "timer.elapsed", name: "t", interval: "5m" });
		dispatcher.dispatch({
			type: "waiting.changed",
			escalationId: 4,
			reasons: ["due"],
			waitSince: 1,
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
			"handle: [timer.elapsed] t\n[needs_action] issue=acme/app#123 — idle_no_escalation",
		);
		// The interval since the init delivery holds it till then.
		expect(preview.when).toEqual({ kind: "at", at: 1_000_300 + 300_000 });
		advance(300_000);
		expect(sent).toEqual([preview.batch]);
		expect(dispatcher.preview()).toMatchObject({
			batch: "handle: [needs_action] issue=acme/app#123 — idle_no_escalation",
		});
	});

	it("says nothing to send, and no time, when nothing would go", () => {
		const { dispatcher } = world();
		expect(dispatcher.preview()).toEqual({ human: [], events: [], more: 0 });
	});

	it("while paused: the person's words each alone, then the batch, as resume sends them", () => {
		const { dispatcher, sent } = world({
			standing: () => [needsActionIssue()],
		});
		dispatcher.pause();
		dispatcher.dispatch(answer("一つ目"));
		dispatcher.dispatch(answer("二つ目"));
		dispatcher.dispatch({ type: "custom.x", text: "y" });
		const preview = dispatcher.preview();
		expect(preview.when).toEqual({ kind: "paused" });
		expect(preview.human).toEqual([
			"esc=3「t」 への人の回答:\n一つ目",
			"esc=3「t」 への人の回答:\n二つ目",
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
			"handle: [needs_action] issue=acme/app#123 — no_agent",
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
