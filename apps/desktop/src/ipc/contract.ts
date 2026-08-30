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

import type { AgentApi } from "./agent.js";
import type { DevhubTerminalApi } from "./terminal.js";
import type {
	AgentProfiles,
	AppAppearance,
	AppError,
	AppIntent,
	AppOutcome,
	AppSnapshot,
	ReplayWire,
} from "./appShell.js";

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
	getAgentProfiles(): Promise<AgentProfiles>;
	dispatch(intent: AppIntent): Promise<AppOutcome>;
	replay(cursor: number): Promise<ReplayWire>;

	onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
	onAppearance(listener: (appearance: AppAppearance) => void): () => void;
	onAgentProfiles(listener: (profiles: AgentProfiles) => void): () => void;
	/** Failures that happen between requests, such as a startup mount. */
	onNativeError(listener: (error: AppError) => void): () => void;
	onMenuCommand(listener: (command: MenuCommand) => void): () => void;
	onWorkbenchDialog(
		listener: (request: WorkbenchDialogRequest) => void,
	): () => void;
	answerWorkbenchDialog(answer: WorkbenchDialogAnswer): Promise<void>;
	setModalOpen(open: boolean): Promise<void>;

	/** Opens the native folder picker; resolves to the pick, or nothing. */
	chooseWorkspaceFolder(): Promise<string | undefined>;
	startWorkspacePicker(query: string): Promise<string>;
	cancelWorkspacePicker(): Promise<void>;
	selectWorkspacePicker(path: string): Promise<AppOutcome>;
	onWorkspacePicker(
		listener: (event: WorkspacePickerEvent) => void,
	): () => void;

	openSettings(): Promise<void>;
	openExternalUrl(url: string): Promise<void>;

	/** Where main must lay the selected workspace's workbench view. */
	setContentRect(rect: ContentRect): Promise<void>;
	/** Whether a DOM surface is on screen, so the native view can hide. */
	setSurfaceVisible(visible: boolean): Promise<void>;

	/**
	 * The two Surface runtimes, each on its own slice.
	 *
	 * They are separate namespaces rather than more members here because they
	 * are separate subsystems with their own framing and their own surface-key
	 * grammars — `global-terminal` / `workspace-terminal:<uuid>` for one,
	 * `agent:<uuid>` for the other. Flattening them would invite a caller to
	 * pass one's key to the other.
	 */
	readonly terminal: DevhubTerminalApi;
	readonly agent: AgentApi;
}

/**
 * Channel names. Requests are `invoke`/`handle`; the pushes are the four
 * projections the page mirrors. Main→page traffic carries nothing else.
 */
export const CHANNELS = {
	getSnapshot: "devhub:get-snapshot",
	getAppearance: "devhub:get-appearance",
	getAgentProfiles: "devhub:get-agent-profiles",
	dispatch: "devhub:dispatch",
	replay: "devhub:replay",
	chooseWorkspaceFolder: "devhub:choose-workspace-folder",
	startWorkspacePicker: "devhub:start-workspace-picker",
	cancelWorkspacePicker: "devhub:cancel-workspace-picker",
	selectWorkspacePicker: "devhub:select-workspace-picker",
	openSettings: "devhub:open-settings",
	openExternalUrl: "devhub:open-external-url",
	setContentRect: "devhub:set-content-rect",
	setSurfaceVisible: "devhub:set-surface-visible",

	snapshotChanged: "devhub:snapshot-changed",
	appearanceChanged: "devhub:appearance-changed",
	agentProfilesChanged: "devhub:agent-profiles-changed",
	nativeError: "devhub:native-error",
	workspacePicker: "devhub:workspace-picker",
	/** A menu command the page has to carry out itself, e.g. open the picker. */
	menuCommand: "devhub:menu-command",
	/** The page has a modal open, or no longer does. */
	setModalOpen: "devhub:set-modal-open",
	/** A workbench asked a question; the page draws it and answers. */
	workbenchDialog: "devhub:workbench-dialog",
	workbenchDialogAnswer: "devhub:workbench-dialog-answer",
} as const;

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
	readonly id: string;
	readonly message: string;
	readonly detail?: string;
	readonly buttons: readonly string[];
	readonly defaultId: number;
	readonly cancelId: number;
	readonly kind: "none" | "info" | "warning" | "error" | "question";
}

export interface WorkbenchDialogAnswer {
	readonly id: string;
	readonly response: number;
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
