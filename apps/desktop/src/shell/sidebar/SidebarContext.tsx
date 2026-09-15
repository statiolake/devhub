/**
 * What the Sidebar holds, and the whole of it.
 *
 * The projection it lists, the appearance it draws at, the agent profiles its
 * `+` offers, the repository status its rows letter, and the four calls a row
 * makes. Nothing else — no notices, no modal set, no workspace picker
 * candidates, no window title. Its bridge cannot spell those either; see
 * `SidebarBridge` in `ipc/contract.ts` and `preload/sidebar.ts`.
 *
 * What is *not* here and used to be: `subscribeNativeError`. Every page took
 * it while one provider served them all, and a page that is told a failure and
 * has nowhere to put it has only one thing left to do with it, which is hand
 * it back. The Sidebar raises what began here and draws none of it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type {
  AgentProfiles,
  AppAppearance,
  AppIntent,
  AppLoadState,
  AppOutcome,
} from "../../ipc/appShell";
import type { RepositoryStatusWire } from "../../ipc/contract";
import { devhub } from "./client";
import {
  useAgentProfiles,
  useAppearance,
  useProjection,
  useRaiseFailure,
  useRepositoryStatus,
  type PendingConfirmation,
} from "../model/pageModel";

export interface SidebarValue {
  readonly state: AppLoadState;
  readonly appearance: AppAppearance | undefined;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  /** "Try Again" on an app-scoped notice, routed here by `retry_app`. */
  readonly retry: () => void;
  readonly agentProfiles: AgentProfiles;
  readonly repositoryStatus: RepositoryStatusWire;
  /** Get rid of a workspace, whatever kind. **The one path**; see the bridge. */
  readonly closeWorkspace: (workspaceId: string) => void;
  /** Hand a destination a row named to the user's browser. */
  readonly openExternalUrl: (url: string) => void;
  /** Hand a failure to main. What arrived is never raised again. */
  readonly reportFailure: (error: unknown) => void;
}

export const SidebarContext = createContext<SidebarValue | null>(null);

export function useSidebar(): SidebarValue {
  const value = useContext(SidebarContext);
  if (!value) {
    throw new Error("useSidebar must be used inside SidebarProvider");
  }
  return value;
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const bridge = useMemo(() => devhub(), []);
  const reportFailure = useRaiseFailure(bridge);

  // This page draws no modals; they stand on the `picker` view, one layer
  // above every workbench. So a confirmation goes to main, which is the one
  // place in DevHub where a question can be both seen and answered.
  const raiseConfirmation = useCallback(
    (confirmation: PendingConfirmation) => {
      void bridge
        .openModal({ kind: "close-confirmation", ...confirmation })
        .catch(reportFailure);
    },
    [bridge, reportFailure],
  );

  const { state, dispatch, retry, attempt } = useProjection(
    bridge,
    reportFailure,
    raiseConfirmation,
  );
  const appearance = useAppearance(bridge, reportFailure, attempt);
  const repositoryStatus = useRepositoryStatus(bridge, reportFailure, attempt);
  const agentProfiles = useAgentProfiles(bridge, attempt);

  const closeWorkspace = useCallback(
    (workspaceId: string) => {
      void bridge.closeWorkspace(workspaceId).catch(reportFailure);
    },
    [bridge, reportFailure],
  );

  const openExternalUrl = useCallback(
    (url: string) => {
      void bridge.openExternalUrl(url).catch(reportFailure);
    },
    [bridge, reportFailure],
  );

  const value = useMemo<SidebarValue>(
    () => ({
      state,
      appearance,
      dispatch,
      retry,
      agentProfiles,
      repositoryStatus,
      closeWorkspace,
      openExternalUrl,
      reportFailure,
    }),
    [
      agentProfiles,
      appearance,
      closeWorkspace,
      dispatch,
      openExternalUrl,
      reportFailure,
      repositoryStatus,
      retry,
      state,
    ],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}
