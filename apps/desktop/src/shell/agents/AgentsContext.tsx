/**
 * What the Agents page holds, and the whole of it.
 *
 * The projection that says which Agents there are and which is selected, the
 * appearance its terminals are drawn at, and what the Smart Buttons read: the
 * repository status their conditions are decided from and the configured
 * actions they say. Nothing else — no agent profiles, no workspace picker, no
 * window title, no notices. Its bridge
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
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  AppAppearance,
  AppIntent,
  AppLoadState,
  AppOutcome,
} from "../../ipc/appShell";
import type { AgentActionWire, RepositoryStatusWire } from "../../ipc/contract";
import { devhub } from "./client";
import {
  useAppearance,
  useProjection,
  useRaiseFailure,
  useRepositoryStatus,
  type PendingConfirmation,
} from "../model/pageModel";

export interface AgentsValue {
  readonly state: AppLoadState;
  readonly appearance: AppAppearance | undefined;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  /** What the Smart Buttons' conditions are read from. */
  readonly repositoryStatus: RepositoryStatusWire;
  /**
   * The configured actions, kept current: a row of buttons stands for as long
   * as its pane does, so an action renamed in Settings must reach it.
   */
  readonly agentActions: readonly AgentActionWire[];
  /** Say one of them to a running Agent. Queued, not sent. */
  readonly runAgentAction: (
    agentId: string,
    actionId: string,
  ) => Promise<AppOutcome>;
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

  const { state, dispatch, applySnapshot, attempt } = useProjection(
    bridge,
    reportFailure,
    raiseConfirmation,
  );
  const appearance = useAppearance(bridge, reportFailure, attempt);
  const repositoryStatus = useRepositoryStatus(bridge, reportFailure, attempt);

  // Subscribed before the first read, so an edit cannot land in the gap.
  const [agentActions, setAgentActions] = useState<readonly AgentActionWire[]>(
    [],
  );
  useEffect(() => {
    let live = true;
    const unsubscribe = bridge.onAgentActions((loaded) => {
      if (live) setAgentActions(loaded);
    });
    bridge.agentActions().then((loaded) => {
      if (live) setAgentActions(loaded);
    }, reportFailure);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge, reportFailure]);

  /**
   * The snapshot comes back because queueing changes the Agent's `injection`,
   * which is what the pane's corner reads to say a message is waiting.
   */
  const runAgentAction = useCallback(
    async (agentId: string, actionId: string) => {
      const outcome = await bridge.runAgentAction(agentId, actionId);
      applySnapshot(outcome.snapshot);
      return outcome;
    },
    [applySnapshot, bridge],
  );

  const value = useMemo<AgentsValue>(
    () => ({
      state,
      appearance,
      dispatch,
      repositoryStatus,
      agentActions,
      runAgentAction,
      reportFailure,
    }),
    [
      agentActions,
      appearance,
      dispatch,
      reportFailure,
      repositoryStatus,
      runAgentAction,
      state,
    ],
  );

  return (
    <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>
  );
}
