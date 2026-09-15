/**
 * What the window's own page holds, and the whole of it.
 *
 * The title bar's name, the projection the three empty states are read off,
 * and the four calls those states make. Nothing else: this page has no
 * sidebar, no agents, no notices and no sheets, so it has no agent profiles,
 * no repository status, no workspace picker and no modal set — and, unlike the
 * provider this replaces, no way to ask for them.
 *
 * See `ShellPageBridge` in `ipc/contract.ts` for the other side of the same
 * statement, and `preload/shell.ts` for what makes it true at runtime.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import type {
  AppAppearance,
  AppIntent,
  AppLoadState,
  AppOutcome,
} from "../ipc/appShell";
import { devhub } from "./client";
import {
  useAppearance,
  useProjection,
  useRaiseFailure,
  type PendingConfirmation,
} from "./model/pageModel";
import type { ShellPageBridge } from "../ipc/contract";

export interface ShellPageValue {
  readonly state: AppLoadState;
  readonly appearance: AppAppearance | undefined;
  /**
   * What this window is called — the string main composed and gave the OS.
   *
   * Lettered into the title bar this page draws. It is read, never computed:
   * one window, one name, and nothing here that could disagree with what
   * Mission Control shows. Empty until the first answer arrives, because a bar
   * that says "Loading…" and then something else reads as a window that
   * changed, and it did not.
   */
  readonly windowTitle: string;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  /** Start this page's projection over — "Try Again" on a start failure. */
  readonly retry: () => void;
  readonly openSettings: () => Promise<void>;
  /** Get rid of a workspace, whatever kind. **The one path**; see the bridge. */
  readonly closeWorkspace: (workspaceId: string) => void;
  readonly chooseWorkspaceFolder: () => Promise<string | undefined>;
  /** Hand a failure to main. What arrived is never raised again. */
  readonly reportFailure: (error: unknown) => void;
}

export const ShellPageContext = createContext<ShellPageValue | null>(null);

export function useShellPage(): ShellPageValue {
  const value = useContext(ShellPageContext);
  if (!value) {
    throw new Error("useShellPage must be used inside ShellPageProvider");
  }
  return value;
}

export function ShellPageProvider({ children }: { children: ReactNode }) {
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
  const windowTitle = useWindowTitle(bridge, reportFailure, attempt);

  const closeWorkspace = useCallback(
    (workspaceId: string) => {
      void bridge.closeWorkspace(workspaceId).catch(reportFailure);
    },
    [bridge, reportFailure],
  );

  const value = useMemo<ShellPageValue>(
    () => ({
      state,
      appearance,
      windowTitle,
      dispatch,
      retry,
      openSettings: () => bridge.openSettings(),
      closeWorkspace,
      chooseWorkspaceFolder: () => bridge.chooseWorkspaceFolder(),
      reportFailure,
    }),
    [
      appearance,
      bridge,
      closeWorkspace,
      dispatch,
      reportFailure,
      retry,
      state,
      windowTitle,
    ],
  );

  return (
    <ShellPageContext.Provider value={value}>
      {children}
    </ShellPageContext.Provider>
  );
}

/**
 * The name between two pushes.
 *
 * Main pushes it whenever it moves, and it moved for the last time before this
 * page existed — so it is also read once, here. A failed read recovers in
 * place: the bar stays empty, which is what it draws until the first answer
 * anyway, and main pushes the name on its next move.
 */
function useWindowTitle(
  bridge: ShellPageBridge,
  reportFailure: (error: unknown) => void,
  attempt: number,
): string {
  const [title, setTitle] = useState("");

  useEffect(() => {
    let active = true;
    const apply = (next: string) => {
      if (active) setTitle(next);
    };
    const dispose = bridge.onWindowTitle(apply);
    void bridge.getWindowTitle().then(apply, reportFailure);
    return () => {
      active = false;
      dispose();
    };
  }, [attempt, bridge, reportFailure]);

  return title;
}
