import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createTauriAppShellClient,
  parseTransportError,
  type AppShellClient,
} from "./client";
import type {
  AppAppearance,
  AppError,
  AppIntent,
  AppLoadState,
  AppOutcome,
  AppSnapshot,
} from "../generated/app-shell";
import { parseAppError } from "../generated/app-shell";
import { AppShellContext, type AppShellContextValue } from "./useAppShell";

const defaultClient = createTauriAppShellClient();
const PERSISTENCE_DEGRADED_ERROR: AppError = {
  code: "persistence_degraded",
  summary:
    "Changes could not be saved. The current workbench remains available.",
};

function toAppError(error: unknown): AppError {
  try {
    return parseAppError(error);
  } catch {
    // Tauri may reject with the structured DTO itself or wrap it in Error.
  }
  if (error instanceof Error && error.message.length > 0) {
    try {
      const decoded = JSON.parse(error.message) as unknown;
      return parseTransportError(decoded);
    } catch {
      // Tauri may wrap a structured command error in a plain message. Keep
      // the transport failure visible when it is not our strict error DTO.
    }
    return { code: "native_unavailable", summary: error.message };
  }
  return {
    code: "native_unavailable",
    summary: "The native app shell could not be reached.",
  };
}

export interface AppShellProviderProps {
  readonly client?: AppShellClient;
  readonly children: ReactNode;
}

/**
 * The provider owns transport lifecycle only. Snapshot data remains a Rust
 * projection; the provider has no derived workspace, selection, or disclosure
 * state of its own.
 */
export function AppShellProvider({
  client = defaultClient,
  children,
}: AppShellProviderProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AppLoadState>({ status: "loading" });
  const [appearance, setAppearance] = useState<AppAppearance>();
  const [intentError, setIntentError] = useState<AppError | null>(null);
  const lastRevision = useRef(-1);
  const lastEventCursor = useRef(0);
  const lastAppearanceSequence = useRef(-1);
  const generation = useRef(0);

  const applySnapshot = useCallback((snapshot: AppSnapshot) => {
    if (snapshot.revision < lastRevision.current) return;
    const revisionAdvanced = snapshot.revision > lastRevision.current;
    lastRevision.current = snapshot.revision;
    setState({ status: "ready", snapshot });
    // A same-revision notification can be the native acknowledgement for a
    // persistence-degraded dispatch. Keep that diagnostic visible until a
    // newer projection or a new user dispatch replaces it.
    if (revisionAdvanced) setIntentError(null);
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeAppearance: (() => void) | undefined;
    lastRevision.current = -1;
    lastAppearanceSequence.current = -1;

    const applyIfActive = (snapshot: AppSnapshot) => {
      if (active && generation.current === currentGeneration)
        applySnapshot(snapshot);
    };

    const applyAppearanceIfActive = (next: AppAppearance) => {
      if (!active || generation.current !== currentGeneration) return;
      if (next.sequence < lastAppearanceSequence.current) return;
      lastAppearanceSequence.current = next.sequence;
      setAppearance(next);
    };

    const initialize = async () => {
      try {
        // Subscribe before the query so a native update cannot be missed
        // between reconstruction and the initial projection.
        const cleanup = await client.subscribe(applyIfActive);
        if (!active) {
          cleanup();
          return;
        }
        unsubscribe = cleanup;
        if (client.subscribeAppearance) {
          const cleanupAppearance = await client.subscribeAppearance(
            applyAppearanceIfActive,
          );
          if (!active) {
            cleanupAppearance();
            return;
          }
          unsubscribeAppearance = cleanupAppearance;
        }
        if (client.getAppearance) {
          try {
            applyAppearanceIfActive(await client.getAppearance());
          } catch {
            // Appearance is a non-blocking projection. The Workbench remains
            // usable with its compact native default if the optional query is
            // unavailable during startup.
          }
        }
        if (client.replay) {
          const replay = await client.replay(lastEventCursor.current);
          if (!active || generation.current !== currentGeneration) return;
          // The replay cursor is independent from AppSnapshot.revision. On a
          // gap, replace the projection with the supplied snapshot before
          // applying any future live notifications.
          lastEventCursor.current = replay.cursor;
          applyIfActive(replay.snapshot);
        }
        applyIfActive(await client.getSnapshot());
      } catch (error) {
        if (active && generation.current === currentGeneration) {
          setState({ status: "error", error: toAppError(error) });
        }
      }
    };

    void initialize();
    return () => {
      active = false;
      generation.current += 1;
      unsubscribe?.();
      unsubscribeAppearance?.();
    };
  }, [applySnapshot, attempt, client]);

  const dispatch = useCallback(
    async (intent: AppIntent): Promise<AppOutcome | undefined> => {
      const dispatchGeneration = generation.current;
      setIntentError(null);
      try {
        const outcome = await client.dispatch(intent);
        if (generation.current !== dispatchGeneration) return undefined;
        applySnapshot(outcome.snapshot);
        if (outcome.kind === "persistence_degraded") {
          setIntentError(PERSISTENCE_DEGRADED_ERROR);
        }
        return outcome;
      } catch (error) {
        if (generation.current !== dispatchGeneration) return undefined;
        const nextError = toAppError(error);
        setIntentError(nextError);
        return undefined;
      }
    },
    [applySnapshot, client],
  );

  const retry = useCallback(() => {
    generation.current += 1;
    setIntentError(null);
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  const value = useMemo<AppShellContextValue>(
    () => ({ state, appearance, intentError, dispatch, retry }),
    [appearance, dispatch, intentError, retry, state],
  );

  return (
    <AppShellContext.Provider value={value}>
      {children}
    </AppShellContext.Provider>
  );
}
