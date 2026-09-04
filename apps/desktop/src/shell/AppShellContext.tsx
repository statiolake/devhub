import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentProfiles,
  AppAppearance,
  AppError,
  AppIntent,
  AppLoadState,
  AppOutcome,
  AppSnapshot,
  ConfirmationPurposeWire,
} from "../ipc/appShell";
import {
  createShellClient,
  type AgentActionWire,
  type AppShellClient,
  type IssueAssignment,
  type RepositoryStatusWire,
  type WorkspacePickerCandidate,
  type WorkspacePickerEvent,
} from "./client";
import {
  PERSISTENCE_DEGRADED_ERROR,
  subscribeToUnhandled,
  toAppError,
} from "./failure";
import { AppShellContext, type AppShellContextValue } from "./useAppShell";

/** What a dispatch came back asking to have confirmed. */
export interface PendingConfirmation {
  readonly confirmationId: string;
  readonly purpose: ConfirmationPurposeWire;
  readonly agentId?: string;
}

export interface AppShellProviderProps {
  readonly client?: AppShellClient;
  /**
   * Where a confirmation goes when main asks for one.
   *
   * The App Shell page does not draw modals — they live one layer up, on the
   * overlay view, so a workbench cannot paint over them. So the page hands the
   * confirmation to main and the overlay page draws it; the overlay's own
   * provider keeps the default, which is to hold it right here, because there
   * the alert *is* the thing on screen.
   */
  readonly raiseConfirmation?: (confirmation: PendingConfirmation) => void;
  readonly children: ReactNode;
}

/**
 * The provider owns transport lifecycle only.
 *
 * Snapshot data is main's projection; the provider keeps no derived workspace,
 * selection or disclosure state of its own, because a second copy of those is
 * a second thing that can be wrong.
 */
export function AppShellProvider({
  client,
  raiseConfirmation,
  children,
}: AppShellProviderProps) {
  const transport = useMemo(() => client ?? createShellClient(), [client]);
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
   * The failure on screen.
   *
   * One rule decides when it goes, and it does not depend on what raised it:
   * the user dismisses it, the user starts another action, or a newer failure
   * replaces it. Nothing that merely arrives can retire it — a projection
   * showing up is not evidence that anything was fixed, and letting one clear
   * the alert is how a reported failure reaches the screen and vanishes before
   * it can be read.
   */
  const [intentError, setIntentError] = useState<AppError | null>(null);
  const [pickerCandidates, setPickerCandidates] = useState<
    WorkspacePickerCandidate[]
  >([]);
  const [repositoryStatus, setRepositoryStatus] =
    useState<RepositoryStatusWire>({ sequence: 0, workspaces: [] });
  const [pickerBusy, setPickerBusy] = useState(false);
  /**
   * How many sources the last run had to ask.
   *
   * Kept because "no sources are configured" and "the sources found nothing"
   * are different things to tell somebody, and the sheet cannot tell them apart
   * from an empty list. `undefined` until a run has started and said.
   */
  const [pickerSourceCount, setPickerSourceCount] = useState<number>();
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);
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
  const pickerEventProcessor = useRef<
    ((event: WorkspacePickerEvent) => void) | null
  >(null);

  /**
   * Route a failure to the one place the shell shows them. Callers that cannot
   * recover do not catch to explain themselves; they hand the failure here.
   */
  const reportFailure = useCallback((error: unknown) => {
    setIntentError(toAppError(error));
  }, []);

  // Whatever the root handler caught is a failure like any other, and it is
  // shown where every other failure is shown.
  useEffect(() => subscribeToUnhandled(setIntentError), []);

  const applySnapshot = useCallback((snapshot: AppSnapshot) => {
    if (snapshot.revision < lastRevision.current) return;
    lastRevision.current = snapshot.revision;
    setState({ status: "ready", snapshot });
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    let active = true;
    const disposers: (() => void)[] = [];
    lastRevision.current = -1;
    lastAppearanceSequence.current = -1;
    lastProfileSequence.current = 0;

    const live = () => active && generation.current === currentGeneration;

    const applyIfActive = (snapshot: AppSnapshot) => {
      if (live()) applySnapshot(snapshot);
    };

    const applyAppearanceIfActive = (next: AppAppearance) => {
      if (!live() || next.sequence < lastAppearanceSequence.current) return;
      lastAppearanceSequence.current = next.sequence;
      setAppearance(next);
    };

    const applyProfilesIfActive = (next: AgentProfiles) => {
      if (!live() || next.sequence <= lastProfileSequence.current) return;
      lastProfileSequence.current = next.sequence;
      setAgentProfiles(next);
    };

    const markProfilesUnavailable = () => {
      if (!live()) return;
      // A local transport fallback, not main's own sequence: do not advance
      // the cursor, or a later same-sequence projection would be discarded.
      setAgentProfiles({
        sequence: Math.max(1, lastProfileSequence.current + 1),
        availability: "unavailable",
        diagnostic: "projection_unavailable",
        profiles: [],
      });
    };

    const processPickerEvent = (event: WorkspacePickerEvent) => {
      if (event.operationId !== pickerOperation.current) return;
      if (event.kind === "started") {
        pickerSequence.current = event.sequence;
        setPickerCandidates([]);
        setPickerSourceCount(event.sourceCount);
        setPickerBusy(true);
        return;
      }
      if (event.sequence <= pickerSequence.current) return;
      pickerSequence.current = event.sequence;
      if (event.kind === "candidate") {
        setPickerCandidates((current) =>
          current.some((item) => item.path === event.path)
            ? current
            : [...current, event].slice(-1000),
        );
      } else if (event.kind === "completed" || event.kind === "cancelled") {
        setPickerBusy(false);
      }
    };
    pickerEventProcessor.current = processPickerEvent;

    const initialize = async () => {
      try {
        // Subscribe before the first query, so an update cannot be missed in
        // the gap between reconstruction and the initial projection.
        disposers.push(transport.subscribe(applyIfActive));
        disposers.push(
          transport.subscribeWorkspacePicker((event) => {
            if (!live()) return;
            if (!pickerOperation.current) {
              pickerBufferedEvents.current = [
                ...pickerBufferedEvents.current,
                event,
              ].slice(-64);
              return;
            }
            processPickerEvent(event);
          }),
        );
        disposers.push(
          transport.subscribeNativeError((error) => {
            if (live()) setIntentError(error);
          }),
        );
        disposers.push(transport.subscribeAppearance(applyAppearanceIfActive));
        disposers.push(
          transport.subscribeRepositoryStatus((status) => {
            // Ordered by the watcher's own sequence, not by arrival: a round
            // that answered late must not replace a newer one.
            if (!live()) return;
            setRepositoryStatus((current) =>
              status.sequence < current.sequence ? current : status,
            );
          }),
        );
        disposers.push(transport.subscribeAgentProfiles(applyProfilesIfActive));

        // Appearance is a non-blocking projection — the shell is usable with
        // its defaults — but "usable with defaults" is a different thing from
        // "the settings you chose are being ignored", and only one of those is
        // worth not saying.
        try {
          applyAppearanceIfActive(await transport.getAppearance());
        } catch (error: unknown) {
          reportFailure(error);
        }
        try {
          applyProfilesIfActive(await transport.getAgentProfiles());
        } catch {
          // Profile discovery failing is not the same as a config with no
          // profiles in it, and the picker must be able to tell them apart.
          markProfilesUnavailable();
        }

        // What the last round found, so a window that opened between two of
        // them draws a branch name now rather than in a minute.
        try {
          const status = await transport.getRepositoryStatus();
          if (live()) {
            setRepositoryStatus((current) =>
              status.sequence < current.sequence ? current : status,
            );
          }
        } catch (error: unknown) {
          reportFailure(error);
        }

        const replay = await transport.replay(lastEventCursor.current);
        if (!live()) return;
        // The replay cursor is independent of the snapshot revision. On a gap,
        // replace the projection with the supplied snapshot before applying
        // any later live notification.
        lastEventCursor.current = replay.cursor;
        applyIfActive(replay.snapshot);
        applyIfActive(await transport.getSnapshot());
      } catch (error) {
        if (live()) {
          setState({ status: "error", error: toAppError(error) });
        }
      }
    };

    void initialize();
    return () => {
      active = false;
      generation.current += 1;
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [applySnapshot, attempt, transport, reportFailure]);

  const dispatch = useCallback(
    async (intent: AppIntent): Promise<AppOutcome | undefined> => {
      const dispatchGeneration = generation.current;
      setIntentError(null);
      try {
        const outcome = await transport.dispatch(intent);
        if (generation.current !== dispatchGeneration) return undefined;
        applySnapshot(outcome.snapshot);
        if (outcome.kind === "persistence_degraded") {
          setIntentError(PERSISTENCE_DEGRADED_ERROR);
        }
        if (outcome.kind === "confirmation_required") {
          (raiseConfirmation ?? setPendingConfirmation)({
            confirmationId: outcome.confirmationId,
            purpose: outcome.purpose,
            // A confirmation can be replaced by main while this one is being
            // submitted. Keep the original Agent identity, because the
            // replacement carries only its token.
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
        setIntentError(toAppError(error));
        return undefined;
      }
    },
    [applySnapshot, transport, pendingConfirmation, raiseConfirmation],
  );

  const retry = useCallback(() => {
    generation.current += 1;
    setIntentError(null);
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  const openExternalUrl = useCallback(
    (url: string) => {
      void transport.openExternalUrl(url).catch(reportFailure);
    },
    [transport, reportFailure],
  );

  const openSettings = useCallback(async () => {
    await transport.openSettings();
  }, [transport]);

  const startWorkspacePicker = useCallback(
    async (query = "") => {
      const requestGeneration = ++pickerStartGeneration.current;
      setPickerBusy(true);
      setPickerCandidates([]);
      pickerOperation.current = null;
      pickerSequence.current = -1;
      pickerBufferedEvents.current = [];
      let operationId: string;
      try {
        operationId = await transport.startWorkspacePicker(query);
      } catch (error: unknown) {
        // Recovers in place: the picker stops claiming to be searching. The
        // failure itself is reported, not explained here.
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
    [transport, reportFailure],
  );

  const cancelWorkspacePicker = useCallback(async () => {
    ++pickerStartGeneration.current;
    pickerOperation.current = null;
    pickerSequence.current = -1;
    pickerBufferedEvents.current = [];
    setPickerCandidates([]);
    setPickerBusy(false);
    try {
      await transport.cancelWorkspacePicker();
    } catch (error: unknown) {
      reportFailure(error);
    }
  }, [transport, reportFailure]);

  const selectWorkspacePicker = useCallback(
    async (path: string, create: boolean) => {
      const outcome = await transport.selectWorkspacePicker(path, create);
      applySnapshot(outcome.snapshot);
      setPickerBusy(false);
      return outcome;
    },
    [applySnapshot, transport],
  );

  const chooseWorkspaceFolder = useCallback(
    () => transport.chooseWorkspaceFolder(),
    [transport],
  );

  /**
   * Start a workspace that does not exist yet.
   *
   * Neither of these reports its failure here. They are the act of one sheet,
   * which is still on screen when they fail and is where the person is going
   * to correct the URL or the path — so the sheet awaits the answer and shows
   * it. What they do share with every other opening is the snapshot that comes
   * back, which is applied the way the picker's own selection is.
   */
  const applyOpening = useCallback(
    (outcome: AppOutcome) => {
      applySnapshot(outcome.snapshot);
      setPickerBusy(false);
      return outcome;
    },
    [applySnapshot],
  );

  const createProject = useCallback(
    async (path: string) => applyOpening(await transport.createProject(path)),
    [applyOpening, transport],
  );

  const cloneProject = useCallback(
    async (url: string, parentDirectory: string) =>
      applyOpening(await transport.cloneProject(url, parentDirectory)),
    [applyOpening, transport],
  );

  const cloneParentDirectories = useCallback(
    () => transport.cloneParentDirectories(),
    [transport],
  );

  const githubLogin = useCallback(() => transport.githubLogin(), [transport]);

  const pullRequestHeadBranch = useCallback(
    (url: string) => transport.pullRequestHeadBranch(url),
    [transport],
  );

  const agentActions = useCallback(() => transport.agentActions(), [transport]);

  const subscribeAgentActions = useCallback(
    (listener: (actions: readonly AgentActionWire[]) => void) =>
      transport.subscribeAgentActions(listener),
    [transport],
  );

  const removeWorktree = useCallback(
    async (workspaceId: string, force: boolean) => {
      const outcome = await transport.removeWorktree(workspaceId, force);
      applySnapshot(outcome.snapshot);
      return outcome;
    },
    [applySnapshot, transport],
  );

  /**
   * Say a configured action to an agent.
   *
   * The snapshot comes back because queueing changes the agent's `injection`,
   * which is what the shortcut buttons read to say a message is waiting. The
   * failure is reported rather than swallowed: a button that silently does
   * nothing is the worst of the three things it could do.
   */
  const runAgentAction = useCallback(
    async (agentId: string, actionId: string) => {
      const outcome = await transport.runAgentAction(agentId, actionId);
      applySnapshot(outcome.snapshot);
      return outcome;
    },
    [applySnapshot, transport],
  );

  /**
   * The two ends of a reviewed message, and both bring the snapshot back.
   *
   * Confirming and cancelling both change what the agent's row says about its
   * queue — waiting for a prompt, or cancelled — so the page is handed the
   * state that says so rather than finding out on the next poll, exactly as
   * queueing one does.
   */
  const confirmInjection = useCallback(
    async (agentId: string, injectionId: string, text: string) => {
      const outcome = await transport.confirmInjection(
        agentId,
        injectionId,
        text,
      );
      applySnapshot(outcome.snapshot);
      return outcome;
    },
    [applySnapshot, transport],
  );

  const cancelInjection = useCallback(
    async (agentId: string, injectionId: string) => {
      const outcome = await transport.cancelInjection(agentId, injectionId);
      applySnapshot(outcome.snapshot);
      return outcome;
    },
    [applySnapshot, transport],
  );

  const projectDefaultDirectory = useCallback(
    () => transport.projectDefaultDirectory(),
    [transport],
  );

  /**
   * The Issue flow's four steps.
   *
   * None of them reports its own failure, for the same reason the two project
   * sheets do not: the wizard is still on screen, and a failure there is
   * answered by re-asking the question that caused it. The one that changes the
   * app — `assignIssue` — hands its snapshot on the way every other opening
   * does.
   */
  const findIssueRepositories = useCallback(
    (issueUrl: string) => transport.findIssueRepositories(issueUrl),
    [transport],
  );

  const cloneRepository = useCallback(
    (url: string, parentDirectory: string) =>
      transport.cloneRepository(url, parentDirectory),
    [transport],
  );

  const listBranches = useCallback(
    (directory: string) => transport.listBranches(directory),
    [transport],
  );

  const assignIssue = useCallback(
    async (request: IssueAssignment) =>
      applyOpening(await transport.assignIssue(request)),
    [applyOpening, transport],
  );

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
      // Keep the confirmation available when the request itself failed. A
      // successful confirmation consumes the one-shot operation in main; a
      // failure has to stay retryable without inventing a second local state.
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

  // A dispatch failure stays until something replaces it, which for a failure
  // needing no further action means it never leaves on its own. The user gets
  // to put it away; the next dispatch re-raises it if it is still there.
  const dismissIntentError = useCallback(() => {
    setIntentError(null);
  }, []);

  const dismissCloseConfirmation = useCallback(() => {
    setPendingConfirmation(null);
  }, []);

  /**
   * Take on a confirmation raised somewhere else.
   *
   * The overlay page is told what to ask by main, not by a dispatch of its
   * own; adopting it here is what lets the confirmation behave exactly as one
   * raised in place, down to the retry-on-failure rule.
   */
  const adoptConfirmation = useCallback((confirmation: PendingConfirmation) => {
    setPendingConfirmation((current) =>
      current?.confirmationId === confirmation.confirmationId
        ? current
        : confirmation,
    );
  }, []);

  const value = useMemo<AppShellContextValue>(
    () => ({
      state,
      appearance,
      intentError,
      dismissIntentError,
      reportFailure,
      dispatch,
      retry,
      openExternalUrl,
      openSettings,
      pickerCandidates,
      pickerBusy,
      pickerSourceCount,
      startWorkspacePicker,
      cancelWorkspacePicker,
      selectWorkspacePicker,
      chooseWorkspaceFolder,
      createProject,
      cloneProject,
      projectDefaultDirectory,
      cloneParentDirectories,
      githubLogin,
      pullRequestHeadBranch,
      agentActions,
      subscribeAgentActions,
      removeWorktree,
      runAgentAction,
      confirmInjection,
      cancelInjection,
      findIssueRepositories,
      cloneRepository,
      listBranches,
      assignIssue,
      agentProfiles,
      repositoryStatus,
      pendingConfirmation,
      confirmationBusy,
      confirmPending,
      dismissCloseConfirmation,
      adoptConfirmation,
    }),
    [
      adoptConfirmation,
      agentProfiles,
      appearance,
      cancelWorkspacePicker,
      chooseWorkspaceFolder,
      cloneProject,
      createProject,
      projectDefaultDirectory,
      cloneParentDirectories,
      githubLogin,
      pullRequestHeadBranch,
      agentActions,
      subscribeAgentActions,
      removeWorktree,
      runAgentAction,
      confirmInjection,
      cancelInjection,
      findIssueRepositories,
      cloneRepository,
      listBranches,
      assignIssue,
      confirmPending,
      confirmationBusy,
      dismissCloseConfirmation,
      dismissIntentError,
      dispatch,
      intentError,
      openExternalUrl,
      openSettings,
      pendingConfirmation,
      pickerBusy,
      pickerCandidates,
      pickerSourceCount,
      reportFailure,
      repositoryStatus,
      retry,
      selectWorkspacePicker,
      startWorkspacePicker,
      state,
    ],
  );

  return (
    <AppShellContext.Provider value={value}>
      {children}
    </AppShellContext.Provider>
  );
}
