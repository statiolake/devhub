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
	PromptCache,
	Question,
	RequestAnswer,
	TranscriptEntry,
	Usage,
} from "../../../model/conversation.js";
import type { PastSession } from "../../agent/conversation/resume.js";
import {
	TELL_USAGE,
	type AgentWaitUntil,
	type TellCommand,
} from "./command.js";

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
	/** `running`, `stopping`, or `stop-failed` (its Stop did not finish). */
	readonly controlState: string;
	/** The refusal its pane is still showing: why it exited or broke. */
	readonly failure:
		| { readonly code: string; readonly detail: string | undefined }
		| undefined;
	/** Its prompt cache, for a GUI Claude Agent that has reported one. */
	readonly promptCache: PromptCache | undefined;
	/** Its own key/value pairs (`model/agentMeta.ts`). */
	readonly meta: Readonly<Record<string, string>>;
}

/** An agent profile, as the agent picker offers it. */
export interface TellProfile {
	readonly id: string;
	readonly name: string;
	/** `claude`, `codex`, `cursor` or `custom`. */
	readonly kind: string;
	/** What a launch is without --gui/--tui: `profilePresentation`. */
	readonly presentation: "gui" | "tui";
	/** Every mode its kind has. */
	readonly presentations: readonly ("gui" | "tui")[];
}

/** An Issue action, as Assign Issue offers it. */
export interface TellIssueAction {
	readonly id: string;
	readonly label: string;
	readonly template: string;
	/** Drafted into the new agent's input box, or sent (`ActionStart`). */
	readonly start: "draft" | "send";
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
	/** Why it is `broken`, in the failing side's words; else undefined. */
	failure(): string | undefined;
	usage(): Usage | undefined;
	/** The person's words, held while a turn runs — the composer's own path. */
	submit(text: string): Promise<void>;
	interrupt(): Promise<void>;
	answer(request: string, answer: RequestAnswer): Promise<void>;
}

export interface IssueAssignRequest {
	/** How the action's wording goes out; absent only with no action. */
	readonly start: "draft" | "send" | undefined;
	readonly url: string;
	/** The clone, always named: the command line never picks one. */
	readonly repo: string;
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

/** One earlier session, as the agent picker lists it. */
export type TellPastSession = PastSession;

/** What an `agent stop` did. */
export interface TellStopped {
	/** It was not idle: the window would have asked, and its turn stopped with it. */
	readonly busy: boolean;
	/** It had a terminal, which went to the Workspace's editor (the sheet's first choice). */
	readonly movedTerminal: boolean;
	/** Its earlier Stop had failed: this was the row's Retry Stop. */
	readonly retried: boolean;
}

export interface TellPorts {
	workspaces(): readonly TellWorkspace[];
	/** The agent profiles, in the agent picker's order: the first is the default. */
	profiles(): readonly TellProfile[];
	/**
	 * Why `profileId` cannot start an agent in `workspaceId` (or on this Mac,
	 * without one) — its program is not found there — or undefined when it can.
	 */
	profileProblem(
		profileId: string,
		workspaceId: string | undefined,
	): Promise<string | undefined>;
	/** The /devhub skill's SKILL.md, for this DevHub's launcher, and the launcher. */
	skill(): { readonly text: string; readonly cli: string };
	/** The enabled Issue actions, in Assign Issue's order. */
	issueActions(): readonly TellIssueAction[];
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
	/** Back to the label DevHub gives it (`reset_agent_name`). */
	resetAgentName(agentId: string): Promise<void>;
	/** Set (or, with undefined, remove) one of an agent's own pairs. */
	setAgentMeta(
		agentId: string,
		key: string,
		value: string | undefined,
	): Promise<void>;
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
	/**
	 * Stop Agent, as its row does (`stop_agent`, or `retry_stop_agent` after a
	 * failed one), with the confirmation the window would draw taken as given:
	 * the command is the decision. Refused where the window refuses.
	 */
	stopAgent(agentId: string): Promise<TellStopped>;
	/** Restart Session, as the row menu does (`restart_agent`), likewise. */
	restartAgent(agentId: string): Promise<{ readonly busy: boolean }>;
	/** The agent picker's earlier sessions of a profile, for a Workspace. */
	pastSessions(
		workspaceId: string,
		profileId: string,
	): Promise<readonly TellPastSession[]>;
	/**
	 * Go on with one in a new GUI Agent, as the picker does: here, or in its
	 * own worktree (opened, or checked out again). Answers the new Agent's id.
	 */
	resumeSession(
		workspaceId: string,
		profileId: string,
		session: TellPastSession,
	): Promise<string>;
}

/** Which Agent is asking, from its pane's `DEVHUB_ORIGIN`. */
export interface TellCaller {
	readonly machine: string;
	readonly agentId: string | undefined;
	readonly workspaceId: string | undefined;
	/**
	 * Not a DevHub pane: a process DevHub did not start (Claude Desktop, a
	 * script, a login shell), known at most by `DEVHUB_MACHINE`. It has no
	 * workspace and no agent, and is credited by its `--as` label.
	 */
	readonly paneless?: true;
	/** `--as NAME`: what an outside caller is called, here and in answers. */
	readonly label?: string;
}

/** What an outside caller with no `--as` is, in `TellMemory` and in answers. */
export const OUTSIDE_LABEL = "external";

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
/** The CLIs whose sessions DevHub lists and resumes (`resume.ts`). */
const RESUMABLE_KINDS: ReadonlySet<string> = new Set(["claude", "codex"]);
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
	label?: string,
): TellCaller {
	const fromOrigin = callerFromOrigin(origin);
	if (fromOrigin !== undefined) {
		// A DevHub pane is already somebody: its agent, or its terminal.
		if (label !== undefined)
			throw new Error(
				`--as is for callers DevHub did not start; this one runs in DevHub (${fromOrigin.agentId === undefined ? "a terminal" : `agent ${fromOrigin.agentId}`}), and is called that.`,
			);
		return fromOrigin;
	}
	// Everybody else: a process DevHub did not start. Its paths are this
	// Mac's unless the shim on a host said otherwise.
	return {
		machine: machine === undefined || machine.length === 0 ? "local" : machine,
		agentId: undefined,
		workspaceId: undefined,
		paneless: true,
		...(label === undefined ? {} : { label }),
	};
}

/** What one caller has read of one Agent: the acknowledgement `wait --any` reads. */
export interface TellSeen {
	/** The last entry `agent read` showed it. */
	readonly cursor: string | undefined;
	/** The open requests it has been shown (`agent read`, `agent requests`). */
	readonly requests: ReadonlySet<string>;
	/** The failure it was shown, as `failureKey` words it. */
	readonly failure: string | undefined;
}

/**
 * What the app keeps between two `--tell` calls; one per app, in memory.
 *
 * - **What each caller has read of each Agent** (`TellSeen`). An orchestrator
 *   loops `wait --any` → `read --since` → `answer`/`send` → `wait --any`, and
 *   something can happen between any two of those calls. So `wait --any` does
 *   not report a change of state, which could come and go between two waits;
 *   it reports what the caller has *not read yet* — output after the last
 *   entry its `agent read` showed it, a request it has not been shown, a
 *   failure it has not been shown — and that stays reported until it is read.
 *   Reading is the one acknowledgement. A caller is its Agent, or the
 *   terminal it runs in.
 * - **Since when each Agent has been in its status**, and when its status or
 *   its activity last changed, as DevHub saw it: the app observes every
 *   snapshot (`observe`), so these are the app's clock, not the CLI's.
 */
export class TellMemory {
	readonly #seen = new Map<string, Map<string, TellSeen>>();
	readonly #times = new Map<
		string,
		{
			status: string;
			since: number;
			activity: string | undefined;
			activityAt: number;
		}
	>();

	observe(
		agents: readonly {
			readonly id: string;
			readonly status: string;
			readonly activity: string | undefined;
		}[],
		now: number,
	): void {
		const live = new Set<string>();
		for (const agent of agents) {
			live.add(agent.id);
			const known = this.#times.get(agent.id);
			if (known === undefined) {
				this.#times.set(agent.id, {
					status: agent.status,
					since: now,
					activity: agent.activity,
					activityAt: now,
				});
				continue;
			}
			if (known.status !== agent.status) {
				known.status = agent.status;
				known.since = now;
				known.activityAt = now;
			}
			if (known.activity !== agent.activity) {
				known.activity = agent.activity;
				known.activityAt = now;
			}
		}
		for (const id of [...this.#times.keys()])
			if (!live.has(id)) this.#times.delete(id);
		for (const seen of this.#seen.values())
			for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
	}

	/** Since when `agentId` has been in its status, and its last change. */
	times(
		agentId: string,
	): { readonly since: number; readonly activityAt: number } | undefined {
		return this.#times.get(agentId);
	}

	seen(caller: string, agentId: string): TellSeen | undefined {
		return this.#seen.get(caller)?.get(agentId);
	}

	/** `caller` has been shown this of `agentId`; what is left out stays as it was. */
	mark(caller: string, agentId: string, seen: Partial<TellSeen>): void {
		const byAgent = this.#seen.get(caller) ?? new Map<string, TellSeen>();
		this.#seen.set(caller, byAgent);
		const before = byAgent.get(agentId);
		byAgent.set(agentId, {
			cursor: "cursor" in seen ? seen.cursor : before?.cursor,
			requests: seen.requests ?? before?.requests ?? new Set(),
			failure: "failure" in seen ? seen.failure : before?.failure,
		});
	}
}

/** Who `TellMemory` keeps a caller's reading under: its Agent, or its terminal. */
export function callerKey(caller: TellCaller | undefined): string {
	if (caller === undefined || caller.paneless === true)
		// One reader per label, wherever it runs: `--as reviewer-bot` twice is
		// the same reader, and every unlabelled outside caller shares one.
		return `outside:${caller?.label ?? OUTSIDE_LABEL}`;
	if (caller.agentId !== undefined) return `agent:${caller.agentId}`;
	return `pane:${caller.machine}:${caller.workspaceId ?? "scratch"}`;
}

/** Output a reader is owed: what the Agent did, not what it was told. */
function isOutput(entry: TranscriptEntry): boolean {
	return entry.kind !== "user" && entry.kind !== "answer";
}

/** The entries after `cursor`; a cursor that is gone (a rewind, a compaction) leaves them all. */
function entriesAfter(
	entries: readonly TranscriptEntry[],
	cursor: string | undefined,
): readonly TranscriptEntry[] {
	if (cursor === undefined) return entries;
	const at = entries.findIndex((entry) => entry.id === cursor);
	return at < 0 ? entries : entries.slice(at + 1);
}

/** An Agent's failure as one key, so "the same failure" is one comparison. */
function failureKey(
	agent: TellAgent,
	conversation: TellConversation | undefined,
): string | undefined {
	const broken = conversation?.failure();
	if (broken !== undefined) return `broken: ${broken}`;
	if (agent.failure === undefined) return undefined;
	return `${agent.failure.code}${agent.failure.detail === undefined ? "" : `: ${agent.failure.detail}`}`;
}

function iso(ms: number | undefined): string | null {
	return ms === undefined ? null : new Date(ms).toISOString();
}

/** `45s`, `12m`, `3h`, `2d`: how long, for a line of text. */
function span(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 120) return `${String(seconds)}s`;
	if (seconds < 3600) return `${String(Math.round(seconds / 60))}m`;
	if (seconds < 172800) return `${String(Math.round(seconds / 3600))}h`;
	return `${String(Math.round(seconds / 86400))}d`;
}

/**
 * One Agent as `agent status --json` writes it, and `agents --json` as each
 * row's `state`. A stable shape: every key is always there, `null` where
 * there is nothing to say (a terminal Agent has no transcript; a CLI that
 * reports no context has none).
 */
export interface TellAgentStatus {
	readonly agentId: string;
	readonly name: string;
	readonly kind: string;
	readonly profile: string;
	readonly presentation: "gui" | "tui";
	/** Its own key/value pairs; `{}` when it has none. */
	readonly meta: Readonly<Record<string, string>>;
	readonly workspace: {
		readonly id: string;
		readonly name: string;
		readonly root: string;
	};
	/** working, background, waiting, idle, error, unknown. */
	readonly status: string;
	/** Since when it has been in `status`, as DevHub saw it. */
	readonly statusSince: string | null;
	/** When its status or its activity last changed, as DevHub saw it. */
	readonly lastActivityAt: string | null;
	readonly activity: string | null;
	/** A GUI Agent's turn: none, running, rewinding, connecting, broken. */
	readonly turn: string | null;
	/** running, stopping, stop-failed. */
	readonly control: string;
	/** Why it exited or broke, when it did. */
	readonly failure: string | null;
	readonly requests: {
		readonly questions: number;
		/** Answered in DevHub, by the person, only. */
		readonly permissions: number;
		readonly open: readonly {
			readonly id: string;
			readonly kind: string;
			readonly answerable: boolean;
			readonly text: string;
		}[];
	} | null;
	/** Output entries after what the caller last read, and where to read from. */
	readonly unread: {
		readonly entries: number;
		/** Pass to `agent read --since`; null: read with --last. */
		readonly since: string | null;
		readonly cursor: string | null;
	} | null;
	readonly context: {
		readonly tokens: number;
		readonly window: number | null;
		readonly percent: number | null;
	} | null;
	readonly promptCache: {
		readonly ttlSeconds: number;
		readonly expiresAt: string | null;
		readonly cold: boolean | null;
		readonly hitRatio: number | null;
		readonly misses: number;
		readonly autoCompactAt: string | null;
	} | null;
}

export class TellService {
	/** The caller of the command being run, for the names it uses. */
	private caller: TellCaller | undefined;

	constructor(
		private readonly ports: TellPorts,
		private readonly clock: TellClock = REAL_CLOCK,
		private readonly memory: TellMemory = new TellMemory(),
	) {}

	async run(
		command: TellCommand,
		caller: TellCaller | undefined,
	): Promise<TellAnswer> {
		this.caller = caller;
		this.observe();
		switch (command.verb) {
			case "help":
				return { message: TELL_USAGE, data: { usage: TELL_USAGE } };
			case "skill": {
				const skill = this.ports.skill();
				return { message: skill.text, data: skill };
			}
			case "workspaces":
				return this.listWorkspaces();
			case "workspace-open":
				return this.openWorkspace(command.path, command.worktree, caller);
			case "agents":
				return this.listAgents(command.workspace, command.meta);
			case "profiles":
				return this.listProfiles();
			case "issue-actions":
				return this.listIssueActions();
			case "agent-rename":
				return this.rename(command.agent, command.name);
			case "agent-meta":
				return this.meta(command);
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
			case "agent-wait-many":
				return command.mode === "any"
					? this.waitAny(command)
					: this.waitAll(command);
			case "agent-status":
				return this.status(command.agent);
			case "agent-stop":
				return this.stop(command.agent);
			case "agent-restart":
				return this.restart(command.agent);
			case "sessions":
				return this.sessions(command);
			case "agent-resume":
				return this.resume(command);
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
			"this needs --workspace <w> here: this devhub is not running in a DevHub terminal or agent, so there is no workspace to default to.",
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

	/** A profile that has to be one of `profiles`. */
	private profile(id: string): string {
		const profiles = this.ports.profiles();
		if (!profiles.some((profile) => profile.id === id))
			throw new Error(
				`there is no agent profile called '${id}': ${profiles.map((profile) => profile.id).join(", ") || "none"} (see devhub --tell profiles)`,
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

	private async listAgents(
		workspace: string | undefined,
		meta: readonly { readonly key: string; readonly value: string }[] = [],
	): Promise<TellAnswer> {
		const workspaces =
			workspace === undefined
				? this.ports.workspaces()
				: [this.workspace(workspace)];
		const rows = await Promise.all(
			workspaces.flatMap((each) =>
				each.agents
					.filter((agent) =>
						meta.every((pair) => agent.meta[pair.key] === pair.value),
					)
					.map(async (agent) => {
						const state = await this.statusOf(agent, each);
						return {
							...agent,
							workspace: each.scratch ? "Scratch" : each.name,
							requests: state.requests?.open.length,
							state,
						};
					}),
			),
		);
		const now = this.clock.now();
		const lines = rows.map(({ state, ...row }) =>
			[
				row.id,
				row.name,
				`${row.kind}/${row.presentation}`,
				state.statusSince === null
					? row.status
					: `${row.status} for ${span(now - Date.parse(state.statusSince))}`,
				row.unread === undefined ? undefined : "unread",
				row.requests ? `${String(row.requests)} request(s)` : undefined,
				state.unread?.entries
					? `${String(state.unread.entries)} new`
					: undefined,
				state.context?.percent === null || state.context === null
					? undefined
					: `ctx ${String(state.context.percent)}%`,
				state.failure === null ? undefined : "failed",
				`in ${row.workspace}`,
				metaWords(row.meta),
				row.activity === undefined ? undefined : `— ${row.activity}`,
			]
				.filter((part) => part !== undefined)
				.join("  "),
		);
		return {
			message:
				lines.length > 0
					? lines.join("\n")
					: meta.length > 0
						? `No agent carries ${meta.map((pair) => `${pair.key}=${pair.value}`).join(" ")}.`
						: "No agents are running.",
			data: { agents: rows },
		};
	}

	// --- profiles and Issue actions --------------------------------------

	/**
	 * The agent picker's profiles, in its order, with the mode each starts in
	 * unless told otherwise and whether its program is there to start —
	 * asked on the machine of the workspace the caller is in.
	 */
	private async listProfiles(): Promise<TellAnswer> {
		const profiles = this.ports.profiles();
		const where =
			this.caller?.paneless === true ? undefined : this.caller?.workspaceId;
		const rows = await Promise.all(
			profiles.map(async (profile) => {
				const problem = await this.ports
					.profileProblem(profile.id, where)
					.catch((error: unknown) =>
						error instanceof Error ? error.message : String(error),
					);
				return {
					...profile,
					available: problem === undefined,
					unavailable: problem ?? null,
				};
			}),
		);
		return {
			message:
				rows.length === 0
					? "No agent profiles are configured."
					: rows
							.map((row) =>
								[
									row.id,
									row.name,
									row.kind,
									`${row.presentations.map((one) => `--${one}`).join(" ")} (window default: ${row.presentation.toUpperCase()})`,
									row.unavailable === null
										? "available"
										: `unavailable: ${row.unavailable}`,
								].join("  "),
							)
							.join("\n"),
			data: { profiles: rows },
		};
	}

	/** Assign Issue's actions: what `--action` takes, and what each says. */
	private listIssueActions(): TellAnswer {
		const rows = this.ports.issueActions().map((action) => ({
			...action,
			summary: promptSummary(action.template),
		}));
		return {
			message: [
				...rows.map(
					(row) =>
						`${row.id}  ${row.label}  (window: ${row.start})  — ${row.summary}`,
				),
				`${NO_ACTION}  (start the agent and tell it nothing)`,
			].join("\n"),
			data: { actions: rows, none: NO_ACTION },
		};
	}

	// --- rename and metadata ---------------------------------------------

	private async rename(
		name: string,
		to: string | undefined,
	): Promise<TellAnswer> {
		const agent = this.agent(name);
		if (to === undefined) await this.ports.resetAgentName(agent.id);
		else await this.ports.renameAgent(agent.id, to);
		const now = this.ports
			.workspaces()
			.flatMap((workspace) => workspace.agents)
			.find((one) => one.id === agent.id);
		return {
			message:
				to === undefined
					? `${agent.id} is called ${now?.name ?? "by DevHub's label"} again.`
					: `${agent.id} is called ${to}.`,
			data: { agentId: agent.id, name: now?.name ?? to ?? null },
		};
	}

	private async meta(
		command: Extract<TellCommand, { verb: "agent-meta" }>,
	): Promise<TellAnswer> {
		const agent = this.agent(command.agent);
		if (command.op !== "list" && command.key !== undefined)
			await this.ports.setAgentMeta(
				agent.id,
				command.key,
				command.op === "set" ? command.value : undefined,
			);
		const meta =
			this.ports
				.workspaces()
				.flatMap((workspace) => workspace.agents)
				.find((one) => one.id === agent.id)?.meta ?? {};
		const entries = Object.entries(meta);
		return {
			message:
				entries.length === 0
					? `${agent.name} has no metadata.`
					: entries.map(([key, value]) => `${key}=${value}`).join("\n"),
			data: { agentId: agent.id, meta },
		};
	}

	/** Every `--meta` pair onto a new agent, in order. */
	private async tag(
		agentId: string,
		meta: readonly { readonly key: string; readonly value: string }[] = [],
	): Promise<void> {
		for (const pair of meta)
			await this.ports.setAgentMeta(agentId, pair.key, pair.value);
	}

	private async newAgent(
		command: Extract<TellCommand, { verb: "agent-new" }>,
	): Promise<TellAnswer> {
		// Every choice named: nothing here falls back on a setting or on the
		// first of a list, because an agent calling this must get the same
		// thing whatever the person's settings say. Checked before anything is
		// done, so a refusal changes nothing.
		const missing: string[] = [];
		if (command.workspace === undefined)
			missing.push(
				`--workspace is required: ${this.workspaceChoices()} (see devhub --tell workspaces)`,
			);
		const profile = this.requiredProfile(command.profile, missing);
		this.requiredMode(profile, command.presentation, missing);
		refuseMissing(missing);
		const workspace = this.workspace(command.workspace!);
		const agentId = await this.ports.createAgent(
			workspace.id,
			profile!.id,
			command.presentation,
		);
		if (command.name !== undefined)
			await this.ports.renameAgent(agentId, command.name);
		await this.tag(agentId, command.meta);
		if (command.prompt !== undefined)
			this.ports.queueText(agentId, command.prompt);
		return {
			message: `Agent ${agentId} (${profile!.id}, ${command.presentation!.toUpperCase()}) is starting in ${workspace.root}${command.prompt === undefined ? "" : "; it is told the prompt once it is ready"}.`,
			data: { agentId, workspaceId: workspace.id, profile: profile!.id },
		};
	}

	private async assignIssue(
		command: Extract<TellCommand, { verb: "issue-assign" }>,
	): Promise<TellAnswer> {
		// As `agent new`: every choice the window would make from settings or
		// from the first row is an argument, all checked before anything runs.
		const missing: string[] = [];
		if (command.repo === undefined)
			missing.push(
				"--repo <path> is required: the clone to work in (the window asks which when there are several)",
			);
		if (command.branch === undefined && command.place !== "root")
			missing.push(
				"--branch <name> or --root is required: --branch NAME works in a worktree of NAME (made if need be), --root in the clone itself (with --branch, switched to NAME; without, as it is)",
			);
		let profile: TellProfile | undefined;
		let action: string | undefined;
		if (command.editorOnly) {
			const extra = [
				command.profile === undefined ? undefined : "--profile",
				command.action === undefined ? undefined : "--action",
				command.presentation === undefined ? undefined : "--gui/--tui",
				command.start === undefined ? undefined : "--send/--draft",
				command.meta === undefined ? undefined : "--meta",
				command.prompt === undefined ? undefined : "--prompt",
			].filter((flag) => flag !== undefined);
			if (extra.length > 0)
				missing.push(
					`${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} about the agent, and --editor-only starts none`,
				);
		} else {
			profile = this.requiredProfile(command.profile, missing);
			this.requiredMode(profile, command.presentation, missing);
			const actions = this.ports.issueActions();
			const choices = [...actions.map((one) => one.id), NO_ACTION].join(", ");
			if (command.action === undefined)
				missing.push(
					`--action is required: ${choices} (see devhub --tell issue actions; ${NO_ACTION} tells the agent nothing)`,
				);
			else if (
				command.action !== NO_ACTION &&
				!actions.some((one) => one.id === command.action)
			)
				missing.push(
					`there is no Issue action called '${command.action}': ${choices} (see devhub --tell issue actions)`,
				);
			else if (command.action !== NO_ACTION) action = command.action;
			if (command.action !== NO_ACTION && command.start === undefined)
				missing.push(
					"--send or --draft is required: --draft puts the action's wording into the agent's input box unsent, --send sends it as its first message",
				);
			if (command.action === NO_ACTION && command.start !== undefined)
				missing.push(
					`--send/--draft is about the action's wording, and --action ${NO_ACTION} has none`,
				);
		}
		refuseMissing(missing);
		const assigned = await this.ports.assignIssue({
			url: command.url,
			repo: command.repo!,
			branch: command.branch,
			place: command.place,
			profile: profile?.id,
			action,
			editorOnly: command.editorOnly,
			presentation: command.presentation,
			start: action === undefined ? undefined : command.start,
		});
		if (assigned.agentId !== undefined)
			await this.tag(assigned.agentId, command.meta);
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

	/** The workspaces a `--workspace` can name, for a refusal. */
	private workspaceChoices(): string {
		const all = this.ports.workspaces();
		return all.length === 0
			? "none is open (devhub --tell workspace open <path>)"
			: all
					.map((one) =>
						one.scratch ? `scratch (${one.id})` : `${one.name} (${one.id})`,
					)
					.join(", ");
	}

	/** `--profile`, which must be given and be one of `profiles`; else a line in `missing`. */
	private requiredProfile(
		id: string | undefined,
		missing: string[],
	): TellProfile | undefined {
		const profiles = this.ports.profiles();
		const names = profiles.map((one) => one.id).join(", ") || "none";
		if (id === undefined) {
			missing.push(
				`--profile is required: ${names} (see devhub --tell profiles)`,
			);
			return undefined;
		}
		const profile = profiles.find((one) => one.id === id);
		if (profile === undefined)
			missing.push(
				`there is no agent profile called '${id}': ${names} (see devhub --tell profiles)`,
			);
		return profile;
	}

	/** `--gui` or `--tui`, which must be given and be one the profile has. */
	private requiredMode(
		profile: TellProfile | undefined,
		mode: "gui" | "tui" | undefined,
		missing: string[],
	): void {
		const offered = profile?.presentations ?? ["gui", "tui"];
		const flags = offered.map((one) => `--${one}`).join(", ");
		if (mode === undefined) {
			missing.push(
				`--gui or --tui is required: ${profile === undefined ? "" : `${profile.id} has `}${flags} (see devhub --tell profiles)`,
			);
			return;
		}
		if (profile !== undefined && !offered.includes(mode))
			missing.push(
				`${profile.id} runs a ${profile.kind} CLI, which has no ${mode.toUpperCase()}: ${flags}`,
			);
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
		// Read to the end: what `wait --any` owes this caller is what came after.
		this.memory.mark(callerKey(this.caller), agent.id, {
			cursor: entries.at(-1)?.id ?? since,
			requests: new Set(conversation.requests().map((request) => request.id)),
			failure: failureKey(agent, conversation),
		});
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
		this.memory.mark(callerKey(this.caller), agent.id, {
			requests: new Set(requests.map((request) => request.id)),
		});
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
			const { reached, requests } = await this.reached(agent, until);
			if (reached || this.clock.now() >= deadline)
				return {
					message: `${agent.name} is ${agent.status}${requests > 0 ? ` with ${String(requests)} open request(s)` : ""}${reached ? "" : ` (still, after ${String(timeoutSeconds)}s)`}.`,
					data: { agentId: id, status: agent.status, requests, reached },
				};
			await this.clock.sleep(WAIT_POLL_MS);
		}
	}

	/** Whether `agent` is in the state `until` names: `agent wait`'s one rule. */
	private async reached(
		agent: TellAgent,
		until: AgentWaitUntil,
	): Promise<{ readonly reached: boolean; readonly requests: number }> {
		const requests = (await this.requestCount(agent)) ?? 0;
		const waiting = agent.status === "waiting" || requests > 0;
		const idle = agent.status === "idle" || agent.status === "error";
		return {
			reached:
				until === "idle"
					? idle
					: until === "waiting"
						? waiting
						: idle || waiting,
			requests,
		};
	}

	// --- several agents ---------------------------------------------------

	/** Every Agent DevHub has, by id, as it is now. */
	private liveAgents(): Map<string, TellAgent> {
		return new Map(
			this.ports
				.workspaces()
				.flatMap((workspace) => workspace.agents)
				.map((agent) => [agent.id, agent]),
		);
	}

	/**
	 * The Agents a `wait --any|--all` is about: the ones named, or every one
	 * but the caller (of `--workspace`, when given). `--any` follows
	 * transcripts, so it takes GUI Agents only.
	 */
	private waitTargets(
		command: Extract<TellCommand, { verb: "agent-wait-many" }>,
	): readonly TellAgent[] {
		const self = this.caller?.agentId;
		const gui = command.mode === "any";
		if (command.agents.length > 0) {
			if (command.workspace !== undefined)
				throw new Error(
					"name the agents or give --workspace, not both: --workspace stands for every agent in it.",
				);
			const named = new Map<string, TellAgent>();
			for (const name of command.agents) {
				const agent = this.agent(name);
				if (agent.id === self)
					throw new Error("an agent cannot wait on itself.");
				if (gui && agent.presentation !== "gui")
					throw new Error(
						`${agent.name} is a terminal agent, and wait --any follows GUI agents' transcripts. Wait on it alone with 'agent wait ${agent.id}', or with --all.`,
					);
				named.set(agent.id, agent);
			}
			return [...named.values()];
		}
		const pool =
			command.workspace === undefined
				? this.ports.workspaces().flatMap((workspace) => workspace.agents)
				: this.workspace(command.workspace).agents;
		const targets = pool.filter(
			(agent) => agent.id !== self && (!gui || agent.presentation === "gui"),
		);
		if (targets.length === 0)
			throw new Error(
				`there is no other ${gui ? "GUI " : ""}agent${command.workspace === undefined ? "" : ` in ${command.workspace}`} to wait on.`,
			);
		return targets;
	}

	/**
	 * What `agent` has for this caller that it has not read (`TellMemory`):
	 * output after its last read while the turn is over, a request it has not
	 * been shown, a failure it has not been shown. Nothing: undefined.
	 */
	private async news(agent: TellAgent, until: AgentWaitUntil) {
		let conversation: TellConversation | undefined;
		try {
			conversation = await this.ports.conversation(agent.id);
		} catch {
			conversation = undefined;
		}
		if (conversation === undefined) return undefined;
		const seen = this.memory.seen(callerKey(this.caller), agent.id);
		const entries = conversation.entries();
		const unread = entriesAfter(entries, seen?.cursor).filter(isOutput);
		const requests = conversation
			.requests()
			.filter((request) => seen?.requests.has(request.id) !== true);
		const failure = failureKey(agent, conversation);
		const newFailure = failure !== undefined && failure !== seen?.failure;
		// The conversation's own turn, not the Sidebar's status: that is read
		// a round later, and output streamed in the meantime is not the end.
		const turn = conversation.turn();
		const over = turn === "none" || turn === "broken";
		const reasons = [
			...(until !== "waiting" && over && unread.length > 0 ? ["output"] : []),
			...(until !== "idle" && requests.length > 0 ? ["request"] : []),
			...(until !== "waiting" && newFailure ? ["failure"] : []),
		];
		if (reasons.length === 0) return undefined;
		return {
			agentId: agent.id,
			name: agent.name,
			status: agent.status,
			turn,
			reasons,
			unread: unread.length,
			since: seen?.cursor ?? null,
			cursor: entries.at(-1)?.id ?? null,
			requests: requests.map(requestView).map(({ id, kind, answerable }) => ({
				id,
				kind,
				answerable,
			})),
			failure: newFailure ? failure : null,
		};
	}

	private async waitAny(
		command: Extract<TellCommand, { verb: "agent-wait-many" }>,
	): Promise<TellAnswer> {
		const targets = this.waitTargets(command);
		const deadline = this.clock.now() + command.timeoutSeconds * 1000;
		for (;;) {
			this.observe();
			const live = this.liveAgents();
			const ready: NonNullable<Awaited<ReturnType<TellService["news"]>>>[] = [];
			const gone: { agentId: string; name: string }[] = [];
			for (const target of targets) {
				const agent = live.get(target.id);
				if (agent === undefined) {
					gone.push({ agentId: target.id, name: target.name });
					continue;
				}
				const news = await this.news(agent, command.until);
				if (news !== undefined) ready.push(news);
			}
			const reached = ready.length > 0 || gone.length > 0;
			if (reached || this.clock.now() >= deadline) {
				const lines = [
					...ready.map((one) => newsLine(one)),
					...gone.map((one) => `${one.name} (${one.agentId}) is gone.`),
				];
				return {
					message: reached
						? lines.join("\n")
						: `None of ${String(targets.length)} agent(s) had anything new for you (until ${command.until}) after ${String(command.timeoutSeconds)}s.`,
					data: {
						reached,
						mode: "any",
						until: command.until,
						ready,
						gone,
						agents: targets.map((target) => target.id),
					},
				};
			}
			await this.clock.sleep(WAIT_POLL_MS);
		}
	}

	private async waitAll(
		command: Extract<TellCommand, { verb: "agent-wait-many" }>,
	): Promise<TellAnswer> {
		const targets = this.waitTargets(command);
		const deadline = this.clock.now() + command.timeoutSeconds * 1000;
		for (;;) {
			const live = this.liveAgents();
			const states = await Promise.all(
				targets.map(async (target) => {
					const agent = live.get(target.id);
					if (agent === undefined)
						return {
							agentId: target.id,
							name: target.name,
							status: "gone",
							requests: 0,
							reached: true,
						};
					return {
						agentId: agent.id,
						name: agent.name,
						status: agent.status,
						...(await this.reached(agent, command.until)),
					};
				}),
			);
			const reached = states.every((state) => state.reached);
			if (reached || this.clock.now() >= deadline)
				return {
					message: [
						...(reached
							? []
							: [
									`Not all there (until ${command.until}) after ${String(command.timeoutSeconds)}s:`,
								]),
						...states.map(
							(state) =>
								`${state.reached ? " " : "-"} ${state.name} (${state.agentId}) is ${state.status}${state.requests > 0 ? ` with ${String(state.requests)} open request(s)` : ""}`,
						),
					].join("\n"),
					data: { reached, mode: "all", until: command.until, agents: states },
				};
			await this.clock.sleep(WAIT_POLL_MS);
		}
	}

	// --- status -----------------------------------------------------------

	private observe(): void {
		this.memory.observe(
			this.ports.workspaces().flatMap((workspace) => workspace.agents),
			this.clock.now(),
		);
	}

	/** One Agent, as `agent status` and `agents --json` give it. */
	private async statusOf(
		agent: TellAgent,
		workspace: TellWorkspace,
	): Promise<TellAgentStatus> {
		let conversation: TellConversation | undefined;
		try {
			conversation =
				agent.presentation === "gui"
					? await this.ports.conversation(agent.id)
					: undefined;
		} catch {
			conversation = undefined;
		}
		const now = this.clock.now();
		const times = this.memory.times(agent.id);
		const requests = conversation?.requests().map(requestView);
		const entries = conversation?.entries();
		const seen = this.memory.seen(callerKey(this.caller), agent.id);
		const usage = conversation?.usage();
		const cache = agent.promptCache ?? usage?.promptCache;
		const tokens = usage?.contextTokens;
		const window = usage?.contextWindow;
		return {
			agentId: agent.id,
			name: agent.name,
			kind: agent.kind,
			profile: agent.profileId,
			presentation: agent.presentation,
			meta: agent.meta,
			workspace: {
				id: workspace.id,
				name: workspace.scratch ? "Scratch" : workspace.name,
				root: workspace.root,
			},
			status: agent.status,
			statusSince: iso(times?.since),
			lastActivityAt: iso(times?.activityAt),
			activity: agent.activity ?? null,
			turn: conversation?.turn() ?? null,
			control: agent.controlState,
			failure: failureKey(agent, conversation) ?? null,
			requests:
				requests === undefined
					? null
					: {
							questions: requests.filter((one) => one.answerable).length,
							permissions: requests.filter((one) => !one.answerable).length,
							open: requests.map(({ id, kind, answerable, text }) => ({
								id,
								kind,
								answerable,
								text,
							})),
						},
			unread:
				entries === undefined
					? null
					: {
							entries: entriesAfter(entries, seen?.cursor).filter(isOutput)
								.length,
							since: seen?.cursor ?? null,
							cursor: entries.at(-1)?.id ?? null,
						},
			context:
				tokens === undefined
					? null
					: {
							tokens,
							window: window ?? null,
							percent:
								window === undefined || window === 0
									? null
									: Math.round((tokens / window) * 100),
						},
			promptCache:
				cache === undefined
					? null
					: {
							ttlSeconds: cache.ttlSeconds,
							expiresAt: iso(cache.expiresAt),
							cold:
								cache.expiresAt === undefined ? null : cache.expiresAt <= now,
							hitRatio: cache.hitRatio ?? null,
							misses: cache.misses,
							autoCompactAt: iso(cache.autoCompactAt),
						},
		};
	}

	private workspaceOf(agent: TellAgent): TellWorkspace {
		const workspace = this.ports
			.workspaces()
			.find((each) => each.agents.some((one) => one.id === agent.id));
		if (workspace === undefined)
			throw new Error(`the agent ${agent.id} is in no open workspace.`);
		return workspace;
	}

	private async status(name: string): Promise<TellAnswer> {
		const agent = this.agent(name);
		const state = await this.statusOf(agent, this.workspaceOf(agent));
		return {
			message: statusLines(state, this.clock.now()).join("\n"),
			data: state,
		};
	}

	// --- stop and restart ---------------------------------------------------

	/** What an Agent may do to others and not to itself. */
	private notSelf(agent: TellAgent, act: string): void {
		if (this.caller?.agentId !== undefined && this.caller.agentId === agent.id)
			throw new Error(
				`an agent cannot ${act} itself. Ask the person, or another agent, to.`,
			);
	}

	private async stop(name: string): Promise<TellAnswer> {
		const agent = this.agent(name);
		this.notSelf(agent, "stop");
		const stopped = await this.ports.stopAgent(agent.id);
		return {
			message: [
				`${stopped.retried ? "Stopped (a retry of the Stop that had failed)" : "Stopped"} ${agent.name} (${agent.id})`,
				stopped.busy
					? `; it was ${agent.status}, and what it was doing stopped with it`
					: "",
				stopped.movedTerminal
					? "; its terminal went to the workspace's editor terminal, still running"
					: "",
				".",
			].join(""),
			data: { agentId: agent.id, stopped: true, ...stopped },
		};
	}

	private async restart(name: string): Promise<TellAnswer> {
		const agent = this.agent(name);
		this.notSelf(agent, "restart");
		const { busy } = await this.ports.restartAgent(agent.id);
		return {
			message: `Restarted ${agent.name}'s session (${agent.id})${busy ? `; it was ${agent.status}, and its turn stopped with it` : ""}.`,
			data: { agentId: agent.id, restarted: true, busy },
		};
	}

	// --- earlier sessions -------------------------------------------------

	/**
	 * The agent picker's earlier sessions in `workspace`: every resumable
	 * profile's (or `profileId`'s), newest first, one row per session of a
	 * CLI. A profile whose listing failed is said, as the picker says it.
	 */
	private async pastSessions(
		workspace: TellWorkspace,
		profileId: string | undefined,
	): Promise<{
		readonly sessions: readonly {
			readonly profile: string;
			readonly session: TellPastSession;
		}[];
		readonly failures: readonly {
			readonly profile: string;
			readonly reason: string;
		}[];
	}> {
		const profiles = this.ports
			.profiles()
			.filter((profile) => profileId === undefined || profile.id === profileId);
		if (profileId !== undefined) this.profile(profileId);
		const resumable = profiles.filter((profile) =>
			RESUMABLE_KINDS.has(profile.kind),
		);
		if (resumable.length === 0)
			throw new Error(
				profileId === undefined
					? "no agent profile runs Claude or Codex, the CLIs whose sessions DevHub resumes."
					: `the profile '${profileId}' runs a ${profiles[0]?.kind ?? "?"} CLI, whose sessions DevHub cannot resume.`,
			);
		const listed = await Promise.allSettled(
			resumable.map((profile) =>
				this.ports.pastSessions(workspace.id, profile.id),
			),
		);
		const offered = new Set<string>();
		const sessions: { profile: string; session: TellPastSession }[] = [];
		const failures: { profile: string; reason: string }[] = [];
		listed.forEach((result, index) => {
			const profile = resumable[index]!;
			if (result.status === "rejected") {
				failures.push({
					profile: profile.id,
					reason:
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason),
				});
				return;
			}
			for (const session of result.value) {
				const same = `${profile.kind}\u0000${session.id}`;
				if (offered.has(same)) continue;
				offered.add(same);
				sessions.push({ profile: profile.id, session });
			}
		});
		if (sessions.length === 0 && failures.length > 0)
			throw new Error(
				failures.map((one) => `${one.profile}: ${one.reason}`).join("; "),
			);
		// Newest first across profiles; stable, so a CLI's own order stays.
		sessions.sort(
			(a, b) =>
				(b.session.updatedAt ?? Number.NEGATIVE_INFINITY) -
					(a.session.updatedAt ?? Number.NEGATIVE_INFINITY) || 0,
		);
		return { sessions, failures };
	}

	private async sessions(
		command: Extract<TellCommand, { verb: "sessions" }>,
	): Promise<TellAnswer> {
		const workspace = this.workspace(
			this.workspaceOrCallers(command.workspace),
		);
		const { sessions, failures } = await this.pastSessions(
			workspace,
			command.profile,
		);
		const shown = sessions.slice(0, command.limit);
		const now = this.clock.now();
		return {
			message: [
				...(shown.length === 0
					? [`No earlier sessions in ${workspace.root}.`]
					: shown.map(({ profile, session }) =>
							sessionLine(profile, session, now),
						)),
				...failures.map(
					(one) =>
						`(${one.profile}'s sessions could not be read: ${one.reason})`,
				),
				...(sessions.length > shown.length
					? [`(${String(sessions.length - shown.length)} more: --limit)`]
					: []),
			].join("\n"),
			data: {
				workspaceId: workspace.id,
				sessions: shown.map(({ profile, session }) => ({
					id: session.id,
					profile,
					title: session.title,
					agentName: session.agentName ?? null,
					updatedAt: iso(session.updatedAt),
					cwd: session.cwd ?? null,
					branch: session.worktree?.branch ?? session.branch ?? null,
					worktree: session.worktree ?? null,
					resumable: session.resumableHere || session.worktree !== undefined,
				})),
				more: sessions.length - shown.length,
				failures,
			},
		};
	}

	private async resume(
		command: Extract<TellCommand, { verb: "agent-resume" }>,
	): Promise<TellAnswer> {
		const workspace = this.workspace(
			this.workspaceOrCallers(command.workspace),
		);
		const { sessions } = await this.pastSessions(workspace, command.profile);
		const exact = sessions.filter(
			({ session }) => session.id === command.session,
		);
		const matches =
			exact.length > 0
				? exact
				: sessions.filter(
						({ session }) =>
							command.session.length >= 4 &&
							session.id.startsWith(command.session),
					);
		if (matches.length === 0)
			throw new Error(
				`there is no earlier session ${JSON.stringify(command.session)} in ${workspace.root}. Run 'devhub --tell sessions --workspace ${workspace.id}'.`,
			);
		if (new Set(matches.map(({ session }) => session.id)).size > 1)
			throw new Error(
				`${JSON.stringify(command.session)} is the start of more than one session's id: ${matches.map(({ session }) => session.id).join(", ")}.`,
			);
		const { profile, session } = matches[0]!;
		// Two profiles of one kind both list the session (the listing shows it
		// once, under the first): which one goes on with it is the caller's.
		if (command.profile === undefined) {
			const kind = this.ports
				.profiles()
				.find((one) => one.id === profile)?.kind;
			const same = this.ports
				.profiles()
				.filter((one) => one.kind === kind)
				.map((one) => one.id);
			if (same.length > 1)
				throw new Error(
					`--profile is required: session ${session.id} is a ${kind ?? "?"} session, and ${same.join(", ")} all run ${kind ?? "it"} (see devhub --tell profiles)`,
				);
		}
		if (!session.resumableHere && session.worktree === undefined)
			throw new Error(
				`session ${session.id} ran in ${session.cwd ?? "another folder"}, and its CLI resumes it only there: open that folder as a workspace and resume it from there.`,
			);
		const agentId = await this.ports.resumeSession(
			workspace.id,
			profile,
			session,
		);
		if (command.name !== undefined)
			await this.ports.renameAgent(agentId, command.name);
		const placed = this.ports
			.workspaces()
			.find((each) => each.agents.some((one) => one.id === agentId));
		const root = placed?.root ?? session.worktree?.root ?? workspace.root;
		return {
			message: `Agent ${agentId} (${profile}) is going on with ${JSON.stringify(sessionTitle(session))} (${session.id}) in ${root}.`,
			data: {
				agentId,
				session: session.id,
				profile,
				workspaceId: placed?.id ?? null,
				root,
			},
		};
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
		const instead = ASKS_IN_THE_WINDOW[id];
		if (instead !== undefined)
			throw new Error(
				`${known.category}: ${known.label} puts a picker or a question up in DevHub's window, which a command line does not do. ${instead}`,
			);
		if (!FOCUS_FREE_COMMANDS.has(id))
			throw new Error(
				`${known.category}: ${known.label} changes what DevHub's window shows or where its keyboard is, and a command line never does: the person is doing something else. 'focus <agent|workspace>' is the one command that goes somewhere; 'run' takes only ${[...FOCUS_FREE_COMMANDS].join(", ")}.`,
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

/** A session's name in a line: its title, or the agent's name it ran under. */
function sessionTitle(session: TellPastSession): string {
	return session.title.length > 0 ? session.title : (session.agentName ?? "");
}

function sessionLine(
	profile: string,
	session: TellPastSession,
	now: number,
): string {
	const worktree = session.worktree;
	return [
		session.id,
		profile,
		session.updatedAt === undefined
			? "-"
			: `${span(now - session.updatedAt)} ago`,
		JSON.stringify(clip(session.title).slice(0, 80)),
		session.agentName === undefined ? undefined : `(${session.agentName})`,
		worktree !== undefined
			? `worktree ${worktree.root}${worktree.branch === undefined ? "" : ` (${worktree.branch})`}${worktree.present ? "" : ", gone: checked out again on resume"}`
			: session.branch === undefined
				? undefined
				: `branch ${session.branch}`,
		session.resumableHere || worktree !== undefined
			? undefined
			: `not resumable here (ran in ${session.cwd ?? "another folder"})`,
	]
		.filter((part) => part !== undefined)
		.join("  ");
}

/** One `wait --any` answer, as a line: who, why, and how to read it. */
function newsLine(news: {
	readonly agentId: string;
	readonly name: string;
	readonly status: string;
	readonly reasons: readonly string[];
	readonly unread: number;
	readonly since: string | null;
	readonly cursor: string | null;
	readonly requests: readonly {
		readonly id: string;
		readonly kind: string;
		readonly answerable: boolean;
	}[];
	readonly failure: string | null;
}): string {
	const why = [
		news.reasons.includes("output")
			? `${String(news.unread)} new entr${news.unread === 1 ? "y" : "ies"}, turn over`
			: undefined,
		...news.requests.map((request) =>
			request.answerable
				? `question ${request.id}`
				: `${request.kind === "tool" || request.kind === "command" || request.kind === "file-change" ? "permission prompt" : request.kind} ${request.id} (answer in DevHub: tell the person)`,
		),
		news.failure === null ? undefined : `failed: ${news.failure}`,
	].filter((part) => part !== undefined);
	return `${news.name} (${news.agentId}) is ${news.status}: ${why.join("; ")}; cursor ${news.cursor ?? "-"}. Read: devhub --tell agent read ${news.agentId} ${news.since === null ? "--last 20" : `--since ${news.since}`}`;
}

/** `agent status`, as lines of text. */
/** `--action none`: start the agent and tell it nothing. */
export const NO_ACTION = "none";

/** Every missing or wrong choice of one command, refused together and before anything runs. */
function refuseMissing(missing: readonly string[]): void {
	if (missing.length === 0) return;
	throw new Error(missing.join("\n"));
}

/** `role=reviewer parent=ab12`, or nothing for an agent with no metadata. */
function metaWords(meta: Readonly<Record<string, string>>): string | undefined {
	const entries = Object.entries(meta);
	return entries.length === 0
		? undefined
		: entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

/** A template's first line that says something, for a listing. */
function promptSummary(template: string): string {
	const line =
		template
			.split("\n")
			.map((each) => each.trim())
			.find((each) => each.length > 0) ?? "";
	return [...line].length > 80 ? `${[...line].slice(0, 79).join("")}…` : line;
}

/**
 * The palette commands that put a picker or a question up in the window, and
 * what to run instead. `run` refuses them: a command line never leaves a
 * sheet over the person's window that nobody there asked for.
 */
/**
 * The palette commands `run` runs: those that change neither the selection,
 * nor what the window shows, nor the keyboard, nor which window is in front.
 * Every other one moves something the person is using, and only `focus`
 * (or an explicit `--focus`) may do that from a command line.
 */
const FOCUS_FREE_COMMANDS: ReadonlySet<string> = new Set([
	"refresh_repositories",
	"mark_agent_unread",
]);

const ASKS_IN_THE_WINDOW: Readonly<Record<string, string>> = {
	add_workspace: "Use 'workspace open <path>'.",
	add_agent:
		"Use 'agent new [--profile <p>] [--gui|--tui]' ('profiles' lists them).",
	open_issue_picker:
		"Use 'issue assign <url>' ('issue actions' lists the actions).",
	open_tab_picker: "Use 'focus <agent|workspace>'.",
	send_agent_action: "Use 'agent send <a> <text>'.",
	rename_agent: "Use 'agent rename <a> <name>'.",
	close_selection:
		"Use 'agent stop <a>' for an agent, or 'terminal close' for your terminal.",
	close_workspace: "Close a workspace in DevHub.",
	restart_agent: "Use 'agent restart <a>'.",
	open_recently_closed: "Use 'run reopen_closed' for the newest one.",
	preview_color_theme: "Choose a theme in DevHub.",
	show_chord_help: "Run 'commands' for the list.",
	open_command_palette: "Run 'commands' and 'run <command-id>'.",
};

function statusLines(state: TellAgentStatus, now: number): string[] {
	const since =
		state.statusSince === null
			? ""
			: ` for ${span(now - Date.parse(state.statusSince))} (since ${state.statusSince})`;
	const cache = state.promptCache;
	return [
		`${state.name} (${state.agentId})  ${state.kind}/${state.presentation}, profile ${state.profile}, in ${state.workspace.name} (${state.workspace.root})`,
		`status    ${state.status}${since}${state.turn === null ? "" : `, turn ${state.turn}`}${state.control === "running" ? "" : `, ${state.control}`}`,
		...(Object.keys(state.meta).length === 0
			? []
			: [`meta      ${metaWords(state.meta) ?? ""}`]),
		`activity  ${state.activity ?? "-"}${state.lastActivityAt === null ? "" : ` (last change ${span(now - Date.parse(state.lastActivityAt))} ago)`}`,
		...(state.requests === null
			? []
			: [
					`requests  ${
						state.requests.open.length === 0
							? "none"
							: state.requests.open
									.map((request) =>
										request.answerable
											? `question ${request.id}`
											: `${request.kind} ${request.id} (answer in DevHub)`,
									)
									.join(", ")
					}`,
				]),
		...(state.unread === null
			? []
			: [
					`unread    ${String(state.unread.entries)} entr${state.unread.entries === 1 ? "y" : "ies"} you have not read; cursor ${state.unread.cursor ?? "-"}${state.unread.since === null ? "" : `, --since ${state.unread.since}`}`,
				]),
		...(state.context === null
			? []
			: [
					`context   ${String(state.context.tokens)}${state.context.window === null ? "" : ` / ${String(state.context.window)}`} tokens${state.context.percent === null ? "" : ` (${String(state.context.percent)}%)`}`,
				]),
		...(cache === null
			? []
			: [
					`cache     ${cache.cold === null ? "no cached prefix" : cache.cold ? "cold" : `warm until ${cache.expiresAt ?? "-"}`} (TTL ${String(cache.ttlSeconds)}s)${cache.hitRatio === null ? "" : `, hit ${String(Math.round(cache.hitRatio * 100))}%`}, ${String(cache.misses)} miss(es)${cache.autoCompactAt === null ? "" : `, compacted at ${cache.autoCompactAt}`}`,
				]),
		...(state.failure === null ? [] : [`failure   ${state.failure}`]),
	];
}

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
				: caller === undefined || caller.paneless === true
					? (caller?.label ?? OUTSIDE_LABEL)
					: "a terminal outside any agent";
	return `answered via devhub CLI by ${who}`;
}
