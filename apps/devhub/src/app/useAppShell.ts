import { createContext, useContext } from "react";
import type {
  AppAppearance,
  AppError,
  AppIntent,
  AppLoadState,
  AppOutcome,
  ConfirmationPurposeWire,
} from "../generated/app-shell";
import type { WorkspacePickerCandidate } from "./client";

export interface AppShellContextValue {
  readonly state: AppLoadState;
  readonly appearance: AppAppearance | undefined;
  readonly intentError: AppError | null;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  readonly retry: () => void;
  readonly pickerCandidates: readonly WorkspacePickerCandidate[];
  readonly pickerBusy: boolean;
  readonly startWorkspacePicker: (query?: string) => Promise<void>;
  readonly cancelWorkspacePicker: () => Promise<void>;
  readonly selectWorkspacePicker: (
    path: string,
  ) => Promise<AppOutcome | undefined>;
  readonly chooseWorkspaceFolder: () => Promise<string | undefined>;
  readonly pendingConfirmation: {
    readonly confirmationId: string;
    readonly purpose: ConfirmationPurposeWire;
  } | null;
  readonly confirmPending: () => Promise<void>;
  readonly dismissCloseConfirmation: () => void;
}

export const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShell(): AppShellContextValue {
  const value = useContext(AppShellContext);
  if (!value) {
    throw new Error("useAppShell must be used inside AppShellProvider");
  }
  return value;
}
