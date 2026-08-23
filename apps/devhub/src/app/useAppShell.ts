import { createContext, useContext } from "react";
import type {
  AppAppearance,
  AppError,
  AppIntent,
  AppLoadState,
  AppOutcome,
} from "../generated/app-shell";

export interface AppShellContextValue {
  readonly state: AppLoadState;
  readonly appearance: AppAppearance | undefined;
  readonly intentError: AppError | null;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  readonly retry: () => void;
}

export const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShell(): AppShellContextValue {
  const value = useContext(AppShellContext);
  if (!value) {
    throw new Error("useAppShell must be used inside AppShellProvider");
  }
  return value;
}
