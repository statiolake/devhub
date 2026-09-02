import { createContext, useContext } from "react";
import type {
  AgentProfiles,
  AppAppearance,
  AppError,
  AppIntent,
  AppLoadState,
  AppOutcome,
  ConfirmationPurposeWire,
} from "../ipc/appShell";
import type {
  AgentActionWire,
  GitHubLoginWire,
  IssueAssignment,
  IssueRepository,
  RepositoryStatusWire,
  WorkspacePickerCandidate,
} from "./client";

export interface AppShellContextValue {
  readonly state: AppLoadState;
  readonly appearance: AppAppearance | undefined;
  readonly intentError: AppError | null;
  readonly dismissIntentError: () => void;
  /** Hand a failure to the shell rather than explaining it locally. */
  readonly reportFailure: (error: unknown) => void;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  readonly retry: () => void;
  /** Hand a destination a surface asked for to the user's browser. */
  readonly openExternalUrl: (url: string) => void;
  readonly openSettings: () => Promise<void>;
  readonly pickerCandidates: readonly WorkspacePickerCandidate[];
  readonly pickerBusy: boolean;
  /** How many sources the last picker run asked; undefined before the first. */
  readonly pickerSourceCount: number | undefined;
  readonly startWorkspacePicker: (query?: string) => Promise<void>;
  readonly cancelWorkspacePicker: () => Promise<void>;
  /**
   * Open the folder a picker row named — making it first when the row said it
   * is not there yet, which only a date source's row ever does.
   */
  readonly selectWorkspacePicker: (
    path: string,
    create: boolean,
  ) => Promise<AppOutcome | undefined>;
  readonly chooseWorkspaceFolder: () => Promise<string | undefined>;
  /** Make a folder and open it. Throws what to do about it when it cannot. */
  readonly createProject: (path: string) => Promise<AppOutcome>;
  /** Clone into `parentDirectory` and open what git made. Throws git's reason. */
  readonly cloneProject: (
    url: string,
    parentDirectory: string,
  ) => Promise<AppOutcome>;
  readonly projectDefaultDirectory: () => Promise<string>;
  /** Where a clone could go: the parents of everything the sources find. */
  readonly cloneParentDirectories: () => Promise<readonly string[]>;
  /**
   * Which GitHub account this machine is signed in as, so a bare repository
   * name means what `gh repo clone` would mean by it. Answers with the reason
   * rather than throwing when it cannot say.
   */
  readonly githubLogin: () => Promise<GitHubLoginWire>;
  /** The branch a pull request is asking to merge. Throws GitHub's reason. */
  readonly pullRequestHeadBranch: (url: string) => Promise<string>;
  /** The ways of starting an agent on an Issue, as Settings lists them. */
  readonly agentActions: () => Promise<readonly AgentActionWire[]>;
  /**
   * Remove a worktree's folder and close its workspace. Throws git's reason.
   *
   * `force` is only ever true after the person has been asked and has said to
   * go ahead: it is what lets a worktree with uncommitted changes be removed at
   * all. Without it git refuses such a removal, which is the check that makes
   * the unasked removals safe.
   */
  readonly removeWorktree: (
    workspaceId: string,
    force: boolean,
  ) => Promise<AppOutcome>;
  /**
   * The four steps of assigning an Issue. Each throws what to do about it when
   * it fails, because each is answered by re-asking the question that led to
   * it — which is the wizard's rule, not a special case for these.
   */
  readonly findIssueRepositories: (
    issueUrl: string,
  ) => Promise<readonly IssueRepository[]>;
  readonly cloneRepository: (
    url: string,
    parentDirectory: string,
  ) => Promise<string>;
  readonly listBranches: (directory: string) => Promise<readonly string[]>;
  readonly assignIssue: (request: IssueAssignment) => Promise<AppOutcome>;
  readonly agentProfiles: AgentProfiles;
  /**
   * What each workspace is working on, as of the last look.
   *
   * A projection of its own, on its own clock: it is observed rather than
   * decided, so it does not move with the snapshot's revision.
   */
  readonly repositoryStatus: RepositoryStatusWire;
  readonly pendingConfirmation: {
    readonly confirmationId: string;
    readonly purpose: ConfirmationPurposeWire;
    readonly agentId?: string;
  } | null;
  readonly confirmationBusy: boolean;
  readonly confirmPending: () => Promise<void>;
  readonly dismissCloseConfirmation: () => void;
  /** Take on a confirmation raised on another page, as if raised here. */
  readonly adoptConfirmation: (confirmation: {
    readonly confirmationId: string;
    readonly purpose: ConfirmationPurposeWire;
    readonly agentId?: string;
  }) => void;
}

export const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShell(): AppShellContextValue {
  const value = useContext(AppShellContext);
  if (!value) {
    throw new Error("useAppShell must be used inside AppShellProvider");
  }
  return value;
}
