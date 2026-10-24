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
	paneWhere,
	callerFromOrigin,
	tellCaller,
	questionAnswer,
	TellService,
	type IssueAssignRequest,
	type TellAgent,
	type TellConversation,
	type TellPorts,
	type TellTerminal,
	type TellEditorPane,
	type TellTerminalPane,
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
	/** Each Agent's terminal session, by Agent id, with its tmux panes. */
	terminals = new Map<string, TellTerminalPane[]>();
	agentTerminal(agentId: string): Promise<TellTerminal> {
		const panes = this.terminals.get(agentId);
		return Promise.resolve({
			agentId,
			workspaceId: "w1",
			session:
				panes === undefined
					? undefined
					: {
							id: agentId,
							name: `tm-${agentId}`,
							open: true,
							visible: true,
							focused: false,
							tmux: {
								tmux: "/opt/homebrew/bin/tmux",
								socket: "/private/tmp/tmux-501/devhub",
								panes,
							},
						},
		});
	}
	openAgentTerminal(
		agentId: string,
		request: Parameters<TellPorts["openAgentTerminal"]>[1],
	) {
		this.calls.push(`open-terminal ${agentId} ${JSON.stringify(request)}`);
		if (this.terminals.has(agentId)) return Promise.resolve({ created: false });
		this.terminals.set(agentId, [pane("%7", 0, 0, 160, 48)]);
		return Promise.resolve({ created: true });
	}
	closeAgentTerminal(agentId: string) {
		this.calls.push(`close-terminal ${agentId}`);
		return Promise.resolve(this.terminals.delete(agentId));
	}
	/** The editor's terminal panes, by Workspace: only ever ws- sessions. */
	editor: TellEditorPane[] = [];
	editorPanes(agentId: string) {
		this.calls.push(`editor-panes ${agentId}`);
		return Promise.resolve(this.editor);
	}
	bringPane(agentId: string, paneId: string, focus: boolean) {
		this.calls.push(`bring ${agentId} ${paneId} ${String(focus)}`);
		const moved = this.editor.find((one) => one.pane === paneId)!;
		this.editor = this.editor.filter((one) => one !== moved);
		const panes = this.terminals.get(agentId);
		this.terminals.set(agentId, [...(panes ?? []), moved]);
		return Promise.resolve({ created: panes === undefined });
	}
}

function pane(
	id: string,
	left: number,
	top: number,
	width: number,
	height: number,
	active = true,
): TellTerminalPane {
	return {
		window: "@1",
		windowIndex: 0,
		windowName: "zsh",
		windowActive: true,
		pane: id,
		paneIndex: Number(id.slice(1)),
		active,
		left,
		top,
		width,
		height,
		cwd: "/src/app",
		command: "zsh",
		title: "host",
		dead: false,
	};
}

function editorPane(
	id: string,
	window: string,
	argv: string | undefined,
): TellEditorPane {
	return {
		...pane(id, 0, 0, 80, 24),
		window,
		session: "ws-0123456789abcdef0123",
		argv,
	};
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

	it("knows a caller by its machine alone when no pane says more", () => {
		expect(tellCaller(undefined, "ssh:box")).toEqual({
			machine: "ssh:box",
			workspaceId: undefined,
			agentId: undefined,
			paneless: true,
		});
		expect(tellCaller("ssh:box\tw1\tnone", "ssh:other")).toEqual(
			callerFromOrigin("ssh:box\tw1\tnone"),
		);
		expect(tellCaller(undefined, undefined)).toBeUndefined();
		expect(tellCaller(undefined, "")).toBeUndefined();
	});

	it("reads a folder as a folder on the caller's machine", async () => {
		const { service, ports } = setup();
		ports.spaces.push(
			workspace({
				id: "w2",
				name: "app-on-box",
				machine: "ssh:box",
				agents: [],
			}),
		);
		const fromBox = await service.run(
			{ verb: "agents", workspace: "/src/app" },
			tellCaller(undefined, "ssh:box"),
		);
		expect(fromBox.message).toBe("No agents are running.");
		const fromHere = await service.run(
			{ verb: "agents", workspace: "/src/app" },
			callerFromOrigin("local\tw1\tnone"),
		);
		expect(fromHere.message).toContain("Claude 1");
		// A caller that cannot say where it is gets every machine's, and
		// a name that is two of them is refused rather than guessed.
		await expect(
			service.run({ verb: "agents", workspace: "/src/app" }, undefined),
		).rejects.toThrow(/names 2 workspaces/);
		await expect(
			service.run(
				{ verb: "agents", workspace: "/src/app" },
				tellCaller(undefined, "ssh:elsewhere"),
			),
		).rejects.toThrow(/no open workspace/);
	});

	it("starts an agent in the asking pane's workspace when none is named", async () => {
		const { service, ports } = setup();
		await service.run(
			{ verb: "agent-new" },
			callerFromOrigin("local\tw1\taaaa1111-0000"),
		);
		expect(ports.calls[0]).toMatch(/^create w1 /);
		await expect(
			service.run({ verb: "agent-new" }, tellCaller(undefined, "ssh:box")),
		).rejects.toThrow(/needs --workspace/);
		await expect(service.run({ verb: "agent-new" }, undefined)).rejects.toThrow(
			/needs --workspace/,
		);
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

describe("the asking agent's own terminal", () => {
	/** The w1 Agent, asking from its own pane. */
	const fromAgent = callerFromOrigin("local\tw1\taaaa1111-0000");
	const AGENT = "aaaa1111-0000";

	it("opens it, and hands back the same tmux handle every time", async () => {
		const { ports, service } = setup();
		const first = await service.run(
			{ verb: "terminal-open", focus: false, command: "npm test" },
			fromAgent,
		);
		const again = await service.run(
			{ verb: "terminal-open", focus: true, command: "npm test" },
			fromAgent,
		);
		expect(ports.calls).toEqual([
			`open-terminal ${AGENT} ${JSON.stringify({ command: "npm test", focus: false })}`,
			`open-terminal ${AGENT} ${JSON.stringify({ command: "npm test", focus: true })}`,
		]);
		const handle = {
			exists: true,
			id: AGENT,
			session: `tm-${AGENT}`,
			tmux: {
				tmux: "/opt/homebrew/bin/tmux",
				socket: "/private/tmp/tmux-501/devhub",
				session: `tm-${AGENT}`,
				target: "%7",
				fullTarget: `tm-${AGENT}:0.7`,
				prefix: [
					"/opt/homebrew/bin/tmux",
					"-S",
					"/private/tmp/tmux-501/devhub",
				],
			},
		};
		expect(first.data).toMatchObject({ created: true, terminal: handle });
		expect(again.data).toMatchObject({ created: false, terminal: handle });
		expect(first.message).toContain("send-keys");
		expect(first.message).toContain("capture-pane -p");
		// Asked again, the command was not typed into a running terminal.
		expect(again.message).toMatch(/--command was not typed/);
	});

	it("reports its status, with every tmux pane and where it is", async () => {
		const { ports, service } = setup();
		const none = await service.run({ verb: "terminal-status" }, fromAgent);
		expect(none.data).toMatchObject({ terminal: { exists: false, panes: [] } });
		expect(none.message).toMatch(/no terminal open/);
		// The person split it: left half, and the right half in two.
		ports.terminals.set(AGENT, [
			pane("%1", 0, 0, 80, 48, false),
			pane("%2", 81, 0, 79, 24, false),
			pane("%3", 81, 25, 79, 23, true),
		]);
		const split = await service.run({ verb: "terminal-status" }, fromAgent);
		const data = split.data as {
			terminal: {
				tmux: { target: string };
				panes: { target: string; where: string }[];
			};
		};
		expect(data.terminal.tmux.target).toBe("%3");
		expect(data.terminal.panes.map((one) => [one.target, one.where])).toEqual([
			["%1", "left"],
			["%2", "top-right"],
			["%3", "bottom-right"],
		]);
		expect(split.message).toContain("bottom-right");
		expect(split.message).toContain("list-panes -s -t");
	});

	it("closes it, and says so when there was none", async () => {
		const { ports, service } = setup();
		ports.terminals.set(AGENT, [pane("%7", 0, 0, 160, 48)]);
		const closed = await service.run({ verb: "terminal-close" }, fromAgent);
		expect(closed.data).toEqual({ closed: true, session: `tm-${AGENT}` });
		const again = await service.run({ verb: "terminal-close" }, fromAgent);
		expect(again.data).toMatchObject({ closed: false });
		expect(ports.calls).toEqual([
			`close-terminal ${AGENT}`,
			`close-terminal ${AGENT}`,
		]);
	});

	it("is only ever the asker's own, and an agent's", async () => {
		const { ports, service } = setup();
		await expect(
			service.run({ verb: "terminal-status" }, undefined),
		).rejects.toThrow(/only from inside/);
		// From a terminal's own shell: there is no agent asking.
		await expect(
			service.run(
				{ verb: "terminal-open", focus: false },
				callerFromOrigin("local\tw1\tnone"),
			),
		).rejects.toThrow(/an agent's/);
		// The Scratch agent's terminal is its own, not w1's agent's.
		await service.run({ verb: "terminal-close" }, coordinator);
		expect(ports.calls).toEqual(["close-terminal bbbb2222-0000"]);
	});
});

describe("bringing an editor terminal's pane to the agent's terminal", () => {
	const fromAgent = callerFromOrigin("local\tw1\taaaa1111-0000");
	const AGENT = "aaaa1111-0000";

	it("lists the panes with what runs in front", async () => {
		const { ports, service } = setup();
		const none = await service.run({ verb: "terminal-panes" }, fromAgent);
		expect(none.message).toMatch(/no DevHub terminal open/);
		ports.editor = [
			editorPane("%2", "@1", "ssh prod"),
			editorPane("%3", "@1", undefined),
		];
		const listed = await service.run({ verb: "terminal-panes" }, fromAgent);
		expect(listed.message).toContain("%2  ws-0123456789abcdef0123:0.2");
		expect(listed.message).toContain("running ssh prod");
		expect(listed.message).toContain("running zsh");
		expect(listed.data).toEqual({ panes: ports.editor });
		expect(ports.calls).toEqual([
			`editor-panes ${AGENT}`,
			`editor-panes ${AGENT}`,
		]);
	});

	it("opens the terminal with it, or adds it to the open one", async () => {
		const { ports, service } = setup();
		ports.editor = [
			editorPane("%2", "@1", "ssh prod"),
			editorPane("%3", "@1", undefined),
			editorPane("%4", "@2", undefined),
		];
		const first = await service.run(
			{ verb: "terminal-bring", pane: "%2", focus: false },
			fromAgent,
		);
		expect(first.data).toMatchObject({ created: true, pane: "%2" });
		expect(first.message).toMatch(/Brought %2 \(ssh prod\) into your new/);
		expect(first.message).not.toMatch(/window closed/);
		const second = await service.run(
			{ verb: "terminal-bring", pane: "%4", focus: true },
			fromAgent,
		);
		expect(second.data).toMatchObject({ created: false });
		expect(second.message).toMatch(/as a split/);
		// %4 was its window's only pane: that editor window is gone.
		expect(second.message).toMatch(/only pane of its editor terminal window/);
		expect(ports.calls).toContain(`bring ${AGENT} %2 false`);
		expect(ports.calls).toContain(`bring ${AGENT} %4 true`);
	});

	it("refuses a pane that is not the editor's, and from outside an agent", async () => {
		const { ports, service } = setup();
		ports.editor = [editorPane("%2", "@1", undefined)];
		await expect(
			service.run(
				{ verb: "terminal-bring", pane: "%9", focus: false },
				fromAgent,
			),
		).rejects.toThrow(/not a pane of your workspace's editor terminals/);
		await expect(
			service.run(
				{ verb: "terminal-bring", pane: "%2", focus: false },
				callerFromOrigin("local\tw1\tnone"),
			),
		).rejects.toThrow(/an agent's/);
		expect(ports.calls.filter((call) => call.startsWith("bring"))).toEqual([]);
	});
});

describe("where a tmux pane is in its window", () => {
	it("names corners, sides, the middle and the whole", () => {
		const whole = pane("%1", 0, 0, 100, 40);
		expect(paneWhere(whole, [whole])).toBe("whole");
		const grid = [
			pane("%1", 0, 0, 33, 20),
			pane("%2", 34, 0, 33, 20),
			pane("%3", 68, 0, 32, 20),
			pane("%4", 0, 21, 100, 19),
		];
		expect(grid.map((one) => paneWhere(one, grid))).toEqual([
			"top-left",
			"top-middle",
			"top-right",
			"bottom",
		]);
	});
});
