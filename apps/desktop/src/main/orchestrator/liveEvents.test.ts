import { describe, expect, it } from "vitest";
import type {
	EntryId,
	PendingRequest,
	RequestId,
	TranscriptEntry,
} from "../../model/conversation.js";
import type { OrchestratorEvent } from "./events.js";
import {
	AgentEventSource,
	TURN_SETTLE_MS,
	turnOf,
	WorkspaceEventSource,
	type ConversationReading,
	type LiveAgentReading,
	type LiveWorkspace,
} from "./liveEvents.js";

const PR = {
	repo: "acme/app",
	number: 7,
	title: "fix",
	url: "https://github.com/acme/app/pull/7",
};

describe("the Workspace source", () => {
	function world() {
		const events: OrchestratorEvent[] = [];
		const source = new WorkspaceEventSource((event) => events.push(event));
		return { events, source };
	}
	const login: LiveWorkspace = {
		id: "w1",
		ws: "login-fix",
		root: "/src/login-fix",
		branch: "12-login",
	};

	it("says nothing about its baseline", () => {
		const { events, source } = world();
		source.observe([{ ...login, pullRequest: PR }]);
		expect(events).toEqual([]);
	});

	it("says opened, closed, branch changes and a pull request appearing", () => {
		const { events, source } = world();
		source.observe([login]);
		source.observe([
			{ ...login, branch: "13-other" },
			{ id: "w2", ws: "api", root: "/src/api" },
		]);
		source.observe([
			{
				...login,
				branch: "13-other",
				pullRequest: PR,
				agent: { id: "a1", name: "Claude" },
			},
		]);
		// The same pull request again is not news.
		source.observe([{ ...login, branch: "13-other", pullRequest: PR }]);
		expect(events).toEqual([
			{
				type: "workspace.branch_changed",
				ws: "login-fix",
				from: "12-login",
				to: "13-other",
			},
			{ type: "workspace.opened", ws: "api", path: "/src/api" },
			{
				type: "workspace.pr_linked",
				ws: "login-fix",
				pr: PR,
				agent: { id: "a1", name: "Claude" },
			},
			{ type: "workspace.closed", ws: "api", path: "/src/api" },
		]);
	});

	it("starts a new baseline after a reset", () => {
		const { events, source } = world();
		source.observe([login]);
		source.reset();
		source.observe([]);
		expect(events).toEqual([]);
	});
});

function said(id: string, text: string): TranscriptEntry {
	return {
		kind: "assistant",
		id: id as EntryId,
		parent: null,
		blocks: [{ kind: "text", markdown: text }],
		streaming: false,
	};
}

function told(id: string, text: string): TranscriptEntry {
	return {
		kind: "user",
		id: id as EntryId,
		parent: null,
		text,
		images: [],
		origin: "person",
		rewindable: true,
	};
}

function question(id: string, headers: string[]): PendingRequest {
	return {
		id: id as RequestId,
		entry: undefined,
		subject: {
			kind: "question",
			questions: headers.map((header, index) => ({
				id: String(index),
				header,
				text: `${header}?`,
				options: [],
				multiSelect: false,
				allowsOther: true,
			})),
		},
		choices: [],
	};
}

function permission(id: string, command: string): PendingRequest {
	return {
		id: id as RequestId,
		entry: undefined,
		subject: { kind: "command", command, cwd: "/", reason: undefined },
		choices: [],
	};
}

describe("the Agent source", () => {
	function world() {
		const events: OrchestratorEvent[] = [];
		const conversations = new Map<string, ConversationReading>();
		const source = new AgentEventSource({
			dispatch: (event) => events.push(event),
			conversation: (id) => Promise.resolve(conversations.get(id)),
		});
		return { events, conversations, source };
	}
	const claude: LiveAgentReading = {
		id: "a1",
		name: "API fix",
		ws: "login-fix",
		status: "idle",
		gui: true,
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("says nothing about its baseline, its requests included", async () => {
		const { events, conversations, source } = world();
		conversations.set("a1", {
			entries: () => [],
			requests: () => [question("q1", ["順番"])],
		});
		source.observe([claude, { ...claude, id: "a2", status: "working" }]);
		await settle();
		expect(events).toEqual([]);
	});

	it("says started and exited", () => {
		const { events, source } = world();
		source.observe([]);
		source.observe([{ ...claude, profile: "claude" }]);
		source.observe([]);
		expect(events.map((event) => event.type)).toEqual([
			"agent.started",
			"agent.exited",
		]);
		expect(events[0]).toEqual({
			type: "agent.started",
			agent: { id: "a1", name: "API fix" },
			ws: "login-fix",
			profile: "claude",
		});
	});

	it("says a turn ended, with the cursor of the message that started it and its last words", async () => {
		const { events, conversations, source } = world();
		conversations.set("a1", {
			entries: () => [
				told("e1", "old"),
				said("e2", "old answer"),
				told("e3", "テストを足して"),
				said("e4", "読みます"),
				said("e5", "テストを追加しました。"),
			],
			requests: () => [],
		});
		source.observe([claude]);
		source.observe([{ ...claude, status: "working" }]);
		source.observe([claude]);
		await settle();
		expect(events).toEqual([
			{
				type: "agent.turn_ended",
				agent: { id: "a1", name: "API fix" },
				ws: "login-fix",
				since: "e3",
				excerpt: "テストを追加しました。",
			},
		]);
		// An idle agent that was not seen working ends no turn.
		source.observe([claude]);
		await settle();
		expect(events).toHaveLength(1);
	});

	it("says nothing of a compaction or keep-warm /compact turn, and still ends the real turn after it", async () => {
		const { events, conversations, source } = world();
		conversations.set("a1", {
			entries: () => [told("e3", "テストを足して"), said("e5", "足しました。")],
			requests: () => [],
		});
		const compacting = { ...claude, status: "working", maintenance: true };
		source.observe([claude]);
		source.observe([compacting]);
		source.observe([compacting]);
		source.observe([claude]);
		await settle();
		expect(events).toEqual([]);
		// The person's message, held through the compaction, starts a real
		// turn straight after it: that one ends a turn.
		source.observe([compacting]);
		source.observe([{ ...claude, status: "working" }]);
		source.observe([claude]);
		await settle();
		expect(events.map((event) => event.type)).toEqual(["agent.turn_ended"]);
	});

	describe("waits for background work before it says a turn ended", () => {
		/** A source whose settle timers run when `run()` says. */
		function timed() {
			const events: OrchestratorEvent[] = [];
			const timers: { ms: number; run: () => void; live: boolean }[] = [];
			const source = new AgentEventSource({
				dispatch: (event) => events.push(event),
				conversation: () =>
					Promise.resolve({ entries: () => [], requests: () => [] }),
				setTimer: (ms, run) => {
					const timer = { ms, run, live: true };
					timers.push(timer);
					return { cancel: () => (timer.live = false) };
				},
			});
			const at = (status: string) => source.observe([{ ...claude, status }]);
			const run = async () => {
				for (const timer of timers.splice(0))
					if (timer.live) {
						expect(timer.ms).toBe(TURN_SETTLE_MS);
						timer.run();
					}
				await settle();
			};
			return { events, timers, at, run };
		}

		it("working → background says nothing; the idle after it says it once", async () => {
			const { events, timers, at, run } = timed();
			at("idle");
			at("working");
			at("background");
			await run();
			expect(timers).toHaveLength(0);
			expect(events).toEqual([]);
			at("background");
			await run();
			expect(events).toEqual([]);
			at("idle");
			await run();
			at("idle");
			await run();
			expect(events.map((event) => event.type)).toEqual(["agent.turn_ended"]);
		});

		it("background → working → idle says it once", async () => {
			const { events, at, run } = timed();
			at("idle");
			at("background");
			at("working");
			at("idle");
			await run();
			expect(events.map((event) => event.type)).toEqual(["agent.turn_ended"]);
		});

		it("still waits out the settle: idle that goes back to background or working ends nothing", async () => {
			const { events, timers, at, run } = timed();
			at("idle");
			at("working");
			at("idle");
			at("background");
			await run();
			expect(events).toEqual([]);
			at("idle");
			at("working");
			await run();
			expect(events).toEqual([]);
			at("idle");
			expect(timers.filter((timer) => timer.live)).toHaveLength(1);
			await run();
			expect(events.map((event) => event.type)).toEqual(["agent.turn_ended"]);
		});
	});

	it("says what it asks, and the permission it wants (for the person)", async () => {
		const { events, conversations, source } = world();
		let requests: PendingRequest[] = [];
		conversations.set("a1", { entries: () => [], requests: () => requests });
		source.observe([claude]);
		await settle();
		requests = [question("q7", ["マイグレーションの順番", "ロールバック"])];
		source.observe([{ ...claude, status: "waiting" }]);
		await settle();
		requests = [...requests, permission("p1", "rm -rf build")];
		source.observe([claude]);
		source.observe([{ ...claude, status: "waiting" }]);
		await settle();
		expect(events).toEqual([
			{
				type: "agent.asked",
				agent: { id: "a1", name: "API fix" },
				ws: "login-fix",
				request: "q7",
				headers: ["マイグレーションの順番", "ロールバック"],
			},
			{
				type: "agent.permission_requested",
				agent: { id: "a1", name: "API fix" },
				ws: "login-fix",
				request: "p1",
				what: "rm -rf build",
			},
		]);
	});

	it("says a terminal agent waits for permission from its status", () => {
		const { events, source } = world();
		const tui = { ...claude, gui: false };
		source.observe([tui]);
		source.observe([{ ...tui, status: "waiting", activity: "Allow Bash?" }]);
		expect(events).toEqual([
			{
				type: "agent.permission_requested",
				agent: { id: "a1", name: "API fix" },
				ws: "login-fix",
				what: "Allow Bash?",
			},
		]);
	});

	it("says it failed, with the reason", () => {
		const { events, source } = world();
		source.observe([claude]);
		source.observe([
			{ ...claude, status: "error", failure: "conversation_host_lost" },
		]);
		expect(events).toEqual([
			{
				type: "agent.failed",
				agent: { id: "a1", name: "API fix" },
				ws: "login-fix",
				reason: "conversation_host_lost",
			},
		]);
	});

	it("reads a turn from the last message that started one", () => {
		expect(turnOf([])).toEqual({});
		expect(turnOf([said("e1", "hi")])).toEqual({ excerpt: "hi" });
		expect(turnOf([said("e1", "hi"), told("e2", "go")])).toEqual({
			since: "e2",
		});
	});
});
