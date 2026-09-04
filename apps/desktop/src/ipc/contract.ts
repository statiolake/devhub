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

import type { ShellPalette } from "./palette.js";
import type { DevhubTerminalApi } from "./terminal.js";
import type {
	AgentProfiles,
	AppAppearance,
	AppError,
	AppIntent,
	AppOutcome,
	AppSnapshot,
	ConfirmationPurposeWire,
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
	/** The repository's own directory, and its identity. */
	readonly mainWorktree: string;
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
	 * What fires it. The Issue flow offers every `issue` action as a choice; the
	 * three shortcuts each fire the one action with their own trigger, so the
	 * page reads this to know whether a button has any wording behind it.
	 */
	readonly trigger: AgentActionTriggerWire;
}

export type AgentActionTriggerWire =
	| "issue"
	| "commit"
	| "push"
	| "pull_request";

/** Everything the Issue flow asked, once it has all the answers. */
export interface IssueAssignment {
	readonly issueUrl: string;
	/** The clone to work in. */
	readonly directory: string;
	/**
	 * The branch to make a worktree for. Absent means the person chose to work
	 * in the clone itself, which is a workspace they may already have open.
	 */
	readonly branch?: string;
	readonly profileId: string;
	/**
	 * Which action to start the agent with, from `agent_actions`.
	 *
	 * Absent when there are none configured, which is a person who has decided
	 * DevHub should start the agent and say nothing.
	 */
	readonly actionId?: string;
	/** The agent beside the editor rather than over it — ⌘Return, as ever. */
	readonly split: boolean;
	/**
	 * Start the branch from the `origin` already on disk, the fetch having
	 * failed and the person having been asked and said to go on.
	 *
	 * Absent means no, which is what every first attempt sends: a stale base is
	 * only ever used deliberately.
	 */
	readonly allowStaleBase?: boolean;
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
export type ContentSurfaceWire = "workbench" | "split" | "page";

/** The rectangle, in page CSS pixels, that workbench views must cover. */
export interface ContentRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
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

/** The surface the preload puts on `window.devhub`. */
export interface DevhubApi {
	getSnapshot(): Promise<AppSnapshot>;
	getAppearance(): Promise<AppAppearance>;
	/**
	 * The colours of the Workbench's theme, which DevHub's chrome wears too.
	 *
	 * Separate from `getAppearance`, and not folded into it, because it has a
	 * different source: appearance is what the person wrote in `config.toml`,
	 * and this is what the Workbench is wearing. A config that will not parse
	 * must not take the window's colours down with it.
	 *
	 * `null` means this profile has never run a workbench, so there is no theme
	 * to follow and the tokens keep their own light/dark defaults.
	 */
	getTheme(): Promise<ShellPalette | null>;
	getAgentProfiles(): Promise<AgentProfiles>;
	dispatch(intent: AppIntent): Promise<AppOutcome>;
	replay(cursor: number): Promise<ReplayWire>;

	onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
	onAppearance(listener: (appearance: AppAppearance) => void): () => void;
	onTheme(listener: (palette: ShellPalette) => void): () => void;
	onAgentProfiles(listener: (profiles: AgentProfiles) => void): () => void;
	onAgentActions(
		listener: (actions: readonly AgentActionWire[]) => void,
	): () => void;
	/** Failures that happen between requests, such as a startup mount. */
	onNativeError(listener: (error: AppError) => void): () => void;
	onMenuCommand(listener: (command: MenuCommand) => void): () => void;
	onEditorRestarting(
		listener: (event: EditorRestartingWire) => void,
	): () => void;
	/** What each workspace is working on, re-read on its own clock. */
	getRepositoryStatus(): Promise<RepositoryStatusWire>;
	onRepositoryStatus(
		listener: (status: RepositoryStatusWire) => void,
	): () => void;

	/**
	 * Put a modal on screen. Resolves to the id that closes it again.
	 *
	 * The page never draws a modal itself: main owns the set that is open, and
	 * the overlay view draws it. That is what makes stacking a fact about the
	 * window rather than something each page has to reconstruct.
	 */
	openModal(request: ModalRequest): Promise<string>;
	/**
	 * Take one modal off screen.
	 *
	 * `response` is the button a workbench's own question was answered with;
	 * every other modal has nothing to answer and passes nothing.
	 */
	closeModal(id: string, response?: number): Promise<void>;
	/** The modals that are open, newest last. The overlay page draws these. */
	onModals(listener: (modals: readonly OpenModal[]) => void): () => void;

	/** Opens the native folder picker; resolves to the pick, or nothing. */
	chooseWorkspaceFolder(): Promise<string | undefined>;
	startWorkspacePicker(query: string): Promise<string>;
	cancelWorkspacePicker(): Promise<void>;
	selectWorkspacePicker(
		path: string,
		create: boolean,
		withAgent?: string,
	): Promise<AppOutcome>;
	onWorkspacePicker(
		listener: (event: WorkspacePickerEvent) => void,
	): () => void;

	/**
	 * The two ways a workspace can start that are not "find one that exists".
	 *
	 * Both make a directory and then open it, in one call, because they are one
	 * act: a folder created and not opened is litter, and a page that had to ask
	 * for the second half could fail between them. A failure — the folder is
	 * there already, git could not reach the URL — is thrown with what to do
	 * about it, and the sheet that asked shows it and stays open.
	 */
	createProject(path: string, withAgent?: string): Promise<AppOutcome>;
	cloneProject(
		url: string,
		parentDirectory: string,
		withAgent?: string,
	): Promise<AppOutcome>;
	/** Where a new project goes unless the person says otherwise. */
	projectDefaultDirectory(): Promise<string>;

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
	 * Remove a worktree's folder and close its workspace.
	 *
	 * Destructive, and asked about first: the page raises the question, this
	 * carries out the answer.
	 */
	removeWorktree(workspaceId: string, force: boolean): Promise<AppOutcome>;
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
	/**
	 * Say one of the configured actions to a running agent.
	 *
	 * Queued rather than sent, on the same terms as the Issue flow's first
	 * message: the injection waits for a settled idle screen, so a shortcut
	 * pressed while the agent is working lands when the agent is next listening
	 * rather than into the middle of its output.
	 */
	runAgentAction(agentId: string, actionId: string): Promise<AppOutcome>;
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
	/** Clone, and answer with the directory git made. Opens nothing. */
	cloneRepository(url: string, parentDirectory: string): Promise<string>;
	/**
	 * The folders a clone could go into: the parents of everything the workspace
	 * sources find, in the sources' own order. Answers once, with all of them.
	 */
	cloneParentDirectories(): Promise<readonly string[]>;
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
	 * The branch a pull request is asking to merge.
	 *
	 * Asked when somebody assigns a pull request and a worktree is being made
	 * for it: the worktree is that branch, checked out, rather than a new one.
	 * Throws what to do about it — no token, no such pull request — because the
	 * step that asked is the step that shows the reason.
	 */
	pullRequestHeadBranch(url: string): Promise<string>;
	listBranches(directory: string): Promise<readonly string[]>;
	/**
	 * Do what the answers add up to: make the worktree if one was asked for,
	 * open it, write the Issue down against it, and start the agent.
	 */
	assignIssue(request: IssueAssignment): Promise<AppOutcome>;

	/** The ways of starting an agent on an Issue, in the order Settings lists. */
	agentActions(): Promise<readonly AgentActionWire[]>;

	openSettings(): Promise<void>;
	openExternalUrl(url: string): Promise<void>;

	/** Where main must lay the selected workspace's workbench view. */
	setContentRect(rect: ContentRect): Promise<void>;
	/** What the page has put in the content area. */
	setContentSurface(surface: ContentSurfaceWire): Promise<void>;

	/**
	 * The Surface runtime.
	 *
	 * There is one, and there used to be two. An Agent had its own namespace
	 * because it had its own provider, its own framing and its own idea of a
	 * screen; now an Agent is a tmux session like any other, so `agent:<uuid>`
	 * is simply another surface key this API answers about, alongside
	 * `global-terminal` and `workspace-terminal:<uuid>`. What the key names is
	 * the resolver's business, not the page's.
	 */
	readonly terminal: DevhubTerminalApi;
}

/**
 * Channel names. Requests are `invoke`/`handle`; the pushes are the four
 * projections the page mirrors. Main→page traffic carries nothing else.
 */
export const CHANNELS = {
	getSnapshot: "devhub:get-snapshot",
	getAppearance: "devhub:get-appearance",
	getTheme: "devhub:get-theme",
	getAgentProfiles: "devhub:get-agent-profiles",
	dispatch: "devhub:dispatch",
	replay: "devhub:replay",
	chooseWorkspaceFolder: "devhub:choose-workspace-folder",
	startWorkspacePicker: "devhub:start-workspace-picker",
	cancelWorkspacePicker: "devhub:cancel-workspace-picker",
	selectWorkspacePicker: "devhub:select-workspace-picker",
	createProject: "devhub:create-project",
	findIssueRepositories: "devhub:find-issue-repositories",
	cloneRepository: "devhub:clone-repository",
	listBranches: "devhub:list-branches",
	assignIssue: "devhub:assign-issue",
	getRepositoryStatus: "devhub:get-repository-status",
	cloneProject: "devhub:clone-project",
	projectDefaultDirectory: "devhub:project-default-directory",
	cloneParentDirectories: "devhub:clone-parent-directories",
	githubLogin: "devhub:github-login",
	pullRequestHeadBranch: "devhub:pull-request-head-branch",
	removeWorktree: "devhub:remove-worktree",
	closeWorkspace: "devhub:close-workspace",
	runAgentAction: "devhub:run-agent-action",
	confirmInjection: "devhub:confirm-injection",
	cancelInjection: "devhub:cancel-injection",
	agentActions: "devhub:agent-actions",
	openSettings: "devhub:open-settings",
	openExternalUrl: "devhub:open-external-url",
	setContentRect: "devhub:set-content-rect",
	setContentSurface: "devhub:set-content-surface",

	snapshotChanged: "devhub:snapshot-changed",
	appearanceChanged: "devhub:appearance-changed",
	/** The Workbench changed colour theme, so DevHub's chrome changes with it. */
	themeChanged: "devhub:theme-changed",
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
	workspacePicker: "devhub:workspace-picker",
	/** A menu command the page has to carry out itself, e.g. open the picker. */
	menuCommand: "devhub:menu-command",
	/** Put a modal on screen; answers with the id that closes it. */
	openModal: "devhub:open-modal",
	/** Take a modal off screen, with the answer if it asked for one. */
	closeModal: "devhub:close-modal",
	/** The set of open modals, pushed to the overlay page whenever it moves. */
	modalsChanged: "devhub:modals-changed",
	/** A workbench died unasked and is being built again in the same slot. */
	editorRestarting: "devhub:editor-restarting",
	/** The branch, Issue and pull request each workspace is working on. */
	repositoryStatusChanged: "devhub:repository-status-changed",
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

export type ModalRequest =
	| { readonly kind: "workspace-picker" }
	| { readonly kind: "agent-picker"; readonly workspaceId: string }
	| { readonly kind: "issue-assignment" }
	| { readonly kind: "agent-rename"; readonly agentId: string }
	/**
	 * Which of an Agent's configured actions to send it.
	 *
	 * `Cmd+Q Shift+A`'s chooser. The buttons a workspace draws
	 * (`AgentShortcuts`) show only the actions whose condition holds right now;
	 * a person who has armed a chord for this is asking for the whole list, so
	 * this one is every enabled action under every trigger. What happens after
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
	 * activates and `Command-Return` mounts an Agent beside its workbench — the
	 * same two gestures, meaning the same two things, as in the workspace
	 * picker.
	 */
	| { readonly kind: "tab-picker" }
	/**
	 * What to hand this workspace's folder to.
	 *
	 * `Cmd+Q O`. A picker rather than a menu, because every other list of
	 * choices in DevHub is one.
	 */
	| {
			readonly kind: "open-externally";
			readonly workspaceId: string;
			readonly root: string;
	  }
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
			readonly purpose: ConfirmationPurposeWire;
			/**
			 * Which Agent is being stopped.
			 *
			 * A replacement confirmation carries only its token, so the identity
			 * travels with the request rather than being read back out of it.
			 */
			readonly agentId?: string;
	  }
	| WorkbenchDialogRequest;

export interface OpenModal {
	readonly id: string;
	readonly request: ModalRequest;
}

/**
 * A workbench that is coming back.
 *
 * The selection does not move when a workbench dies — the Editor activity
 * stays selected and the workbench is rebuilt in its own slot — so the page
 * has to be able to say *that*, rather than showing an empty pane or claiming
 * a view is on screen that no longer exists.
 */
export interface EditorRestartingWire {
	readonly surfaceKey: string;
	readonly restarting: boolean;
}

/**
 * A question a workbench asked, for the page to draw.
 *
 * VS Code raises these through Electron, which would make them a sheet across
 * DevHub's whole window — a workbench's question presented as if the
 * application were asking it, with everything else frozen behind it. It is one
 * workbench's business, so DevHub draws it over that workbench instead and the
 * rest of the app stays usable while it stands.
 */
export interface WorkbenchDialogRequest {
	readonly kind: "workbench-dialog";
	/**
	 * The editor surface this question belongs to.
	 *
	 * It is drawn inside that workbench's own rectangle and nowhere else: the
	 * question is about one editor, so it is modal to one editor. Everything
	 * outside — the sidebar, the other workspaces, the terminal — stays live,
	 * because main sizes the overlay view to that workbench's rectangle and the
	 * rest of the window is not covered at all.
	 */
	readonly surfaceKey: string;
	readonly message: string;
	readonly detail?: string;
	readonly buttons: readonly string[];
	readonly defaultId: number;
	readonly cancelId: number;
	readonly tone: "none" | "info" | "warning" | "error" | "question";
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
	 * Put the keyboard in the Agent's pane.
	 *
	 * The one thing the selection does not already answer. Side by side, both
	 * halves of a workspace are on screen at once, so `Cmd+Q Cmd+J` moves the
	 * keyboard rather than the selection — and the editor is a native view the
	 * window focuses directly while the Agent's pane is drawn by this page, so
	 * only this half can be a message. See `shell/focusHome.ts`, which is the
	 * page's half of the focus rule and already knows how to find the pane.
	 */
	| "focus_agent_pane";
