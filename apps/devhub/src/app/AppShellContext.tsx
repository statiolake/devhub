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
  type AppPerformanceMarker,
  type AppShellClient,
  type EditorLayout,
  type EditorRemote,
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
  AgentProfiles,
  ConfirmationPurposeWire,
} from "../generated/app-shell";
import {
  PERSISTENCE_DEGRADED_ERROR,
  toAppError,
  UserFacingFailure,
} from "./failure";
import { AppShellContext, type AppShellContextValue } from "./useAppShell";
import { trace } from "../editor/trace";

const defaultClient = createTauriAppShellClient();
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
  const [agentProfiles, setAgentProfiles] = useState<AgentProfiles>({
    sequence: 1,
    availability: "unavailable",
    diagnostic: "projection_unavailable",
    profiles: [],
  });
  /**
   * The failure on screen, and whether a new projection invalidates it.
   *
   * A dispatch failure is a statement about a projection that has since been
   * replaced, so the next one retires it. A failure that had nothing to do
   * with the projection — a provider that would not start, a query that was
   * refused — is not answered by a snapshot arriving, and clearing it on one
   * is how a reported failure reaches the screen and vanishes before it can
   * be read. Which of the two it is belongs to whoever raised it.
   */
  const [intentError, setIntentErrorState] = useState<{
    readonly error: AppError;
    readonly retiredByProjection: boolean;
  } | null>(null);
  const setIntentError = useCallback((error: AppError | null) => {
    setIntentErrorState(
      error === null ? null : { error, retiredByProjection: true },
    );
  }, []);
  const [pickerCandidates, setPickerCandidates] = useState<
    WorkspacePickerCandidate[]
  >([]);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    confirmationId: string;
    purpose: ConfirmationPurposeWire;
    agentId?: string;
  } | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const confirmationBusyRef = useRef(false);
  const lastRevision = useRef(-1);
  const lastEventCursor = useRef(0);
  const lastAppearanceSequence = useRef(-1);
  const lastProfileSequence = useRef(0);
  const generation = useRef(0);
  const pickerOperation = useRef<string | null>(null);
  const pickerSequence = useRef(-1);
  const pickerStartGeneration = useRef(0);
  const pickerBufferedEvents = useRef<WorkspacePickerEvent[]>([]);
  const pickerFirstResultMarkerOperation = useRef<string | null>(null);
  const pickerEventProcessor = useRef<
    ((event: WorkspacePickerEvent) => void) | null
  >(null);

  /**
   * Route a failure to the one place the shell shows them.
   *
   * Callers that cannot recover do not catch to explain themselves; they hand
   * the failure here, and it appears where every other failure appears.
   */
  const reportFailure = useCallback((error: unknown) => {
    setIntentErrorState({
      error: toAppError(error),
      retiredByProjection: false,
    });
  }, []);

  const applySnapshot = useCallback((snapshot: AppSnapshot) => {
    if (snapshot.revision < lastRevision.current) return;
    const revisionAdvanced = snapshot.revision > lastRevision.current;
    lastRevision.current = snapshot.revision;
    setState({ status: "ready", snapshot });
    // A same-revision notification can be the native acknowledgement for a
    // persistence-degraded dispatch. Keep that diagnostic visible until a
    // newer projection or a new user dispatch replaces it.
    if (revisionAdvanced) {
      setIntentErrorState((current) =>
        current?.retiredByProjection === true ? null : current,
      );
    }
  }, []);

  const emitPerformanceMarker = useCallback(
    (marker: AppPerformanceMarker) => {
      const result = client.recordPerformanceMarker?.(marker);
      if (result) void result.catch(() => undefined);
    },
    [client],
  );

  // These markers are intentionally emitted after React commits the native
  // App Shell projection. The command is a no-op outside the opt-in native
  // performance driver, so the production transport has no extra log work.
  useEffect(() => {
    if (state.status !== "ready") return;
    emitPerformanceMarker("app_shell_interactive");
  }, [emitPerformanceMarker, state.status]);

  const activeActivity =
    state.status === "ready" ? state.snapshot.selection.activity : undefined;

  useEffect(() => {
    if (state.status !== "ready") return;
    emitPerformanceMarker("activity_interactive");
  }, [activeActivity, emitPerformanceMarker, state.status]);

  useEffect(() => {
    if (
      pickerCandidates.length === 0 ||
      !pickerOperation.current ||
      pickerFirstResultMarkerOperation.current === pickerOperation.current
    ) {
      return;
    }
    pickerFirstResultMarkerOperation.current = pickerOperation.current;
    emitPerformanceMarker("picker_first_result");
  }, [emitPerformanceMarker, pickerCandidates.length]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeAppearance: (() => void) | undefined;
    let unsubscribeProfiles: (() => void) | undefined;
    let unsubscribePicker: (() => void) | undefined;
    let unsubscribeNativeError: (() => void) | undefined;
    lastRevision.current = -1;
    lastAppearanceSequence.current = -1;
    lastProfileSequence.current = 0;

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

    const applyProfilesIfActive = (next: AgentProfiles) => {
      if (!active || generation.current !== currentGeneration) return;
      if (next.sequence <= lastProfileSequence.current) return;
      lastProfileSequence.current = next.sequence;
      setAgentProfiles(next);
    };

    const markProfilesUnavailable = () => {
      if (!active || generation.current !== currentGeneration) return;
      const sequence = Math.max(1, lastProfileSequence.current + 1);
      // This is a local transport fallback, not a Rust-owned projection
      // sequence. Do not advance the native cursor or a successful same-
      // revision query could be discarded after a subscription failure.
      setAgentProfiles({
        sequence,
        availability: "unavailable",
        diagnostic: "projection_unavailable",
        profiles: [],
      });
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
        if (client.subscribeNativeError) {
          const cleanupNativeError = await client.subscribeNativeError(
            (error) => {
              if (active && generation.current === currentGeneration)
                setIntentError(error);
            },
          );
          if (!active) cleanupNativeError();
          else unsubscribeNativeError = cleanupNativeError;
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
        if (client.subscribeAgentProfiles) {
          try {
            const cleanupProfiles = await client.subscribeAgentProfiles(
              applyProfilesIfActive,
            );
            if (!active) {
              cleanupProfiles();
              return;
            }
            unsubscribeProfiles = cleanupProfiles;
          } catch {
            // Keep query failure explicit. An empty list would make the
            // picker indistinguishable from a valid no-profile config.
            markProfilesUnavailable();
          }
        }
        if (client.getAppearance) {
          // Appearance is a non-blocking projection — the shell is usable with
          // its native defaults — but "usable with defaults" is a different
          // thing from "the settings you chose are being ignored", and only
          // one of those is worth not saying.
          try {
            applyAppearanceIfActive(await client.getAppearance());
          } catch (error: unknown) {
            reportFailure(error);
          }
        }
        if (client.getAgentProfiles) {
          try {
            applyProfilesIfActive(await client.getAgentProfiles());
          } catch {
            // Profile discovery is optional transport wiring, but failure is
            // not equivalent to an empty enabled-profile set.
            markProfilesUnavailable();
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
      unsubscribeProfiles?.();
      unsubscribePicker?.();
      unsubscribeNativeError?.();
    };
  }, [applySnapshot, attempt, client, reportFailure, setIntentError]);

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
            // A confirmation can be replaced by native while the one-shot
            // operation is being submitted. Preserve the original Agent
            // identity because the replacement intent carries only its token.
            agentId:
              intent.type === "stop_agent"
                ? intent.agentId
                : outcome.purpose.kind === "agent_stop"
                  ? pendingConfirmation?.agentId
                  : undefined,
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
    [applySnapshot, client, pendingConfirmation, setIntentError],
  );

  const retry = useCallback(() => {
    generation.current += 1;
    setIntentError(null);
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, [setIntentError]);

  const openSettings = useCallback(async () => {
    await client.openSettings?.();
  }, [client]);

  const setEditorLayout = useCallback(
    (layout: EditorLayout) => {
      const result = client.setEditorLayout?.(layout);
      // Layout is a native projection side effect. A stale or unavailable
      // child must not turn a valid App Shell snapshot into an error state;
      // the next committed geometry retries it.
      if (result) void result.catch(() => undefined);
    },
    [client],
  );

  const startWorkspacePicker = useCallback(
    async (query = "") => {
      if (!client.startWorkspacePicker) return;
      const requestGeneration = ++pickerStartGeneration.current;
      setPickerBusy(true);
      setPickerCandidates([]);
      pickerOperation.current = null;
      pickerSequence.current = -1;
      pickerBufferedEvents.current = [];
      pickerFirstResultMarkerOperation.current = null;
      let operationId: string;
      try {
        operationId = await client.startWorkspacePicker(query);
      } catch (error: unknown) {
        // Recovers in place: the picker stops claiming to be searching. The
        // failure itself is not explained here.
        if (requestGeneration === pickerStartGeneration.current) {
          setPickerBusy(false);
          reportFailure(error);
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
    [client, reportFailure],
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
    } catch (error: unknown) {
      reportFailure(error);
    }
  }, [client, reportFailure]);

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
    if (!pendingConfirmation || confirmationBusyRef.current) return;
    confirmationBusyRef.current = true;
    setConfirmationBusy(true);
    const confirmationId = pendingConfirmation.confirmationId;
    try {
      let outcome: AppOutcome | undefined;
      if (pendingConfirmation.purpose.kind === "agent_stop") {
        if (!pendingConfirmation.agentId) {
          setPendingConfirmation(null);
          return;
        }
        outcome = await dispatch({
          type: "confirm_stop_agent",
          confirmationId,
        });
      } else {
        outcome = await dispatch({
          type: "confirm_close_workspace",
          confirmationId,
        });
      }

      // Keep the typed confirmation available when the command itself failed at
      // the transport boundary. A successful confirmation transitions the Rust
      // row into stopping/closing and consumes this one-shot operation; a
      // failure must remain retryable without inventing a second local state.
      // If native replaces the confirmation while this request is in flight,
      // the replacement remains visible and is not consumed by this response.
      if (outcome) {
        setPendingConfirmation((current) =>
          current?.confirmationId === confirmationId ? null : current,
        );
      }
    } finally {
      confirmationBusyRef.current = false;
      setConfirmationBusy(false);
    }
  }, [dispatch, pendingConfirmation]);

  // A dispatch failure stays on screen until something replaces it, which for a
  // failure that needs no further action means it never leaves on its own. The
  // user gets to put it away; the next dispatch or projection re-raises it if
  // the problem is still there.
  const dismissIntentError = useCallback(() => {
    setIntentErrorState(null);
  }, []);

  // The Editor's server is started on demand and outlives every Surface, so
  // the connection to it is asked for once and shared.
  const [editorRemote, setEditorRemote] = useState<EditorRemote | null>(null);
  const editorRequested = useRef(false);
  const ensureEditorRemote = useCallback(() => {
    if (editorRequested.current) {
      trace("ensureEditorRemote: already asked, not asking again");
      return;
    }
    editorRequested.current = true;
    trace("ensureEditorRemote: invoking");
    const result = client.ensureEditorRemote?.();
    if (!result) {
      // A transport that cannot start the Editor is a failure, not a wait.
      // Returning quietly here is how a Surface ends up on a spinner that
      // nothing will ever replace.
      editorRequested.current = false;
      reportFailure(
        new UserFacingFailure(
          "The editor is unavailable in this build.",
          "The app shell has no way to start an editor server.",
        ),
      );
      return;
    }
    void result.then(
      (remote) => {
        trace("ensureEditorRemote: resolved", remote.authority);
        setEditorRemote(remote);
      },
      (error: unknown) => {
        trace("ensureEditorRemote: rejected", error);
        // Allow another attempt: a server that would not start can be fixed
        // without restarting the app.
        editorRequested.current = false;
        reportFailure(error);
      },
    );
  }, [client, reportFailure]);

  const dismissCloseConfirmation = useCallback(() => {
    setPendingConfirmation(null);
  }, []);

  // A source build gets one place to look when the Editor will not start.
  // The two states that produce the same waiting notice — no server yet, and
  // a request that never came back — are indistinguishable from the outside,
  // and this is the only thing that tells them apart.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__devhubEditor = {
      remote: editorRemote,
      requestInFlight: editorRequested.current && editorRemote == null,
      canRequest: client.ensureEditorRemote != null,
    };
  }

  const value = useMemo<AppShellContextValue>(
    () => ({
      state,
      appearance,
      intentError: intentError?.error ?? null,
      dismissIntentError,
      editorRemote,
      ensureEditorRemote,
      reportFailure,
      recordPerformanceMarker: emitPerformanceMarker,
      dispatch,
      retry,
      openSettings,
      setEditorLayout,
      pickerCandidates,
      pickerBusy,
      startWorkspacePicker,
      cancelWorkspacePicker,
      selectWorkspacePicker,
      chooseWorkspaceFolder,
      agentProfiles,
      pendingConfirmation,
      confirmationBusy,
      confirmPending,
      dismissCloseConfirmation,
    }),
    [
      appearance,
      cancelWorkspacePicker,
      dispatch,
      emitPerformanceMarker,
      intentError,
      dismissIntentError,
      editorRemote,
      ensureEditorRemote,
      reportFailure,
      openSettings,
      setEditorLayout,
      pickerBusy,
      pickerCandidates,
      retry,
      selectWorkspacePicker,
      startWorkspacePicker,
      state,
      agentProfiles,
      pendingConfirmation,
      confirmationBusy,
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
