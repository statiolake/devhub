import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../../model/commands.js";
import { parseControlRequest } from "../protocol.js";
import { parseTellArguments } from "./command.js";
import type {
	EntryId,
	PendingRequest,
	Question,
	RequestAnswer,
	RequestId,
	TranscriptEntry,
	Usage,
} from "../../../model/conversation.js";
import {
	answeredBy,
	callerKey,
	paneWhere,
	callerFromOrigin,
	tellCaller,
	questionAnswer,
	TellService,
	type IssueAssignRequest,
	type TellCaller,
	type TellAgent,
	type TellConversation,
	type TellPorts,
	type TellTerminal,
	type TellEditorPane,
	type TellPastSession,
	type TellIssueAction,
	type TellProfile,
	type TellStopped,
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
		controlState: "running",
		failure: undefined,
		promptCache: undefined,
		meta: {},
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
	broken: string | undefined = undefined;
	failure() {
		return this.broken;
	}
	reported: Usage | undefined = undefined;
	usage() {
		return this.reported;
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
	profiles(): TellProfile[] {
		return [
			{
				id: "claude",
				name: "Claude",
				kind: "claude",
				presentation: "gui",
				presentations: ["tui", "gui"],
			},
			{
				id: "codex",
				name: "Codex",
				kind: "codex",
				presentation: "gui",
				presentations: ["tui", "gui"],
			},
			{
				id: "cursor",
				name: "Cursor",
				kind: "cursor",
				presentation: "tui",
				presentations: ["tui"],
			},
		];
	}
	missing = new Map<string, string>([
		["cursor", "DevHub could not find cursor-agent on this Mac."],
	]);
	profileProblem(profileId: string, workspaceId: string | undefined) {
		this.calls.push(`profile-problem ${profileId} ${workspaceId ?? "-"}`);
		return Promise.resolve(this.missing.get(profileId));
	}
	actions: TellIssueAction[] = [
		{
			id: "issue_assignment",
			label: "Work on the Issue",
			template: "このIssueを読み、実装をしてください。\n{{ISSUE_URL}}\n",
			start: "draft",
		},
		{
			id: "review",
			label: "Review it",
			template: "\nReview {{ISSUE_URL}} and leave comments.",
			start: "send",
		},
	];
	issueActions() {
		return this.actions;
	}
	skill() {
		return {
			text: "---\nname: devhub\n---\n# /devhub\n",
			cli: "/x/bin/devhub",
		};
	}
	resetAgentName(agentId: string) {
		this.calls.push(`reset-name ${agentId}`);
		return Promise.resolve();
	}
	setAgentMeta(agentId: string, key: string, value: string | undefined) {
		this.calls.push(`meta ${agentId} ${key} ${value ?? "<unset>"}`);
		this.spaces = this.spaces.map((space) => ({
			...space,
			agents: space.agents.map((one) => {
				if (one.id !== agentId) return one;
				const meta: Record<string, string> = { ...one.meta };
				if (value === undefined) delete meta[key];
				else meta[key] = value;
				return { ...one, meta };
			}),
		}));
		return Promise.resolve();
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
			{
				id: "refresh_repositories",
				label: "Refresh repositories",
				category: "Workspace",
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
	/** What Stop answers, or the refusal it throws (the window's own words). */
	stopped: TellStopped | Error = {
		busy: false,
		movedTerminal: false,
		retried: false,
	};
	stopAgent(agentId: string) {
		this.calls.push(`stop ${agentId}`);
		return this.stopped instanceof Error
			? Promise.reject(this.stopped)
			: Promise.resolve(this.stopped);
	}
	restarted: { busy: boolean } | Error = { busy: false };
	restartAgent(agentId: string) {
		this.calls.push(`restart ${agentId}`);
		return this.restarted instanceof Error
			? Promise.reject(this.restarted)
			: Promise.resolve(this.restarted);
	}
	/** Each profile's earlier sessions, or why they could not be read. */
	past = new Map<string, readonly TellPastSession[] | Error>();
	pastSessions(workspaceId: string, profileId: string) {
		this.calls.push(`sessions ${workspaceId} ${profileId}`);
		const listed = this.past.get(profileId) ?? [];
		return listed instanceof Error
			? Promise.reject(listed)
			: Promise.resolve(listed);
	}
	resumeSession(
		workspaceId: string,
		profileId: string,
		session: TellPastSession,
	) {
		this.calls.push(`resume ${workspaceId} ${profileId} ${session.id}`);
		return Promise.resolve("resumed-agent");
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
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
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
			"aaaa1111-0000  Claude 1  claude/gui  working for 0s  2 request(s)  2 new  in app",
		);
		expect(all.message).toContain("Shell  shell/tui  idle for 0s  in Scratch");
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
		// No pane and no machine: a process DevHub did not start, on this Mac.
		expect(tellCaller(undefined, undefined)).toEqual({
			machine: "local",
			workspaceId: undefined,
			agentId: undefined,
			paneless: true,
		});
		expect(tellCaller(undefined, "")).toEqual(tellCaller(undefined, undefined));
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

	it("needs --workspace, --profile and --gui|--tui, and starts nothing without them", async () => {
		const { service, ports } = setup();
		// Even from inside a workspace: where an agent starts is not inferred.
		await expect(
			service.run(
				{ verb: "agent-new" },
				callerFromOrigin("local\tw1\taaaa1111-0000"),
			),
		).rejects.toThrow(
			[
				"--workspace is required: app (w1), scratch (scratch-id) (see devhub --tell workspaces)",
				"--profile is required: claude, codex, cursor (see devhub --tell profiles)",
				"--gui or --tui is required: --gui, --tui (see devhub --tell profiles)",
			].join("\n"),
		);
		await expect(
			service.run(
				{ verb: "agent-new", workspace: "w1", profile: "claude" },
				coordinator,
			),
		).rejects.toThrow(
			"--gui or --tui is required: claude has --tui, --gui (see devhub --tell profiles)",
		);
		await expect(
			service.run(
				{
					verb: "agent-new",
					workspace: "w1",
					profile: "cursor",
					presentation: "gui",
				},
				coordinator,
			),
		).rejects.toThrow("cursor runs a cursor CLI, which has no GUI: --tui");
		expect(ports.calls).toEqual([]);
		expect(ports.queued).toEqual([]);
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

	it("refuses a profile that is not configured, naming the ones there are", async () => {
		const { service, ports } = setup();
		await expect(
			service.run(
				{
					verb: "agent-new",
					workspace: "w1",
					profile: "gpt",
					presentation: "gui",
				},
				undefined,
			),
		).rejects.toThrow(
			"there is no agent profile called 'gpt': claude, codex, cursor (see devhub --tell profiles)",
		);
		expect(ports.calls).toEqual([]);
	});

	it("hands an Issue on with the branch it was given, and the extra prompt", async () => {
		const { service, ports } = setup();
		const answer = await service.run(
			{
				verb: "issue-assign",
				url: "https://github.com/o/r/issues/123",
				repo: "/src/r",
				branch: "123-fix-login-timeout",
				place: "worktree",
				editorOnly: false,
				profile: "claude",
				presentation: "gui",
				action: "issue_assignment",
				start: "draft",
				prompt: "only the backend",
			},
			coordinator,
		);
		expect(ports.calls[0]).toContain('"branch":"123-fix-login-timeout"');
		expect(ports.calls[0]).toContain('"profile":"claude"');
		expect(ports.calls[0]).toContain('"repo":"/src/r"');
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
		await service.run(
			{ verb: "run", command: "refresh_repositories" },
			undefined,
		);
		expect(ports.calls).toEqual(["run refresh_repositories"]);
		// One that moves the window's selection is not a command line's to run.
		await expect(
			service.run({ verb: "run", command: "next_agent" }, undefined),
		).rejects.toThrow(/changes what DevHub's window shows/u);
		expect(ports.calls).toEqual(["run refresh_repositories"]);
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
		expect(answeredBy(callerFromOrigin("local\tw1\tnone"), [])).toBe(
			"answered via devhub CLI by a terminal outside any agent",
		);
		expect(answeredBy(undefined, [])).toBe(
			"answered via devhub CLI by external",
		);
		expect(
			answeredBy(tellCaller(undefined, undefined, "claude-desktop"), []),
		).toBe("answered via devhub CLI by claude-desktop");
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

// --- orchestrating other agents -----------------------------------------------

/**
 * A command line, the way it reaches the app: parsed as the CLI parses it,
 * sent as a `tell` control request, and taken back off the socket.
 */
function viaSocket(
	service: TellService,
	argv: readonly string[],
	caller: TellCaller | undefined,
) {
	const parsed = parseTellArguments(argv);
	if (parsed.kind !== "tell") throw new Error(parsed.message);
	const request = parseControlRequest(
		JSON.stringify({ kind: "tell", command: parsed.command }),
	);
	if (request.kind !== "tell") throw new Error("not a tell request");
	return service.run(request.command, caller);
}

function said(text: string): TranscriptEntry {
	return {
		kind: "assistant",
		id: text as EntryId,
		parent: null,
		blocks: [{ kind: "text", markdown: text }],
		streaming: false,
	};
}

function told(text: string): TranscriptEntry {
	return {
		kind: "user",
		id: text as EntryId,
		parent: null,
		text,
		images: [],
		origin: "person",
		rewindable: true,
	};
}

/** The Agent `id`'s row, changed. */
function withAgent(
	ports: FakePorts,
	id: string,
	change: Partial<TellAgent>,
): void {
	ports.spaces = ports.spaces.map((space) => ({
		...space,
		agents: space.agents.map((one) =>
			one.id === id ? { ...one, ...change } : one,
		),
	}));
}

const self = callerFromOrigin("local\tw1\taaaa1111-0000");

describe("agent stop and agent restart", () => {
	it("stop the agent the window's way, and say what happened", async () => {
		const { service, ports } = setup();
		ports.stopped = { busy: true, movedTerminal: true, retried: false };
		const answer = await viaSocket(
			service,
			["agent", "stop", "Claude 1"],
			coordinator,
		);
		expect(ports.calls).toEqual(["stop aaaa1111-0000"]);
		expect(answer.message).toBe(
			"Stopped Claude 1 (aaaa1111-0000); it was working, and what it was doing stopped with it; its terminal went to the workspace's editor terminal, still running.",
		);
		expect(answer.data).toEqual({
			agentId: "aaaa1111-0000",
			stopped: true,
			busy: true,
			movedTerminal: true,
			retried: false,
		});
		ports.stopped = { busy: false, movedTerminal: false, retried: true };
		expect(
			(await viaSocket(service, ["agent", "stop", "aaaa"], undefined)).message,
		).toBe(
			"Stopped (a retry of the Stop that had failed) Claude 1 (aaaa1111-0000).",
		);
	});

	it("restart its session the window's way", async () => {
		const { service, ports } = setup();
		ports.restarted = { busy: true };
		const answer = await viaSocket(
			service,
			["agent", "restart", "aaaa"],
			coordinator,
		);
		expect(ports.calls).toEqual(["restart aaaa1111-0000"]);
		expect(answer.message).toBe(
			"Restarted Claude 1's session (aaaa1111-0000); it was working, and its turn stopped with it.",
		);
	});

	it("refuse an agent stopping or restarting itself, before asking the window", async () => {
		const { service, ports } = setup();
		await expect(
			viaSocket(service, ["agent", "stop", "aaaa"], self),
		).rejects.toThrow(/cannot stop itself/);
		await expect(
			viaSocket(service, ["agent", "restart", "Claude 1"], self),
		).rejects.toThrow(/cannot restart itself/);
		expect(ports.calls).toEqual([]);
	});

	it("refuse what the window refuses, in its words", async () => {
		const { service, ports } = setup();
		ports.stopped = new Error("Claude 1 is already stopping.");
		await expect(
			viaSocket(service, ["agent", "stop", "aaaa"], coordinator),
		).rejects.toThrow("Claude 1 is already stopping.");
		ports.restarted = new Error(
			"“Shell” runs a shell CLI, which has no session DevHub can resume, so there is no session to restart.",
		);
		await expect(
			viaSocket(service, ["agent", "restart", "Shell"], coordinator),
		).rejects.toThrow(/no session to restart/);
		await expect(
			viaSocket(service, ["agent", "stop", "nobody"], coordinator),
		).rejects.toThrow(/no agent is called/);
	});
});

describe("agent wait --any", () => {
	it("answers at once with a request the caller has not seen, and not again once it has", async () => {
		const { service } = setup();
		// Claude 1's turn runs, holding a question and a permission prompt.
		const first = await viaSocket(
			service,
			["agent", "wait", "--any"],
			coordinator,
		);
		expect(first.data).toMatchObject({
			reached: true,
			agents: ["aaaa1111-0000"],
			ready: [
				{
					agentId: "aaaa1111-0000",
					reasons: ["request"],
					requests: [
						{ id: "req-1", kind: "question", answerable: true },
						{ id: "req-2", kind: "tool", answerable: false },
					],
				},
			],
		});
		expect(first.message).toContain("question req-1");
		expect(first.message).toContain(
			"permission prompt req-2 (answer in DevHub: tell the person)",
		);
		// Seen: a wait does not keep coming back for a prompt the person is to answer.
		await viaSocket(service, ["agent", "requests", "aaaa"], coordinator);
		const later = await viaSocket(
			service,
			["agent", "wait", "--any", "--timeout", "2"],
			coordinator,
		);
		expect(later.data).toMatchObject({ reached: false, ready: [] });
		expect(later.message).toContain("after 2s");
	});

	it("reports output only once the turn is over, and only what the caller has not read", async () => {
		const { service, conversation } = setup();
		conversation.pending = [];
		// Streaming in a turn that runs is not news yet.
		expect(
			(
				await viaSocket(
					service,
					["agent", "wait", "--any", "--timeout", "1"],
					coordinator,
				)
			).data,
		).toMatchObject({ reached: false });
		conversation.state = "none";
		const done = await viaSocket(
			service,
			["agent", "wait", "--any"],
			coordinator,
		);
		expect(done.data).toMatchObject({
			ready: [{ reasons: ["output"], unread: 2, since: null, cursor: "e3" }],
		});
		expect(done.message).toContain(
			"Read: devhub --tell agent read aaaa1111-0000 --last 20",
		);
		// Read: nothing is owed any more.
		await viaSocket(service, ["agent", "read", "aaaa"], coordinator);
		expect(
			(
				await viaSocket(
					service,
					["agent", "wait", "--any", "--timeout", "1"],
					coordinator,
				)
			).data,
		).toMatchObject({ reached: false });
		// What the orchestrator itself sent is not news.
		conversation.log = [...conversation.log, told("e4")];
		expect(
			(
				await viaSocket(
					service,
					["agent", "wait", "--any", "--timeout", "1"],
					coordinator,
				)
			).data,
		).toMatchObject({ reached: false });
	});

	it("misses nothing that happens between two calls", async () => {
		const { service, conversation } = setup();
		conversation.pending = [];
		conversation.state = "none";
		await viaSocket(service, ["agent", "read", "aaaa"], coordinator);
		// Between the read and the next wait — while the orchestrator was busy
		// with something else — the agent ran a whole turn and went idle
		// again. No wait saw it working; the next one still reports it.
		conversation.log = [...conversation.log, told("e4")];
		conversation.state = "running";
		conversation.log = [...conversation.log, said("e5")];
		conversation.state = "none";
		conversation.log = [...conversation.log, said("e6")];
		const next = await viaSocket(
			service,
			["agent", "wait", "--any", "--timeout", "1"],
			coordinator,
		);
		expect(next.data).toMatchObject({
			reached: true,
			ready: [{ reasons: ["output"], unread: 2, since: "e3", cursor: "e6" }],
		});
		// It stays news until it is read, however many waits come first...
		expect(
			(
				await viaSocket(
					service,
					["agent", "wait", "--any", "--timeout", "1"],
					coordinator,
				)
			).data,
		).toMatchObject({ reached: true });
		// ...and another caller has its own reading.
		expect(
			(
				await viaSocket(
					service,
					["agent", "wait", "--any", "aaaa", "--timeout", "1"],
					callerFromOrigin("local\tw1\tnone"),
				)
			).data,
		).toMatchObject({ ready: [{ since: null, unread: 4 }] });
		// Read from the cursor the wait gave: everything since, then quiet.
		const read = await viaSocket(
			service,
			["agent", "read", "aaaa", "--since", "e3"],
			coordinator,
		);
		expect(read.data).toMatchObject({ cursor: "e6" });
		expect(
			(read.data as { entries: { id: string }[] }).entries.map(
				(entry) => entry.id,
			),
		).toEqual(["e4", "e5", "e6"]);
		expect(
			(
				await viaSocket(
					service,
					["agent", "wait", "--any", "--timeout", "1"],
					coordinator,
				)
			).data,
		).toMatchObject({ reached: false });
	});

	it("waits until an agent has news, polling, within the timeout", async () => {
		const { service, conversation, now } = setup();
		conversation.pending = [];
		await viaSocket(service, ["agent", "read", "aaaa"], coordinator);
		let polls = 0;
		const entries = conversation.entries.bind(conversation);
		conversation.entries = () => {
			polls += 1;
			if (polls === 3) {
				conversation.state = "none";
				conversation.log = [...conversation.log, said("e9")];
			}
			return entries();
		};
		const answer = await viaSocket(
			service,
			["agent", "wait", "--any", "--timeout", "60"],
			coordinator,
		);
		expect(answer.data).toMatchObject({
			reached: true,
			ready: [{ cursor: "e9" }],
		});
		expect(now()).toBe(1000);
	});

	it("tells a failure the caller has not seen", async () => {
		const { service, ports, conversation } = setup();
		conversation.pending = [];
		await viaSocket(service, ["agent", "read", "aaaa"], coordinator);
		withAgent(ports, "aaaa1111-0000", {
			status: "error",
			failure: { code: "conversation_failed", detail: undefined },
		});
		const answer = await viaSocket(
			service,
			["agent", "wait", "--any", "--until", "idle", "--timeout", "1"],
			coordinator,
		);
		expect(answer.data).toMatchObject({
			ready: [{ reasons: ["failure"], failure: "conversation_failed" }],
		});
	});

	it("is about the others: never the caller, nor a terminal agent", async () => {
		const { service, ports } = setup();
		const callerConversation = new FakeConversation();
		callerConversation.pending = [question];
		ports.conversations.set("bbbb2222-0000", callerConversation);
		const answer = await viaSocket(
			service,
			["agent", "wait", "--any"],
			coordinator,
		);
		expect(answer.data).toMatchObject({ agents: ["aaaa1111-0000"] });
		await expect(
			viaSocket(
				service,
				["agent", "wait", "--any", "Coordinator"],
				coordinator,
			),
		).rejects.toThrow(/cannot wait on itself/);
		await expect(
			viaSocket(service, ["agent", "wait", "--any", "Shell"], coordinator),
		).rejects.toThrow(/terminal agent.*--all/);
		await expect(
			viaSocket(
				service,
				["agent", "wait", "--any", "--workspace", "scratch"],
				coordinator,
			),
		).rejects.toThrow(/no other GUI agent in scratch/);
		await expect(
			viaSocket(
				service,
				["agent", "wait", "--any", "aaaa", "--workspace", "w1"],
				coordinator,
			),
		).rejects.toThrow(/not both/);
	});

	it("says when one of them is gone", async () => {
		const { service, ports, conversation } = setup();
		conversation.pending = [];
		ports.spaces = ports.spaces.map((space) => ({
			...space,
			agents: space.agents.filter((one) => one.id !== "aaaa1111-0000"),
		}));
		const answer = await service
			.run(
				{
					verb: "agent-wait-many",
					mode: "any",
					agents: [],
					until: "any",
					timeoutSeconds: 5,
				},
				coordinator,
			)
			.catch((error: unknown) => error as Error);
		// Gone before the wait began: there is nobody to wait on.
		expect(answer).toBeInstanceOf(Error);
		const fresh = setup();
		fresh.conversation.pending = [];
		let polls = 0;
		const original = fresh.ports.workspaces.bind(fresh.ports);
		fresh.ports.workspaces = () => {
			polls += 1;
			const spaces = original();
			return polls < 3
				? spaces
				: spaces.map((space) => ({
						...space,
						agents: space.agents.filter((one) => one.id !== "aaaa1111-0000"),
					}));
		};
		const gone = await viaSocket(
			fresh.service,
			["agent", "wait", "--any", "aaaa"],
			coordinator,
		);
		expect(gone.data).toMatchObject({
			reached: true,
			gone: [{ agentId: "aaaa1111-0000" }],
		});
		expect(gone.message).toBe("Claude 1 (aaaa1111-0000) is gone.");
	});
});

describe("agent wait --all", () => {
	it("returns once every one is in the state, terminal agents included", async () => {
		const { service, ports } = setup();
		let polls = 0;
		const original = ports.workspaces.bind(ports);
		ports.workspaces = () => {
			polls += 1;
			const spaces = original();
			return polls < 4
				? spaces
				: spaces.map((space) => ({
						...space,
						agents: space.agents.map((one) => ({ ...one, status: "idle" })),
					}));
		};
		const answer = await viaSocket(
			service,
			["agent", "wait", "--all", "aaaa", "Shell", "--until", "idle"],
			coordinator,
		);
		expect(answer.data).toMatchObject({
			reached: true,
			agents: [
				{ agentId: "aaaa1111-0000", status: "idle", reached: true },
				{ agentId: "cccc3333-0000", status: "idle", reached: true },
			],
		});
	});

	it("says which are not there yet at the timeout", async () => {
		const { service } = setup();
		const answer = await viaSocket(
			service,
			["agent", "wait", "--all", "--until", "idle", "--timeout", "3"],
			coordinator,
		);
		expect(answer.data).toMatchObject({ reached: false });
		expect(answer.message).toContain("Not all there (until idle) after 3s:");
		expect(answer.message).toContain("- Claude 1 (aaaa1111-0000) is working");
		expect(answer.message).toContain("  Shell (cccc3333-0000) is idle");
	});
});

describe("agent status", () => {
	it("gives one agent's state in one call, with a stable --json shape", async () => {
		const { service, ports, conversation, advance } = setup();
		conversation.reported = {
			inputTokens: undefined,
			outputTokens: undefined,
			cachedInputTokens: undefined,
			contextTokens: 50_000,
			contextWindow: 200_000,
			costUsd: undefined,
			rateLimits: undefined,
		};
		withAgent(ports, "aaaa1111-0000", {
			activity: "Running tests",
			promptCache: {
				ttlSeconds: 300,
				ttlKnown: true,
				expiresAt: 400_000,
				hitRatio: 0.9,
				requests: 3,
				misses: 1,
				recacheTokens: 1000,
			},
		});
		await viaSocket(service, ["agents"], coordinator);
		advance(90_000);
		withAgent(ports, "aaaa1111-0000", { status: "waiting" });
		await viaSocket(service, ["agents"], coordinator);
		advance(30_000);
		const answer = await viaSocket(
			service,
			["--json", "agent", "status", "aaaa"],
			coordinator,
		);
		expect(answer.data).toEqual({
			agentId: "aaaa1111-0000",
			name: "Claude 1",
			kind: "claude",
			profile: "claude",
			presentation: "gui",
			meta: {},
			workspace: { id: "w1", name: "app", root: "/src/app" },
			status: "waiting",
			statusSince: "1970-01-01T00:01:30.000Z",
			lastActivityAt: "1970-01-01T00:01:30.000Z",
			activity: "Running tests",
			turn: "running",
			control: "running",
			failure: null,
			requests: {
				questions: 1,
				permissions: 1,
				open: [
					expect.objectContaining({ id: "req-1", answerable: true }),
					expect.objectContaining({
						id: "req-2",
						kind: "tool",
						answerable: false,
						text: expect.stringContaining("(answer in DevHub)"),
					}),
				],
			},
			unread: { entries: 2, since: null, cursor: "e3" },
			context: { tokens: 50_000, window: 200_000, percent: 25 },
			promptCache: {
				ttlSeconds: 300,
				expiresAt: "1970-01-01T00:06:40.000Z",
				cold: false,
				hitRatio: 0.9,
				misses: 1,
				autoCompactAt: null,
			},
		});
		expect(answer.message.split("\n")).toEqual([
			"Claude 1 (aaaa1111-0000)  claude/gui, profile claude, in app (/src/app)",
			"status    waiting for 30s (since 1970-01-01T00:01:30.000Z), turn running",
			"activity  Running tests (last change 30s ago)",
			"requests  question req-1, tool req-2 (answer in DevHub)",
			"unread    2 entries you have not read; cursor e3",
			"context   50000 / 200000 tokens (25%)",
			"cache     warm until 1970-01-01T00:06:40.000Z (TTL 300s), hit 90%, 1 miss(es)",
		]);
	});

	it("says why it broke, and has nothing to say of a terminal agent's transcript", async () => {
		const { service, conversation } = setup();
		conversation.state = "broken";
		conversation.broken = "protocol_mismatch: line 3";
		const broken = await viaSocket(
			service,
			["agent", "status", "aaaa"],
			undefined,
		);
		expect(broken.data).toMatchObject({
			turn: "broken",
			failure: "broken: protocol_mismatch: line 3",
		});
		expect(broken.message).toContain("failure   broken: protocol_mismatch");
		const shell = await viaSocket(
			service,
			["agent", "status", "Shell"],
			undefined,
		);
		expect(shell.data).toMatchObject({
			presentation: "tui",
			turn: null,
			requests: null,
			unread: null,
			context: null,
			promptCache: null,
		});
	});

	it("is each row's state in agents --json", async () => {
		const { service } = setup();
		const answer = await viaSocket(service, ["--json", "agents"], undefined);
		const rows = (answer.data as { agents: { id: string; state: unknown }[] })
			.agents;
		expect(rows.map((row) => row.id)).toEqual([
			"aaaa1111-0000",
			"bbbb2222-0000",
			"cccc3333-0000",
		]);
		expect(rows[0]!.state).toEqual(
			(await viaSocket(service, ["agent", "status", "aaaa"], undefined)).data,
		);
	});
});

const PAST: Record<string, TellPastSession[]> = {
	claude: [
		{
			id: "c1aa-0001",
			title: "Fix the login timeout",
			updatedAt: 8 * 3_600_000,
			cwd: "/src/app",
			branch: "12-fix",
			resumableHere: true,
		},
		{
			id: "c2bb-0002",
			title: "",
			agentName: "API",
			updatedAt: 5 * 3_600_000,
			cwd: "/src/app-13-api",
			branch: "13-api",
			resumableHere: false,
			worktree: { root: "/src/app-13-api", branch: "13-api", present: false },
		},
		{
			id: "c3cc-0003",
			title: "Elsewhere",
			updatedAt: undefined,
			cwd: "/tmp/other",
			branch: undefined,
			resumableHere: false,
		},
	],
	codex: [
		{
			id: "x1dd-0001",
			title: "Refactor the store",
			updatedAt: 9 * 3_600_000,
			cwd: "/src/app",
			branch: undefined,
			resumableHere: true,
		},
	],
};

describe("sessions and agent resume", () => {
	function withSessions() {
		const made = setup();
		made.advance(10 * 3_600_000);
		made.ports.past.set("claude", PAST["claude"]!);
		made.ports.past.set("codex", PAST["codex"]!);
		return made;
	}

	it("lists the picker's earlier sessions, newest first across profiles", async () => {
		const { service, ports } = withSessions();
		const answer = await viaSocket(
			service,
			["sessions", "--workspace", "w1", "--limit", "3"],
			coordinator,
		);
		expect(ports.calls).toEqual(["sessions w1 claude", "sessions w1 codex"]);
		expect(answer.message.split("\n")).toEqual([
			'x1dd-0001  codex  1h ago  "Refactor the store"',
			'c1aa-0001  claude  2h ago  "Fix the login timeout"  branch 12-fix',
			'c2bb-0002  claude  5h ago  ""  (API)  worktree /src/app-13-api (13-api), gone: checked out again on resume',
			"(1 more: --limit)",
		]);
		expect(answer.data).toMatchObject({
			workspaceId: "w1",
			more: 1,
			sessions: [
				{ id: "x1dd-0001", profile: "codex", resumable: true },
				{ id: "c1aa-0001", branch: "12-fix", worktree: null },
				{
					id: "c2bb-0002",
					agentName: "API",
					worktree: { root: "/src/app-13-api", present: false },
					resumable: true,
				},
			],
		});
	});

	it("defaults to the caller's workspace, takes one profile, and says what could not be read", async () => {
		const { service, ports } = withSessions();
		ports.past.set("codex", new Error("codex is not installed"));
		const answer = await viaSocket(service, ["sessions"], self);
		expect(ports.calls[0]).toBe("sessions w1 claude");
		expect(answer.message).toContain(
			"(codex's sessions could not be read: codex is not installed)",
		);
		expect(answer.message).toContain("not resumable here (ran in /tmp/other)");
		ports.calls = [];
		await viaSocket(service, ["sessions", "--profile", "claude"], self);
		expect(ports.calls).toEqual(["sessions w1 claude"]);
		await expect(
			viaSocket(service, ["sessions", "--profile", "nope"], self),
		).rejects.toThrow(/no agent profile called 'nope'/);
		await expect(viaSocket(service, ["sessions"], undefined)).rejects.toThrow(
			/needs --workspace/,
		);
	});

	it("resumes one in a new GUI agent, the picker's way, by id or a prefix", async () => {
		const { service, ports } = withSessions();
		const answer = await viaSocket(
			service,
			["agent", "resume", "c2bb", "--workspace", "w1", "--name", "API again"],
			coordinator,
		);
		expect(ports.calls).toEqual([
			"sessions w1 claude",
			"sessions w1 codex",
			"resume w1 claude c2bb-0002",
			"rename resumed-agent API again",
		]);
		expect(answer.message).toBe(
			'Agent resumed-agent (claude) is going on with "API" (c2bb-0002) in /src/app-13-api.',
		);
		ports.calls = [];
		await viaSocket(service, ["agent", "resume", "x1dd-0001"], self);
		expect(ports.calls.at(-1)).toBe("resume w1 codex x1dd-0001");
	});

	it("refuses a session it cannot go on with here, and one it cannot tell apart", async () => {
		const { service, ports } = withSessions();
		await expect(
			viaSocket(service, ["agent", "resume", "c3cc-0003"], self),
		).rejects.toThrow(/ran in \/tmp\/other.*only there/);
		ports.past.set("codex", [
			...PAST["codex"]!,
			{ ...PAST["codex"]![0]!, id: "x1dd-0002" },
		]);
		await expect(
			viaSocket(service, ["agent", "resume", "x1dd"], self),
		).rejects.toThrow(/more than one session/);
		await expect(
			viaSocket(service, ["agent", "resume", "zzzz"], self),
		).rejects.toThrow(/no earlier session/);
		expect(ports.calls.filter((call) => call.startsWith("resume"))).toEqual([]);
	});
});

describe("no command line answers a permission prompt", () => {
	/** Every verb with a way into another agent, aimed at Claude 1's permission prompt. */
	const LINES: readonly (readonly string[])[] = [
		["agent", "answer", "aaaa", "req-2", "--option", "1"],
		["agent", "answer", "aaaa", "req-2", "--text", "allow"],
		["agent", "answer", "aaaa", "req-2", "--allow"],
		["agent", "answer", "aaaa", "req-2", "--deny"],
		["agent", "send", "aaaa", "yes, allow it"],
		["agent", "interrupt", "aaaa"],
		["agent", "read", "aaaa"],
		["agent", "requests", "aaaa"],
		["agent", "status", "aaaa"],
		["agent", "wait", "aaaa", "--timeout", "1"],
		["agent", "wait", "--any", "--timeout", "1"],
		["agent", "wait", "--any", "aaaa", "--until", "waiting", "--timeout", "1"],
		["agent", "wait", "--all", "--timeout", "1"],
		["agent", "stop", "aaaa"],
		["agent", "restart", "aaaa"],
		["sessions", "--workspace", "w1"],
		["agent", "resume", "c1aa-0001", "--workspace", "w1"],
		["agents"],
		["commands"],
		["run", "next_agent"],
		["focus", "aaaa"],
		["notify", "allow req-2"],
	];

	it("through answer, run, or any of the orchestration commands", async () => {
		const { service, ports, conversation } = setup();
		ports.past.set("claude", PAST["claude"]!);
		for (const line of LINES) {
			try {
				await viaSocket(service, line, coordinator);
			} catch {
				// A refusal is what some of these are for.
			}
		}
		expect(conversation.answered).toEqual([]);
		expect(conversation.pending.map((request) => request.id)).toContain(
			"req-2",
		);
		// What the CLI refuses before anything is sent.
		expect(
			parseTellArguments(["agent", "answer", "a", "r", "--allow"]),
		).toEqual({
			kind: "invalid",
			message:
				"permission prompts are answered in DevHub, by the person, and never from the command line.",
		});
	});

	it("refuses every kind of request that is not a question", async () => {
		const { service, conversation } = setup();
		const subjects: PendingRequest["subject"][] = [
			permission.subject,
			{
				kind: "command",
				command: "rm -rf /",
				cwd: undefined,
				reason: undefined,
			},
			{ kind: "file-change", files: [], reason: undefined },
		] as PendingRequest["subject"][];
		for (const [index, subject] of subjects.entries()) {
			const id = `perm-${String(index)}` as RequestId;
			conversation.pending = [{ ...permission, id, subject }];
			await expect(
				viaSocket(
					service,
					["agent", "answer", "aaaa", id, "--option", "1"],
					coordinator,
				),
			).rejects.toThrow(/only questions can be answered/);
		}
		expect(conversation.answered).toEqual([]);
	});

	it("has one call that answers anything, behind the questions-only check", () => {
		const source = readFileSync(
			new URL("./service.ts", import.meta.url),
			"utf8",
		);
		// `this.answer(` is the verb's own method; any other `.answer(` reaches an agent.
		const calls = source.match(/(?<!this)\.answer\(/gu) ?? [];
		expect(calls).toHaveLength(1);
		const guard = source.indexOf('request.subject.kind !== "question"');
		expect(guard).toBeGreaterThan(0);
		expect(guard).toBeLessThan(source.indexOf("conversation.answer("));
	});

	it("has no palette command that answers a request", () => {
		expect(
			COMMANDS.filter((command) =>
				/answer|approv|allow|permission|deny|accept|grant/iu.test(
					`${command.id} ${command.label}`,
				),
			).map((command) => command.id),
		).toEqual([]);
	});
});

/** `issue assign` with every choice named. */
const FULL_ASSIGN = [
	"issue",
	"assign",
	"https://github.com/o/r/issues/7",
	"--repo",
	"/src/r",
	"--branch",
	"7-fix",
	"--profile",
	"claude",
	"--tui",
	"--action",
	"issue_assignment",
	"--send",
	"--meta",
	"parent=bbbb2222-0000",
	"--meta",
	"role=implementer",
];

describe("no --tell call opens a picker", () => {
	it("refuses a palette command that would put a picker or a question up, naming the command to use", async () => {
		const { service, ports } = setup();
		const commands = ports.commands.bind(ports);
		ports.commands = () => [
			...commands(),
			...COMMANDS.filter((command) =>
				[
					"add_agent",
					"open_issue_picker",
					"rename_agent",
					"close_workspace",
				].includes(command.id),
			).map((command) => ({
				id: command.id,
				label: command.label,
				category: command.category,
				available: true,
			})),
		];
		await expect(
			viaSocket(service, ["run", "add_agent"], coordinator),
		).rejects.toThrow(
			/picker or a question up in DevHub's window.*'agent new/u,
		);
		await expect(
			viaSocket(service, ["run", "open_issue_picker"], coordinator),
		).rejects.toThrow(/'issue assign <url>'/u);
		await expect(
			viaSocket(service, ["run", "rename_agent"], coordinator),
		).rejects.toThrow(/'agent rename <a> <name>'/u);
		await expect(
			viaSocket(service, ["run", "close_workspace"], coordinator),
		).rejects.toThrow(/picker or a question/u);
		expect(ports.calls.filter((call) => call.startsWith("run "))).toEqual([]);
		// One that neither asks nor moves anything still runs.
		await viaSocket(service, ["run", "refresh_repositories"], coordinator);
		expect(ports.calls).toContain("run refresh_repositories");
	});

	it("knows every palette command that asks in the window", () => {
		// The commands whose chord opens a sheet or a confirmation: a new one
		// of those has to be added to the refusals, or `run` would open it.
		const asking = [
			"add_workspace",
			"add_agent",
			"open_issue_picker",
			"open_tab_picker",
			"send_agent_action",
			"rename_agent",
			"close_selection",
			"close_workspace",
			"restart_agent",
			"open_recently_closed",
			"preview_color_theme",
			"show_chord_help",
			"open_command_palette",
		];
		const ids = COMMANDS.map((command) => command.id as string);
		for (const id of asking) expect(ids).toContain(id);
	});

	it("passes every choice of issue assign through, and none it was not given", async () => {
		const { service, ports } = setup();
		await viaSocket(service, FULL_ASSIGN, coordinator);
		const assigned = JSON.parse(
			ports.calls[0]!.slice("assign ".length),
		) as IssueAssignRequest;
		expect(assigned).toMatchObject({
			repo: "/src/r",
			branch: "7-fix",
			place: "worktree",
			profile: "claude",
			presentation: "tui",
			action: "issue_assignment",
			start: "send",
		});
		expect(ports.calls.slice(1)).toEqual([
			"meta issue-agent parent bbbb2222-0000",
			"meta issue-agent role implementer",
		]);
		// --action none: no action, and so nothing to draft or send.
		ports.calls = [];
		const none = FULL_ASSIGN.slice(0, 10).concat(["--action", "none"]);
		await viaSocket(service, none, coordinator);
		const bare = JSON.parse(
			ports.calls[0]!.slice("assign ".length),
		) as IssueAssignRequest;
		expect(bare.action).toBeUndefined();
		expect(bare.start).toBeUndefined();
		await expect(
			viaSocket(service, [...none, "--draft"], coordinator),
		).rejects.toThrow(
			"--send/--draft is about the action's wording, and --action none has none",
		);
		expect(
			parseTellArguments(["issue", "assign", "u", "--send", "--draft"]),
		).toEqual({
			kind: "invalid",
			message: "--send and --draft ask for different things.",
		});
	});

	it("refuses an issue assign that leaves any choice open, naming every flag and its values, and does nothing", async () => {
		const { service, ports } = setup();
		await expect(
			viaSocket(
				service,
				["issue", "assign", "https://github.com/o/r/issues/7"],
				coordinator,
			),
		).rejects.toThrow(
			[
				"--repo <path> is required: the clone to work in (the window asks which when there are several)",
				"--branch <name> or --root is required: --branch NAME works in a worktree of NAME (made if need be), --root in the clone itself (with --branch, switched to NAME; without, as it is)",
				"--profile is required: claude, codex, cursor (see devhub --tell profiles)",
				"--gui or --tui is required: --gui, --tui (see devhub --tell profiles)",
				"--action is required: issue_assignment, review, none (see devhub --tell issue actions; none tells the agent nothing)",
				"--send or --draft is required: --draft puts the action's wording into the agent's input box unsent, --send sends it as its first message",
			].join("\n"),
		);
		// Each one missing on its own is named on its own.
		const without = (flag: string, values = 1) => {
			const at = FULL_ASSIGN.indexOf(flag);
			return [
				...FULL_ASSIGN.slice(0, at),
				...FULL_ASSIGN.slice(at + 1 + values),
			];
		};
		for (const [line, said] of [
			[without("--repo"), /^--repo <path> is required/u],
			[without("--branch"), /^--branch <name> or --root is required/u],
			[without("--profile"), /^--profile is required: claude, codex, cursor/u],
			[
				without("--tui", 0),
				/^--gui or --tui is required: claude has --tui, --gui/u,
			],
			[
				without("--action"),
				/^--action is required: issue_assignment, review, none/u,
			],
			[without("--send", 0), /^--send or --draft is required/u],
		] as const) {
			await expect(viaSocket(service, line, coordinator)).rejects.toThrow(said);
		}
		await expect(
			viaSocket(
				service,
				[...without("--action"), "--action", "nope"],
				coordinator,
			),
		).rejects.toThrow(
			"there is no Issue action called 'nope': issue_assignment, review, none (see devhub --tell issue actions)",
		);
		// Nothing at all was done by any of those.
		expect(ports.calls).toEqual([]);
		// --root alone is a choice: the clone as it is.
		await viaSocket(service, [...without("--branch"), "--root"], coordinator);
		expect(ports.calls).toHaveLength(3);
		expect(ports.calls[0]).toContain('"place":"root"');
		expect(ports.calls[0]).not.toContain('"branch"');
		expect(ports.queued).toEqual([]);
	});

	it("takes --editor-only with only the clone and the branch, and refuses the agent's flags with it", async () => {
		const { service, ports } = setup();
		const base = [
			"issue",
			"assign",
			"https://github.com/o/r/issues/7",
			"--repo",
			"/src/r",
			"--branch",
			"7-fix",
			"--editor-only",
		];
		await viaSocket(service, base, coordinator);
		expect(ports.calls).toHaveLength(1);
		await expect(
			viaSocket(
				service,
				[...base, "--profile", "claude", "--gui"],
				coordinator,
			),
		).rejects.toThrow(
			"--profile, --gui/--tui are about the agent, and --editor-only starts none",
		);
		expect(ports.calls).toHaveLength(1);
	});

	it("needs --profile for a session two profiles could go on with", async () => {
		const { service, ports } = setup();
		ports.past.set("claude", PAST["claude"]!);
		const profiles = ports.profiles.bind(ports);
		ports.profiles = () => [
			...profiles(),
			{
				id: "claude-fast",
				name: "Claude (fast)",
				kind: "claude",
				presentation: "gui",
				presentations: ["tui", "gui"],
			},
		];
		await expect(
			viaSocket(
				service,
				["agent", "resume", "c1aa-0001", "--workspace", "w1"],
				coordinator,
			),
		).rejects.toThrow(
			"--profile is required: session c1aa-0001 is a claude session, and claude, claude-fast all run claude (see devhub --tell profiles)",
		);
		expect(ports.calls.filter((call) => call.startsWith("resume"))).toEqual([]);
	});
});

describe("profiles and issue actions", () => {
	it("lists the profiles the agent picker offers, with the default mode and why one cannot start", async () => {
		const { service, ports } = setup();
		const answer = await viaSocket(service, ["profiles"], coordinator);
		expect(answer.message.split("\n")).toEqual([
			"claude  Claude  claude  --tui --gui (window default: GUI)  available",
			"codex  Codex  codex  --tui --gui (window default: GUI)  available",
			"cursor  Cursor  cursor  --tui (window default: TUI)  unavailable: DevHub could not find cursor-agent on this Mac.",
		]);
		expect(answer.data).toEqual({
			profiles: [
				{
					id: "claude",
					name: "Claude",
					kind: "claude",
					presentation: "gui",
					presentations: ["tui", "gui"],
					available: true,
					unavailable: null,
				},
				{
					id: "codex",
					name: "Codex",
					kind: "codex",
					presentation: "gui",
					presentations: ["tui", "gui"],
					available: true,
					unavailable: null,
				},
				{
					id: "cursor",
					name: "Cursor",
					kind: "cursor",
					presentation: "tui",
					presentations: ["tui"],
					available: false,
					unavailable: "DevHub could not find cursor-agent on this Mac.",
				},
			],
		});
		// Asked on the machine of the caller's workspace (Scratch has none).
		expect(ports.calls).toContain("profile-problem claude -");
	});

	it("lists the Issue actions --action takes, what the window does with each, and none", async () => {
		const { service } = setup();
		const answer = await viaSocket(service, ["issue", "actions"], coordinator);
		expect(answer.message.split("\n")).toEqual([
			"issue_assignment  Work on the Issue  (window: draft)  — このIssueを読み、実装をしてください。",
			"review  Review it  (window: send)  — Review {{ISSUE_URL}} and leave comments.",
			"none  (start the agent and tell it nothing)",
		]);
		expect(
			(answer.data as { actions: { id: string; start: string }[] }).actions.map(
				(action) => [action.id, action.start],
			),
		).toEqual([
			["issue_assignment", "draft"],
			["review", "send"],
		]);
	});
});

describe("agent rename and agent meta", () => {
	it("renames through the window's intent, and --clear goes back to DevHub's label", async () => {
		const { service, ports } = setup();
		await viaSocket(
			service,
			["agent", "rename", "aaaa", "API", "fix"],
			coordinator,
		);
		await viaSocket(
			service,
			["agent", "rename", "aaaa", "--clear"],
			coordinator,
		);
		expect(ports.calls).toEqual([
			"rename aaaa1111-0000 API fix",
			"reset-name aaaa1111-0000",
		]);
		// An agent may rename itself.
		await viaSocket(
			service,
			["agent", "rename", "bbbb2222-0000", "Lead"],
			coordinator,
		);
		expect(ports.calls).toContain("rename bbbb2222-0000 Lead");
		expect(parseTellArguments(["agent", "rename", "aaaa"])).toEqual({
			kind: "invalid",
			message: "missing <name> (or --clear for the name DevHub gives it).",
		});
	});

	it("sets, lists, unsets and filters by an agent's own pairs", async () => {
		const { service, ports } = setup();
		await viaSocket(
			service,
			["agent", "meta", "aaaa", "set", "role", "code", "reviewer"],
			coordinator,
		);
		await viaSocket(
			service,
			["agent", "meta", "aaaa", "set", "issue", "123"],
			coordinator,
		);
		const listed = await viaSocket(
			service,
			["agent", "meta", "aaaa"],
			coordinator,
		);
		expect(listed.message).toBe("role=code reviewer\nissue=123");
		expect(listed.data).toEqual({
			agentId: "aaaa1111-0000",
			meta: { role: "code reviewer", issue: "123" },
		});
		const filtered = await viaSocket(
			service,
			["--json", "agents", "--meta", "issue=123"],
			coordinator,
		);
		const rows = (
			filtered.data as { agents: { id: string; state: { meta: object } }[] }
		).agents;
		expect(rows.map((row) => row.id)).toEqual(["aaaa1111-0000"]);
		expect(rows[0]!.state.meta).toEqual({
			role: "code reviewer",
			issue: "123",
		});
		const status = await viaSocket(
			service,
			["agent", "status", "aaaa"],
			coordinator,
		);
		expect(status.message).toContain("meta      role=code reviewer issue=123");
		await viaSocket(
			service,
			["agent", "meta", "aaaa", "unset", "issue"],
			coordinator,
		);
		expect(
			(await viaSocket(service, ["agents", "--meta", "issue=123"], coordinator))
				.message,
		).toBe("No agent carries issue=123.");
		expect(ports.calls).toContain("meta aaaa1111-0000 issue <unset>");
	});

	it("tags a new agent with --meta, and refuses a key or value it cannot keep", async () => {
		const { service, ports } = setup();
		await viaSocket(
			service,
			[
				"agent",
				"new",
				"--workspace",
				"w1",
				"--profile",
				"claude",
				"--gui",
				"--meta",
				"parent=bbbb2222-0000",
			],
			coordinator,
		);
		expect(ports.calls).toEqual([
			"create w1 claude gui",
			"meta new-agent parent bbbb2222-0000",
		]);
		for (const [line, message] of [
			[["agent", "meta", "a", "set", "9lives", "x"], /is not a metadata key/u],
			[["agent", "new", "--meta", "role"], /--meta takes KEY=VALUE/u],
			[
				["agent", "new", "--meta", "a=1", "--meta", "a=2"],
				/given more than once/u,
			],
			[
				["agent", "meta", "a", "set", "k", "x".repeat(257)],
				/at most 256 characters/u,
			],
		] as const) {
			const parsed = parseTellArguments(line);
			expect(parsed.kind).toBe("invalid");
			if (parsed.kind === "invalid") expect(parsed.message).toMatch(message);
		}
	});
});

describe("callers DevHub did not start", () => {
	const outside = tellCaller(undefined, undefined);
	const desktop = tellCaller(undefined, undefined, "claude-desktop");

	it("prints the /devhub skill for this DevHub's devhub command, from anywhere", async () => {
		const { service } = setup();
		for (const caller of [outside, desktop, coordinator]) {
			const answer = await viaSocket(service, ["skill"], caller);
			expect(answer.message).toBe("---\nname: devhub\n---\n# /devhub\n");
			expect(answer.data).toEqual({
				text: "---\nname: devhub\n---\n# /devhub\n",
				cli: "/x/bin/devhub",
			});
		}
	});

	it("are one reader per --as label, all unlabelled ones being 'external'", async () => {
		expect(callerKey(outside)).toBe("outside:external");
		expect(callerKey(tellCaller(undefined, "ssh:box"))).toBe(
			"outside:external",
		);
		expect(callerKey(desktop)).toBe("outside:claude-desktop");
		expect(callerKey(tellCaller(undefined, "ssh:box", "claude-desktop"))).toBe(
			"outside:claude-desktop",
		);
		const { service } = setup();
		// What one has read is not what the other has.
		const first = await viaSocket(service, ["agent", "wait", "--any"], desktop);
		expect(first.data).toMatchObject({ reached: true });
		await viaSocket(service, ["agent", "requests", "aaaa"], desktop);
		const again = await viaSocket(
			service,
			["agent", "wait", "--any", "--timeout", "2"],
			desktop,
		);
		expect(again.data).toMatchObject({ reached: false });
		const other = await viaSocket(
			service,
			["agent", "wait", "--any", "--timeout", "2"],
			outside,
		);
		expect(other.data).toMatchObject({ reached: true });
	});

	it("wait on every GUI agent with no ids, there being no self to leave out", async () => {
		const { service } = setup();
		const waited = await viaSocket(
			service,
			["agent", "wait", "--all", "--timeout", "1"],
			outside,
		);
		const agents = (
			waited.data as { agents: { agentId: string }[] }
		).agents.map((one) => one.agentId);
		// The coordinator is an agent like any other to an outside caller.
		expect(agents).toContain("bbbb2222-0000");
		expect(agents).toContain("aaaa1111-0000");
	});

	it("are refused the terminal commands, which are an agent's own", async () => {
		const { service } = setup();
		for (const line of [
			["terminal", "open"],
			["terminal", "status"],
			["terminal", "close"],
			["terminal", "panes"],
			["terminal", "bring", "%7"],
		]) {
			await expect(viaSocket(service, line, desktop)).rejects.toThrow(
				"terminal commands work only from inside a DevHub agent",
			);
		}
	});

	it("still cannot answer a permission prompt, and answer a question as their label", async () => {
		const { service, conversation } = setup();
		await expect(
			viaSocket(
				service,
				["agent", "answer", "aaaa", "req-2", "--option", "1"],
				desktop,
			),
		).rejects.toThrow();
		expect(conversation.answered.map((one) => one.request)).not.toContain(
			"req-2",
		);
		await viaSocket(
			service,
			["agent", "answer", "aaaa", "req-1", "--option", "1"],
			desktop,
		);
		expect(JSON.stringify(conversation.answered)).toContain(
			"answered via devhub CLI by claude-desktop",
		);
	});

	it("take --as only outside DevHub, and a label that is a name", () => {
		expect(() =>
			tellCaller("local\tw1\taaaa1111-0000", undefined, "me"),
		).toThrow(/--as is for callers DevHub did not start/u);
		expect(
			parseTellArguments(["--as", "claude-desktop", "--json", "agents"]),
		).toEqual({
			kind: "tell",
			command: { verb: "agents" },
			json: true,
			as: "claude-desktop",
		});
		expect(parseTellArguments(["--as", "has space", "agents"]).kind).toBe(
			"invalid",
		);
		// And across the socket, checked again on the app's side.
		const request = parseControlRequest(
			JSON.stringify({
				kind: "tell",
				command: { verb: "agents" },
				as: "claude-desktop",
			}),
		);
		expect(request).toMatchObject({ kind: "tell", as: "claude-desktop" });
		expect(() =>
			parseControlRequest(
				JSON.stringify({
					kind: "tell",
					command: { verb: "agents" },
					as: "a b",
				}),
			),
		).toThrow(/--as takes a name/u);
	});
});

describe("a request of several questions, answered in one call", () => {
	const option = (label: string) => ({
		label,
		description: "",
		preview: undefined,
	});
	const ask = (
		id: string,
		header: string,
		labels: readonly string[],
		more: Partial<Question> = {},
	): Question => ({
		id,
		header,
		text: `${header}?`,
		options: labels.map(option),
		multiSelect: false,
		allowsOther: true,
		...more,
	});
	const four: Question[] = [
		ask("q-db", "Database", ["Postgres", "SQLite"]),
		ask("q-lang", "Language", ["TypeScript", "Go", "Rust"], {
			multiSelect: true,
		}),
		ask("q-ci", "CI", ["GitHub Actions", "None"], { allowsOther: false }),
		ask("q-name", "Name", []),
	];
	const asking = (questions: readonly Question[]): PendingRequest => ({
		id: "req-9" as RequestId,
		entry: undefined,
		subject: { kind: "question", questions },
		choices: [],
	});
	const answerLine = (...words: string[]) => [
		"agent",
		"answer",
		"aaaa",
		"req-9",
		...words,
	];

	it("answers two questions, each with its own --q", async () => {
		const { service, conversation } = setup();
		conversation.pending = [asking(four.slice(0, 2))];
		await viaSocket(
			service,
			answerLine(
				"--q",
				"1",
				"--option",
				"2",
				"--q",
				"Language",
				"--option",
				"1",
				"--option",
				"3",
			),
			coordinator,
		);
		expect(conversation.answered).toEqual([
			{
				request: "req-9",
				answer: {
					kind: "answers",
					values: { "q-db": "SQLite", "q-lang": ["TypeScript", "Rust"] },
					notes: {
						"q-db": "answered via devhub CLI by Coordinator (bbbb2222-0000)",
						"q-lang": "answered via devhub CLI by Coordinator (bbbb2222-0000)",
					},
				},
			},
		]);
	});

	it("answers four, with a multi-select plus Other and words for the one with no options", async () => {
		const { service, conversation } = setup();
		conversation.pending = [asking(four)];
		await viaSocket(
			service,
			answerLine(
				"--q",
				"q-db",
				"--text",
				"MySQL, as it is today",
				"--q",
				"2",
				"--option",
				"2",
				"--text",
				"Zig",
				"--q",
				"ci",
				"--option",
				"1",
				"--q",
				"4",
				"--text",
				"widget",
			),
			coordinator,
		);
		expect(conversation.answered[0]!.answer).toMatchObject({
			values: {
				"q-db": "MySQL, as it is today",
				"q-lang": ["Go", "Zig"],
				"q-ci": "GitHub Actions",
				"q-name": "widget",
			},
		});
	});

	it("names the question left out, and the one that cannot take words, and sends nothing", async () => {
		const { service, conversation } = setup();
		conversation.pending = [asking(four)];
		await expect(
			viaSocket(
				service,
				answerLine("--q", "1", "--option", "1", "--q", "2", "--option", "1"),
				coordinator,
			),
		).rejects.toThrow(
			'every question must be answered; question 3 ("CI"), question 4 ("Name") have no --q.',
		);
		await expect(
			viaSocket(
				service,
				answerLine(
					"--q",
					"1",
					"--option",
					"1",
					"--q",
					"2",
					"--option",
					"1",
					"--q",
					"3",
					"--text",
					"Jenkins",
					"--q",
					"4",
					"--text",
					"w",
				),
				coordinator,
			),
		).rejects.toThrow(
			'question 3 ("CI") takes one of its options, not words of its own.',
		);
		await expect(
			viaSocket(
				service,
				answerLine(
					"--q",
					"1",
					"--option",
					"1",
					"--option",
					"2",
					"--q",
					"2",
					"--option",
					"1",
					"--q",
					"3",
					"--option",
					"1",
					"--q",
					"4",
					"--text",
					"w",
				),
				coordinator,
			),
		).rejects.toThrow('question 1 ("Database") takes one answer');
		await expect(
			viaSocket(service, answerLine("--q", "7", "--option", "1"), coordinator),
		).rejects.toThrow(/--q 7 is none of this request's questions/u);
		expect(conversation.answered).toEqual([]);
		expect(
			parseTellArguments(
				answerLine("--option", "1", "--q", "1", "--option", "1"),
			),
		).toEqual({
			kind: "invalid",
			message:
				"with --q, every --option and --text goes after the --q of its question.",
		});
		expect(parseTellArguments(answerLine("--q", "1"))).toEqual({
			kind: "invalid",
			message: "--q 1 needs --option <n> or --text <t> after it.",
		});
	});

	it("lists each question with what --q takes, its options and whether it takes several", async () => {
		const { service, conversation } = setup();
		conversation.pending = [asking(four.slice(0, 3)), permission];
		const listed = await viaSocket(
			service,
			["agent", "requests", "aaaa"],
			coordinator,
		);
		expect(listed.message).toBe(
			[
				"req-9  questions (3, answer every one)",
				"  --q 1  Database: Database?  [one answer, or --text]",
				"    1. Postgres",
				"    2. SQLite",
				"  --q 2  Language: Language?  [multiSelect: several --option, or --text]",
				"    1. TypeScript",
				"    2. Go",
				"    3. Rust",
				"  --q 3  CI: CI?  [one answer]",
				"    1. GitHub Actions",
				"    2. None",
				"  answer: agent answer <a> req-9 --q 1 --option <n> --q 2 --option <n> --q 3 --option <n>",
				"",
				"req-2  a permission prompt: Bash: rm -rf build\n  (answer in DevHub)",
			].join("\n"),
		);
		const data = listed.data as {
			requests: {
				questions?: { index: number; id: string; multiSelect: boolean }[];
			}[];
		};
		expect(
			data.requests[0]!.questions!.map((one) => [
				one.index,
				one.id,
				one.multiSelect,
			]),
		).toEqual([
			[1, "q-db", false],
			[2, "q-lang", true],
			[3, "q-ci", false],
		]);
	});

	it("still answers the single-question form, and never a permission prompt", async () => {
		const { service, conversation } = setup();
		await viaSocket(
			service,
			["agent", "answer", "aaaa", "req-1", "--option", "1"],
			coordinator,
		);
		expect(conversation.answered).toHaveLength(1);
		await expect(
			viaSocket(
				service,
				["agent", "answer", "aaaa", "req-2", "--q", "1", "--option", "1"],
				coordinator,
			),
		).rejects.toThrow(/only questions can be answered/u);
		expect(conversation.answered).toHaveLength(1);
	});
});
