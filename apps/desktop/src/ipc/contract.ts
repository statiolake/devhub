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

/** One clone of the repository an Issue lives in. */
export interface IssueClone {
	readonly path: string;
	/** What is checked out there, so two worktrees can be told apart. */
	readonly branch?: string;
	/** The repository itself, rather than one of its worktrees. */
	readonly isMainWorktree: boolean;
}

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
	/** The agent beside the editor rather than over it — ⌘Return, as ever. */
	readonly split: boolean;
}

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
 */
export interface WorkspacePickerCandidate {
	readonly operationId: string;
	readonly sequence: number;
	readonly label: string;
	readonly searchText: string;
	readonly path: string;
	readonly score: number;
}

/** Streamed progress for one picker run. */
export type WorkspacePickerEvent =
	| {
			readonly kind: "started";
			readonly operationId: string;
			readonly sequence: number;
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
	/** Failures that happen between requests, such as a startup mount. */
	onNativeError(listener: (error: AppError) => void): () => void;
	onMenuCommand(listener: (command: MenuCommand) => void): () => void;
	onEditorRestarting(
		listener: (event: EditorRestartingWire) => void,
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
	selectWorkspacePicker(path: string): Promise<AppOutcome>;
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
	createProject(path: string): Promise<AppOutcome>;
	cloneProject(url: string, parentDirectory: string): Promise<AppOutcome>;
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
	findIssueClones(issueUrl: string): Promise<readonly IssueClone[]>;
	/** Clone, and answer with the directory git made. Opens nothing. */
	cloneRepository(url: string, parentDirectory: string): Promise<string>;
	listBranches(directory: string): Promise<readonly string[]>;
	/**
	 * Do what the answers add up to: make the worktree if one was asked for,
	 * open it, write the Issue down against it, and start the agent.
	 */
	assignIssue(request: IssueAssignment): Promise<AppOutcome>;

	openSettings(): Promise<void>;
	openExternalUrl(url: string): Promise<void>;

	/** Where main must lay the selected workspace's workbench view. */
	setContentRect(rect: ContentRect): Promise<void>;
	/** Whether a DOM surface is on screen, so the native view can hide. */
	setSurfaceVisible(visible: boolean): Promise<void>;

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
	findIssueClones: "devhub:find-issue-clones",
	cloneRepository: "devhub:clone-repository",
	listBranches: "devhub:list-branches",
	assignIssue: "devhub:assign-issue",
	cloneProject: "devhub:clone-project",
	projectDefaultDirectory: "devhub:project-default-directory",
	openSettings: "devhub:open-settings",
	openExternalUrl: "devhub:open-external-url",
	setContentRect: "devhub:set-content-rect",
	setSurfaceVisible: "devhub:set-surface-visible",

	snapshotChanged: "devhub:snapshot-changed",
	appearanceChanged: "devhub:appearance-changed",
	/** The Workbench changed colour theme, so DevHub's chrome changes with it. */
	themeChanged: "devhub:theme-changed",
	agentProfilesChanged: "devhub:agent-profiles-changed",
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
export type ModalRequest =
	| { readonly kind: "workspace-picker" }
	| { readonly kind: "agent-picker"; readonly workspaceId: string }
	| { readonly kind: "issue-assignment" }
	| { readonly kind: "agent-rename"; readonly agentId: string }
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
export type MenuCommand = "open_workspace_picker";
