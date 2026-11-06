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
	ToolOutput,
	TranscriptEntry,
	Usage,
} from "../../../model/conversation.js";
import type { PastSession } from "../../agent/conversation/resume.js";
import type {
	EscalationWire,
	OrchestratorBoardWire,
	WorkspaceRepositoryWire,
} from "../../../ipc/contract.js";
import type { UsageReport } from "../../shell/usageLimits.js";
import { usageJson, usageText } from "./usage.js";
import { ORCHESTRATOR_CANNOT_CLOSE } from "./windowActs.js";
import { ISSUE_LINK_KEY } from "../../orchestrator/invariant.js";
import { breachWords, type Breach } from "../../orchestrator/events.js";
import type {
	StatusItem,
	SubjectStatus,
} from "../../orchestrator/orchestratorService.js";
import {
	DEVHUB_LINK_FORMS,
	formatDevhubLink,
	isDevhubLink,
	owningWorkspace,
	parseDevhubLink,
	type DevhubLink,
} from "../../../model/devhubLink.js";
import { dueWords } from "../../../model/escalations.js";
import {
	TELL_USAGE,
	type AgentWaitUntil,
	type AnswerPart,
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
	/** Under the orchestrator's management (`Agent.managed`). */
	readonly managed: boolean;
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
}

export interface TellWorkspace {
	readonly id: string;
	readonly name: string;
	readonly root: string;
	/** `local`, or `ssh:<host>`. */
	readonly machine: string;
	readonly scratch: boolean;
	/** The Orchestrator row's Workspace (addressed as "orchestrator"). */
	readonly orchestrator?: boolean;
	readonly selected: boolean;
	readonly branch: string | undefined;
	/** The main checkout, when this workspace is a worktree of one. */
	readonly worktreeOf: string | undefined;
	readonly repositoryUrl: string | undefined;
	readonly issue: string | undefined;
	/** The dev container the editor is attached to, when it is. */
	readonly container: string | undefined;
	readonly agents: readonly TellAgent[];
	/** Its Issue, pull request, review and CI, as the Sidebar row's tooltip has them. */
	readonly review: TellReview;
}

/**
 * What a Workspace's branch is about on GitHub: the facts the Sidebar row's
 * tooltip shows (`rowDescription.ts`), from the same projection
 * (`RepositoryStatusWire`) and nothing fetched for the command line. A
 * stable shape: every field is there, null when DevHub does not know it.
 */
export interface TellReview {
	/** The Issue the branch names, as GitHub last answered. */
	readonly issue: {
		readonly number: number;
		readonly title: string;
		readonly url: string;
		readonly state: "open" | "closed";
		/** The Projects boards it is on and its lane (Status) on each. */
		readonly projects: readonly {
			readonly project: string;
			readonly lane: string | null;
		}[];
	} | null;
	/** The pull request out from the branch (the live one, if several). */
	readonly pullRequest: {
		readonly number: number;
		readonly title: string;
		readonly url: string;
		readonly state: "open" | "closed" | "merged";
		readonly draft: boolean;
		/** GitHub's review decision; `none` when it has none. */
		readonly review:
			| "approved"
			| "changes_requested"
			| "review_required"
			| "none";
	} | null;
	/**
	 * Its review conversations nobody has resolved. `uncounted`: threads past
	 * the page the count was read from (nought under a hundred), so
	 * `unresolved` is then a lower bound. Null without a pull request.
	 */
	readonly conversations: {
		readonly unresolved: number;
		readonly uncounted: number;
	} | null;
	/**
	 * Its CI on the head commit: GitHub's rollup verdict, and how many of
	 * `total` checks fail and have not finished. `passedOrSkipped` is the rest:
	 * DevHub does not count passed apart from skipped or neutral. Null when
	 * nothing has reported on that commit (or there is no pull request).
	 */
	readonly checks: {
		readonly state: "passing" | "failing" | "pending";
		readonly total: number;
		readonly failing: number;
		readonly pending: number;
		readonly passedOrSkipped: number;
	} | null;
	/** The branch names this Issue, and GitHub has not answered about it yet. */
	readonly pendingIssue: number | null;
	/** Why DevHub cannot say what the branch is about (GitHub's or git's words). */
	readonly unavailable: string | null;
	/** When DevHub last finished a look at this Workspace (git and GitHub). */
	readonly fetchedAt: string | null;
	/** Why the last look was incomplete, if it was: what is shown may be older. */
	readonly stale: string | null;
}

/** `TellReview` from the Sidebar's projection of one Workspace. */
export function tellReview(
	repository: WorkspaceRepositoryWire | undefined,
	fetchedAt: string | undefined,
	stale: string | undefined,
): TellReview {
	const issue = repository?.issue;
	const pullRequest = repository?.pullRequest;
	const checks = pullRequest?.checks;
	return {
		issue:
			issue === undefined
				? null
				: {
						number: issue.number,
						title: issue.title,
						url: issue.url,
						state: issue.state,
						projects: (issue.projects ?? []).map((one) => ({
							project: one.project,
							lane: one.status ?? null,
						})),
					},
		pullRequest:
			pullRequest === undefined
				? null
				: {
						number: pullRequest.number,
						title: pullRequest.title,
						url: pullRequest.url,
						state: pullRequest.state === "draft" ? "open" : pullRequest.state,
						draft: pullRequest.state === "draft",
						review: pullRequest.review ?? "none",
					},
		conversations:
			pullRequest === undefined ? null : { ...pullRequest.conversations },
		checks:
			checks === undefined
				? null
				: {
						state: checks.state,
						total: checks.total,
						failing: checks.failing,
						pending: checks.pending,
						passedOrSkipped: Math.max(
							0,
							checks.total - checks.failing - checks.pending,
						),
					},
		pendingIssue: repository?.pending?.number ?? null,
		unavailable: repository?.unavailable?.reason ?? null,
		fetchedAt: fetchedAt ?? null,
		stale: stale ?? null,
	};
}

/** `workspace close`'s answers to the window's questions, as flags. */
export interface TellCloseAnswers {
	/** The worktree folder: kept, or removed (the window's two answers). */
	readonly worktree: "keep" | "remove" | undefined;
	/** Busy agents: stopped with the close. */
	readonly agents: "stop" | undefined;
	/** Running terminals: ended with the close. */
	readonly terminals: "close" | undefined;
	/** Unsaved editors: their changes discarded. */
	readonly discardUnsaved: boolean;
}

/** One question the window would ask about a close, as the flag that answers it. */
export interface TellCloseQuestion {
	readonly flag: string;
	/** Its values; empty for a switch. */
	readonly values: readonly string[];
	readonly why: string;
}

/** What `workspace close` came to. */
export type TellClosed =
	| {
			readonly kind: "closed";
			/** `none`: not a worktree; `kept` or `removed`: its folder. */
			readonly worktree: "none" | "kept" | "removed";
			readonly busyTerminalProcesses: number;
			/** The unsaved editors whose changes were discarded. */
			readonly discarded: readonly string[];
	  }
	| {
			/** Nothing was done: these are open. */
			readonly kind: "questions";
			readonly questions: readonly TellCloseQuestion[];
	  };

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
	readonly url: string;
	/** The clone, always named: the command line never picks one. */
	readonly repo: string;
	readonly branch: string | undefined;
	readonly place: "worktree" | "root";
	readonly profile: string | undefined;
	readonly action: string | undefined;
	readonly editorOnly: boolean;
	readonly presentation: "gui" | "tui" | undefined;
	/** The agent's name from the start, as `agent new --name`; absent: DevHub's label. */
	readonly name?: string;
	/**
	 * `--offline`: when the fetch `origin` gets first fails, go on from the
	 * copy on disk rather than stop. Without it a failed fetch is the answer.
	 */
	readonly offline: boolean;
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
	/** The Orchestrator row: board, escalations, events. */
	readonly orchestrator: TellOrchestratorPorts;
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
	/** The /devhub-orchestrator skill's SKILL.md, the launcher it names, and where it is. */
	orchestratorSkill(): {
		readonly text: string;
		readonly cli: string;
		readonly skillFile: string;
	};
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
	/** Put an agent under the orchestrator's management, or take it out. */
	setAgentManaged(agentId: string, managed: boolean): Promise<void>;
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
		/**
		 * What became of the fetch `origin` got first: `on-disk` when it failed
		 * and `--offline` went on anyway (or there is no `origin`); absent when
		 * nothing was fetched — the clone as it stands.
		 */
		readonly origin?: "fetched" | "on-disk";
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
	/**
	 * What is at `path` on `machine` (`local`, `ssh:<host>`): a `devhub:file`
	 * link must name a file. Absent: not checked (the window checks it again
	 * when the link is followed).
	 */
	fileKind?(
		machine: string,
		path: string,
	): Promise<"file" | "directory" | "absent">;
	/** The agent running `session` (an id, or a unique prefix of one), if one is. */
	sessionAgent?(session: string): Promise<string | undefined>;
	notify(text: string): void;
	/**
	 * The Sidebar's usage readout as it stands, each window with when it was
	 * last seen (`usageLimits.ts`). Reads nothing from a CLI.
	 */
	usage(): UsageReport;
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
	/**
	 * Close Workspace, as the window does (`tell/windowActs.ts`): every
	 * question its sheets ask answered by `answers`, or nothing done and the
	 * open ones answered back. Never draws a sheet or moves the selection
	 * itself; the model's own rule picks the next row when it was selected.
	 */
	closeWorkspace(
		workspaceId: string,
		answers: TellCloseAnswers,
	): Promise<TellClosed>;
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
	/**
	 * The agent picker's listing for `folder` on `machine`, whether or not a
	 * Workspace has it open (`here`), or every folder's sessions as the CLIs
	 * keep them, newest first and bounded by each listing (`everywhere`).
	 */
	pastSessionsIn(
		folder: string,
		machine: string,
		profileId: string,
		scope: "here" | "everywhere",
	): Promise<readonly TellPastSession[]>;
	/**
	 * Go on with one in `folder`, opened as a Workspace if it is not open —
	 * in the Sidebar, unselected, nothing focused — or, for a session of
	 * another worktree (`session.worktree`), in that worktree of the clone at
	 * `folder`, opened or checked out again as the picker does.
	 */
	resumeSessionIn(
		folder: string,
		machine: string,
		profileId: string,
		session: TellPastSession,
	): Promise<string>;
	/** What `path` is on `machine`: a folder, a file, or nothing. */
	pathKind(
		path: string,
		machine: string,
	): Promise<"directory" | "file" | "absent">;
	/**
	 * Set (or, with undefined, remove) one pair of a session no agent runs
	 * now, checked as an agent's are (`model/sessionMeta.ts`); answers its
	 * pairs. Refused for a session an agent runs: that is `agent meta`'s.
	 */
	setSessionMeta(
		profileId: string,
		session: string,
		key: string,
		value: string | undefined,
	): Promise<Readonly<Record<string, string>>>;
}

/** A new escalation, as `escalation new` asks for one. */
export interface TellNewEscalation {
	readonly title: string;
	readonly markdown: string;
	readonly options: readonly string[];
	readonly agents: readonly string[];
	readonly links: readonly string[];
	readonly workspaceId: string | undefined;
	readonly rank: TellEscalationRank;
	/** Born waiting (`--wait`, `--at`). */
	readonly wait?: { readonly trigger: string; readonly dueAt?: number };
}

/** The orchestrator's ranking of one, as `--priority`/`--effort`/`--rank-note` give it. */
export interface TellEscalationRank {
	readonly priority?: "high" | "normal" | "low";
	readonly effort?: "quick" | "normal" | "deep";
	/** `""` takes the note away. */
	readonly note?: string;
}

/**
 * The Orchestrator row, as far as a command line reaches into it.
 *
 * **There is no answer here.** The person answers an escalation in DevHub's
 * window and nowhere else (`OrchestratorActionsBridge.answerEscalation`); a
 * port that wrote one would let an agent decide for the person. The tests
 * hold this shape to that (`service.test.ts`).
 */
export interface TellOrchestratorPorts {
	/** The board, as the Orchestrator screen draws it. */
	board(): OrchestratorBoardWire;
	/** Every escalation, closed ones included. */
	escalations(): readonly EscalationWire[];
	raise(request: TellNewEscalation): EscalationWire;
	ask(
		id: number,
		markdown: string,
		options: readonly string[],
		links?: readonly string[],
	): EscalationWire;
	close(id: number, note: string | undefined): EscalationWire;
	/**
	 * Parked in in_progress by the orchestrator (`escalation hold`): an entry
	 * on its side, never a human one.
	 */
	hold(id: number, note: string | undefined): EscalationWire;
	/** Parked on an outside condition (`escalation wait`): 待機中. */
	wait(id: number, trigger: string, dueAt: number | undefined): EscalationWire;
	/** Off its wait, to in_progress (`escalation resume`). */
	resumeWait(id: number, note: string | undefined): EscalationWire;
	/** More it is about (`escalation link`): an agent, links. */
	link(
		id: number,
		more: { readonly agentId?: string; readonly links?: readonly string[] },
	): EscalationWire;
	/** Ranked again by the orchestrator. Not an answer: it writes no entry. */
	rank(id: number, rank: TellEscalationRank): EscalationWire;
	/**
	 * The orchestrator has been shown escalation `id`'s first `entries`
	 * entries (`escalation show`): an answer among them is read, and 停滞
	 * (on the board) may start counting.
	 */
	acknowledge?(id: number, entries: number): void;
	/** `[orchestrator] root`, for a refusal that names it. */
	configuredRoot(): string | undefined;
	start(request: {
		readonly root: string;
		readonly profile: string;
		readonly presentation: "gui" | "tui";
		readonly prompt: string | undefined;
	}): Promise<string>;
	pause(): void;
	/** How many held lines went out: at once, the sources catching up alongside. */
	resume(): number;
	/** The last `last` events, oldest first, each with what came of it. */
	events(last: number): readonly TellEventEntry[];
	/** A `custom.*` event, as any source dispatches one. */
	emit(type: string, text: string): TellEventEntry;
	timers(): readonly TellTimer[];
	/** For this session; refused with the rule it breaks. */
	setTimer(name: string, interval: string): TellTimer;
	/** Off for this session; false when no such timer runs. */
	clearTimer(name: string): boolean;
	/** Show the Orchestrator screen: the one focus this family has. */
	focus(): Promise<void>;
	/** How an agent stands against the invariant (`orchestrator/invariant.ts`). */
	standing(agentId: string): TellStanding | undefined;
	/**
	 * `status`: one subject's whole state now — an item (URL or
	 * `owner/repo#N`) or an agent. Undefined when DevHub has not read it.
	 */
	status(
		target: { readonly item: string } | { readonly agentId: string },
	): SubjectStatus | undefined;
	/** `agent keep A --note`: leave an agent that needs action as it is, for `note`. */
	keep(
		agentId: string,
		note: string,
	): { readonly note: string; readonly at: number };
	/** `agent keep A --clear`: whether it was being kept. */
	unkeep(agentId: string): boolean;
}

/** An agent's standing against the invariant, as `agent status` reads it. */
export interface TellStanding {
	readonly settled: boolean;
	/** The clause it fails (managed agents), as `needs_action` says it. */
	readonly breach?: Breach;
	readonly waiting?: {
		readonly escalationId: number;
		readonly trigger: string;
	};
	readonly kept?: { readonly note: string; readonly at: number };
}

/** One event in the orchestrator's log (`orchestrator events`). */
export interface TellEventEntry {
	readonly seq: number;
	/** ms since the epoch. */
	readonly at: number;
	readonly type: string;
	/**
	 * delivered, pending, filtered, coalesced (into `into`), dropped-stale,
	 * overflow, dropped.
	 */
	readonly fate: string;
	/** What `{EVENT}` holds for it. */
	readonly line: string;
	readonly into?: number;
	/** The event's fields, as `{EVENT_JSON}` carries them. */
	readonly event: Record<string, unknown>;
}

export interface TellTimer {
	readonly name: string;
	readonly interval: string;
	readonly source: "settings" | "session";
	/** ms since the epoch. */
	readonly nextAt: number;
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

	readonly #escalations = new Map<string, Map<number, number>>();

	/** How many entries of escalation `id` the caller has been shown (`escalation show`). */
	escalationSeen(caller: string, id: number): number | undefined {
		return this.#escalations.get(caller)?.get(id);
	}

	markEscalation(caller: string, id: number, entries: number): void {
		const byId = this.#escalations.get(caller) ?? new Map<number, number>();
		this.#escalations.set(caller, byId);
		byId.set(id, entries);
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
	/** Under the orchestrator's management (`agent manage`, `--managed`). */
	readonly managed: boolean;
	/**
	 * How it stands against the invariant: settled or not, the clause it
	 * fails as its `needs_action` line says it, the 待機中 escalation it is
	 * one of the agents of, and `agent keep`'s note. Null while no
	 * orchestrator service reads it. Its whole state: `status`.
	 */
	readonly invariant: {
		readonly settled: boolean;
		readonly needsAction: string | null;
		readonly waiting: {
			readonly escalationId: number;
			readonly trigger: string;
		} | null;
		readonly kept: { readonly note: string; readonly at: string } | null;
	} | null;
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
				const skill =
					command.orchestrator === true
						? this.ports.orchestratorSkill()
						: this.ports.skill();
				return { message: skill.text, data: skill };
			}
			case "workspaces":
				return this.listWorkspaces();
			case "workspace-open":
				return this.openWorkspace(command.path, command.worktree, caller);
			case "workspace-close":
				return this.closeWorkspace(command);
			case "workspace-status":
				return this.workspaceStatus(command.workspace);
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
			case "agent-manage":
				return this.manage(command.agent, command.managed);
			case "agent-keep":
				return this.keep(command.agent, command.note);
			case "agent-new":
				return this.newAgent(command);
			case "issue-assign":
				return this.assignIssue(command);
			case "agent-read":
				return command.entry !== undefined
					? this.readEntry(command.agent, command.entry)
					: this.read(
							command.agent,
							command.last,
							command.since,
							command.full === true,
						);
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
			case "session-meta":
				return this.sessionMeta(command);
			case "commands":
				return this.listCommands();
			case "run":
				return this.runCommand(command.command);
			case "focus":
				return this.focus(command.target);
			case "link":
				return this.makeLink(command);
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
			case "usage": {
				const now = this.clock.now();
				const report = this.ports.usage();
				return {
					message: usageText(report, now),
					data: usageJson(report, now),
				};
			}
			case "board":
				return this.board();
			case "status":
				return this.subjectStatus(command.ref);
			case "escalation-new":
				return this.raise(command);
			case "escalation-ask":
				return this.askAgain(command);
			case "escalation-show":
				return this.showEscalation(command.id);
			case "escalation-list":
				return this.listEscalations(command.state);
			case "escalation-close":
				return this.closeEscalation(command.id, command.note);
			case "escalation-hold":
				return this.holdEscalation(command.id, command.note);
			case "escalation-wait": {
				const waiting = this.ports.orchestrator.wait(
					command.id,
					command.trigger,
					command.at,
				);
				return {
					message: `#${String(waiting.id)} 「${waiting.title}」 waits on: ${command.trigger.trim()}${command.at === undefined ? "" : ` (waiting.changed, due, at ${new Date(command.at).toISOString()})`}. 'escalation resume', 'ask' or 'close' takes it off.`,
					data: waiting,
				};
			}
			case "escalation-resume": {
				const resumed = this.ports.orchestrator.resumeWait(
					command.id,
					command.note,
				);
				return {
					message: `Resumed #${String(resumed.id)} 「${resumed.title}」: in_progress.`,
					data: resumed,
				};
			}
			case "escalation-link":
				return this.linkEscalation(command);
			case "escalation-rank":
				return this.rankEscalation(command);
			case "orchestrator-start":
				return this.startOrchestrator(command);
			case "orchestrator-status":
				return this.orchestratorStatus();
			case "orchestrator-stop":
				return this.stop(this.orchestratorAgent("stop").id);
			case "orchestrator-restart":
				return this.restart(this.orchestratorAgent("restart").id);
			case "orchestrator-pause":
				this.ports.orchestrator.pause();
				return {
					message:
						"The orchestrator's events are paused: each is held (one line per subject), GitHub polling is suspended, and 'orchestrator resume' delivers them at once, as one message.",
					data: { paused: true },
				};
			case "orchestrator-resume": {
				const delivered = this.ports.orchestrator.resume();
				return {
					message: `The orchestrator's events are delivered again${delivered === 0 ? "" : `; ${String(delivered)} held line(s) went out as one message`}.`,
					data: { paused: false, delivered },
				};
			}
			case "orchestrator-events":
				return this.orchestratorEvents(command.last);
			case "orchestrator-emit": {
				const entry = this.ports.orchestrator.emit(command.type, command.text);
				return {
					message: `${entry.line}\n-- ${entry.fate}${entry.fate === "pending" ? ": it goes out with the next delivery" : ""}`,
					data: entry,
				};
			}
			case "orchestrator-timer-list":
				return this.timerList();
			case "orchestrator-timer-set": {
				const timer = this.ports.orchestrator.setTimer(
					command.name,
					command.interval,
				);
				return {
					message: `Timer ${timer.name} fires every ${timer.interval} for this session (next at ${new Date(timer.nextAt).toISOString()}).`,
					data: timer,
				};
			}
			case "orchestrator-timer-clear": {
				const cleared = this.ports.orchestrator.clearTimer(command.name);
				if (!cleared)
					throw new Error(
						`there is no timer ${command.name}. 'orchestrator timer list' lists them.`,
					);
				return {
					message: `Timer ${command.name} is off for this session.`,
					data: { name: command.name, cleared },
				};
			}
		}
	}

	// --- the Orchestrator row -----------------------------------------------

	private orchestratorAgent(act: string): TellAgent {
		const id = this.ports.orchestrator.board().orchestratorAgentId;
		if (id === undefined)
			throw new Error(
				`there is no orchestrator to ${act}. 'devhub --tell orchestrator start' starts one.`,
			);
		return this.agent(id);
	}

	/** Whether the caller is the orchestrator agent itself. */
	private callerIsOrchestrator(): boolean {
		const id = this.caller?.agentId;
		return (
			id !== undefined &&
			id === this.ports.orchestrator.board().orchestratorAgentId
		);
	}

	private escalation(id: number): EscalationWire {
		const found = this.ports.orchestrator
			.escalations()
			.find((one) => one.id === id);
		if (found === undefined)
			throw new Error(
				`there is no escalation #${String(id)}. Run 'devhub --tell escalation list'.`,
			);
		return found;
	}

	private board(): TellAnswer {
		const board = this.ports.orchestrator.board();
		const now = this.clock.now();
		const lines = [
			`orchestrator: ${board.orchestratorAgentId ?? "none"}${board.paused ? `  (events paused, ${String(board.held)} held)` : ""}`,
			`needs answer (${String(board.needsAnswer.length)}, priority then effort then age):`,
			...board.needsAnswer.map(
				(one) =>
					`  #${String(one.id)}  ${one.title}  waiting ${span(now - one.stateSince)}  [${rankText(one)}]${agentsText(one)}`,
			),
			`in progress (${String(board.inProgress.length)}):`,
			...board.inProgress.map(
				(one) =>
					`  #${String(one.id)}  ${one.title}  answered ${span(now - one.stateSince)} ago${agentsText(one)}${one.stalledSince === undefined ? "" : `  [停滞 ${span(now - one.stalledSince)}: no agent is working on it]`}`,
			),
			`waiting (${String(board.waiting.length)}, soonest first):`,
			...board.waiting.map((one) => {
				const wait = one.entries.at(-1);
				return `  #${String(one.id)}  ${one.title}  waiting on: ${wait?.markdown ?? ""}${wait?.dueAt === undefined ? "" : `  [${new Date(wait.dueAt).toISOString()}, ${dueWords(wait.dueAt, now)}]`}`;
			}),
			...needsActionLines(board, now),
		];
		return {
			message: lines.join("\n"),
			data: {
				orchestratorAgentId: board.orchestratorAgentId ?? null,
				paused: board.paused,
				held: board.held,
				needsAnswer: board.needsAnswer,
				inProgress: board.inProgress,
				waiting: board.waiting,
				graceMs: board.graceMs,
				needsAction: board.needsAction,
			},
		};
	}

	private async raise(
		command: Extract<TellCommand, { verb: "escalation-new" }>,
	): Promise<TellAnswer> {
		const agents = command.agents.map((name) => this.agent(name).id);
		const workspaceId =
			command.workspace === undefined
				? undefined
				: this.workspace(command.workspace).id;
		const links = await this.checkedLinks(command.links, command.body);
		const made = this.ports.orchestrator.raise({
			title: command.title,
			markdown: command.body,
			options: command.options,
			agents,
			links,
			workspaceId,
			rank: rankOf(command),
			...(command.wait === undefined
				? {}
				: {
						wait: {
							trigger: command.wait,
							...(command.at === undefined ? {} : { dueAt: command.at }),
						},
					}),
		});
		this.memory.markEscalation(
			callerKey(this.caller),
			made.id,
			made.entries.length,
		);
		return {
			message:
				made.state === "waiting"
					? `Raised #${String(made.id)} 「${made.title}」 in waiting: nothing is asked of the person yet.`
					: `Raised #${String(made.id)} 「${made.title}」: it waits for the person's answer (needs_answer).`,
			data: made,
		};
	}

	private async askAgain(
		command: Extract<TellCommand, { verb: "escalation-ask" }>,
	): Promise<TellAnswer> {
		const links = await this.checkedLinks(command.links ?? [], command.body);
		const asked =
			links.length === 0
				? this.ports.orchestrator.ask(command.id, command.body, command.options)
				: this.ports.orchestrator.ask(
						command.id,
						command.body,
						command.options,
						links,
					);
		this.memory.markEscalation(
			callerKey(this.caller),
			asked.id,
			asked.entries.length,
		);
		return {
			message: `Asked again on #${String(asked.id)}: it waits for the person's answer (needs_answer).`,
			data: asked,
		};
	}

	private showEscalation(id: number): TellAnswer {
		const one = this.escalation(id);
		// Being shown the thread is reading the answer: 'agent wait --any'
		// stops reporting it.
		this.memory.markEscalation(callerKey(this.caller), id, one.entries.length);
		if (this.callerIsOrchestrator())
			this.ports.orchestrator.acknowledge?.(id, one.entries.length);
		const lines = [
			`#${String(one.id)} ${one.title}  [${one.state}]`,
			`rank: ${rankText(one)}`,
			...(one.agents.length === 0
				? []
				: [
						`agents: ${one.agents.map((agent) => `${agent.name ?? "(gone)"} (${agent.agentId})`).join(", ")}`,
					]),
			...(one.links.length === 0 ? [] : [`links: ${one.links.join(" ")}`]),
			...one.entries.flatMap((entry) =>
				entry.kind !== undefined
					? ["", noteLine(entry)]
					: [
							"",
							`--- ${entry.role === "human" ? "the person (answer)" : "orchestrator"}, ${new Date(entry.at).toISOString()}`,
							entry.markdown,
							...(entry.options === undefined
								? []
								: [
										`options: ${entry.options.map((option) => JSON.stringify(option)).join(", ")}`,
									]),
						],
			),
			...(one.closed === undefined
				? []
				: [
						"",
						`--- closed ${new Date(one.closed.at).toISOString()}${one.closed.note === undefined ? "" : `: ${one.closed.note}`}`,
					]),
		];
		return { message: lines.join("\n"), data: one };
	}

	private listEscalations(
		state: "needs_answer" | "in_progress" | "waiting" | "closed" | undefined,
	): TellAnswer {
		const all = this.ports.orchestrator
			.escalations()
			.filter((one) =>
				state === undefined ? one.state !== "closed" : one.state === state,
			);
		const now = this.clock.now();
		return {
			message:
				all.length === 0
					? `No ${state ?? "open"} escalations.`
					: all
							.map(
								(one) =>
									`#${String(one.id)}  ${one.state}  ${span(now - one.stateSince)}  [${rankText(one)}]  ${one.title}${agentsText(one)}`,
							)
							.join("\n"),
			data: { escalations: all },
		};
	}

	private closeEscalation(id: number, note: string | undefined): TellAnswer {
		const closed = this.ports.orchestrator.close(id, note);
		return {
			message: `Closed #${String(closed.id)} 「${closed.title}」.`,
			data: closed,
		};
	}

	private holdEscalation(id: number, note: string | undefined): TellAnswer {
		const held = this.ports.orchestrator.hold(id, note);
		return {
			message: `Held #${String(held.id)} 「${held.title}」 in in_progress; 'escalation ask' puts it back to needs_answer.`,
			data: held,
		};
	}

	private rankEscalation(
		command: Extract<TellCommand, { verb: "escalation-rank" }>,
	): TellAnswer {
		const ranked = this.ports.orchestrator.rank(command.id, rankOf(command));
		return {
			message: `#${String(ranked.id)} is ranked ${rankText(ranked)}.`,
			data: ranked,
		};
	}

	private linkEscalation(
		command: Extract<TellCommand, { verb: "escalation-link" }>,
	): TellAnswer {
		const agent =
			command.agent === undefined ? undefined : this.agent(command.agent);
		const links = command.links ?? [];
		const linked = this.ports.orchestrator.link(command.id, {
			...(agent === undefined ? {} : { agentId: agent.id }),
			...(links.length === 0 ? {} : { links }),
		});
		const what = [
			...(agent === undefined ? [] : [`${agent.name} (${agent.id})`]),
			...links,
		].join(", ");
		return {
			message: `#${String(linked.id)} is about ${what} too.`,
			data: linked,
		};
	}

	private async startOrchestrator(
		command: Extract<TellCommand, { verb: "orchestrator-start" }>,
	): Promise<TellAnswer> {
		const missing: string[] = [];
		if (command.root === undefined) {
			const configured = this.ports.orchestrator.configuredRoot();
			missing.push(
				`--root <path> is required: the folder the orchestrator runs in${configured === undefined ? "" : ` (orchestrator.root is ${configured})`}`,
			);
		}
		const profile = this.requiredProfile(command.profile, missing);
		this.requiredMode(profile, command.presentation, missing);
		const running = this.ports.orchestrator.board().orchestratorAgentId;
		if (running !== undefined)
			missing.push(
				`an orchestrator is already running (${running}): one at a time. 'orchestrator stop' first`,
			);
		refuseMissing(missing);
		const agentId = await this.ports.orchestrator.start({
			root: command.root!,
			profile: profile!.id,
			presentation: command.presentation!,
			prompt: command.prompt,
		});
		return {
			message: `The orchestrator ${agentId} (${profile!.id}, ${command.presentation!.toUpperCase()}) is starting in ${command.root!}; it is sent ${command.prompt === undefined ? "the init event" : "--prompt"} once it is ready. 'devhub --tell focus orchestrator' shows it.`,
			data: { agentId, root: command.root, profile: profile!.id },
		};
	}

	private orchestratorEvents(last: number): TellAnswer {
		const entries = this.ports.orchestrator.events(last);
		return {
			message:
				entries.length === 0
					? "No events yet."
					: entries
							.map(
								(entry) =>
									`${String(entry.seq).padStart(4)} ${new Date(entry.at).toISOString().slice(11, 19)} ${entry.fate.padEnd(9)} ${entry.line}${entry.into === undefined ? "" : ` (→ ${String(entry.into)})`}`,
							)
							.join("\n"),
			data: { events: entries },
		};
	}

	private timerList(): TellAnswer {
		const timers = this.ports.orchestrator.timers();
		return {
			message:
				timers.length === 0
					? "No timers. 'orchestrator timer set NAME INTERVAL' starts one; [[orchestrator.timers]] are the defaults."
					: timers
							.map(
								(timer) =>
									`${timer.name}  every ${timer.interval}  (${timer.source})  next ${new Date(timer.nextAt).toISOString()}`,
							)
							.join("\n"),
			data: { timers },
		};
	}

	private orchestratorStatus(): TellAnswer {
		const board = this.ports.orchestrator.board();
		const agent =
			board.orchestratorAgentId === undefined
				? undefined
				: this.liveAgents().get(board.orchestratorAgentId);
		const counts = {
			needsAnswer: board.needsAnswer.length,
			inProgress: board.inProgress.length,
			waiting: board.waiting.length,
		};
		return {
			message: [
				agent === undefined
					? "No orchestrator is running."
					: `orchestrator: ${agent.name} (${agent.id}), ${agent.status}${agent.presentation === "gui" ? "" : ", terminal"}`,
				`needs answer ${String(counts.needsAnswer)}, in progress ${String(counts.inProgress)}, waiting ${String(counts.waiting)}`,
				`events: ${board.paused ? "paused" : "delivered"}${board.held > 0 ? ` (${String(board.held)} pending)` : ""}`,
				githubPollingLine(board),
			].join("\n"),
			data: {
				agentId: agent?.id ?? null,
				status: agent?.status ?? null,
				presentation: agent?.presentation ?? null,
				counts,
				paused: board.paused,
				held: board.held,
				github: board.github,
				root: this.ports.orchestrator.configuredRoot() ?? null,
			},
		};
	}

	/**
	 * What the board has for the orchestrator that it has not been shown:
	 * answers it has not read (`escalation show`). Only the orchestrator is
	 * woken by these.
	 */
	private boardNews(): {
		readonly answered: readonly {
			readonly id: number;
			readonly title: string;
		}[];
	} {
		if (!this.callerIsOrchestrator()) return { answered: [] };
		const caller = callerKey(this.caller);
		const board = this.ports.orchestrator.board();
		return {
			answered: board.inProgress
				.filter((one) =>
					one.entries
						.slice(this.memory.escalationSeen(caller, one.id) ?? 0)
						.some(
							(entry) => entry.role === "human" && entry.kind === undefined,
						),
				)
				.map((one) => ({ id: one.id, title: one.title })),
		};
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
		if (name === "orchestrator") {
			const own = all.find((workspace) => workspace.orchestrator === true);
			if (own) return own;
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

	/**
	 * `status <item|agent>`: one subject's whole state now, as one call — an
	 * item's state, assignment, lanes and pull request, the agents linked to
	 * it and how each stands, the escalations about it, the clause it fails
	 * and `agent keep`'s note; for an agent, all of that of its item, and its
	 * Workspace's facts as the Sidebar's tooltip has them.
	 */
	private subjectStatus(ref: string): TellAnswer {
		const now = this.clock.now();
		const isItem =
			/^https?:\/\//iu.test(ref.trim()) ||
			/^[\w.-]+\/[\w.-]+#\d+$/u.test(ref.trim());
		if (isItem) {
			const found = this.ports.orchestrator.status({ item: ref });
			if (found === undefined) {
				// Say why here, with what GitHub polling says now: "see another
				// command" left the person guessing whether the item is off the
				// Projects or the Projects were never read.
				const github = this.ports.orchestrator.board().github;
				const why =
					github.assigned === undefined
						? "the registered Projects have not been read (yet)"
						: `it is not an open item of the registered Projects (${String(github.assigned)} assigned to me there)`;
				throw new Error(
					`DevHub has not read ${ref}: ${why}. Only the Issues and pull requests on [orchestrator.github] projects are read, while an orchestrator runs. ${githubPollingLine(this.ports.orchestrator.board())}`,
				);
			}
			return {
				message: subjectText(found, undefined, now),
				data: subjectJson(found, undefined),
			};
		}
		const agent = this.agent(ref);
		const found = this.ports.orchestrator.status({ agentId: agent.id });
		if (found === undefined)
			throw new Error(
				`${agent.name} (${agent.id}) is not read by the orchestrator's invariant (the orchestrator agent itself never is, and nothing is read before DevHub has started).`,
			);
		const workspace = this.ports
			.workspaces()
			.find((one) => one.agents.some((each) => each.id === agent.id));
		return {
			message: subjectText(found, workspace?.review, now),
			data: subjectJson(found, workspace?.review ?? null),
		};
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
				...reviewFacts(workspace),
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
			data: { workspaces: workspaces.map(workspaceRow) },
		};
	}

	/** `workspace status W`: one Workspace, its branch's GitHub facts in full. */
	private workspaceStatus(name: string): TellAnswer {
		const workspace = this.workspace(name);
		const { review } = workspace;
		const lines = [
			`${workspace.scratch ? "Scratch" : workspace.name} (${workspace.id})  ${workspace.root}${workspace.machine === "local" ? "" : `  on ${workspace.machine}`}${workspace.selected ? "  [selected]" : ""}`,
			`branch: ${workspace.branch ?? "none (not a repository, or not read yet)"}`,
			...(workspace.worktreeOf === undefined
				? []
				: [`worktree of: ${workspace.worktreeOf}`]),
			review.issue !== null
				? `Issue #${String(review.issue.number)} (${review.issue.state}): ${review.issue.title}  ${review.issue.url}${review.issue.projects.length === 0 ? "" : `\nlane: ${review.issue.projects.map((one) => `${one.lane ?? "none"} (${one.project})`).join(", ")}`}`
				: review.pendingIssue !== null
					? `Issue #${String(review.pendingIssue)}: GitHub has not answered yet`
					: "Issue: none",
			review.pullRequest === null
				? "pull request: none"
				: `pull request #${String(review.pullRequest.number)} (${review.pullRequest.draft ? "draft" : review.pullRequest.state}): ${review.pullRequest.title}  ${review.pullRequest.url}\nreview decision: ${review.pullRequest.review}`,
			...(review.conversations === null
				? []
				: [`review: ${conversationsText(review.conversations)}`]),
			...(review.pullRequest === null
				? []
				: [
						review.checks === null
							? "CI: nothing has reported on its head commit"
							: `CI: ${review.checks.state} - ${String(review.checks.failing)} failing, ${String(review.checks.pending)} pending, ${String(review.checks.passedOrSkipped)} passed or skipped, of ${String(review.checks.total)}`,
					]),
			...(review.unavailable === null
				? []
				: [`unknown: ${review.unavailable}`]),
			`as of: ${review.fetchedAt ?? "DevHub has not finished a look at it yet"}${review.stale === null ? "" : ` (the last look was incomplete: ${review.stale})`}`,
		];
		return { message: lines.join("\n"), data: workspaceRow(workspace) };
	}

	/**
	 * `workspace close W`: Close Workspace, with every question the window
	 * would ask answered by a flag. Not your own: that would stop you.
	 */
	private async closeWorkspace(
		command: Extract<TellCommand, { verb: "workspace-close" }>,
	): Promise<TellAnswer> {
		const workspace = this.workspace(command.workspace);
		if (workspace.scratch)
			throw new Error(
				"Scratch cannot be closed: it is today's folder, and the window has no close for it.",
			);
		if (workspace.orchestrator === true)
			throw new Error(ORCHESTRATOR_CANNOT_CLOSE);
		const caller = this.caller;
		if (caller !== undefined && caller.paneless !== true) {
			const own =
				caller.workspaceId ??
				this.ports.workspaces().find((each) => each.scratch)?.id;
			if (own === workspace.id)
				throw new Error(
					`you run in ${workspace.name} (${workspace.id}): closing it would stop you${caller.agentId === undefined ? " (this terminal)" : ""}. Ask the person, or an agent in another workspace, to close it.`,
				);
		}
		const closed = await this.ports.closeWorkspace(workspace.id, {
			worktree: command.worktree,
			agents: command.agents,
			terminals: command.terminals,
			discardUnsaved: command.discardUnsaved,
		});
		if (closed.kind === "questions")
			throw new Error(
				[
					`${workspace.name} (${workspace.id}) was not closed: the window would ask ${closed.questions.length === 1 ? "this" : "these"}, so pass the answer${closed.questions.length === 1 ? "" : "s"}:`,
					...closed.questions.map(
						(question) =>
							`  ${question.flag}${question.values.length === 0 ? "" : ` ${question.values.join("|")}`}  - ${question.why}`,
					),
				].join("\n"),
			);
		const after = this.ports.workspaces();
		const next = after.find((each) => each.selected);
		const agents = workspace.agents.map((agent) => agent.id);
		const facts = [
			agents.length === 0
				? undefined
				: `stopped ${String(agents.length)} agent${agents.length === 1 ? "" : "s"} (${workspace.agents.map((agent) => agent.name).join(", ")})`,
			closed.busyTerminalProcesses === 0
				? undefined
				: `ended ${String(closed.busyTerminalProcesses)} running terminal process${closed.busyTerminalProcesses === 1 ? "" : "es"}`,
			closed.discarded.length === 0
				? undefined
				: `discarded unsaved changes in ${closed.discarded.join(", ")}`,
			closed.worktree === "removed"
				? `removed the worktree ${workspace.root}`
				: closed.worktree === "kept"
					? `kept the worktree ${workspace.root} on disk`
					: undefined,
		].filter((fact) => fact !== undefined);
		const selection = workspace.selected
			? ` It was selected, so the window selected the next row, as when a person closes it: ${next === undefined ? "none" : `${next.scratch ? "Scratch" : next.name} (${next.id})`}.`
			: "";
		return {
			message: `Closed ${workspace.name} (${workspace.id})${facts.length === 0 ? "" : `: ${facts.join("; ")}`}.${selection}`,
			data: {
				workspaceId: workspace.id,
				closed: true,
				worktree: closed.worktree,
				stoppedAgents: agents,
				busyTerminalProcesses: closed.busyTerminalProcesses,
				discarded: closed.discarded,
				wasSelected: workspace.selected,
				selected: workspace.selected && next !== undefined ? next.id : null,
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
				row.managed ? "managed" : undefined,
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
				...rows.map((row) => `${row.id}  ${row.label}  — ${row.summary}`),
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
		if (command.op === "set") checkLinkMeta(command.key, command.value);
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

	/** `agent manage` / `agent unmanage`. Never the orchestrator itself. */
	private async manage(name: string, managed: boolean): Promise<TellAnswer> {
		const agent = this.agent(name);
		if (
			managed &&
			agent.id === this.ports.orchestrator.board().orchestratorAgentId
		)
			throw new Error(
				"the orchestrator is never under its own management: it manages the others.",
			);
		await this.ports.setAgentManaged(agent.id, managed);
		return {
			message: managed
				? `${agent.name} (${agent.id}) is under the orchestrator's management.`
				: `${agent.name} (${agent.id}) is no longer under the orchestrator's management.`,
			data: { agentId: agent.id, managed },
		};
	}

	/**
	 * `agent keep A --note TEXT`: an unsettled managed agent left as it is,
	 * for the reason given, until its facts change; `--clear` ends it.
	 */
	private keep(name: string, note: string | undefined): TellAnswer {
		const agent = this.agent(name);
		if (note === undefined) {
			const was = this.ports.orchestrator.unkeep(agent.id);
			return {
				message: was
					? `${agent.name} (${agent.id}) is no longer kept: it is said again while it needs action.`
					: `${agent.name} (${agent.id}) was not kept.`,
				data: { agentId: agent.id, kept: null },
			};
		}
		const kept = this.ports.orchestrator.keep(agent.id, note);
		return {
			message: `${agent.name} (${agent.id}) is kept as it is (${note}): not said again until its facts change.`,
			data: {
				agentId: agent.id,
				kept: { note: kept.note, at: new Date(kept.at).toISOString() },
			},
		};
	}

	/** `--managed|--unmanaged`, which must be given; else a line in `missing`. */
	private requiredManaged(
		managed: boolean | undefined,
		missing: string[],
	): void {
		if (managed === undefined)
			missing.push(
				"--managed or --unmanaged is required: --managed puts the agent under the orchestrator's management (it is held to the invariant and its state is reported), --unmanaged leaves it the person's",
			);
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
		for (const pair of command.meta ?? []) checkLinkMeta(pair.key, pair.value);
		const missing: string[] = [];
		if (command.workspace === undefined)
			missing.push(
				`--workspace is required: ${this.workspaceChoices()} (see devhub --tell workspaces)`,
			);
		const profile = this.requiredProfile(command.profile, missing);
		this.requiredMode(profile, command.presentation, missing);
		this.requiredManaged(command.managed, missing);
		refuseMissing(missing);
		const workspace = this.workspace(command.workspace!);
		const agentId = await this.ports.createAgent(
			workspace.id,
			profile!.id,
			command.presentation,
		);
		if (command.name !== undefined)
			await this.ports.renameAgent(agentId, command.name);
		if (command.managed === true)
			await this.ports.setAgentManaged(agentId, true);
		await this.tag(agentId, command.meta);
		if (command.prompt !== undefined)
			this.ports.queueText(agentId, command.prompt);
		return {
			message: `Agent ${agentId} (${profile!.id}, ${command.presentation!.toUpperCase()}) is starting in ${workspace.root}${command.prompt === undefined ? "" : "; it is told the prompt once it is ready"}.`,
			data: {
				agentId,
				workspaceId: workspace.id,
				profile: profile!.id,
				managed: command.managed === true,
			},
		};
	}

	private async assignIssue(
		command: Extract<TellCommand, { verb: "issue-assign" }>,
	): Promise<TellAnswer> {
		// As `agent new`: every choice the window would make from settings or
		// from the first row is an argument, all checked before anything runs.
		for (const pair of command.meta ?? []) checkLinkMeta(pair.key, pair.value);
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
				command.meta === undefined ? undefined : "--meta",
				command.prompt === undefined ? undefined : "--prompt",
				command.name === undefined ? undefined : "--name",
				command.managed === undefined ? undefined : "--managed/--unmanaged",
			].filter((flag) => flag !== undefined);
			if (extra.length > 0)
				missing.push(
					`${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} about the agent, and --editor-only starts none`,
				);
		} else {
			profile = this.requiredProfile(command.profile, missing);
			this.requiredMode(profile, command.presentation, missing);
			this.requiredManaged(command.managed, missing);
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
		}
		if (command.name !== undefined && command.name.trim().length === 0)
			missing.push("--name needs a name: leave it out for DevHub's own label");
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
			...(command.name === undefined ? {} : { name: command.name.trim() }),
			offline: command.offline === true,
		});
		if (assigned.agentId !== undefined && command.managed === true)
			await this.ports.setAgentManaged(assigned.agentId, true);
		if (assigned.agentId !== undefined)
			await this.tag(assigned.agentId, command.meta);
		if (command.prompt !== undefined && assigned.agentId !== undefined)
			this.ports.queueText(assigned.agentId, command.prompt);
		const workspace = this.ports
			.workspaces()
			.find((each) => each.id === assigned.workspaceId);
		// Said, because it is the one thing about the branch that may be old.
		const stale =
			command.offline === true && assigned.origin === "on-disk"
				? " origin was not fetched: the branch was found and started from the copy on this machine."
				: "";
		return {
			message:
				(assigned.agentId === undefined
					? `Opened ${workspace?.root ?? "the workspace"} for ${command.url}.`
					: `Agent ${assigned.agentId}${command.name === undefined ? "" : ` (${command.name.trim()})`} is taking ${command.url} in ${workspace?.root ?? "its workspace"}.`) +
				stale,
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
		full = false,
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
		const views = shown.map((entry) => ({
			entry,
			view: entryView(entry, full, agent.id),
		}));
		const lines = views
			.map(({ view }) => view?.text)
			.filter((line) => line !== undefined);
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
				entries: views.map(({ entry, view }) => ({
					id: entry.id,
					kind: entry.kind,
					text: view?.json,
					truncated: view?.truncated ?? false,
					length: view?.length ?? 0,
				})),
			},
		};
	}

	/**
	 * `agent read <a> --entry <id>`: one entry, in full. What the caller has
	 * read (`TellMemory`) is left as it was: this is a look back, and moves
	 * no cursor.
	 */
	private async readEntry(name: string, id: string): Promise<TellAnswer> {
		const agent = this.agent(name);
		const conversation = await this.guiConversation(agent);
		const entry = conversation.entries().find((one) => one.id === id);
		if (entry === undefined)
			throw new Error(
				`${agent.name} has no entry ${JSON.stringify(id)} (a rewind or a compaction may have taken it). Run 'devhub --tell agent read ${agent.id}'.`,
			);
		const view = entryView(entry, true, agent.id);
		return {
			message: view?.text ?? `(entry ${entry.id} has no text)`,
			data: {
				agentId: agent.id,
				entry: {
					id: entry.id,
					kind: entry.kind,
					text: view?.json,
					truncated: false,
					length: view?.length ?? 0,
				},
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
		const note = answeredBy(caller, this.ports.workspaces());
		const answer =
			command.questions === undefined
				? questionAnswer(
						request.subject.questions,
						command.options,
						command.text,
						note,
					)
				: questionAnswerByPart(
						request.subject.questions,
						command.questions,
						note,
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
		// The orchestrator waits on its board too, so it may wait with no
		// other agent to wait on.
		if (targets.length === 0 && !(gui && this.callerIsOrchestrator()))
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
			// The orchestrator's own news: an answer it has not read. Until
			// 'idle' does not ask
			// about questions, and these are not questions, so every until
			// but 'waiting' takes them.
			const board =
				command.until === "waiting" ? { answered: [] } : this.boardNews();
			const reached =
				ready.length > 0 || gone.length > 0 || board.answered.length > 0;
			if (reached || this.clock.now() >= deadline) {
				const lines = [
					...ready.map((one) => newsLine(one)),
					...gone.map((one) => `${one.name} (${one.agentId}) is gone.`),
					...board.answered.map(
						(one) =>
							`Escalation #${String(one.id)} 「${one.title}」 was answered by the person: read it with 'devhub --tell escalation show ${String(one.id)}'.`,
					),
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
						answered: board.answered,
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
			managed: agent.managed,
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
			invariant: invariantOf(this.ports.orchestrator.standing(agent.id)),
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
	 * The agent picker's earlier sessions where `where` says: every resumable
	 * profile's (or `profileId`'s), newest first, one row per session of a
	 * CLI. A profile whose listing failed is said, as the picker says it.
	 */
	private async pastSessions(
		where: TellWorkspace | SessionsWhere,
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
		const place: SessionsWhere =
			"kind" in where ? where : { kind: "workspace", workspace: where };
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
				place.kind === "workspace"
					? this.ports.pastSessions(place.workspace.id, profile.id)
					: this.ports.pastSessionsIn(
							place.root,
							place.machine,
							profile.id,
							place.kind === "all" ? "everywhere" : "here",
						),
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

	/** The machine a `--folder` (or `--all`) is on: the asking `devhub`'s. */
	private callerMachine(): string {
		return this.caller?.machine ?? "local";
	}

	/** The open workspace whose folder is `folder` on `machine`, if one is. */
	private openAt(folder: string, machine: string): TellWorkspace | undefined {
		const root = stripSlashes(folder);
		return this.ports
			.workspaces()
			.find(
				(workspace) =>
					workspace.machine === machine &&
					stripSlashes(workspace.root) === root,
			);
	}

	/**
	 * Where `sessions` / `agent resume` look: `--workspace W`, `--folder PATH`
	 * (an open workspace's when one has it open), `--all`, or the caller's
	 * own workspace — never a setting.
	 */
	private async sessionsWhere(asked: {
		readonly workspace?: string;
		readonly folder?: string;
		readonly all?: true;
	}): Promise<SessionsWhere> {
		if (asked.all === true) {
			const machine = this.callerMachine();
			const all = this.ports
				.workspaces()
				.filter((workspace) => workspace.machine === machine);
			// The listing is read from somewhere: the caller's own workspace
			// (whose repository's worktrees it then places), else Scratch.
			const base =
				all.find(
					(workspace) =>
						this.caller?.paneless !== true &&
						workspace.id === (this.caller?.workspaceId ?? "") &&
						!workspace.scratch,
				) ??
				all.find((workspace) => workspace.scratch) ??
				all[0];
			if (base === undefined)
				throw new Error(
					`no workspace is open on ${machine}, the machine devhub runs on, to list its sessions from: open one, or give --folder <path>.`,
				);
			return { kind: "all", root: base.root, machine, base };
		}
		if (asked.folder !== undefined) {
			const machine = this.callerMachine();
			const root = stripSlashes(asked.folder);
			const open = this.openAt(root, machine);
			if (open !== undefined) return { kind: "workspace", workspace: open };
			const kind = await this.ports.pathKind(root, machine);
			if (kind !== "directory")
				throw new Error(
					kind === "absent"
						? `${root} does not exist on ${machine}: there is no folder to list or resume sessions in.`
						: `${root} is a file, not a folder.`,
				);
			return { kind: "folder", root, machine };
		}
		return {
			kind: "workspace",
			workspace: this.workspace(this.workspaceOrCallers(asked.workspace)),
		};
	}

	private async sessions(
		command: Extract<TellCommand, { verb: "sessions" }>,
	): Promise<TellAnswer> {
		const where = await this.sessionsWhere(command);
		const listed = await this.pastSessions(where, command.profile);
		const failures = listed.failures;
		const meta = command.meta ?? [];
		const sessions = listed.sessions.filter(({ session }) =>
			meta.every((pair) => session.meta?.[pair.key] === pair.value),
		);
		const shown = sessions.slice(0, command.limit);
		const now = this.clock.now();
		const listedRoot =
			where.kind === "workspace"
				? where.workspace.root
				: where.kind === "folder"
					? where.root
					: undefined;
		const machine =
			where.kind === "workspace" ? where.workspace.machine : where.machine;
		const rows = shown.map(({ profile, session }) => {
			const folder = sessionFolder(where, session);
			const open =
				folder === undefined ? undefined : this.openAt(folder, machine);
			return { profile, session, folder, open };
		});
		const named =
			where.kind === "all"
				? `any folder on ${machine}`
				: `${listedRoot ?? ""}${where.kind === "folder" ? " (not open)" : ""}`;
		return {
			message: [
				...(shown.length === 0
					? [
							meta.length > 0
								? `No earlier session in ${named} carries ${meta.map((pair) => `${pair.key}=${pair.value}`).join(" ")}.`
								: `No earlier sessions in ${named}.`,
						]
					: rows.map((row) =>
							sessionLine(row.profile, row.session, now, {
								listedRoot,
								folder: row.folder,
								open: row.open?.id,
							}),
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
				scope: where.kind,
				workspaceId: where.kind === "workspace" ? where.workspace.id : null,
				folder: listedRoot ?? null,
				machine,
				sessions: rows.map(({ profile, session, folder, open }) => ({
					id: session.id,
					profile,
					title: session.title,
					agentName: session.agentName ?? null,
					meta: session.meta ?? {},
					managed: session.managed === true,
					liveAgentId: session.liveAgentId ?? null,
					updatedAt: iso(session.updatedAt),
					cwd: session.cwd ?? null,
					folder: folder ?? null,
					openWorkspaceId: open?.id ?? null,
					branch: session.worktree?.branch ?? session.branch ?? null,
					worktree: session.worktree ?? null,
					resumable: folder !== undefined,
				})),
				more: sessions.length - shown.length,
				failures,
			},
		};
	}

	private async resume(
		command: Extract<TellCommand, { verb: "agent-resume" }>,
	): Promise<TellAnswer> {
		const { where, profile, session } = await this.sessionToResume(command);
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
		const agentId = await this.resumeWhere(where, profile, session);
		// The name and the pairs it had go on with it, as the window gives
		// them back; --name is the caller's own.
		const name = command.name ?? session.agentName;
		if (name !== undefined) await this.ports.renameAgent(agentId, name);
		const meta = session.meta ?? {};
		// So does being under the orchestrator's management.
		if (session.managed === true)
			await this.ports.setAgentManaged(agentId, true);
		await this.tag(
			agentId,
			Object.entries(meta).map(([key, value]) => ({ key, value })),
		);
		const placed = this.ports
			.workspaces()
			.find((each) => each.agents.some((one) => one.id === agentId));
		const root =
			placed?.root ??
			session.worktree?.root ??
			sessionFolder(where, session) ??
			"";
		return {
			message: `Agent ${agentId} (${profile}) is going on with ${JSON.stringify(sessionTitle(session))} (${session.id}) in ${root}${Object.keys(meta).length === 0 ? "" : `, with ${metaWords(meta) ?? ""}`}.`,
			data: {
				agentId,
				session: session.id,
				profile,
				workspaceId: placed?.id ?? null,
				root,
				name: name ?? null,
				meta,
				managed: session.managed === true,
			},
		};
	}

	/**
	 * The session `agent resume` names, and where it was listed: where
	 * `--workspace` / `--folder` say, or the caller's workspace and then
	 * every folder's sessions (`sessions --all`).
	 */
	private async sessionToResume(
		command: Extract<TellCommand, { verb: "agent-resume" }>,
	): Promise<{
		readonly where: SessionsWhere;
		readonly profile: string;
		readonly session: TellPastSession;
	}> {
		const explicit =
			command.workspace !== undefined ||
			command.folder !== undefined ||
			(this.caller !== undefined && this.caller.paneless !== true);
		if (explicit) {
			const where = await this.sessionsWhere(command);
			const { sessions } = await this.pastSessions(where, command.profile);
			const found = matchSession(sessions, command.session);
			if (found !== undefined) return { where, ...found };
			if (command.workspace !== undefined || command.folder !== undefined)
				throw new Error(
					`there is no earlier session ${JSON.stringify(command.session)} in ${where.kind === "workspace" ? where.workspace.root : where.kind === "folder" ? where.root : "any folder"}. Run 'devhub --tell sessions ${where.kind === "workspace" ? `--workspace ${where.workspace.id}` : `--folder ${where.kind === "folder" ? where.root : "<path>"}`}'.`,
				);
		}
		const where = await this.sessionsWhere({ all: true });
		const { sessions } = await this.pastSessions(where, command.profile);
		const found = matchSession(sessions, command.session);
		if (found !== undefined) return { where, ...found };
		throw new Error(
			`there is no earlier session ${JSON.stringify(command.session)} here or among the newest of every folder on ${this.callerMachine()}. Run 'devhub --tell sessions --all', or give --folder <path> for an older one.`,
		);
	}

	/**
	 * Start the new Agent on `session` where it belongs: the listed
	 * workspace, its worktree (opened, or checked out again), or its own
	 * folder — opened unfocused when no workspace has it open, and its
	 * worktree checked out again when it was one that is gone.
	 */
	private async resumeWhere(
		where: SessionsWhere,
		profile: string,
		session: TellPastSession,
	): Promise<string> {
		const workspace =
			where.kind === "workspace"
				? where.workspace
				: where.kind === "all"
					? where.base
					: undefined;
		if (session.worktree !== undefined || session.resumableHere) {
			if (
				workspace !== undefined &&
				(where.kind !== "all" || session.worktree !== undefined)
			)
				return this.ports.resumeSession(workspace.id, profile, session);
			if (where.kind === "folder")
				return this.ports.resumeSessionIn(
					where.root,
					where.machine,
					profile,
					session,
				);
		}
		const machine =
			where.kind === "workspace" ? where.workspace.machine : where.machine;
		const folder = sessionFolder(where, session);
		if (folder === undefined)
			throw new Error(
				`session ${session.id} does not say which folder it ran in: give --folder <path> to resume it there.`,
			);
		const here = { ...session, resumableHere: true, worktree: undefined };
		const open = this.openAt(folder, machine);
		if (open !== undefined)
			return this.ports.resumeSession(open.id, profile, here);
		const kind = await this.ports.pathKind(folder, machine);
		if (kind === "directory")
			return this.ports.resumeSessionIn(folder, machine, profile, here);
		if (kind === "file")
			throw new Error(
				`session ${session.id} ran in ${folder}, which is now a file: there is no folder to resume it in.`,
			);
		// Gone: a DevHub worktree of a clone is made again, as the picker does.
		const clones = await this.clonesFor(folder, machine);
		if (clones.length === 0)
			throw new Error(
				`session ${session.id} ran in ${folder}, which no longer exists on ${machine}, and it is not a worktree of a clone DevHub can find (an open workspace's repository, or a folder beside it named like ${folder.slice(0, folder.lastIndexOf("_") + 1) || "<clone>_"}): nothing can check it out again. Give --folder <clone> if it was a worktree of one.`,
			);
		if (clones.length > 1)
			throw new Error(
				`--folder is required: session ${session.id} ran in ${folder}, which no longer exists, and more than one clone could check it out again:\n${clones.map((clone) => `  --folder ${clone.root}`).join("\n")}`,
			);
		const [clone] = clones;
		const branch = session.branch;
		if (branch === undefined)
			throw new Error(
				`session ${session.id} ran in ${clone!.worktree}, which no longer exists, and it did not record which branch it was on, so there is no worktree to make again for it.`,
			);
		return this.ports.resumeSessionIn(clone!.root, machine, profile, {
			...session,
			resumableHere: false,
			worktree: { root: clone!.worktree, branch, present: false },
		});
	}

	/**
	 * The clones `folder` would be one of DevHub's worktrees of
	 * (`worktreeSiblingPrefix`: `<clone>_<name>`), with the worktree's own
	 * folder: open workspaces' repositories, and folders beside it that are
	 * there and named like one.
	 */
	private async clonesFor(
		folder: string,
		machine: string,
	): Promise<readonly { readonly root: string; readonly worktree: string }[]> {
		const found = new Map<string, string>();
		const worktreeOf = (clone: string): string | undefined => {
			const prefix = `${stripSlashes(clone)}_`;
			if (!folder.startsWith(prefix)) return undefined;
			const segment = folder.slice(prefix.length).split("/")[0] ?? "";
			return segment.length === 0 ? undefined : `${prefix}${segment}`;
		};
		for (const workspace of this.ports.workspaces()) {
			if (workspace.scratch || workspace.machine !== machine) continue;
			const clone = workspace.worktreeOf ?? workspace.root;
			const worktree = worktreeOf(clone);
			if (worktree !== undefined) found.set(stripSlashes(clone), worktree);
		}
		const parts = folder.split("/");
		for (let at = 1; at < parts.length; at += 1) {
			const part = parts[at]!;
			for (
				let cut = part.indexOf("_");
				cut > 0;
				cut = part.indexOf("_", cut + 1)
			) {
				const clone = [...parts.slice(0, at), part.slice(0, cut)].join("/");
				if (found.has(clone)) continue;
				const worktree = worktreeOf(clone);
				if (worktree === undefined) continue;
				if ((await this.ports.pathKind(clone, machine)) === "directory")
					found.set(clone, worktree);
			}
		}
		return [...found].map(([root, worktree]) => ({ root, worktree }));
	}

	/** `session meta`: a session's pairs, kept past its agent; set or unset one. */
	private async sessionMeta(
		command: Extract<TellCommand, { verb: "session-meta" }>,
	): Promise<TellAnswer> {
		const workspace = this.workspace(
			this.workspaceOrCallers(command.workspace),
		);
		const { profile, session } = await this.findSession(
			workspace,
			command.session,
			command.profile,
		);
		if (command.op === "set") checkLinkMeta(command.key, command.value);
		if (command.op !== "list" && session.liveAgentId !== undefined)
			throw new Error(
				`session ${session.id} is agent ${session.liveAgentId}'s, running now: use 'agent meta ${session.liveAgentId}'.`,
			);
		const meta =
			command.op === "list" || command.key === undefined
				? (session.meta ?? {})
				: await this.ports.setSessionMeta(
						profile,
						session.id,
						command.key,
						command.op === "set" ? command.value : undefined,
					);
		const entries = Object.entries(meta);
		return {
			message:
				entries.length === 0
					? `Session ${session.id} has no metadata.`
					: entries.map(([key, value]) => `${key}=${value}`).join("\n"),
			data: {
				session: session.id,
				profile,
				liveAgentId: session.liveAgentId ?? null,
				meta,
			},
		};
	}

	/** The one earlier session `id` (or a unique prefix of one) names in `workspace`. */
	private async findSession(
		workspace: TellWorkspace,
		id: string,
		profileId: string | undefined,
	): Promise<{ readonly profile: string; readonly session: TellPastSession }> {
		const { sessions } = await this.pastSessions(workspace, profileId);
		const found = matchSession(sessions, id);
		if (found === undefined)
			throw new Error(
				`there is no earlier session ${JSON.stringify(id)} in ${workspace.root}. Run 'devhub --tell sessions --workspace ${workspace.id}'.`,
			);
		return found;
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

	// --- devhub: links (`model/devhubLink.ts`) ---------------------------------

	/**
	 * An escalation's `--link`s, each `devhub:` one checked against what is
	 * open and written canonically (an http(s) one is the model's to check),
	 * and the `devhub:` links its Markdown body makes, checked the same way.
	 */
	private async checkedLinks(
		links: readonly string[],
		markdown: string,
	): Promise<readonly string[]> {
		const checked: string[] = [];
		for (const link of links)
			checked.push(isDevhubLink(link) ? await this.checkedLink(link) : link);
		for (const link of devhubLinksIn(markdown)) await this.checkedLink(link);
		return checked;
	}

	/** A `devhub:` link to something open, canonically; refused otherwise. */
	private async checkedLink(text: string): Promise<string> {
		const parsed = parseDevhubLink(text);
		if (!parsed.ok)
			throw new Error(
				`${JSON.stringify(text)} is not a valid devhub: link: ${parsed.problem} A devhub: link is one of:\n${DEVHUB_LINK_FORMS.map((form) => `  ${form}`).join("\n")}\n'devhub --tell link ...' makes one.`,
			);
		try {
			return formatDevhubLink(await this.linkTarget(parsed.link));
		} catch (error: unknown) {
			throw new Error(
				`${text} leads nowhere: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** The link, naming what is open by its id; refused when nothing is. */
	private async linkTarget(link: DevhubLink): Promise<DevhubLink> {
		switch (link.kind) {
			case "agent":
				return { kind: "agent", agent: this.agent(link.agent).id };
			case "workspace":
				return {
					kind: "workspace",
					workspace: this.workspace(link.workspace).id,
				};
			case "escalation":
				return { kind: "escalation", id: this.escalation(link.id).id };
			case "orchestrator":
				return link;
			case "session": {
				const agentId = await this.ports.sessionAgent?.(link.session);
				if (agentId === undefined)
					throw new Error(
						`no agent is running the session ${JSON.stringify(link.session)}. A devhub:session link shows the agent that runs it; 'devhub --tell agents' lists them.`,
					);
				return link;
			}
			case "file": {
				const all = this.ports.workspaces();
				const machine = this.caller?.machine;
				const here =
					machine === undefined
						? all
						: all.filter((workspace) => workspace.machine === machine);
				const owner = owningWorkspace(
					link.path,
					(here.length === 0 ? all : here).map((workspace) => ({
						...workspace,
						label: workspace.name,
						local: workspace.machine === "local",
						agents: [],
					})),
				);
				if (owner === undefined)
					throw new Error(
						`no open workspace holds ${link.path}. A devhub:file link opens in the workspace whose folder holds it: ${all.map((workspace) => workspace.root).join(", ") || "none is open"}.`,
					);
				const kind = await this.ports.fileKind?.(owner.machine, link.path);
				if (kind === "absent")
					throw new Error(`there is no file ${link.path}.`);
				if (kind === "directory")
					throw new Error(
						`${link.path} is a folder; a devhub:file link names a file (a folder's workspace is devhub:workspace/<w>).`,
					);
				return link;
			}
		}
	}

	private async makeLink(
		command: Extract<TellCommand, { verb: "link" }>,
	): Promise<TellAnswer> {
		const asked: DevhubLink = (() => {
			const target = command.target ?? "";
			switch (command.kind) {
				case "agent":
					return { kind: "agent", agent: target };
				case "workspace":
					return { kind: "workspace", workspace: target };
				case "escalation":
					return { kind: "escalation", id: Number(target) };
				case "orchestrator":
					return { kind: "orchestrator" };
				case "session":
					return { kind: "session", session: target };
				case "file":
					return {
						kind: "file",
						path: target,
						...(command.line === undefined ? {} : { line: command.line }),
						...(command.column === undefined ? {} : { column: command.column }),
					};
			}
		})();
		const link = formatDevhubLink(await this.linkTarget(asked));
		return { message: link, data: { link } };
	}

	private async focus(target: string): Promise<TellAnswer> {
		if (target === "orchestrator") {
			await this.ports.orchestrator.focus();
			return {
				message: "Showing the Orchestrator screen.",
				data: { orchestrator: true },
			};
		}
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
 * The `devhub:` links a Markdown body makes: `[text](devhub:…)`,
 * `[text](<devhub:…>)` and `<devhub:…>`.
 */
export function devhubLinksIn(markdown: string): readonly string[] {
	const found: string[] = [];
	for (const match of markdown.matchAll(
		/\]\(\s*<?(devhub:[^\s)>]+)>?|<(devhub:[^\s>]+)>/giu,
	))
		found.push((match[1] ?? match[2])!);
	return found;
}

function agentsText(one: EscalationWire): string {
	return one.agents.length === 0
		? ""
		: `  (${one.agents.map((agent) => agent.name ?? agent.agentId).join(", ")})`;
}

/** A session's name in a line: its title, or the agent's name it ran under. */
/** Where `sessions` and `agent resume` look (`TellService.sessionsWhere`). */
type SessionsWhere =
	| { readonly kind: "workspace"; readonly workspace: TellWorkspace }
	/** A folder no workspace has open. */
	| { readonly kind: "folder"; readonly root: string; readonly machine: string }
	/** Every folder's, read from `base` (whose repository's worktrees are placed). */
	| {
			readonly kind: "all";
			readonly root: string;
			readonly machine: string;
			readonly base: TellWorkspace;
	  };

function stripSlashes(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

/**
 * The folder a listed session is gone on with in: its worktree's, the
 * listed folder's when its CLI resumes it there, else the one it ran in.
 */
function sessionFolder(
	where: SessionsWhere,
	session: TellPastSession,
): string | undefined {
	if (session.worktree !== undefined) return session.worktree.root;
	if (session.resumableHere)
		return where.kind === "workspace" ? where.workspace.root : where.root;
	return session.cwd === undefined ? undefined : stripSlashes(session.cwd);
}

/** The one session `id` (or a unique prefix of one) names; undefined for none. */
function matchSession(
	sessions: readonly {
		readonly profile: string;
		readonly session: TellPastSession;
	}[],
	id: string,
): { readonly profile: string; readonly session: TellPastSession } | undefined {
	const exact = sessions.filter(({ session }) => session.id === id);
	const matches =
		exact.length > 0
			? exact
			: sessions.filter(
					({ session }) => id.length >= 4 && session.id.startsWith(id),
				);
	if (new Set(matches.map(({ session }) => session.id)).size > 1)
		throw new Error(
			`${JSON.stringify(id)} is the start of more than one session's id: ${matches.map(({ session }) => session.id).join(", ")}.`,
		);
	return matches[0];
}

function sessionTitle(session: TellPastSession): string {
	return session.title.length > 0 ? session.title : (session.agentName ?? "");
}

function sessionLine(
	profile: string,
	session: TellPastSession,
	now: number,
	place: {
		/** The folder listed (absent for --all): rows there say nothing more. */
		readonly listedRoot: string | undefined;
		readonly folder: string | undefined;
		/** The open workspace that has `folder`, if one does. */
		readonly open: string | undefined;
	},
): string {
	const worktree = session.worktree;
	const elsewhere =
		place.folder !== undefined && place.folder !== place.listedRoot;
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
		place.folder === undefined
			? "folder unknown: resume with --folder"
			: elsewhere && worktree === undefined
				? `in ${place.folder}`
				: undefined,
		!elsewhere || worktree?.present === false
			? undefined
			: place.open === undefined
				? "not open"
				: `open as ${place.open}`,
		session.liveAgentId === undefined
			? undefined
			: `running in agent ${session.liveAgentId}`,
		session.managed === true ? "managed" : undefined,
		metaWords(session.meta ?? {}),
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

/** A Workspace as `workspaces --json` and `workspace status --json` give it: one schema. */
function workspaceRow({ agents, review, ...workspace }: TellWorkspace) {
	return {
		...workspace,
		agents: agents.map((agent) => agent.id),
		/** `issue` above is the URL the branch's number makes; this is GitHub's answer. */
		github: review,
	};
}

function conversationsText(conversations: {
	readonly unresolved: number;
	readonly uncounted: number;
}): string {
	const { unresolved, uncounted } = conversations;
	const count = uncounted > 0 ? `${String(unresolved)}+` : String(unresolved);
	return `${count} unresolved conversation${unresolved === 1 && uncounted === 0 ? "" : "s"}`;
}

/** The row's GitHub facts, short, for the `workspaces` list. */
function reviewFacts(
	workspace: TellWorkspace,
): readonly (string | undefined)[] {
	const { review } = workspace;
	const pr = review.pullRequest;
	return [
		review.issue !== null
			? `Issue #${String(review.issue.number)} ${review.issue.state}`
			: review.pendingIssue !== null
				? `Issue #${String(review.pendingIssue)} (asking GitHub)`
				: workspace.issue,
		pr === null
			? undefined
			: `PR #${String(pr.number)} ${pr.draft ? "draft" : pr.state}`,
		review.conversations === null || review.conversations.unresolved === 0
			? undefined
			: conversationsText(review.conversations),
		review.checks === null
			? undefined
			: review.checks.state === "passing"
				? "CI passing"
				: `CI ${review.checks.state} (${String(review.checks.state === "failing" ? review.checks.failing : review.checks.pending)} of ${String(review.checks.total)})`,
	];
}

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
		...(state.managed
			? ["managed   yes: under the orchestrator's management"]
			: []),
		...(state.invariant === null
			? []
			: [
					...(state.invariant.needsAction === null
						? []
						: [`needs     action: ${state.invariant.needsAction}`]),
					...(state.invariant.waiting === null
						? []
						: [
								`waiting   in esc=${String(state.invariant.waiting.escalationId)}: ${state.invariant.waiting.trigger}`,
							]),
					...(state.invariant.kept === null
						? []
						: [
								`kept      ${state.invariant.kept.note} (since ${state.invariant.kept.at})`,
							]),
				]),
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

/**
 * One entry as `agent read` shows it. `text` is its line: clipped, unless
 * `full`, and then saying so and how to read it whole (`--entry`); `json`
 * is the same without that note. `length` is the whole text's, in
 * characters, and `truncated` whether `text` is less than it.
 */
export function entryView(
	entry: TranscriptEntry,
	full: boolean,
	agentId: string,
):
	| {
			readonly text: string;
			readonly json: string;
			readonly truncated: boolean;
			readonly length: number;
	  }
	| undefined {
	const whole = entryText(entry, true);
	if (whole === undefined) return undefined;
	const length = [...whole].length;
	if (full) return { text: whole, json: whole, truncated: false, length };
	const short = entryText(entry, false) ?? "";
	if (short === whole)
		return { text: whole, json: whole, truncated: false, length };
	return {
		text: `${short} (truncated, ${length.toLocaleString("en-US")} chars; devhub --tell agent read ${agentId} --entry ${entry.id})`,
		json: short,
		truncated: true,
		length,
	};
}

/** One transcript entry, as a line or two of text. */
export function entryLine(entry: TranscriptEntry): string | undefined {
	return entryText(entry, false);
}

/** A tool's output as text: what it printed, said once each. */
function toolOutputText(output: ToolOutput | undefined): string {
	if (output === undefined) return "";
	return output
		.map((part) => {
			switch (part.kind) {
				case "text":
					return part.text;
				case "image":
					return "[image]";
				case "reference":
					return `[tool ${part.name}]`;
				case "command":
					return [
						part.output,
						part.stderr === undefined || part.stderr.length === 0
							? undefined
							: `[stderr]\n${part.stderr}`,
						part.interrupted
							? "[interrupted]"
							: part.exitCode === undefined
								? undefined
								: `[exit ${String(part.exitCode)}]`,
					]
						.filter((piece) => piece !== undefined)
						.join("\n");
				case "persisted":
					return `${part.preview}\n[${part.note}]`;
			}
		})
		.join("\n")
		.trim();
}

/** An entry's text: clipped, or (`whole`) all of it, a tool's output too. */
function entryText(entry: TranscriptEntry, whole: boolean): string | undefined {
	const cut = whole ? (text: string) => text.trim() : clip;
	switch (entry.kind) {
		case "user":
			return `> ${cut(entry.text)}`;
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
			return `$ ${entry.line ?? ""}${entry.output === undefined ? "" : `\n${cut(entry.output)}`}`;
		case "assistant": {
			const text = entry.blocks
				.filter((block) => block.kind === "text")
				.map((block) => block.markdown)
				.join("\n");
			return text.trim().length === 0 ? undefined : cut(text);
		}
		case "tool": {
			const line = `[${entry.tool}] ${cut(entry.title)} (${entry.status})`;
			const output = toolOutputText(entry.output);
			return whole && output.length > 0 ? `${line}\n${output}` : line;
		}
		case "notice":
			return `! ${cut(entry.text)}`;
		case "compaction":
			return "-- compacted --";
		case "turn-end":
			return `-- turn ${entry.outcome}${entry.detail === undefined ? "" : `: ${cut(entry.detail)}`} --`;
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
		/** 1-based: what `--q` takes, as does `id` and `header`. */
		readonly index: number;
		readonly id: string;
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
	const questions = subject.questions.map((question, index) => ({
		index: index + 1,
		id: question.id,
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
			`${request.id}  question${questions.length > 1 ? `s (${String(questions.length)}, answer every one)` : ""}`,
			...questions.flatMap((question) => [
				`  --q ${String(question.index)}  ${question.header}: ${question.text}  [${question.multiSelect ? "multiSelect: several --option" : "one answer"}${question.allowsOther ? ", or --text" : ""}]`,
				...question.options.map(
					(option) =>
						`    ${String(option.n)}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
				),
			]),
			`  answer: agent answer <a> ${request.id} ${questions
				.map(
					(question) =>
						`--q ${String(question.index)} ${question.allowsOther && question.options.length === 0 ? "--text <t>" : "--option <n>"}`,
				)
				.join(" ")}`,
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

/**
 * The answer to a request of one or more questions, each given by its own
 * `--q`: its options numbered within it, its own words where it takes them.
 * Every question has to be answered, once; anything else is refused before
 * anything is sent, naming the question.
 */
export function questionAnswerByPart(
	questions: readonly Question[],
	parts: readonly AnswerPart[],
	note: string,
): RequestAnswer {
	const name = (index: number) =>
		`question ${String(index + 1)} ("${questions[index]!.header}")`;
	const find = (given: string): number => {
		const byIndex = /^\d+$/u.test(given) ? Number(given) - 1 : -1;
		if (byIndex >= 0 && byIndex < questions.length) return byIndex;
		const byId = questions.findIndex((question) => question.id === given);
		if (byId >= 0) return byId;
		const byHeader = questions.findIndex(
			(question) => question.header.toLowerCase() === given.toLowerCase(),
		);
		if (byHeader >= 0) return byHeader;
		throw new Error(
			`--q ${given} is none of this request's questions: ${questions.map((_, index) => name(index)).join(", ")}.`,
		);
	};
	const answered = new Map<number, AnswerPart>();
	for (const part of parts) {
		const index = find(part.question);
		if (answered.has(index))
			throw new Error(`${name(index)} is answered twice.`);
		answered.set(index, part);
	}
	const missing = questions
		.map((_, index) => index)
		.filter((index) => !answered.has(index));
	if (missing.length > 0)
		throw new Error(
			`every question must be answered; ${missing.map(name).join(", ")} ${missing.length === 1 ? "has" : "have"} no --q. See 'agent requests'.`,
		);
	const values: Record<string, string | readonly string[]> = {};
	const notes: Record<string, string> = {};
	questions.forEach((question, index) => {
		const part = answered.get(index)!;
		const bad = part.options.find((n) => n > question.options.length);
		if (bad !== undefined)
			throw new Error(
				`${name(index)} has ${String(question.options.length)} options; there is no ${String(bad)}.`,
			);
		if (part.text !== undefined && !question.allowsOther)
			throw new Error(
				`${name(index)} takes one of its options, not words of its own.`,
			);
		const given = [
			...new Set(part.options.map((n) => question.options[n - 1]!.label)),
			...(part.text === undefined ? [] : [part.text]),
		];
		if (!question.multiSelect && given.length > 1)
			throw new Error(
				`${name(index)} takes one answer: one --option, or --text.`,
			);
		values[question.id] = question.multiSelect ? given : given[0]!;
		notes[question.id] = note;
	});
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

/** `orchestrator status`'s GitHub line: polling, suspended by the pause, or idle and why. */
function githubPollingLine(board: OrchestratorBoardWire): string {
	const {
		state,
		lastAt,
		nextAt,
		rateLimit,
		boards,
		assigned,
		problem,
		problemAt,
		reading,
	} = board.github;
	const why =
		state === "suspended"
			? " (events paused: GitHub is not polled)"
			: state === "idle"
				? board.orchestratorAgentId === undefined
					? " (no orchestrator)"
					: " (no [orchestrator.github] projects: the population is empty)"
				: "";
	return [
		`GitHub polling: ${state}${why}`,
		...(assigned !== undefined
			? [`${String(assigned)} open items assigned to me on the Projects`]
			: state === "idle"
				? []
				: [
						`the population is not known yet${reading === undefined ? "" : `: reading ${reading}`}`,
					]),
		...(boards === undefined || boards.length === 0
			? []
			: [`Projects ${boards.map((one) => one.ref).join(" ")}`]),
		...(lastAt === undefined ? [] : [`last ${new Date(lastAt).toISOString()}`]),
		...(nextAt === undefined ? [] : [`next ${new Date(nextAt).toISOString()}`]),
		...(rateLimit === undefined
			? []
			: [
					`rate limit ${String(rateLimit.remaining)}/${String(rateLimit.limit)} left`,
				]),
		...(problem === undefined
			? []
			: [
					`last error${problemAt === undefined ? "" : ` (since ${new Date(problemAt).toISOString()})`}: ${problem}`,
				]),
	].join(", ");
}

/** An item as `status --json` carries it: every field there, null when unknown. */
function itemJson(item: StatusItem): Record<string, unknown> {
	return {
		kind: item.kind,
		ref: item.ref,
		url: item.url ?? null,
		title: item.title ?? null,
		state: item.state,
		assigned: item.assigned,
		inPopulation: item.inPopulation,
		projects: item.projects,
		pullRequest:
			item.pull === undefined
				? null
				: {
						number: item.pull.number,
						url: item.pull.url ?? null,
						state: item.pull.state,
						review: item.pull.review,
						unresolved: item.pull.unresolved,
						checks: item.pull.checks,
					},
	};
}

/** `status --json`: one stable shape for an item and for an agent. */
function subjectJson(
	found: SubjectStatus,
	workspace: TellReview | null | undefined,
): Record<string, unknown> {
	const needsAction =
		found.needsAction === undefined
			? null
			: {
					clause: found.needsAction.clause,
					line: found.needsAction.line,
					since: iso(found.needsAction.since),
				};
	const agentJson = (
		agent: (typeof found & { subject: "agent" })["agent"],
	) => ({
		id: agent.id,
		name: agent.name,
		ws: agent.ws,
		workspaceId: agent.workspaceId,
		status: agent.status,
		managed: agent.managed,
		linked: agent.linked ?? null,
		needsAction: agent.needsAction ?? null,
		kept:
			agent.kept === undefined
				? null
				: { note: agent.kept.note, at: iso(agent.kept.at) },
	});
	const escalations = found.escalations.map((one) => ({
		id: one.id,
		title: one.title,
		state: one.state,
		trigger: one.trigger ?? null,
		dueAt: iso(one.dueAt),
	}));
	if (found.subject === "item")
		return {
			subject: "item",
			item: itemJson(found.item),
			needsAction,
			agents: found.agents.map(agentJson),
			escalations,
		};
	return {
		subject: "agent",
		agent: agentJson(found.agent),
		item: found.item === undefined ? null : itemJson(found.item),
		workspace: workspace ?? null,
		needsAction,
		waiting: found.waiting ?? null,
		escalations,
	};
}

function itemLines(item: StatusItem): string[] {
	const pull = item.pull;
	return [
		`${item.ref}${item.title === undefined ? "" : `「${item.title}」`}  ${item.state}, ${item.assigned ? "assigned to me" : "not assigned to me"}, ${item.inPopulation ? "in the population" : "outside the population"}${item.url === undefined ? "" : `  ${item.url}`}`,
		`  lanes      ${item.projects.length === 0 ? "-" : item.projects.map((one) => `${one.project} ${one.lane ?? "(none)"}`).join(", ")}`,
		`  pull req.  ${pull === undefined ? "none" : `#${String(pull.number)} ${pull.state}, review ${pull.review}, unresolved ${String(pull.unresolved)}, checks ${pull.checks}`}`,
	];
}

/** `status`, as text: the same facts as `--json`. */
function subjectText(
	found: SubjectStatus,
	workspace: TellReview | undefined,
	now: number,
): string {
	const needs =
		found.needsAction === undefined
			? "needs action: no"
			: `needs action: ${found.needsAction.clause} (for ${span(now - found.needsAction.since)})`;
	const agentLine = (agent: (typeof found & { subject: "agent" })["agent"]) =>
		`${agent.name} (${agent.id}) ws=${agent.ws} ${agent.status}${agent.managed ? ", managed" : ""}${agent.needsAction === undefined ? "" : `, needs action: ${agent.needsAction}`}${agent.kept === undefined ? "" : `, kept: ${agent.kept.note}`}`;
	const escalations =
		found.escalations.length === 0
			? ["escalations: none"]
			: [
					"escalations:",
					...found.escalations.map(
						(one) =>
							`  #${String(one.id)} ${one.title}  ${one.state}${one.trigger === undefined ? "" : `  waiting on: ${one.trigger}`}${one.dueAt === undefined ? "" : ` [${new Date(one.dueAt).toISOString()}]`}`,
					),
				];
	if (found.subject === "item")
		return [
			...itemLines(found.item),
			needs,
			found.agents.length === 0 ? "agents: none linked" : "agents:",
			...found.agents.map((agent) => `  ${agentLine(agent)}`),
			...escalations,
		].join("\n");
	const review = workspace;
	return [
		agentLine(found.agent),
		`linked to ${found.agent.linked ?? "no item"}`,
		...(found.item === undefined ? [] : itemLines(found.item)),
		...(review === undefined
			? []
			: [
					`workspace  issue ${review.issue === null ? "none" : `#${String(review.issue.number)} ${review.issue.state}`}, pull request ${review.pullRequest === null ? "none" : `#${String(review.pullRequest.number)} ${review.pullRequest.draft ? "draft" : review.pullRequest.state}, review ${review.pullRequest.review}`}, unresolved ${review.conversations === null ? "-" : String(review.conversations.unresolved)}, checks ${review.checks === null ? "none" : review.checks.state}`,
				]),
		needs,
		...(found.waiting === undefined
			? []
			: [
					`waiting in esc=${String(found.waiting.escalationId)}: ${found.waiting.trigger}`,
				]),
		...escalations,
	].join("\n");
}

/** `board`'s invariant part: every subject that needs action now, and why. */
function needsActionLines(board: OrchestratorBoardWire, now: number): string[] {
	const list = board.needsAction;
	return [
		`needs action (${String(list.length)}):`,
		...list.map(
			(one) =>
				`  ${one.line}  [${span(now - one.since)}${one.kept === undefined ? "" : `, kept: ${one.kept.note}`}]`,
		),
	];
}

/**
 * The item linkage (`issue=`), set by hand as `issue assign` writes it: the
 * URL of an Issue or a pull request, which is what the invariant compares.
 */
function checkLinkMeta(
	key: string | undefined,
	value: string | undefined,
): void {
	if (key !== ISSUE_LINK_KEY) return;
	if (
		!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+\/?$/u.test(
			value?.trim() ?? "",
		)
	)
		throw new Error(
			`${ISSUE_LINK_KEY}= links the agent to an item: it takes the URL of an Issue or a pull request (https://github.com/OWNER/REPO/issues/N or …/pull/N), as 'issue assign' writes it; got ${JSON.stringify(value ?? "")}.`,
		);
}

/** `agent status`'s `invariant`, from the service's standing. */
function invariantOf(
	standing: TellStanding | undefined,
): TellAgentStatus["invariant"] {
	if (standing === undefined) return null;
	return {
		settled: standing.settled,
		needsAction:
			standing.breach === undefined ? null : breachWords(standing.breach),
		waiting: standing.waiting ?? null,
		kept:
			standing.kept === undefined
				? null
				: {
						note: standing.kept.note,
						at: new Date(standing.kept.at).toISOString(),
					},
	};
}

/** The ranking a command gives, as the port takes it. */
function rankOf(command: {
	readonly priority?: "high" | "normal" | "low";
	readonly effort?: "quick" | "normal" | "deep";
	readonly rankNote?: string;
}): TellEscalationRank {
	return {
		...(command.priority === undefined ? {} : { priority: command.priority }),
		...(command.effort === undefined ? {} : { effort: command.effort }),
		...(command.rankNote === undefined ? {} : { note: command.rankNote }),
	};
}

/** `priority high, effort quick: blocks the release`. */
function rankText(one: EscalationWire): string {
	return `priority ${one.priority ?? "normal"}, effort ${one.effort ?? "normal"}${one.rankNote === undefined ? "" : `: ${one.rankNote}`}`;
}

/** `escalation show`'s line for a note (an entry with a `kind`). */
function noteLine(entry: EscalationWire["entries"][number]): string {
	const at = new Date(entry.at).toISOString();
	const note = entry.markdown === "" ? "" : `: ${entry.markdown}`;
	switch (entry.kind) {
		case "direct":
			return `--- the person talked to ${entry.agent ?? "an agent"} directly, ${at} (read it: devhub --tell agent read ${entry.agent ?? "<agent>"})`;
		case "resumed":
			return `--- ${entry.agent ?? "an agent"} went back to work, ${at}: no longer waiting for an answer`;
		case "taken":
			return `--- moved to in_progress (not an answer), ${at}${note}`;
		case "wait":
			return `--- waiting on: ${entry.markdown}${entry.dueAt === undefined ? "" : ` (at ${new Date(entry.dueAt).toISOString()})`}, since ${at}`;
		default:
			return `--- held in in_progress by the orchestrator, ${at}${note}`;
	}
}
