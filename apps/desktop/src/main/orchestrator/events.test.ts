import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR_EVENTS } from "../../model/orchestratorSettings.js";
import {
	EventDispatcher,
	MAX_DELIVERY_LINES,
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

function unsettledIssue(
	facts: readonly string[] = ["state=open"],
): OrchestratorEvent {
	return {
		type: "unsettled",
		subject: { kind: "issue", item: ISSUE },
		facts,
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
	it("states an unsettled Issue and its facts, no reason", () => {
		expect(
			eventLine(
				unsettledIssue([
					"state=open",
					"assigned=yes",
					"lane=Todo",
					"pr=none",
					"agents=none",
					"esc=none",
				]),
				now,
			),
		).toBe(
			"[unsettled] issue=acme/app#123「API整理」 state=open assigned=yes lane=Todo pr=none agents=none esc=none https://github.com/acme/app/issues/123",
		);
	});

	it("states an unsettled agent by the id --tell takes", () => {
		expect(
			eventLine(
				{
					type: "unsettled",
					subject: { kind: "agent", agent: AGENT },
					ws: "api",
					facts: ["status=idle", "issue=none"],
				},
				now,
			),
		).toBe(
			"[unsettled] agent=a1b2c3d4 (API fix) ws=api status=idle issue=none",
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
		dispatcher.dispatch(unsettledIssue());
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
		dispatcher.dispatch(unsettledIssue());
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
			expect.stringContaining("[unsettled] issue=acme/app#123"),
		]);
	});
});

describe("the dispatcher", () => {
	it("delivers a batch at most once per delivery_interval", () => {
		const { dispatcher, sent, advance } = world({ interval: "5m" });
		dispatcher.dispatch({ type: "init" });
		advance(300);
		expect(sent).toHaveLength(1);
		dispatcher.dispatch(unsettledIssue());
		advance(60_000);
		expect(sent).toHaveLength(1);
		advance(240_000);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("[unsettled] issue=acme/app#123");
	});

	it("holds a batch while the orchestrator is in a foreground turn", () => {
		const { dispatcher, sent, state, advance } = world({ busy: true });
		dispatcher.dispatch(unsettledIssue());
		advance(300);
		expect(sent).toEqual([]);
		state.busy = false;
		dispatcher.flush();
		expect(sent).toHaveLength(1);
	});

	it("keeps one line per subject: the latest says how it stands", () => {
		const { dispatcher, sent, state, advance } = world({ busy: true });
		dispatcher.dispatch(unsettledIssue(["state=open", "checks=pending"]));
		dispatcher.dispatch(unsettledIssue(["state=open", "checks=failing"]));
		state.busy = false;
		advance(300);
		expect(sent).toEqual([
			"handle: [unsettled] issue=acme/app#123「API整理」 state=open checks=failing https://github.com/acme/app/issues/123",
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
		dispatcher.dispatch(unsettledIssue());
		advance(300);
		expect(sent).toEqual([]);
		expect(dispatcher.recent(1)[0]?.fate).toBe("dropped-stale");
	});

	it("applies the events filter", () => {
		const { dispatcher, sent, advance } = world({
			events: ["*", "!timer.*"],
		});
		dispatcher.dispatch({ type: "timer.elapsed", name: "t", interval: "5m" });
		dispatcher.dispatch(unsettledIssue());
		advance(300);
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toContain("timer.elapsed");
	});

	it("caps a backlog at one line per subject and counts the rest", () => {
		const { dispatcher, sent, state, advance } = world({ busy: true });
		for (let index = 0; index < MAX_DELIVERY_LINES + 3; index += 1)
			dispatcher.dispatch({
				type: "unsettled",
				subject: {
					kind: "issue",
					item: {
						...ISSUE,
						number: index,
						url: `${ISSUE.url}${String(index)}`,
					},
				},
				facts: [],
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
		expect(dispatcher.dispatch(unsettledIssue()).fate).toBe("dropped");
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
