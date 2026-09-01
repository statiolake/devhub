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
  IssueAssignment,
  IssueClone,
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
  readonly startWorkspacePicker: (query?: string) => Promise<void>;
  readonly cancelWorkspacePicker: () => Promise<void>;
  readonly selectWorkspacePicker: (
    path: string,
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
  /**
   * The four steps of assigning an Issue. Each throws what to do about it when
   * it fails, because each is answered by re-asking the question that led to
   * it — which is the wizard's rule, not a special case for these.
   */
  readonly findIssueClones: (
    issueUrl: string,
  ) => Promise<readonly IssueClone[]>;
  readonly cloneRepository: (
    url: string,
    parentDirectory: string,
  ) => Promise<string>;
  readonly listBranches: (directory: string) => Promise<readonly string[]>;
  readonly assignIssue: (request: IssueAssignment) => Promise<AppOutcome>;
  readonly agentProfiles: AgentProfiles;
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
