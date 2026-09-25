/**
 * What the questions page holds, and the whole of it.
 *
 * The projection the sheets read, the agent profiles and actions they offer,
 * every way of starting a Workspace, the two ends of a reviewed message, and
 * the confirmation this page is the one place in DevHub that can both show and
 * answer. Nothing else — no appearance, no repository status, no window title,
 * no notices: a sheet draws none of them, and its bridge cannot spell them
 * either. See `PickerBridge` in `ipc/contract.ts` and `preload/picker.ts`.
 *
 * The modal *set* is not here. It is subscribed to as `PickerApp`'s module is
 * evaluated, because main publishes it from the page's `did-finish-load` —
 * before any React effect has run, which is why the first modal of a session
 * used to be pushed to nobody at all.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentLaunchWire,
  AgentProfiles,
  AppIntent,
  AppLoadState,
  AppOutcome,
} from "../../ipc/appShell";
import type {
  AgentActionWire,
  AssignmentBranchWire,
  GitHubLoginWire,
  IssueAssignment,
  IssueRepository,
  PastSessionWire,
  SshHostWire,
  WorkspacePickerCandidate,
  WorkspacePickerEvent,
  WorkspacePlaceWire,
} from "../../ipc/contract";
import { devhub } from "./client";
import {
  useAgentProfiles,
  useProjection,
  useRaiseFailure,
  type PendingConfirmation,
} from "../model/pageModel";

export interface PickerValue {
  readonly state: AppLoadState;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  readonly reportFailure: (error: unknown) => void;
  readonly agentProfiles: AgentProfiles;

  readonly pickerCandidates: readonly WorkspacePickerCandidate[];
  readonly pickerBusy: boolean;
  /** How many sources the last picker run asked; undefined before the first. */
  readonly pickerSourceCount: number | undefined;
  readonly startWorkspacePicker: (query?: string) => Promise<void>;
  readonly cancelWorkspacePicker: () => Promise<void>;
  /**
   * Open the folder a picker row named — making it first when the row said it
   * is not there yet, which only a date source's row ever does.
   */
  readonly selectWorkspacePicker: (
    path: string,
    create: boolean,
    withAgent?: AgentLaunchWire,
  ) => Promise<AppOutcome | undefined>;
  readonly chooseWorkspaceFolder: () => Promise<string | undefined>;
  /** The machines `~/.ssh/config` names, read fresh when the picker opens. */
  readonly listSshHosts: () => Promise<readonly SshHostWire[]>;
  /** Open a folder on another machine as a Workspace. */
  readonly openSshWorkspace: (
    host: string,
    path: string,
    withAgent?: AgentLaunchWire,
  ) => Promise<AppOutcome | undefined>;
  /** Which file makes this folder a Dev Container, if any does. */
  readonly devContainerConfig: (path: string) => Promise<string | undefined>;
  /** Build or start this folder's container, then open it as a Workspace. */
  readonly openContainerWorkspace: (
    workspaceFolder: string,
    withAgent?: AgentLaunchWire,
  ) => Promise<AppOutcome | undefined>;
  /** Make a folder and open it. Throws what to do about it when it cannot. */
  readonly createProject: (
    path: string,
    withAgent?: AgentLaunchWire,
  ) => Promise<AppOutcome>;
  /** Clone into `parentDirectory` and open what git made. Throws git's reason. */
  readonly cloneProject: (
    url: string,
    parentDirectory: string,
    withAgent?: AgentLaunchWire,
  ) => Promise<AppOutcome>;
  readonly projectDefaultDirectory: () => Promise<string>;
  /** Where a clone could go: the parents of everything the sources find. */
  readonly cloneParentDirectories: (
    signal?: AbortSignal,
  ) => Promise<readonly string[]>;
  /**
   * Which GitHub account this machine is signed in as, so a bare repository
   * name means what `gh repo clone` would mean by it. Answers with the reason
   * rather than throwing when it cannot say.
   */
  readonly githubLogin: () => Promise<GitHubLoginWire>;
  /** A profile's earlier sessions in a Workspace. Throws the reason it cannot list them. */
  readonly listPastSessions: (
    workspaceId: string,
    profileId: string,
  ) => Promise<readonly PastSessionWire[]>;
  /**
   * The four steps of assigning an Issue. Each throws what to do about it when
   * it fails, because each is answered by re-asking the question that led to
   * it — which is the wizard's rule, not a special case for these.
   */
  readonly findIssueRepositories: (
    issueUrl: string,
    /**
     * Stops the lookup in main, and the `gh` or `git` it started with it.
     *
     * Here rather than on a separate `cancel…()` the caller has to remember to
     * pair with this one: the signal arrives with the call it belongs to, so
     * there is no way to start a lookup and forget how to stop it.
     */
    signal?: AbortSignal,
  ) => Promise<readonly IssueRepository[]>;
  readonly cloneRepository: (
    url: string,
    parentDirectory: string,
  ) => Promise<string>;
  readonly assignmentBranch: (
    url: string,
    place: WorkspacePlaceWire,
    signal?: AbortSignal,
  ) => Promise<AssignmentBranchWire>;
  readonly listBranches: (
    place: WorkspacePlaceWire,
  ) => Promise<readonly string[]>;
  readonly assignIssue: (request: IssueAssignment) => Promise<AppOutcome>;

  /** The ways of starting an agent on an Issue, as Settings lists them. */
  readonly agentActions: () => Promise<readonly AgentActionWire[]>;
  /** Say one of them to a running agent. Queued, not sent. */
  readonly runAgentAction: (
    agentId: string,
    actionId: string,
  ) => Promise<AppOutcome>;
  /**
   * The wording, as the person settled on it. Confirming does not send it.
   *
   * What it removes is the queue's reason for refusing; when the text actually
   * goes is still the idle gate's decision, and may already have been reached.
   */
  readonly confirmInjection: (
    agentId: string,
    injectionId: string,
    text: string,
  ) => Promise<AppOutcome>;
  /** Drop a queued message without sending it. The agent keeps running. */
  readonly cancelInjection: (
    agentId: string,
    injectionId: string,
  ) => Promise<AppOutcome>;
  /**
   * Answer the three-way question about a worktree main is closing.
   *
   * The page answers a question main asked. It does not decide `--force`, and
   * it does not carry out either answer itself. Throws git's reason.
   */
  readonly answerWorktreeClose: (
    workspaceId: string,
    answer: "close" | "delete",
  ) => Promise<AppOutcome>;

  readonly pendingConfirmation: PendingConfirmation | null;
  /**
   * Answer the pending confirmation, and say whether it was carried out.
   *
   * `false` is a request main refused: the confirmation is still there, still
   * retryable — main's one-shot operation was not consumed — and the caller is
   * the only thing in a position to say so where the question was asked. A
   * `void` here is how a close that quietly did not happen looked exactly like
   * one that did.
   */
  readonly confirmPending: () => Promise<boolean>;
  readonly dismissCloseConfirmation: () => void;
  /** Take on a confirmation main raised, as if it had been raised here. */
  readonly adoptConfirmation: (confirmation: PendingConfirmation) => void;
}

export const PickerContext = createContext<PickerValue | null>(null);

export function usePicker(): PickerValue {
  const value = useContext(PickerContext);
  if (!value) {
    throw new Error("usePicker must be used inside PickerProvider");
  }
  return value;
}

export function PickerProvider({ children }: { children: ReactNode }) {
  const bridge = useMemo(() => devhub(), []);
  const reportFailure = useRaiseFailure(bridge);

  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);
  /**
   * One answer at a time, and the whole of what that costs.
   *
   * A ref rather than state, because nothing draws it: the picker that asks
   * the question shows the wait on the row that was taken. This only stops a
   * second Return from sending main a confirmation it has already consumed.
   */
  const confirmationBusyRef = useRef(false);

  // The sheet is drawn *here*, so a confirmation is held right here: this is
  // the one page in DevHub where a question can be both seen and answered.
  const { state, dispatch, applySnapshot, attempt } = useProjection(
    bridge,
    reportFailure,
    setPendingConfirmation,
  );
  const agentProfiles = useAgentProfiles(bridge, attempt);
  const picker = useWorkspacePickerRun(bridge, reportFailure);

  /**
   * Every way of opening a Workspace ends the same way.
   *
   * The snapshot that came back is applied the way the picker's own selection
   * is, and the search that was running is over because what it was searching
   * for has been found. Neither of the project sheets reports its own failure:
   * the sheet is still on screen when it fails and is where the person is
   * going to correct the URL or the path.
   */
  const applyOpening = useCallback(
    (outcome: AppOutcome) => {
      applySnapshot(outcome.snapshot);
      picker.settle();
      return outcome;
    },
    [applySnapshot, picker],
  );

  const confirmPending = useCallback(async (): Promise<boolean> => {
    if (!pendingConfirmation || confirmationBusyRef.current) return false;
    confirmationBusyRef.current = true;
    const confirmationId = pendingConfirmation.confirmationId;
    try {
      // One answer per purpose, and every purpose has one. There used to be a
      // guard above this that cleared the confirmation and reported *success*
      // when an `agent_stop` had no Agent id — so main's one-shot confirmation
      // was stranded, the Agent was not stopped, and the sheet closed as
      // though it had been. The purpose carries its subject now, and there is
      // no such state left to guard.
      const outcome: AppOutcome | undefined = await dispatch(
        pendingConfirmation.purpose.kind === "agent_stop"
          ? { type: "confirm_stop_agent", confirmationId }
          : { type: "confirm_close_workspace", confirmationId },
      );
      // Keep the confirmation available when the request itself failed. A
      // successful confirmation consumes the one-shot operation in main; a
      // failure has to stay retryable without inventing a second local state.
      if (outcome) {
        setPendingConfirmation((current) =>
          current?.confirmationId === confirmationId ? null : current,
        );
      }
      return outcome !== undefined;
    } finally {
      confirmationBusyRef.current = false;
    }
  }, [dispatch, pendingConfirmation]);

  const adoptConfirmation = useCallback((confirmation: PendingConfirmation) => {
    setPendingConfirmation((current) =>
      current?.confirmationId === confirmation.confirmationId
        ? current
        : confirmation,
    );
  }, []);

  const value = useMemo<PickerValue>(
    () => ({
      state,
      dispatch,
      reportFailure,
      agentProfiles,

      pickerCandidates: picker.candidates,
      pickerBusy: picker.busy,
      pickerSourceCount: picker.sourceCount,
      startWorkspacePicker: picker.start,
      cancelWorkspacePicker: picker.cancel,
      selectWorkspacePicker: async (path, create, withAgent) =>
        applyOpening(
          await bridge.selectWorkspacePicker(path, create, withAgent),
        ),
      chooseWorkspaceFolder: () => bridge.chooseWorkspaceFolder(),
      listSshHosts: () => bridge.listSshHosts(),
      openSshWorkspace: async (host, path, withAgent) =>
        applyOpening(await bridge.openSshWorkspace(host, path, withAgent)),
      devContainerConfig: (path) => bridge.devContainerConfig(path),
      openContainerWorkspace: async (workspaceFolder, withAgent) =>
        applyOpening(
          await bridge.openContainerWorkspace(workspaceFolder, withAgent),
        ),
      createProject: async (path, withAgent) =>
        applyOpening(await bridge.createProject(path, withAgent)),
      cloneProject: async (url, parentDirectory, withAgent) =>
        applyOpening(
          await bridge.cloneProject(url, parentDirectory, withAgent),
        ),
      projectDefaultDirectory: () => bridge.projectDefaultDirectory(),
      cloneParentDirectories: (signal) => {
        signal?.addEventListener("abort", () => {
          void bridge.cancelPickerLookup();
        });
        return bridge.cloneParentDirectories();
      },
      githubLogin: () => bridge.githubLogin(),
      listPastSessions: (workspaceId, profileId) =>
        bridge.listPastSessions(workspaceId, profileId),
      findIssueRepositories: (issueUrl, signal) => {
        // Main keeps one lookup and cancels it by name of being the one that is
        // running, so there is nothing to pass and nothing to match up.
        signal?.addEventListener("abort", () => {
          void bridge.cancelPickerLookup();
        });
        return bridge.findIssueRepositories(issueUrl);
      },
      cloneRepository: (url, parentDirectory) =>
        bridge.cloneRepository(url, parentDirectory),
      assignmentBranch: (url, place, signal) => {
        signal?.addEventListener("abort", () => {
          void bridge.cancelPickerLookup();
        });
        return bridge.assignmentBranch(url, place);
      },
      listBranches: (place) => bridge.listBranches(place),
      assignIssue: async (request) =>
        applyOpening(await bridge.assignIssue(request)),

      agentActions: () => bridge.agentActions(),
      runAgentAction: async (agentId, actionId) => {
        const outcome = await bridge.runAgentAction(agentId, actionId);
        applySnapshot(outcome.snapshot);
        return outcome;
      },
      // Confirming and cancelling both change what the agent's row says about
      // its queue — waiting for a prompt, or cancelled — so the page is handed
      // the state that says so rather than finding out on the next poll.
      confirmInjection: async (agentId, injectionId, text) => {
        const outcome = await bridge.confirmInjection(
          agentId,
          injectionId,
          text,
        );
        applySnapshot(outcome.snapshot);
        return outcome;
      },
      cancelInjection: async (agentId, injectionId) => {
        const outcome = await bridge.cancelInjection(agentId, injectionId);
        applySnapshot(outcome.snapshot);
        return outcome;
      },
      answerWorktreeClose: async (workspaceId, answer) => {
        const outcome = await bridge.answerWorktreeClose(workspaceId, answer);
        applySnapshot(outcome.snapshot);
        return outcome;
      },

      pendingConfirmation,
      confirmPending,
      dismissCloseConfirmation: () => {
        setPendingConfirmation(null);
      },
      adoptConfirmation,
    }),
    [
      adoptConfirmation,
      agentProfiles,
      applyOpening,
      applySnapshot,
      bridge,
      confirmPending,
      dispatch,
      pendingConfirmation,
      picker,
      reportFailure,
      state,
    ],
  );

  return (
    <PickerContext.Provider value={value}>{children}</PickerContext.Provider>
  );
}

interface WorkspacePickerRun {
  readonly candidates: readonly WorkspacePickerCandidate[];
  readonly busy: boolean;
  readonly sourceCount: number | undefined;
  readonly start: (query?: string) => Promise<void>;
  readonly cancel: () => Promise<void>;
  /** A Workspace was opened, so whatever was being searched for is found. */
  readonly settle: () => void;
}

/**
 * One run of the workspace search, and what makes it one run.
 *
 * Main streams candidates as it finds them, on a channel that is open before
 * anything has asked for a search — so an event can arrive for an operation
 * this page has not been told the id of yet. Those are buffered rather than
 * dropped: a buffer of the last 64 is the difference between a picker that
 * lists what the first source found and one that lists nothing until the
 * second source answers.
 *
 * Everything else here is ordering. A run has an id and a sequence; an event
 * belonging to an earlier run, or arriving out of order within this one, is
 * discarded rather than appended, because a candidate list assembled out of
 * order is a list whose rows move under the pointer.
 */
function useWorkspacePickerRun(
  bridge: ReturnType<typeof devhub>,
  reportFailure: (error: unknown) => void,
): WorkspacePickerRun {
  const [candidates, setCandidates] = useState<WorkspacePickerCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * How many sources the last run had to ask.
   *
   * Kept because "no sources are configured" and "the sources found nothing"
   * are different things to tell somebody, and the sheet cannot tell them
   * apart from an empty list. `undefined` until a run has started and said.
   */
  const [sourceCount, setSourceCount] = useState<number>();

  const operation = useRef<string | null>(null);
  const sequence = useRef(-1);
  const startGeneration = useRef(0);
  const buffered = useRef<WorkspacePickerEvent[]>([]);

  const process = useCallback((event: WorkspacePickerEvent) => {
    if (event.operationId !== operation.current) return;
    if (event.kind === "started") {
      sequence.current = event.sequence;
      setCandidates([]);
      setSourceCount(event.sourceCount);
      setBusy(true);
      return;
    }
    if (event.sequence <= sequence.current) return;
    sequence.current = event.sequence;
    if (event.kind === "candidate") {
      setCandidates((current) =>
        current.some((item) => item.path === event.path)
          ? current
          : [...current, event].slice(-1000),
      );
    } else if (event.kind === "completed" || event.kind === "cancelled") {
      setBusy(false);
    }
  }, []);

  const processRef = useRef(process);
  processRef.current = process;

  // Subscribed once, outside any run: a run's events can begin arriving before
  // the call that started it has answered with its id, and an event with no
  // run to belong to yet is buffered rather than dropped.
  useEffect(
    () =>
      bridge.onWorkspacePicker((event) => {
        if (!operation.current) {
          buffered.current = [...buffered.current, event].slice(-64);
          return;
        }
        processRef.current(event);
      }),
    [bridge],
  );

  const start = useCallback(
    async (query = "") => {
      const generation = ++startGeneration.current;
      setBusy(true);
      setCandidates([]);
      operation.current = null;
      sequence.current = -1;
      buffered.current = [];
      let operationId: string;
      try {
        operationId = await bridge.startWorkspacePicker(query);
      } catch (error: unknown) {
        // Recovers in place: the picker stops claiming to be searching. The
        // failure itself is reported, not explained here.
        if (generation === startGeneration.current) {
          setBusy(false);
          reportFailure(error);
        }
        return;
      }
      if (generation !== startGeneration.current) return;
      operation.current = operationId;
      sequence.current = -1;
      const pending = buffered.current;
      buffered.current = [];
      for (const event of pending) {
        if (event.operationId === operationId) processRef.current(event);
      }
    },
    [bridge, reportFailure],
  );

  const cancel = useCallback(async () => {
    ++startGeneration.current;
    operation.current = null;
    sequence.current = -1;
    buffered.current = [];
    setBusy(false);
    setCandidates([]);
    await bridge.cancelWorkspacePicker();
  }, [bridge]);

  const settle = useCallback(() => {
    setBusy(false);
  }, []);

  return useMemo(
    () => ({ candidates, busy, sourceCount, start, cancel, settle }),
    [busy, cancel, candidates, settle, sourceCount, start],
  );
}
