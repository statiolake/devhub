import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR_EVENTS } from "../../model/orchestratorSettings.js";
import {
	EventDispatcher,
	MAX_DELIVERY_LINES,
	eventLine,
	eventsMessage,
	shortId,
	workspaceToken,
	type OrchestratorEvent,
} from "./events.js";

const AGENT = { id: "a1b2c3d4-0000-4000-8000-000000000000", name: "API fix" };
const ORCH = "0rc4e57r-0000";
const PR = {
	repo: "acme/app",
	number: 130,
	title: "ログイン修正",
	url: "https://github.com/acme/app/pull/130",
};

function world(
	options: {
		events?: readonly string[];
		event_prompt?: string;
		init_prompt?: string;
		busy?: boolean;
	} = {},
) {
	const sent: string[] = [];
	const state = { busy: options.busy ?? false, now: 1_000_000 };
	const timers: (() => void)[] = [];
	const dispatcher = new EventDispatcher({
		orchestrator: () => ORCH,
		settings: () => ({
			event_prompt: options.event_prompt ?? "handle: {EVENT}",
			init_prompt: options.init_prompt,
			events: options.events ?? DEFAULT_ORCHESTRATOR_EVENTS,
		}),
		deliver: (_agent, text) => {
			sent.push(text);
		},
		busy: () => state.busy,
		now: () => state.now,
		setTimer: (_ms, run) => {
			timers.push(run);
			return { cancel: () => undefined };
		},
	});
	const tick = () => {
		for (const run of timers.splice(0)) run();
	};
	return { dispatcher, sent, state, tick };
}

describe("an event's line", () => {
	const now = 10 * 60_000;
	const cases: [OrchestratorEvent, string][] = [
		[
			{
				type: "github.review_comment",
				pr: PR,
				count: 2,
				authors: ["alice"],
				ws: "login-fix",
				agent: { id: AGENT.id },
			},
			"[github.review_comment] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 — alice から新規2件 https://github.com/acme/app/pull/130",
		],
		[
			{
				type: "github.lane_changed",
				kind: "issue",
				item: { repo: "acme/app", number: 123, title: "API整理" },
				project: "acme/7",
				from: "In Progress",
				to: "In Review",
				ws: "api-refactor",
			},
			"[github.lane_changed] #123「API整理」 In Progress → In Review ws=api-refactor",
		],
		[
			{
				type: "agent.turn_ended",
				agent: AGENT,
				ws: "login-fix",
				since: "e39",
				excerpt: "テストを追加しました。残りは…",
			},
			"[agent.turn_ended] agent=a1b2c3d4 (API fix) ws=login-fix since=e39 — 「テストを追加しました。残りは…」",
		],
		[
			{
				type: "agent.asked",
				agent: { id: "c3d4" },
				request: "q7",
				headers: ["マイグレーションの順番", "ロールバック"],
			},
			"[agent.asked] agent=c3d4 req=q7 — 「マイグレーションの順番」ほか1問",
		],
		[
			{
				type: "escalation_answered",
				escalationId: 12,
				title: "本番DBマイグレーション承認",
				agents: [],
			},
			"[escalation_answered] esc=12「本番DBマイグレーション承認」 — 人が回答しました (escalation show で読む)",
		],
		[
			{
				type: "unaccounted",
				agent: { id: "e5f6", name: "調査" },
				idleSince: now - 12 * 60_000,
			},
			"[unaccounted] agent=e5f6 (調査) idle 12m",
		],
		[
			{ type: "timer.elapsed", name: "tick", interval: "5m" },
			"[timer.elapsed] tick",
		],
		[
			{
				type: "agent.permission_requested",
				agent: { id: "e5f6" },
				what: "rm -rf build",
			},
			"[agent.permission_requested] agent=e5f6 — 権限確認「rm -rf build」 (FYI: 承認できるのは人だけ)",
		],
		[
			{ type: "custom.deploy", text: "staging に deploy 完了" },
			"[custom.deploy] — staging に deploy 完了",
		],
	];
	for (const [event, line] of cases)
		it(`words ${event.type}`, () => {
			expect(eventLine(event, now)).toBe(line);
		});

	it("cuts a long excerpt and keeps one line", () => {
		const line = eventLine(
			{ type: "agent.turn_ended", agent: AGENT, excerpt: "あ\n".repeat(400) },
			0,
		);
		expect(line).not.toContain("\n");
		expect(line.length).toBeLessThan(220);
	});

	it("names ids the way --tell takes them", () => {
		expect(shortId("a1b2c3d4-0000-4000-8000-000000000000")).toBe("a1b2c3d4");
		expect(shortId("scratch")).toBe("scratch");
		expect(workspaceToken("login-fix", "w1")).toBe("login-fix");
		expect(workspaceToken("my repo", "w1")).toBe("w1");
	});
});

describe("the message", () => {
	const events: OrchestratorEvent[] = [
		{ type: "timer.elapsed", name: "tick", interval: "5m" },
		{ type: "custom.x", text: "y" },
	];
	const prompts = { event_prompt: "/go {EVENT}", init_prompt: undefined };

	it("carries every event, one line each, in {EVENT}", () => {
		expect(eventsMessage(events, prompts, 0)).toBe(
			"/go [timer.elapsed] tick\n[custom.x] — y",
		);
	});

	it("renders {EVENT_JSON} only when the template has it", () => {
		const json = eventsMessage(
			events,
			{ event_prompt: "/go {EVENT_JSON}", init_prompt: undefined },
			0,
		);
		expect(JSON.parse(json.slice("/go ".length))).toEqual([
			{ type: "timer.elapsed", name: "tick", interval: "5m" },
			{ type: "custom.x", text: "y" },
		]);
		const stringify = JSON.stringify;
		let calls = 0;
		JSON.stringify = ((...args: Parameters<typeof stringify>) => {
			calls += 1;
			return stringify(...args);
		}) as typeof JSON.stringify;
		try {
			eventsMessage(events, prompts, 0);
		} finally {
			JSON.stringify = stringify;
		}
		expect(calls).toBe(0);
	});

	it("uses init_prompt for a batch with init in it", () => {
		expect(
			eventsMessage(
				[{ type: "init" }],
				{ event_prompt: "/go {EVENT}", init_prompt: "/start {EVENT}" },
				0,
			),
		).toMatch(/^\/start \[init\]/u);
	});
});

describe("the dispatcher", () => {
	it("delivers what came while the orchestrator was busy as one message", () => {
		const { dispatcher, sent, state, tick } = world({ busy: true });
		dispatcher.dispatch({ type: "custom.a", text: "1" });
		dispatcher.dispatch({ type: "custom.b", text: "2" });
		tick();
		expect(sent).toEqual([]);
		expect(dispatcher.held()).toHaveLength(2);
		state.busy = false;
		dispatcher.flush();
		expect(sent).toEqual(["handle: [custom.a] — 1\n[custom.b] — 2"]);
		expect(dispatcher.held()).toEqual([]);
	});

	it("batches what arrives within the window", () => {
		const { dispatcher, sent, tick } = world();
		dispatcher.dispatch({ type: "custom.a", text: "1" });
		dispatcher.dispatch({ type: "custom.b", text: "2" });
		expect(sent).toEqual([]);
		tick();
		expect(sent).toHaveLength(1);
	});

	it("waits for the last message to be taken before the next", () => {
		const { dispatcher, sent, state, tick } = world();
		dispatcher.dispatch({ type: "custom.a", text: "1" });
		tick();
		dispatcher.dispatch({ type: "custom.b", text: "2" });
		tick();
		// Not seen busy since: held, for a while.
		expect(sent).toHaveLength(1);
		state.busy = true;
		dispatcher.flush();
		state.busy = false;
		dispatcher.flush();
		expect(sent).toHaveLength(2);
		// Or once the wait is over.
		dispatcher.dispatch({ type: "custom.c", text: "3" });
		tick();
		expect(sent).toHaveLength(2);
		state.now += 61_000;
		tick();
		expect(sent).toHaveLength(3);
	});

	it("holds everything while paused, and resume sends it as one", async () => {
		const { dispatcher, sent, tick } = world();
		dispatcher.pause();
		dispatcher.dispatch({ type: "custom.a", text: "1" });
		dispatcher.dispatch({ type: "custom.b", text: "2" });
		tick();
		expect(sent).toEqual([]);
		expect(await dispatcher.resume()).toBe(2);
		expect(sent).toEqual(["handle: [custom.a] — 1\n[custom.b] — 2"]);
	});

	it("folds review comments on one pull request into one line with a count", () => {
		const { dispatcher } = world({ busy: true });
		const comment = (author: string, count: number): OrchestratorEvent => ({
			type: "github.review_comment",
			pr: PR,
			count,
			authors: [author],
		});
		dispatcher.dispatch(comment("alice", 2));
		dispatcher.dispatch({
			type: "github.review_comment",
			pr: { ...PR, number: 131 },
			count: 1,
			authors: ["carol"],
		});
		dispatcher.dispatch(comment("bob", 1));
		expect(dispatcher.held()).toHaveLength(2);
		// In the first one's place in line.
		expect(dispatcher.held()[0]).toMatchObject({
			count: 3,
			authors: ["alice", "bob"],
		});
		expect(dispatcher.recent(10).map((entry) => entry.fate)).toEqual([
			"coalesced",
			"pending",
			"pending",
		]);
	});

	it("keeps an agent's latest turn, read from the first unread one", () => {
		const { dispatcher } = world({ busy: true });
		dispatcher.dispatch({
			type: "agent.turn_ended",
			agent: AGENT,
			since: "e1",
			excerpt: "first",
		});
		dispatcher.dispatch({
			type: "agent.turn_ended",
			agent: AGENT,
			since: "e5",
			excerpt: "second",
		});
		expect(dispatcher.held()).toEqual([
			{
				type: "agent.turn_ended",
				agent: AGENT,
				since: "e1",
				excerpt: "second",
			},
		]);
	});

	it("keeps one pending event per timer", () => {
		const { dispatcher } = world({ busy: true });
		for (let index = 0; index < 3; index += 1)
			dispatcher.dispatch({
				type: "timer.elapsed",
				name: "tick",
				interval: "1m",
			});
		dispatcher.dispatch({
			type: "timer.elapsed",
			name: "sweep",
			interval: "1h",
		});
		expect(
			dispatcher.held().map((event) => "name" in event && event.name),
		).toEqual(["tick", "sweep"]);
	});

	it("applies the events filter, by default leaving the chatter out", () => {
		const { dispatcher } = world({ busy: true });
		for (const type of [
			"agent.started",
			"workspace.opened",
			"agent.permission_requested",
		] as const) {
			const entry = dispatcher.dispatch(
				type === "workspace.opened"
					? { type, ws: "w", path: "/w" }
					: { type, agent: { id: "x" } },
			);
			expect(entry.fate).toBe("filtered");
		}
		expect(
			dispatcher.dispatch({ type: "agent.exited", agent: { id: "x" } }).fate,
		).toBe("pending");
		const narrow = world({
			busy: true,
			events: ["github.*", "!github.checks"],
		});
		expect(
			narrow.dispatcher.dispatch({
				type: "github.checks",
				pr: PR,
				result: "passed",
			}).fate,
		).toBe("filtered");
		expect(
			narrow.dispatcher.dispatch({ type: "github.pr_merged", pr: PR }).fate,
		).toBe("pending");
		// init always goes.
		expect(narrow.dispatcher.dispatch({ type: "init" }).fate).toBe("pending");
	});

	it("never tells the orchestrator about itself", () => {
		const { dispatcher } = world({ busy: true, events: ["*"] });
		for (const type of [
			"agent.turn_ended",
			"agent.started",
			"agent.exited",
		] as const)
			expect(dispatcher.dispatch({ type, agent: { id: ORCH } }).fate).toBe(
				"self",
			);
		expect(dispatcher.held()).toEqual([]);
	});

	it("drops events with nobody to tell", () => {
		const dispatcher = new EventDispatcher({
			orchestrator: () => undefined,
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: ["*"],
			}),
			deliver: () => {
				throw new Error("nobody to deliver to");
			},
		});
		expect(dispatcher.dispatch({ type: "custom.x", text: "y" }).fate).toBe(
			"dropped",
		);
	});
});

describe("one line per subject", () => {
	const lane = (from: string, to: string): OrchestratorEvent => ({
		type: "github.lane_changed",
		item: PR,
		kind: "pr",
		project: "acme/7",
		from,
		to,
	});

	it("says a pull request's news on one line, the latest leading it", () => {
		const { dispatcher, sent, state } = world({ busy: true });
		dispatcher.dispatch({ type: "github.pr_ready", pr: PR });
		dispatcher.dispatch({ type: "github.checks", pr: PR, result: "failed" });
		dispatcher.dispatch({ type: "github.pr_approved", pr: PR, by: ["bob"] });
		dispatcher.dispatch({ type: "github.checks", pr: PR, result: "passed" });
		expect(dispatcher.heldLines()).toEqual([
			{
				event: { type: "github.checks", pr: PR, result: "passed" },
				also: [
					{ type: "github.pr_ready", pr: PR },
					{ type: "github.pr_approved", pr: PR, by: ["bob"] },
				],
			},
		]);
		state.busy = false;
		dispatcher.flush();
		expect(sent).toEqual([
			"handle: [github.checks] PR #130「ログイン修正」 — CI 成功 ／ [github.pr_ready] ready for review になった ／ [github.pr_approved] bob が承認 https://github.com/acme/app/pull/130",
		]);
	});

	it("folds a lane into first from → last to, and drops it when that is no move", () => {
		const { dispatcher } = world({ busy: true });
		dispatcher.dispatch(lane("Todo", "In Progress"));
		dispatcher.dispatch(lane("In Progress", "In Review"));
		expect(dispatcher.held()).toEqual([lane("Todo", "In Review")]);
		dispatcher.dispatch(lane("In Review", "Todo"));
		expect(dispatcher.held()).toEqual([]);
		expect(dispatcher.recent(3).map((entry) => entry.fate)).toEqual([
			"coalesced",
			"coalesced",
			"dropped-stale",
		]);
	});

	it("lets a merge replace whatever else was pending about the pull request", () => {
		const { dispatcher } = world({ busy: true });
		dispatcher.dispatch({
			type: "github.review_comment",
			pr: PR,
			count: 2,
			authors: ["alice"],
		});
		dispatcher.dispatch({ type: "github.checks", pr: PR, result: "failed" });
		dispatcher.dispatch({ type: "github.pr_merged", pr: PR });
		expect(dispatcher.heldLines()).toEqual([
			{ event: { type: "github.pr_merged", pr: PR }, also: [] },
		]);
	});

	it("drops what no longer needs attention when it would go", () => {
		const stale = new Set<string>();
		const sent: string[] = [];
		const state = { busy: true };
		const dispatcher = new EventDispatcher({
			orchestrator: () => ORCH,
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: ["*"],
			}),
			deliver: (_agent, text) => sent.push(text),
			busy: () => state.busy,
			relevant: (event) => !stale.has(event.type),
		});
		dispatcher.dispatch({
			type: "agent.turn_ended",
			agent: AGENT,
			since: "e1",
		});
		dispatcher.dispatch({ type: "custom.x", text: "still" });
		stale.add("agent.turn_ended");
		state.busy = false;
		dispatcher.flush();
		expect(sent).toEqual(["[custom.x] — still"]);
		expect(dispatcher.recent(2)[0]).toMatchObject({
			fate: "dropped-stale",
			reason: "no longer needs attention",
		});
	});

	it("never says the same thing again while its subject is unchanged", () => {
		const { dispatcher, sent, state } = world({ events: ["*"] });
		const idle: OrchestratorEvent = {
			type: "unaccounted",
			agent: AGENT,
			idleSince: 5,
		};
		dispatcher.flush();
		dispatcher.dispatch(idle);
		dispatcher.flush();
		expect(sent).toHaveLength(1);
		expect(dispatcher.dispatch(idle).fate).toBe("repeat");
		// Something new about it, and the same statement is news again.
		state.busy = true;
		dispatcher.dispatch({ type: "agent.turn_ended", agent: AGENT });
		expect(dispatcher.dispatch(idle).fate).toBe("pending");
	});

	it("caps a backlog at one line per subject and counts the rest", () => {
		const { dispatcher, sent, state } = world({ busy: true });
		for (let round = 0; round < 3; round += 1)
			for (let index = 0; index < MAX_DELIVERY_LINES + 7; index += 1)
				dispatcher.dispatch({
					type: "timer.elapsed",
					name: `t${String(index)}`,
					interval: "1m",
				});
		expect(dispatcher.held()).toHaveLength(MAX_DELIVERY_LINES + 7);
		state.busy = false;
		dispatcher.flush();
		const lines = sent[0]!.replace(/^handle: /u, "").split("\n");
		expect(lines).toHaveLength(MAX_DELIVERY_LINES + 1);
		expect(lines.at(-1)).toBe(
			"…ほか 7 件 (devhub --tell orchestrator events で確認)",
		);
		expect(dispatcher.recent(1)[0]?.fate).toBe("overflow");
	});
});
