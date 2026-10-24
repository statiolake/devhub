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

/**
 * One tmux pane inside an Agent's terminal, read live. The session starts
 * with one; the person may have split it, or opened windows, with tmux's own
 * keys. Everything is on the Workspace's machine — the machine the asking
 * Agent runs on — so the paths are paths there.
 */
export interface TellTerminalPane {
	/** tmux's window id (`@3`), index and name. */
	readonly window: string;
	readonly windowIndex: number;
	readonly windowName: string;
	/** The window is the one the session shows. */
	readonly windowActive: boolean;
	/** tmux's pane id (`%7`): unique on the server, the target to use. */
	readonly pane: string;
	readonly paneIndex: number;
	/** Its window's active pane, in the session's active window. */
	readonly active: boolean;
	/** Where it is in its window, in cells from the top left. */
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	readonly cwd: string;
	/** The foreground process, as tmux names it: the shell at a prompt. */
	readonly command: string;
	readonly title: string;
	readonly dead: boolean;
}

/**
 * One pane of the asking Agent's Workspace's editor terminals: the tmux
 * session the editor's DevHub terminal tabs attach to, on the same server.
 */
export interface TellEditorPane extends TellTerminalPane {
	readonly session: string;
	/** What its terminal runs in front, as a command line (`ssh prod`), when known. */
	readonly argv: string | undefined;
}

/** The asking Agent's own terminal, as the app knows it now. */
export interface TellTerminal {
	readonly agentId: string;
	readonly workspaceId: string;
	/** Its session is up. Absent: it has none yet, or it was closed. */
	readonly session:
		| {
				readonly id: string;
				/** `tm-<id>`. */
				readonly name: string;
				/** Its pane is shown when its Agent is the view's. */
				readonly open: boolean;
				/**
				 * It is on screen now: open, and its Agent is on screen with it —
				 * full (the terminal right of it) or beside its workbench (under
				 * it). Never with the workbench alone.
				 */
				readonly visible: boolean;
				/** It has the person's keyboard. */
				readonly focused: boolean;
				/** The live half, from tmux; absent when tmux could not be asked. */
				readonly tmux:
					| {
							/** The tmux DevHub runs there, which may not be the one on PATH. */
							readonly tmux: string;
							/** The server's socket, absolute: what `tmux -S` takes. */
							readonly socket: string;
							readonly panes: readonly TellTerminalPane[];
					  }
					| undefined;
		  }
		| undefined;
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
	/** An Agent's own terminal, read live. */
	agentTerminal(agentId: string): Promise<TellTerminal>;
	/**
	 * Open an Agent's terminal, or show the one it has (idempotent). Answers
	 * whether this call started its session; `command` is typed only then.
	 */
	openAgentTerminal(
		agentId: string,
		request: { readonly command: string | undefined; readonly focus: boolean },
	): Promise<{ readonly created: boolean }>;
	/** Close an Agent's terminal and its session; whether it had one. */
	closeAgentTerminal(agentId: string): Promise<boolean>;
	/** The panes of an Agent's Workspace's editor terminals, read live. */
	editorPanes(agentId: string): Promise<readonly TellEditorPane[]>;
	/**
	 * Move one of them (by tmux id) into the Agent's terminal, still running:
	 * the terminal opened with it in place of the fresh shell, or the pane
	 * added as a split of the open one. Shows it; the keyboard only on `focus`.
	 */
	bringPane(
		agentId: string,
		pane: string,
		focus: boolean,
	): Promise<{ readonly created: boolean }>;
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
			case "terminal-open":
				return this.openTerminal(command);
			case "terminal-status":
				return this.terminalStatus();
			case "terminal-close":
				return this.closeTerminal();
			case "terminal-panes":
				return this.editorPanes();
			case "terminal-bring":
				return this.bring(command.pane, command.focus);
		}
	}

	// --- terminals --------------------------------------------------------

	/**
	 * The Agent a terminal command is about: the asker itself, and no other.
	 * There is no `--agent` for these on purpose — the terminal beside its pane
	 * is the asking Agent's own, and reaching into another Agent's shell is not
	 * something one Agent may do to another.
	 */
	private callerAgent(): TellAgent {
		const caller = this.caller;
		if (caller === undefined || caller.paneless === true)
			throw new Error(
				"terminal commands work only from inside a DevHub agent: they are about the asking agent's own terminal, and this devhub is not running in one.",
			);
		if (caller.agentId === undefined)
			throw new Error(
				"terminal commands are an agent's: run them from the agent's own pane. (This is a terminal, not an agent.)",
			);
		for (const workspace of this.ports.workspaces()) {
			const agent = workspace.agents.find((one) => one.id === caller.agentId);
			if (agent) return agent;
		}
		throw new Error(
			`the agent asking (${caller.agentId}) is not one DevHub has open any more.`,
		);
	}

	private async openTerminal(
		command: Extract<TellCommand, { verb: "terminal-open" }>,
	): Promise<TellAnswer> {
		const agent = this.callerAgent();
		const { created } = await this.ports.openAgentTerminal(agent.id, {
			command: command.command,
			focus: command.focus,
		});
		const terminal = await this.ports.agentTerminal(agent.id);
		if (terminal.session === undefined)
			throw new Error(
				"the terminal opened and was gone again at once: its shell exited. Check --command.",
			);
		const described = describeTerminal(terminal);
		const notTyped =
			!created && command.command !== undefined
				? [
						"It was already running, so --command was not typed into it: send it with send-keys (below) if you still want it.",
					]
				: [];
		return {
			message: [
				`${created ? "Opened" : "Showing"} your terminal: ${terminalLine(described)}.`,
				...notTyped,
				...driveHints(described),
			].join("\n"),
			data: { terminal: described, created },
		};
	}

	private async terminalStatus(): Promise<TellAnswer> {
		const agent = this.callerAgent();
		const terminal = await this.ports.agentTerminal(agent.id);
		const described = describeTerminal(terminal);
		if (terminal.session === undefined)
			return {
				message:
					"You have no terminal open. 'devhub --tell terminal open' opens one, beside your pane.",
				data: { terminal: described },
			};
		return {
			message: [
				terminalLine(described),
				...paneLines(described),
				...driveHints(described),
			].join("\n"),
			data: { terminal: described },
		};
	}

	private async closeTerminal(): Promise<TellAnswer> {
		const agent = this.callerAgent();
		const before = await this.ports.agentTerminal(agent.id);
		const closed = await this.ports.closeAgentTerminal(agent.id);
		return {
			message: closed
				? `Closed your terminal (${before.session?.name ?? "its session"}).`
				: "You had no terminal open.",
			data: { closed, session: before.session?.name },
		};
	}

	private async editorPanes(): Promise<TellAnswer> {
		const agent = this.callerAgent();
		const panes = await this.ports.editorPanes(agent.id);
		return {
			message:
				panes.length === 0
					? "Your workspace's editor has no DevHub terminal open."
					: [
							"Your workspace's editor terminals ('devhub --tell terminal bring <pane>' moves one into your terminal):",
							...panes.map(editorPaneLine),
						].join("\n"),
			data: { panes },
		};
	}

	private async bring(paneId: string, focus: boolean): Promise<TellAnswer> {
		const agent = this.callerAgent();
		const panes = await this.ports.editorPanes(agent.id);
		const pane = panes.find((one) => one.pane === paneId);
		if (pane === undefined)
			throw new Error(
				`${paneId} is not a pane of your workspace's editor terminals (see 'devhub --tell terminal panes'). Agents' own panes and terminals are never moved.`,
			);
		const { created } = await this.ports.bringPane(agent.id, paneId, focus);
		const described = describeTerminal(
			await this.ports.agentTerminal(agent.id),
		);
		const left = panes.filter((one) => one.window === pane.window).length === 1;
		return {
			message: [
				`Brought ${paneId} (${pane.argv ?? pane.command}) ${created ? "into your new terminal" : "into your terminal, as a split"}: ${terminalLine(described)}.`,
				...(left
					? [
							"It was the only pane of its editor terminal window, so that window closed (and the editor's tab with it, if it was the last).",
						]
					: []),
				...paneLines(described),
				...driveHints(described),
			].join("\n"),
			data: { terminal: described, created, pane: paneId },
		};
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

/**
 * One tmux pane of the terminal as `--json` writes it, with what a person
 * calls it: `where` is its place in its window — `top-left`, `bottom-right`,
 * `right`, `whole` — so "the bottom-right pane" is a lookup, not a sum.
 */
export interface DescribedTerminalPane extends TellTerminalPane {
	readonly where: string;
	/** `-t` this. */
	readonly target: string;
	/** The same pane as `session:window.pane`. */
	readonly fullTarget: string;
}

/** The asking Agent's terminal as `--json` writes it: the handle to drive it by. */
export interface DescribedTerminal {
	readonly agentId: string;
	readonly workspaceId: string;
	/** It has a session. The rest is absent when it does not. */
	readonly exists: boolean;
	readonly id: string | undefined;
	readonly session: string | undefined;
	readonly open: boolean;
	readonly visible: boolean;
	readonly focused: boolean;
	/**
	 * The tmux handle, with the active pane as its target. Absent when there
	 * is no session or tmux could not be asked.
	 */
	readonly tmux:
		| {
				readonly tmux: string;
				readonly socket: string;
				readonly session: string;
				/** The active pane of the active window: the one the person sees typed into. */
				readonly window: string;
				readonly windowIndex: number;
				readonly pane: string;
				readonly paneIndex: number;
				/** `-t` this: the pane id, which nothing else on the server has. */
				readonly target: string;
				/** The same pane as `session:window.pane`. */
				readonly fullTarget: string;
				/** Every command starts with these: `tmux -S <socket>`. */
				readonly prefix: readonly string[];
				readonly cwd: string;
				readonly command: string;
				readonly title: string;
		  }
		| undefined;
	/** Every tmux pane in the session, every window's, in tmux's order. */
	readonly panes: readonly DescribedTerminalPane[];
}

/** `top-left`, `bottom`, `right`, `whole`: where a pane is in its window. */
export function paneWhere(
	pane: TellTerminalPane,
	window: readonly TellTerminalPane[],
): string {
	const right = Math.max(...window.map((one) => one.left + one.width));
	const bottom = Math.max(...window.map((one) => one.top + one.height));
	const minLeft = Math.min(...window.map((one) => one.left));
	const minTop = Math.min(...window.map((one) => one.top));
	const across = (start: number, size: number, min: number, end: number) => {
		const first = start <= min;
		const last = start + size >= end;
		if (first && last) return undefined;
		return first ? "first" : last ? "last" : "middle";
	};
	const column = across(pane.left, pane.width, minLeft, right);
	const row = across(pane.top, pane.height, minTop, bottom);
	const vertical =
		row === undefined
			? undefined
			: row === "first"
				? "top"
				: row === "last"
					? "bottom"
					: "middle";
	const horizontal =
		column === undefined
			? undefined
			: column === "first"
				? "left"
				: column === "last"
					? "right"
					: "middle";
	const words = [vertical, horizontal].filter(
		(word): word is string => word !== undefined,
	);
	if (words.length === 0) return "whole";
	if (words.length === 2 && words[0] === "middle" && words[1] === "middle")
		return "middle";
	return words.join("-");
}

export function describeTerminal(terminal: TellTerminal): DescribedTerminal {
	const session = terminal.session;
	const live = session?.tmux;
	const panes: DescribedTerminalPane[] =
		live === undefined || session === undefined
			? []
			: live.panes.map((pane) => ({
					...pane,
					where: paneWhere(
						pane,
						live.panes.filter((one) => one.window === pane.window),
					),
					target: pane.pane,
					fullTarget: `${session.name}:${String(pane.windowIndex)}.${String(pane.paneIndex)}`,
				}));
	const front =
		panes.find((pane) => pane.active) ??
		panes.find((pane) => pane.windowActive) ??
		panes[0];
	return {
		agentId: terminal.agentId,
		workspaceId: terminal.workspaceId,
		exists: session !== undefined,
		id: session?.id,
		session: session?.name,
		open: session?.open ?? false,
		visible: session?.visible ?? false,
		focused: session?.focused ?? false,
		tmux:
			live === undefined || session === undefined || front === undefined
				? undefined
				: {
						tmux: live.tmux,
						socket: live.socket,
						session: session.name,
						window: front.window,
						windowIndex: front.windowIndex,
						pane: front.pane,
						paneIndex: front.paneIndex,
						target: front.target,
						fullTarget: front.fullTarget,
						prefix: [live.tmux, "-S", live.socket],
						cwd: front.cwd,
						command: front.command,
						title: front.title,
					},
		panes,
	};
}

/** A word for the shell, quoted only when it has to be. */
export function shellWord(word: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word)
		? word
		: `'${word.replaceAll("'", `'\\''`)}'`;
}

function terminalLine(terminal: DescribedTerminal): string {
	const tmux = terminal.tmux;
	return [
		terminal.session ?? "no session",
		terminal.visible
			? "on screen, with your pane (right of it, or under it beside the editor)"
			: terminal.open
				? "open, not on screen (your pane is not: another Agent or the editor alone is in front)"
				: "hidden (Cmd+Q V shows it)",
		tmux === undefined
			? "tmux could not be asked about it"
			: `${shellWord(tmux.tmux)} -S ${shellWord(tmux.socket)} … -t ${tmux.target}`,
		tmux === undefined ? undefined : `cwd ${tmux.cwd}`,
		tmux === undefined ? undefined : `running ${tmux.command}`,
		terminal.panes.length > 1
			? `${String(terminal.panes.length)} tmux panes`
			: undefined,
		terminal.focused ? "has the keyboard" : undefined,
	]
		.filter((part) => part !== undefined)
		.join("  ");
}

/** One line per tmux pane, when the person has split it. */
function paneLines(terminal: DescribedTerminal): readonly string[] {
	if (terminal.panes.length < 2) return [];
	return [
		"panes:",
		...terminal.panes.map(
			(pane) =>
				`  ${pane.target}  window ${String(pane.windowIndex)} (${pane.windowName})  ${pane.where}  ${String(pane.width)}x${String(pane.height)} at ${String(pane.left)},${String(pane.top)}  running ${pane.command}${pane.active ? "  active" : ""}`,
		),
	];
}

/** One editor-terminal pane, as `terminal panes` lists it. */
function editorPaneLine(pane: TellEditorPane): string {
	return [
		`  ${pane.pane}`,
		`${pane.session}:${String(pane.windowIndex)}.${String(pane.paneIndex)}`,
		`window ${String(pane.windowIndex)} (${pane.windowName})`,
		`running ${pane.argv ?? pane.command}`,
		`cwd ${pane.cwd}`,
		pane.title.length > 0 ? `title ${JSON.stringify(pane.title)}` : undefined,
		pane.active ? "active" : undefined,
		pane.dead ? "dead" : undefined,
	]
		.filter((part) => part !== undefined)
		.join("  ");
}

/** How to type into it and read it back, with this terminal's own handle. */
function driveHints(terminal: DescribedTerminal): readonly string[] {
	const tmux = terminal.tmux;
	if (tmux === undefined) return [];
	const base = `${shellWord(tmux.tmux)} -S ${shellWord(tmux.socket)}`;
	return [
		`send:  ${base} send-keys -t ${tmux.target} -l -- 'make test' && ${base} send-keys -t ${tmux.target} Enter`,
		`read:  ${base} capture-pane -p -J -t ${tmux.target} -S -200`,
		`panes: ${base} list-panes -s -t ${shellWord(tmux.session)} -F '#{pane_id} #{window_index} #{pane_left},#{pane_top} #{pane_width}x#{pane_height} #{pane_current_command}'`,
		"close: devhub --tell terminal close",
	];
}

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
