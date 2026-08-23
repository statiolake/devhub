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
  type WorkspacePickerCandidate,
  type WorkspacePickerEvent,
} from "./client";
import type {
  AppAppearance,
  AppError,
  AppIntent,
  AppLoadState,
  AppOutcome,
  AppSnapshot,
  ConfirmationPurposeWire,
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
  const [pickerCandidates, setPickerCandidates] = useState<
    WorkspacePickerCandidate[]
  >([]);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    confirmationId: string;
    purpose: ConfirmationPurposeWire;
  } | null>(null);
  const lastRevision = useRef(-1);
  const lastEventCursor = useRef(0);
  const lastAppearanceSequence = useRef(-1);
  const generation = useRef(0);
  const pickerOperation = useRef<string | null>(null);
  const pickerSequence = useRef(-1);
  const pickerStartGeneration = useRef(0);
  const pickerBufferedEvents = useRef<WorkspacePickerEvent[]>([]);
  const pickerEventProcessor = useRef<
    ((event: WorkspacePickerEvent) => void) | null
  >(null);

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
    let unsubscribePicker: (() => void) | undefined;
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
        if (client.subscribeWorkspacePicker) {
          const processPickerEvent = (event: WorkspacePickerEvent) => {
            if (event.operationId !== pickerOperation.current) return;
            if (event.kind === "started") {
              pickerSequence.current = event.sequence;
              setPickerCandidates([]);
              setPickerBusy(true);
              return;
            }
            if (event.sequence <= pickerSequence.current) return;
            if (event.kind === "candidate") {
              pickerSequence.current = event.sequence;
              const candidate = {
                operationId: event.operationId,
                sequence: event.sequence,
                label: event.label,
                searchText: event.searchText,
                path: event.path,
                score: event.score,
              };
              setPickerCandidates((current) => {
                if (current.some((item) => item.path === event.path))
                  return current;
                return [...current, candidate].slice(-1000);
              });
            } else if (
              event.kind === "completed" ||
              event.kind === "cancelled"
            ) {
              pickerSequence.current = event.sequence;
              setPickerBusy(false);
            } else {
              pickerSequence.current = event.sequence;
            }
          };
          pickerEventProcessor.current = processPickerEvent;
          const cleanupPicker = await client.subscribeWorkspacePicker(
            (event) => {
              if (!active || generation.current !== currentGeneration) return;
              if (!pickerOperation.current) {
                pickerBufferedEvents.current = [
                  ...pickerBufferedEvents.current,
                  event,
                ].slice(-64);
                return;
              }
              processPickerEvent(event);
            },
          );
          if (!active) cleanupPicker();
          else unsubscribePicker = cleanupPicker;
        }
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
      unsubscribePicker?.();
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
        if (outcome.kind === "confirmation_required") {
          setPendingConfirmation({
            confirmationId: outcome.confirmationId,
            purpose: outcome.purpose,
          });
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

  const startWorkspacePicker = useCallback(
    async (query = "") => {
      if (!client.startWorkspacePicker) return;
      const requestGeneration = ++pickerStartGeneration.current;
      setPickerBusy(true);
      setPickerCandidates([]);
      pickerOperation.current = null;
      pickerSequence.current = -1;
      pickerBufferedEvents.current = [];
      let operationId: string;
      try {
        operationId = await client.startWorkspacePicker(query);
      } catch (error) {
        if (requestGeneration === pickerStartGeneration.current) {
          setPickerBusy(false);
          setIntentError(toAppError(error));
        }
        return;
      }
      if (requestGeneration !== pickerStartGeneration.current) return;
      pickerOperation.current = operationId;
      pickerSequence.current = -1;
      const buffered = pickerBufferedEvents.current;
      pickerBufferedEvents.current = [];
      for (const event of buffered) {
        if (event.operationId === operationId) {
          pickerEventProcessor.current?.(event);
        }
      }
    },
    [client],
  );

  const cancelWorkspacePicker = useCallback(async () => {
    ++pickerStartGeneration.current;
    pickerOperation.current = null;
    pickerSequence.current = -1;
    pickerBufferedEvents.current = [];
    setPickerCandidates([]);
    setPickerBusy(false);
    try {
      await client.cancelWorkspacePicker?.();
    } catch (error) {
      setIntentError(toAppError(error));
    }
  }, [client]);

  const selectWorkspacePicker = useCallback(
    async (path: string) => {
      const outcome = await client.selectWorkspacePicker?.(path);
      if (outcome) applySnapshot(outcome.snapshot);
      setPickerBusy(false);
      return outcome;
    },
    [applySnapshot, client],
  );

  const chooseWorkspaceFolder = useCallback(async () => {
    return client.chooseWorkspaceFolder?.();
  }, [client]);

  const confirmPending = useCallback(async () => {
    if (!pendingConfirmation) return;
    const confirmationId = pendingConfirmation.confirmationId;
    if (pendingConfirmation.purpose.kind !== "workspace_close") {
      // Agent-stop confirmations are owned by the Agent surface in the next
      // shell wave; never reinterpret one as a workspace close.
      setPendingConfirmation(null);
      return;
    }
    await dispatch({
      type: "confirm_close_workspace",
      confirmationId,
    });
    setPendingConfirmation((current) =>
      current?.confirmationId === confirmationId ? null : current,
    );
  }, [dispatch, pendingConfirmation]);

  const dismissCloseConfirmation = useCallback(() => {
    setPendingConfirmation(null);
  }, []);

  const value = useMemo<AppShellContextValue>(
    () => ({
      state,
      appearance,
      intentError,
      dispatch,
      retry,
      pickerCandidates,
      pickerBusy,
      startWorkspacePicker,
      cancelWorkspacePicker,
      selectWorkspacePicker,
      chooseWorkspaceFolder,
      pendingConfirmation,
      confirmPending,
      dismissCloseConfirmation,
    }),
    [
      appearance,
      cancelWorkspacePicker,
      dispatch,
      intentError,
      pickerBusy,
      pickerCandidates,
      retry,
      selectWorkspacePicker,
      startWorkspacePicker,
      state,
      pendingConfirmation,
      chooseWorkspaceFolder,
      confirmPending,
      dismissCloseConfirmation,
    ],
  );

  return (
    <AppShellContext.Provider value={value}>
      {children}
    </AppShellContext.Provider>
  );
}
