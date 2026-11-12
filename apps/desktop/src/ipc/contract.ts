/**
 * The one contract between the App Shell page and the main process.
 *
 * The page never touches Electron's IPC directly: the preload exposes exactly
 * the calls below as `window.devhub`, and every one of them is a request the
 * main process answers or an error it throws. There is no second style.
 *
 * This is the Tauri app's command surface with the transport swapped: what was
 * `invoke("dispatch_app_intent", …)` is `devhub.dispatch(intent)`, and what was
 * `listen("app://snapshot-changed", …)` is `devhub.onSnapshot(…)`. The payloads
 * are unchanged, so the App Shell components are the same components.
 */

import type { DevhubNeovimApi } from "./neovim.js";
import type { ShellPalette } from "./palette.js";
import type { DevhubTerminalApi } from "./terminal.js";
import type { ConversationApi, FileRange } from "./conversation.js";
import type { VoiceApi } from "./voice.js";
import type {
	AgentLaunchWire,
	AgentPresentationWire,
	AgentProfiles,
	AgentStatusWire,
	AppAppearance,
	AppError,
	AppIntent,
	AppOutcome,
	AppSnapshot,
	ConfirmationPurposeWire,
	NoticeRetiredWire,
	ReplayWire,
} from "./appShell.js";

/** One place work can happen: a repository itself, or one of its worktrees. */
export interface IssueWorktree {
	readonly path: string;
	/** What is checked out there, so two worktrees can be told apart. */
	readonly branch?: string;
	/** The repository itself, rather than one of its worktrees. */
	readonly isMainWorktree: boolean;
}

/**
 * A folder, and the machine it is on.
 *
 * The shape `requestedLocation` already takes, so a place that crossed the wire
 * becomes a `WorkspaceLocation` — and therefore a `Runtime` — without anything
 * in between having to ask which machine it was. A bare path would be the same
 * question asked again at every step, with a different answer each time
 * somebody forgot.
 */
export type WorkspacePlaceWire =
	| { readonly kind: "local"; readonly path: string }
	| { readonly kind: "ssh"; readonly host: string; readonly path: string };

/** A place as a person reads it: `host:path` when the machine is not this one. */
export function placeLabel(place: WorkspacePlaceWire): string {
	return place.kind === "ssh" ? `${place.host}:${place.path}` : place.path;
}

/**
 * One clone of the repository an Issue lives in, with everywhere it is checked
 * out.
 *
 * A repository and its worktrees used to arrive as a flat list of equals, and
 * the flow asked about them in two goes: which of these, then worktree or not.
 * That reads as two questions and is really one — worktrees of one repository
 * are not *different repositories*, they are the same repository in several
 * places, and asking somebody to pick one and then asking whether they wanted a
 * different one is asking twice.
 *
 * So the grouping happens where the facts are. The identity is the main
 * worktree's path, which is what git itself answers with, so two directories
 * are the same repository exactly when git says they are.
 */
export interface IssueRepository {
	/**
	 * The repository's own directory, and its identity — with the machine it is
	 * on, because a path alone is not one.
	 *
	 * Two hosts can both have `/srv/app`, and a flow that carried only the path
	 * would run git on this Mac against a directory on somebody's server and be
	 * told it is not a repository. So every step after this one carries the
	 * place, and the worktree it makes is a place on the same machine by
	 * construction.
	 */
	readonly place: WorkspacePlaceWire;
	/** Everywhere it is checked out, the repository itself first. */
	readonly worktrees: readonly IssueWorktree[];
}

/**
 * Who GitHub says this machine is, or why DevHub cannot say.
 *
 * Two answers and no default. A page that guessed an owner would clone
 * somebody else's repository under a name the person recognised, which is the
 * worst way to be wrong, so not knowing is carried as a reason to show.
 */
export type GitHubLoginWire =
	| { readonly kind: "login"; readonly login: string }
	| { readonly kind: "unknown"; readonly reason: string };

/** One thing DevHub can say to an agent, and what makes it say it. */
export interface AgentActionWire {
	readonly id: string;
	readonly displayName: string;
	/**
	 * What fires it. The Issue flow offers every `issue` action as a choice;
	 * every other trigger is a Smart Button's, drawn on an Agent's pane while
	 * its condition holds (`smartButtonTriggers` in `model/agentActions.ts`).
	 */
	readonly trigger: AgentActionTriggerWire;
	/**
	 * Whether it is drawn as a Smart Button when its trigger holds. Always false
	 * for an Issue action. The Agent actions sheet lists it either way.
	 */
	readonly button: boolean;
}

export type AgentActionTriggerWire =
	| "issue"
	| "commit"
	| "push"
	| "pull_request"
	| "draft_pull_request"
	| "unresolved_review_comments"
	| "ci_failing"
	| "always";

/**
 * The branch an Issue or a pull request already has, and what can be done with
 * it in one particular clone.
 *
 * Read in one call because the four facts are one question — *is there a branch
 * for this, and can this checkout have it?* — and each is worthless without the
 * others: a name with nowhere to fetch it from is a row that can only fail, and
 * a name already checked out somewhere is a different offer entirely.
 *
 * Everything absent is the ordinary case: an Issue nobody has started, whose
 * branch DevHub is about to invent.
 */
export interface AssignmentBranchWire {
	/** The branch that exists for it: a pull request's head, an Issue's link. */
	readonly branch?: string;
	/**
	 * Where the branch lives, when that is not the repository being worked in —
	 * `alice/widget` for a pull request out of a fork.
	 *
	 * Present *and* `reachable` false is the case worth saying out loud: the
	 * branch exists, and not anywhere this clone can see.
	 */
	readonly fork?: string;
	/** The branch is here, or on a remote this clone has, so it can be had. */
	readonly reachable: boolean;
	/** Where it is already checked out, when it is. Opening that is the offer. */
	readonly checkedOutAt?: string;
	/**
	 * A pull request's state, when GitHub said: a merged or closed one whose
	 * head is gone is stopped before the branch question with that reason.
	 */
	readonly pullRequestState?: "open" | "closed" | "merged";
}

/**
 * Where an Issue is to be worked on: the clone, and the branch that decides
 * which folder of it.
 *
 * The first half of assigning an Issue, and only the folder work: DevHub makes
 * the worktree, or finds the one the branch is already in, or takes the clone
 * as it stands, and answers with that folder. Nothing is opened. The agent
 * question is asked about the folder by its path — its earlier sessions are
 * read there — and the folder becomes a Workspace only when an agent is chosen
 * for it, so the question keeps the keyboard and no editor starts behind it.
 */
export interface IssueFolderRequest {
	readonly issueUrl: string;
	/** The clone to work in, and the machine it is on. */
	readonly place: WorkspacePlaceWire;
	/**
	 * The branch whose worktree to open, made if it is not there yet. Absent
	 * means the clone's own folder, on whatever branch it is on.
	 */
	readonly branch?: string;
	/**
	 * Check `branch` out in the clone's own folder instead of a worktree —
	 * made from the default branch if need be, refused if the folder has
	 * uncommitted changes. Ignored without `branch`.
	 */
	readonly inRoot?: boolean;
	/**
	 * Start the branch from the `origin` already on disk, the fetch having
	 * failed and the person having been asked and said to go on.
	 *
	 * Absent means no, which is what every first attempt sends: a stale base is
	 * only ever used deliberately.
	 */
	readonly allowStaleBase?: boolean;
	/**
	 * The fetch the flow began with (`fetchForAssignment`), handed on so that
	 * `origin` is not fetched a second time: `fetched` reads the refs as
	 * current, `on-disk` reads them as they are. Absent, the folder step
	 * fetches first itself, as the command line's does.
	 */
	readonly origin?: OriginFetchWire;
}

/**
 * What became of the fetch an Issue assignment starts with: `origin` fetched
 * just now, or the copy on this machine taken as it is — the fetch failed and
 * the person said to go on, or there is no `origin`.
 */
export type OriginFetchWire = "fetched" | "on-disk";

/**
 * The second half: open the folder as the selected Workspace, start an agent
 * in it, and tell it about the Issue — one act, taken once the agent is chosen.
 */
export type IssueAssignment = IssueEditorOnly | IssueAgentAssignment;

/** Fields both ways of assigning share. */
interface IssueAssignmentBase {
	readonly issueUrl: string;
	/** The folder `prepareIssueFolder` answered with, on its machine. */
	readonly place: WorkspacePlaceWire;
}

/** "Just open the editor": open the folder as the selected Workspace, no agent. */
export interface IssueEditorOnly extends IssueAssignmentBase {
	readonly editorOnly: true;
}

export interface IssueAgentAssignment extends IssueAssignmentBase {
	readonly editorOnly?: false;
	readonly profileId: string;
	/**
	 * Which action to start the agent with, from `agent_actions`.
	 *
	 * Absent when there are none configured, which is a person who has decided
	 * DevHub should start the agent and say nothing.
	 */
	readonly actionId?: string;
	/** The agent beside the editor rather than over it — ⌥Return, as ever. */
	readonly split: boolean;
	/** TUI or GUI, as the agent row said when it was taken (⌘ flips it). */
	readonly presentation: "tui" | "gui";
	/**
	 * The name to give the agent as it starts, as Rename… would: kept with
	 * its session and shown wherever a given name is. Absent keeps DevHub's
	 * own label. Only `devhub --tell issue assign --name` gives one; the
	 * Assign Issue sheet does not ask.
	 */
	readonly name?: string;
	/**
	 * An earlier session of the profile's CLI in that folder, which
	 * the agent goes on with and is then told about the Issue. Absent starts
	 * afresh.
	 */
	readonly resume?: string;
}

/**
 * What one workspace is working on: the branch, and the Issue it is about.
 *
 * A separate projection from the snapshot, on its own clock, because it is the
 * only thing in the window that is *observed* rather than decided — a branch
 * changes because somebody ran git, and an Issue closes because somebody
 * clicked a button on another continent. Folding it into the snapshot would
 * make every poll a revision of the whole application state.
 */
export interface WorkspaceRepositoryWire {
	readonly workspaceId: string;
	/** What is checked out, or nothing when the workspace is not a repository. */
	readonly branch?: string;
	/**
	 * The branch is checked out but nothing has been committed to it yet.
	 *
	 * A repository made on GitHub a minute ago and cloned. `branch` is set — git
	 * has a branch in mind and says so — but there is no commit under it, and
	 * every question about what is *in* the repository has no answer rather than
	 * a boring one. The row says so instead of showing a branch that looks like
	 * every other branch, because the two are not the same thing to a person
	 * deciding whether to cut a worktree from it.
	 */
	readonly unborn?: boolean;
	/**
	 * The repository this workspace belongs to: its main worktree's path.
	 *
	 * The identity git itself answers with, and the only honest way to tell that
	 * two open workspaces are the same repository in two places. The Sidebar
	 * sorts by it — worktrees under the repository they came from — because a
	 * flat list in the order folders happened to be opened puts a worktree three
	 * rows from the repository it is a worktree of.
	 */
	readonly mainWorktree?: string;
	/**
	 * The root of the checkout this workspace sits in.
	 *
	 * Equal to `mainWorktree` for the repository itself, different for one of its
	 * worktrees — the pair is what says which of the two a row is. The workspace's
	 * own path is neither when somebody opens a subdirectory, which is why this is
	 * a field rather than a comparison against the row's root: doing that made
	 * `repo/packages/app` read as a worktree of `repo`, drawn with a worktree's
	 * mark and offered a button that would have deleted the checkout around it.
	 */
	readonly worktree?: string;
	/**
	 * The repository's page, for a workspace whose `origin` is on GitHub.
	 *
	 * Only GitHub: a URL is built from a remote, and github.com is the only host
	 * DevHub knows the shape of. A remote it cannot build a page for has nothing
	 * here rather than a guess that leads somewhere wrong.
	 */
	readonly repositoryUrl?: string;
	/**
	 * Where this workspace's Issues and pull requests are numbered, for a
	 * workspace whose `origin` is on GitHub: `upstream` in a fork, else
	 * `origin` — the repository `issue` and `pullRequest` are read from.
	 *
	 * What a bare `#128` in a GUI Agent's conversation links to. Absent, it is
	 * not a link: a number without a repository names nothing.
	 */
	readonly issueRepository?: {
		readonly owner: string;
		readonly repository: string;
	};
	/**
	 * Work here that removing the folder would destroy, as of the last look.
	 *
	 * Tracked changes and untracked files alike. Absent when DevHub could not
	 * tell, which is not the same as clean.
	 *
	 * It decides whether removing the worktree is *asked about*, and never
	 * whether the removal is safe: it is a poll up to a minute old, so a removal
	 * DevHub believes is safe still goes to git without `--force` and git's
	 * refusal is the authority. Absent is treated as dirty — the question is the
	 * safe branch, and DevHub not knowing is not a reason to skip it.
	 */
	readonly dirty?: boolean;
	/**
	 * Commits here that the branch's upstream does not have.
	 *
	 * `0` when the branch is level with what it tracks, and absent when there is
	 * nothing to compare against — a branch nobody has pushed, or a repository
	 * with no remotes. Absent is not zero: "there is nothing to push" and "there
	 * is nowhere to push it" are different answers, and only one of them means a
	 * push would help.
	 */
	readonly ahead?: number;
	/**
	 * What `origin` calls its default branch, when the clone knows.
	 *
	 * Absent means not knowing, and the shortcut that reads it stays quiet then:
	 * it is how "this branch is the trunk" is decided, and offering to open a
	 * pull request from the trunk is a button with nothing to do.
	 */
	readonly defaultBranch?: string;
	readonly issue?: {
		readonly url: string;
		readonly number: number;
		readonly title: string;
		readonly state: "open" | "closed";
		/** Projects (v2) boards and Status lanes the Issue is on. */
		readonly projects?: readonly {
			readonly project: string;
			readonly status?: string;
			readonly color?: string;
		}[];
		/** The token cannot read Projects (`read:project` missing). */
		readonly projectsUnreadable?: boolean;
	};
	/**
	 * The pull request out from the checked-out branch.
	 *
	 * Found by asking the branch what is out from it, not by reading closing
	 * keywords out of open pull request bodies — so it is here for a branch that
	 * names no Issue at all, and it is here after the pull request is merged or
	 * closed. Where a branch has more than one, it is the live one, and the most
	 * recently updated of those.
	 */
	readonly pullRequest?: {
		readonly number: number;
		readonly url: string;
		readonly title: string;
		readonly state: "open" | "draft" | "closed" | "merged";
		/**
		 * Its review conversations nobody has resolved. `uncounted` is how many
		 * threads were past the page the count was read from — nought unless the
		 * pull request has more than a hundred — so a count that is only a lower
		 * bound is never drawn as the whole of it.
		 */
		readonly conversations: {
			readonly unresolved: number;
			readonly uncounted: number;
		};
		/** GitHub's review decision; absent when it has none. */
		readonly review?: "approved" | "changes_requested" | "review_required";
		/**
		 * What its CI says about its head commit: GitHub's own verdict, and how
		 * many of `total` checks are failing and how many have not finished.
		 * Absent when nothing has reported on that commit.
		 */
		readonly checks?: {
			readonly state: "passing" | "failing" | "pending";
			readonly total: number;
			readonly failing: number;
			readonly pending: number;
		};
	};
	/**
	 * Why this row cannot say what the workspace is working on.
	 *
	 * A branch called `feature/128-…` is a workspace that *is* about Issue 128
	 * whether or not GitHub answered. Without this the row looked exactly like a
	 * branch that names no Issue at all, and the reason — a number that is
	 * really a pull request, a private repository, a token without the scope,
	 * a rate limit — was one line at the foot of the whole Sidebar, attached to
	 * nothing. Two different facts drawn identically, with the explanation kept
	 * somewhere else, is how "it just does not link" becomes unanswerable.
	 *
	 * One field rather than one per failing step, because the row is asking a
	 * single question — *what is this working on?* — and every way of failing to
	 * answer it produces the same blank. A second channel for the failures that
	 * happen before an Issue number is known would be a second way of saying the
	 * one thing, and the two would drift: git refusing to run, an `origin` that
	 * is not a GitHub repository, and GitHub declining to answer all leave the
	 * person looking at the same empty line, and all of them belong here.
	 *
	 * `number` is present only when the branch actually named an Issue — the
	 * failures upstream of that (no git, no repository, a remote DevHub cannot
	 * resolve) know there is a question but not which one.
	 *
	 * It is never present alongside `issue`: what was last known outranks a look
	 * that failed, which is the same rule `diagnostic` follows. So this appears
	 * only when there is nothing known to show instead, and it is replaced the
	 * moment a later look succeeds.
	 */
	/**
	 * DevHub knows which Issue this is and has not heard back yet.
	 *
	 * The third answer to "what is this working on?", and it needs to exist
	 * because the branch is now read on a much faster clock than GitHub is
	 * asked. A branch you have just switched to appears at once; for the second
	 * or two before GitHub answers, the row would otherwise look like a branch
	 * that is about no Issue — the same blank that used to hide every failure,
	 * arriving now on every successful switch.
	 *
	 * Never present alongside `issue` or `unavailable`: those are answers, and
	 * this is the state of having none yet.
	 */
	readonly pending?: {
		readonly number: number;
	};
	readonly unavailable?: {
		/** The Issue the branch named, when the branch got far enough to name one. */
		readonly number?: number;
		/** GitHub's own words, git's own words, or DevHub's about not having asked. */
		readonly reason: string;
	};
}

/**
 * A standing fact about DevHub, and whether it still holds.
 *
 * The counterpart of `nativeError` for the things that are not events. A
 * failure is about something the person just asked for and is retired by their
 * next action; a condition — a machine that is not answering — is about
 * nothing they did, so only its own source can say it is over. That is what
 * `summary` being absent means, and it is the *only* thing that takes one off
 * screen besides the person putting it away.
 *
 * `source` is the key: main keeps one entry per source
 * (`main/shell/appConditions.ts`) and sends only a change to it, and the page
 * draws each source's condition as its own toast — so one source retracting
 * its own leaves every other source's standing.
 */
export interface AppConditionWire {
	readonly source: string;
	/** Absent: the source retracts it. */
	readonly summary?: string;
}

/**
 * How much of each CLI's rate limits is used, as DevHub's background reader
 * and its GUI Agents last reported them. One entry per CLI with plan limits,
 * always; `windows` absent means nothing has reported one yet — not that
 * nothing is used. One window per
 * limit the CLI keeps (`5-hour`, `7-day`, …), in the order first reported.
 * See `main/shell/usageLimits.ts`.
 */
export interface UsageLimitsWire {
	readonly clis: readonly {
		readonly cli: "claude" | "codex";
		readonly windows?: readonly {
			/** Which window, in words: a label, never read for its length. */
			readonly window: string;
			/** How long the window is, in minutes; absent when the CLI does not say. */
			readonly durationMinutes?: number;
			/** 0–100. */
			readonly usedPercent?: number;
			/** Epoch milliseconds. */
			readonly resetsAt?: number;
		}[];
		/**
		 * What DevHub's own reader of the account last said besides windows:
		 * the sign-in has no plan limits (an API key, Bedrock), or the CLI's
		 * command is not on this Mac, so it cannot be asked.
		 */
		readonly note?: UsageNoteWire;
		/**
		 * How DevHub's own reader of this CLI's account is doing: when it last
		 * read the limits, and why its latest attempt gave nothing, when it did
		 * — so a readout can say that what it shows is old, and why. Absent
		 * until the reader has tried once.
		 */
		readonly reader?: {
			/** When the reader last read the account (epoch ms); absent: never yet. */
			readonly readAt?: number;
			/**
			 * Its latest attempt, when that gave no reading: when it was
			 * (epoch ms), and why, in words. Absent once a reading succeeds.
			 */
			readonly problem?: { readonly at: number; readonly text: string };
		};
	}[];
}

export type UsageNoteWire = "no_plan_limits" | "cli_not_found";

export interface RepositoryStatusWire {
	readonly sequence: number;
	readonly workspaces: readonly WorkspaceRepositoryWire[];
	/**
	 * Why the last look was incomplete, if it was.
	 *
	 * It travels *beside* what is still known rather than replacing it: a
	 * network that dropped must not read as an Issue that closed. It is gone
	 * when a later round succeeds, and by no other rule.
	 */
	readonly diagnostic?: string;
}

/** One subject that breaks the invariant, as the board carries it. */
export interface NeedsActionWire {
	/** An open task, an Issue or a pull request item, or a managed agent. */
	readonly kind: "task" | "issue" | "pr" | "agent";
	/** `task <id>`, `item <url>` or `agent <id>`. */
	readonly key: string;
	/** The dispatcher's subject: `task 12`, `item owner/repo#N`, `agent <id>`. */
	readonly subject: string;
	/** Its words, as `needs_action` says them (without the `[type]`). */
	readonly line: string;
	/** The clause it fails: `no_agent`, `idle`, `no_task`. */
	readonly clause: string;
	/** Since when it has needed action (ms since the epoch). */
	readonly since: number;
}

/** An agent's standing for its row: see `OrchestratorBoardWire.agentStates`. */
export interface AgentOrchestrationWire {
	/** The open task it is bound to. */
	readonly task?: {
		readonly id: number;
		readonly title: string;
		readonly status: TaskStatusWire;
	};
	/**
	 * Needs action — its task's clause (`idle`, `no_agent`), or its own
	 * (`no_task`, a managed agent bound to no open task).
	 */
	readonly needsAction?: string;
}

/** A task's status, as the board files it (`model/tasks.ts`). */
export type TaskStatusWire = "answer" | "in_progress" | "waiting" | "done";

/** One question to the person, and their answer. See `model/escalations.ts`. */
export interface EscalationWire {
	readonly id: number;
	readonly taskId: number;
	readonly title: string;
	readonly state: "open" | "answered" | "withdrawn";
	readonly question: {
		readonly markdown: string;
		/** ms since the epoch. */
		readonly at: number;
		readonly options?: readonly string[];
	};
	readonly answer?: {
		readonly markdown: string;
		readonly at: number;
		readonly option?: string;
	};
	readonly withdrawn?: { readonly at: number; readonly note?: string };
	readonly links: readonly string[];
	/** What a link is, in a line (`--link URL=LABEL`), by the link. */
	readonly linkLabels?: Readonly<Record<string, string>>;
	readonly createdAt: number;
}

/** An agent bound to a task, as the board names it. */
export interface TaskAgentWire {
	readonly agentId: string;
	readonly name: string;
	/** Open in the window now. */
	readonly live: boolean;
	/** Its Sidebar status, while it is open. */
	readonly status?: string;
	readonly workspaceId?: string;
	readonly workspaceLabel?: string;
	/** Stopped, with a Claude or Codex session to go on with. */
	readonly resumable: boolean;
	readonly stoppedAt?: number;
	readonly profileId?: string;
	readonly kind?: string;
	/** The model it ran on over its profile's own (`model/agentModel.ts`). */
	readonly model?: string;
	readonly machine?: string;
	readonly folder?: string;
	readonly branch?: string;
	/** The CLI session it last ran. */
	readonly session?: string;
}

/** A task, as the board and `--tell` carry it. See `model/tasks.ts`. */
export interface TaskWire {
	readonly id: number;
	readonly title: string;
	/** 回答待ち (`answer`, derived from an open escalation), 処理中, 待機, done. */
	readonly status: TaskStatusWire;
	/** 待機: what it waits for, and when to look again. */
	readonly waitNote?: string;
	readonly checkAt?: number;
	readonly links: readonly string[];
	readonly linkLabels?: Readonly<Record<string, string>>;
	/** Oldest first; the last is the one `agent resume task=N` brings back. */
	readonly agents: readonly TaskAgentWire[];
	/** The orchestrator's one note: what is next. */
	readonly memo?: { readonly text: string; readonly at: number };
	readonly priority: "high" | "normal" | "low";
	readonly priorityNote?: string;
	/** Made from the person's request: their words; `sentAt` once delivered. */
	readonly request?: {
		readonly text: string;
		readonly at: number;
		readonly sentAt?: number;
	};
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly done?: { readonly at: number; readonly note?: string };
	/** 要対応: the clause it fails (`idle`, `no_agent`); absent when settled. */
	readonly needsAction?: string;
	/**
	 * May no longer match reality (`staleness.ts`): a linked pull request
	 * merged or closed, a linked Issue closed. Open tasks only.
	 */
	readonly mayBeStale?: {
		readonly since: number;
		readonly reasons: readonly string[];
	};
	/** Its escalations, oldest first: the open ones, then its past Q&A. */
	readonly escalations: readonly EscalationWire[];
}

/**
 * The next delivery, as it would go now (`EventDispatcher.preview`): the
 * person's held words, each a message of its own, then the batch — the
 * `event_prompt` with `{EVENT}` filled — and when it goes.
 */
export interface OrchestratorNextDeliveryWire {
	readonly human: readonly string[];
	/** The batch message; absent with no lines. */
	readonly batch?: string;
	/** How many lines the batch carries, and how many more were cut. */
	readonly lines: number;
	readonly more: number;
	/**
	 * `now` (within the batch window), `at` the interval's end,
	 * `after_turn` once the orchestrator takes it, `paused` until resumed,
	 * `saving_held` when saving holds every line (nudges waiting for the
	 * next triage), `nobody` with no orchestrator. Absent: nothing to send.
	 */
	readonly when?:
		| { readonly kind: "now" }
		| { readonly kind: "at"; readonly at: number }
		| { readonly kind: "after_turn" }
		| { readonly kind: "paused" }
		| { readonly kind: "saving_held"; readonly lines: number }
		| { readonly kind: "nobody" };
}

/** The Orchestrator's mode, as the board and the commands say it. */
export type OrchestratorModeWire = "full" | "saving" | "off";

/**
 * The Orchestrator screen's board: the tasks by status, the orchestrator,
 * and its mode. Pushed whenever any of it moves.
 */
export interface OrchestratorBoardWire {
	readonly revision: number;
	/** The orchestrator agent, while one is assigned. */
	readonly orchestratorAgentId?: string;
	/**
	 * Whether the window can start one, and from what: `[orchestrator]` as
	 * DevHub runs on it. `problem` is why it cannot, in a sentence.
	 */
	readonly start: {
		readonly root?: string;
		readonly profile?: string;
		readonly presentation?: "gui" | "tui";
		readonly problem?: string;
	};
	/** Events are held, not delivered, until resumed: `mode` is off. */
	readonly paused: boolean;
	/**
	 * Full, saving or off (`main/orchestrator/mode.ts`). Off at every
	 * launch; absent reads as off.
	 */
	readonly mode?: OrchestratorModeWire;
	/**
	 * Saving entered by the usage readout: the window at or over
	 * `saving_threshold`, and when it resets. Absent when the person chose
	 * the mode, or it is not saving.
	 */
	readonly autoSaving?: {
		readonly cli: string;
		readonly window: string;
		readonly usedPercent: number;
		readonly threshold: number;
		readonly resetsAt?: number;
	};
	/** The tasks 処理中: saving's gate reads it. */
	readonly inProgressTasks?: number;
	/** When the last triage went to the orchestrator, and when the next is due. */
	readonly triage?: { readonly lastAt?: number; readonly nextAt?: number };
	/**
	 * Events pending: held by the pause, or waiting for the orchestrator to
	 * finish its turn (they then go out together, as one message).
	 */
	readonly held: number;
	/**
	 * What the next delivery would send now, for the mode control's hover
	 * card. Always set by main; absent reads as nothing to send.
	 */
	readonly nextDelivery?: OrchestratorNextDeliveryWire;
	/**
	 * GitHub polling: `active`; `suspended` while events are paused (nothing
	 * is asked of GitHub, the last reading is kept); `idle` with no
	 * orchestrator, or no `[orchestrator.github] projects` (the population is
	 * then empty).
	 */
	readonly github: {
		readonly state: "active" | "suspended" | "idle";
		/** When the last request was sent (ms since the epoch). */
		readonly lastAt?: number;
		/** How it went: answered, failed (`problem` says why), or still out. */
		readonly lastOutcome?: "ok" | "failed" | "in_flight";
		/**
		 * When the next request is to be sent, while active; never before
		 * `lastAt` (`pollTimes` says both).
		 */
		readonly nextAt?: number;
		/** What the last poll said of the rate limit. */
		readonly rateLimit?: {
			readonly remaining: number;
			readonly limit: number;
			/** ms since the epoch. */
			readonly resetAt: number;
		};
		/**
		 * The open Issues and pull requests of the Projects assigned to the
		 * viewer (the population), once read in full.
		 */
		readonly assigned?: number;
		/**
		 * The registered Projects (`[orchestrator.github] projects`,
		 * `OWNER/NUMBER`), with their title when DevHub has one.
		 */
		readonly boards?: readonly {
			readonly ref: string;
			readonly title?: string;
		}[];
		/**
		 * What went wrong at the last poll, each complaint saying where it is
		 * from (`Project acme/7: …`, `pull request details: …`) in GitHub's
		 * words.
		 */
		readonly problem?: string;
		/** Since when `problem` has been so. */
		readonly problemAt?: number;
		/**
		 * While the population is not known: what is being read (`searching
		 * the open items assigned to me, page 2`).
		 */
		readonly reading?: string;
	};
	/**
	 * The subjects that break the invariant now (`main/orchestrator/
	 * invariant.ts`): open tasks nobody is moving, items of mine and managed
	 * agents with no task. Each as its `needs_action` line names it.
	 */
	readonly needsAction: readonly NeedsActionWire[];
	/**
	 * Each agent's task, and whether it needs action, for its row. Absent
	 * for an agent with neither.
	 */
	readonly agentStates: Readonly<Record<string, AgentOrchestrationWire>>;
	/** 回答待ち: priority first, then the oldest open question. */
	readonly answer: readonly TaskWire[];
	/** 処理中: priority first, then the longest untouched. */
	readonly inProgress: readonly TaskWire[];
	/** 待機: the soonest `checkAt` first (none after), then the oldest. */
	readonly waiting: readonly TaskWire[];
	/** Done: most recently completed first; the last few only. */
	readonly done: readonly TaskWire[];
}

export const EMPTY_BOARD: OrchestratorBoardWire = {
	revision: 0,
	start: {},
	paused: true,
	mode: "off",
	held: 0,
	github: { state: "idle" },
	needsAction: [],
	agentStates: {},
	answer: [],
	inProgress: [],
	waiting: [],
	done: [],
};

/** The board, read and kept current. The Sidebar's row and the Agents page. */
export interface OrchestratorBoardBridge {
	getOrchestratorBoard(): Promise<OrchestratorBoardWire>;
	onOrchestratorBoard(
		listener: (board: OrchestratorBoardWire) => void,
	): () => void;
}

/** One entry of a folder in the orchestrator's root, for the Files tab. */
export interface OrchestratorFileEntryWire {
	readonly name: string;
	/** From the root, `/`-separated: `decisions.md`, `.claude/skills`. */
	readonly path: string;
	readonly kind: "directory" | "file";
}

/** A folder in the orchestrator's root, listed (noise and ignored left out). */
export interface OrchestratorFolderWire {
	/** The root, absolute; absent while none is set or it is not there. */
	readonly root?: string;
	/** The folder, from the root; `""` is the root itself. */
	readonly path: string;
	/** Folders first, then files, each by name. */
	readonly entries: readonly OrchestratorFileEntryWire[];
	/** Why there is nothing to list, in a sentence. */
	readonly problem?: string;
}

/**
 * A file in the orchestrator's root, read for the Files tab. Markdown and
 * other text carry `text`; an image (SVG included) a `data:` URL; a file
 * too large or not text carries neither.
 */
export interface OrchestratorFileWire {
	readonly path: string;
	readonly kind: "markdown" | "text" | "image" | "binary" | "too_large";
	readonly size: number;
	/** Last written (ms since the epoch): what "changed" is measured against. */
	readonly modifiedAt: number;
	readonly text?: string;
	/** For `text`: the highlighter's language, from the extension. */
	readonly language?: string;
	readonly dataUrl?: string;
}

/**
 * The orchestrator's folder, read-only: list, read, and be told when it
 * changes. Every path is from the root and stays inside it — `..`, absolute
 * paths and symlinks that lead out are refused in main.
 */
export interface OrchestratorFilesBridge {
	listOrchestratorFolder(path: string): Promise<OrchestratorFolderWire>;
	readOrchestratorFile(path: string): Promise<OrchestratorFileWire>;
	/** Open the file in the workbench of the Workspace it belongs to. */
	openOrchestratorFile(path: string): Promise<void>;
	/** The paths (from the root) that changed, a moment after they did. */
	onOrchestratorFilesChanged(
		listener: (paths: readonly string[]) => void,
	): () => void;
}

/**
 * What an escalation's thread draws from files — a screenshot, an SVG, a
 * diagram file — read the way a conversation reads its embeds (the same
 * readers, the same rules: absolute, a kind an embed draws) on this Mac,
 * so an escalation draws whether or not its agents are still there.
 */
export interface EscalationEmbedsBridge {
	resolveEscalationPaths(
		cwd: string | undefined,
		paths: readonly string[],
	): Promise<readonly (string | null)[]>;
	readEscalationEmbed(path: string): Promise<{
		readonly mediaType: string;
		readonly bytes: Uint8Array;
		readonly signature: string;
	} | null>;
	escalationEmbedSignature(path: string): Promise<string | null>;
}

/** What the Orchestrator screen does that no other page may. */
export interface OrchestratorActionsBridge {
	/**
	 * The person's answer to an escalation. **The only way an answer is
	 * written**: no `devhub --tell` command reaches it.
	 */
	answerEscalation(id: number, markdown: string): Promise<void>;
	/** Start the orchestrator from `[orchestrator]`, as the board's button does. */
	startOrchestrator(): Promise<void>;
	/** Full, saving or off (`main/orchestrator/mode.ts`): the person's choice. */
	setOrchestratorMode(mode: OrchestratorModeWire): Promise<void>;
	/** The board's +: a 待機 task from the person's words, sent to the orchestrator. */
	sendOrchestratorRequest(text: string): Promise<void>;
	/** `Cmd+Q +` / the palette: open the board's request composer. */
	onOpenOrchestratorRequest(listener: () => void): () => void;
	/**
	 * What the left pane is showing, for the window's title: main names the
	 * window (`main/shell/shellTitle.ts`), so the page says only which
	 * task or file — an id or a path, never a body.
	 */
	reportOrchestratorView(view: OrchestratorViewWire): void;
}

/**
 * What the Orchestrator screen's left pane shows: the board (or the Files
 * tab's tree), a task read over the board, or a file over the tree.
 */
export type OrchestratorViewWire =
	| { readonly kind: "board" }
	| { readonly kind: "task"; readonly id: number }
	| { readonly kind: "file"; readonly path: string };

/**
 * What the page has put in the content area.
 *
 * Two things depend on this and they are not the same question, which is why
 * it is one word rather than a flag. *Is the native workbench view drawn?* —
 * yes for `workbench` and for `split`, where the workbench has part of the
 * area and an Agent has the rest. *Does the workbench hold the keyboard?* —
 * only for `workbench`: in a split the person selected an Agent and asked for
 * it beside its editor, so the Agent is what they are typing into.
 *
 * It used to be a boolean meaning "is a workbench visible", and main answered
 * both questions with it. So opening an Agent beside its workbench and then
 * clicking back onto DevHub put the keyboard in the editor, every time, on
 * every window focus — the Agent was on screen and selected, and the keys went
 * somewhere else.
 *
 * `page` covers everything the page draws for itself: an Agent with the whole
 * area, a message while a workspace is unavailable or an editor is restarting,
 * the wait before the model is ready. Main does not distinguish them, because
 * the answer to both questions is the same for all of them.
 */
/**
 * A drag in progress, as the page's own hand reports it.
 *
 * The sidebar's handle and the split's seam move under the pointer, and the
 * model only learns where they stopped: an intent per pointer move would put a
 * round trip in the middle of the one interaction that has to feel direct. So
 * while a drag lasts, the number being dragged to is told to main, which is
 * where the layout is computed.
 *
 * What is reported is a *pointer*, which the page owns. It is deliberately not
 * a rectangle: the page used to measure the hole it leaves for a workbench and
 * report that, and main's idea of the layout was then a page's idea of the
 * layout, one frame late. `null` ends a drag — the model has the number now.
 */
export interface LayoutPreviewWire {
	readonly sidebarWidth?: number | null;
	readonly splitRatio?: number | null;
	/**
	 * The divider between the Agent and its terminal, as the terminal's share
	 * of the seam's `extent` — whichever way it runs (`TerminalSeamWire`).
	 */
	readonly terminalShare?: number | null;
	/**
	 * Compact mode's floating Sidebar is up (or landing as compact mode is
	 * turned off): the one other geometric fact the page owns while it lasts,
	 * because the pointer it follows is in the page. `false` or `null` ends
	 * it. See `windowLayout.sidebarRect` and `useSidebarOverlay.ts`.
	 */
	readonly sidebarOverlay?: boolean | null;
	/**
	 * The Agents page has a picture or page from the Orchestrator's board
	 * open large over its whole view: its view goes over the conversation
	 * beside the board while it lasts. `false` or `null` ends it. See
	 * `LayoutState.agentsOverlay`.
	 */
	readonly agentsOverlay?: boolean | null;
}

/**
 * The divider between the Agent and its terminal, as main laid it out — the
 * strip the window's own page draws it in, because it is the one place no
 * child view covers. `extent` is what a drag's share is a share *of*: the
 * whole content area for the upright divider left of a full Agent's terminal,
 * or the split's right half for the level one under its Agent (`stacked`).
 * See `model/agentTerminal.ts`.
 */
export interface TerminalSeamWire {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** The terminal on the other side of it. */
	readonly terminalId: string;
	/** The terminal's share of `extent` now: its width, or its height. */
	readonly share: number;
	/** Under the Agent — a split's right half — rather than right of it. */
	readonly stacked: boolean;
	readonly extent: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

/**
 * The rectangle a workbench is laid into, as main computed it.
 *
 * Pushed to the page so it can leave exactly that hole. This is the direction
 * the old `setContentRect` ran in, reversed: whoever owns the layout says
 * where the seam is, and the page draws to it.
 */
export interface WorkbenchAreaWire {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/**
	 * How wide the whole content area is — the workbench, the seam and the
	 * Agent beside it — from `x` to the window's trailing edge.
	 *
	 * Said by main rather than measured, and `width` is not enough to work it
	 * out: in a split `width` is the leading share only. The page needs the
	 * whole of it because the split ratio is a ratio *of* it, and the
	 * alternative was `window.innerWidth - x`. A view's `innerWidth` is its
	 * own, and is one frame stale after main moves it either way, so a pointer
	 * landing in the first frame after a resize computed a ratio against the
	 * width the window used to be.
	 */
	readonly contentWidth: number;
	/**
	 * The divider left of the Agent's terminal, when one is shown. Absent is
	 * the content alone.
	 */
	readonly terminalSeam?: TerminalSeamWire;
}

/**
 * The rectangle the Sidebar's view is laid into, as main computed it.
 *
 * Pushed for one reason: the Sidebar has to be able to say where one of its
 * rows is *in the window*, and a page cannot work that out. `window.screenX`
 * is the screen's and needs the window's own origin subtracted back off;
 * `documentElement`'s box is the view's own and is one frame stale after main
 * moves it — measured, the collapsed Sidebar went on answering 249 for seconds
 * after being narrowed to 76. So the origin is the owner's number, told to the
 * page, exactly as the workbench area is.
 *
 * It is the whole rectangle rather than just the origin because the page has
 * to clip its anchor to it: a row scrolled half out of the column has half a
 * rectangle, and a tooltip pointing at the invisible half points at nothing.
 */
/** What `settleLayout` asks: answer `token` once drawn at this size. */
export interface SettleLayoutWire {
	readonly token: number;
	readonly width: number;
	readonly height: number;
}

export interface SidebarAreaWire {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Where the cursor is, as the floating Sidebar's page asks main once the
 * pointer has left its document (`useSidebarOverlay.ts`): whether it is still
 * on the card or on the tooltip a row raised, and whether the window is in
 * front. See `windowLayout.sidebarOverlayHolds`.
 */
export interface SidebarPointerWire {
	readonly inside: boolean;
	readonly active: boolean;
}

/**
 * One item of a context menu a page asks main to put up.
 *
 * Only what the menu draws: the act stays with the page, which runs the item
 * whose id comes back (`main/shell/contextMenu.ts`).
 */
export interface ContextMenuItemWire {
	readonly id: string;
	readonly label: string;
	/** Draw a separator above this item (the destructive ones stand apart). */
	readonly separatorBefore?: true;
}

/**
 * A context menu, and where the click that opened it was — in the **page's**
 * own coordinates. Main adds where it laid the page; the page is never asked
 * for a number main already has.
 */
export interface ContextMenuRequestWire {
	readonly items: readonly ContextMenuItemWire[];
	readonly at: { readonly x: number; readonly y: number };
}

/**
 * A tooltip the Sidebar is asking for, in the window's own coordinates.
 *
 * The Sidebar composes the sentence and knows which row the pointer is
 * resting on; main owns where anything in the window goes. So the page sends
 * the two facts only it has — what to say and which rectangle it is about —
 * and never learns where it ended up. Which side of that rectangle the box
 * goes on is not one of them: it is beside the row, always, and that is
 * `tooltipRect`'s to know.
 *
 * `anchor` is in **window** coordinates, converted by the page from its own
 * box plus the rectangle main told it it occupies (`SidebarAreaWire`). That
 * conversion is the one thing the page must get right, and it is one addition.
 */
export interface TooltipRequestWire {
	readonly lines: readonly TooltipLineWire[];
	readonly anchor: SidebarAreaWire;
}

/**
 * One fact, as a tooltip draws it: a mark, the fact itself, and how it is set.
 *
 * A tooltip used to be a string, and the string was a sentence about a row
 * composed out of label words — *widget workspace, path /projects/widget,
 * branch main*. Nobody reads that: the words "workspace", "path" and "branch"
 * are three quarters of the ink and they are the part the reader already knows,
 * because they are asking about a row in a list of workspaces.
 *
 * So a line is a fact and the mark in front of it is what the label word was:
 * the branch mark, then the branch. The reader recognises the mark the same way
 * they recognise it on the row, because it *is* the row's mark — `icon` is a
 * `GlyphName`, an identifier and never a drawing, so the tooltip page maps it
 * through the same `icons.tsx` the Sidebar draws from. Two pages, one set of
 * marks, and no SVG on the wire.
 *
 * `spoken` is what the words would have been. It is not sent — a screen reader
 * is never shown this — it is what the same composition produces for the row's
 * `aria-label`, which is the one place a label word still belongs. See
 * `shell/components/sidebar/rowDescription.ts`, where both come from one list
 * of facts, so the tooltip and the accessible name cannot come to disagree.
 *
 * A line is a fact in words (`TooltipFactLineWire`) or a measure drawn as a
 * bar (`TooltipMeterLineWire`), told apart by `kind`.
 */
export type TooltipLineWire = TooltipFactLineWire | TooltipMeterLineWire;

/** A fact in words, behind the mark the row would have drawn for it. */
export interface TooltipFactLineWire {
	/** Absent: a line is a fact unless it says it is something else. */
	readonly kind?: undefined;
	readonly icon?: GlyphNameWire;
	readonly text: string;
	/**
	 * How the line is set. The name of the thing is `name`; anything that
	 * qualifies it is `muted`; `note` is the stronger dim ink for a reason
	 * something is not happening; `danger` is a failure.
	 */
	readonly style?: "name" | "muted" | "note" | "danger";
	/**
	 * The status colour this line's mark and words take, when the line is about
	 * an Agent's status. Absent everywhere else, because nothing else in the
	 * Sidebar is coloured.
	 */
	readonly tone?: AgentStatusWire;
	/**
	 * Where this fact leads, when the fact is a place.
	 *
	 * Three of a row's facts name a page on GitHub — the repository, the Issue,
	 * the pull request — and the row's tooltip is where they are followed: the
	 * row's own marks carry no hover and the folder glyph is inert, so the box
	 * a person is reading is the thing they act on. Composed with the rest of
	 * the facts (`shell/components/sidebar/rowDescription.ts`) and only ever an
	 * `https://github.com/` page (`shell/githubPage.ts`), which the tooltip page
	 * checks again before it follows one. Absent on every fact that is not a
	 * place.
	 */
	readonly href?: string;
	/**
	 * A few subdued words after the fact, on the same line: where a Workspace
	 * is — `· SSH: host`, `· dev container: name` — beside its name in the
	 * tooltip's heading, or what a worktree was cut from —
	 * `(worktree of ~/src/widget)` — beside its path. Drawn as given.
	 */
	readonly qualifier?: string;
	/**
	 * The absolute path this fact's text names, when it names one: the box
	 * draws a quiet copy button inline right after it that puts this on the
	 * clipboard (`TooltipBridge.writeClipboard`). The text is `~`-abbreviated;
	 * this is not.
	 */
	readonly copy?: string;
	/** The same, for a path the `qualifier` names. */
	readonly qualifierCopy?: string;
	/**
	 * Where in the `qualifier` that path is written — the words the copy button
	 * for `qualifierCopy` follows, so it sits right after the path it copies
	 * (`(worktree of ~/src/widget⧉)`) rather than after the closing bracket.
	 * Absent, or not found in the qualifier: after the whole qualifier.
	 */
	readonly qualifierCopyAfter?: string;
}

/**
 * How much of something is used, drawn as a labelled bar: a CLI's rate-limit
 * window, today the only one.
 *
 * The line carries the numbers and not the words, because the words depend on
 * when the tooltip is read: "resets in 2h 10m" and whether the reading is
 * already history (its reset has passed, and nothing newer came in) are worked
 * out by the tooltip page as it draws, from its own clock. Composed at the
 * row, they would be as old as the Sidebar's last render.
 */
export interface TooltipMeterLineWire {
	readonly kind: "meter";
	/** What is measured, in words: "5-hour", "7-day", "primary". */
	readonly label: string;
	/** 0–100; absent when the CLI did not say. */
	readonly usedPercent?: number;
	/** When the measure starts again from zero, epoch milliseconds; absent when not said. */
	readonly resetsAt?: number;
}

/**
 * Which mark a tooltip line carries, by name.
 *
 * It is a plain string on the wire and is checked against the drawings the
 * tooltip page actually has: a name that does not resolve draws no mark rather
 * than throwing, because a missing icon beside a fact still says the fact.
 */
export type GlyphNameWire = string;

/** What the tooltip page is given to draw: the facts, and nothing else. */
export interface TooltipContentWire {
	readonly lines: readonly TooltipLineWire[];
	/**
	 * The most room the box may take, in the page's own CSS pixels: the
	 * window's content area less the margin `tooltipRect` keeps, divided by the
	 * page's zoom. The box wraps to this width and stops at this height rather
	 * than growing past the window and being cut off by its own view. Absent:
	 * no limit beyond the stylesheet's own.
	 */
	readonly room?: { readonly width: number; readonly height: number };
}

/**
 * A machine `~/.ssh/config` names, as the picker is told it.
 *
 * The alias is what travels back when the row is chosen: `ssh` resolves it,
 * and DevHub resolving it too would be a second answer that can disagree the
 * first time somebody edits a `HostName`. The rest is shown, so a person with
 * six aliases can tell which is which without opening the file.
 */
export interface SshHostWire {
	readonly alias: string;
	readonly hostName?: string;
	readonly user?: string;
}

/**
 * One candidate the workspace picker found. `searchText` is what the filter
 * matches against and `score` is the rank main assigned, so two sources that
 * disagree about ordering still merge into one list.
 *
 * `sourceRank` is where the source that named it sits in `workspace_sources`,
 * and it is what puts the merged list back in the order the person wrote in
 * Settings. Sources are run concurrently and answer at whatever speed they
 * answer, so arrival order is a race between a command and a directory walk —
 * which is why the rank travels with the candidate rather than the list being
 * assumed to arrive in it.
 */
export interface WorkspacePickerCandidate {
	readonly operationId: string;
	readonly sequence: number;
	readonly label: string;
	readonly searchText: string;
	readonly path: string;
	readonly score: number;
	readonly sourceId: string;
	/** The source's index in `config.workspace_sources`, from the top. */
	readonly sourceRank: number;
	/**
	 * The folder is not there yet, and choosing this row makes it.
	 *
	 * Only a date source that says `create_if_missing` produces one. Everything
	 * else offers folders it found, so this is false for them and there is no
	 * arrangement in which a row about a folder that exists is marked missing.
	 */
	readonly missing: boolean;
	/**
	 * The folder is a git worktree: its `.git` is a file pointing at another
	 * checkout's repository rather than a directory of its own.
	 *
	 * Read from the folder, the same way for every source, rather than from
	 * which `kinds` a source was told to look for — a command source names
	 * paths without saying what they are, and a row's kind must not depend on
	 * which source happened to name it. The sheet ranks a repository above a
	 * worktree the query matches equally well (`PickerItem.worktree`).
	 */
	readonly worktree: boolean;
}

/** Streamed progress for one picker run. */
export type WorkspacePickerEvent =
	| {
			readonly kind: "started";
			readonly operationId: string;
			readonly sequence: number;
			/**
			 * How many sources this run has to ask.
			 *
			 * Zero is a different sentence from "found nothing": a person with no
			 * `workspace_sources` has not searched an empty machine, they have not
			 * said where to look yet, and the sheet has to say which of the two it
			 * is. It travels on `started` so the sheet knows before any source has
			 * answered, rather than inferring it from a run that produced nothing.
			 */
			readonly sourceCount: number;
	  }
	| ({ readonly kind: "candidate" } & WorkspacePickerCandidate)
	| {
			readonly kind: "source-error";
			readonly operationId: string;
			readonly sequence: number;
			readonly sourceId: string;
			readonly errorCount: number;
			readonly truncated: boolean;
	  }
	| {
			readonly kind: "source-completed";
			readonly operationId: string;
			readonly sequence: number;
			readonly sourceId: string;
			readonly candidateCount: number;
			readonly errorCount: number;
			readonly stderrBytes: number;
	  }
	| {
			readonly kind: "cancelled";
			readonly operationId: string;
			readonly sequence: number;
			readonly sourceId?: string;
	  }
	| {
			readonly kind: "completed";
			readonly operationId: string;
			readonly sequence: number;
			readonly sourceId?: string;
			readonly candidateCount: number;
			readonly errorCount: number;
			readonly stderrBytes: number;
			readonly cancelled: boolean;
			readonly truncated: boolean;
	  };

/**
 * What a preload puts on `window.devhub` — one interface per page.
 *
 * There used to be one, `DevhubApi`, and every page got all of it. That was
 * not a convenience; it was the reason a page could take a subscription that
 * could never fire. `devhub:modals-changed` is sent to the `picker` view
 * directly rather than through `send()`, so `onModals` on any other page was a
 * listener on a channel nobody was ever going to write to — spellable, silent,
 * and indistinguishable from a bug in the modal layer. The same shape of trap
 * was available for every other member a page had no business with.
 *
 * So the contract is the preload. Each page is loaded with a preload of its
 * own (`preload/<page>.ts`) that exposes exactly the members that page's
 * header declares, and a member a page does not own is not *refused* there —
 * it is absent, which is a thing TypeScript can say and a running page cannot
 * work around. A page cannot subscribe to what it does not own because there
 * is nothing on the bridge to subscribe with.
 *
 * The fragments below are the parts several pages genuinely share, written
 * once so that "the projection" means the same four calls everywhere it
 * appears. A page interface is what it extends plus what only it has.
 */

/** What every page can do, whatever else it can. */
export interface PageBridge {
	/**
	 * Say that a failure *began on this page*, so main can journal it and
	 * publish it to the page that draws failures.
	 *
	 * This is one half of a rule with exactly two halves. A page raises only
	 * what originated in it — its root handler's `error` and
	 * `unhandledrejection`, and the intents it started — and it draws only what
	 * arrived on `nativeError`. A failure that arrived is never raised again;
	 * that is what keeps a failure from going round main and the page forever.
	 *
	 * It answers nothing, and it cannot: a call that could reject would raise
	 * its own rejection through the very root handler that calls this, which is
	 * the same loop by another route. Telling main is not asking it.
	 */
	raiseFailure(error: AppError): void;
	/**
	 * The colours of the Workbench's theme, which DevHub's chrome wears too.
	 *
	 * Every page is served wearing the last palette main persisted, and this is
	 * what keeps it current. Separate from the appearance, and not folded into
	 * it, because it has a different source: appearance is what the person
	 * wrote in `config.toml`, and this is what the Workbench is wearing. A
	 * config that will not parse must not take the window's colours down with
	 * it.
	 */
	onTheme(listener: (palette: ShellPalette) => void): () => void;
}

/**
 * The model as main projects it, and the one way to ask for a change.
 *
 * Four members and not three: a page reads the snapshot once, replays whatever
 * it missed, is told about every move, and dispatches. Every page that draws
 * from the model takes all four, because a page that took fewer would be a
 * page whose picture of the model could be older than main's without anything
 * saying so.
 */
export interface ProjectionBridge {
	getSnapshot(): Promise<AppSnapshot>;
	replay(cursor: number): Promise<ReplayWire>;
	onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
	dispatch(intent: AppIntent): Promise<AppOutcome>;
}

/** What the person wrote in `config.toml` about how DevHub should look. */
export interface AppearanceBridge {
	getAppearance(): Promise<AppAppearance>;
	onAppearance(listener: (appearance: AppAppearance) => void): () => void;
}

/** What each workspace is working on, re-read on its own clock. */
export interface RepositoryStatusBridge {
	getRepositoryStatus(): Promise<RepositoryStatusWire>;
	onRepositoryStatus(
		listener: (status: RepositoryStatusWire) => void,
	): () => void;
}

/** Claude's and Codex's rate limits, as the GUI Agents report them. */
export interface UsageLimitsBridge {
	getUsageLimits(): Promise<UsageLimitsWire>;
	onUsageLimits(listener: (limits: UsageLimitsWire) => void): () => void;
}

/** The agents Settings knows how to start, and whether discovery could say. */
export interface AgentProfilesBridge {
	getAgentProfiles(): Promise<AgentProfiles>;
	onAgentProfiles(listener: (profiles: AgentProfiles) => void): () => void;
}

/** The configured things one can say to a running agent. */
export interface AgentActionsBridge {
	/** The ways of starting an agent on an Issue, in the order Settings lists. */
	agentActions(): Promise<readonly AgentActionWire[]>;
	/**
	 * The same list again whenever the configuration changes. Reading once was
	 * enough while the actions were only read as a flow opened; a row of
	 * buttons stands for as long as its pane does, so it has to be told.
	 */
	onAgentActions(
		listener: (actions: readonly AgentActionWire[]) => void,
	): () => void;
	/**
	 * Say one of the configured actions to a running agent.
	 *
	 * Queued rather than sent, on the same terms as the Issue flow's first
	 * message: the injection waits for a settled idle screen, so a shortcut
	 * pressed while the agent is working lands when the agent is next listening
	 * rather than into the middle of its output.
	 */
	runAgentAction(agentId: string, actionId: string): Promise<AppOutcome>;
}

/**
 * Every way a Workspace can be started, and the questions each one asks.
 *
 * One fragment because they are one page's job: the sheets that ask where a
 * Workspace is coming from all stand on the `picker` view, and nothing else in
 * DevHub opens one.
 */
export interface WorkspaceOpeningBridge {
	/** Opens the native folder picker; resolves to the pick, or nothing. */
	chooseWorkspaceFolder(): Promise<string | undefined>;
	startWorkspacePicker(query: string): Promise<string>;
	cancelWorkspacePicker(): Promise<void>;
	selectWorkspacePicker(
		path: string,
		create: boolean,
		withAgent?: AgentLaunchWire,
	): Promise<AppOutcome>;
	onWorkspacePicker(
		listener: (event: WorkspacePickerEvent) => void,
	): () => void;
	/**
	 * The branches of the repository the selection's Workspace is in, for the
	 * workspace picker to offer beside its folders. Nothing when the selection
	 * is in no repository (Scratch, a plain folder) or git cannot be asked.
	 */
	listSelectionBranches(): Promise<BranchListWire | undefined>;
	/**
	 * Open `branch` of the repository at `place` as a Workspace: its worktree
	 * when it has one (focused when it is open already), else a worktree made
	 * for it — a remote-only branch as a local branch tracking it — placed
	 * under the selection's Workspace. `create`: a branch that is nowhere yet
	 * is started from the remote's default branch (the New Branch row: work
	 * with no Issue yet); without it, that is refused. A refusal (a folder in
	 * the way, git's own) is thrown with its reason.
	 */
	openBranchWorkspace(
		place: WorkspacePlaceWire,
		branch: string,
		create: boolean,
		withAgent?: AgentLaunchWire,
	): Promise<AppOutcome>;

	/**
	 * The two ways a workspace can start that are not "find one that exists".
	 *
	 * Both make a directory and then open it, in one call, because they are one
	 * act: a folder created and not opened is litter, and a page that had to ask
	 * for the second half could fail between them. A failure — the folder is
	 * there already, git could not reach the URL — is thrown with what to do
	 * about it, and the sheet that asked shows it and stays open.
	 */
	createProject(path: string, withAgent?: AgentLaunchWire): Promise<AppOutcome>;
	cloneProject(
		url: string,
		parentDirectory: string,
		withAgent?: AgentLaunchWire,
	): Promise<AppOutcome>;
	/** Where a new project goes unless the person says otherwise. */
	projectDefaultDirectory(): Promise<string>;
	/**
	 * The folders a clone could go into: the parents of everything the workspace
	 * sources find, in the sources' own order. Answers once, with all of them.
	 */
	cloneParentDirectories(): Promise<readonly string[]>;
	/** Clone, and answer with the directory git made. Opens nothing. */
	cloneRepository(url: string, parentDirectory: string): Promise<string>;

	/**
	 * The machines `~/.ssh/config` already names.
	 *
	 * Read on demand rather than pushed with the snapshot, because it is not
	 * part of what DevHub *is* — it is what the picker offers, and it is asked
	 * for at the moment the picker opens so a host added five minutes ago is
	 * there. A machine with no SSH config answers with an empty list, which the
	 * picker draws as "no rows", not as a failure.
	 */
	listSshHosts(): Promise<readonly SshHostWire[]>;
	/**
	 * Open a folder on another machine as a Workspace.
	 *
	 * Beside `selectWorkspacePicker` rather than folded into it, because the
	 * two questions differ: a local row can be a folder a source is offering to
	 * *make*, and there is no making a directory on a machine DevHub has not
	 * connected to. They meet one call later, at `openFolder`, which is where
	 * "this is a Workspace now" is decided for every way of opening one.
	 */
	openSshWorkspace(
		host: string,
		path: string,
		withAgent?: AgentLaunchWire,
	): Promise<AppOutcome>;

	/**
	 * Assigning an Issue, one question at a time.
	 *
	 * Four calls rather than one, and the seams are where the flow's questions
	 * are: each can fail, and each failure is answered by re-asking the question
	 * that led to it — a URL git could not reach is corrected in the field that
	 * asked for the parent folder, not in the branch picker three steps later.
	 * A single call would have one failure for five questions.
	 */
	findIssueRepositories(issueUrl: string): Promise<readonly IssueRepository[]>;
	/**
	 * Which GitHub account this machine is signed in as, so a repository typed
	 * as a bare name means the same thing to DevHub as to `gh repo clone`.
	 *
	 * Answers with the reason rather than throwing when it cannot say. Not
	 * knowing is an ordinary state of the world — no `gh`, or a `gh` that is
	 * logged out — and it is answered by typing the owner, which is something
	 * the sheet can say while it stands there.
	 */
	githubLogin(): Promise<GitHubLoginWire>;
	/**
	 * The branch this Issue or pull request already has, in this clone's terms.
	 *
	 * Asked once the clone is known, because half the answer is about the clone:
	 * a pull request's head branch is a fact of GitHub's, and whether it can be
	 * checked out here — and whether it already is — is a fact of this
	 * repository's remotes and worktrees. Read from the refs
	 * `fetchForAssignment` left: `origin` is not fetched again here. Throws what
	 * to do about it — no token, no such pull request — because the step that
	 * asked shows the reason.
	 */
	assignmentBranch(
		url: string,
		place: WorkspacePlaceWire,
	): Promise<AssignmentBranchWire>;
	/**
	 * Fetch the clone's `origin`, once, before anything about the branch is
	 * asked: `assignmentBranch` and `prepareIssueFolder` read the refs it
	 * leaves and do not fetch it again. Throws `git_fetch_failed` with git's
	 * reason, for the flow to offer the copy on disk.
	 */
	fetchForAssignment(place: WorkspacePlaceWire): Promise<OriginFetchWire>;
	listBranches(place: WorkspacePlaceWire): Promise<readonly string[]>;
	/**
	 * Make or find the folder the Issue is worked in, and answer with it —
	 * opening nothing. Throws what to do about it — a directory in the way, a
	 * fetch that failed — because the branch question shows the reason.
	 */
	prepareIssueFolder(request: IssueFolderRequest): Promise<WorkspacePlaceWire>;
	/**
	 * Open that folder as the selected Workspace, start the agent in it, and
	 * queue the Issue's action for it.
	 */
	assignIssue(request: IssueAssignment): Promise<AppOutcome>;
}

/**
 * The window's own page — `index.html`.
 *
 * What is left of the window when the Sidebar, the Agents, the notices and the
 * questions are views of their own: the title bar, the states in which there
 * is no child view to show, and the seam of a split.
 */
export interface ShellPageBridge
	extends PageBridge,
		ProjectionBridge,
		AppearanceBridge {
	/**
	 * What this window is called, right now.
	 *
	 * The name is composed in main (`shellTitle.ts`) out of the model and what
	 * the workbench on screen calls itself, and it is *the* name — the one the
	 * OS shows in Mission Control and the window menu. When DevHub draws its
	 * own title bar the page has to letter that same string, and asking for it
	 * is the only way to do that without a second composition that could say
	 * something different from the window it is written on.
	 *
	 * Pushed by `onWindowTitle` whenever it moves; read once on mount, for the
	 * moments between two pushes.
	 */
	getWindowTitle(): Promise<string>;
	onWindowTitle(listener: (title: string) => void): () => void;
	/**
	 * Where main has laid the workbench, so the page leaves that hole: the
	 * rectangle as it is now, asked of main as the page starts listening, and
	 * then each time it moves. Main says it only when it moves.
	 */
	onWorkbenchArea(listener: (area: WorkbenchAreaWire) => void): () => void;
	/**
	 * Put a modal on screen. Resolves to the id that closes it again.
	 *
	 * A page never draws a modal itself: main owns the set that is open, and
	 * the `picker` view draws it. That is what makes stacking a fact about the
	 * window rather than something each page has to reconstruct.
	 */
	openModal(request: ModalRequest): Promise<string>;
	/**
	 * Get rid of a workspace, whatever kind of workspace it is.
	 *
	 * **The one path.** The sidebar's close button, `Cmd+Q Shift+W` and
	 * `Cmd+Q X` on a workspace row all come here, because "close this" has to
	 * mean one thing: an ordinary workspace is closed, and a worktree is
	 * deleted — without a question when there is nothing in it to lose, and with
	 * the three-way one when there is. It answers nothing, because what happens
	 * next may be a question; the projection says how it ended.
	 */
	closeWorkspace(workspaceId: string): Promise<void>;
	/** Opens the native folder picker; resolves to the pick, or nothing. */
	chooseWorkspaceFolder(): Promise<string | undefined>;
	/** A split drag in progress; `null` ends it. */
	previewLayout(preview: LayoutPreviewWire): Promise<void>;
	openSettings(): Promise<void>;
}

/** The Sidebar — `sidebar.html`. Its header states the whole of this. */
export interface SidebarBridge
	extends PageBridge,
		ProjectionBridge,
		AppearanceBridge,
		RepositoryStatusBridge,
		UsageLimitsBridge,
		AgentProfilesBridge,
		OrchestratorBoardBridge {
	/**
	 * The menu commands whose subject is drawn here, and no others.
	 *
	 * `open_workspace_picker`, `focus_sidebar` and `retry_app`. A command about
	 * something drawn on another page is delivered to that page: main addresses
	 * the view, so there is no longer a "whichever page happened to be
	 * listening".
	 */
	onMenuCommand(listener: (command: MenuCommand) => void): () => void;
	/** Put a modal on screen. Resolves to the id that closes it again. */
	openModal(request: ModalRequest): Promise<string>;
	/** Get rid of a workspace, whatever kind. **The one path**; see above. */
	closeWorkspace(workspaceId: string): Promise<void>;
	/**
	 * Carry an Agent on in its other presentation, resuming its session: a GUI
	 * Agent in a terminal, a terminal Claude or Codex Agent in the GUI. The
	 * row menu's Continue in Terminal / Continue in GUI.
	 */
	continueAgent(agentId: string): Promise<void>;
	openExternalUrl(url: string): Promise<void>;
	/** The sidebar's width under the pointer while a drag lasts; `null` ends it. */
	previewLayout(preview: LayoutPreviewWire): Promise<void>;
	/**
	 * Hand the keyboard back to whatever is on screen.
	 *
	 * Escape in the Sidebar. It is a request to main rather than a `blur()`
	 * here, because the surface is usually a native `WebContentsView` that this
	 * document cannot focus — where the keyboard goes is the window's single
	 * answer, and asking it is the only way not to write a second one.
	 */
	focusSurface(): Promise<void>;
	/**
	 * Where main has laid this view, so a row can say where it is in the
	 * window. See `SidebarAreaWire` — the origin is the owner's number. As
	 * `onWorkbenchArea`: the rectangle as it is now, then each move.
	 */
	onSidebarArea(listener: (area: SidebarAreaWire) => void): () => void;
	/**
	 * Where the cursor is, for the floating Sidebar: on the card or its
	 * tooltip, and whether the window is in front. See `SidebarPointerWire`.
	 */
	sidebarPointer(): Promise<SidebarPointerWire>;
	/**
	 * Whether the chord prefix (`Cmd+Q`) is armed. While it is, each row wears
	 * the digit that selects it in place of its folder mark.
	 */
	onChordArmed(listener: (armed: boolean) => void): () => void;
	/**
	 * Put a row's context menu up over the window, as a native menu.
	 *
	 * The Sidebar used to draw its own, and a box in this document is clipped
	 * by this view — on a collapsed rail, to nothing. Resolves to the id of
	 * the item chosen, or `undefined` when the menu was dismissed; the page
	 * runs the item itself, the way its own buttons would.
	 */
	showContextMenu(request: ContextMenuRequestWire): Promise<string | undefined>;
	/**
	 * Raise a tooltip over the window, about a row in this column.
	 *
	 * The Sidebar used to draw its own, which is why the rail had none: a box
	 * in this document is clipped by this view, and this view is 44px wide on
	 * a collapsed rail. It asks now, and the tooltip is a child of the window
	 * (`main/shell/tooltipView.ts`), so the sentence may run out over the
	 * editor.
	 *
	 * One way, like `raiseFailure` and for the same reason: what is being sent
	 * is a fact about the pointer, not a request waiting on an answer, and a
	 * tooltip that had to await a round trip would arrive after the pointer
	 * had moved on. The page still owns *when* — at once, now — and the one
	 * tooltip for the whole tree — because only it can see the pointer in this
	 * view. It no longer owns the leave: see `releaseTooltip`.
	 */
	showTooltip(request: TooltipRequestWire): void;
	/**
	 * Take the tooltip down at once. Something moved out from under it.
	 *
	 * A scroll, a resize, the window losing focus, the keyboard leaving the
	 * row: in every one of these the row the sentence is about is gone or
	 * unreachable, and there is nothing to wait to find out.
	 */
	hideTooltip(): void;
	/**
	 * The pointer left the row. **A request, not an order.**
	 *
	 * The tooltip is a different view from this one, so a pointer travelling
	 * from the row into the box leaves this view — and this page cannot tell
	 * that from a pointer leaving for the editor. Only main sees both views, so
	 * only main can decide: it holds the tooltip for a short grace and takes it
	 * down unless the tooltip page says the pointer arrived there. See
	 * `main/shell/tooltipView.ts`.
	 */
	releaseTooltip(): void;
}

/** Text and its HTML rendering, for `writeClipboardRich`. */
export interface RichClipboardWire {
	readonly text: string;
	readonly html: string;
}

/** A deck to print to PDF (`AgentsBridge.saveSlidesPdf`). */
export interface SlidesPdfRequestWire {
	/** A whole HTML document: the slides, one a page, and their CSS. */
	readonly html: string;
	/** A slide's size in CSS pixels, which is the page's. */
	readonly width: number;
	readonly height: number;
	/** The file name the dialog suggests, without `.pdf`. */
	readonly name: string;
}

/** Slides rasterised by the page (`AgentsBridge.saveSlideImages`). */
export interface SlideImagesRequestWire {
	readonly images: readonly Uint8Array[];
	/** The file name the dialog suggests, without `.png`. */
	readonly name: string;
}

/**
 * What a `devhub:` link (`model/devhubLink.ts`) asks of main that the
 * snapshot cannot answer. Every other kind goes through `dispatch`
 * (`select_context`, `reason: "explicit"`).
 */
export interface DevhubLinksBridge {
	/**
	 * Open `path` in the workbench of `workspaceId`, the open Workspace whose
	 * folder holds it, at `range` — as an explicit move (Back and Forward).
	 * Rejects, with the reason, when the file is gone or not in it.
	 */
	openLinkedFile(
		workspaceId: string,
		path: string,
		range: FileRange | undefined,
	): Promise<void>;
	/** The open Agent running `session` (an id or a 4+ prefix), or `null`. */
	devhubSessionAgent(session: string): Promise<string | null>;
}

/** Every Agent, in one view — `agents.html`. */
export interface AgentsBridge
	extends PageBridge,
		DevhubLinksBridge,
		ProjectionBridge,
		AppearanceBridge,
		RepositoryStatusBridge,
		AgentActionsBridge,
		OrchestratorBoardBridge,
		OrchestratorActionsBridge,
		OrchestratorFilesBridge,
		EscalationEmbedsBridge {
	/** Put a modal on screen — an injection to review. */
	openModal(request: ModalRequest): Promise<string>;
	/**
	 * Something opened large over the page (`agentsOverlay`), so main stacks
	 * this view above the conversation beside the board while it is open.
	 */
	previewLayout(preview: LayoutPreviewWire): Promise<void>;
	openExternalUrl(url: string): Promise<void>;
	/**
	 * Put text on the Mac's clipboard.
	 *
	 * A terminal surface's OSC 52 writes come through here rather than through
	 * `navigator.clipboard`: the browser API is gated on the document being
	 * focused, and the write arrives from tmux at a moment nobody chose
	 * (`ControlToPage` `clipboard`).
	 */
	writeClipboard(text: string): Promise<void>;
	/**
	 * Put a picture on the Mac's clipboard: a diagram of a GUI Agent's answer,
	 * rasterised by the page (`shell/conversation/diagramCopy.ts`). PNG bytes;
	 * main refuses anything that is not one. Main's clipboard for the same
	 * reason as `writeClipboard`: the page's is gated on focus.
	 */
	writeClipboardImage(png: Uint8Array): Promise<void>;
	/**
	 * Put text on the clipboard with an HTML rendering of it beside: a
	 * Markdown preview's copy, which pastes as its source into an editor and
	 * formatted into a document.
	 */
	writeClipboardRich(content: RichClipboardWire): Promise<void>;
	/**
	 * Save a Marp deck of a GUI Agent's answer as a PDF: main asks where, with
	 * a save dialog, and prints `html` — the deck's own markup, one slide a
	 * page — from a hidden window that runs no script and loads nothing
	 * (`main/shell/slideExport.ts`). Resolves to the path written, or
	 * `undefined` when the dialog was cancelled.
	 */
	saveSlidesPdf(request: SlidesPdfRequestWire): Promise<string | undefined>;
	/**
	 * Save slides as PNGs the page has rasterised: one file for one slide,
	 * `<name>-01.png`, `<name>-02.png`… beside the name chosen for several.
	 * Resolves to the paths written, or `[]` when the dialog was cancelled.
	 */
	saveSlideImages(request: SlideImagesRequestWire): Promise<readonly string[]>;
	/**
	 * Put a context menu up over the window, as a native menu — a right-click
	 * on a diagram in a GUI Agent's answer. Resolves to the id chosen, or
	 * `undefined`; the page runs it. `at` is in this page's coordinates.
	 */
	showContextMenu(request: ContextMenuRequestWire): Promise<string | undefined>;
	/**
	 * The Surface runtime.
	 *
	 * There is one, and there used to be two. An Agent had its own namespace
	 * because it had its own provider, its own framing and its own idea of a
	 * screen; now an Agent is a tmux session like any other, so `agent:<uuid>`
	 * is simply another surface key this API answers about, alongside
	 * `workspace-terminal:<uuid>`. What the key names is
	 * the resolver's business, not the page's.
	 */
	readonly terminal: DevhubTerminalApi;
	/**
	 * The GUI Agents' conversations. On this page only: it is the page that
	 * draws them, and a second page able to attach would be a second reader
	 * main sends every event to. See `ipc/conversation.ts`.
	 */
	readonly conversation: ConversationApi;
	/**
	 * Dictation into a GUI Agent's composer: the microphone permission, and
	 * the bundled recogniser that turns a recording into words on this Mac.
	 * See `ipc/voice.ts`.
	 */
	readonly voice: VoiceApi;
}

/**
 * What a terminal surface needs from whatever page it is mounted on: the
 * transport, and the two things a PTY can ask of the Mac — a link opened, a
 * copy put on the clipboard. Both the Agents and every terminal pane draw
 * terminals, so this is the fragment the surface reads (`shell/terminal`),
 * and neither page's own bridge has to be reachable from the other's.
 */
export interface TerminalSurfaceBridge {
	openExternalUrl(url: string): Promise<void>;
	writeClipboard(text: string): Promise<void>;
	readonly terminal: DevhubTerminalApi;
}

/**
 * One terminal pane — `pane.html`, one view per Agent terminal, the
 * terminal named by the page's fragment (`pane.html#<id>`), and with
 * `general.editor = "neovim"` one per Workspace whose editor area it is
 * (`pane.html#ws:<workspace id>`, its `ws-` session).
 *
 * The page is a terminal surface on that session and nothing else: no header,
 * no buttons. It reads the projection for its name and the appearance
 * for its font, like the Agents page, and asks nothing of its own; closing is
 * main's (`Cmd+Q X`, the shell exiting, `--tell terminal close`).
 */
export interface PaneBridge
	extends PageBridge,
		ProjectionBridge,
		AppearanceBridge,
		TerminalSurfaceBridge {
	/**
	 * What the terminal's panes are — the shown window's, which is active,
	 * every pane's mode and `@devhub-nvim` — for the Neovims drawn over them;
	 * `null` once the surface goes (`main/editor/terminalNeovims.ts`, "Where
	 * an overlay goes"). Where a pane is drawn is the page's own business.
	 */
	reportTerminalPanes(
		terminalId: string,
		panes: TerminalPanesWire | null,
	): void;
	/**
	 * The Neovims drawn over the terminal's panes, and which has the keys:
	 * as it stands, then each change (`TerminalNeovimsWire`).
	 */
	onTerminalNeovims(
		terminalId: string,
		listener: (neovims: TerminalNeovimsWire) => void,
	): () => void;
	/**
	 * A keystroke main took on its way into this page, to be typed where it
	 * belongs: into an overlay's Neovim that takes the keys with it, or the
	 * terminal (tmux's prefix, typed in a Neovim).
	 */
	onTerminalNeovimKey(
		listener: (key: TerminalNeovimKeyWire) => void,
	): () => void;
	/**
	 * Keys main handed this page for its terminal (tmux's prefix typed in a
	 * Neovim, and the key after it) that its terminal surface could not
	 * type: none was there, or it was not attached. As tmux names them; main
	 * sends them through DevHub's control client on the session, or says
	 * they were lost and gives the keys back to the Neovim.
	 */
	reportUntypedTerminalKeys(terminalId: string, keys: readonly string[]): void;
	/**
	 * A press in the page: into an overlay's Neovim (its key), or into the
	 * terminal beside it (`null`). The keys go where the person put them.
	 */
	reportNeovimPointer(terminalId: string, key: string | null): void;
	/** The UIs of the Neovims drawn over this terminal's panes. */
	readonly neovim: DevhubNeovimApi;
}

/**
 * `PaneBridge.onTerminalNeovims`: every Neovim DevHub draws over one of the
 * terminal's panes (`main/editor/terminalNeovims.ts`). The page draws each
 * in its pane, among the panes' own layers (docs/rendering-layers.md).
 */
export interface TerminalNeovimsWire {
	readonly overlays: readonly TerminalNeovimWire[];
	/** The overlay whose Neovim has the terminal's keys; absent: the terminal's. */
	readonly keys?: string;
}

export interface TerminalNeovimWire {
	/** The id its UI attaches as (`tnv:<n>`). */
	readonly key: string;
	/** Its tmux pane's number (`%N`'s N). */
	readonly pane: number;
	/** tmux shows the pane: its window, not a zoomed sibling, not in a mode. */
	readonly shown: boolean;
}

/** `PaneBridge.onTerminalNeovimKey`: a keystroke as `before-input-event` had it. */
export interface TerminalNeovimKeyWire {
	/** The overlay's key, or `""`: the terminal. */
	readonly to: string;
	readonly key: string;
	readonly code: string;
	readonly control: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	readonly meta: boolean;
	/** The left Option is held (`mac_option_is_meta = "left"`). */
	readonly leftOption: boolean;
}

/** `PaneBridge.reportTerminalPanes`. */
export interface TerminalPanesWire {
	readonly client: string;
	readonly prefixes: readonly string[];
	/** The shown window's panes (a zoomed pane alone). */
	readonly shown: readonly {
		readonly pane: number;
		readonly active: boolean;
	}[];
	readonly panes: readonly {
		readonly pane: number;
		readonly inMode: boolean;
		readonly socket: string;
	}[];
	/**
	 * Something DevHub draws over the panes is open (a popup, a prompt, a
	 * menu, the chooser, `display-panes`): it has the keys.
	 */
	readonly covered: boolean;
}

/** `general.notice_seconds`, the one setting the notices page reads. */
export interface NoticeSettingsWire {
	/** `0` never hides a toast by itself. */
	readonly hideAfterSeconds: number;
}

/** The page DevHub speaks from — `toasts.html`. No model, by design. */
export interface ToastsBridge extends PageBridge {
	/** Failures that happen between requests, such as a startup mount. */
	onNativeError(listener: (error: AppError) => void): () => void;
	/** Standing facts, raised and retracted by the source that watches them. */
	onAppCondition(listener: (condition: AppConditionWire) => void): () => void;
	/** The person started another action; see `actionStarted` in `CHANNELS`. */
	onActionStarted(listener: () => void): () => void;
	/**
	 * `dismiss_alert` and `show_notifications`: the notices are here, so the
	 * chords are delivered here.
	 */
	onMenuCommand(listener: (command: MenuCommand) => void): () => void;
	/** How long a toast stays up; pushed on listening and on every config. */
	onNoticeSettings(
		listener: (settings: NoticeSettingsWire) => void,
	): () => void;
	/** The notice center closed from the keyboard: keys back to the surface. */
	focusSurface(): Promise<void>;
	/**
	 * Tell main a notice has left the screen, and by which rule.
	 *
	 * Main publishes every app-scoped notice and would otherwise never learn
	 * that one came down: two of the three rules that retire a notice are
	 * gestures in the page — the person dismissing it, and the person starting
	 * another action — and the third is main's own retraction. A log that saw
	 * only the raises could not tell a notice that stood for a minute from one
	 * that blinked, which is the whole question a flicker report asks.
	 *
	 * It reports and nothing more: nothing in main acts on it, and a page that
	 * cannot reach main loses a log line rather than a notice.
	 */
	reportNoticeRetired(retired: NoticeRetiredWire): Promise<void>;
	/**
	 * Put a notice's words on the clipboard — Cmd+C on a notice. Main's
	 * clipboard rather than the page's, which refuses a write from a view
	 * that does not have the focus.
	 */
	writeClipboard(text: string): Promise<void>;
	/**
	 * How much room the notices this page is drawing take up.
	 *
	 * This page's whole geometry protocol with the window, and it exists
	 * because a `WebContentsView` is a native view whose hit testing is by
	 * rectangle: every click inside its bounds is its own, whether or not
	 * anything is painted there, and Electron has no per-view way to stand
	 * aside. So the view is exactly as big as the notices, and this is the page
	 * saying how big that is. Nothing to say is a size of zero, which takes the
	 * view out of the window entirely.
	 *
	 * One way, like `raiseFailure` and for a weaker version of the same reason:
	 * a measurement is a fact the page has, not a request it is waiting on.
	 */
	reportToastsSize(size: {
		readonly width: number;
		readonly height: number;
	}): void;
	/**
	 * "Try Again", pressed on a notice.
	 *
	 * The notices are drawn on a page of their own, and what an app-scoped
	 * failure's retry means — start the App Shell page's projection over — is
	 * something only another page can do. So it is routed: this reaches main,
	 * and main asks the page that owns the projection. Every other way of
	 * doing it would be a second page reaching into the first.
	 */
	retryApp(): void;
	openSettings(): Promise<void>;
	/** "Open Microphone Settings" on a refused dictation: System Settings → Privacy & Security → Microphone. */
	openMicrophoneSettings(): Promise<void>;
	/**
	 * The page is listening for notices.
	 *
	 * Sent once, after its listeners are in place. What went wrong before any
	 * page existed is held in main until this: a notice sent a moment earlier
	 * reaches a page with no listener and is gone. It is this page's to say
	 * because it is this page that draws them — another page asking for the
	 * snapshot says nothing about whether this one is ready, and every page
	 * in the window starts at the same moment.
	 */
	reportListening(): void;
}

/**
 * The one box a tooltip is drawn in — `tooltip.html`.
 *
 * The smallest bridge DevHub has, smaller than the notices': a tooltip is a
 * sentence somebody else composed, and this page only draws it and says how
 * big it came out.
 *
 * **What is deliberately not here is the anchor.** The Sidebar sends it
 * (`TooltipRequestWire`) and main keeps it: it is the input to
 * `windowLayout.ts`, which turns it into a rectangle this page never sees.
 * Putting it on this bridge would be a member whose page has no use for it —
 * the shape `onModals` had on four bridges that could never receive it, and
 * the exact thing the per-page contract exists to make unspellable.
 */
export interface TooltipBridge extends PageBridge {
	/** The sentence to draw, or nothing at all to draw none. */
	onTooltip(
		listener: (tooltip: TooltipContentWire | undefined) => void,
	): () => void;
	/**
	 * How big the box came out.
	 *
	 * This page's whole geometry protocol with the window, and it exists
	 * because a `WebContentsView` is a native view whose hit testing is by
	 * rectangle: every click inside its bounds is its own, whether or not
	 * anything is painted there. So the view is exactly as big as the tooltip,
	 * and this is the page saying how big that is. Nothing to say is a size of
	 * zero, which takes the view out of the window entirely.
	 *
	 * One way, like `reportToastsSize`: a measurement is a fact the page has,
	 * not a request it is waiting on.
	 */
	reportTooltipSize(size: {
		readonly width: number;
		readonly height: number;
	}): void;
	/**
	 * Whether the pointer is in the box right now.
	 *
	 * The other half of the arbitration the Sidebar's `releaseTooltip` begins.
	 * The row and the box are different views, so the pointer crossing from one
	 * to the other is a leave in one document and an enter in the other, with
	 * nothing in either page able to join them. Main joins them: it holds a
	 * released tooltip for a grace, `true` within that grace keeps it up, and
	 * `false` takes it down at once.
	 *
	 * One way, like the measurement beside it: where the pointer is, is a fact
	 * this page has, not a request it is waiting on.
	 */
	reportTooltipPointer(inside: boolean): void;
	/**
	 * Follow one of the box's links.
	 *
	 * A tooltip line that names a page on GitHub (`TooltipFactLineWire.href`)
	 * is drawn as a link, and a click on it goes to the person's browser. It is
	 * not left to the navigation backstop in `externalLinks.ts`: that one
	 * catches what a page did not mean to do, and a refusal disappearing into
	 * it is a click that reports nothing.
	 */
	openExternalUrl(url: string): Promise<void>;
	/**
	 * Put a path on the clipboard: the box's copy buttons, beside a row's
	 * folder and the checkout a worktree was cut from. Through main, the way
	 * every copy DevHub makes is, since this view never holds focus.
	 */
	writeClipboard(text: string): Promise<void>;
}

/** Everything DevHub stops to ask — `picker.html`. */
export interface PickerBridge
	extends PageBridge,
		ProjectionBridge,
		AppearanceBridge,
		AgentProfilesBridge,
		AgentActionsBridge,
		WorkspaceOpeningBridge {
	/**
	 * The modals that are open, newest last.
	 *
	 * On this bridge and on no other. Main sends `devhub:modals-changed` to
	 * this view directly rather than through `send()`, so the member's absence
	 * elsewhere is not a restriction — it is the truth about which page can
	 * ever hear it.
	 */
	onModals(listener: (modals: readonly OpenModal[]) => void): () => void;
	/**
	 * Take one modal off screen.
	 *
	 * `response` is the button a workbench's own question was answered with;
	 * every other modal has nothing to answer and passes nothing.
	 */
	closeModal(id: string, response?: number | string): Promise<void>;
	/**
	 * The wording, as the person settled on it. Nothing is sent by this call.
	 *
	 * Confirming only removes the reason the queue was refusing to send; the
	 * idle gate is untouched and still decides the instant. See
	 * `main/agent/injection.ts`.
	 */
	confirmInjection(
		agentId: string,
		injectionId: string,
		text: string,
	): Promise<AppOutcome>;
	/** Drop the intent without sending it. The agent keeps running. */
	cancelInjection(agentId: string, injectionId: string): Promise<AppOutcome>;
	/**
	 * Answer the three-way question about a worktree main is closing.
	 *
	 * The page answers a question main asked; it does not decide `--force`.
	 * This used to be `removeWorktree(workspaceId, force)` — a destructive verb
	 * of its own, with the renderer choosing the flag — beside a raw
	 * `request_close_workspace` for the other answer, so one question was
	 * carried out down two paths and only one of them went through the close
	 * rule. `cancel` is the third answer and is the sheet's own dismissal, so
	 * it is not sent.
	 */
	answerWorktreeClose(
		workspaceId: string,
		answer: "close" | "delete",
	): Promise<AppOutcome>;
	/**
	 * Stop the lookup a question is waiting for, and kill what it started.
	 *
	 * Any of them — which clones a repository has, which folders a clone could
	 * go into — because they are the same kind of thing and main bounds them all
	 * the same way. It is named for the picker rather than for any one of them
	 * so that the next question with something slow behind it does not arrive
	 * with a second way to say stop.
	 *
	 * On this bridge and on no other, because the picker is the only page that
	 * can start one: a lookup begins when a question is asked and there is never
	 * a second one in flight, so it needs no identifier — "the one that is
	 * running" is the whole of what there is to name.
	 *
	 * This exists because a deadline alone is not an answer to Escape. Main
	 * already bounds the lookup, so nothing runs forever either way; what this
	 * adds is that the `gh` or `git` child dies *when the person stops waiting*
	 * rather than up to twenty seconds later, which is the difference between a
	 * sheet that has let go and one that is still quietly holding on.
	 *
	 * Asking again is how "typing a new query" cancels the old lookup — main
	 * cancels whatever is in flight when a new lookup arrives — so the page only
	 * has to say this for the case where no new question follows.
	 */
	cancelPickerLookup(): Promise<void>;
	/**
	 * Theme: Preview…'s cursor is on this theme now: wear it, for the moment.
	 * Only while that sheet is open; main ignores it otherwise.
	 */
	previewColorTheme(name: string): Promise<void>;
	/**
	 * The earlier sessions of a profile's CLI that ran in `place`, newest
	 * first, read on its machine: the past-session rows of the agent picker.
	 * Throws the reason (`sessions_unreadable`, or the profile's own refusal)
	 * when they cannot be listed.
	 */
	listAgentSessions(
		place: WorkspacePlaceWire,
		profileId: string,
	): Promise<readonly PastSessionWire[]>;
	/** The last exchanges of one listed session, read on demand. */
	previewAgentSession(
		place: WorkspacePlaceWire,
		profileId: string,
		session: string,
		cwd: string,
	): Promise<readonly SessionPreviewLineWire[]>;
	/**
	 * Resume a listed session that ran in another worktree of the place's
	 * repository, in that worktree: its Workspace opened or focused (the
	 * worktree made again on its branch when it is gone) and an Agent of the
	 * profile started there on the session.
	 */
	resumeSessionElsewhere(request: ResumeElsewhereWire): Promise<AppOutcome>;
}

/** An earlier session to go on with in the worktree it ran in. */
export interface ResumeElsewhereWire {
	/** The folder the list was read for, on its machine: the repository, and the machine. */
	readonly place: WorkspacePlaceWire;
	readonly profileId: string;
	readonly session: string;
	readonly worktree: SessionWorktreeWire;
	/** Where the CLI said it ran. */
	readonly cwd?: string;
	readonly presentation?: AgentPresentationWire;
	/** Beside the editor. */
	readonly split?: boolean;
}

/** The branches the workspace picker offers, and the repository they are of. */
export interface BranchListWire {
	/** The folder git was asked in, on its machine: where a worktree is made from. */
	readonly place: WorkspacePlaceWire;
	/** The repository's name, for the rows to say whose branches they are. */
	readonly repository: string;
	/** Newest commit first. */
	readonly branches: readonly BranchWire[];
}

export interface BranchWire {
	readonly name: string;
	/** The remote it is only on, when there is no local branch of the name yet. */
	readonly remote?: string;
	/** Its tip's commit time, in ms since the epoch. */
	readonly committedAt: number;
	/** The folder it is checked out in, when it is. */
	readonly worktree?: string;
	/** That folder is open as a Workspace now. */
	readonly open: boolean;
}

/** Which earlier sessions a picker lists: the Workspace's directory's, or every directory's. */
export type SessionScopeWire = "here" | "everywhere";

/** One earlier session of an Agent's CLI, as the resume picker and the agent picker list it. */
export interface PastSessionWire {
	/**
	 * What resuming it hands the CLI — `/resume`, or a launch's `resume`:
	 * Claude's session id, Codex's thread id.
	 */
	readonly id: string;
	readonly title: string;
	/** When it last changed, in ms since the epoch, when the CLI says. */
	readonly updatedAt?: number;
	/** The directory it ran in, when the CLI says. */
	readonly cwd?: string;
	/** The git branch it was last on, when the CLI recorded one. */
	readonly branch?: string;
	/**
	 * Whether an Agent in the Workspace can go on with it. Claude resumes a
	 * session only in the directory it ran in; the picker shows another
	 * directory's and says so rather than offering it.
	 */
	readonly resumableHere: boolean;
	/**
	 * It ran in another worktree of the Workspace's repository, on another
	 * branch: which one. Choosing it resumes it there — that worktree's
	 * Workspace, opened or focused, or the worktree made again when it is
	 * gone — rather than in the Workspace the list was asked for.
	 */
	readonly worktree?: SessionWorktreeWire;
	/** The name a person gave the Agent that ran it, when one did. */
	readonly agentName?: string;
}

/** The worktree an earlier session ran in, when it is not the Workspace's own. */
export interface SessionWorktreeWire {
	/** The worktree's folder: where it is, or was. */
	readonly root: string;
	/** The branch checked out there, or the one the CLI last recorded. */
	readonly branch?: string;
	/** The folder is still a worktree of the repository. */
	readonly present: boolean;
}

/** One message of a session's last exchanges, as the resume picker previews it. */
export interface SessionPreviewLineWire {
	readonly role: "person" | "agent";
	readonly text: string;
}

/**
 * The Settings window's failure contract — `settings.html`.
 *
 * Everything Settings *does* is on `window.devhubSettings` (`ipc/settings.ts`).
 * This is the other half every page has: what began here is told to main, and
 * what main tells back is drawn here rather than on the shell window's
 * notices, because a report about the window the person is looking at, drawn
 * on a window they are not, is a report nobody reads. See
 * `main/shell/publishAudience.ts`.
 */
export interface SettingsPageBridge extends PageBridge {
	onNativeError(listener: (error: AppError) => void): () => void;
}

/**
 * The Task Manager window's failure contract — `task-manager.html`.
 *
 * What it *does* is on `window.devhubTaskManager` (`ipc/taskManager.ts`);
 * this is what every page has, with a failure that began there drawn there,
 * as Settings does.
 */
export interface TaskManagerPageBridge extends PageBridge {
	onNativeError(listener: (error: AppError) => void): () => void;
}

/**
 * Channel names, for every page there is.
 *
 * Requests are `invoke`/`handle`, except the eight that answer nothing and
 * cannot (`raiseFailure`, `toastsSize`, `retryApp`, `showTooltip`,
 * `hideTooltip`, `releaseTooltip`, `tooltipSize`, `tooltipPointer`); the rest
 * are pushes. No
 * page reaches all of them — which page may spell which is decided by the
 * preload it was loaded with, and stated by the bridge interfaces above.
 */
export const CHANNELS = {
	getSnapshot: "devhub:get-snapshot",
	getAppearance: "devhub:get-appearance",
	getWindowTitle: "devhub:get-window-title",
	/** The workbench's rectangle as it is now: what `workbenchAreaChanged` last said. */
	getWorkbenchArea: "devhub:get-workbench-area",
	/** The Sidebar's rectangle as it is now: what `sidebarAreaChanged` last said. */
	getSidebarArea: "devhub:get-sidebar-area",
	getAgentProfiles: "devhub:get-agent-profiles",
	dispatch: "devhub:dispatch",
	replay: "devhub:replay",
	chooseWorkspaceFolder: "devhub:choose-workspace-folder",
	/** Every standing editor placeholder, said again to the page that asks. */
	startWorkspacePicker: "devhub:start-workspace-picker",
	cancelWorkspacePicker: "devhub:cancel-workspace-picker",
	selectWorkspacePicker: "devhub:select-workspace-picker",
	createProject: "devhub:create-project",
	findIssueRepositories: "devhub:find-issue-repositories",
	cancelPickerLookup: "devhub:cancel-picker-lookup",
	previewColorTheme: "devhub:preview-color-theme",
	listAgentSessions: "devhub:list-agent-sessions",
	resumeSessionElsewhere: "devhub:resume-session-elsewhere",
	listSelectionBranches: "devhub:list-selection-branches",
	openBranchWorkspace: "devhub:open-branch-workspace",
	previewAgentSession: "devhub:preview-agent-session",
	cloneRepository: "devhub:clone-repository",
	listBranches: "devhub:list-branches",
	prepareIssueFolder: "devhub:prepare-issue-folder",
	assignIssue: "devhub:assign-issue",
	getRepositoryStatus: "devhub:get-repository-status",
	getUsageLimits: "devhub:get-usage-limits",
	getOrchestratorBoard: "devhub:get-orchestrator-board",
	answerEscalation: "devhub:answer-escalation",
	startOrchestrator: "devhub:start-orchestrator",
	setOrchestratorMode: "devhub:set-orchestrator-mode",
	sendOrchestratorRequest: "devhub:send-orchestrator-request",
	openOrchestratorRequest: "devhub:open-orchestrator-request",
	reportOrchestratorView: "devhub:report-orchestrator-view",
	listOrchestratorFolder: "devhub:list-orchestrator-folder",
	readOrchestratorFile: "devhub:read-orchestrator-file",
	openOrchestratorFile: "devhub:open-orchestrator-file",
	openLinkedFile: "devhub:open-linked-file",
	devhubSessionAgent: "devhub:devhub-session-agent",
	resolveEscalationPaths: "devhub:resolve-escalation-paths",
	readEscalationEmbed: "devhub:read-escalation-embed",
	escalationEmbedSignature: "devhub:escalation-embed-signature",
	cloneProject: "devhub:clone-project",
	projectDefaultDirectory: "devhub:project-default-directory",
	listSshHosts: "devhub:list-ssh-hosts",
	openSshWorkspace: "devhub:open-ssh-workspace",
	continueAgent: "devhub:continue-agent",
	cloneParentDirectories: "devhub:clone-parent-directories",
	githubLogin: "devhub:github-login",
	assignmentBranch: "devhub:assignment-branch",
	fetchForAssignment: "devhub:fetch-for-assignment",
	answerWorktreeClose: "devhub:answer-worktree-close",
	closeWorkspace: "devhub:close-workspace",
	runAgentAction: "devhub:run-agent-action",
	confirmInjection: "devhub:confirm-injection",
	cancelInjection: "devhub:cancel-injection",
	agentActions: "devhub:agent-actions",
	openSettings: "devhub:open-settings",
	openMicrophoneSettings: "devhub:open-microphone-settings",
	openExternalUrl: "devhub:open-external-url",
	reportTerminalPanes: "devhub:report-terminal-panes",
	terminalNeovims: "devhub:terminal-neovims",
	askTerminalNeovims: "devhub:ask-terminal-neovims",
	terminalNeovimKey: "devhub:terminal-neovim-key",
	reportUntypedTerminalKeys: "devhub:report-untyped-terminal-keys",
	reportNeovimPointer: "devhub:report-neovim-pointer",
	writeClipboard: "devhub:write-clipboard",
	writeClipboardImage: "devhub:write-clipboard-image",
	writeClipboardRich: "devhub:write-clipboard-rich",
	saveSlidesPdf: "devhub:save-slides-pdf",
	saveSlideImages: "devhub:save-slide-images",
	previewLayout: "devhub:preview-layout",
	focusSurface: "devhub:focus-surface",

	snapshotChanged: "devhub:snapshot-changed",
	/** Where main has put the workbench, so the page leaves that hole. */
	workbenchAreaChanged: "devhub:workbench-area-changed",
	appearanceChanged: "devhub:appearance-changed",
	/** The Workbench changed colour theme, so DevHub's chrome changes with it. */
	themeChanged: "devhub:theme-changed",
	/** The window's name moved, and DevHub's own title bar letters it. */
	windowTitleChanged: "devhub:window-title-changed",
	agentProfilesChanged: "devhub:agent-profiles-changed",
	/**
	 * The actions changed, because the configuration they live in did.
	 *
	 * Pushed for the same reason the profiles are: a page that read them once
	 * would go on offering yesterday's buttons after somebody edited their
	 * wording in Settings, with nothing on screen to say the row was stale.
	 */
	agentActionsChanged: "devhub:agent-actions-changed",
	nativeError: "devhub:native-error",
	/** A standing condition going up, or the source taking it down again. */
	appCondition: "devhub:app-condition",
	/**
	 * The person asked DevHub for something.
	 *
	 * One of the three things that retire a failure: they have moved on, and a
	 * report about the last thing is in the way of the next. The page that
	 * draws notices cannot see a dispatch — it has no model and does not want
	 * one — so main, which sees every dispatch a page makes, says so.
	 */
	actionStarted: "devhub:action-started",
	/** A page handing main a failure it has no place to draw. */
	raiseFailure: "devhub:raise-failure",
	/** The `toasts` page saying how much room its notices take up. */
	toastsSize: "devhub:toasts-size",
	/** Where main laid the Sidebar, so a row can say where it is in the window. */
	sidebarAreaChanged: "devhub:sidebar-area-changed",
	sidebarPointer: "devhub:sidebar-pointer",
	/** The chord prefix was armed or disarmed: the Sidebar numbers its rows. */
	chordArmedChanged: "devhub:chord-armed-changed",
	/** A row's context menu, put up by main as a native menu. */
	showContextMenu: "devhub:show-context-menu",
	/** The Sidebar asking for a tooltip over the window, about one of its rows. */
	showTooltip: "devhub:show-tooltip",
	/** The Sidebar taking it down again, at once. */
	hideTooltip: "devhub:hide-tooltip",
	/** The pointer left the row: main decides, after a grace. */
	releaseTooltip: "devhub:release-tooltip",
	/** The `tooltip` page saying whether the pointer is in the box. */
	tooltipPointer: "devhub:tooltip-pointer",
	/** The sentence the `tooltip` page is to draw, or nothing to draw none. */
	tooltipText: "devhub:tooltip-text",
	/** The `tooltip` page saying how big the box it drew came out. */
	tooltipSize: "devhub:tooltip-size",
	/**
	 * Main asking a content page to say when it has drawn at the size its
	 * view is about to have (`SettleLayoutWire`); the view waits off the
	 * window until it has (`ShellWindow.staged`).
	 */
	settleLayout: "devhub:settle-layout",
	/** A page saying it has drawn at the size `settleLayout` named. */
	layoutSettled: "devhub:layout-settled",
	/** "Try Again" on a notice, on its way to the page that owns the boot. */
	retryApp: "devhub:retry-app",
	/** A page telling main that a notice has left the screen, and why. */
	noticeRetired: "devhub:notice-retired",
	/** The `toasts` page saying its notice listeners are in place. */
	noticesListening: "devhub:notices-listening",
	/** `general.notice_seconds`, to the `toasts` page. */
	noticeSettings: "devhub:notice-settings",
	workspacePicker: "devhub:workspace-picker",
	/** A menu command the page has to carry out itself, e.g. open the picker. */
	menuCommand: "devhub:menu-command",
	/** Put a modal on screen; answers with the id that closes it. */
	openModal: "devhub:open-modal",
	/** Take a modal off screen, with the answer if it asked for one. */
	closeModal: "devhub:close-modal",
	/** The set of open modals, pushed to the `picker` page whenever it moves. */
	modalsChanged: "devhub:modals-changed",
	/** A workbench died unasked and is being built again in the same slot. */
	/** The branch, Issue and pull request each workspace is working on. */
	repositoryStatusChanged: "devhub:repository-status-changed",
	/** Claude's and Codex's rate limits, when a GUI Agent reports a change. */
	usageLimitsChanged: "devhub:usage-limits-changed",
	/** The Orchestrator board moved: an escalation, the pause. */
	orchestratorBoardChanged: "devhub:orchestrator-board-changed",
	/** Something in the orchestrator's folder was written (debounced). */
	orchestratorFilesChanged: "devhub:orchestrator-files-changed",
} as const;

/**
 * A modal DevHub is showing.
 *
 * Every one of them is drawn by the overlay view — a transparent
 * `WebContentsView` that main puts on top of the window for exactly as long as
 * this list is non-empty. Native views always paint above the App Shell page's
 * DOM, so a modal drawn *by that page* can only be seen if the workbench is
 * taken off screen first; drawing them one layer up instead makes the stacking
 * true rather than reconstructed, and the workbench stays visible underneath.
 *
 * The set lives in main because two different things open modals — the App
 * Shell page, and a workbench asking its own question through Electron — and
 * the answer has to come back to whichever asked.
 */
/** One line of the help overlay: a chord, and what it does. */
export interface ChordHelpRowWire {
	readonly commandId: string;
	readonly label: string;
	/** Every chord that reaches it, written out in full: `Cmd+Q Shift+N`. */
	readonly chords: readonly string[];
	/** What must be selected for it to do anything, in words, or nothing. */
	readonly needs?: string;
}

/** One row of the command palette: a command, by name, and its chords. */
export interface CommandPaletteRowWire {
	readonly commandId: string;
	/** `Category: Label`. */
	readonly title: string;
	/** Every chord that reaches it, written out in full: `Cmd+Q Shift+N`. */
	readonly chords: readonly string[];
	/** Run from the palette lately; such rows lead the list. */
	readonly recent: boolean;
}

/** One row of a quick pick a program asked for (Neovim's `vim.ui.select`). */
export interface QuickPickRowWire {
	readonly label: string;
	/** The second line, dimmer: what the program said about the row. */
	readonly detail?: string;
}

/**
 * A question a program asked DevHub to put to the person in its own quick
 * pick (`docs/native-picker.md`): Neovim's `vim.ui.select` (rows; the answer
 * is the index chosen) or `vim.ui.input` (no rows; the answer is the text).
 */
export interface QuickPickRequestWire {
	/** Who is asking: drawn as the title ("Neovim"). */
	readonly title: string;
	/** The program's prompt, as the question under the title. */
	readonly question: string;
	readonly rows: readonly QuickPickRowWire[];
	/** `vim.ui.input`: a line to type, starting with `default`. */
	readonly input?: { readonly default: string };
}

/** One row of Theme: Preview…: a theme that can be worn. */
export interface ThemePreviewRowWire {
	/** What the settings name it by — what is previewed and chosen. */
	readonly name: string;
	readonly label: string;
	/** `Dark · VS Code`, `Light · DevHub library · publisher.name`. */
	readonly detail: string;
}

/** One row of the Recently Closed picker: what it was, and when it closed. */
export interface RecentlyClosedRowWire {
	/** `Workspace ~/src/app`, `Agent “Reviewer” in ~/src/app`. */
	readonly title: string;
	/** What came with it, and how long ago: `2 Agents · closed 5 min ago`. */
	readonly detail: string;
}

export type ModalRequest =
	| { readonly kind: "workspace-picker" }
	| { readonly kind: "agent-picker"; readonly workspaceId: string }
	| { readonly kind: "issue-assignment" }
	| { readonly kind: "agent-rename"; readonly agentId: string }
	/**
	 * Which of an Agent's configured actions to send it.
	 *
	 * `Cmd+Q Shift+A`'s chooser: every enabled action under every trigger. What happens after
	 * the choice is not this sheet's business: it runs the same
	 * `runAgentAction`, so the wording still goes through the review the action
	 * asks for.
	 */
	| { readonly kind: "agent-actions"; readonly agentId: string }
	/**
	 * Every workspace and Agent, as a list to choose from.
	 *
	 * `Cmd+Q G`. Stepping (`Cmd+N`, `{`, `Shift+N`) is for the neighbour; this
	 * is for the one you can name. It is the ordinary picker, so `Return`
	 * activates and `Option-Return` mounts an Agent beside its workbench — the
	 * same two gestures, meaning the same two things, as in the workspace
	 * picker.
	 */
	| { readonly kind: "tab-picker" }
	/**
	 * Closing a worktree that has something in it to lose.
	 *
	 * Three answers, because there really are three, and a two-button dialog
	 * would have had to pick two of them: keep the folder and just close the
	 * workspace, delete it anyway, or do nothing. Cancel is the default, which
	 * is the rule for every question whose other answers destroy something.
	 *
	 * A *clean* worktree never gets here — it is removed without asking — so the
	 * question is only ever put in front of somebody when the answer is not
	 * obvious.
	 */
	| {
			readonly kind: "worktree-close";
			readonly workspaceId: string;
			/** What the row calls it, so the question names what it is about. */
			readonly label: string;
			/**
			 * The folder that is about to be deleted.
			 *
			 * Two worktrees of one repository are two rows with different labels
			 * and the same everything else, and a label is not enough to check you
			 * are about to destroy the right one.
			 */
			readonly root: string;
			readonly branch?: string;
			/** Nothing when DevHub could not read the working tree at all. */
			readonly dirty?: boolean;
	  }
	| { readonly kind: "chord-help"; readonly rows: readonly ChordHelpRowWire[] }
	/**
	 * Every command, by name — `Cmd+Q :`. The sheet closes with the index of
	 * the row chosen as its response, and main runs that row's command through
	 * the same path its chord takes.
	 */
	| {
			readonly kind: "command-palette";
			readonly rows: readonly CommandPaletteRowWire[];
	  }
	/**
	 * A program's question in the quick pick: Neovim's `vim.ui.select` and
	 * `vim.ui.input`. Closes with the row's index (a select) or the text (an
	 * input) as its response; Escape answers -1.
	 */
	| ({ readonly kind: "quick-pick" } & QuickPickRequestWire)
	/**
	 * What `Cmd+Q Shift+T` would reopen, newest first, as a list to choose
	 * from. Closes with the chosen row's index, as the palette does; main
	 * reopens that entry (`model/recentlyClosed.ts`).
	 */
	| {
			readonly kind: "recently-closed";
			readonly rows: readonly RecentlyClosedRowWire[];
	  }
	/**
	 * Theme: Preview… — every theme that can be worn. The row under the
	 * cursor is worn while it is there (`previewColorTheme`); choosing one
	 * keeps it for the session, closing with its index; Escape puts back what
	 * was worn before. Nothing is written to the settings.
	 */
	| {
			readonly kind: "theme-preview";
			readonly rows: readonly ThemePreviewRowWire[];
			/** The row of the theme worn when it opened. */
			readonly current: number;
	  }
	| {
			/**
			 * The wording DevHub is about to say, before it says it.
			 *
			 * The agent is already starting behind this sheet — that is the point
			 * of it being a modal and not a step in the flow's picker chain: the
			 * two waits run at once, and whichever finishes second is the one that
			 * decides when the text goes.
			 */
			readonly kind: "injection-review";
			readonly agentId: string;
			/** The intent this sheet is reviewing, in `main/agent/injection.ts`. */
			readonly injectionId: string;
			/** What the action's name is, so the sheet says what is being sent. */
			readonly actionName: string;
			/** The template, rendered. The starting contents of the field. */
			readonly text: string;
	  }
	| {
			readonly kind: "close-confirmation";
			readonly confirmationId: string;
			/**
			 * What is being asked, subject included.
			 *
			 * There used to be an `agentId` beside it, and the page recovered the
			 * identity by sniffing the request it had sent — which cannot work
			 * for a confirmation main raised on its own. The purpose says what it
			 * is about. See `ConfirmationPurposeWire`.
			 */
			readonly purpose: ConfirmationPurposeWire;
	  };

export interface OpenModal {
	readonly id: string;
	readonly request: ModalRequest;
}

/**
 * What the menu bar asks the page to do.
 *
 * Only the commands the page genuinely owns are here. Everything the model
 * owns — selecting an activity, hiding the sidebar, closing a workspace — is
 * dispatched in main as an ordinary intent, because routing it through the
 * page would be a second way to do what there is already one way to do.
 */
export type MenuCommand =
	| "open_workspace_picker"
	/**
	 * Put the keyboard on the Sidebar's selected row.
	 *
	 * Half of one act, and the half main cannot do: main moves the keyboard
	 * into the Sidebar's view, because no page can focus another page, and the
	 * Sidebar's page puts it on the selected row, because no one but that page
	 * knows which row that is.
	 *
	 * There used to be a `focus_agent_pane` beside this, for the other end of
	 * `Cmd+Q Cmd+J`. It is gone: the Agents are a view of their own now, so
	 * "put the keyboard in the Agent's pane" is a focus call in main like every
	 * other one, and there is nothing left for a page to be asked.
	 */
	| "focus_sidebar"
	/**
	 * Put away whichever failure this page is showing.
	 *
	 * The page owns the alert's lifetime (`shell/alertLifetime.ts`), so main can
	 * only ask; a page with nothing on screen answers with nothing, which is
	 * what makes one chord right in every window.
	 */
	| "dismiss_alert"
	/**
	 * Open the notice center, or close it if it is open — `Cmd+Q M`.
	 *
	 * Main has already given this view the keyboard; the page knows whether
	 * the center is open, so it decides which.
	 */
	| "show_notifications"
	/**
	 * Start the projection over — "Try Again" on an app-scoped notice.
	 *
	 * The notices are drawn on a page of their own and the projection is this
	 * page's, so the two ends of one button are in two pages and main is what
	 * joins them. It is a message for the same reason the two focus commands
	 * are: what it acts on is here.
	 */
	| "retry_app";
