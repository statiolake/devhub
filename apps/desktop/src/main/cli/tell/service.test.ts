import { describe, expect, it } from "vitest";
import type {
	EntryId,
	PendingRequest,
	RequestAnswer,
	RequestId,
	TranscriptEntry,
} from "../../../model/conversation.js";
import {
	answeredBy,
	callerFromOrigin,
	questionAnswer,
	TellService,
	type IssueAssignRequest,
	type TellAgent,
	type TellConversation,
	type TellPorts,
	type TellWorkspace,
} from "./service.js";

function agent(overrides: Partial<TellAgent> = {}): TellAgent {
	return {
		id: "aaaa1111-0000",
		name: "Claude 1",
		workspaceId: "w1",
		profileId: "claude",
		kind: "claude",
		presentation: "gui",
		status: "working",
		unread: undefined,
		activity: undefined,
		...overrides,
	};
}

function workspace(overrides: Partial<TellWorkspace> = {}): TellWorkspace {
	return {
		id: "w1",
		name: "app",
		root: "/src/app",
		machine: "local",
		scratch: false,
		selected: true,
		branch: "12-fix",
		worktreeOf: undefined,
		repositoryUrl: undefined,
		issue: undefined,
		container: undefined,
		agents: [agent()],
		...overrides,
	};
}

const question: PendingRequest = {
	id: "req-1" as RequestId,
	entry: undefined,
	subject: {
		kind: "question",
		questions: [
			{
				id: "Which database?",
				header: "Database",
				text: "Which database?",
				options: [
					{ label: "Postgres", description: "", preview: undefined },
					{ label: "SQLite", description: "small", preview: undefined },
				],
				multiSelect: false,
				allowsOther: true,
			},
		],
	},
	choices: [],
};

const permission: PendingRequest = {
	id: "req-2" as RequestId,
	entry: undefined,
	subject: {
		kind: "tool",
		tool: "Bash",
		title: "rm -rf build",
		input: {},
		reason: undefined,
	},
	choices: [{ id: "allow", label: "Allow", tone: "allow", takesText: false }],
};

class FakeConversation implements TellConversation {
	submitted: string[] = [];
	answered: { request: string; answer: RequestAnswer }[] = [];
	interrupted = 0;
	pending: PendingRequest[] = [question, permission];
	state = "running";
	log: TranscriptEntry[] = [
		{
			kind: "user",
			id: "e1" as EntryId,
			parent: null,
			text: "do it",
			images: [],
			origin: "person",
			rewindable: true,
		},
		{
			kind: "assistant",
			id: "e2" as EntryId,
			parent: null,
			blocks: [{ kind: "text", markdown: "On it." }],
			streaming: false,
		},
		{
			kind: "turn-end",
			id: "e3" as EntryId,
			outcome: "completed",
			detail: undefined,
			usage: undefined,
			durationMs: undefined,
			limit: undefined,
		},
	];
	entries() {
		return this.log;
	}
	requests() {
		return this.pending;
	}
	turn() {
		return this.state;
	}
	submit(text: string) {
		this.submitted.push(text);
		return Promise.resolve();
	}
	interrupt() {
		this.interrupted += 1;
		return Promise.resolve();
	}
	answer(request: string, answer: RequestAnswer) {
		this.answered.push({ request, answer });
		return Promise.resolve();
	}
}

class FakePorts implements TellPorts {
	calls: string[] = [];
	queued: [string, string][] = [];
	conversations = new Map<string, FakeConversation>();
	spaces: TellWorkspace[] = [
		workspace(),
		workspace({
			id: "scratch-id",
			name: "Scratch",
			root: "/scratch/today",
			scratch: true,
			selected: false,
			branch: undefined,
			agents: [
				agent({
					id: "bbbb2222-0000",
					name: "Coordinator",
					workspaceId: "scratch-id",
				}),
				agent({
					id: "cccc3333-0000",
					name: "Shell",
					workspaceId: "scratch-id",
					kind: "shell",
					presentation: "tui",
					status: "idle",
				}),
			],
		}),
	];
	constructor() {
		this.conversations.set("aaaa1111-0000", new FakeConversation());
	}
	workspaces() {
		return this.spaces;
	}
	profiles() {
		return [
			{ id: "claude", kind: "claude" },
			{ id: "codex", kind: "codex" },
		];
	}
	openWorkspace(path: string, machine: string, worktree?: string) {
		this.calls.push(`open ${path} ${machine} ${worktree ?? "-"}`);
		return Promise.resolve("w1");
	}
	createAgent(workspaceId: string, profileId: string, presentation?: string) {
		this.calls.push(
			`create ${workspaceId} ${profileId} ${presentation ?? "-"}`,
		);
		return Promise.resolve("new-agent");
	}
	renameAgent(agentId: string, name: string) {
		this.calls.push(`rename ${agentId} ${name}`);
		return Promise.resolve();
	}
	queueText(agentId: string, text: string) {
		this.queued.push([agentId, text]);
	}
	assignIssue(request: IssueAssignRequest) {
		this.calls.push(`assign ${JSON.stringify(request)}`);
		return Promise.resolve({
			workspaceId: "w1",
			agentId: request.editorOnly ? undefined : "issue-agent",
		});
	}
	conversation(agentId: string) {
		return Promise.resolve(this.conversations.get(agentId));
	}
	commands() {
		return [
			{
				id: "next_agent",
				label: "Next agent",
				category: "Navigate",
				available: true,
			},
		];
	}
	runCommand(id: string) {
		this.calls.push(`run ${id}`);
		return true;
	}
	focusWorkspace(id: string) {
		this.calls.push(`focus-workspace ${id}`);
		return Promise.resolve();
	}
	focusAgent(id: string) {
		this.calls.push(`focus-agent ${id}`);
		return Promise.resolve();
	}
	notify(text: string) {
		this.calls.push(`notify ${text}`);
	}
}

const coordinator = callerFromOrigin("local\tscratch\tbbbb2222-0000");

function setup() {
	const ports = new FakePorts();
	let now = 0;
	const service = new TellService(ports, {
		now: () => now,
		sleep: (ms) => {
			now += ms;
			return Promise.resolve();
		},
	});
	return {
		ports,
		service,
		conversation: ports.conversations.get("aaaa1111-0000")!,
	};
}

describe("devhub --tell, in the app", () => {
	it("reads the caller out of DEVHUB_ORIGIN", () => {
		expect(coordinator).toEqual({
			machine: "local",
			workspaceId: undefined,
			agentId: "bbbb2222-0000",
		});
		expect(callerFromOrigin("ssh:box\tw1\tnone")).toEqual({
			machine: "ssh:box",
			workspaceId: "w1",
			agentId: undefined,
		});
		expect(callerFromOrigin(undefined)).toBeUndefined();
		expect(callerFromOrigin("garbage")).toBeUndefined();
	});

	it("lists workspaces as text and as data", async () => {
		const { service } = setup();
		const answer = await service.run({ verb: "workspaces" }, undefined);
		expect(answer.message).toContain(
			"* w1  app  /src/app  (branch 12-fix, 1 agent)",
		);
		expect(answer.message).toContain("Scratch");
		expect(answer.data).toMatchObject({
			workspaces: [{ id: "w1", agents: ["aaaa1111-0000"] }, { scratch: true }],
		});
	});

	it("lists agents with their open requests, and filters by workspace", async () => {
		const { service } = setup();
		const all = await service.run({ verb: "agents" }, undefined);
		expect(all.message).toContain(
			"aaaa1111-0000  Claude 1  claude/gui  working  2 request(s)  in app",
		);
		expect(all.message).toContain("Shell  shell/tui  idle");
		const scratch = await service.run(
			{ verb: "agents", workspace: "scratch" },
			undefined,
		);
		expect(scratch.message).not.toContain("Claude 1");
		await expect(
			service.run({ verb: "agents", workspace: "nope" }, undefined),
		).rejects.toThrow(/no open workspace/);
	});

	it("opens a workspace on the caller's machine", async () => {
		const { service, ports } = setup();
		const answer = await service.run(
			{ verb: "workspace-open", path: "/src/app", worktree: "12-fix" },
			callerFromOrigin("ssh:box\tw1\tnone"),
		);
		expect(ports.calls).toEqual(["open /src/app ssh:box 12-fix"]);
		expect(answer.data).toEqual({ workspaceId: "w1", root: "/src/app" });
	});

	it("starts an agent, names it and queues its prompt", async () => {
		const { service, ports } = setup();
		const answer = await service.run(
			{
				verb: "agent-new",
				workspace: "/src/app/",
				profile: "codex",
				name: "API",
				prompt: "fix the API",
				presentation: "gui",
			},
			coordinator,
		);
		expect(ports.calls).toEqual([
			"create w1 codex gui",
			"rename new-agent API",
		]);
		expect(ports.queued).toEqual([["new-agent", "fix the API"]]);
		expect(answer.data).toEqual({
			agentId: "new-agent",
			workspaceId: "w1",
			profile: "codex",
		});
	});

	it("uses the first profile, and refuses one that is not configured", async () => {
		const { service, ports } = setup();
		await service.run({ verb: "agent-new", workspace: "w1" }, undefined);
		expect(ports.calls).toEqual(["create w1 claude -"]);
		await expect(
			service.run(
				{ verb: "agent-new", workspace: "w1", profile: "gpt" },
				undefined,
			),
		).rejects.toThrow(/Configured profiles: claude, codex/);
	});

	it("hands an Issue on with the branch it was given, and the extra prompt", async () => {
		const { service, ports } = setup();
		const answer = await service.run(
			{
				verb: "issue-assign",
				url: "https://github.com/o/r/issues/123",
				branch: "123-fix-login-timeout",
				place: "worktree",
				editorOnly: false,
				prompt: "only the backend",
			},
			coordinator,
		);
		expect(ports.calls[0]).toContain('"branch":"123-fix-login-timeout"');
		expect(ports.calls[0]).toContain('"profile":"claude"');
		expect(ports.queued).toEqual([["issue-agent", "only the backend"]]);
		expect(answer.message).toContain("Agent issue-agent is taking");
	});

	it("resolves an agent by id prefix or name, and says when it cannot", async () => {
		const { service, conversation } = setup();
		await service.run(
			{ verb: "agent-send", agent: "aaaa", text: "hi" },
			undefined,
		);
		await service.run(
			{ verb: "agent-send", agent: "Claude 1", text: "again" },
			undefined,
		);
		expect(conversation.submitted).toEqual(["hi", "again"]);
		await expect(
			service.run({ verb: "agent-send", agent: "zzzz", text: "x" }, undefined),
		).rejects.toThrow(/no agent is called/);
	});

	it("queues text for a terminal agent, and refuses to read one", async () => {
		const { service, ports } = setup();
		const answer = await service.run(
			{ verb: "agent-send", agent: "Shell", text: "ls" },
			undefined,
		);
		expect(ports.queued).toEqual([["cccc3333-0000", "ls"]]);
		expect(answer.message).toContain("Queued");
		await expect(
			service.run({ verb: "agent-read", agent: "Shell" }, undefined),
		).rejects.toThrow(/terminal agent/);
	});

	it("reads a transcript tail and goes on from its cursor", async () => {
		const { service, conversation } = setup();
		const first = await service.run(
			{ verb: "agent-read", agent: "aaaa1111-0000", last: 2 },
			undefined,
		);
		expect(first.message).toBe(
			"On it.\n-- turn completed --\n-- Claude 1: working, turn running, 2 open request(s); cursor e3",
		);
		conversation.log = [
			...conversation.log,
			{
				kind: "tool",
				id: "e4" as EntryId,
				parent: null,
				tool: "Bash",
				title: "npm test",
				input: {},
				status: "succeeded",
				output: undefined,
				spawns: undefined,
				background: undefined,
				outsideSandbox: false,
				plan: undefined,
				change: undefined,
				asked: undefined,
				denial: undefined,
			},
		];
		const next = await service.run(
			{ verb: "agent-read", agent: "aaaa1111-0000", since: "e3" },
			undefined,
		);
		expect(next.message.split("\n")[0]).toBe("[Bash] npm test (succeeded)");
		expect(next.data).toMatchObject({ cursor: "e4", entries: [{ id: "e4" }] });
	});

	it("interrupts", async () => {
		const { service, conversation } = setup();
		await service.run({ verb: "agent-interrupt", agent: "aaaa" }, undefined);
		expect(conversation.interrupted).toBe(1);
	});

	it("lists requests, marking permission prompts as DevHub's to answer", async () => {
		const { service } = setup();
		const answer = await service.run(
			{ verb: "agent-requests", agent: "aaaa" },
			undefined,
		);
		expect(answer.message).toContain("req-1  question");
		expect(answer.message).toContain("1. Postgres");
		expect(answer.message).toContain("2. SQLite — small");
		expect(answer.message).toContain(
			"req-2  a permission prompt: Bash: rm -rf build",
		);
		expect(answer.message).toContain("(answer in DevHub)");
		expect(answer.data).toMatchObject({
			requests: [
				{ id: "req-1", answerable: true },
				{ id: "req-2", answerable: false },
			],
		});
	});

	it("answers a question, crediting the agent that answered", async () => {
		const { service, conversation } = setup();
		await service.run(
			{ verb: "agent-answer", agent: "aaaa", request: "req-1", options: [2] },
			coordinator,
		);
		expect(conversation.answered).toEqual([
			{
				request: "req-1",
				answer: {
					kind: "answers",
					values: { "Which database?": "SQLite" },
					notes: {
						"Which database?":
							"answered via devhub CLI by Coordinator (bbbb2222-0000)",
					},
				},
			},
		]);
	});

	it("never answers a permission prompt", async () => {
		const { service, conversation } = setup();
		await expect(
			service.run(
				{ verb: "agent-answer", agent: "aaaa", request: "req-2", options: [1] },
				coordinator,
			),
		).rejects.toThrow(/permission prompt.*only questions/);
		expect(conversation.answered).toEqual([]);
	});

	it("refuses an agent answering its own question, and a request that is not open", async () => {
		const { service } = setup();
		await expect(
			service.run(
				{ verb: "agent-answer", agent: "aaaa", request: "req-1", options: [1] },
				callerFromOrigin("local\tw1\taaaa1111-0000"),
			),
		).rejects.toThrow(/its own question/);
		await expect(
			service.run(
				{ verb: "agent-answer", agent: "aaaa", request: "gone", options: [1] },
				coordinator,
			),
		).rejects.toThrow(/no open request/);
	});

	it("waits until the agent is waiting, or gives up at the timeout", async () => {
		const { service, ports, conversation } = setup();
		// It has open requests: waiting already.
		const now = await service.run(
			{
				verb: "agent-wait",
				agent: "aaaa",
				until: "waiting",
				timeoutSeconds: 5,
			},
			undefined,
		);
		expect(now.data).toMatchObject({ reached: true, requests: 2 });

		conversation.pending = [];
		const late = await service.run(
			{ verb: "agent-wait", agent: "aaaa", until: "idle", timeoutSeconds: 2 },
			undefined,
		);
		expect(late.data).toMatchObject({ reached: false, status: "working" });
		expect(late.message).toContain("still, after 2s");

		let polls = 0;
		const original = ports.workspaces.bind(ports);
		ports.workspaces = () => {
			polls += 1;
			const spaces = original();
			if (polls < 3) return spaces;
			return spaces.map((each) =>
				each.id === "w1"
					? { ...each, agents: [agent({ status: "idle" })] }
					: each,
			);
		};
		const done = await service.run(
			{ verb: "agent-wait", agent: "aaaa", until: "any", timeoutSeconds: 60 },
			undefined,
		);
		expect(done.data).toMatchObject({ reached: true, status: "idle" });
	});

	it("lists and runs palette commands, refusing unknown ones", async () => {
		const { service, ports } = setup();
		expect(
			(await service.run({ verb: "commands" }, undefined)).message,
		).toContain("next_agent  Navigate: Next agent");
		await service.run({ verb: "run", command: "next_agent" }, undefined);
		expect(ports.calls).toEqual(["run next_agent"]);
		await expect(
			service.run({ verb: "run", command: "format_disk" }, undefined),
		).rejects.toThrow(/no command/);
	});

	it("focuses an agent or a workspace, and notifies", async () => {
		const { service, ports } = setup();
		await service.run({ verb: "focus", target: "Coordinator" }, undefined);
		await service.run({ verb: "focus", target: "scratch" }, undefined);
		await service.run({ verb: "notify", text: "done" }, undefined);
		expect(ports.calls).toEqual([
			"focus-agent bbbb2222-0000",
			"focus-workspace scratch-id",
			"notify done",
		]);
	});
});

describe("an answer from option numbers", () => {
	const questions =
		question.subject.kind === "question" ? question.subject.questions : [];

	it("takes words where the question allows its own answer", () => {
		expect(questionAnswer(questions, [], "MySQL", "n")).toMatchObject({
			values: { "Which database?": "MySQL" },
		});
	});

	it("refuses an answer it cannot give", () => {
		expect(() => questionAnswer(questions, [3], undefined, "n")).toThrow(
			/2 options/,
		);
		expect(() => questionAnswer(questions, [1, 2], undefined, "n")).toThrow(
			/one answer/,
		);
		expect(() => questionAnswer(questions, [], undefined, "n")).toThrow(
			/no answer/,
		);
	});

	it("numbers the options of several questions in order", () => {
		const two = [
			questions[0]!,
			{ ...questions[0]!, id: "Q2", header: "Q2", multiSelect: true },
		];
		expect(questionAnswer(two, [1, 3, 4], undefined, "n")).toMatchObject({
			values: { "Which database?": "Postgres", Q2: ["Postgres", "SQLite"] },
		});
	});

	it("says who answered when nobody can be named", () => {
		expect(answeredBy(undefined, [])).toBe(
			"answered via devhub CLI by a terminal outside any agent",
		);
	});
});
