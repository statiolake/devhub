/**
 * The parts a page's bridge is assembled from.
 *
 * One function per fragment in `ipc/contract.ts`, so that "the projection"
 * means the same four calls on every page that has it rather than four calls
 * each page spells for itself. Nothing here decides anything: each member
 * forwards one request and lets the failure through. A rejected call surfaces
 * in the page's error area rather than being turned into a quiet default here.
 *
 * What a page's bridge *is* is decided in `preload/<page>.ts`, which names the
 * fragments it takes and spells the members only it has. That file is the
 * enforcement: a member a page does not own is absent from the object the
 * context bridge exposes, so the page cannot spell it at all.
 *
 * VS Code calls `app.enableSandbox()`, so every renderer — DevHub's pages
 * included — is sandboxed, and a sandboxed preload is a single CommonJS file
 * with no module resolver behind it. Each page's preload is bundled on its
 * own, which is why this module is shared as source and never as a chunk.
 */

import { ipcRenderer } from "electron";
import {
	CHANNELS,
	type AgentActionWire,
	type AgentActionsBridge,
	type AgentProfilesBridge,
	type AppearanceBridge,
	type AssignmentBranchWire,
	type GitHubLoginWire,
	type IssueAssignment,
	type IssueRepository,
	type LayoutPreviewWire,
	type ModalRequest,
	type PageBridge,
	type ProjectionBridge,
	type RepositoryStatusBridge,
	type UsageLimitsBridge,
	type SshHostWire,
	type DevContainerConfigWire,
	type WorkspaceOpeningBridge,
	type WorkspacePickerEvent,
	type WorkspacePlaceWire,
} from "../ipc/contract.js";
import type { ShellPalette } from "../ipc/palette.js";
import type {
	AgentLaunchWire,
	AgentProfiles,
	AppAppearance,
	AppError,
	AppIntent,
	AppOutcome,
	AppSnapshot,
	ReplayWire,
} from "../ipc/appShell.js";
import type { RepositoryStatusWire, UsageLimitsWire } from "../ipc/contract.js";

/** One push channel, one listener, one way to stop listening. */
export function on<T>(
	channel: string,
	listener: (payload: T) => void,
): () => void {
	const handler = (_event: Electron.IpcRendererEvent, payload: T) => {
		listener(payload);
	};
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.removeListener(channel, handler);
	};
}

export function pageBridge(): PageBridge {
	return {
		// One way, and it has to be: see `raiseFailure` in `ipc/contract.ts`.
		raiseFailure: (error: AppError) => {
			ipcRenderer.send(CHANNELS.raiseFailure, error);
		},
		onTheme: (listener) => on<ShellPalette>(CHANNELS.themeChanged, listener),
	};
}

export function projectionBridge(): ProjectionBridge {
	return {
		getSnapshot: () =>
			ipcRenderer.invoke(CHANNELS.getSnapshot) as Promise<AppSnapshot>,
		replay: (cursor: number) =>
			ipcRenderer.invoke(CHANNELS.replay, cursor) as Promise<ReplayWire>,
		onSnapshot: (listener) =>
			on<AppSnapshot>(CHANNELS.snapshotChanged, listener),
		dispatch: (intent: AppIntent) =>
			ipcRenderer.invoke(CHANNELS.dispatch, intent) as Promise<AppOutcome>,
	};
}

export function appearanceBridge(): AppearanceBridge {
	return {
		getAppearance: () =>
			ipcRenderer.invoke(CHANNELS.getAppearance) as Promise<AppAppearance>,
		onAppearance: (listener) =>
			on<AppAppearance>(CHANNELS.appearanceChanged, listener),
	};
}

export function usageLimitsBridge(): UsageLimitsBridge {
	return {
		getUsageLimits: () =>
			ipcRenderer.invoke(CHANNELS.getUsageLimits) as Promise<UsageLimitsWire>,
		onUsageLimits: (listener) =>
			on<UsageLimitsWire>(CHANNELS.usageLimitsChanged, listener),
	};
}

export function repositoryStatusBridge(): RepositoryStatusBridge {
	return {
		getRepositoryStatus: () =>
			ipcRenderer.invoke(
				CHANNELS.getRepositoryStatus,
			) as Promise<RepositoryStatusWire>,
		onRepositoryStatus: (listener) =>
			on<RepositoryStatusWire>(CHANNELS.repositoryStatusChanged, listener),
	};
}

export function agentProfilesBridge(): AgentProfilesBridge {
	return {
		getAgentProfiles: () =>
			ipcRenderer.invoke(CHANNELS.getAgentProfiles) as Promise<AgentProfiles>,
		onAgentProfiles: (listener) =>
			on<AgentProfiles>(CHANNELS.agentProfilesChanged, listener),
	};
}

export function agentActionsBridge(): AgentActionsBridge {
	return {
		agentActions: () =>
			ipcRenderer.invoke(CHANNELS.agentActions) as Promise<
				readonly AgentActionWire[]
			>,
		onAgentActions: (listener) =>
			on<readonly AgentActionWire[]>(CHANNELS.agentActionsChanged, listener),
		runAgentAction: (agentId: string, actionId: string) =>
			ipcRenderer.invoke(
				CHANNELS.runAgentAction,
				agentId,
				actionId,
			) as Promise<AppOutcome>,
	};
}

export function workspaceOpeningBridge(): WorkspaceOpeningBridge {
	return {
		chooseWorkspaceFolder: () =>
			ipcRenderer.invoke(CHANNELS.chooseWorkspaceFolder) as Promise<
				string | undefined
			>,
		startWorkspacePicker: (query: string) =>
			ipcRenderer.invoke(
				CHANNELS.startWorkspacePicker,
				query,
			) as Promise<string>,
		cancelWorkspacePicker: () =>
			ipcRenderer.invoke(CHANNELS.cancelWorkspacePicker) as Promise<void>,
		selectWorkspacePicker: (
			path: string,
			create: boolean,
			withAgent?: AgentLaunchWire,
		) =>
			ipcRenderer.invoke(
				CHANNELS.selectWorkspacePicker,
				path,
				create,
				withAgent,
			) as Promise<AppOutcome>,
		onWorkspacePicker: (listener) =>
			on<WorkspacePickerEvent>(CHANNELS.workspacePicker, listener),
		createProject: (path: string, withAgent?: AgentLaunchWire) =>
			ipcRenderer.invoke(
				CHANNELS.createProject,
				path,
				withAgent,
			) as Promise<AppOutcome>,
		cloneProject: (
			url: string,
			parentDirectory: string,
			withAgent?: AgentLaunchWire,
		) =>
			ipcRenderer.invoke(
				CHANNELS.cloneProject,
				url,
				parentDirectory,
				withAgent,
			) as Promise<AppOutcome>,
		projectDefaultDirectory: () =>
			ipcRenderer.invoke(CHANNELS.projectDefaultDirectory) as Promise<string>,
		cloneParentDirectories: () =>
			ipcRenderer.invoke(CHANNELS.cloneParentDirectories) as Promise<
				readonly string[]
			>,
		cloneRepository: (url: string, parentDirectory: string) =>
			ipcRenderer.invoke(
				CHANNELS.cloneRepository,
				url,
				parentDirectory,
			) as Promise<string>,
		listSshHosts: () =>
			ipcRenderer.invoke(CHANNELS.listSshHosts) as Promise<
				readonly SshHostWire[]
			>,
		openSshWorkspace: (
			host: string,
			path: string,
			withAgent?: AgentLaunchWire,
		) =>
			ipcRenderer.invoke(
				CHANNELS.openSshWorkspace,
				host,
				path,
				withAgent,
			) as Promise<AppOutcome>,
		devContainerConfigs: (path: string) =>
			ipcRenderer.invoke(CHANNELS.devContainerConfigs, path) as Promise<
				readonly DevContainerConfigWire[]
			>,
		openContainerWorkspace: (
			workspaceFolder: string,
			configPath?: string,
			withAgent?: AgentLaunchWire,
		) =>
			ipcRenderer.invoke(
				CHANNELS.openContainerWorkspace,
				workspaceFolder,
				configPath,
				withAgent,
			) as Promise<AppOutcome>,
		findIssueRepositories: (issueUrl: string) =>
			ipcRenderer.invoke(CHANNELS.findIssueRepositories, issueUrl) as Promise<
				readonly IssueRepository[]
			>,
		githubLogin: () =>
			ipcRenderer.invoke(CHANNELS.githubLogin) as Promise<GitHubLoginWire>,
		assignmentBranch: (url: string, place: WorkspacePlaceWire) =>
			ipcRenderer.invoke(
				CHANNELS.assignmentBranch,
				url,
				place,
			) as Promise<AssignmentBranchWire>,
		listBranches: (place: WorkspacePlaceWire) =>
			ipcRenderer.invoke(CHANNELS.listBranches, place) as Promise<
				readonly string[]
			>,
		assignIssue: (request: IssueAssignment) =>
			ipcRenderer.invoke(CHANNELS.assignIssue, request) as Promise<AppOutcome>,
	};
}

/** Put a modal on screen. Resolves to the id that closes it again. */
export function openModal(request: ModalRequest): Promise<string> {
	return ipcRenderer.invoke(CHANNELS.openModal, request) as Promise<string>;
}

/** Get rid of a workspace, whatever kind it is. **The one path.** */
export function closeWorkspace(workspaceId: string): Promise<void> {
	return ipcRenderer.invoke(
		CHANNELS.closeWorkspace,
		workspaceId,
	) as Promise<void>;
}

export function openSettings(): Promise<void> {
	return ipcRenderer.invoke(CHANNELS.openSettings) as Promise<void>;
}

export function reopenEditorLocally(workspaceId: string): Promise<void> {
	return ipcRenderer.invoke(
		CHANNELS.reopenEditorLocally,
		workspaceId,
	) as Promise<void>;
}

export function openExternalUrl(url: string): Promise<void> {
	return ipcRenderer.invoke(CHANNELS.openExternalUrl, url) as Promise<void>;
}

export function previewLayout(preview: LayoutPreviewWire): Promise<void> {
	return ipcRenderer.invoke(CHANNELS.previewLayout, preview) as Promise<void>;
}

/** Hand the keyboard back to whatever is on screen — Escape in the chrome. */
export function focusSurface(): Promise<void> {
	return ipcRenderer.invoke(CHANNELS.focusSurface) as Promise<void>;
}

/** Put text on the Mac's clipboard — OSC 52 from a pane. */
export function writeClipboard(text: string): Promise<void> {
	return ipcRenderer.invoke(CHANNELS.writeClipboard, text) as Promise<void>;
}
