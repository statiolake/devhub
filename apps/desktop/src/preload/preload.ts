/**
 * The pages' only way to reach the main process.
 *
 * Nothing here decides anything: each member forwards one request and lets the
 * failure through. A rejected call surfaces in the page's error area rather
 * than being turned into a quiet default here.
 *
 * One preload serves both windows, because both are the same page: the shell
 * uses `window.devhub`, the Settings window uses `window.devhubSettings`, and
 * neither can reach the other's channels by accident.
 *
 * VS Code calls `app.enableSandbox()`, so every renderer — DevHub's pages
 * included — is sandboxed, and a sandboxed preload is a single CommonJS file
 * with no module resolver behind it. Vite bundles this one, which is how the
 * contract it shares with main stays a single file.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type MenuCommand,
	type EditorRestartingWire,
	type ModalRequest,
	type OpenModal,
	type ContentRect,
	type ContentSurfaceWire,
	type DevhubApi,
	type IssueAssignment,
	type IssueClone,
	type RepositoryStatusWire,
	type WorkspacePickerEvent,
} from "../ipc/contract.js";
import type { ShellPalette } from "../ipc/palette.js";
import type {
	AgentProfiles,
	AppAppearance,
	AppError,
	AppIntent,
	AppOutcome,
	AppSnapshot,
	ReplayWire,
} from "../ipc/appShell.js";
import { terminalApi } from "./terminal.js";
import {
	SETTINGS_CHANNELS,
	type SettingsApi,
	type SettingsSaveRequestWire,
	type SettingsSnapshot,
	type SettingsSocketPreflightWire,
} from "../ipc/settings.js";

/** One push channel, one listener, one way to stop listening. */
function on<T>(channel: string, listener: (payload: T) => void): () => void {
	const handler = (_event: Electron.IpcRendererEvent, payload: T) => {
		listener(payload);
	};
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.removeListener(channel, handler);
	};
}

const devhub: DevhubApi = {
	getSnapshot: () =>
		ipcRenderer.invoke(CHANNELS.getSnapshot) as Promise<AppSnapshot>,
	getAppearance: () =>
		ipcRenderer.invoke(CHANNELS.getAppearance) as Promise<AppAppearance>,
	getTheme: () =>
		ipcRenderer.invoke(CHANNELS.getTheme) as Promise<ShellPalette | null>,
	getAgentProfiles: () =>
		ipcRenderer.invoke(CHANNELS.getAgentProfiles) as Promise<AgentProfiles>,
	dispatch: (intent: AppIntent) =>
		ipcRenderer.invoke(CHANNELS.dispatch, intent) as Promise<AppOutcome>,
	replay: (cursor: number) =>
		ipcRenderer.invoke(CHANNELS.replay, cursor) as Promise<ReplayWire>,

	onSnapshot: (listener) => on<AppSnapshot>(CHANNELS.snapshotChanged, listener),
	onAppearance: (listener) =>
		on<AppAppearance>(CHANNELS.appearanceChanged, listener),
	onTheme: (listener) => on<ShellPalette>(CHANNELS.themeChanged, listener),
	onAgentProfiles: (listener) =>
		on<AgentProfiles>(CHANNELS.agentProfilesChanged, listener),
	onNativeError: (listener) => on<AppError>(CHANNELS.nativeError, listener),
	onMenuCommand: (listener) => on<MenuCommand>(CHANNELS.menuCommand, listener),
	onEditorRestarting: (listener) =>
		on<EditorRestartingWire>(CHANNELS.editorRestarting, listener),
	getRepositoryStatus: () =>
		ipcRenderer.invoke(
			CHANNELS.getRepositoryStatus,
		) as Promise<RepositoryStatusWire>,
	onRepositoryStatus: (listener) =>
		on<RepositoryStatusWire>(CHANNELS.repositoryStatusChanged, listener),

	openModal: (request: ModalRequest) =>
		ipcRenderer.invoke(CHANNELS.openModal, request) as Promise<string>,
	closeModal: (id: string, response?: number) =>
		ipcRenderer.invoke(CHANNELS.closeModal, id, response) as Promise<void>,
	onModals: (listener) =>
		on<readonly OpenModal[]>(CHANNELS.modalsChanged, listener),
	onWorkspacePicker: (listener) =>
		on<WorkspacePickerEvent>(CHANNELS.workspacePicker, listener),

	chooseWorkspaceFolder: () =>
		ipcRenderer.invoke(CHANNELS.chooseWorkspaceFolder) as Promise<
			string | undefined
		>,
	startWorkspacePicker: (query: string) =>
		ipcRenderer.invoke(CHANNELS.startWorkspacePicker, query) as Promise<string>,
	cancelWorkspacePicker: () =>
		ipcRenderer.invoke(CHANNELS.cancelWorkspacePicker) as Promise<void>,
	selectWorkspacePicker: (path: string, create: boolean) =>
		ipcRenderer.invoke(
			CHANNELS.selectWorkspacePicker,
			path,
			create,
		) as Promise<AppOutcome>,
	createProject: (path: string) =>
		ipcRenderer.invoke(CHANNELS.createProject, path) as Promise<AppOutcome>,
	cloneProject: (url: string, parentDirectory: string) =>
		ipcRenderer.invoke(
			CHANNELS.cloneProject,
			url,
			parentDirectory,
		) as Promise<AppOutcome>,
	projectDefaultDirectory: () =>
		ipcRenderer.invoke(CHANNELS.projectDefaultDirectory) as Promise<string>,

	findIssueClones: (issueUrl: string) =>
		ipcRenderer.invoke(CHANNELS.findIssueClones, issueUrl) as Promise<
			readonly IssueClone[]
		>,
	cloneRepository: (url: string, parentDirectory: string) =>
		ipcRenderer.invoke(
			CHANNELS.cloneRepository,
			url,
			parentDirectory,
		) as Promise<string>,
	listBranches: (directory: string) =>
		ipcRenderer.invoke(CHANNELS.listBranches, directory) as Promise<
			readonly string[]
		>,
	assignIssue: (request: IssueAssignment) =>
		ipcRenderer.invoke(CHANNELS.assignIssue, request) as Promise<AppOutcome>,

	openSettings: () =>
		ipcRenderer.invoke(CHANNELS.openSettings) as Promise<void>,
	openExternalUrl: (url: string) =>
		ipcRenderer.invoke(CHANNELS.openExternalUrl, url) as Promise<void>,

	setContentRect: (rect: ContentRect) =>
		ipcRenderer.invoke(CHANNELS.setContentRect, rect) as Promise<void>,
	setContentSurface: (surface: ContentSurfaceWire) =>
		ipcRenderer.invoke(CHANNELS.setContentSurface, surface) as Promise<void>,

	terminal: terminalApi,
};

const devhubSettings: SettingsApi = {
	getSnapshot: () =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.getSnapshot,
		) as Promise<SettingsSnapshot>,
	save: (request: SettingsSaveRequestWire) =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.save,
			request,
		) as Promise<SettingsSnapshot>,
	reload: () =>
		ipcRenderer.invoke(SETTINGS_CHANNELS.reload) as Promise<SettingsSnapshot>,
	recheck: () =>
		ipcRenderer.invoke(SETTINGS_CHANNELS.recheck) as Promise<SettingsSnapshot>,
	openLogFolder: () =>
		ipcRenderer.invoke(SETTINGS_CHANNELS.openLogFolder) as Promise<void>,
	copyDiagnostics: () =>
		ipcRenderer.invoke(SETTINGS_CHANNELS.copyDiagnostics) as Promise<void>,
	socketPreflight: (socketName: string) =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.socketPreflight,
			socketName,
		) as Promise<SettingsSocketPreflightWire>,
	socketApply: (socketName: string) =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.socketApply,
			socketName,
		) as Promise<SettingsSnapshot>,
	close: () => ipcRenderer.invoke(SETTINGS_CHANNELS.close) as Promise<void>,
	onChanged: (listener) =>
		on<SettingsSnapshot>(SETTINGS_CHANNELS.changed, listener),
};

contextBridge.exposeInMainWorld("devhub", devhub);
contextBridge.exposeInMainWorld("devhubSettings", devhubSettings);
