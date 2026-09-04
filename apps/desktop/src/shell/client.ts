/**
 * The App Shell's transport.
 *
 * In the Tauri build this wrapped `invoke`/`listen`; here it wraps the bridge
 * the preload installed. The interface is what the components see, and it is
 * an interface so a test can hand them a different one — that is the only
 * reason it is not just `window.devhub`.
 */

import type {
  AgentProfiles,
  AppAppearance,
  AppError,
  AppIntent,
  AppOutcome,
  AppSnapshot,
  ReplayWire,
} from "../ipc/appShell";
import type {
  AgentActionWire,
  ContentSurfaceWire,
  DevhubApi,
  GitHubLoginWire,
  IssueAssignment,
  IssueRepository,
  ModalRequest,
  RepositoryStatusWire,
  WorkspacePickerCandidate,
  WorkspacePickerEvent,
} from "../ipc/contract";

export type {
  AgentActionWire,
  GitHubLoginWire,
  IssueAssignment,
  IssueRepository,
  RepositoryStatusWire,
  WorkspacePickerCandidate,
  WorkspacePickerEvent,
};

export interface AppShellClient {
  getSnapshot(): Promise<AppSnapshot>;
  getAppearance(): Promise<AppAppearance>;
  getAgentProfiles(): Promise<AgentProfiles>;
  dispatch(intent: AppIntent): Promise<AppOutcome>;
  replay(cursor: number): Promise<ReplayWire>;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
  subscribeAppearance(
    listener: (appearance: AppAppearance) => void,
  ): () => void;
  subscribeAgentProfiles(
    listener: (profiles: AgentProfiles) => void,
  ): () => void;
  subscribeAgentActions(
    listener: (actions: readonly AgentActionWire[]) => void,
  ): () => void;
  subscribeNativeError(listener: (error: AppError) => void): () => void;
  subscribeWorkspacePicker(
    listener: (event: WorkspacePickerEvent) => void,
  ): () => void;
  getRepositoryStatus(): Promise<RepositoryStatusWire>;
  subscribeRepositoryStatus(
    listener: (status: RepositoryStatusWire) => void,
  ): () => void;
  startWorkspacePicker(query: string): Promise<string>;
  cancelWorkspacePicker(): Promise<void>;
  selectWorkspacePicker(
    path: string,
    create: boolean,
    withAgent?: string,
  ): Promise<AppOutcome>;
  createProject(path: string, withAgent?: string): Promise<AppOutcome>;
  cloneProject(
    url: string,
    parentDirectory: string,
    withAgent?: string,
  ): Promise<AppOutcome>;
  projectDefaultDirectory(): Promise<string>;
  cloneParentDirectories(): Promise<readonly string[]>;
  githubLogin(): Promise<GitHubLoginWire>;
  pullRequestHeadBranch(url: string): Promise<string>;
  agentActions(): Promise<readonly AgentActionWire[]>;
  removeWorktree(workspaceId: string, force: boolean): Promise<AppOutcome>;
  runAgentAction(agentId: string, actionId: string): Promise<AppOutcome>;
  confirmInjection(
    agentId: string,
    injectionId: string,
    text: string,
  ): Promise<AppOutcome>;
  cancelInjection(agentId: string, injectionId: string): Promise<AppOutcome>;
  findIssueRepositories(issueUrl: string): Promise<readonly IssueRepository[]>;
  cloneRepository(url: string, parentDirectory: string): Promise<string>;
  listBranches(directory: string): Promise<readonly string[]>;
  assignIssue(request: IssueAssignment): Promise<AppOutcome>;
  chooseWorkspaceFolder(): Promise<string | undefined>;
  openSettings(): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  setContentRect(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<void>;
  setContentSurface(surface: ContentSurfaceWire): Promise<void>;
  /** Put a modal on the overlay layer; the id is what takes it off again. */
  openModal(request: ModalRequest): Promise<string>;
  closeModal(id: string, response?: number): Promise<void>;
}

declare global {
  interface Window {
    // Not `readonly`: the terminal and agent surfaces augment this same global
    // with their own slices, and every declaration of it has to agree.
    devhub?: DevhubApi;
  }
}

/**
 * The bridge the preload installed. Its absence means the page was loaded
 * without its preload, which is not a state the App Shell can work around.
 */
export function devhub(): DevhubApi {
  const api = window.devhub;
  if (!api) {
    throw new Error(
      "the App Shell page was loaded without its preload: window.devhub is missing",
    );
  }
  return api;
}

export function createShellClient(api: DevhubApi = devhub()): AppShellClient {
  return {
    getSnapshot: () => api.getSnapshot(),
    getAppearance: () => api.getAppearance(),
    getAgentProfiles: () => api.getAgentProfiles(),
    dispatch: (intent) => api.dispatch(intent),
    replay: (cursor) => api.replay(cursor),
    subscribe: (listener) => api.onSnapshot(listener),
    subscribeAppearance: (listener) => api.onAppearance(listener),
    subscribeAgentProfiles: (listener) => api.onAgentProfiles(listener),
    subscribeAgentActions: (listener) => api.onAgentActions(listener),
    subscribeNativeError: (listener) => api.onNativeError(listener),
    subscribeWorkspacePicker: (listener) => api.onWorkspacePicker(listener),
    getRepositoryStatus: () => api.getRepositoryStatus(),
    subscribeRepositoryStatus: (listener) => api.onRepositoryStatus(listener),
    startWorkspacePicker: (query) => api.startWorkspacePicker(query),
    cancelWorkspacePicker: () => api.cancelWorkspacePicker(),
    selectWorkspacePicker: (path, create, withAgent) =>
      api.selectWorkspacePicker(path, create, withAgent),
    createProject: (path, withAgent) => api.createProject(path, withAgent),
    cloneProject: (url, parentDirectory, withAgent) =>
      api.cloneProject(url, parentDirectory, withAgent),
    projectDefaultDirectory: () => api.projectDefaultDirectory(),
    cloneParentDirectories: () => api.cloneParentDirectories(),
    githubLogin: () => api.githubLogin(),
    pullRequestHeadBranch: (url) => api.pullRequestHeadBranch(url),
    agentActions: () => api.agentActions(),
    removeWorktree: (workspaceId, force) =>
      api.removeWorktree(workspaceId, force),
    runAgentAction: (agentId, actionId) =>
      api.runAgentAction(agentId, actionId),
    confirmInjection: (agentId, injectionId, text) =>
      api.confirmInjection(agentId, injectionId, text),
    cancelInjection: (agentId, injectionId) =>
      api.cancelInjection(agentId, injectionId),
    findIssueRepositories: (issueUrl) => api.findIssueRepositories(issueUrl),
    cloneRepository: (url, parentDirectory) =>
      api.cloneRepository(url, parentDirectory),
    listBranches: (directory) => api.listBranches(directory),
    assignIssue: (request) => api.assignIssue(request),
    chooseWorkspaceFolder: () => api.chooseWorkspaceFolder(),
    openSettings: () => api.openSettings(),
    openExternalUrl: (url) => api.openExternalUrl(url),
    setContentRect: (rect) => api.setContentRect(rect),
    setContentSurface: (surface) => api.setContentSurface(surface),
    openModal: (request) => api.openModal(request),
    closeModal: (id, response) => api.closeModal(id, response),
  };
}
