/**
 * The app's answer to `devhub --tell`.
 *
 * Everything here is phrased against `TellPorts`, which the app controller
 * implements with the very calls its own window makes (`appController.ts`,
 * `tellPorts`), so a command line and a click cannot disagree about what an
 * operation means. This file only resolves names to ids, enforces what a
 * command line may not do, and words the answer twice: as a sentence for a
 * person, and as data for `--json`.
 */

import type {
	PendingRequest,
	Question,
	RequestAnswer,
	TranscriptEntry,
} from "../../../model/conversation.js";
import { TELL_USAGE, type TellCommand } from "./command.js";

export interface TellAgent {
	readonly id: string;
	readonly name: string;
	readonly workspaceId: string;
	readonly profileId: string;
	/** `claude`, `codex`, or the profile's other kind. */
	readonly kind: string;
	readonly presentation: "gui" | "tui";
	/** working, background, waiting, idle, error, unknown. */
	readonly status: string;
	readonly unread: string | undefined;
	readonly activity: string | undefined;
}

export interface TellWorkspace {
	readonly id: string;
	readonly name: string;
	readonly root: string;
	/** `local`, or `ssh:<host>`. */
	readonly machine: string;
	readonly scratch: boolean;
	readonly selected: boolean;
	readonly branch: string | undefined;
	/** The main checkout, when this workspace is a worktree of one. */
	readonly worktreeOf: string | undefined;
	readonly repositoryUrl: string | undefined;
	readonly issue: string | undefined;
	/** The dev container the editor is attached to, when it is. */
	readonly container: string | undefined;
	readonly agents: readonly TellAgent[];
}

/** One GUI Agent's conversation, as far as a command line reaches into it. */
export interface TellConversation {
	entries(): readonly TranscriptEntry[];
	requests(): readonly PendingRequest[];
	/** `none`, `running`, `rewinding`, `connecting` or `broken`. */
	turn(): string;
	/** The person's words, held while a turn runs — the composer's own path. */
	submit(text: string): Promise<void>;
	interrupt(): Promise<void>;
	answer(request: string, answer: RequestAnswer): Promise<void>;
}

export interface IssueAssignRequest {
	readonly url: string;
	readonly repo: string | undefined;
	readonly branch: string | undefined;
	readonly place: "worktree" | "root";
	readonly profile: string | undefined;
	readonly action: string | undefined;
	readonly editorOnly: boolean;
	readonly presentation: "gui" | "tui" | undefined;
}

export interface TellPorts {
	workspaces(): readonly TellWorkspace[];
	profiles(): readonly { readonly id: string; readonly kind: string }[];
	/** Open (or select) the folder; answers the workspace's id. */
	openWorkspace(
		path: string,
		machine: string,
		worktree?: string,
	): Promise<string>;
	/** Start an Agent; answers its id. */
	createAgent(
		workspaceId: string,
		profileId: string,
		presentation: "gui" | "tui" | undefined,
	): Promise<string>;
	renameAgent(agentId: string, name: string): Promise<void>;
	/**
	 * Queue words for an Agent: sent once it is idle, through the same queue
	 * DevHub's own injections go through. The one way to reach a terminal Agent.
	 */
	queueText(agentId: string, text: string): void;
	assignIssue(request: IssueAssignRequest): Promise<{
		readonly workspaceId: string;
		readonly agentId: string | undefined;
	}>;
	/** A GUI Agent's conversation; undefined for a terminal Agent. */
	conversation(agentId: string): Promise<TellConversation | undefined>;
	commands(): readonly {
		readonly id: string;
		readonly label: string;
		readonly category: string;
		readonly available: boolean;
	}[];
	/** Run a palette command the way the palette does; false if it had nothing to do. */
	runCommand(id: string): boolean;
	focusWorkspace(workspaceId: string): Promise<void>;
	focusAgent(agentId: string): Promise<void>;
	notify(text: string): void;
}

/** Which Agent is asking, from its pane's `DEVHUB_ORIGIN`. */
export interface TellCaller {
	readonly machine: string;
	readonly agentId: string | undefined;
	readonly workspaceId: string | undefined;
	/** Known only by `DEVHUB_MACHINE`: not a DevHub pane, so no workspace or agent. */
	readonly paneless?: true;
}

export interface TellAnswer {
	readonly message: string;
	readonly data: unknown;
}

export interface TellClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: TellClock = {
	now: () => Date.now(),
	sleep: (ms) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		}),
};

const WAIT_POLL_MS = 500;
const DEFAULT_READ_LAST = 20;
/** The longest a transcript line gets in text: a tool's output is a summary. */
const LINE_LIMIT = 2000;

/** `<machine>\t<workspace | "scratch">\t<agent | "none">`, as tmux.ts writes it. */
export function callerFromOrigin(
	origin: string | undefined,
): TellCaller | undefined {
	if (origin === undefined) return undefined;
	const [machine, workspace, agent] = origin.split("\t");
	if (machine === undefined || workspace === undefined || agent === undefined)
		return undefined;
	return {
		machine,
		workspaceId: workspace === "scratch" ? undefined : workspace,
		agentId: agent === "none" ? undefined : agent,
	};
}

/**
 * Who is asking, from both things a request can carry: the pane's
 * `DEVHUB_ORIGIN` (machine, workspace, agent) and the shim's `DEVHUB_MACHINE`.
 * The origin wins where it is there; a `devhub` on a host run from somewhere
 * that is not a DevHub pane — an Agent's own subshell that dropped the
 * variable, a script — still says which machine its paths are on.
 */
export function tellCaller(
	origin: string | undefined,
	machine: string | undefined,
): TellCaller | undefined {
	const fromOrigin = callerFromOrigin(origin);
	if (fromOrigin !== undefined) return fromOrigin;
	if (machine === undefined || machine.length === 0) return undefined;
	return {
		machine,
		agentId: undefined,
		workspaceId: undefined,
		paneless: true,
	};
}

export class TellService {
	/** The caller of the command being run, for the names it uses. */
	private caller: TellCaller | undefined;

	constructor(
		private readonly ports: TellPorts,
		private readonly clock: TellClock = REAL_CLOCK,
	) {}

	async run(
		command: TellCommand,
		caller: TellCaller | undefined,
	): Promise<TellAnswer> {
		this.caller = caller;
		switch (command.verb) {
			case "help":
				return { message: TELL_USAGE, data: { usage: TELL_USAGE } };
			case "workspaces":
				return this.listWorkspaces();
			case "workspace-open":
				return this.openWorkspace(command.path, command.worktree, caller);
			case "agents":
				return this.listAgents(command.workspace);
			case "agent-new":
				return this.newAgent(command);
			case "issue-assign":
				return this.assignIssue(command);
			case "agent-read":
				return this.read(command.agent, command.last, command.since);
			case "agent-send":
				return this.send(command.agent, command.text);
			case "agent-interrupt":
				return this.interrupt(command.agent);
			case "agent-requests":
				return this.requests(command.agent);
			case "agent-answer":
				return this.answer(command, caller);
			case "agent-wait":
				return this.wait(command.agent, command.until, command.timeoutSeconds);
			case "commands":
				return this.listCommands();
			case "run":
				return this.runCommand(command.command);
			case "focus":
				return this.focus(command.target);
			case "notify":
				this.ports.notify(command.text);
				return { message: "Shown in DevHub.", data: { ok: true } };
		}
	}

	// --- names -------------------------------------------------------------

	/** `<w>` as given, or the workspace of the pane asking when it is left out. */
	private workspaceOrCallers(name: string | undefined): string {
		if (name !== undefined) return name;
		if (this.caller !== undefined && this.caller.paneless !== true)
			return this.caller.workspaceId ?? "scratch";
		throw new Error(
			"agent new needs --workspace <w> here: this devhub is not running in a DevHub terminal or agent, so there is no workspace to default to.",
		);
	}

	private workspace(name: string): TellWorkspace {
		const all = this.ports.workspaces();
		if (name === "scratch") {
			const scratch = all.find((workspace) => workspace.scratch);
			if (scratch) return scratch;
		}
		const trimmed = name.length > 1 ? name.replace(/\/+$/, "") : name;
		// A folder is a folder on the machine the asking `devhub` runs on:
		// `/srv/app` typed on a host is not this Mac's `/srv/app`. A caller
		// that cannot say which machine it is on matches any.
		const machine = this.caller?.machine;
		const exact = all.filter(
			(workspace) =>
				workspace.id === name ||
				(workspace.root === trimmed &&
					(machine === undefined || workspace.machine === machine)) ||
				workspace.name === name,
		);
		if (exact.length === 1) return exact[0]!;
		if (exact.length > 1)
			throw new Error(
				`${JSON.stringify(name)} names ${String(exact.length)} workspaces; use an id: ${exact.map((workspace) => workspace.id).join(", ")}.`,
			);
		const prefixed = all.filter(
			(workspace) => name.length >= 4 && workspace.id.startsWith(name),
		);
		if (prefixed.length === 1) return prefixed[0]!;
		throw new Error(
			`no open workspace is called ${JSON.stringify(name)}. Run 'devhub --tell workspaces' to see them.`,
		);
	}

	private agent(name: string): TellAgent {
		const all = this.ports
			.workspaces()
			.flatMap((workspace) => workspace.agents);
		const exact = all.filter(
			(agent) => agent.id === name || agent.name === name,
		);
		if (exact.length === 1) return exact[0]!;
		if (exact.length > 1)
			throw new Error(
				`${JSON.stringify(name)} names ${String(exact.length)} agents; use an id: ${exact.map((agent) => agent.id).join(", ")}.`,
			);
		const prefixed = all.filter(
			(agent) => name.length >= 4 && agent.id.startsWith(name),
		);
		if (prefixed.length === 1) return prefixed[0]!;
		if (prefixed.length > 1)
			throw new Error(
				`${JSON.stringify(name)} is the start of more than one agent's id.`,
			);
		throw new Error(
			`no agent is called ${JSON.stringify(name)}. Run 'devhub --tell agents' to see them.`,
		);
	}

	private profile(id: string | undefined): string {
		const profiles = this.ports.profiles();
		if (id === undefined) {
			const first = profiles[0];
			if (!first) throw new Error("no agent profiles are configured.");
			return first.id;
		}
		if (!profiles.some((profile) => profile.id === id))
			throw new Error(
				`there is no agent profile called '${id}'. Configured profiles: ${profiles.map((profile) => profile.id).join(", ") || "none"}.`,
			);
		return id;
	}

	private async guiConversation(agent: TellAgent): Promise<TellConversation> {
		const conversation =
			agent.presentation === "gui"
				? await this.ports.conversation(agent.id)
				: undefined;
		if (!conversation)
			throw new Error(
				`${agent.name} is a terminal agent, and only a GUI agent's conversation can be read or answered from here. 'agent send' and 'agent wait' work for both.`,
			);
		return conversation;
	}

	// --- workspaces -------------------------------------------------------

	private listWorkspaces(): TellAnswer {
		const workspaces = this.ports.workspaces();
		const lines = workspaces.map((workspace) => {
			const facts = [
				workspace.machine === "local" ? undefined : workspace.machine,
				workspace.branch === undefined
					? undefined
					: `branch ${workspace.branch}`,
				workspace.worktreeOf === undefined
					? undefined
					: `worktree of ${workspace.worktreeOf}`,
				workspace.issue,
				workspace.container === undefined
					? undefined
					: `container ${workspace.container}`,
				`${String(workspace.agents.length)} agent${workspace.agents.length === 1 ? "" : "s"}`,
			].filter((fact) => fact !== undefined);
			return `${workspace.selected ? "*" : " "} ${workspace.id}  ${workspace.scratch ? "Scratch" : workspace.name}  ${workspace.root}  (${facts.join(", ")})`;
		});
		return {
			message:
				lines.length === 0 ? "No workspaces are open." : lines.join("\n"),
			data: {
				workspaces: workspaces.map(({ agents, ...workspace }) => ({
					...workspace,
					agents: agents.map((agent) => agent.id),
				})),
			},
		};
	}

	private async openWorkspace(
		path: string,
		worktree: string | undefined,
		caller: TellCaller | undefined,
	): Promise<TellAnswer> {
		// The path is a path on the machine the asking `devhub` runs on.
		const machine = caller?.machine ?? "local";
		const id = await this.ports.openWorkspace(path, machine, worktree);
		const workspace = this.ports.workspaces().find((each) => each.id === id);
		return {
			message: `Workspace ${id} is open at ${workspace?.root ?? path}.`,
			data: { workspaceId: id, root: workspace?.root ?? path },
		};
	}

	// --- agents -----------------------------------------------------------

	private async requestCount(agent: TellAgent): Promise<number | undefined> {
		if (agent.presentation !== "gui") return undefined;
		try {
			return (await this.ports.conversation(agent.id))?.requests().length;
		} catch {
			return undefined;
		}
	}

	private async listAgents(workspace: string | undefined): Promise<TellAnswer> {
		const workspaces =
			workspace === undefined
				? this.ports.workspaces()
				: [this.workspace(workspace)];
		const rows = await Promise.all(
			workspaces.flatMap((each) =>
				each.agents.map(async (agent) => ({
					...agent,
					workspace: each.scratch ? "Scratch" : each.name,
					requests: await this.requestCount(agent),
				})),
			),
		);
		const lines = rows.map((row) =>
			[
				row.id,
				row.name,
				`${row.kind}/${row.presentation}`,
				row.status,
				row.unread === undefined ? undefined : "unread",
				row.requests ? `${String(row.requests)} request(s)` : undefined,
				`in ${row.workspace}`,
				row.activity === undefined ? undefined : `— ${row.activity}`,
			]
				.filter((part) => part !== undefined)
				.join("  "),
		);
		return {
			message: lines.length === 0 ? "No agents are running." : lines.join("\n"),
			data: { agents: rows },
		};
	}

	private async newAgent(
		command: Extract<TellCommand, { verb: "agent-new" }>,
	): Promise<TellAnswer> {
		const workspace = this.workspace(
			this.workspaceOrCallers(command.workspace),
		);
		const profile = this.profile(command.profile);
		const agentId = await this.ports.createAgent(
			workspace.id,
			profile,
			command.presentation,
		);
		if (command.name !== undefined)
			await this.ports.renameAgent(agentId, command.name);
		if (command.prompt !== undefined)
			this.ports.queueText(agentId, command.prompt);
		return {
			message: `Agent ${agentId} (${profile}) is starting in ${workspace.root}${command.prompt === undefined ? "" : "; it is told the prompt once it is ready"}.`,
			data: { agentId, workspaceId: workspace.id, profile },
		};
	}

	private async assignIssue(
		command: Extract<TellCommand, { verb: "issue-assign" }>,
	): Promise<TellAnswer> {
		const profile = command.editorOnly
			? undefined
			: this.profile(command.profile);
		const assigned = await this.ports.assignIssue({
			url: command.url,
			repo: command.repo,
			branch: command.branch,
			place: command.place,
			profile,
			action: command.action,
			editorOnly: command.editorOnly,
			presentation: command.presentation,
		});
		if (command.prompt !== undefined && assigned.agentId !== undefined)
			this.ports.queueText(assigned.agentId, command.prompt);
		const workspace = this.ports
			.workspaces()
			.find((each) => each.id === assigned.workspaceId);
		return {
			message:
				assigned.agentId === undefined
					? `Opened ${workspace?.root ?? "the workspace"} for ${command.url}.`
					: `Agent ${assigned.agentId} is taking ${command.url} in ${workspace?.root ?? "its workspace"}.`,
			data: { ...assigned, root: workspace?.root },
		};
	}

	// --- one agent ----------------------------------------------------------

	private async read(
		name: string,
		last: number | undefined,
		since: string | undefined,
	): Promise<TellAnswer> {
		const agent = this.agent(name);
		const conversation = await this.guiConversation(agent);
		const entries = conversation.entries();
		let from = Math.max(0, entries.length - (last ?? DEFAULT_READ_LAST));
		if (since !== undefined) {
			const at = entries.findIndex((entry) => entry.id === since);
			// A cursor that is gone (a rewind, a compaction) reads from the tail.
			if (at >= 0) from = at + 1;
			if (last !== undefined) from = Math.max(from, entries.length - last);
		}
		const shown = entries.slice(from);
		const cursor = entries.at(-1)?.id ?? since ?? "";
		const lines = shown.map(entryLine).filter((line) => line !== undefined);
		const requests = conversation.requests().length;
		return {
			message: [
				...lines,
				`-- ${agent.name}: ${agent.status}, turn ${conversation.turn()}${requests > 0 ? `, ${String(requests)} open request(s)` : ""}; cursor ${cursor}`,
			].join("\n"),
			data: {
				agentId: agent.id,
				status: agent.status,
				turn: conversation.turn(),
				requests,
				cursor,
				entries: shown.map((entry) => ({
					id: entry.id,
					kind: entry.kind,
					text: entryLine(entry),
				})),
			},
		};
	}

	private async send(name: string, text: string): Promise<TellAnswer> {
		const agent = this.agent(name);
		if (agent.presentation === "gui") {
			const conversation = await this.guiConversation(agent);
			await conversation.submit(text);
			return {
				message: `Sent to ${agent.name}${conversation.turn() === "running" ? " (held until its turn ends)" : ""}.`,
				data: { agentId: agent.id, queued: conversation.turn() === "running" },
			};
		}
		this.ports.queueText(agent.id, text);
		return {
			message: `Queued for ${agent.name}; it is typed once the agent is idle.`,
			data: { agentId: agent.id, queued: true },
		};
	}

	private async interrupt(name: string): Promise<TellAnswer> {
		const agent = this.agent(name);
		const conversation = await this.guiConversation(agent);
		await conversation.interrupt();
		return {
			message: `Interrupted ${agent.name}.`,
			data: { agentId: agent.id },
		};
	}

	private async requests(name: string): Promise<TellAnswer> {
		const agent = this.agent(name);
		const conversation = await this.guiConversation(agent);
		const requests = conversation.requests().map(requestView);
		return {
			message:
				requests.length === 0
					? `${agent.name} is not waiting on anything.`
					: requests.map((request) => request.text).join("\n\n"),
			data: { agentId: agent.id, requests },
		};
	}

	private async answer(
		command: Extract<TellCommand, { verb: "agent-answer" }>,
		caller: TellCaller | undefined,
	): Promise<TellAnswer> {
		const agent = this.agent(command.agent);
		if (caller?.agentId !== undefined && caller.agentId === agent.id)
			throw new Error("an agent cannot answer its own question.");
		const conversation = await this.guiConversation(agent);
		const request = conversation
			.requests()
			.find((each) => each.id === command.request);
		if (!request)
			throw new Error(
				`${agent.name} has no open request ${command.request}. Run 'devhub --tell agent requests ${agent.id}'.`,
			);
		if (request.subject.kind !== "question")
			throw new Error(
				`request ${command.request} is ${requestKind(request)}, and only questions can be answered from the command line. The person answers it in DevHub.`,
			);
		const answer = questionAnswer(
			request.subject.questions,
			command.options,
			command.text,
			answeredBy(caller, this.ports.workspaces()),
		);
		await conversation.answer(request.id, answer);
		return {
			message: `Answered ${agent.name}'s question.`,
			data: { agentId: agent.id, request: request.id, answer },
		};
	}

	private async wait(
		name: string,
		until: "idle" | "waiting" | "any",
		timeoutSeconds: number,
	): Promise<TellAnswer> {
		const id = this.agent(name).id;
		const deadline = this.clock.now() + timeoutSeconds * 1000;
		for (;;) {
			const agent = this.ports
				.workspaces()
				.flatMap((workspace) => workspace.agents)
				.find((each) => each.id === id);
			if (!agent)
				return {
					message: `Agent ${id} is gone.`,
					data: { agentId: id, status: "gone", reached: true },
				};
			const requests = (await this.requestCount(agent)) ?? 0;
			const waiting = agent.status === "waiting" || requests > 0;
			const idle = agent.status === "idle" || agent.status === "error";
			const reached =
				until === "idle"
					? idle
					: until === "waiting"
						? waiting
						: idle || waiting;
			if (reached || this.clock.now() >= deadline)
				return {
					message: `${agent.name} is ${agent.status}${requests > 0 ? ` with ${String(requests)} open request(s)` : ""}${reached ? "" : ` (still, after ${String(timeoutSeconds)}s)`}.`,
					data: { agentId: id, status: agent.status, requests, reached },
				};
			await this.clock.sleep(WAIT_POLL_MS);
		}
	}

	// --- the app ------------------------------------------------------------

	private listCommands(): TellAnswer {
		const commands = this.ports.commands();
		return {
			message: commands
				.map(
					(command) =>
						`${command.available ? " " : "-"} ${command.id}  ${command.category}: ${command.label}`,
				)
				.join("\n"),
			data: { commands },
		};
	}

	private runCommand(id: string): TellAnswer {
		const known = this.ports.commands().find((command) => command.id === id);
		if (!known)
			throw new Error(
				`there is no command ${JSON.stringify(id)}. Run 'devhub --tell commands'.`,
			);
		const ran = this.ports.runCommand(id);
		return {
			message: ran
				? `Ran ${known.category}: ${known.label}.`
				: `${known.category}: ${known.label} has nothing to do right now.`,
			data: { command: id, ran },
		};
	}

	private async focus(target: string): Promise<TellAnswer> {
		let agent: TellAgent | undefined;
		try {
			agent = this.agent(target);
		} catch {
			agent = undefined;
		}
		if (agent) {
			await this.ports.focusAgent(agent.id);
			return {
				message: `Selected ${agent.name}.`,
				data: { agentId: agent.id },
			};
		}
		const workspace = this.workspace(target);
		await this.ports.focusWorkspace(workspace.id);
		return {
			message: `Selected ${workspace.scratch ? "Scratch" : workspace.name}.`,
			data: { workspaceId: workspace.id },
		};
	}
}

// --- words ------------------------------------------------------------------

function clip(text: string): string {
	const flat = text.trim();
	return flat.length > LINE_LIMIT ? `${flat.slice(0, LINE_LIMIT)}…` : flat;
}

/** One transcript entry, as a line or two of text. */
export function entryLine(entry: TranscriptEntry): string | undefined {
	switch (entry.kind) {
		case "user":
			return `> ${clip(entry.text)}`;
		case "answer":
			return `> (answered) ${entry.answers
				.map((answer) =>
					[
						answer.question,
						"→",
						[...answer.chosen, answer.written ?? ""].filter(Boolean).join(", "),
					].join(" "),
				)
				.join("; ")}`;
		case "command":
			return `$ ${entry.line ?? ""}${entry.output === undefined ? "" : `\n${clip(entry.output)}`}`;
		case "assistant": {
			const text = entry.blocks
				.filter((block) => block.kind === "text")
				.map((block) => block.markdown)
				.join("\n");
			return text.trim().length === 0 ? undefined : clip(text);
		}
		case "tool":
			return `[${entry.tool}] ${clip(entry.title)} (${entry.status})`;
		case "notice":
			return `! ${clip(entry.text)}`;
		case "compaction":
			return "-- compacted --";
		case "turn-end":
			return `-- turn ${entry.outcome}${entry.detail === undefined ? "" : `: ${clip(entry.detail)}`} --`;
	}
}

function requestKind(request: PendingRequest): string {
	switch (request.subject.kind) {
		case "question":
			return "a question";
		case "elicitation":
			return `an MCP server's request (${request.subject.server})`;
		default:
			return "a permission prompt";
	}
}

/** A request as `agent requests` shows it. Permission prompts are listed, not offered. */
export function requestView(request: PendingRequest): {
	readonly id: string;
	readonly kind: string;
	readonly answerable: boolean;
	readonly questions?: readonly {
		readonly header: string;
		readonly text: string;
		readonly multiSelect: boolean;
		readonly allowsOther: boolean;
		readonly options: readonly {
			readonly n: number;
			readonly label: string;
			readonly description: string;
		}[];
	}[];
	readonly text: string;
} {
	const subject = request.subject;
	if (subject.kind !== "question") {
		const what =
			subject.kind === "tool"
				? `${subject.tool}: ${subject.title}`
				: subject.kind === "command"
					? `run ${subject.command}`
					: subject.kind === "file-change"
						? `change ${subject.files.map((file) => file.path).join(", ")}`
						: subject.message;
		return {
			id: request.id,
			kind: subject.kind,
			answerable: false,
			text: `${request.id}  ${requestKind(request)}: ${clip(what)}\n  (answer in DevHub)`,
		};
	}
	const questions = subject.questions.map((question) => ({
		header: question.header,
		text: question.text,
		multiSelect: question.multiSelect,
		allowsOther: question.allowsOther,
		options: question.options.map((option, index) => ({
			n: index + 1,
			label: option.label,
			description: option.description,
		})),
	}));
	return {
		id: request.id,
		kind: "question",
		answerable: true,
		questions,
		text: [
			`${request.id}  question`,
			...questions.flatMap((question, index) => [
				`  ${subject.questions.length > 1 ? `[${String(index + 1)}] ` : ""}${question.header}: ${question.text}${question.multiSelect ? " (several)" : ""}`,
				...question.options.map(
					(option) =>
						`    ${String(option.n)}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
				),
				...(question.allowsOther ? ["    (or --text <your own answer>)"] : []),
			]),
		].join("\n"),
	};
}

/**
 * The answer to a question request, built from option numbers and words.
 *
 * Options number the questions' options in order across all of them — for
 * the usual single question that is simply 1…n. Every question must get an
 * answer, as the window's card requires.
 */
export function questionAnswer(
	questions: readonly Question[],
	options: readonly number[],
	text: string | undefined,
	note: string,
): RequestAnswer {
	const values: Record<string, string | readonly string[]> = {};
	const notes: Record<string, string> = {};
	const total = questions.reduce((sum, each) => sum + each.options.length, 0);
	if (options.some((n) => n < 1 || n > total))
		throw new Error(`there are ${String(total)} options to choose from.`);
	let offset = 0;
	for (const question of questions) {
		const chosen = options
			.filter((n) => n > offset && n <= offset + question.options.length)
			.map((n) => question.options[n - offset - 1]!.label);
		offset += question.options.length;
		const written = questions.length === 1 ? text : undefined;
		if (written !== undefined && !question.allowsOther && chosen.length === 0)
			throw new Error(
				`"${question.header}" takes one of its options, not words of its own.`,
			);
		const given = [...chosen, ...(written === undefined ? [] : [written])];
		if (given.length === 0)
			throw new Error(
				`"${question.header}" has no answer; choose with --option <n>.`,
			);
		if (!question.multiSelect && given.length > 1)
			throw new Error(`"${question.header}" takes one answer.`);
		values[question.id] = question.multiSelect ? given : given[0]!;
		notes[question.id] = note;
	}
	return { kind: "answers", values, notes };
}

/** "answered via devhub CLI by <agent>", the line the target's transcript keeps. */
export function answeredBy(
	caller: TellCaller | undefined,
	workspaces: readonly TellWorkspace[],
): string {
	const agent =
		caller?.agentId === undefined
			? undefined
			: workspaces
					.flatMap((workspace) => workspace.agents)
					.find((each) => each.id === caller.agentId);
	const who =
		agent !== undefined
			? `${agent.name} (${agent.id})`
			: caller?.agentId !== undefined
				? caller.agentId
				: "a terminal outside any agent";
	return `answered via devhub CLI by ${who}`;
}
