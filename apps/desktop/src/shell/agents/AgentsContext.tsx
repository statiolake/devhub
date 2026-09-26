/**
 * What the Agents page holds, and the whole of it.
 *
 * The projection that says which Agents there are and which is selected, and
 * the appearance its terminals are drawn at. Nothing else — no agent
 * profiles, no repository status, no workspace picker, no window title, no
 * notices. Its bridge
 * cannot spell those either; see `AgentsBridge` in `ipc/contract.ts` and
 * `preload/agents.ts`.
 *
 * The terminal transport is not here and does not need to be: frames arrive
 * per surface, `channelId` is the routing key, and `terminal/client.ts` reads
 * the same bridge directly from wherever a pane is mounted.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type {
  AppAppearance,
  AppIntent,
  AppLoadState,
  AppOutcome,
} from "../../ipc/appShell";
import { devhub } from "./client";
import {
  useAppearance,
  useProjection,
  useRaiseFailure,
  type PendingConfirmation,
} from "../model/pageModel";

export interface AgentsValue {
  readonly state: AppLoadState;
  readonly appearance: AppAppearance | undefined;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  /** Hand a failure to main. What arrived is never raised again. */
  readonly reportFailure: (error: unknown) => void;
}

export const AgentsContext = createContext<AgentsValue | null>(null);

export function useAgents(): AgentsValue {
  const value = useContext(AgentsContext);
  if (!value) {
    throw new Error("useAgents must be used inside AgentsProvider");
  }
  return value;
}

export function AgentsProvider({ children }: { children: ReactNode }) {
  const bridge = useMemo(() => devhub(), []);
  const reportFailure = useRaiseFailure(bridge);

  // This page draws no modals; they stand on the `picker` view. A confirmation
  // goes to main, which is the one place in DevHub where a question can be
  // both seen and answered.
  const raiseConfirmation = useCallback(
    (confirmation: PendingConfirmation) => {
      void bridge
        .openModal({ kind: "close-confirmation", ...confirmation })
        .catch(reportFailure);
    },
    [bridge, reportFailure],
  );

  const { state, dispatch, attempt } = useProjection(
    bridge,
    reportFailure,
    raiseConfirmation,
  );
  const appearance = useAppearance(bridge, reportFailure, attempt);

  const value = useMemo<AgentsValue>(
    () => ({
      state,
      appearance,
      dispatch,
      reportFailure,
    }),
    [appearance, dispatch, reportFailure, state],
  );

  return (
    <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>
  );
}
