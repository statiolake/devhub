/**
 * The App Shell, in the main process.
 *
 * Everything DevHub is outside VS Code meets here: the model that owns
 * Workspaces and Agents, the config file, the state file, the workbench views,
 * and the page that draws all of it. The shape is the Tauri app's, with the
 * transport swapped — and one rule from that design is what keeps this file
 * from becoming a pile of async callbacks:
 *
 * **The model never performs an effect.** It emits one, tagged with a token,
 * and this file performs it and hands the result back. So every path into the
 * model is `dispatch` or `accept`, every path out is an effect, and a stale
 * answer to a superseded operation is rejected rather than applied to whatever
 * happens to be current.
 */

import { APP_ROOT } from "./appRoot.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, posix } from "node:path";
import { devhubProduct } from "../product.js";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { noteMainActivity } from "../diagnostics/eventLoopLag.js";
import { SaveCoalescer } from "./saveCoalescer.js";
import { PaneActivityTracker } from "../terminal/paneActivity.js";
import {
	FailureOnce,
	terminalActivityHost,
	terminalObservations,
} from "./terminalActivityLoop.js";
import {
	metricsReport,
	type TerminalLauncherStatus,
} from "../diagnostics/metrics.js";
import { NoticeJournal } from "../diagnostics/notices.js";
import { reconcileRounds } from "../diagnostics/rounds.js";
import { electron } from "../electron.js";
import {
	CHANNELS,
	type AgentActionWire,
	type ChordHelpRowWire,
	type NoticeSettingsWire,
	type LayoutPreviewWire,
	type AssignmentBranchWire,
	type IssueAssignment,
	type IssueFolderRequest,
	type WorkspacePlaceWire,
	type BranchListWire,
	type PastSessionWire,
	type ResumeElsewhereWire,
	type ModalRequest,
	type RepositoryStatusWire,
	EMPTY_BOARD,
	type OrchestratorViewWire,
	type ContextMenuRequestWire,
	type TooltipRequestWire,
	type UsageLimitsWire,
	type WorkspacePickerEvent,
} from "../../ipc/contract.js";
import {
	appConditionIdentity,
	appFailureIdentity,
	type AgentLaunchWire,
	type AgentProfiles,
	type AppAppearance,
	type AppErrorWire,
	type AppIntentWire,
	type AppOutcomeWire,
	type AppSnapshotWire,
	type CloseDiagnosticWire,
	type EditorAttachmentWire,
	type NoticeRetiredWire,
	type ReplayWire,
	sidebarWorkspaces,
} from "../../ipc/appShell.js";
import { placeWorkspaceBelow } from "../../model/workspaceOrder.js";
import { AppCoordinator, type Effect } from "../../model/coordinator.js";
import {
	CLOSE_BUDGET_MS,
	CloseTimeout,
	sessionsLeftRunning,
	sessionsLeftRunningDetail,
	withCloseDeadline,
} from "./cleanupDeadline.js";
import { canonicalise, type ResolvedPath } from "../cli/canonical.js";
import { resolvePathCandidates } from "../agent/conversation/pathLinks.js";
import {
	embedSignature,
	readEmbedFile,
} from "../agent/conversation/embedFiles.js";
import type { FileSelection } from "../cli/fileSelection.js";
import { WaitSelectionReturns } from "../cli/waitReturn.js";
import type { ControlOpenRequest, ControlPosition } from "../cli/protocol.js";
import { workspaceRootFor } from "../cli/resolve.js";
import { isDevhubLink } from "../../model/devhubLink.js";
import { fileSelection } from "../agent/conversation/pathLinks.js";
import {
	routeAgentOpen,
	routeOpen,
	type OpenDestination,
	type OpenReason,
	type RoutableWorkspace,
} from "../cli/route.js";
import {
	AgentProfile,
	type AgentPresentation,
	agentPresentation,
	agentsInspection,
	agentProfileId,
	displayPath,
	locationKey,
	agentId as parseAgentId,
	containerTargetFromHostId,
	workspaceId as parseWorkspaceId,
	workspaceLocation,
	sessionId,
	type Agent,
	type AgentId,
	type AgentProfileKind,
	type AgentReconciliation,
	type CloseStep,
	type CloseInspectionInputs,
	type Workspace,
	type WorkspaceId,
	type WorkspaceLocation,
} from "../../model/domain.js";
import { readSshHosts } from "./sshHosts.js";
import {
	operationId as parseOperationId,
	type OperationId,
	confirmationId as parseConfirmationId,
	intentId as parseIntentId,
	requestedAtPath,
	requestedLocation,
	whereRequested,
	type RequestedWorkspaceLocation,
	type AgentProfileResolution,
	type IntentOutcome,
	type OperationToken,
	type ProviderEvent,
	type IntentFocus,
	type UserIntent,
	type WorktreeDisposition,
} from "../../model/intents.js";
import { closingDeletesWorktree } from "../../model/worktrees.js";
import { zoomedTerminalFontSize } from "../../model/terminalZoom.js";
import {
	agentSubject,
	portRefusal,
	refusalWire,
	type OperationRefusal,
	type RefusedOperation,
} from "./agentFailure.js";
import { AppModel, type NavigationSelection } from "../../model/appModel.js";
import { activeProfile } from "../../model/profile.js";
import {
	customThemesOf,
	themeSelectionOf,
	type Config,
} from "../../model/config.js";
import {
	applySnapshot,
	hydrateModel,
	JsonStateStore,
	markCleanShutdown,
	markStarting,
	StateError,
	type PersistedAppState,
} from "../../model/persistence.js";
import {
	agentProfilesWire,
	appearanceWire,
	errorWire,
	errorWireAt,
	intentFromWire,
	outcomeWire,
	replayWire,
	setRuntimeVersion,
	snapshotWire,
	drawnWorkspaceOrder,
	NamedFailure,
	namedFailure,
	namedFailureAt,
	fileNotFound,
	withDetail,
	withSummary,
	failureText,
} from "../../model/wire.js";
import {
	shellWindow,
	shellWindowIfCreated,
	type ContentFocus,
	type ShellWindow,
} from "./shellWindow.js";
import type { KeyboardHalf, SurfaceArrangement } from "./windowLayout.js";
import {
	agentTerminalSessionName,
	clampTerminalShare,
} from "../../model/agentTerminal.js";
import type { MarkedPane } from "../terminal/tmux.js";
import {
	chromeAudience,
	displayAudience,
	projectionAudience,
} from "./publishAudience.js";
import { WindowAttention, platformDock } from "./windowAttention.js";
import { AgentNotifier, type AgentNotification } from "./agentNotifications.js";

/**
 * Which app-wide condition the repository watcher's diagnostic is.
 *
 * One source, so one name: every look publishes either a reason the last round
 * was incomplete or nothing at all, so a notice raised under this name is
 * replaced or retracted by the next look and by nothing else.
 */
const REPOSITORY_STATUS_CONDITION = "repository_status";
import { crash, isInvariantViolation } from "./invariant.js";
import { InvariantViolation } from "../../model/invariant.js";
import { HostLinkFailure } from "../agent/conversation/hostLink.js";
import { ConversationStopped } from "../agent/conversation/failures.js";
import { appearanceMode } from "./appearanceMode.js";
import { mainLogPath } from "../diagnostics/mainLog.js";
import {
	orchestratorViewWire,
	shellTitleFor,
	type OrchestratorTitleView,
} from "./shellTitle.js";
import type { ShellPalette } from "../../ipc/palette.js";
import { agents, inspectWorkspaceResources, terminals } from "./adapters.js";
import { wireTerminals, type TerminalWiring } from "./terminalWiring.js";
import { REPOSITORY_LOOKUP_DEADLINE_MS } from "../runtime/cadence.js";
import {
	CancellationToken,
	scratchTarget,
	socketName,
	workspaceTarget,
	type TerminalPreflight,
	type WorkspaceTerminalTarget,
} from "../terminal/ports.js";
import { remoteProfileTag } from "../terminal/launcher.js";
import { controlSocketPath } from "../cli/protocol.js";
import { OperationDeadline } from "../terminal/command.js";
import {
	cacheKeepSettingsOf,
	limitResumeSettingsOf,
	wireAgents,
	type AgentWiring,
} from "./agentWiring.js";
import { EngineClient, electronEngineLauncher } from "../agentEngine/client.js";
import { enginePagePorts } from "../agentEngine/pagePorts.js";
import { PtyHostClient, electronPtyHostLauncher } from "../ptyHost/client.js";
import {
	NeovimHostClient,
	electronNeovimHostLauncher,
} from "../neovimHost/client.js";
import { EscalationStore } from "../orchestrator/escalationStore.js";
import {
	OrchestratorService,
	type LiveAgent,
} from "../orchestrator/orchestratorService.js";
import {
	ensureOrchestratorRoot,
	expandOrchestratorRoot,
} from "../orchestrator/root.js";
import { importEscalationFiles } from "../orchestrator/escalationFiles.js";
import {
	insideRoot,
	listFolder,
	OrchestratorFileError,
	readRootFile,
	rootProblem,
	watchRoot,
} from "../orchestrator/orchestratorFiles.js";
import { workspaceToken } from "../orchestrator/events.js";
import { GitHubItemSource } from "../orchestrator/githubItems.js";
import { KeptFile } from "../orchestrator/keptFile.js";
import {
	ISSUE_LINK_KEY,
	issueLinkOf,
	type InvariantAgent,
	type PullFacts,
} from "../orchestrator/invariant.js";
import { registerConversationIpc } from "./conversationIpc.js";
import {
	MICROPHONE_SETTINGS_URL,
	registerVoiceIpc,
} from "../voice/voiceIpc.js";
import { locateWhisper, whisperCandidates } from "../voice/whisper.js";
import { AgentDrafts } from "../agent/conversation/drafts.js";
import { AgentRecords } from "../agent/conversation/agentRecords.js";
import { SessionMetaFile } from "../agent/conversation/sessionMetaFile.js";
import { SessionMetaKeeper, type KnownSession } from "./sessionMetaKeeper.js";
import {
	LIMIT_RESUME_RECORDS,
	type LimitResumeRecord,
} from "../agent/conversation/limitResume.js";
import {
	UsageLimits,
	usageLimitsListener,
	usageReadingListener,
} from "./usageLimits.js";
import { spawnLineProcess, startUsageReaders } from "./usageReaders.js";
import {
	UsageThresholdWatch,
	usageWindowOf,
} from "../orchestrator/usageThresholds.js";
import { agentHostFiles } from "../agent/conversation/hostCommand.js";
import { AgentReconcilers, type ReconcileHost } from "./agentReconciler.js";
import { AppConditions } from "./appConditions.js";
import { MachineConditions } from "./machineConditions.js";
import {
	disposeRuntime,
	liveRuntimes,
	localRuntime,
	runtimeById,
	runtimeForRequested,
	runtimeFor,
	runtimeIdFor,
	runtimeMachine,
	setRuntimeProfile,
} from "../runtime/registry.js";
import {
	ReleaseToolDelivery,
	toolInstallDirectory,
	type HostTool,
} from "../runtime/toolDelivery.js";
import { bundledToolDelivery } from "../runtime/bundledTool.js";
import type {
	Runtime,
	RuntimeId,
	TerminalLauncher,
} from "../runtime/runtime.js";
import { resolveAgentProfile } from "./agentProfileCommand.js";
import {
	carryClaudeSession,
	claudeSessionPresent,
	listPastSessions,
	previewPastSession,
	resumeArgs,
	resumedSession,
	withSession,
	type ListingContext,
	type RepositoryWorktrees,
} from "../agent/conversation/resume.js";
import { repositoryWorktrees, resumeFolder } from "./sessionWorktree.js";
import {
	rememberSessionName,
	sessionNameOf,
	type SessionNameKind,
} from "../../model/sessionNames.js";
import {
	agentEntriesOf,
	closedEntryDetail,
	closedEntryLabel,
	closeRemembers,
	placeKey,
	placeLabel,
	rememberClosed,
	restoreEntry,
	resumableSession,
	withoutEntry,
	type ClosedAgentRecord,
	type ClosedEntryRecord,
	type ClosedPlaceRecord,
	type ClosedWorktreeRecord,
} from "../../model/recentlyClosed.js";
import {
	readClaudeDefaults,
	writeClaudeDefault,
} from "../agent/conversation/claude/defaults.js";
import {
	readCodexDefaults,
	writeCodexDefault,
} from "../agent/conversation/codex/defaults.js";
import { completionRefusal, refusalOf } from "./completionRefusal.js";
import {
	executableMissingMessage,
	type SettingsUnavailableRuntimeWire,
} from "../../ipc/settings.js";
import {
	adoptLoginEnvironment,
	launchEnvironment,
	loginEnvironmentSummary,
	resolveLoginEnvironment,
	type LoginEnvironment,
} from "./loginEnvironment.js";
import { onRuntimeConnected } from "../runtime/connectivity.js";
import { SessionSweeper } from "./sessionSweep.js";
import {
	collectParentDirectories,
	startWorkspacePicker,
} from "./workspacePicker.js";
import {
	cloneParentChoices,
	cloneProject,
	createProject,
	defaultProjectDirectory,
	ensureWorkspaceFolder,
} from "./projects.js";
import {
	ensureWorktree,
	listBranchCandidates,
	repositoryName,
	issueBranchPlan,
	fetchBranchFrom,
	fetchOriginFirst,
	findBranch,
	prepareIssueCheckout,
	remoteForRepository,
	listBranches,
	workspaceFailure,
	worktreeForBranch,
	type GitCommand,
} from "./git.js";
import { disposeWorktreeFolder, readWorktreeFolder } from "./worktreeFolder.js";
import { findClones } from "./issues.js";
import {
	postGraphQl,
	readGitHubLogin,
	readGitHubToken,
	readIssueLinkedBranch,
	readPullRequestHead,
} from "./github.js";
import {
	gitHubItemUrl,
	issueNumberFromBranch,
	parseGitHubItemUrl,
} from "../../model/github.js";
import { requestId, type Usage } from "../../model/conversation.js";
import type { GitHubItem } from "../../model/github.js";
import { issuePromptReview, toDomainProfile } from "./issueAssignment.js";
import {
	renderAgentAction,
	smartButtonValues,
} from "../../model/agentActions.js";
import type { ConfiguredAgentAction } from "../../model/config.js";
import { AutomaticActions } from "../../model/automaticActions.js";
import type { RunningSettings } from "./runningSettings.js";
import { type ScratchDay, ScratchFollower, scratchDay } from "./scratchDay.js";
import { shellThemeIfInstalled } from "./shellTheme.js";
import { themePublicationIfInstalled } from "./themePublication.js";
import { ThemePreview } from "./themePreview.js";
import { publishedThemeOf } from "../../model/publishedTheme.js";
import { RepositoryStatusWatcher } from "./repositoryStatus.js";
import { writeClipboardImage } from "./clipboardImage.js";
import {
	saveSlideImages,
	saveSlidesPdf,
	type SlideExportHost,
} from "./slideExport.js";
import { popupContextMenu } from "./contextMenu.js";
import { installMenu, refreshMenu } from "./menu.js";
import {
	devhubSkillAnswer,
	devhubSkillPaths,
	devhubSkillText,
	writeDevhubSkill,
	type DevhubSkill,
} from "../agent/devhubSkill.js";
import {
	isOrchestratorAgent,
	orchestratorSkillAnswer,
	orchestratorSkillPaths,
	writeOrchestratorSkill,
	type OrchestratorSkill,
} from "../orchestrator/orchestratorSkill.js";
import {
	cliBinaryPath,
	installLauncher,
	launchCommandFor,
	launcherScript,
	type InstallRequest,
} from "../cli/install.js";
import type { TellCommand } from "../cli/tell/command.js";
import {
	callerKey,
	tellCaller,
	tellReview,
	TellMemory,
	TellService,
	type IssueAssignRequest,
	type TellAnswer,
	type TellCloseAnswers,
	type TellClosed,
	type TellPorts,
	type TellWorkspace,
} from "../cli/tell/service.js";
import {
	restartAsTheMenuDoes,
	stopAsTheRowDoes,
	closeAsTheWindowDoes,
} from "../cli/tell/windowActs.js";
import {
	installKeyboard,
	setArmingObserver,
	runCommand,
	setChordLayout,
	type ChordHost,
} from "./keyboard.js";
import { resolveChord } from "./chords.js";
import {
	commandPaletteRows,
	rememberRecentCommand,
} from "../../model/commandPalette.js";
import {
	appCommandDirection,
	isAppHistorySurface,
	isDestinationSurface,
	swipeDirection,
} from "./historyKeys.js";
import type { NavigationDirection } from "../../model/navigationHistory.js";
import {
	InputSourceHelper,
	inputSourceHelperPath,
} from "./inputSourceHelper.js";
import { ManagedNeovims, socketDirectoryFor } from "../editor/managedNeovim.js";
import { NeovimEditors } from "../editor/neovimEditors.js";
import {
	parseControlPanes,
	type TerminalNeovims,
} from "../editor/terminalNeovims.js";
import {
	overlayTerminals,
	wireTerminalNeovims,
} from "../editor/terminalNeovimWiring.js";
import { neovimOpenOf } from "../editor/neovimOpen.js";
import { workspaceTerminalPageId } from "../../ipc/terminal.js";
import {
	neovimMissingMessage,
	remoteNeovimSockets,
} from "../editor/neovimMachines.js";
import {
	NEOVIM_CHANNELS,
	type NeovimAttachRequest,
	type NeovimCall,
	type NeovimGuiMessage,
} from "../../ipc/neovim.js";
import { describeChordKey } from "../../model/chordKeys.js";
import {
	COMMANDS,
	isCommandId,
	keysForCommand,
	resolveBindings,
	type CommandId,
	type CommandNeeds,
} from "../../model/commands.js";
import {
	openSettingsWindow,
	publishSettingsSnapshot,
	settingsWindowContents,
	settingsWindowIsFocused,
} from "./settingsWindow.js";
import {
	openTaskManagerWindow,
	taskManagerWindowContents,
	taskManagerWindowIsFocused,
} from "./taskManagerWindow.js";
import { takeTaskReading } from "./taskManagerReading.js";
import type {
	TaskRevealWire,
	TaskSnapshotWire,
} from "../../ipc/taskManager.js";

/** What the Task Manager calls each of the shell window's pages. */
const PAGE_NAMES: Readonly<Record<string, string>> = {
	shell: "Window page",
	sidebar: "Sidebar page",
	agents: "Agents page",
	toasts: "Notices page",
	picker: "Questions page",
};

/**
 * The `devhub` launcher this DevHub writes (`cli/install.ts`): the one the
 * install command puts on the PATH and the one the `/devhub` skill names.
 *
 * It execs the `devhub` binary this app's build left for this machine
 * (`out/cli/<os>-<arch>/devhub`, Go, `docs/devhub-cli.md`), in a checkout and
 * in a bundle alike. How this DevHub is started is written down by the DevHub
 * that is running: a bundle the Finder can open, or the checkout's own dev.sh
 * (`launchCommandFor`).
 */
function launcherRequest(userDataPath: string): InstallRequest {
	return {
		cliBinary: cliBinaryPath(APP_ROOT),
		socketPath: controlSocketPath(userDataPath),
		commandName: activeProfile().cliCommandName,
		profile: activeProfile().profile,
		launchCommand: launchCommandFor(APP_ROOT),
		home: homedir(),
		pathValue: process.env["PATH"] ?? "",
	};
}

/**
 * How long a close waits to be told which session an Agent's CLI is in, so it
 * can be reopened (`model/recentlyClosed.ts`). Short: it is asked only so the
 * close can be undone, and an Agent whose session was not told in time is
 * still closed — it is only not resumable.
 */
const SESSION_AT_CLOSE_TIMEOUT_MS = 3_000;

/**
 * A closed Agent or Workspace that cannot come back, and why — said, and the
 * entry dropped (`model/recentlyClosed.ts`).
 */
class ReopenRefused extends Error {}

/**
 * The same promise, with "it never answered" as one of its answers.
 *
 * The timer is cleared on either outcome and never keeps the process alive, so
 * an open that succeeds costs one timer and nothing else.
 */
function withDeadline<T>(
	work: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(message));
		}, timeoutMs);
		(timer as unknown as { unref?: () => void }).unref?.();
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/**
 * How long the page waits for a deferred operation before it is a failure.
 *
 * *Derived* from the cleanup budget, not chosen beside it. It was 60s against
 * four steps of 20s each, so two unresponsive steps plus any real work ran
 * past it: `awaitOutcome`'s timer fired first and reported a generic
 * `operation_timed_out`, throwing away the per-step diagnostics —
 * `close_editor_unresponsive`, `close_terminal_unknown` — that were computed
 * for exactly that scenario and are the only ones that say *what* did not
 * answer. The margin is for the work either side of the steps.
 */
const OPERATION_TIMEOUT_MS = CLOSE_BUDGET_MS + 20_000;

/**
 * What the help overlay says a command wants, one phrase per `CommandNeeds`.
 *
 * A total table rather than a chain of conditionals, so a need added to the
 * registry is a compile error here instead of a row that quietly says the
 * wrong thing.
 */
const NEEDS_PHRASE: Readonly<Record<Exclude<CommandNeeds, "nothing">, string>> =
	{
		workspace: "with a workspace selected",
		agent: "with an Agent selected",
		split: "with the editor and an Agent side by side",
	};

/** More rounds than any real chain needs, and fewer than a cycle survives. */
const MAX_DRAIN_ROUNDS = 512;

/**
 * Where a Workspace a folder open makes goes in the Sidebar.
 *
 * `below-selection` is for the flows a person runs from DevHub itself to add
 * a Workspace next to what they are in — the folder picker (`Cmd+Q F`, Add
 * Workspace… in the palette and the menu), an SSH folder, New Project, Clone:
 * directly under the Workspace the selection is in (`placeWorkspaceBelow`).
 * `automatic` is everything else — `devhub <folder>` from a terminal, VS
 * Code's own opens, Reopen Closed, an Issue's worktree — which is not said
 * from a row and keeps the order's own rule (`orderWorkspaces`).
 */
type WorkspacePlacement = "automatic" | "below-selection";

/**
 * How long `--metrics` waits for tmux to list its clients.
 *
 * A reading is something a person takes while wondering what DevHub is doing,
 * so it must come back even when tmux is the thing that is wedged. Short, and
 * the failure is a failure — a reading that quietly left the client count out
 * would read as "no clients", which is the answer this number exists to
 * distinguish from.
 */
const METRICS_CLIENT_TIMEOUT_MS = 2_000;

interface PendingRequest {
	readonly promise: Promise<IntentOutcome>;
	readonly settle: (outcome: IntentOutcome) => void;
	readonly fail: (error: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class AppController {
	private readonly coordinator: AppCoordinator;
	private cursor = 0;
	private draining = false;

	/**
	 * Where each `--wait` open came from, so closing it can go back there.
	 * Empty except while a `devhub --wait` is in flight; see `waitReturn.ts`.
	 */
	private readonly waitReturns = new WaitSelectionReturns();

	/**
	 * The settings DevHub is running on, now: always a `Config`, the defaults
	 * or the last accepted settings while the file cannot be used. Asked of
	 * the one object that owns them (`runningSettings.ts`), never kept here.
	 */
	private get config(): Config {
		return this.settings.config;
	}
	/**
	 * The lookup a question on screen is waiting for, if there is one.
	 *
	 * One, not a map, and that is a fact about the picker rather than a
	 * simplification: a lookup is started by a question on screen, and there is
	 * one question on screen. So "the lookup" always names exactly one thing,
	 * a second one beginning means the first is not wanted, and there is no
	 * identifier for the page to keep and get wrong.
	 */
	private pickerLookup: CancellationToken | undefined;
	private state: PersistedAppState;
	private appearanceSequence = 0;
	private profileSequence = 0;
	private cancelPicker: (() => void) | undefined;
	/** Page requests still waiting on a deferred chain, by operation identity. */
	private readonly pendingRequests = new Map<OperationId, PendingRequest>();
	private terminalsWiring: TerminalWiring | undefined;
	/**
	 * The terminal view's file jumps: one Neovim per Workspace, DevHub's own.
	 * Built with the terminal runtime it runs on; see
	 * `editor/managedNeovim.ts`.
	 */
	private managedNeovims: ManagedNeovims | undefined;
	/** The Neovim editor's UIs, over the managed Neovims (`neovimEditors.ts`). */
	private neovimEditors: NeovimEditors | undefined;
	/** Neovims run in Agent terminals, drawn over their panes (`terminalNeovims.ts`). */
	private terminalNeovims: TerminalNeovims | undefined;
	/** Where a host's Neovim socket is forwarded to, here. */
	private neovimForwards = "";
	/**
	 * The Workspaces whose Neovim page has been shown since the editor became
	 * Neovim: each keeps its page, hidden, while another is on screen.
	 */
	private readonly neovimShown = new Set<string>();
	/** Theme: Preview… (`themePreview.ts`). */
	private readonly themePreview = new ThemePreview({
		theme: () => shellThemeIfInstalled(),
		choose: (rows, current) =>
			shellWindow().picker.choose({ kind: "theme-preview", rows, current }),
		report: (problem) => {
			this.noteFailure(
				new NamedFailure(
					withDetail(errorWireAt("color_theme_unavailable"), problem),
				),
			);
		},
	});
	/** This profile's user-data directory, from `startRuntimes`. */
	private userDataPath: string | undefined;
	/** The launcher installation, asked for once per machine. */
	private readonly launchers = new Map<RuntimeId, Promise<TerminalLauncher>>();
	/** What became of each of those, for `devhub --metrics`. */
	private readonly launcherStatus = new Map<
		RuntimeId,
		TerminalLauncherStatus
	>();
	private agentWiring: AgentWiring | undefined;
	/**
	 * Where the GUI Agents' conversations run (`agentEngine/`): a utility
	 * process. `DEVHUB_CONVERSATIONS_IN_MAIN=1` runs them in main instead.
	 */
	private conversationEngine: EngineClient | undefined;
	/**
	 * Where the terminal surfaces' tmux clients run (`ptyHost/`): a utility
	 * process the pages reach over ports of their own.
	 * `DEVHUB_TERMINALS_IN_MAIN=1` runs them in main instead.
	 */
	private ptyHost: PtyHostClient | undefined;
	/**
	 * Where the Neovim editors' UIs run (`neovimHost/`): a utility process,
	 * the pages over ports. `DEVHUB_NEOVIM_IN_MAIN=1` runs them in main.
	 */
	private neovimHost: NeovimHostClient | undefined;
	/** Each GUI Agent's unsent draft, beside `state.json`. See `drafts.ts`. */
	private readonly drafts: AgentDrafts;
	/** What each Agent's automatic actions have already sent. See `runAutomaticActions`. */
	private readonly automaticActions = new AutomaticActions();
	/** What each GUI Agent decided about the usage limit it stopped at (`limitResume.ts`). */
	private readonly limitResumes: AgentRecords<LimitResumeRecord>;
	/**
	 * The metadata of the Agents that ran each CLI session, kept once they are
	 * stopped or closed, beside `state.json`. See `model/sessionMeta.ts`.
	 */
	private readonly sessionMeta: SessionMetaKeeper;
	/** The state file's Agents were told to `sessionMeta` as seen. */
	private sessionMetaSeeded = false;
	/** The sweep of DevHub's own stray sessions, and the machines it owes. */
	private sessionSweeper: SessionSweeper | undefined;
	private stopHearingReconnections: (() => void) | undefined;
	/**
	 * What became of the login-shell environment import, and the environment it
	 * produced. Both are answered once, at `startRuntimes`, and every executable
	 * lookup and every child DevHub starts uses that one answer — see
	 * `loginEnvironment.ts`. The Settings window shows the first so a failed
	 * import is a sentence somebody can read rather than a PATH that is
	 * mysteriously short.
	 */
	private loginEnvironment: LoginEnvironment = { kind: "disabled" };
	private launchEnvironment: Readonly<Record<string, string | undefined>> =
		process.env;
	/**
	 * The one thing that keeps every Agent's status and existence true.
	 *
	 * Nothing else asks the provider on its own: a status that only moved when
	 * a view happened to attach is a status that stays on "Starting runtime"
	 * for an Agent that started, and an exit nobody asked about is a row for a
	 * process that is gone.
	 */
	/**
	 * Which machines are not answering, as a condition rather than an event.
	 *
	 * A machine-wide round runs once a cadence tick for as long as that machine
	 * has Agents, so its failure is not something that *happened* — it is
	 * something that is *true*, and it is published once per episode with the
	 * hysteresis in `machineConditions.ts`. It used to be an app-wide failure
	 * raised every round: the person's next click retired it (that is what a
	 * failure's lifetime is), the next round put it back, and the notice took
	 * layout room, so an unreachable host made the whole workbench shake.
	 */
	/**
	 * Every notice this process publishes, written down once.
	 *
	 * Here rather than inside each raising site because the question it answers
	 * — "did this go up and down a hundred times, and who kept raising it" —
	 * is about the *sequence* of notices and no single site can see one. See
	 * `diagnostics/notices.ts`.
	 */
	private readonly notices = new NoticeJournal();
	/**
	 * The window's own way of saying "over here".
	 *
	 * A state, told everything that can change it — the projection moving and
	 * the window coming forward — and idempotent, so no site has to know
	 * whether it is the one that turns it on. See `windowAttention.ts`.
	 */
	private readonly attention = new WindowAttention(platformDock());

	private shellFocused = false;
	private readonly liveNotifications = new Set<Electron.Notification>();

	/** Notifies when an Agent finishes or needs the person. See `agentNotifications.ts`. */
	private readonly agentNotifier = new AgentNotifier({
		settings: () => ({
			enabled: this.config.general.notify_on_idle,
			sound: this.config.general.notify_sound,
		}),
		windowFocused: () => this.shellFocused,
		snapshot: () => this.snapshot(),
		notify: (notification) => this.showAgentNotification(notification),
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
	});

	private showAgentNotification(info: AgentNotification): void {
		const { Notification } = electron;
		if (!Notification.isSupported()) return;
		const notification = new Notification({
			title: info.title,
			body: info.body,
			silent: !info.sound,
			...(info.sound ? { sound: "Glass" } : {}),
		});
		this.liveNotifications.add(notification);
		const done = (): void => {
			this.liveNotifications.delete(notification);
		};
		notification.on("click", () => {
			done();
			this.bringToFront();
			this.dispatchOwn({
				type: "select_context",
				context: { kind: "agent", agentId: parseAgentId(info.agentId) },
				presentation: "full",
			});
		});
		notification.on("close", done);
		notification.on("failed", done);
		notification.show();
	}
	private readonly machineConditions = new MachineConditions({
		publish: (source, summary, reason) => {
			const event = {
				code: summary === undefined ? "" : "machine_not_answering",
				subject: source,
				source: "reconcile",
				identity: appConditionIdentity(source),
				reason,
			};
			if (summary === undefined) this.notices.retracted(event);
			else this.notices.raised(event);
			this.publishCondition(source, summary);
		},
	});
	private readonly agentReconcilers = new AgentReconcilers({
		reconcile: (host) => this.reconcileAgentsOn(host.id),
		onFailure: (error) => {
			// The round already reported itself: an Agent operation that failed is
			// published where every operation failure is published. What is left
			// here is the round's own bookkeeping, and it belongs in the log.
			console.error(error instanceof Error ? error.stack : error);
		},
	});
	/**
	 * One loop per machine with a Workspace on it, reading its terminals' panes
	 * at most once a second. See `terminalActivityLoop.ts`.
	 */
	private readonly terminalActivity = new AgentReconcilers({
		reconcile: (host) => this.observeTerminalsOn(host.id),
		onFailure: (error) => {
			console.error(error instanceof Error ? error.stack : error);
		},
		record: () => {
			activityCounters.record(COUNTER.terminalActivityRound);
		},
	});
	/** Each machine's output clock, round to round (`PaneActivityTracker`). */
	private readonly paneTrackers = new Map<RuntimeId, PaneActivityTracker>();
	private readonly terminalActivityFailures = new FailureOnce();
	private stopWatchingConfig: (() => void) | undefined;

	constructor(
		/**
		 * The settings DevHub is running on, and the only reader of the file.
		 * See `runningSettings.ts`.
		 */
		private readonly settings: RunningSettings,
		private readonly stateStore: JsonStateStore,
		model: AppModel,
		state: PersistedAppState,
		/**
		 * How the *previous* run ended, captured before this one marked itself
		 * started — after that the flag describes this run, not the last one.
		 */
		private readonly previousExitValue: "clean" | "unclean" | "unknown",
		/** Whether this run started from a state file that did not exist. */
		private readonly freshState: boolean,
	) {
		this.state = state;
		// The appearance and the colour theme this run starts on were applied
		// from these same settings before the window was made
		// (`bootstrapShell`); `settingsAccepted` applies every change after.
		this.scratch = new ScratchFollower(this.config.scratch.daily, {
			home: homedir(),
			adopt: (day) => this.adoptScratchDay(day),
		});
		// Where a Workspace's close lands is the row after it as the Sidebar
		// draws it, and the Sidebar's order is read with the repository status
		// only main has — so the model is handed the same order the projection
		// is in.
		this.coordinator = new AppCoordinator(model, (snapshot) =>
			drawnWorkspaceOrder(snapshot, this.repositoryOf),
		);
		// The window's size is the one input to the rectangles that is not
		// the model's, and a resize is no projection: said only from one,
		// they stayed where they were until the model next moved, and the
		// window's page drew its states and the split's seam against the
		// window's old size.
		shellWindow().window.on("resize", () => {
			this.publishAreas(shellWindow());
		});
		// A click into one of the content area's views is the person choosing
		// that pane; the model is told, so the chords start from it.
		shellWindow().onContentFocused((pane) => {
			this.paneFocused(pane);
		});
		// The Sidebar's page started over, so whatever it was floating is
		// gone with it; the view goes back to its column.
		shellWindow().onSidebarRestarted(() => {
			if (!this.sidebarOverlay) return;
			this.sidebarOverlay = false;
			this.publishLayoutState();
		});
		// Loaded before any page exists, so a file that would not read is said
		// with the other startup failures. Pruned to the Agents the model has:
		// a draft goes when its Agent does.
		const drafts = AgentDrafts.load(
			join(dirname(stateStore.path), "drafts.json"),
			() => this.modelAgentIds(),
		);
		this.drafts = drafts.drafts;
		if (drafts.refused !== undefined) {
			this.noteStartupFailure(
				withDetail(errorWireAt("persistence_degraded"), drafts.refused),
			);
		}
		const limitResumes = AgentRecords.load(
			join(dirname(stateStore.path), "limit-resumes.json"),
			LIMIT_RESUME_RECORDS,
			() => this.modelAgentIds(),
		);
		this.limitResumes = limitResumes.records;
		if (limitResumes.refused !== undefined) {
			this.noteStartupFailure(
				withDetail(errorWireAt("persistence_degraded"), limitResumes.refused),
			);
		}
		const sessionMeta = SessionMetaFile.load(
			join(dirname(stateStore.path), "session-meta.json"),
		);
		this.sessionMeta = new SessionMetaKeeper(sessionMeta.index, {
			agents: () =>
				this.coordinator.model.workspaces.flatMap(
					(workspace) => workspace.agents,
				),
			sessionOf: (agentId) => this.sessionAtClose(parseAgentId(agentId)),
			restore: (agentId, meta, managed) => {
				this.restoreSessionMeta(parseAgentId(agentId), meta, managed);
			},
		});
		if (sessionMeta.refused !== undefined) {
			this.noteStartupFailure(
				withDetail(errorWireAt("persistence_degraded"), sessionMeta.refused),
			);
		}
		this.registerIpc();
		this.watchConfig();
	}

	//#region lifecycle

	/** Whether the previous run ended cleanly, for the Settings diagnostics. */
	previousExit(): "clean" | "unclean" | "unknown" {
		return this.previousExitValue;
	}

	/** The environment every executable lookup and every child DevHub starts uses. */
	launchEnvironmentValue(): Readonly<Record<string, string | undefined>> {
		return this.launchEnvironment;
	}

	/** What became of the login-shell import that built it. */
	loginEnvironmentValue(): LoginEnvironment {
		return this.loginEnvironment;
	}

	/**
	 * Why an executable could not be found, in terms that name the cause.
	 *
	 * Two facts decide this, and they are learned in different places. One is
	 * that the lookup failed. The other is that the PATH it searched is the
	 * short one DevHub was started with, because the login shell did not answer
	 * in time — a profile slower than `LOGIN_ENVIRONMENT_TIMEOUT_MS` is slow
	 * rather than broken, so this happens on some launches and not others.
	 *
	 * Kept apart they are two small mysteries: an Agent that is "unavailable"
	 * today and fine tomorrow, and a sentence about the environment in a
	 * Settings window nobody had a reason to open. The second fact is the cause
	 * of the first, so it is said in the same breath — and said here, once,
	 * rather than at each place that reports a lookup.
	 */
	private executableMissingMessage(
		resolved: SettingsUnavailableRuntimeWire,
	): string {
		return executableMissingMessage(
			resolved,
			this.loginEnvironment.kind === "failed"
				? loginEnvironmentSummary(this.loginEnvironment)
				: undefined,
		);
	}

	/**
	 * Bring up the terminal and Agent runtimes.
	 *
	 * They are built after the config and the state are loaded, because both
	 * are inputs: which tmux and shell to use, and which socket is in effect,
	 * come from those two files. Agents are built on the terminal runtime,
	 * because an Agent *is* a tmux session — there is one socket, one marker
	 * protocol and one client for both.
	 */
	async startRuntimes(userDataPath: string): Promise<void> {
		this.userDataPath = userDataPath;
		const config = this.config;
		// On a state file that has never existed, the configured socket *is* the
		// effective one: there are no sessions to migrate, so adopting it is the
		// whole of the change. Once a run has owned sessions on a socket, the
		// configured name becomes a request Settings has to apply, because
		// switching silently would abandon them.
		//
		// A non-default profile is the exception, and for the same reason its
		// settings cannot name a socket: its whole purpose is to be a DevHub
		// that shares no tmux server with the other one, so its socket is
		// adopted whether or not this is a first run.
		const profile = activeProfile();
		const configuredSocket = profile.isDefault
			? config.runtimes.tmux_socket_name
			: profile.tmuxSocketName;
		if (
			(this.freshState || !profile.isDefault) &&
			this.state.tmux.transition.kind === "stable" &&
			this.state.tmux.effective_socket_name !== configuredSocket
		) {
			this.state.tmux.effective_socket_name = configuredSocket;
			await this.saveState();
		}
		// The environment is resolved before anything is looked up in it, and
		// once. A DevHub launched from Finder inherits launchd's four-entry PATH,
		// so without this the lookup below would not find the user's tmux, and
		// the terminals and agents launched with it would not find their tools
		// either. One environment, one resolution: what
		// DevHub can find and what a shell inside it can find cannot disagree.
		this.loginEnvironment = await resolveLoginEnvironment({
			enabled: config.general.import_login_environment,
		});
		// It lands in DevHub's own process, which is what makes "one
		// environment" true of VS Code's side as well: the workbench windows,
		// the extension host and the `git` an extension runs are children of
		// this process and of nothing DevHub hands out. `startRuntimes` is
		// awaited from `bootstrapShell`, which the entry point awaits before
		// `CodeApplication.startup()`, so none of them exists yet.
		adoptLoginEnvironment(process.env, this.loginEnvironment);
		this.launchEnvironment = launchEnvironment(process.env);
		// Nothing is resolved here any more. Which `tmux` and which shell a
		// Workspace's terminals run is a question about that Workspace's
		// machine, so it is asked on that machine, once, when its adapter is
		// built (`terminalRuntimes.ts`) — and the Settings window asks its own
		// for this Mac, which is what that window is about.
		this.ptyHost =
			process.env["DEVHUB_TERMINALS_IN_MAIN"] === "1"
				? undefined
				: new PtyHostClient({ launch: electronPtyHostLauncher });
		this.terminalsWiring = wireTerminals({
			...(this.ptyHost === undefined ? {} : { ptyHost: this.ptyHost }),
			settings: this.settings,
			effectiveSocketName: this.state.tmux.effective_socket_name,
			// One tmux config, in DevHub's own config directory, beside
			// `settings.toml` and profile-aware with it. Not `~/.tmux.conf`:
			// that is the config of the tmux a person runs themselves, and
			// DevHub's server is not that tmux.
			userTmuxConfigPath: join(activeProfile().configDirectory, "tmux.conf"),
			// Not for talking to: it is what tags the directory DevHub owns on
			// every *other* machine, so that two profiles reaching one host stay
			// apart. See `remoteCliBinDirectory`.
			controlSocketPath: controlSocketPath(userDataPath),
			model: () => this.coordinator.model,
		});
		const terminalRuntimes = this.terminalsWiring.runtimes;
		this.managedNeovims = this.createManagedNeovims(userDataPath);
		const clipboard = {
			read: () => Promise.resolve(electron.clipboard.readText()),
			write: (text: string) => {
				electron.clipboard.writeText(text);
			},
		};
		this.neovimHost =
			process.env["DEVHUB_NEOVIM_IN_MAIN"] === "1"
				? undefined
				: new NeovimHostClient({
						launch: electronNeovimHostLauncher,
						clipboard,
					});
		this.terminalNeovims = wireTerminalNeovims({
			tmuxOf: async (machine) => {
				const runtime = await terminalRuntimes.for(runtimeById(machine));
				if (!runtime.adapterAvailable) {
					throw new Error(runtime.unavailableReason ?? "no tmux");
				}
				return runtime;
			},
			runtimeById,
			forwardDirectory: this.neovimForwards,
			shell: () => shellWindowIfCreated(),
			theme: () => themePublicationIfInstalled()?.current(),
			addThemeSink: (sink) => {
				themePublicationIfInstalled()?.addSink("the terminals' Neovims", sink);
			},
			// Which Neovim the Workspace's terminal shows is in the title.
			changed: () => {
				this.refreshWindowTitle();
			},
		});
		this.neovimEditors = new NeovimEditors({
			overlays: this.terminalNeovims,
			neovims: this.managedNeovims,
			clipboard,
			...(this.neovimHost === undefined ? {} : { host: this.neovimHost }),
			log: (line) => {
				console.error(line);
			},
			onBuffer: () => {
				this.refreshWindowTitle();
			},
		});
		// The theme, before any tmux server is brought up: a server is started
		// with it, and told again on every change after (`themePublication.ts`).
		this.publishTerminalTheme();
		const managedNeovims = this.managedNeovims;
		themePublicationIfInstalled()?.addSink("tmux", () =>
			terminalRuntimes.publishThemeEnvironment(),
		);
		themePublicationIfInstalled()?.addSink("the managed Neovims", (theme) =>
			managedNeovims.publishTheme(theme),
		);
		const skill = this.writeAgentSkill(userDataPath);
		const orchestratorSkill = this.writeOrchestratorSkill(userDataPath);
		this.startOrchestratorService(userDataPath);
		const engine =
			process.env["DEVHUB_CONVERSATIONS_IN_MAIN"] === "1"
				? undefined
				: new EngineClient({
						launch: electronEngineLauncher,
						settings: () => ({
							limitResume: limitResumeSettingsOf(this.settings.config),
							cacheKeep: cacheKeepSettingsOf(this.settings.config),
						}),
					});
		this.conversationEngine = engine;
		this.agentWiring = wireAgents({
			...(engine === undefined ? {} : { engine }),
			// This Mac's skill is written at startup; another machine's is
			// written there with its `devhub` command, when its terminal
			// launcher is installed (`RemoteShellRuntime.terminalLauncher`).
			devhubSkill: async (machine) =>
				machine === "local"
					? skill
					: (
							await this.terminalLauncherFor(runtimeById(machine)).catch(
								() => undefined,
							)
						)?.skill,
			// The orchestrator alone, and only here: its root is a folder on
			// this Mac (`orchestrator start`).
			orchestratorSkill: (machine, agentId) =>
				machine === "local" && this.isOrchestratorAgent(agentId)
					? orchestratorSkill
					: undefined,
			runtimeFor: (machine) => terminalRuntimes.for(runtimeById(machine)),
			model: () => this.coordinator.model,
			machineOf: (workspaceId) => this.machineOf(workspaceId),
			machineRuntime: (machine) => runtimeById(machine),
			report: (message) =>
				this.publishError(withDetail(errorWireAt("agent_exited"), message)),
			clientVersion: electron.app.getVersion(),
			profileTag: remoteProfileTag(controlSocketPath(userDataPath)),
			settings: this.settings,
			limitResumes: this.limitResumes,
			listingContext: (runtime, root, kind) =>
				this.listingContext(runtime, root, kind),
		});
		const agentWiring = this.agentWiring;
		// Dictation into the GUI Agent composer: the bundled recogniser, if
		// this build has one, and macOS's microphone permission.
		registerVoiceIpc({
			ipcMain: electron.ipcMain,
			pages: () => [
				shellWindow().conversations.contents(),
				shellWindow().agents.contents(),
			],
			install: locateWhisper(whisperCandidates(APP_ROOT, process.env)),
			microphone: {
				status: () =>
					electron.systemPreferences.getMediaAccessStatus("microphone"),
				ask: () => electron.systemPreferences.askForMediaAccess("microphone"),
			},
		});
		registerConversationIpc({
			ipcMain: electron.ipcMain,
			// `/resume` gives an Agent with no name of its own the name the
			// session it goes on with was given.
			conversations: {
				...agentWiring.conversations,
				resume: async (agentId, session) => {
					await agentWiring.conversations.resume(agentId, session);
					await this.sessionResumedIn(agentId, session);
				},
			},
			drafts: this.drafts,
			...(engine === undefined ? {} : { pagePorts: enginePagePorts(engine) }),
			conversationsPage: () => shellWindow().conversations.contents(),
			agentsPage: () => shellWindow().agents.contents(),
			// A continue of an Agent that is not idle is a question first
			// (`Coordinator.askAbout`), and the button that asked cannot draw
			// it: it goes to the one sheet a stop's question goes to.
			continueIn: (agentId, presentation, session) =>
				this.continueAgentIn(agentId, presentation, session),
			// `/restart`: the question, when there is one, goes to the same
			// sheet as the Sidebar's Restart Session and the chord's.
			restart: (agentId) => this.requestRestartAgent(agentId),
			// `/resume` on another worktree's session: there, in a new Agent.
			resumeElsewhere: (agentId, session) =>
				this.resumeAgentSessionElsewhere(agentId, session),
			terminalSession: (agentId) => agentWiring.terminalSession(agentId),
			resolvePaths: (agentId, cwd, paths) =>
				resolvePathCandidates(
					runtimeById(this.agentMachine(agentId)),
					cwd,
					paths,
				),
			readEmbedFile: (agentId, path) =>
				readEmbedFile(runtimeById(this.agentMachine(agentId)), path),
			embedSignature: (agentId, path) =>
				embedSignature(runtimeById(this.agentMachine(agentId)), path),
			openFile: (agentId, path, selection) =>
				this.openFromConversation(agentId, path, selection),
			cliDefaults: async (agentId, model) => {
				const place = this.cliAgentPlace(agentId);
				switch (place.profile.kind) {
					case "claude":
						return readClaudeDefaults(
							place.runtime,
							place.profile,
							place.root,
							model,
						);
					case "codex":
						return readCodexDefaults(place.runtime, place.profile);
					default:
						return undefined;
				}
			},
			setCliDefault: async (agentId, which, value, model) => {
				const place = this.cliAgentPlace(agentId);
				switch (place.profile.kind) {
					case "claude":
						return writeClaudeDefault(
							place.runtime,
							place.profile,
							which,
							value,
							model,
						);
					case "codex":
						return writeCodexDefault(
							place.runtime,
							place.profile,
							which,
							value,
						);
					default:
						throw new Error(
							"Only a Claude Code or Codex Agent's defaults can be set from DevHub",
						);
				}
			},
			// The person's own words to an Agent: the orchestrator watches them.
			personSent: (agentId) => this.orchestrator?.personSent(agentId),
			fail: (error) => namedFailure(error),
		});
		// The Sidebar's usage-limits readout, from what the GUI Agents report
		// as well as from the background readers (`startUsageReaders`).
		const usageLimits = usageLimitsListener(
			this.usageLimits,
			(agentId) => this.coordinator.model.agent(agentId)?.profile.kind,
			(limits) => this.usageLimitsChanged(limits),
		);
		const usageOf = (agentId: AgentId, usage: Usage) =>
			usageLimits(agentId, 0, { type: "usage", usage });
		this.agentWiring.conversations.registry.onUsage(usageOf);
		engine?.onUsage(usageOf);
		// Everything restored from the state file describes the previous run,
		// and the sessions on the socket are what is left of it. Nothing has to
		// be told which session belongs where: each carries its own workspace
		// and Agent id in its markers, so restoring a row is finding its
		// session again. What is left over is swept once, here, because a
		// session no row can show is a process nobody can reach — on every
		// machine DevHub has ever owned sessions on, which is more than the
		// machines it still has Workspaces on. See `sessionSweep.ts`.
		this.sessionSweeper = new SessionSweeper({
			adapterFor: (machine) => terminalRuntimes.for(runtimeById(machine)),
			hostFilesFor: (machine) =>
				agentHostFiles(
					runtimeById(machine),
					remoteProfileTag(controlSocketPath(userDataPath)),
				),
			accounted: () => {
				const workspaces = new Set<string>();
				const agents = new Set<string>();
				for (const workspace of this.coordinator.model.workspaces) {
					workspaces.add(workspace.id);
					for (const agent of workspace.agents) agents.add(agent.id);
				}
				// An Agent being launched has its session, and a GUI Agent its
				// host files, before it has a row: its launch accounts for them.
				for (const agent of this.coordinator.launchingAgents()) {
					agents.add(agent);
				}
				// A terminal is accounted for by its Agent, and one being opened
				// has its session before the model knows of it.
				const terminals = new Set<string>(this.launchingTerminals);
				for (const terminal of this.coordinator.model.agentTerminals()) {
					terminals.add(terminal.terminalId);
				}
				return { workspaces, agents, terminals };
			},
			workspaceMachines: () => this.workspaceMachines(),
			remembered: () => this.state.session_machines,
			forget: (machine) => {
				this.state.session_machines = this.state.session_machines.filter(
					(remembered) => remembered !== machine,
				);
				void this.saveState();
			},
		});
		// Before the sweep, not after: a machine that answers is one this run
		// owns sessions on, and a crash between the sweep and the first save
		// must not be what makes DevHub forget where they are.
		await this.saveState();
		this.stopHearingReconnections = onRuntimeConnected((machine) => {
			this.sessionSweeper?.machineCameBack(machine);
		});
		await this.sessionSweeper.sweepAll();
		this.agentReconcilers.follow(this.agentHosts());
		this.terminalActivity.follow(this.terminalHosts());
		this.repositoryStatus.start();
		this.watchForWake();
		this.scratch.start();
	}

	/**
	 * The current file of the Neovim the selected Workspace's terminal shows
	 * (its active pane's), for the title.
	 */
	private neovimTitleElement(
		selection: ReturnType<AppController["snapshot"]>["selection"],
	): string | undefined {
		const context = selection.context;
		if (context.kind !== "workspace") return undefined;
		const key = this.terminalNeovims?.shownOverlay(
			workspaceTerminalPageId(context.workspaceId),
		);
		return key === undefined ? undefined : this.neovimEditors?.bufferName(key);
	}

	/**
	 * Where a Workspace's Neovim runs: its own machine. A dev container is
	 * not one yet (`docs/neovim-editor.md`, "Limitations").
	 */
	private neovimTarget(workspaceId: string): WorkspaceTerminalTarget {
		const workspace = this.coordinator.model.workspace(
			parseWorkspaceId(workspaceId),
		);
		if (!workspace) throw new Error("That Workspace is not open.");
		if (workspace.editor.kind !== "host") {
			throw new Error(
				`The Neovim editor does not run in a dev container yet. Reopen ${workspace.root} on its own machine, or set [general] editor = "vscode".`,
			);
		}
		return {
			machine: runtimeIdFor(workspace.location),
			workspaceId: workspace.id,
			root: workspace.root,
		};
	}

	/**
	 * The managed Neovims: the Neovim editor's headless servers, one per
	 * Workspace, kept by the tmux of the Workspace's machine. Built at once —
	 * it costs nothing until a Workspace's Neovim page attaches or a file is
	 * opened into one.
	 */
	private createManagedNeovims(userDataPath: string): ManagedNeovims {
		const tmuxOf = async (machine: RuntimeId) => {
			const wiring = this.terminalsWiring;
			if (!wiring) throw new Error("the terminal runtime is not running");
			const runtime = await wiring.runtimes.for(runtimeById(machine));
			if (!runtime.adapterAvailable) {
				throw new Error(
					runtime.unavailableReason ??
						`there is no tmux${runtimeById(machine).where}`,
				);
			}
			return runtime;
		};
		// DevHub's own directory first; a path too long for a socket address
		// (a long home on macOS) falls back to the temporary one. Neither
		// fitting is said at the first jump, not thrown at startup.
		const candidates = [
			join(userDataPath, "devhub", "nvim"),
			join(tmpdir(), `devhub-nvim-${String(userInfo().uid)}`),
		];
		let socketDirectory = candidates[1] as string;
		let socketProblem: string | undefined;
		try {
			socketDirectory = socketDirectoryFor(candidates);
		} catch (error: unknown) {
			socketProblem = failureText(error);
		}
		const forwards = join(socketDirectory, "forwarded");
		this.neovimForwards = forwards;
		return new ManagedNeovims({
			panes: {
				open: async (target, argv) =>
					(await tmuxOf(target.machine)).openEditorWindow(target, argv),
				show: async (target, paneId, socketPath) => {
					await (
						await tmuxOf(target.machine)
					).showEditorPane(target, paneId, socketPath);
				},
				state: async (target, paneId) =>
					(await tmuxOf(target.machine)).editorPaneState(target, paneId),
				kill: async (target, paneId) => {
					await (await tmuxOf(target.machine)).killEditorPane(target, paneId);
				},
			},
			// DevHub's Neovim on the Workspace's machine, never the PATH's: the
			// one inside the app here, the delivered one on a host.
			nvim: async (target) => {
				if (target.machine === "local" && socketProblem !== undefined) {
					throw new Error(socketProblem);
				}
				const program = await runtimeById(target.machine).neovimProgram();
				if (program.kind === "unavailable") {
					throw new Error(neovimMissingMessage(target.machine, program.reason));
				}
				return program.path;
			},
			socketDirectory,
			remoteSockets: async (target) => {
				const runtime = runtimeById(target.machine);
				return remoteNeovimSockets(runtime, forwards);
			},
			onExit: (workspaceId) => {
				console.log(`[devhub] the managed Neovim of ${workspaceId} ended`);
			},
			theme: () => themePublicationIfInstalled()?.current(),
			onThemeFailure: (workspaceId, error) => {
				console.error(
					`[devhub] the managed Neovim of ${workspaceId} was not told the theme: ${failureText(error)}`,
				);
			},
		});
	}

	/**
	 * The `/devhub` skill and its launcher, rewritten for this run (see
	 * `agent/devhubSkill.ts`). A skill that cannot be written is said and
	 * skipped: the Agents start without it, which is how they started before.
	 */
	private writeAgentSkill(userDataPath: string): DevhubSkill | undefined {
		const skill = devhubSkillPaths(userDataPath);
		try {
			writeDevhubSkill(skill, launcherScript(launcherRequest(userDataPath)));
			return skill;
		} catch (error) {
			console.error(
				`[devhub] could not write the /devhub agent skill: ${failureText(error)}`,
			);
			return undefined;
		}
	}

	/**
	 * The `/devhub-orchestrator` skill, rewritten for this run beside
	 * `/devhub` and naming the same launcher (`orchestrator/orchestratorSkill.ts`).
	 * One that cannot be written is said and skipped.
	 */
	private writeOrchestratorSkill(
		userDataPath: string,
	): OrchestratorSkill | undefined {
		const skill = orchestratorSkillPaths(userDataPath);
		try {
			writeOrchestratorSkill(skill, devhubSkillPaths(userDataPath).cli);
			return skill;
		} catch (error) {
			console.error(
				`[devhub] could not write the /devhub-orchestrator skill: ${failureText(error)}`,
			);
			return undefined;
		}
	}

	/** Every Agent the model has, by id. */
	private modelAgentIds(): ReadonlySet<string> {
		return new Set(
			this.coordinator.model.workspaces.flatMap((workspace) =>
				workspace.agents.map((agent) => agent.id),
			),
		);
	}

	/**
	 * Keeps Scratch on today's folder under the `[scratch] daily` this run is
	 * on: at each local midnight, on a wake, and when settings with a
	 * different `daily` are accepted (`settingsAccepted`). Only the identity moves:
	 * yesterday's folder stays open as an ordinary row with its Agents and its
	 * workbench exactly as they were. The launch itself was reconciled before
	 * the model existed (`createAppController`).
	 */
	private readonly scratch: ScratchFollower;

	/** Make `today` Scratch. See `AppModel.adoptScratchDay`. */
	private async adoptScratchDay(today: ScratchDay): Promise<void> {
		await this.dispatchAwaiting({
			type: "adopt_scratch_day",
			workspaceId: today.workspace.id,
			location: today.workspace.location,
			selectedPath: today.workspace.selectedPath,
		});
		if (today.failure !== undefined) {
			await this.dispatchAwaiting({
				type: "workspace_root_unreadable",
				workspaceId: this.coordinator.model.scratchWorkspaceId,
				reason: "root_inaccessible",
			});
			this.publishError(
				withDetail(errorWireAt("workspace_unavailable"), today.failure),
			);
		}
	}

	/**
	 * What a sleep does to every connection, answered in one place.
	 *
	 * A suspended Mac leaves an ssh ControlMaster holding a socket whose other
	 * end is long gone, and OpenSSH keeps it for `ControlPersist` — so without
	 * this, waking up buys minutes of rounds that cannot work, against a host
	 * that is in fact reachable. Told to every runtime rather than to the ones
	 * this file thinks are remote (`Runtime.resumed`), because which of them
	 * have a connection to rebuild is theirs to know; and followed by one wake,
	 * so the answer arrives at the next round instead of at the next tick.
	 */
	private watchForWake(): void {
		const wake = (): void => {
			for (const runtime of liveRuntimes()) runtime.resumed();
			this.agentReconcilers.wake();
			// A Mac asleep across midnight wakes to a timer aimed at a moment
			// that has passed, or at one in a timezone it has left. Not caught
			// here: a failure goes to the main process's root like any other.
			void this.scratch.resumed();
		};
		electron.powerMonitor.on("resume", wake);
		this.stopWatchingWake = (): void => {
			electron.powerMonitor.off("resume", wake);
		};
	}

	private stopWatchingWake: (() => void) | undefined;

	/**
	 * Wire the menu bar to the same model everything else uses.
	 *
	 * Every command here is an ordinary intent, dispatched exactly as the page
	 * dispatches its own; only opening the picker is pushed to the page, because
	 * the picker is a page dialog and nothing in the model knows about it.
	 */
	installMenuBar(): void {
		installMenu({
			snapshot: () => this.snapshot(),
			focusedWindow: () => (settingsWindowIsFocused() ? "settings" : "shell"),
			// The menu item is the same command as the chord and the sidebar's
			// button, so it is the same line. It used to go straight to
			// `requestCloseWorkspace`, around the worktree rule — so File ▸ Close
			// Workspace left a worktree's folder on disk and every other way of
			// closing the same row deleted it.
			closeWorkspace: (workspaceId) => {
				this.closeWorkspaceOrWorktree(workspaceId);
			},
			openWorkspacePicker: () => {
				this.send(CHANNELS.menuCommand, "open_workspace_picker");
			},
			openSettings: () => {
				openSettingsWindow();
			},
			openDeveloperTools: () => {
				this.openDeveloperTools();
			},
		});
	}

	/**
	 * `DevHub: Open Log`: main's log (`diagnostics/mainLog.ts`), in whatever
	 * the Mac opens a `.log` file with — Console, unless the person chose
	 * another app.
	 *
	 * Not in a workbench: the log is most wanted when a workbench is the thing
	 * misbehaving (or asleep, and opening one would wake it and write more of
	 * the log being read), a five-megabyte file is not a thing to put in an
	 * editor's history, and Console follows the file as it grows. Settings'
	 * log folder button opens the folder it is in.
	 */
	private async openLog(): Promise<void> {
		const userDataPath = this.userDataPath;
		if (userDataPath === undefined) return;
		const file = mainLogPath(userDataPath);
		// Said before it is opened, so the file exists and ends with this.
		console.log(`[devhub] log: opening ${file}`);
		const failure = await electron.shell.openPath(file);
		if (failure.length === 0) return;
		this.publishError(
			withDetail(
				withSummary(
					errorWireAt("file_not_found"),
					"The log could not be opened.",
				),
				`${file}: ${failure}`,
			),
		);
	}

	/**
	 * `DevHub: Install 'devhub' command in PATH`: write the launcher
	 * (`cli/install.ts`) and say where it went, or why it went nowhere.
	 *
	 * DevHub's own command rather than a workbench's, because the launcher is
	 * DevHub's and a Workspace whose editor is Neovim has no workbench to run a
	 * command in. The answer is a message box, the way VS Code answers its own
	 * "Shell Command: Install 'code' command in PATH": it is the one sentence
	 * the person asked for, and it may tell them to change their PATH.
	 */
	private async installCli(): Promise<void> {
		const userDataPath = this.userDataPath;
		if (userDataPath === undefined) return;
		let message: string;
		try {
			message = installLauncher(launcherRequest(userDataPath)).message;
		} catch (error) {
			this.publishError(
				withDetail(
					withSummary(
						errorWireAt("native_unavailable"),
						`The '${activeProfile().cliCommandName}' command could not be installed.`,
					),
					failureText(error),
				),
			);
			return;
		}
		console.log(`[devhub] cli: ${message}`);
		const options: Electron.MessageBoxOptions = {
			type: "info",
			message: `Install '${activeProfile().cliCommandName}' command in PATH`,
			detail: message,
			buttons: ["OK"],
			noLink: true,
		};
		const shell = shellWindowIfCreated();
		await (shell
			? electron.dialog.showMessageBox(shell.window, options)
			: electron.dialog.showMessageBox(options));
	}

	/**
	 * Open the Web Inspector on whatever the keyboard is in.
	 *
	 * One DevHub window holds several web contents over one rectangle — the App
	 * Shell page, a `WebContentsView` per workbench — and Settings is a window
	 * of its own. "The page" therefore names nothing on its own, so this asks
	 * the same question the focus rule asks and gets the same answer: Settings
	 * when Settings has the keyboard, and otherwise whatever `focusTarget` says
	 * is on screen. Two rules would drift; there is one, and the Inspector opens
	 * on the thing the person is looking at.
	 *
	 * Detached, because a panel docked inside a workbench view would be laid out
	 * inside the rectangle DevHub positions, and the surface would appear to
	 * shrink for reasons nothing on screen explains.
	 */
	private openDeveloperTools(): void {
		const contents = settingsWindowIsFocused()
			? settingsWindowContents()
			: taskManagerWindowIsFocused()
				? taskManagerWindowContents()
				: shellWindow().focusTarget();
		if (!contents || contents.isDestroyed()) return;
		contents.openDevTools({ mode: "detach" });
	}

	/**
	 * Wire the Command-Q chords to the same commands the menu bar raises.
	 *
	 * Every one of these is a line the menu already has, on purpose: a chord is
	 * a second way to reach a command, never a second implementation of it.
	 * See `chords.ts` for the table and `keyboard.ts` for where it is caught.
	 */
	installChords(): void {
		// The input source a chord switches, and the root surface it says a
		// failure on. See `chordInputSource.ts`.
		const inputSource = new InputSourceHelper(inputSourceHelperPath(APP_ROOT));
		const report = (failure: unknown) => {
			this.publishError(errorWire(failure));
		};
		const chordHost: ChordHost = {
			snapshot: () => this.chordSnapshot(),
			selectContext: (context, presentation) => {
				this.arrive(
					intentFromWire({
						type: "select_context",
						context,
						...(presentation === "beside" ? { split: true } : {}),
					}),
				);
			},
			swapSplitFocus: () => {
				this.swapSplitFocus();
			},
			interacted: (surfaceUrl) => {
				if (isDestinationSurface(surfaceUrl)) this.noteInteraction();
			},
			cyclePaneFocus: () => {
				this.arrive({ type: "cycle_pane_focus", direction: 1 });
			},
			toggleTerminal: (agentId) => {
				void this.toggleAgentTerminal(parseAgentId(agentId)).catch(report);
			},
			terminalNeedsAgent: () => {
				this.publishError(errorWireAt("terminal_needs_agent"));
			},
			terminalNeedsAgentView: () => {
				this.publishError(errorWireAt("terminal_needs_agent_view"));
			},
			closeTerminal: (terminalId) => {
				void this.closePaneTerminal(terminalId).catch(report);
			},
			togglePlace: (place) => {
				// A selection change like any other, to a place only the model
				// remembers — so it arrives exactly the way `selectContext` does.
				this.arrive({ type: "toggle_place", place });
			},
			openWorkspacePicker: () => {
				this.send(CHANNELS.menuCommand, "open_workspace_picker");
			},
			openTabPicker: () => {
				shellWindow().picker.openModal({ kind: "tab-picker" });
			},
			openAgentPicker: (workspaceId) => {
				// The same door the sidebar's `+` goes through: it asks main to
				// open this modal, and this *is* main.
				shellWindow().picker.openModal({ kind: "agent-picker", workspaceId });
			},
			openIssuePicker: () => {
				shellWindow().picker.openModal({ kind: "issue-assignment" });
			},
			openAgentActions: (agentId) => {
				shellWindow().picker.openModal({ kind: "agent-actions", agentId });
			},
			renameAgent: (agentId) => {
				shellWindow().picker.openModal({ kind: "agent-rename", agentId });
			},
			markAgentUnread: (agentId) => {
				// The same intent the row menu dispatches, through the same
				// door: a chord is another way to raise a command DevHub has.
				this.dispatchOwn(
					intentFromWire({ type: "mark_agent_unread", agentId }),
				);
			},
			focusSidebar: () => {
				// Two halves, and both are needed: main moves the keyboard into
				// the Sidebar's view, because no page can focus another page,
				// and the Sidebar's page puts it on the row that is selected,
				// because no one but that page knows which row that is.
				this.keyboardInSidebar = true;
				this.publishLayoutState();
				shellWindow().focusSurface();
				this.send(CHANNELS.menuCommand, "focus_sidebar");
			},
			toggleSidebar: () => {
				// A change to the model like the resize beside it, so the page
				// re-renders narrower and the rectangle it reports for the
				// workbench is the freed width. Nothing here lays anything out.
				this.dispatchOwn({ type: "toggle_sidebar" });
			},
			terminalZoom: (direction) => {
				// A question that is up holds the keyboard, so this is all but
				// unreachable while one is — and "all but" is not a rule. The
				// keys go through main because main is in front of every
				// surface, and being in front of a modal and acting anyway is
				// the one thing that would make it a modal in name only.
				if (shellWindow().picker.openModals().length > 0) return false;
				const config = this.config;
				this.dispatchOwn({
					type: "terminal_zoom",
					direction,
					base: config.appearance.terminalFontSize,
				});
				// The size lives on the appearance projection, which the model's
				// own revision does not carry: the panes learn the new size the
				// same way they learn an edited setting.
				this.publishAppearance();
				return true;
			},
			dismissAlert: () => {
				// The page that draws app-scoped notices, and nowhere else.
				// Every failure main raises goes to that one page, so there is
				// one alert to put away however it got there — and the chord has
				// to reach the page that has it rather than every page that
				// might. The Settings window's own refusal is not this: its
				// Dismiss button is ordinary DOM in a window where Tab works, so
				// it was never out of the keyboard's reach.
				this.sendToDisplay(CHANNELS.menuCommand, "dismiss_alert");
			},
			showNotifications: () => {
				// Under a question the keyboard is the question's, and the
				// notices are drawn under it.
				const window = shellWindow();
				if (window.picker.openModals().length > 0) return;
				// The page knows whether the center is open and decides; the
				// keyboard goes to it either way, since only main can move it
				// between views. Closing hands it back (`focusSurface`).
				this.sendToDisplay(CHANNELS.menuCommand, "show_notifications");
				window.toasts.contents()?.focus();
			},
			// A close typed from the keyboard is a move like every other chord
			// that goes somewhere: it ends on the row the model repairs the
			// selection to (`AppModel.repairSelection`), and the keyboard ends
			// there with it — out of the Sidebar too. It is taken out now, not
			// when the close lands: a close that asks first is answered on the
			// sheet, which puts the keys on the surface whatever it is asked
			// from, and one that does not ask would otherwise leave them on a
			// row that has gone.
			closeAgent: (agentId) => {
				this.placeKeyboardOnSurface();
				this.requestCloseAgent(agentId);
			},
			restartAgent: (agentId) => {
				void this.requestRestartAgent(agentId);
			},
			closeWorkspace: (workspaceId) => {
				this.placeKeyboardOnSurface();
				this.closeWorkspaceOrWorktree(workspaceId);
			},
			reopenClosed: () => {
				this.placeKeyboardOnSurface();
				void this.reopenClosed().catch(report);
			},
			openRecentlyClosed: () => {
				void this.openRecentlyClosed().catch(report);
			},
			reorderEntries: (order, workspaceId) => {
				// The same intents the Sidebar's own drag raises, through the same
				// door: a chord is another way to raise a command DevHub has.
				this.dispatchOwn(
					intentFromWire(
						workspaceId === undefined
							? { type: "reorder_workspaces", order }
							: { type: "reorder_agents", workspaceId, order },
					),
				);
			},
			refreshRepositories: () => {
				this.repositoryStatus.look();
			},
			openChordHelp: () => {
				shellWindow().picker.openModal({
					kind: "chord-help",
					rows: this.chordHelpRows(),
				});
			},
			openSettings: () => {
				openSettingsWindow();
			},
			openLog: () => {
				void this.openLog().catch(report);
			},
			previewColorTheme: () => {
				this.openThemePreview();
			},
			openTaskManager: () => {
				openTaskManagerWindow();
			},
			installCli: () => {
				void this.installCli().catch(report);
			},
			navigateHistory: (direction) => this.navigateHistory(direction),
			openCommandPalette: () => {
				void this.openCommandPalette(chordHost);
			},
		};
		this.chordHost = chordHost;
		installKeyboard(inputSource, report, chordHost);
		setArmingObserver((armed) => {
			// While a chord is armed the keyboard stays where DevHub's chord
			// layer sees it; see `ShellWindow.chordArmedChanged`.
			shellWindowIfCreated()?.chordArmedChanged(armed);
			this.send(CHANNELS.chordArmedChanged, armed);
		});
		this.applyChordLayout();
		this.installHistoryGestures();
	}

	/**
	 * Back or Forward through the places the window has shown, raised by main.
	 *
	 * A move like any chord's (`arrive`): the keyboard goes to what it lands
	 * on. Declined while a question is up, on the zoom's terms — a modal holds
	 * the keyboard, and walking away from the place it asks about would be
	 * answering it by leaving. With nowhere to go the model does nothing, and
	 * the key is still taken: it was a Back, on a page where Back means this.
	 */
	private navigateHistory(direction: NavigationDirection): boolean {
		if (shellWindow().picker.openModals().length > 0) return false;
		this.arrive({ type: "navigate_history", direction });
		return true;
	}

	/**
	 * The window-level gestures for Back and Forward: Electron's
	 * `app-command` (the mouse's side buttons on Windows and Linux) and the
	 * trackpad's `swipe` on macOS.
	 *
	 * Neither says which surface it was over, so both are decided by where the
	 * keyboard is (`focusTarget`), which is the closest thing to "the area the
	 * person is in" main has. Over a workbench they are left to VS Code, whose
	 * own Back and Forward are the editor's (`historyKeys.ts`). The pages that
	 * answer the side buttons in their own DOM (`shell/historyButtons.ts`) are
	 * left out of `app-command`, so one press is never two moves.
	 */
	private installHistoryGestures(): void {
		const shell = shellWindowIfCreated();
		if (!shell) return;
		const ownButtons = [
			"/agents.html",
			"/conversations.html",
			"/sidebar.html",
			"/pane.html",
		];
		shell.window.on("app-command", (_event, command) => {
			const direction = appCommandDirection(command);
			if (direction === undefined) return;
			const url = shell.focusTarget().getURL();
			if (!isAppHistorySurface(url)) return;
			if (ownButtons.some((page) => url.includes(page))) return;
			this.navigateHistory(direction);
		});
		shell.window.on("swipe", (_event, swiped) => {
			const direction = swipeDirection(swiped);
			if (direction === undefined) return;
			if (!isAppHistorySurface(shell.focusTarget().getURL())) return;
			this.navigateHistory(direction);
		});
	}

	/**
	 * Hand the chord layer the table the configuration says it should have.
	 *
	 * Called once at start and again on every configuration change, because the
	 * file is already re-read when it changes and a keyboard that needed a
	 * restart would be the one setting in DevHub that did.
	 *
	 * A `[keybindings]` table that would not validate never gets here: the store
	 * refuses the whole file and keeps the last one that parsed, which is why
	 * `resolveBindings` can skip a bad entry rather than having an opinion about
	 * it.
	 */
	private applyChordLayout(): void {
		const spec = this.config.keybindings;
		const resolved = resolveBindings(spec);
		setChordLayout({ prefix: resolved.prefix, table: resolved.bindings });
	}

	/**
	 * Every chord there is, for the help overlay.
	 *
	 * Built from the registry and from the table actually in effect, so a person
	 * who rebound a key reads their own keyboard rather than DevHub's shipped
	 * one — and a command added later appears here without anybody remembering
	 * to add it.
	 */
	private chordHelpRows(): readonly ChordHelpRowWire[] {
		const spec = this.config.keybindings;
		const { prefix, bindings } = resolveBindings(spec);
		const armed = describeChordKey(prefix);
		return COMMANDS.map((command) => ({
			commandId: command.id,
			label: command.label,
			chords: keysForCommand(bindings, command.id).map(
				(key) => `${armed} ${describeChordKey(key)}`,
			),
			...(command.needs === "nothing"
				? {}
				: {
						needs: NEEDS_PHRASE[command.needs],
					}),
		})).filter((row) => row.chords.length > 0);
	}

	/**
	 * Side by side: move the keyboard between the editor and the Agent's pane.
	 *
	 * The half in front is *what is selected* — a split with the Agent selected
	 * and a split with its workspace selected are the same two panes with the
	 * keyboard in a different one — so the swap is a change to the model and
	 * not a boolean kept out here. It used to be that boolean, which meant two
	 * answers to "which half am I in": this one, which started on the editor
	 * whatever had been selected, and the selection, which `Cmd+Q Z` has
	 * to read to know which half to leave the split to.
	 *
	 * The Agent's pane is drawn by the App Shell page and the workbench is a
	 * native view, so the two halves are moved to differently: one is the
	 * window's own focus rule, and the other is a message to the page (see
	 * `shell/focusHome.ts`, which is the page's half of that rule).
	 */
	private swapSplitFocus(): void {
		this.arrive({ type: "swap_split_focus" });
	}

	//#region the Agents' terminals

	/**
	 * `Cmd+Q V`: show or hide an Agent's own terminal on the right, starting it
	 * the first time (`model/agentTerminal.ts`). Hiding leaves its session
	 * running; the keyboard, if it was in it, goes back to the content.
	 */
	async toggleAgentTerminal(agentId: AgentId): Promise<void> {
		const model = this.coordinator.model;
		const terminal = model.agentTerminal(agentId);
		if (terminal?.open === true && model.terminalAgentId() === agentId) {
			const focused = model.paneFocus !== undefined;
			this.dispatchOwn({
				type: "agent_terminal_shown",
				agentId,
				open: false,
				focus: false,
			});
			if (focused) this.placeKeyboardOnSurface();
			return;
		}
		await this.openAgentTerminal(agentId, { focus: true });
	}

	/**
	 * Open an Agent's own terminal, or show the one it has: `Cmd+Q V`, and
	 * `devhub --tell terminal open`. Idempotent — an Agent has one terminal,
	 * and asking again shows the same one.
	 *
	 * The terminal is a tmux session of its own on the Workspace's machine —
	 * the same server, socket and config as the Workspace's own terminals —
	 * named `tm-<agent id>` and started in the Workspace's folder (the Agent's
	 * worktree, when the Workspace is one). Whether a session is there is
	 * tmux's answer, read first: a terminal the model remembers whose shell
	 * has exited is started again, and a session that outlived what the model
	 * remembered is taken back rather than shadowed. Only once the session
	 * exists is the model told, so a pane is never drawn for a session that
	 * failed to start.
	 *
	 * `command` is typed into the shell, not run instead of it — and only into
	 * a terminal this call started: typing into one that is already running
	 * something would be typing into whatever that is.
	 */
	async openAgentTerminal(
		agentId: AgentId,
		options: { readonly command?: string; readonly focus: boolean },
	): Promise<{ readonly terminalId: string; readonly created: boolean }> {
		const wiring = this.terminalsWiring;
		if (!wiring) throw new Error("the terminal runtime is not running");
		const model = this.coordinator.model;
		const workspace = model.workspaceForAgent(agentId);
		if (!workspace) throw new Error(`there is no Agent ${agentId}`);
		const machine = runtimeIdFor(workspace.location);
		const runtime = await wiring.runtimes.for(runtimeById(machine));
		if (!runtime.adapterAvailable) {
			throw new Error(
				runtime.unavailableReason ?? `there is no tmux on ${machine}`,
			);
		}
		const live = await runtime.paneTerminals();
		const alive = (terminalId: string): boolean =>
			live.some(
				(pane) =>
					pane.terminalId === terminalId && pane.workspaceId === workspace.id,
			);
		const reveal = (terminalId: string, known: boolean) => {
			this.dispatchOwn(
				known
					? {
							type: "agent_terminal_shown",
							agentId,
							open: true,
							focus: options.focus,
						}
					: {
							type: "agent_terminal_opened",
							agentId,
							terminalId,
							focus: options.focus,
						},
			);
			if (options.focus) this.placeKeyboardOnSurface();
			return { terminalId, created: false };
		};
		const existing = model.agentTerminal(agentId);
		if (existing && alive(existing.terminalId)) {
			return reveal(existing.terminalId, true);
		}
		const terminalId: string = agentId;
		if (alive(terminalId)) return reveal(terminalId, false);
		if (!workspace.canCreateAgent) {
			throw new Error(
				`${workspace.root} is closing or unavailable, so there is no folder to open a terminal in.`,
			);
		}
		const target = {
			machine,
			terminalId,
			workspaceId: workspace.id,
			root: workspace.root,
		};
		this.launchingTerminals.add(terminalId);
		try {
			await runtime.launchTerminal(target);
			if (options.command !== undefined && options.command.length > 0) {
				await runtime.typeIntoTerminal(target, options.command);
			}
			try {
				this.coordinator.dispatchUser({
					intentId: parseIntentId(randomUUID()),
					operationId: this.freshOperationId(),
					intent: {
						type: "agent_terminal_opened",
						agentId,
						terminalId,
						focus: options.focus,
					},
				});
			} catch (error) {
				await runtime.closeTerminal(target).catch(() => undefined);
				throw error;
			} finally {
				this.drain();
			}
			if (options.focus) this.placeKeyboardOnSurface();
			return { terminalId, created: true };
		} finally {
			this.launchingTerminals.delete(terminalId);
		}
	}

	/**
	 * Close an Agent's terminal: its clients, its session, then its pane.
	 * Answers whether it had one.
	 *
	 * The session goes first, so the pane is never gone while the shell is
	 * still running unseen; a session already gone (the shell exited) is the
	 * same as one closed here.
	 */
	async closeAgentTerminal(agentId: AgentId): Promise<boolean> {
		const wiring = this.terminalsWiring;
		const model = this.coordinator.model;
		const terminal = model.agentTerminal(agentId);
		if (!terminal) return false;
		const workspace = model.workspaceForAgent(agentId);
		if (wiring && workspace) {
			await wiring.service.surfaces.closePaneTerminal({
				machine: runtimeIdFor(workspace.location),
				terminalId: terminal.terminalId,
				workspaceId: workspace.id,
				root: workspace.root,
			});
		}
		const focused = model.paneFocus === terminal.terminalId;
		this.dispatchOwn({ type: "agent_terminal_closed", agentId });
		// The keyboard was in the pane that went; it goes back to the content
		// rather than staying on a view that is gone.
		if (focused) this.placeKeyboardOnSurface();
		return true;
	}

	/** An Agent's terminal's target, with the tmux of its Workspace's machine. */
	private async terminalOf(agentId: AgentId, terminalId?: string) {
		const wiring = this.terminalsWiring;
		if (!wiring) throw new Error("the terminal runtime is not running");
		const model = this.coordinator.model;
		const workspace = model.workspaceForAgent(agentId);
		if (!workspace) throw new Error(`there is no Agent ${agentId}`);
		const machine = runtimeIdFor(workspace.location);
		return {
			runtime: await wiring.runtimes.for(runtimeById(machine)),
			workspaceId: workspace.id,
			target: {
				machine,
				terminalId:
					terminalId ?? model.agentTerminal(agentId)?.terminalId ?? agentId,
				workspaceId: workspace.id,
				root: workspace.root,
			},
		};
	}

	/**
	 * `devhub --tell terminal bring`: one pane of the Workspace's editor
	 * terminal into the Agent's, its process running on — the terminal
	 * opened with it in place of the fresh shell, or the pane added as a
	 * split of the one open.
	 */
	private async bringPane(
		agentId: AgentId,
		paneId: string,
		focus: boolean,
	): Promise<{ readonly created: boolean }> {
		const { created, terminalId } = await this.openAgentTerminal(agentId, {
			focus,
		});
		const { runtime, target } = await this.terminalOf(agentId, terminalId);
		await runtime.joinIntoTerminal(target, paneId, created);
		return { created };
	}

	/**
	 * The stop sheet's "Move the terminal to the editor": the terminal's
	 * windows go to the Workspace's editor terminal (`ws-` session, which
	 * the editor attaches to whenever it is up), still running, and the
	 * Agent's pane closes on its emptied session.
	 */
	private async moveAgentTerminalToEditor(agentId: AgentId): Promise<void> {
		if (!this.coordinator.model.agentTerminal(agentId)) return;
		const { runtime, target } = await this.terminalOf(agentId);
		await runtime.moveTerminalToWorkspace(target);
		await this.closeAgentTerminal(agentId);
	}

	/** `Cmd+Q X` in the terminal: by the terminal's id. */
	private async closePaneTerminal(terminalId: string): Promise<void> {
		const terminal = this.coordinator.model.agentTerminalById(terminalId);
		if (terminal) await this.closeAgentTerminal(terminal.agentId);
	}

	/**
	 * One of the content area's views took the keyboard by itself — a click.
	 *
	 * The model is told which pane, so `Cmd+Q X` closes the terminal the
	 * person is typing into and `Cmd+Q O` steps from there; and a click into
	 * the other half of the workbench/Agent split moves the selection's half,
	 * because the keyboard being in the editor while the selection says the
	 * Agent is the two-answers problem `SurfacePresentation` exists to end.
	 * A focus main placed itself arrives here too, and changes nothing.
	 */
	private paneFocused(pane: ContentFocus): void {
		const model = this.coordinator.model;
		if (pane.kind === "terminal") {
			if (model.paneFocus === pane.terminalId) return;
			this.dispatchOwn({
				type: "focus_pane",
				target: { kind: "terminal", terminalId: pane.terminalId },
			});
			return;
		}
		if (model.paneFocus === undefined) return;
		this.dispatchOwn({ type: "focus_pane", target: { kind: "content" } });
		const selection = model.selection;
		if (selection.presentation !== "beside") return;
		const agentHalf = selection.context.kind === "agent";
		if (agentHalf !== (pane.kind === "agents")) {
			this.dispatchOwn({ type: "swap_split_focus" });
		}
	}

	//#endregion

	/**
	 * A move made from the keyboard: make it, and take the keyboard there.
	 *
	 * The one rule for every chord that goes somewhere. The keyboard ends in
	 * what the move selected — the Sidebar is left too, because a chord typed
	 * there is not the Sidebar's own Return, which is the one keyboard
	 * selection that stays in the list.
	 *
	 * Placed once more after the move even when the move changed nothing.
	 * `Cmd+Q 0` on Scratch from the Sidebar selects what is already selected,
	 * and is still somebody asking to be in Scratch.
	 */
	private arrive(intent: UserIntent): void {
		this.keyboardInSidebar = false;
		this.dispatchOwn(intent);
		this.placeKeyboardOnSurface();
	}

	/**
	 * Put the keyboard on whatever the selection has on screen.
	 *
	 * One sentence now, where it used to be two. An Agent's pane was drawn by
	 * the App Shell page, so "focus the Agent" could not be a focus call at
	 * all — it was a message asking that page to go and find the pane in its
	 * own DOM, which is the whole of what `shell/focusHome.ts` was. The Agents
	 * are a child of the window like the editor now, so both halves are the
	 * window's one answer: the arrangement already says which child the keys
	 * belong to (`keyboardChild`), and this is asking it again.
	 *
	 * Both callers are "the keyboard should go back to the surface now" —
	 * swapping the halves of a split, and Escape out of the Sidebar — and they
	 * ask it here rather than each deciding, because two answers to one question
	 * is how the split ended up focusing the wrong pane once already.
	 */
	private placeKeyboardOnSurface(): void {
		this.keyboardInSidebar = false;
		// The arrangement said "the Sidebar" a moment ago and says something
		// else now, so the window is told the new one before it is asked to
		// act on it.
		this.publishLayoutState();
		shellWindow().focusSurface();
	}

	/**
	 * Whether the person asked for the Sidebar, rather than for what is on
	 * screen.
	 *
	 * The one fact about the keyboard that is not a function of the model.
	 * Everything else — the workbench, the Agent beside it, which half of a
	 * split — is read off the selection, and this is not: selecting a
	 * Workspace while standing in the Sidebar is a perfectly ordinary thing to
	 * do and does not mean "and now leave". So it is a fact of its own, set by
	 * the one command that means it and cleared by the two that mean the
	 * opposite, and `publishLayoutState` is where it joins the rest.
	 */
	private keyboardInSidebar = false;

	/** The keyboard's host, which `devhub --tell run` runs a command through. */
	private chordHost: ChordHost | undefined;

	/** What the command palette ran lately, most recent first. Memory only. */
	private recentCommands: readonly CommandId[] = [];

	/**
	 * `Cmd+Q :` — every command, by name, run through the chord's own path.
	 *
	 * The rows are the registry, the chords actually in effect, and only the
	 * commands that would do something now: availability is the chord resolver
	 * itself, asked about the snapshot the palette opens on. The choice comes
	 * back as an index; the sheet is gone before the command runs, so a command
	 * that opens a sheet of its own (or declines while one is up, like Back)
	 * meets an empty modal layer.
	 */
	private async openCommandPalette(host: ChordHost): Promise<void> {
		const snapshot = this.chordSnapshot();
		if (!snapshot) return;
		const spec = this.config.keybindings;
		const { prefix, bindings } = resolveBindings(spec);
		const rows = commandPaletteRows({
			prefix,
			bindings,
			recent: this.recentCommands,
			available: (id) => resolveChord(id, snapshot) !== undefined,
		});
		const chosen = await shellWindow().picker.choose({
			kind: "command-palette",
			rows,
		});
		const row = rows[chosen];
		if (!row) return;
		this.recentCommands = rememberRecentCommand(
			this.recentCommands,
			row.commandId,
		);
		runCommand(host, row.commandId);
	}

	/**
	 * Stop an Agent, asking first, exactly as its own row does.
	 *
	 * The row dispatches `stop_agent` and draws the confirmation the model asks
	 * for; a chord cannot draw anything, so it opens the same confirmation on
	 * the modal layer with the same token. One question, one wording, one
	 * `confirm_stop_agent` — the chord is another way to press the row's button
	 * and not a second way to stop an Agent.
	 */
	private requestCloseAgent(agentId: string): void {
		void this.dispatchFromPage({ type: "stop_agent", agentId }).then(
			(outcome) => {
				// An idle Agent is stopped without a question — the model decides
				// that, from `interruptsNothing` — and then there is no confirmation in
				// the outcome and nothing to open.
				this.raiseCloseConfirmation(outcome, agentId);
			},
		);
	}

	/**
	 * Restart an Agent's session, asking first exactly as the Sidebar's
	 * Restart Session does: `/restart` and the chord cannot draw the question,
	 * so it goes on the modal layer with the same token (`requestCloseAgent`).
	 */
	private async requestRestartAgent(agentId: string): Promise<void> {
		this.raiseCloseConfirmation(
			await this.dispatchFromPage({ type: "restart_agent", agentId }),
			agentId,
		);
	}

	/**
	 * Getting rid of a workspace, whatever kind of workspace it is.
	 *
	 * **One path**, and this is it: the `Cmd+Q Shift+W` chord, `Cmd+Q X` on a
	 * workspace row, File ▸ Close Workspace, the sidebar's own close button and
	 * the Unavailable pane's all arrive here, because "close this" has to mean
	 * one thing. It used to mean several — the sidebar had a close button and a
	 * separate trash button and the chord only knew about the first; later the
	 * menu item and the surface pane dispatched the raw lifecycle intent — so
	 * whether a worktree survived depended on which control you happened to
	 * press.
	 *
	 * A close that failed is not a different act and has no separate entry: it
	 * is this same close, asked for again. What the model does with it is the
	 * model's, from state the model already holds.
	 *
	 * A worktree is a folder git made so that work could happen somewhere.
	 * Closing the workspace and leaving the folder behind is how a machine fills
	 * up with checkouts nobody can account for, so closing a worktree deletes
	 * it. What is *asked* is decided by whether there is anything in it to lose:
	 *
	 * - Not a worktree: the ordinary close, unchanged.
	 * - A clean worktree: removed without a question. git can rebuild it in a
	 *   second, and a question whose answer is always yes is what teaches people
	 *   to dismiss the ones that matter. Not `--force`, so if DevHub's "clean"
	 *   was a stale poll git refuses and nothing has happened.
	 * - A dirty worktree, or one DevHub could not read: the three-way question.
	 *   Not knowing is not clean, and the question is the safe branch.
	 *
	 * # When two things are worth asking about
	 *
	 * The folder and the work inside it are two different losses, and either
	 * can apply on its own, so they are two questions in one fixed order: the
	 * **folder first**, then the **close**. The folder question is the one that
	 * cannot be undone and the one whose answer decides whether there is
	 * anything left to close, so asking it second would be asking about a
	 * checkout that may be about to be deleted anyway.
	 *
	 * Neither is asked when there is nothing to lose: a clean worktree is
	 * removed without a word, and a workspace whose Agents are all idle closes
	 * without one — see `agentsInspection`. So the common case still asks
	 * nothing at all, and the two-sheet case is exactly the case where two
	 * different things were at stake.
	 */
	private closeWorkspaceOrWorktree(workspaceId: string): void {
		const workspace = this.coordinator.model.workspaces.find(
			(candidate) => candidate.id === workspaceId,
		);
		if (!workspace) return;
		const repository = this.lastRepositoryStatus.workspaces.find(
			(entry) => entry.workspaceId === workspaceId,
		);
		// The same predicate the sidebar's button reads to decide what to call
		// itself, so the label and the act cannot disagree.
		if (!closingDeletesWorktree(repository, workspace.root)) {
			this.requestCloseWorkspace(workspaceId, "keep");
			return;
		}
		if (repository?.dirty === false) {
			this.requestCloseWorkspace(workspaceId, "remove");
			return;
		}
		shellWindow().picker.openModal({
			kind: "worktree-close",
			workspaceId,
			label:
				this.snapshot()?.workspaces.find((one) => one.id === workspaceId)
					?.label ?? workspace.root,
			root: workspace.root,
			...(repository?.branch === undefined
				? {}
				: { branch: repository.branch }),
			...(repository?.dirty === undefined ? {} : { dirty: repository.dirty }),
		});
	}

	/**
	 * Put a question main raised on screen, if there is one to put there.
	 *
	 * Every way of closing something ends in an outcome, and an outcome that
	 * says `confirmation_required` is a question nobody has been asked yet. It
	 * goes to the one sheet that asks it — the same one a close started from
	 * the page opens — so a close cannot quietly stop halfway. The alternative
	 * was what this replaces: an outcome nobody read, and a row that stayed.
	 */
	private raiseCloseConfirmation(
		outcome: AppOutcomeWire,
		agentId?: string,
	): AppOutcomeWire {
		if (outcome.kind === "confirmation_required") {
			shellWindow().picker.openModal({
				kind: "close-confirmation",
				confirmationId: outcome.confirmationId,
				purpose: outcome.purpose,
				...(agentId === undefined ? {} : { agentId }),
			});
		}
		return outcome;
	}

	/**
	 * Ask to close a workspace, from a command with nobody waiting on it.
	 *
	 * The menu item and the `Cmd+Q Shift+W` chord are the same command, so they
	 * are the same line: one intent, and a failure that goes to the error
	 * surface the way every other unwatched failure does.
	 *
	 * A close that has something to ask about is *asked*, through
	 * `raiseCloseConfirmation`. This used to drop the `confirmation_required`
	 * outcome on the floor, so closing a workspace with an Agent in it — or an
	 * unsaved editor — did nothing at all and said nothing about why.
	 */
	private requestCloseWorkspace(
		workspaceId: string,
		worktree: WorktreeDisposition,
	): void {
		// One intent, whatever state the workspace is in. Choosing between a
		// fresh close and a retry used to happen here, from the workspace's own
		// state — a branch in a caller, which every other caller then had to
		// grow its own copy of or send the wrong one. A close that failed is
		// the same close, asked for again (`Coordinator.closeWorkspace`).
		void this.dispatchAwaiting({
			type: "request_close_workspace",
			workspaceId: parseWorkspaceId(workspaceId),
			worktree,
		}).then((settled) => {
			this.raiseCloseConfirmation(
				outcomeWire(
					settled,
					this.coordinator.readiness,
					this.repositoryOf,
					this.homeOf,
				),
			);
		});
	}

	get terminalRuntime(): TerminalWiring | undefined {
		return this.terminalsWiring;
	}

	/**
	 * What the socket a person is asking DevHub to move to looks like.
	 *
	 * Read-only, and the same probe the runtime uses for its own health, so the
	 * question the confirmation asks is the situation the migration will meet.
	 */
	async preflightTerminalSocket(name: string): Promise<TerminalPreflight> {
		const wiring = this.terminalsWiring;
		if (!wiring) throw new Error("the terminal runtime is not running");
		return (await wiring.local()).preflight(socketName(name));
	}

	/**
	 * Move DevHub's terminal sessions onto another socket.
	 *
	 * The order is the whole correctness argument. Every attached client is
	 * detached first, because a client of a session that is about to be killed
	 * is a client reading a closed pipe. Then one transition permit is held
	 * across the entire migration, so no ordinary operation can create a session
	 * on the socket being left behind — which is why the calls inside are the
	 * ungated `transition*` variants: taking the gate again under a permit we
	 * are already holding would deadlock, by design.
	 *
	 * Nothing here is caught. A migration that fails part-way must surface as a
	 * failure with the effective socket unchanged, not as an app that quietly
	 * believes it moved.
	 */
	/**
	 * Run something a question is waiting for, bounded and abandonable.
	 *
	 * Every lookup the picker starts goes through here, and that is the point:
	 * the rule is one deadline, one token, one sentence when it expires, and a
	 * rule stated once cannot be applied differently by the next handler that
	 * needs it. Each of these has parts with timeouts of their own — a source
	 * walk, a `git`, a `gh` — and none of those say anything about the sum,
	 * which is the number the person is actually waiting out.
	 *
	 * Starting one ends the one before it. There is one question on screen, so a
	 * second lookup means the answer to the first is not wanted: that is what
	 * makes typing a new query cancel the old search without the page having to
	 * say so.
	 *
	 * `what` is the subject of the sentence a person reads when it expires, so
	 * it is written as a noun phrase — "example/widget", "the folders a clone
	 * could go into" — and never as a verb or a channel name.
	 */
	private async boundedLookup<T>(
		what: string,
		run: (cancel: CancellationToken) => Promise<T>,
	): Promise<T> {
		this.pickerLookup?.cancel();
		const cancel = new CancellationToken();
		this.pickerLookup = cancel;
		// Which of the two ways this could end, because they are not the same
		// thing to say. A deadline is DevHub giving up and owes the person a
		// sentence; a person pressing Escape is not a failure and owes them
		// nothing, least of all a refusal for a question they withdrew.
		let expired = false;
		const timer = setTimeout(() => {
			expired = true;
			cancel.cancel();
		}, REPOSITORY_LOOKUP_DEADLINE_MS);
		try {
			return await run(cancel);
		} catch (error: unknown) {
			if (expired) {
				throw workspaceFailure(
					`${what} could not be found within ${String(
						REPOSITORY_LOOKUP_DEADLINE_MS / 1000,
					)}s. Something DevHub asked — a workspace source, or git — did not answer.`,
				);
			}
			if (cancel.isCancelled) {
				// Nobody is reading this: the page stopped waiting, which is why
				// the lookup stopped. It is thrown rather than answered with an
				// empty list so that a caller who somehow is still listening
				// cannot mistake "withdrawn" for "there is nothing".
				throw workspaceFailure("The lookup was cancelled.");
			}
			throw namedFailure(error);
		} finally {
			clearTimeout(timer);
			if (this.pickerLookup === cancel) this.pickerLookup = undefined;
		}
	}

	async changeTerminalSocket(name: string): Promise<void> {
		const wiring = this.terminalsWiring;
		if (!wiring) throw new Error("the terminal runtime is not running");
		const next = socketName(name);
		const previous = this.state.tmux.effective_socket_name;
		if (next === previous) return;

		wiring.service.surfaces.detachAll();
		const cancel = new CancellationToken();
		const old = socketName(previous);
		// One migration per machine, because a socket is one tmux server's and
		// the config names it for every machine at once. A host left behind
		// would keep its sessions on the old socket, which DevHub would never
		// look at again — the sessions would be running with nothing that can
		// reach them, which is the one outcome this whole flow exists to avoid.
		for (const machine of this.workspaceMachines()) {
			const runtime = await wiring.runtimes.for(runtimeById(machine));
			const release = await runtime.beginTransition();
			try {
				const owned = await runtime.transitionInspectOwnedSessions(old, cancel);
				for (const record of owned.sessions) {
					await runtime.transitionCloseOwnedSession(old, record, cancel);
				}
				const targets = [
					// The server's anchor, not Scratch: see `TerminalTarget`.
					...(machine === "local" ? [scratchTarget("local")] : []),
					...this.coordinator.model.workspaces
						.filter((workspace) => this.machineOf(workspace.id) === machine)
						.map((workspace) =>
							workspaceTarget(machine, workspace.id, workspace.root),
						),
				];
				for (const target of targets) {
					await runtime.transitionEnsureOnSocket(next, target, cancel);
				}
			} finally {
				release();
			}
		}
		await wiring.runtimes.setEffectiveSocket(next);
		this.state.tmux.effective_socket_name = next;
		await this.saveState();
	}

	windowFocusChanged(focused: boolean): void {
		// Whether the window is in front decides how loudly an unread Agent is
		// announced — a badge either way, a Dock bounce only while the person
		// is somewhere else. See `windowAttention.ts`.
		this.attention.windowFocusChanged(focused);
		this.shellFocused = focused;
		// Coming back to the window is a reason to look at the repositories
		// again, and the trigger DevHub was missing: a person leaves for a
		// terminal, commits, switches a branch, comes back — and until the poll's
		// minute was up the Sidebar showed them what it looked like before they
		// left. This is what VS Code's git extension does on
		// `window.onDidChangeWindowState`, and what the GitHub Pull Requests
		// extension does with its own queries. The watcher decides whether it is
		// worth a round; blur is not a trigger for anything.
		if (focused) this.repositoryStatus.focused();
		// Dispatched rather than awaited: nothing about a focus change has an
		// effect to wait for, and this is called from a window event that has
		// nowhere to put a rejected promise. A throw here is a bug in the model
		// and belongs on the console with its stack, not swallowed.
		this.coordinator.dispatchUser({
			intentId: parseIntentId(randomUUID()),
			operationId: this.freshOperationId(),
			intent: { type: "window_focus_changed", focused },
		});
		this.drain();
	}

	/**
	 * One round of the reconciler, about one machine.
	 *
	 * The machine is carried by the intent rather than worked out downstream,
	 * because a round *is* one question to one tmux server: the loop that asked
	 * is the loop that knows which one, and the answer is only ever complete
	 * for that machine.
	 */
	private async reconcileAgentsOn(machine: RuntimeId): Promise<void> {
		await this.dispatchAwaiting({ type: "reconcile_agents", machine });
	}

	/**
	 * Let go of a machine no Workspace is on any more.
	 *
	 * Both halves together, because they are one machine: the connection and
	 * the tmux adapter that speaks over it. Keeping either would be a
	 * multiplexed ssh master held open for a host nothing is asking about, and
	 * a `devhub --metrics` reading for a machine that has gone.
	 *
	 * The sessions over there are untouched. Reopening a Workspace on that host
	 * builds both again and finds them by their markers, which is the same
	 * thing a restart does.
	 */
	private releaseIdleMachines(): void {
		const live = new Set(this.workspaceMachines());
		for (const runtime of liveRuntimes()) {
			if (runtime.id === "local" || live.has(runtime.id)) continue;
			this.terminalsWiring?.runtimes.forget(runtime.id);
			// Nothing will ask this machine again, so nothing could ever retract
			// a condition about it: it goes now, with the machine.
			this.machineConditions.forget(runtime.id);
			this.launchers.delete(runtime.id);
			this.launcherStatus.delete(runtime.id);
			// A machine DevHub could not let go of is a machine it may still have
			// a connection and sessions on, which is worth more than a log line.
			void disposeRuntime(runtime.id);
		}
	}

	/**
	 * Write the state file, with the machines DevHub owns sessions on brought
	 * up to date.
	 *
	 * Every save goes through here, because "this DevHub has owned sessions on
	 * that machine" becomes true the moment a Workspace is open on it and there
	 * is no later moment at which anything else would notice. The list only
	 * grows here; the sweep is the one thing that shortens it, and only for a
	 * machine it found clean and unused.
	 */
	private async saveState(): Promise<void> {
		const remembered = new Set(this.state.session_machines);
		for (const machine of this.workspaceMachines()) remembered.add(machine);
		this.state.session_machines = [...remembered];
		await this.stateStore.saveState(this.state);
	}

	//#region sessions across worktrees, and the names they were given

	/**
	 * What a listing of `root`'s earlier sessions knows beyond the CLI's own
	 * store: the repository's worktrees, so another branch's sessions are
	 * listed with it, and the names people gave the Agents that ran them.
	 * Best effort — a folder git cannot be asked about lists its own.
	 */
	private async listingContext(
		runtime: Runtime,
		root: string,
		kind: AgentProfileKind,
	): Promise<ListingContext> {
		let repository: RepositoryWorktrees | undefined;
		try {
			repository = await repositoryWorktrees(
				await this.gitCommand(runtime),
				await runtime.realpath(root),
			);
		} catch {
			// Not a swallow: no git on that machine is a folder of its own
			// sessions, which is what the listing reads then.
			repository = undefined;
		}
		const names =
			kind === "claude" || kind === "codex"
				? this.sessionNames(kind)
				: new Map<string, string>();
		const known =
			kind === "claude" || kind === "codex"
				? this.sessionMeta.known(kind)
				: new Map<string, KnownSession>();
		return {
			...(repository === undefined ? {} : { repository }),
			nameOf: (session) => names.get(session),
			metaOf: (session) => known.get(session),
		};
	}

	/**
	 * Every session of `kind`'s CLI a person-given name is known for: those
	 * written down (`state.session_names`), and the sessions the named Agents
	 * running now were started on, which win.
	 */
	private sessionNames(kind: SessionNameKind): Map<string, string> {
		const names = new Map<string, string>();
		for (const record of this.state.session_names.toReversed()) {
			if (record.kind === kind) names.set(record.session, record.name);
		}
		for (const workspace of this.coordinator.model.workspaces) {
			for (const agent of workspace.agents) {
				if (!agent.named || agent.profile.kind !== kind) continue;
				const session = resumedSession(kind, agent.profile.args);
				if (session !== undefined) names.set(session, agent.displayName);
			}
		}
		return names;
	}

	/**
	 * The name to give back to an Agent started on `session`: the one
	 * `session_names` has, else a person-given one the meta index kept.
	 */
	private givenSessionName(
		kind: SessionNameKind,
		session: string,
	): string | undefined {
		const indexed = this.sessionMeta.index.of(kind, session);
		return (
			sessionNameOf(this.state.session_names, kind, session) ??
			(indexed?.named === true ? indexed.name : undefined)
		);
	}

	/**
	 * Set `meta`'s pairs and the managed flag on an Agent, after this save
	 * (each is an intent).
	 */
	private restoreSessionMeta(
		agentId: AgentId,
		meta: Readonly<Record<string, string>>,
		managed: boolean,
	): void {
		queueMicrotask(() => {
			void (async () => {
				if (managed)
					await this.dispatchAwaiting({
						type: "set_agent_managed",
						agentId,
						managed: true,
					});
				for (const [key, value] of Object.entries(meta)) {
					await this.dispatchAwaiting({
						type: "set_agent_meta",
						agentId,
						key,
						value,
					});
				}
			})().catch((error: unknown) => {
				console.warn(
					`[devhub] Agent ${agentId}: its session's metadata could not be given back: ${failureText(error)}`,
				);
			});
		});
	}

	/** Write down that `session` was the named Agent `name`'s. Saved with the next save. */
	private rememberSessionName(
		kind: AgentProfileKind,
		session: string,
		name: string,
	): void {
		if (kind !== "claude" && kind !== "codex") return;
		this.state.session_names = rememberSessionName(this.state.session_names, {
			kind,
			session,
			name,
			at: Date.now(),
		});
	}

	/** The Agents the name sweep has seen, and the name it wrote down for each. */
	private sweptAgents: Map<AgentId, string | undefined> | undefined;

	/**
	 * Keep `session_names` in step with the Agents, on every save.
	 *
	 * Two things, both about Agents the sweep has not seen as they are now:
	 *
	 * - **A named Agent** has its session written down under its name. A
	 *   resumed one says its session in its own record (`resumedSession`); a
	 *   GUI Agent's conversation knows it once its CLI has named one; a
	 *   terminal Agent's is read from its processes, once per name. Its close
	 *   writes it down again (`closedAgentOf`), which catches the rest.
	 * - **An Agent started on a session that had a name** — from New Agent's
	 *   earlier sessions, `/resume` in another worktree, `devhub` — is given
	 *   that name back, as Reopen Closed gives it back. Only an Agent started
	 *   since DevHub did: one that was already running when it started has
	 *   been seen by whoever renamed it or reset its name (`persist` counts
	 *   the Agents of the state file as seen before its first sweep).
	 */
	private sweepSessionNames(): void {
		const agents = this.coordinator.model.workspaces.flatMap(
			(workspace) => workspace.agents,
		);
		const swept = (this.sweptAgents ??= new Map());
		for (const agent of agents) {
			const kind = agent.profile.kind;
			if (kind !== "claude" && kind !== "codex") continue;
			const resumed = resumedSession(kind, agent.profile.args);
			const seen = swept.has(agent.id);
			if (!seen && !agent.named && resumed !== undefined) {
				const name = this.givenSessionName(kind, resumed);
				if (name !== undefined) {
					swept.set(agent.id, name);
					const agentId = agent.id;
					// After this save: a rename is an intent of its own.
					queueMicrotask(() => {
						void this.dispatchAwaiting({
							type: "rename_agent",
							agentId,
							displayName: name,
						}).catch((error: unknown) => {
							console.warn(
								`[devhub] Agent ${agentId}: its session's name could not be given back: ${failureText(error)}`,
							);
						});
					});
					continue;
				}
			}
			const name = agent.named ? agent.displayName : undefined;
			if (seen && swept.get(agent.id) === name) continue;
			swept.set(agent.id, name);
			if (name === undefined) continue;
			if (resumed !== undefined) {
				this.rememberSessionName(kind, resumed, name);
				continue;
			}
			const agentId = agent.id;
			void this.sessionAtClose(agentId).then((session) => {
				if (session === undefined) {
					// Not named yet by its CLI: asked again on a later save.
					if (agent.presentation === "gui") swept.delete(agentId);
					return;
				}
				const now = this.coordinator.model.agent(agentId);
				if (now?.named !== true) return;
				const before = this.state.session_names;
				this.rememberSessionName(kind, session, now.displayName);
				if (this.state.session_names !== before) {
					void this.saveState().catch(() => undefined);
				}
			});
		}
		for (const agentId of [...swept.keys()]) {
			if (!agents.some((agent) => agent.id === agentId)) swept.delete(agentId);
		}
	}

	/**
	 * After `/resume` in a GUI Agent: an Agent with no name of its own takes
	 * the name the session was given.
	 */
	private async sessionResumedIn(
		agentId: AgentId,
		session: string,
	): Promise<void> {
		const agent = this.coordinator.model.agent(agentId);
		const kind = agent?.profile.kind;
		if (agent === undefined) return;
		if (kind !== "claude" && kind !== "codex") return;
		const kept = this.sessionMeta.resumedIn(agent, session);
		if (kept !== undefined)
			this.restoreSessionMeta(agentId, kept.meta, kept.managed);
		if (agent.named) return;
		const name = this.givenSessionName(kind, session);
		if (name === undefined) return;
		await this.dispatchAwaiting({
			type: "rename_agent",
			agentId,
			displayName: name,
		});
	}

	/**
	 * Go on with a session of another worktree of the repository at `place`,
	 * in that worktree: see `sessionWorktree.ts`. The Workspace is opened (or
	 * focused) under the selection's, the session carried where its CLI will
	 * look for it, and an Agent of the profile started there on it.
	 */
	private async resumeSessionElsewhere(
		request: ResumeElsewhereWire,
		focus?: IntentFocus,
	): Promise<AppOutcomeWire> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.session)) {
			throw workspaceFailure(`${request.session} is not a session id.`);
		}
		const location = workspaceLocation(request.place);
		const runtime = runtimeFor(location);
		const root = await resumeFolder(
			await this.gitCommand(runtime),
			request.place.path,
			request.worktree,
		);
		const target: WorkspacePlaceWire = { ...request.place, path: root };
		const { profile } = await this.sessionsProfile(target, request.profileId);
		if (profile.kind === "claude" && request.cwd !== undefined) {
			await carryClaudeSession(
				runtime,
				profile,
				request.cwd,
				root,
				request.session,
			);
		}
		const opening = requestedLocation(target);
		let workspaceId: WorkspaceId;
		if (focus === "none") {
			workspaceId = await this.openFolderUnfocused(opening, "below-selection");
		} else {
			await this.openFolder(opening, undefined, "below-selection", "for-agent");
			workspaceId = this.openedWorkspaceId(opening);
		}
		const settled = await this.dispatchAwaiting({
			type: "create_agent",
			workspaceId,
			profileId: agentProfileId(request.profileId),
			presentation: request.split === true ? "beside" : "full",
			...(request.presentation === undefined
				? {}
				: { agentPresentation: agentPresentation(request.presentation) }),
			resume: sessionId(request.session),
			...(focus === undefined ? {} : { focus }),
		});
		return outcomeWire(
			settled,
			this.coordinator.readiness,
			this.repositoryOf,
			this.homeOf,
		);
	}

	/** `/resume` in a GUI Agent, on a session of another worktree. */
	private async resumeAgentSessionElsewhere(
		agentId: AgentId,
		session: PastSessionWire,
	): Promise<void> {
		const agent = this.coordinator.model.agent(agentId);
		const workspace = this.coordinator.model.workspaceForAgent(agentId);
		if (agent === undefined || workspace === undefined || !session.worktree) {
			throw new Error(`there is no running Agent ${agentId}`);
		}
		await this.resumeSessionElsewhere({
			place: workspacePlaceOf(workspace),
			profileId: agent.profile.id,
			session: session.id,
			worktree: session.worktree,
			...(session.cwd === undefined ? {} : { cwd: session.cwd }),
			presentation: agent.presentation,
		});
	}

	/**
	 * The branches of the repository the selection's Workspace is in, for the
	 * workspace picker: nothing for Scratch, a folder git does not know, or a
	 * git that cannot be asked.
	 */
	private async selectionBranches(): Promise<BranchListWire | undefined> {
		const model = this.coordinator.model;
		const anchor = this.placementAnchor();
		const workspace =
			anchor === undefined ? undefined : model.workspace(anchor);
		if (workspace === undefined) return undefined;
		const place = workspacePlaceOf(workspace);
		try {
			const runtime = runtimeFor(workspaceLocation(place));
			const command = await this.gitCommand(runtime);
			const branches = await listBranchCandidates(command, place.path);
			const repository = await repositoryWorktrees(command, place.path);
			const open = new Set(
				model.workspaces.map((each) => locationKey(each.location)),
			);
			// A Workspace's root is its real path; git lists the path it was given.
			const real = new Map(
				await Promise.all(
					branches.flatMap((branch) =>
						branch.worktree === undefined
							? []
							: [
									runtime
										.realpath(branch.worktree)
										.catch(() => branch.worktree!)
										.then((path) => [branch.worktree!, path] as const),
								],
					),
				),
			);
			const keyOf = (path: string) =>
				locationKey(
					workspaceLocation({ ...place, path: real.get(path) ?? path }),
				);
			return {
				place,
				repository: repositoryName(
					repository?.worktrees[0]?.path ?? place.path,
				),
				branches: branches.map((branch) => ({
					name: branch.name,
					...(branch.remote === undefined ? {} : { remote: branch.remote }),
					committedAt: branch.committedAt * 1000,
					...(branch.worktree === undefined
						? {}
						: { worktree: branch.worktree }),
					open:
						branch.worktree !== undefined && open.has(keyOf(branch.worktree)),
				})),
			};
		} catch (error: unknown) {
			console.warn(
				`[devhub] the branches of ${place.path} could not be listed: ${failureText(error)}`,
			);
			return undefined;
		}
	}

	/**
	 * A branch row of the workspace picker: its worktree opened (or focused),
	 * or made for it first — `ensureWorktree` with the branch as the work —
	 * and placed under the selection's Workspace like every opening from here.
	 * `create`: the New Branch row, a branch to start when it is nowhere yet.
	 */
	private async openBranchWorkspace(
		place: WorkspacePlaceWire,
		branch: string,
		create: boolean,
		withAgent: AgentLaunchWire | undefined,
	): Promise<AppOutcomeWire> {
		const location = workspaceLocation(place);
		const path = await ensureWorktree(
			await this.gitCommand(runtimeFor(location)),
			place.path,
			{ kind: "branch", create },
			branch,
		);
		return this.openFolder(
			requestedLocation({ ...place, path }),
			withAgent,
			"below-selection",
		);
	}

	//#endregion

	//#region recently closed

	/**
	 * Reopens run one at a time, in the order asked: two quick presses bring
	 * back the newest and then the one before it, rather than racing each
	 * other for the same entry.
	 */
	private reopening: Promise<void> = Promise.resolve();

	/** The page's snapshot with what main alone knows that chords read. */
	private chordSnapshot(): AppSnapshotWire {
		return {
			...this.snapshot(),
			recentlyClosed: this.state.recently_closed.length,
		};
	}

	/** Where a Workspace is, as a closed entry remembers it. */
	private closedPlaceOf(workspace: Workspace): ClosedPlaceRecord {
		const location = workspace.location;
		const editor =
			workspace.editor.kind === "devContainer"
				? { dev_container: workspace.editor.configPath as string }
				: {};
		return location.kind === "local"
			? { kind: "local", path: location.path, ...editor }
			: {
					kind: "ssh",
					host: location.host,
					path: location.path,
					...editor,
				};
	}

	/**
	 * The session an Agent's CLI is in, asked while it is still running: a
	 * GUI Agent's conversation knows it, a terminal Agent's is read from its
	 * processes. Best effort and bounded — a close is never held up for long
	 * by a question asked only so it can be undone — and nothing when it
	 * cannot be told, which reopening then says.
	 */
	private async sessionAtClose(agentId: AgentId): Promise<string | undefined> {
		const wiring = this.agentWiring;
		const agent = this.coordinator.model.agent(agentId);
		if (wiring === undefined || agent === undefined) return undefined;
		if (agent.profile.kind !== "claude" && agent.profile.kind !== "codex") {
			return undefined;
		}
		try {
			const session = await withDeadline(
				agent.presentation === "gui"
					? wiring.conversations.session(agentId)
					: wiring.terminalSession(agentId),
				SESSION_AT_CLOSE_TIMEOUT_MS,
				"the session could not be told in time",
			);
			return session === undefined ? undefined : sessionId(session);
		} catch (error: unknown) {
			console.warn(
				`[devhub] closing Agent ${agentId}: its session could not be told, so it cannot be reopened: ${failureText(error)}`,
			);
			return undefined;
		}
	}

	private async closedAgentOf(agentId: AgentId): Promise<ClosedAgentRecord> {
		const agent = this.coordinator.model.agent(agentId);
		if (agent === undefined) throw new Error(`no Agent ${agentId} is open`);
		const session = await this.sessionAtClose(agentId);
		// A named Agent's session keeps its name for the resume lists.
		if (agent.named && session !== undefined) {
			this.rememberSessionName(agent.profile.kind, session, agent.displayName);
		}
		// And its metadata, for 'sessions --meta' and whoever goes on with it.
		this.sessionMeta.closed(agent, session);
		return {
			profile_id: agent.profile.id,
			profile_kind: agent.profile.kind,
			display_name: agent.displayName,
			...(agent.named ? { named: true } : {}),
			presentation: agent.presentation,
			...(session === undefined ? {} : { session }),
		};
	}

	/** What reopening this Agent needs, or nothing when it is not open. */
	private async closedAgentEntry(
		agentId: AgentId,
	): Promise<ClosedEntryRecord | undefined> {
		const workspace = this.coordinator.model.workspaceForAgent(agentId);
		if (workspace === undefined) return undefined;
		return {
			kind: "agent",
			closed_at: Date.now(),
			place: this.closedPlaceOf(workspace),
			agent: await this.closedAgentOf(agentId),
		};
	}

	/** What reopening this Workspace needs, its running Agents included. */
	private async closedWorkspaceEntry(
		workspaceId: WorkspaceId,
		worktree?: ClosedWorktreeRecord,
	): Promise<ClosedEntryRecord | undefined> {
		const workspace = this.coordinator.model.workspace(workspaceId);
		if (
			workspace === undefined ||
			workspaceId === this.coordinator.model.scratchWorkspaceId
		) {
			return undefined;
		}
		return {
			kind: "workspace",
			closed_at: Date.now(),
			place: this.closedPlaceOf(workspace),
			agents: await Promise.all(
				workspace.agents.map((agent) => this.closedAgentOf(agent.id)),
			),
			...(worktree === undefined ? {} : { worktree }),
		};
	}

	/**
	 * Put one more closed thing on the stack. Not saved here: every close
	 * ends in a persist, which writes `this.state` — this list with it.
	 */
	private rememberClosedEntry(entry: ClosedEntryRecord): void {
		this.state.recently_closed = rememberClosed(
			this.state.recently_closed,
			entry,
		);
	}

	private setRecentlyClosed(stack: ClosedEntryRecord[]): void {
		this.state.recently_closed = stack;
		void this.saveState().catch((error: unknown) => {
			this.publishError(
				withDetail(
					errorWireAt("persistence_degraded"),
					this.persistenceReason(error),
				),
			);
		});
	}

	/** `Cmd+Q Shift+T`: the newest entry; pressed again, the one before it. */
	reopenClosed(): Promise<void> {
		return this.queueReopen(() => this.state.recently_closed[0]);
	}

	/** `Recently Closed…`: the stack as a list, and the chosen one reopened. */
	private async openRecentlyClosed(): Promise<void> {
		const entries = [...this.state.recently_closed];
		const now = Date.now();
		const chosen = await shellWindow().picker.choose({
			kind: "recently-closed",
			rows: entries.map((entry) => ({
				title: closedEntryLabel(entry),
				detail: closedEntryDetail(entry, now),
			})),
		});
		const entry = entries[chosen];
		if (entry === undefined) return;
		// By identity: the stack may have moved while the sheet was up.
		await this.queueReopen(() =>
			this.state.recently_closed.includes(entry) ? entry : undefined,
		);
	}

	private queueReopen(
		which: () => ClosedEntryRecord | undefined,
	): Promise<void> {
		const run = this.reopening.then(async () => {
			const entry = which();
			if (entry !== undefined) await this.reopenEntry(entry);
		});
		this.reopening = run.catch(() => undefined);
		return run;
	}

	/**
	 * Take one entry off the stack and bring it back.
	 *
	 * The rules are `model/recentlyClosed.ts`'s. What cannot come back
	 * (`ReopenRefused`) is said and the entry dropped, so the next press goes
	 * further back. A failure before anything was opened — the machine did
	 * not answer — puts the entry back where it was, so pressing again tries
	 * again. Once DevHub has started bringing it back, a failure is said and
	 * the entry is gone: what it could bring back is back.
	 */
	private async reopenEntry(entry: ClosedEntryRecord): Promise<void> {
		const index = this.state.recently_closed.indexOf(entry);
		if (index < 0) return;
		this.setRecentlyClosed(withoutEntry(this.state.recently_closed, index));
		const progress = { opened: false };
		try {
			const notes =
				entry.kind === "workspace"
					? await this.reopenWorkspace(entry, progress)
					: await this.reopenAgent(entry, progress);
			if (notes.length > 0) {
				this.publishError(
					withDetail(
						errorWireAt("closed_not_reopened"),
						`${closedEntryLabel(entry)} is back, but not all of it: ${notes.join(" ")}`,
					),
				);
			}
		} catch (error: unknown) {
			const label = closedEntryLabel(entry);
			if (error instanceof ReopenRefused) {
				this.publishError(
					withDetail(
						errorWireAt("closed_not_reopened"),
						`${label} cannot be reopened: ${error.message} It has been taken off Recently Closed.`,
					),
				);
				return;
			}
			if (!progress.opened) {
				this.setRecentlyClosed(
					restoreEntry(this.state.recently_closed, index, entry),
				);
			}
			this.publishError(
				withDetail(
					errorWireAt("closed_not_reopened"),
					`${label} could not be reopened: ${failureText(error)}${
						progress.opened
							? ""
							: " It is still in Recently Closed; Cmd+Q Shift+T tries it again."
					}`,
				),
			);
		}
	}

	/** The open Workspace on this place, if there is one. */
	private openWorkspaceAt(place: ClosedPlaceRecord): Workspace | undefined {
		const key = placeKey(place);
		return this.coordinator.model.workspaces.find(
			(workspace) => locationKey(workspace.location) === key,
		);
	}

	/**
	 * Open the place again, the way it was open: its folder on its machine,
	 * its editor in the dev container it was attached to. A folder that is no
	 * longer there is refused; a machine that does not answer is a failure
	 * that may pass.
	 */
	private async openClosedPlace(
		place: ClosedPlaceRecord,
		progress: { opened: boolean },
		worktree?: ClosedWorktreeRecord,
	): Promise<{ readonly workspaceId: WorkspaceId; readonly notes: string[] }> {
		let requested: WorkspacePlaceWire =
			place.kind === "local"
				? { kind: "local", path: place.path }
				: { kind: "ssh", host: place.host, path: place.path };
		let location: WorkspaceLocation;
		try {
			location = workspaceLocation(requested);
		} catch {
			throw new ReopenRefused("DevHub no longer reads where it was.");
		}
		const runtime = runtimeFor(location);
		const kind = await runtime.stat(location.path);
		if (kind === "absent" && worktree !== undefined) {
			// The worktree its close deleted, made again on its branch at the
			// path it had (`model/recentlyClosed.ts`).
			const made = await this.remakeClosedWorktree(
				requested,
				runtime,
				worktree,
			);
			requested = { ...requested, path: made };
		} else if (kind !== "directory") {
			throw new ReopenRefused(
				`${placeLabel(requested)} is no longer a folder${
					kind === "absent" ? " there: it has been deleted or moved." : "."
				}`,
			);
		}
		const opening = requestedLocation(requested);
		progress.opened = true;
		// Brought back with its Agents, or for one of them: its editor waits
		// to be asked for like any asleep one.
		await this.openFolder(opening, undefined, "automatic", "for-agent");
		const workspaceId = this.openedWorkspaceId(opening);
		// A dev container it was attached to is not reattached: that was VS
		// Code's (docs/without-vscode.md).
		const notes =
			place.dev_container === undefined
				? []
				: [
						"It was open in a dev container; DevHub opens it on its own machine now.",
					];
		return { workspaceId, notes };
	}

	/**
	 * Make a closed worktree again on its branch, at the path it had, and
	 * answer where it is. What can never work — the repository or the branch
	 * gone, the path taken by something else — is a refusal; anything else (a
	 * host that did not answer) is a failure the entry survives.
	 */
	private async remakeClosedWorktree(
		requested: WorkspacePlaceWire,
		runtime: ReturnType<typeof runtimeFor>,
		worktree: ClosedWorktreeRecord,
	): Promise<string> {
		if ((await runtime.stat(worktree.repository)) !== "directory") {
			throw new ReopenRefused(
				`its worktree was deleted when it closed, and the repository it was made from (${worktree.repository}) is no longer there to make it again.`,
			);
		}
		try {
			return await resumeFolder(
				await this.gitCommand(runtime),
				worktree.repository,
				{ root: requested.path, branch: worktree.branch },
			);
		} catch (error: unknown) {
			if (
				error instanceof NamedFailure &&
				error.wire.code === "workspace_unavailable"
			) {
				throw new ReopenRefused(
					`its worktree was deleted when it closed, and could not be made again on ${worktree.branch}: ${failureText(error)}`,
				);
			}
			throw error;
		}
	}

	/**
	 * A Workspace: focused if it is open already — its Agents then put back
	 * on the stack, to be brought back one press at a time — and otherwise
	 * opened again with every Agent that can be resumed.
	 */
	private async reopenWorkspace(
		entry: Extract<ClosedEntryRecord, { kind: "workspace" }>,
		progress: { opened: boolean },
	): Promise<string[]> {
		const open = this.openWorkspaceAt(entry.place);
		if (open !== undefined) {
			progress.opened = true;
			await this.dispatchAwaiting({
				type: "select_context",
				context: { kind: "workspace", workspaceId: open.id },
				presentation: "full",
			});
			let stack = this.state.recently_closed;
			for (const agent of agentEntriesOf(entry).reverse()) {
				stack = rememberClosed(stack, agent);
			}
			this.setRecentlyClosed(stack);
			return [];
		}
		const { workspaceId, notes } = await this.openClosedPlace(
			entry.place,
			progress,
			entry.worktree,
		);
		let first: AgentId | undefined;
		for (const agent of entry.agents) {
			try {
				const created = await this.resumeClosedAgent(
					workspaceId,
					entry.place,
					agent,
				);
				first ??= created;
			} catch (error: unknown) {
				notes.push(
					error instanceof ReopenRefused
						? error.message
						: `“${agent.display_name}” could not be started again: ${failureText(error)}`,
				);
			}
		}
		if (first !== undefined) {
			await this.dispatchAwaiting({
				type: "select_context",
				context: { kind: "agent", agentId: first },
				presentation: "full",
			});
		}
		return notes;
	}

	/** An Agent: in its Workspace, opened again first if it was closed too. */
	private async reopenAgent(
		entry: Extract<ClosedEntryRecord, { kind: "agent" }>,
		progress: { opened: boolean },
	): Promise<string[]> {
		// Asked before anything is opened: an Agent that cannot come back
		// does not reopen its folder on the way to saying so.
		const resumable = resumableSession(entry.agent);
		if (resumable.kind === "none") throw new ReopenRefused(resumable.why);
		const open = this.openWorkspaceAt(entry.place);
		const { workspaceId, notes } =
			open === undefined
				? await this.openClosedPlace(entry.place, progress)
				: { workspaceId: open.id, notes: [] };
		progress.opened = true;
		await this.resumeClosedAgent(workspaceId, entry.place, entry.agent);
		return notes;
	}

	/**
	 * Start a closed Agent again in `workspaceId`, resuming its session, with
	 * the name a person gave it. Refused — never started afresh — when it has
	 * no session, its profile is gone, or Claude no longer keeps the session.
	 */
	private async resumeClosedAgent(
		workspaceId: WorkspaceId,
		place: ClosedPlaceRecord,
		agent: ClosedAgentRecord,
	): Promise<AgentId> {
		const resumable = resumableSession(agent);
		if (resumable.kind === "none") throw new ReopenRefused(resumable.why);
		if (
			!this.config.agentProfiles.some(
				(profile) => profile.id === agent.profile_id,
			)
		) {
			throw new ReopenRefused(
				`“${agent.display_name}” was started from the profile “${agent.profile_id}”, which is no longer in DevHub's settings.`,
			);
		}
		const requested: WorkspacePlaceWire =
			place.kind === "local"
				? { kind: "local", path: place.path }
				: { kind: "ssh", host: place.host, path: place.path };
		if (agent.profile_kind === "claude") {
			const { runtime, profile } = await this.sessionsProfile(
				requested,
				agent.profile_id,
			);
			const workspace = this.coordinator.model.workspace(workspaceId);
			if (
				workspace !== undefined &&
				!(await claudeSessionPresent(
					runtime,
					profile,
					workspace.root,
					resumable.session,
				))
			) {
				throw new ReopenRefused(
					`Claude no longer keeps the session “${agent.display_name}” was in (${resumable.session}) for ${placeLabel(requested)}.`,
				);
			}
		}
		const before = this.modelAgentIds();
		await this.dispatchAwaiting({
			type: "create_agent",
			workspaceId,
			profileId: agentProfileId(agent.profile_id),
			presentation: "full",
			agentPresentation: agent.presentation,
			resume: resumable.session,
		});
		const created = this.coordinator.model.workspaces
			.flatMap((workspace) => workspace.agents)
			.find((each) => !before.has(each.id));
		if (created === undefined) {
			throw new Error("DevHub did not start the Agent.");
		}
		if (agent.named === true) {
			await this.dispatchAwaiting({
				type: "rename_agent",
				agentId: created.id,
				displayName: agent.display_name,
			});
		}
		return created.id;
	}

	//#endregion

	/**
	 * Tell the Neovims over terminal panes which terminals there are — every
	 * Agent's, and every Workspace's whose terminal has a page — and which
	 * are on screen.
	 */
	private syncTerminalNeovims(
		shell: ReturnType<typeof shellWindow>,
		workspaceTerminals: readonly string[],
		onScreen: readonly string[],
	): void {
		const overlays = this.terminalNeovims;
		if (overlays === undefined) return;
		shell.setTerminalNeovimHooks(overlays);
		overlays.setEnabled(true);
		const workspaces = workspaceTerminals.flatMap((workspaceId) => {
			try {
				const target = this.neovimTarget(workspaceId);
				return [
					{
						terminalId: workspaceTerminalPageId(workspaceId),
						machine: target.machine,
						workspace: target,
					},
				];
			} catch {
				return [];
			}
		});
		overlays.setTerminals(
			[
				...overlayTerminals(this.coordinator.model.agentTerminals(), (one) =>
					this.machineOfAgent(one.agentId),
				),
				...workspaces,
			],
			new Set(onScreen),
		);
	}

	/** The machine one Agent runs on: its Workspace's. */
	private machineOfAgent(
		agentId: ReturnType<typeof parseAgentId>,
	): RuntimeId | undefined {
		const workspace = this.coordinator.model.workspaceForAgent(agentId);
		return workspace ? runtimeIdFor(workspace.location) : undefined;
	}

	/** The machine a Workspace's folder — and therefore its Agents — is on. */
	private machineOf(workspaceId: WorkspaceId): RuntimeId | undefined {
		const workspace = this.coordinator.model.workspace(workspaceId);
		return workspace ? runtimeIdFor(workspace.location) : undefined;
	}

	/**
	 * Every machine a Workspace is open on, this one always among them.
	 *
	 * This one always, because the tmux anchor is on it and because DevHub
	 * itself runs there: a sweep or a socket migration that skipped it would leave the
	 * app's own sessions behind.
	 */
	private workspaceMachines(): readonly RuntimeId[] {
		const machines = new Set<RuntimeId>(["local"]);
		for (const workspace of this.coordinator.model.workspaces) {
			machines.add(runtimeIdFor(workspace.location));
		}
		return [...machines];
	}

	/**
	 * The machines with at least one Agent on them right now.
	 *
	 * One loop each, at each machine's own cadence, each round about that
	 * machine's Agents only — which is what `reconcile_agents` carrying a
	 * machine buys. A host across an ocean does not slow this Mac's Agents
	 * down, and neither of the two loops can report the other's Agents as
	 * ended, because neither is ever shown the other's session list.
	 */
	private agentHosts(): readonly ReconcileHost[] {
		const hosts = new Map<RuntimeId, ReconcileHost>();
		for (const workspace of this.coordinator.model.workspaces) {
			if (workspace.agents.length === 0) continue;
			const runtime = runtimeFor(workspace.location);
			hosts.set(runtime.id, runtime);
		}
		return [...hosts.values()];
	}

	/**
	 * Every machine with a Workspace on it — the machines whose terminals the
	 * Sidebar reports on — each at no more than one round a second.
	 */
	private terminalHosts(): readonly ReconcileHost[] {
		const hosts = new Map<RuntimeId, ReconcileHost>();
		for (const workspace of this.coordinator.model.workspaces) {
			const runtime = runtimeFor(workspace.location);
			if (!hosts.has(runtime.id)) {
				hosts.set(runtime.id, terminalActivityHost(runtime));
			}
		}
		for (const id of this.paneTrackers.keys()) {
			if (!hosts.has(id)) this.paneTrackers.delete(id);
		}
		return [...hosts.values()];
	}

	/**
	 * One round of the terminal-activity loop, about one machine: one
	 * `list-panes -a`, made into a reading for every Workspace on it.
	 *
	 * A machine that cannot be asked is skipped — the rows keep what they last
	 * showed — and said once per reason in the log, not raised as a notice:
	 * see `terminalActivityLoop.ts`.
	 */
	private async observeTerminalsOn(machine: RuntimeId): Promise<void> {
		const wiring = this.terminalsWiring;
		if (wiring === undefined) return;
		let runtime: Awaited<ReturnType<typeof wiring.runtimes.for>>;
		let reading: Awaited<ReturnType<typeof runtime.terminalPanes>>;
		// When the reading began: a pane terminal the model learned of after
		// this cannot have been seen by it (`AppModel.observePaneTerminals`).
		const since = Date.now();
		try {
			runtime = await wiring.runtimes.for(runtimeById(machine));
			if (!runtime.adapterAvailable) return;
			reading = await runtime.terminalPanes();
		} catch (error) {
			if (this.terminalActivityFailures.failed(machine, failureText(error))) {
				console.error(
					`[devhub] terminal activity on ${machine}: ${failureText(error)}`,
				);
			}
			return;
		}
		this.terminalActivityFailures.succeeded(machine);
		noteMainActivity(`terminal activity round on ${machine}`);
		let tracker = this.paneTrackers.get(machine);
		if (tracker === undefined) {
			tracker = new PaneActivityTracker();
			this.paneTrackers.set(machine, tracker);
		}
		const verdicts = tracker.observe(
			reading.panes,
			Date.now(),
			this.config.general.terminal_idle_seconds,
			runtime.configuredShell,
		);
		// Read the model after the round, as the Agent round does: a Workspace
		// that closed while tmux was being asked is not one to report on.
		const workspaces = this.coordinator.model.workspaces
			.filter((workspace) => this.machineOf(workspace.id) === machine)
			.map((workspace) => workspace.id);
		this.coordinator.dispatchUser({
			intentId: parseIntentId(randomUUID()),
			operationId: this.freshOperationId(),
			intent: {
				type: "terminal_activity_observed",
				workspaces: terminalObservations(verdicts, workspaces),
			},
		});
		// The same reading says which Agent terminals still have a session: a
		// shell that exited took its session with it, and its pane goes.
		const model = this.coordinator.model;
		const here = new Set<string>(workspaces);
		if (
			model
				.agentTerminals()
				.some((terminal) =>
					here.has(model.workspaceForAgent(terminal.agentId)?.id ?? ""),
				)
		) {
			this.coordinator.dispatchUser({
				intentId: parseIntentId(randomUUID()),
				operationId: this.freshOperationId(),
				intent: {
					type: "pane_terminals_observed",
					workspaces,
					alive: reading.terminals.map((terminal) => terminal.terminalId),
					since,
				},
			});
		}
		this.drain();
		// And which ones nothing owns any more: an Agent that was stopped or
		// ended takes its terminal with it. Only on a Workspace still open here
		// (a closed one's go with its close), and never one being opened.
		const owned = new Set(
			model.agentTerminals().map((terminal) => terminal.terminalId),
		);
		for (const stray of reading.terminals) {
			if (
				owned.has(stray.terminalId) ||
				this.launchingTerminals.has(stray.terminalId) ||
				!here.has(stray.workspaceId)
			) {
				continue;
			}
			const workspace = model.workspace(parseWorkspaceId(stray.workspaceId));
			if (!workspace) continue;
			await wiring.service.surfaces
				.closePaneTerminal({
					machine,
					terminalId: stray.terminalId,
					workspaceId: workspace.id,
					root: workspace.root,
				})
				.catch((error: unknown) => {
					console.error(
						`[devhub] closing the terminal of a gone Agent on ${machine}: ${failureText(error)}`,
					);
				});
		}
	}

	markReady(): void {
		this.coordinator.markReady();
		this.coordinator.setEditorHostState({ kind: "ready" });
		this.publishSnapshot();
	}

	/**
	 * Record a clean shutdown, so the next launch knows this one ended well.
	 *
	 * Terminals are deliberately *not* closed: a DevHub terminal is a tmux
	 * session that outlives the app, and quitting detaches the clients rather
	 * than killing the work. Agents get a bounded chance to shut down.
	 */
	async shutdown(): Promise<void> {
		// From here a terminal ending is DevHub going, not a person's exit.
		this.stopWatchingConfig?.();
		this.stopHearingReconnections?.();
		// The flag is written first, and on purpose: it records that the person
		// asked to quit, which is true whether or not the teardown below manages
		// to finish. Writing it afterwards would report a crash every time a
		// runtime was slow to let go.
		markCleanShutdown(this.state);
		await this.saveState();
		this.agentReconcilers.stop();
		this.terminalActivity.stop();
		this.stopWatchingWake?.();
		this.scratch.stop();
		this.repositoryStatus.stop();
		this.githubItems.stop();
		this.usageReaders?.stop();
		// Quitting detaches clients and leaves every session — an Agent's as
		// much as a terminal's. That is the point of putting them on the same
		// runtime: coming back finds the same work still running.
		this.terminalsWiring?.service.dispose();
		this.ptyHost?.dispose();
		// The managed Neovims too: they run on in tmux, and the next DevHub
		// adopts them by their sockets. Their UIs' connections go first.
		this.neovimEditors?.dispose();
		this.terminalNeovims?.dispose();
		this.neovimHost?.dispose();
		this.managedNeovims?.dispose();
		// The conversations stop being followed; their hosts run on in tmux,
		// and the next DevHub replays them from their journals.
		this.conversationEngine?.dispose();
	}

	//#endregion

	//#region the Task Manager

	/**
	 * One Task Manager reading (`taskManagerReading.ts`): the model's
	 * Workspaces and Agents in the Sidebar's order, each workbench's phase and
	 * renderer, DevHub's own pages, and this Mac's tmux.
	 */
	taskManagerSnapshot(): Promise<TaskSnapshotWire> {
		const shell = shellWindow();
		const { orchestrator, scratch, rows } = sidebarWorkspaces(this.snapshot());
		return takeTaskReading({
			workspaces: () =>
				[
					...(orchestrator === undefined ? [] : [orchestrator]),
					scratch,
					...rows,
				].map((workspace) => {
					return {
						id: workspace.id,
						label: workspace.label,
						detail: workspace.displayRoot,
						agents: workspace.agents.map((agent) => ({
							id: agent.id,
							label: agent.displayName,
							detail: `${agent.profileKind} · ${agent.presentation === "gui" ? "GUI" : "terminal"}`,
							...(agent.terminal === undefined
								? {}
								: {
										terminalSession: agentTerminalSessionName(
											agent.terminal.id,
										),
									}),
						})),
					};
				}),
			pages: () => [
				...this.chromePages().map((page) => ({
					pid: page.contents.getOSProcessId(),
					name: PAGE_NAMES[page.name] ?? page.name,
				})),
				...shell.paneTerminalContents().map((contents) => ({
					pid: contents.getOSProcessId(),
					name: "Agent terminal page",
				})),
				...[
					{ contents: settingsWindowContents(), name: "Settings" },
					{ contents: taskManagerWindowContents(), name: "Task Manager" },
				].flatMap(({ contents, name }) =>
					contents ? [{ pid: contents.getOSProcessId(), name }] : [],
				),
			],
			tmux: async () => {
				const wiring = this.terminalsWiring;
				if (!wiring) return { serverPid: undefined, panes: [], clients: [] };
				return (await wiring.local()).processPanes();
			},
		});
	}

	/** The Task Manager's Stop: the Agent's own stop, with its question. */
	stopAgentFromTaskManager(agentId: string): void {
		this.bringToFront();
		this.requestCloseAgent(agentId);
	}

	/** The Task Manager's Reveal: select it, and bring the window forward. */
	revealFromTaskManager(target: TaskRevealWire): void {
		this.arrive(
			intentFromWire({
				type: "select_context",
				context:
					target.kind === "agent"
						? { kind: "agent", agentId: target.agentId }
						: { kind: "workspace", workspaceId: target.workspaceId },
			}),
		);
		this.bringToFront();
	}

	//#endregion

	//#region projections

	snapshot(): AppSnapshotWire {
		return snapshotWire(
			this.coordinator.snapshot(),
			this.coordinator.readiness,
			this.repositoryOf,
			this.homeOf,
		);
	}

	/**
	 * Which repository each workspace is a checkout of, for the projection.
	 *
	 * The last poll's answer, which is the same one the sidebar's button and
	 * `closeWorkspaceOrWorktree` read — the order on screen and the order the
	 * chords step through are then the same list, because they *are* the same
	 * list. See `model/workspaceOrder.ts`.
	 */
	private orderedWorkspaceIds(): readonly string[] {
		return this.snapshot().workspaces.map((workspace) => workspace.id);
	}

	private readonly repositoryOf = (workspaceId: string): string | undefined =>
		this.lastRepositoryStatus.workspaces.find(
			(entry) => entry.workspaceId === workspaceId,
		)?.mainWorktree;

	/**
	 * Each machine's home directory, as that machine has answered it.
	 *
	 * The projection needs it to write a row's path the way a person writes it
	 * (`WorkspaceWire.displayRoot`), and only main can ask: a home is a fact
	 * about a machine, and a Workspace on a NAS is under *its* `$HOME`, which
	 * this Mac's has no prefix in common with.
	 *
	 * It is a cache and not a lookup because `Runtime.home()` is a round trip on
	 * a host and the projection is synchronous and runs on every change. This
	 * machine is in it from the start — `homedir()` costs nothing and is never
	 * wrong — and a host is filled in the first time a row on it is projected,
	 * with a republish when the answer lands. Until then the row shows its true
	 * path, which is never a lie, only longer.
	 */
	private readonly homes = new Map<RuntimeId, string>([["local", homedir()]]);

	/** Hosts already being asked, so one slow answer is not asked for twice. */
	private readonly homesAsked = new Set<RuntimeId>();

	private readonly homeOf = (
		location: WorkspaceLocation,
	): string | undefined => {
		const machine = runtimeIdFor(location);
		const known = this.homes.get(machine);
		if (known !== undefined) return known;
		this.learnHome(machine, location);
		return undefined;
	};

	/**
	 * Ask a machine where its home is, once, and republish when it says.
	 *
	 * A failure is not raised. Nothing is broken if this never answers — the row
	 * shows the path it already had — and a host that is unreachable is being
	 * reported by everything that actually needs it: the Agents on it, the git
	 * poll, the terminal. A second toast about the shape of a path would be
	 * noise about the one thing here that does not matter.
	 */
	private learnHome(machine: RuntimeId, location: WorkspaceLocation): void {
		if (this.homesAsked.has(machine)) return;
		this.homesAsked.add(machine);
		void runtimeFor(location)
			.home()
			.then((home) => {
				this.homes.set(machine, home);
				this.publishSnapshot();
			})
			.catch(() => {
				// Ask again next time this machine is reachable.
				this.homesAsked.delete(machine);
			});
	}

	/**
	 * What the window looks like — with the Agent panes' zoom already in it.
	 *
	 * The zoom is an offset from the size `settings.toml` names and the pages
	 * are told the sum, not the two halves. That is the whole of why no page
	 * changed for this: a pane already draws `terminalFontSize` and already
	 * re-fits and re-sizes its tmux pane when it moves, so zooming is the same
	 * event as editing the setting. A page given both numbers would be a second
	 * place the sum is worked out, and the first one to disagree would be
	 * whichever page forgot to add them.
	 */
	appearance(): AppAppearance {
		const config = this.config;
		this.appearanceSequence += 1;
		return appearanceWire(
			{
				...config.appearance,
				terminalFontSize: zoomedTerminalFontSize(
					config.appearance.terminalFontSize,
					this.coordinator.model.terminalZoomOffset,
				),
			},
			this.appearanceSequence,
			// The colour theme's terminal colours. A controller built
			// without a theme (in a test) has DevHub's own.
			shellThemeIfInstalled()?.terminalPalette(),
			config.terminal.macOptionIsMeta,
			config.terminal.tmuxControlMode,
		);
	}

	agentProfiles(): AgentProfiles {
		this.profileSequence += 1;
		const config = this.config;
		return agentProfilesWire(
			config.agentProfiles.map((profile) =>
				toDomainProfile(profile, config.agents),
			),
			this.profileSequence,
		);
	}

	/** Push one projection to every page that draws from the model. */
	private send(channel: string, payload: unknown): void {
		for (const contents of projectionAudience(shellWindow())) {
			contents.send(channel, payload);
		}
	}

	/**
	 * Push to the one page that draws this, and to no other. See
	 * `publishAudience.ts` for why a failure has a smaller audience than a
	 * projection does.
	 */
	private sendToDisplay(
		channel: string,
		payload: unknown,
		origin?: Electron.WebContents,
	): void {
		for (const contents of displayAudience(shellWindow(), origin)) {
			contents.send(channel, payload);
		}
	}

	/**
	 * A standing condition going up, or its own source taking it down.
	 *
	 * To the page that draws notices and to no other — the same audience a
	 * failure has, for the same reason. A condition used to go out on the
	 * projection audience, which was every page that draws from the model; a
	 * condition is not the model, and the page that draws it is the one page
	 * that has no model at all.
	 */
	private publishCondition(source: string, summary: string | undefined): void {
		this.conditions.observe(source, summary);
	}

	/**
	 * What holds right now, one entry per source — so a source clearing its
	 * own condition leaves every other source's standing. See
	 * `appConditions.ts`.
	 */
	private readonly conditions = new AppConditions((condition) => {
		this.sendToDisplay(CHANNELS.appCondition, condition);
	});

	/** `general.notice_seconds`, to the page that draws the notices. */
	private publishNoticeSettings(): void {
		this.sendToDisplay(CHANNELS.noticeSettings, {
			hideAfterSeconds: this.config.general.notice_seconds,
		} satisfies NoticeSettingsWire);
	}

	/**
	 * The projection, to every page that draws from it — unless it says what
	 * the last one said, its revision aside. A revision moves with changes
	 * the projection does not show, and six pages each decoding and drawing
	 * the same picture again is the whole of what sending it would do. A
	 * page that missed it asks (`getSnapshot`), as every page does when it
	 * starts.
	 */
	private sendSnapshot(snapshot: AppSnapshotWire): void {
		const content = JSON.stringify({ ...snapshot, revision: 0 });
		if (content === this.snapshotSent) return;
		this.snapshotSent = content;
		this.send(CHANNELS.snapshotChanged, snapshot);
	}

	/** What the last snapshot sent said, as JSON with its revision cleared. */
	private snapshotSent: string | undefined;

	private publishSnapshot(): void {
		this.sendSnapshot(this.snapshot());
		this.projectionChanged();
	}

	/**
	 * What has to be true again whenever the projection changes.
	 *
	 * The menu describes the model, so it is rebuilt; and a workspace that has
	 * just appeared is a workbench that should already be starting, for the
	 * same reason the restored ones are — nobody should wait for one at the
	 * moment they ask to see it. Both are idempotent, and both are here rather
	 * than at each place a snapshot is sent, so neither can be forgotten at one
	 * of them.
	 */
	private projectionChanged(): void {
		refreshMenu();
		this.syncOrchestrator();
		// An Agent nobody has read yet is the window asking to be looked at,
		// and it is a fact about the projection like the menu and the title —
		// so it is answered here, where everything that follows the projection
		// is answered, rather than by a page that can only be seen when there
		// is no workbench over it. See `windowAttention.ts`.
		this.attention.observe(this.snapshot());
		this.agentNotifier.observe(this.snapshot());
		// The arrangement is a function of the projection like everything else
		// here, so it is said here rather than at each place a selection moves.
		this.publishLayoutState();
		// The window's name says which Workspace, and what in it, so it moves
		// whenever the projection does — here rather than at each place that
		// changes a selection, for the same reason the menu is rebuilt here.
		this.refreshWindowTitle();
		// A workspace that has just appeared, closed, or been given an Issue is
		// the only thing here the watcher cares about; it compares before it
		// looks, so this is a nudge and not a poll.
		this.repositoryStatus.observe();
		// A machine that has just gained its first Agent needs a loop, and one
		// that has lost its last needs its loop stopped. `follow` is idempotent
		// and compares before it acts, so this is a nudge like the line above it.
		this.agentReconcilers.follow(this.agentHosts());
		this.terminalActivity.follow(this.terminalHosts());
		this.releaseIdleMachines();
		// A draft lives as long as its Agent: one that has just gone takes its
		// draft with it. `prune` compares before it writes.
		this.drafts.prune();
		this.limitResumes.prune();
		// An Agent gone idle, or a box ticked, is when an automatic action may
		// be due.
		this.runAutomaticActions();
		// Which workbenches exist follows the projection and the selection —
		// a Workspace added or gone, one shown that is asleep, the cap — so
		// every change is a plan. See `workbenchLifecycle.ts`.
		// What is on screen follows the selection, wherever the selection
		// changed — a menu command, a restored session, or the page.
	}

	/**
	 * Say what this window is, now.
	 *
	 * Every part of the answer is read at the moment it is asked for: the model
	 * for the Workspace and the Agent's word, the window for what the workbench
	 * on screen calls itself. Nothing is cached, so there is no second copy to
	 * go stale, and calling this more often than necessary costs a string.
	 */
	/**
	 * What the Orchestrator screen says it shows (`reportOrchestratorView`),
	 * with the escalation read off the store: its subject and what it is
	 * about, never its thread.
	 */
	private orchestratorTitleView(): OrchestratorTitleView {
		const view = this.orchestratorView;
		if (view.kind !== "escalation") return view;
		const escalation = this.orchestrator?.escalation(view.id);
		if (escalation === undefined) return { kind: "board" };
		return {
			kind: "escalation",
			subject: escalation.title,
			workspaceId: escalation.workspaceId,
			agentIds: escalation.agents,
		};
	}

	/** What the Orchestrator screen's left pane last said it shows. */
	private orchestratorView: OrchestratorViewWire = { kind: "board" };

	private refreshWindowTitle(): void {
		const shell = shellWindow();
		if (shell.window.isDestroyed()) return;
		const snapshot = this.coordinator.snapshot();
		const title = shellTitleFor({
			selection: snapshot.selection,
			workspaces: snapshot.workspaces,
			editorElement: this.neovimTitleElement(snapshot.selection),
			orchestratorWorkspaceId: snapshot.orchestratorWorkspaceId,
			orchestratorView: this.orchestratorTitleView(),
			repositories: this.lastRepositoryStatus.workspaces,
		});
		// Asked for on every projection; said only when it moved.
		if (shell.window.getTitle() === title) return;
		shell.window.setTitle(title);
		// The same string, once, to both places that show it. DevHub's own
		// title bar is drawn by the page, and a page that composed the name a
		// second time would be a window whose bar and whose Mission Control
		// entry could disagree — about the very thing a title is for. The
		// window's own page is the one that letters it; one that has just
		// started reads it (`getWindowTitle`).
		shell.window.webContents.send(CHANNELS.windowTitleChanged, title);
	}

	/**
	 * Tell the window what the arrangement is.
	 *
	 * Everything the layout is a function of that is not the window's own size,
	 * read off the model in one breath so no half of it can be newer than the
	 * other. It replaces two channels that carried the same facts *up* from the
	 * page — a measured rectangle, and one word for what was in the content
	 * area — and it is better than both for the same reason: the page was
	 * reporting what it had drawn from the projection, and the projection is
	 * right here.
	 *
	 * A drag preview is the one number the page does own while it lasts: the
	 * pointer is in the page, and the model learns where the person stopped
	 * rather than where they are. See `CHANNELS.previewLayout`.
	 */
	publishLayoutState(): void {
		const shell = shellWindowIfCreated();
		if (!shell || shell.window.isDestroyed()) return;
		const snapshot = this.snapshot();
		const appearance = this.config.appearance;
		const layout = snapshot.layout;
		// The projection names a workbench by its *surface key*, which is the
		// model's name for it; the window's children are folders, which is the
		// window's. This is where the two are joined, and joining them anywhere
		// else is how "the editor is on screen" and "no editor is on screen"
		// came to be two true answers to one question.
		const editorKey =
			layout.kind === "workbench" || layout.kind === "split"
				? this.editorKeyForSurfaceKey(layout.editorKey)
				: undefined;
		// The Workspace's terminal is its editor area, its page made the first
		// time it is shown and kept, with every Neovim in it drawn over its
		// pane.
		if (editorKey !== undefined) this.neovimShown.add(editorKey);
		const neovimPages = this.coordinator.model.workspaces.flatMap(
			(workspace) =>
				this.neovimShown.has(workspace.key)
					? [{ editorKey: workspace.key, workspaceId: workspace.id }]
					: [],
		);
		shell.syncEditorTerminals(neovimPages);
		const surface: SurfaceArrangement =
			snapshot.readiness !== "ready"
				? { kind: "none" }
				: layout.kind === "agent" || layout.kind === "orchestrator"
					? { kind: "agent" }
					: editorKey === undefined
						? { kind: "none" }
						: layout.kind === "split"
							? {
									kind: "split",
									editorKey,
									ratio: snapshot.splitRatio,
								}
							: { kind: "editor", editorKey };
		// Both panes of a split are drawn; which of them holds the keyboard is
		// which half is selected. An Agent selected `beside` is the Agent half
		// in front, and the workspace selected `beside` is the editor half.
		// The view's Agent's terminal, when it is open, with the divider being
		// dragged where the pointer is: it is laid out with its Agent — right
		// of a full one, under a split's — and never with the workbench alone,
		// which shows no Agent (`model/agentTerminal.ts`). Each way keeps its
		// own share.
		const model = this.coordinator.model;
		const visible = model.visibleTerminal();
		const terminal =
			visible === undefined ||
			(surface.kind !== "agent" && surface.kind !== "split")
				? undefined
				: {
						terminalId: visible.terminalId,
						share:
							this.terminalSharePreview ??
							(surface.kind === "split"
								? model.terminalStackedShare(visible.agentId)
								: model.terminalShare(visible.agentId)),
					};
		// Every Agent terminal there is has a view, shown or hidden, so coming
		// back to its Agent finds its scrollback where it was.
		shell.syncTerminalViews(
			model.agentTerminals().map((one) => one.terminalId),
		);
		const editorWorkspace =
			editorKey !== undefined && surface.kind !== "none"
				? neovimPages.find((page) => page.editorKey === editorKey)?.workspaceId
				: undefined;
		this.syncTerminalNeovims(
			shell,
			neovimPages.map((page) => page.workspaceId),
			[
				...(terminal === undefined ? [] : [terminal.terminalId]),
				...(editorWorkspace === undefined
					? []
					: [workspaceTerminalPageId(editorWorkspace)]),
			],
		);
		// A GUI Agent on screen is drawn by the Conversations view, the rest
		// by the Agents view (`LayoutState.conversation`); the Orchestrator's
		// board stays the Agents view's, left of its GUI Agent's conversation.
		const shownKey =
			layout.kind === "agent" ||
			layout.kind === "split" ||
			layout.kind === "orchestrator"
				? layout.agentKey
				: undefined;
		const shownGui =
			shownKey !== undefined &&
			snapshot.workspaces.some((workspace) =>
				workspace.agents.some(
					(agent) =>
						`agent:${agent.id}` === shownKey && agent.presentation === "gui",
				),
			);
		const conversation = !shownGui
			? undefined
			: layout.kind === "orchestrator"
				? ("beside-board" as const)
				: ("whole" as const);
		const paneFocus = model.paneFocus;
		const keyboard: KeyboardHalf = this.keyboardInSidebar
			? "sidebar"
			: paneFocus !== undefined
				? { terminal: paneFocus }
				: surface.kind === "editor" ||
					  (surface.kind === "split" &&
							snapshot.selection.context.kind !== "agent")
					? "editor"
					: "agents";
		shell.setLayoutState({
			// The window was built with one of the two chromes and the setting
			// can have moved since; the setting wins, because it is what the
			// page is drawing. Anything the config does not recognise is the
			// chrome the window has, which is the one on screen.
			titleBar: appearance.titleBar === "hidden" ? "hidden" : "shown",
			density:
				appearance.sidebarDensity === "comfortable" ? "comfortable" : "compact",
			sidebar: {
				width: this.sidebarWidthPreview ?? snapshot.sidebar.width,
				collapsed: snapshot.sidebar.collapsed,
				...(this.sidebarOverlay ? { overlay: true } : {}),
			},
			surface:
				surface.kind === "split" && this.splitRatioPreview !== undefined
					? { ...surface, ratio: this.splitRatioPreview }
					: surface,
			keyboard,
			...(terminal === undefined ? {} : { terminal }),
			...(conversation === undefined ? {} : { conversation }),
		});
		this.publishAreas(shell);
	}

	/**
	 * Where the workbench and the Sidebar are laid, to the pages that draw
	 * against them.
	 */
	private publishAreas(shell: ShellWindow): void {
		// The page draws its own states in the same rectangle the workbench is
		// laid into, and the split's seam is where that rectangle ends. It is
		// given the number rather than asked for it, so there is no
		// arrangement in which the two can disagree about where the seam is.
		//
		// To the window's own page and to no other, and only when it moved:
		// this runs on every projection, which is several times a second while
		// an Agent works, and the rectangle is the same nearly every time. A
		// page that has just started asks for it (`getWorkbenchArea`), so
		// nothing depends on it being said again.
		const workbench = shell.workbenchArea();
		const workbenchKey = JSON.stringify(workbench);
		if (workbenchKey !== this.workbenchAreaSent) {
			this.workbenchAreaSent = workbenchKey;
			shell.window.webContents.send(CHANNELS.workbenchAreaChanged, workbench);
		}
		// And the Sidebar is told its own, for one reason: a row has to be
		// able to say where it is *in the window*, so that its tooltip is
		// placed against the window rather than against the column it is in.
		// Nothing about the Sidebar's own drawing depends on this — the
		// column's width is the model's — which is why it is the rectangle and
		// not just the origin: a row scrolled half out of the column has half
		// an anchor, and a tooltip pointing at the invisible half points at
		// nothing. To the Sidebar alone, when it moved, as above.
		const sidebar = shell.sidebarArea();
		const sidebarKey = JSON.stringify(sidebar);
		if (sidebarKey !== this.sidebarAreaSent) {
			this.sidebarAreaSent = sidebarKey;
			shell.sidebar.contents()?.send(CHANNELS.sidebarAreaChanged, sidebar);
		}
	}

	/** The last workbench and Sidebar rectangles said, as JSON: see `publishAreas`. */
	private workbenchAreaSent: string | undefined;
	private sidebarAreaSent: string | undefined;

	/**
	 * A drag in progress, in the page's own hand.
	 *
	 * The sidebar's handle and the split's seam move under the pointer, and the
	 * model only learns where they stopped — sending an intent per pointer move
	 * would put a round trip in the middle of the one thing that has to feel
	 * direct. So the number the person is dragging to is told to main as it
	 * moves and forgotten when the model has it: what is being reported is a
	 * pointer, which the page owns, and not a rectangle, which it does not.
	 */
	private sidebarWidthPreview: number | undefined;
	/**
	 * Whether the Sidebar page is floating the expanded Sidebar over the
	 * content (compact mode under the pointer). The page's to say, like a drag
	 * preview, and for the same reason: see `LayoutPreviewWire.sidebarOverlay`.
	 */
	private sidebarOverlay = false;
	private splitRatioPreview: number | undefined;
	/** The divider between the Agent and its terminal, being dragged. */
	private terminalSharePreview: number | undefined;
	/**
	 * Terminals whose session is being made and that the model has not been
	 * told of yet — what the sweep must not reap in the meantime.
	 */
	private readonly launchingTerminals = new Set<string>();

	/**
	 * Every page learns the appearance again: a setting changed, or the
	 * colour theme's terminal colours did.
	 */
	publishAppearance(): void {
		this.publishTerminalTheme();
		this.send(CHANNELS.appearanceChanged, this.appearance());
		// The title bar and the sidebar's density are two of the numbers the
		// layout is made of: changing either moves every child in the window.
		this.publishLayoutState();
	}

	/**
	 * Theme: Preview…, from the palette or from Settings: the main window is
	 * brought forward, since that is what is being recoloured.
	 */
	openThemePreview(): void {
		shellWindow().raiseFromAppActivation();
		void this.themePreview.open().catch((error: unknown) => {
			this.noteFailure(
				new NamedFailure(
					withDetail(
						errorWireAt("color_theme_unavailable"),
						failureText(error),
					),
				),
			);
		});
	}

	/**
	 * Tell the programs in DevHub's terminals the theme (`themePublication.ts`):
	 * its name, and the palette DevHub's own terminals are given under it,
	 * for the appearance worn now. Published
	 * whenever the appearance is, which is every change of theme, of
	 * appearance and of settings; an unchanged value goes nowhere.
	 */
	publishTerminalTheme(): void {
		const publication = themePublicationIfInstalled();
		const theme = shellThemeIfInstalled();
		if (!publication || !theme) return;
		publication.publish(
			publishedThemeOf({
				theme: theme.wornTheme(),
				terminal: theme.terminalPalette(),
				temporary: theme.temporaryTheme() !== undefined,
			}),
		);
	}

	/**
	 * Tell every page DevHub draws chrome on what the Workbench now looks like.
	 *
	 * All seven of them, and that is the point: a modal must never be a
	 * different colour from the window it is standing on, and neither must a
	 * notice or a tooltip. This used to go out on the *projection* audience,
	 * which was every page that draws from the model — a set that happened to
	 * coincide until `toasts` arrived with `onTheme` on its bridge and no
	 * model behind it, and then silently did not.
	 */
	publishTheme(palette: ShellPalette): void {
		// Every page DevHub draws chrome on, which is not the same set as
		// every page that draws from the model — `toasts` and `tooltip` have
		// no model at all and are painted in the Workbench's colours like
		// everything else. See `chromeAudience` in `publishAudience.ts`.
		for (const contents of chromeAudience(shellWindow())) {
			contents.send(CHANNELS.themeChanged, palette);
		}
	}

	/** The Sidebar's usage-limits readout. See `usageLimits.ts`. */
	private readonly usageLimits = new UsageLimits();

	/** `usage.threshold`, read off the readout as it changes. */
	private readonly usageThresholds = new UsageThresholdWatch({
		thresholds: () => this.config.orchestrator.usage_thresholds,
		dispatch: (event) => {
			this.orchestrator?.events.dispatch(event);
		},
	});

	/** The readout moved: the Sidebar, and the orchestrator's thresholds. */
	private usageLimitsChanged(limits: UsageLimitsWire): void {
		this.send(CHANNELS.usageLimitsChanged, limits);
		this.usageThresholds.observe(limits);
	}

	/** The background readers of each CLI's plan limits, once started. */
	private usageReaders: { stop(): void } | undefined;

	/**
	 * Start reading each CLI's plan limits in the background, once the window
	 * is up: one process per CLI with a profile, the first profile of its kind
	 * (`usageReaders.ts`). A failure is said once on the root surface. A
	 * settings file that would not parse has no profiles, and is already said.
	 */
	startUsageReaders(): void {
		const config = this.config;
		this.usageReaders = startUsageReaders({
			profiles: config.agentProfiles,
			runtime: localRuntime(),
			searchPath: this.launchEnvironment["PATH"] ?? "",
			clientVersion: electron.app.getVersion(),
			spawn: spawnLineProcess,
			...usageReadingListener(this.usageLimits, (limits) =>
				this.usageLimitsChanged(limits),
			),
			report: (failure) => {
				this.publishError(errorWire(failure));
			},
		});
	}

	/**
	 * The branch and Issue projection, and the watcher that keeps it true.
	 *
	 * Held here because the last one sent is the answer a page gets when it
	 * asks — a window opened between two rounds must not have to wait a minute
	 * to draw a branch name.
	 */
	private lastRepositoryStatus: RepositoryStatusWire = {
		sequence: 0,
		workspaces: [],
	};

	private readonly repositoryStatus = new RepositoryStatusWatcher({
		gitCommand: (runtime) => this.gitCommand(runtime),
		environment: this.launchEnvironment,
		// Every open Workspace, wherever its folder is. git, the HEAD watcher
		// and the worktree probe all go through the Workspace's own runtime now,
		// so a checkout on another machine is read the same way as one here —
		// the same row, with the same branch, Issue and pull request on it.
		workspaces: () =>
			this.coordinator.model.workspaces.map((workspace) => ({
				id: workspace.id,
				root: workspace.root,
				runtime: runtimeFor(workspace.location),
			})),
		publish: (status) => {
			// The order the rows are in is git's answer to "which repository is
			// this a checkout of", so a round that changes that answer changes the
			// list — and the list is the projection's, not the sidebar's. Sending
			// the snapshot again is how the new order reaches everything that
			// reads it at once; sending it only when the order actually moved
			// keeps a poll that learned nothing from redrawing anything.
			const before = this.orderedWorkspaceIds();
			this.lastRepositoryStatus = status;
			this.send(CHANNELS.repositoryStatusChanged, status);
			// The title names the Workspace's Issue, which is this projection's:
			// a branch switched, and so an Issue changed, renames the window.
			if (shellWindowIfCreated() !== undefined) this.refreshWindowTitle();
			// Why what the rows say may be out of date, said where the
			// application says everything else it has to say. It is a
			// *condition*, not a failed action: nobody asked for the look that
			// did not finish, and the reason it did not — `gh` missing, a
			// network that dropped — is still true after the person's next
			// click. The watcher has always documented exactly this ("it is
			// gone when a later round succeeds, and by no other rule"), and a
			// condition is the shape that rule already has: a round that
			// succeeds publishes no diagnostic, and the source retracting it is
			// the only thing besides the person that takes it away.
			//
			// It used to be raised in the App Shell page, from the projection
			// it had just received. The page that draws notices has no
			// projection now — it does not need one — so the source says it
			// itself, which is where every other condition is already said.
			this.publishCondition(REPOSITORY_STATUS_CONDITION, status.diagnostic);
			// Review comments arriving and CI failing are news from here.
			this.runAutomaticActions();
			// A pull request moved: the invariant's facts may have.
			this.orchestrator?.observe();
			const after = this.orderedWorkspaceIds();
			if (before.join("\0") !== after.join("\0")) {
				this.sendSnapshot(this.snapshot());
			}
		},
	});

	private publishProfiles(): void {
		this.send(CHANNELS.agentProfilesChanged, this.agentProfiles());
	}

	/**
	 * The actions that exist, in the order they are arranged.
	 *
	 * The trigger travels with each one rather than being worked out from its
	 * id: a person may have three commit buttons and none of them is called
	 * `commit_changes`.
	 */
	private agentActionsWire(): readonly AgentActionWire[] {
		return this.config.agentActions
			.filter((action) => action.enabled)
			.map((action) => ({
				trigger: action.trigger,
				id: action.id,
				displayName: action.display_name,
				button: action.button,
			}));
	}

	private publishActions(): void {
		this.send(CHANNELS.agentActionsChanged, this.agentActionsWire());
	}

	/**
	 * Publish an app-scoped failure, and write down that it happened.
	 *
	 * Deliberately *not* throttled. The rule that stops a notice flapping is
	 * `model/noticeEpisodes.ts`, and it is applied at the one seam every
	 * app-scoped notice passes through — `shell/notices.ts`, in the page that
	 * draws them — because main is not the only publisher: the App Shell page
	 * raises its own failures without coming through here at all. Throttling
	 * here as well would be a second implementation of the rule, and the log
	 * would then record the rate main *allowed* rather than the rate something
	 * published at. The second number is the whole point of the journal.
	 */
	private publishError(
		error: AppErrorWire,
		/**
		 * The page a failure began on, when main knows it.
		 *
		 * Consulted for one thing only — a failure raised in the Settings
		 * window is drawn in the Settings window. See `publishAudience.ts`.
		 */
		origin?: Electron.WebContents,
	): void {
		// A failure published before there is a page — or into a window that has
		// gone — is in the log too. `module` is the source: it is already the
		// wire's own answer to "which part of DevHub said this", so no raising
		// site has to be told about the journal to appear in it.
		this.notices.raised({
			code: error.code,
			subject: "app",
			source: error.module,
			identity: appFailureIdentity(error.code),
			reason: error.detail ?? error.summary,
		});
		this.sendToDisplay(CHANNELS.nativeError, error, origin);
	}

	/**
	 * The main process's root boundary: a failure nothing caught.
	 *
	 * Published like any other app-scoped failure, because to the person there
	 * is no difference — something DevHub was doing did not happen. What makes
	 * it worth a door of its own is that until there was one, main's unhandled
	 * rejections went to a stderr warning and nowhere else. See
	 * `mainFailureRoot.ts`.
	 */
	raiseUnhandled(reason: unknown): void {
		this.publishError(errorWire(reason));
	}

	/**
	 * A failure from before there was a page, kept until there is one.
	 *
	 * Startup does things a person needs to be told about — reading the
	 * workbench's settings file is one — and it does them before the App Shell
	 * page exists. Published there and then, the message goes to a window with
	 * nothing loaded in it and is gone. So it waits, and the notices page
	 * saying it is listening delivers it: that is what "there is somebody to
	 * tell" means. It used to be any page's first request for the snapshot,
	 * which said nothing about the notices page once every page in the window
	 * started at the same moment. It is delivered once, because an alert that
	 * comes back every time the page reloads cannot be dismissed.
	 */
	noteStartupFailure(error: AppErrorWire): void {
		this.startupFailures.push(error);
	}

	/** Every one, in order: a second failure before the page must not hide the first. */
	private startupFailures: AppErrorWire[] = [];

	/**
	 * Refuse an operation, and say why *where its subject is*.
	 *
	 * `operation_failed` is the coordinator's whole vocabulary for "this did
	 * not happen": it consumes the token so nothing is left pending, and it
	 * carries no reason, because the reason is not the model's to know. Sent on
	 * its own it produces a row that quietly never appears — which is how
	 * "I picked Codex and nothing happened" became unanswerable.
	 *
	 * So the two go together, always, through this one call: the reason to a
	 * surface, the token back to the coordinator. A caller that accepts
	 * `operation_failed` directly is a caller that has decided the person does
	 * not need to know, and none of them has.
	 *
	 * **Which surface is the subject's, and the subject is known here.** A
	 * failure about one Agent — its session is gone, the runtime cannot be
	 * reached for it — belongs in that Agent's own pane, where the thing it is
	 * about is on screen; a failure about one workspace belongs in that
	 * workspace's surface. Only a failure with no subject to stand on — the
	 * tmux server unreachable for everything, the control socket, the settings
	 * file — is the application speaking, and only those are app-wide alerts.
	 *
	 * This used to publish `agent_runtime_unavailable` for every refusal there
	 * is, so a missing profile, a closed workspace and a tmux that would not
	 * answer all produced one banner across the whole window, all three
	 * blaming a runtime, none of them naming what they were about.
	 */
	private failOperation(
		token: OperationToken,
		failure: OperationRefusal,
	): void {
		this.reportFailure(failure);
		this.accept({
			type: "operation_failed",
			token,
			failure: refusalWire(failure),
		});
	}

	/**
	 * Deliver a failure to its subject's surface. The one router; exhaustive.
	 *
	 * The renderer decides nothing. A page that had to work out whether a
	 * failure was about an Agent would be a second copy of a rule main already
	 * knows the answer to, and the two would disagree the first time a new
	 * raising site forgot one of them.
	 */
	private reportFailure(failure: RefusedOperation): void {
		switch (failure.subject) {
			case "agent":
				// Into the Agent's own state, so the pane draws it and the row
				// notes it — and so the next reconcile that reads the Agent
				// retires it, with nothing to dismiss.
				this.coordinator.model.markAgentFailed(failure.id, {
					code: failure.code,
					...(failure.detail === undefined ? {} : { detail: failure.detail }),
				});
				this.publishSnapshot();
				return;
			case "workspace":
				this.coordinator.model.markWorkspaceUnavailable(
					failure.id,
					failure.code,
				);
				this.publishSnapshot();
				return;
			case "machine":
				// Not a toast per round. The condition goes up once for the
				// episode and comes down when the machine has been answering
				// again for long enough to believe — one place, one rule.
				this.machineConditions.failed(
					failure.id,
					// The machine is named, because that is the whole of what the
					// person can act on: "the agent runtime is unavailable" sent
					// them to look at a tmux, and the tmux was fine — the host was
					// not answering. The detail is DevHub's own words about its own
					// configuration and never the provider's (see `PortFailure`).
					failure.detail === undefined
						? `DevHub is not getting an answer from ${failure.id}.`
						: `DevHub is not getting an answer from ${failure.id}. ${failure.detail}`,
				);
				return;
			case "app":
				this.publishError(refusalWire(failure));
				return;
		}
	}

	//#endregion

	//#region the coordinator

	private freshOperationId(): ReturnType<typeof parseOperationId> {
		return parseOperationId(randomUUID());
	}

	/** Dispatch an intent DevHub itself raised, not one the page sent. */
	private dispatchOwn(intent: UserIntent): IntentOutcome | undefined {
		try {
			const outcome = this.coordinator.dispatchUser({
				intentId: parseIntentId(randomUUID()),
				operationId: this.freshOperationId(),
				intent,
			});
			this.drain();
			return outcome;
		} catch (error) {
			this.drain();
			this.publishError(errorWire(error));
			return undefined;
		}
	}

	private accept(event: ProviderEvent): void {
		const id = event.token.operationId;
		try {
			const outcome = this.coordinator.acceptProviderEvent({
				eventId: parseOperationId(randomUUID()) as never,
				event,
			});
			this.settle(id, outcome);
		} catch (error) {
			// Where the refusal is drawn, and what the request waiting on it is
			// refused with, is `completionRefusal`'s decision for every
			// completion alike.
			const refusal = completionRefusal(event, error);
			if (refusal.kind === "crash") {
				crash(error);
				this.reject(id, error);
			} else {
				if (refusal.publish) this.publishError(refusal.publish);
				this.reject(id, refusal.rejection);
			}
		}
		this.drain();
	}

	/**
	 * Wait for a deferred operation to reach an answer.
	 *
	 * A request from the page is one act — "close this workspace" — but the model
	 * answers it with a chain: inspect, then maybe a confirmation, then cleanup,
	 * then a save. Every link keeps the same operation identity, so the page's
	 * call resolves to whatever that identity finally produced. Without this the
	 * page would be told "deferred" and never hear the confirmation it has to
	 * show, which is exactly a failure that never reaches anyone.
	 */
	private awaitOutcome(outcome: IntentOutcome): Promise<IntentOutcome> {
		if (outcome.kind !== "deferred") {
			return Promise.resolve(outcome);
		}
		const existing = this.pendingRequests.get(outcome.operationId);
		if (existing) {
			return existing.promise;
		}
		let settle: (value: IntentOutcome) => void = () => undefined;
		let fail: (error: unknown) => void = () => undefined;
		const promise = new Promise<IntentOutcome>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		// An operation nothing ever completes would leave the page waiting on a
		// promise forever. A bounded wait turns that into a visible failure.
		const timer = setTimeout(() => {
			this.reject(
				outcome.operationId,
				new NamedFailure(errorWireAt("operation_timed_out")),
			);
		}, OPERATION_TIMEOUT_MS);
		// A pending page request must never be the reason the process stays alive.
		(timer as unknown as { unref?: () => void }).unref?.();
		this.pendingRequests.set(outcome.operationId, {
			promise,
			settle,
			fail,
			timer,
		});
		return promise;
	}

	private settle(id: OperationId, outcome: IntentOutcome): void {
		const pending = this.pendingRequests.get(id);
		if (!pending) return;
		if (outcome.kind === "deferred") {
			if (outcome.operationId === id) {
				// Still the same operation, one link further along.
				return;
			}
			this.pendingRequests.delete(id);
			this.pendingRequests.set(outcome.operationId, pending);
			return;
		}
		this.pendingRequests.delete(id);
		clearTimeout(pending.timer);
		pending.settle(outcome);
	}

	private reject(id: OperationId, error: unknown): void {
		const pending = this.pendingRequests.get(id);
		if (!pending) return;
		this.pendingRequests.delete(id);
		clearTimeout(pending.timer);
		pending.fail(error);
	}

	/**
	 * Move everything the coordinator has emitted since the last drain: push the
	 * newest snapshot, surface errors, and start the effects.
	 *
	 * Re-entrancy is the reason for the guard: performing an effect feeds a
	 * completion back in, which emits more events. The outer drain owns the
	 * cursor and the inner call just returns.
	 */
	private drain(): void {
		if (this.draining) return;
		this.draining = true;
		try {
			// One dispatch settles in a handful of rounds. A chain that does not
			// is a cycle, and a cycle here spins the main thread — the app stops
			// answering anything, including its own window. Failing loudly at a
			// bound turns that into a stack trace at the moment it starts.
			for (let round = 0; ; round += 1) {
				if (round > MAX_DRAIN_ROUNDS) {
					throw new Error(
						"the coordinator did not settle: an effect chain is cycling",
					);
				}
				const subscription = this.coordinator.subscribeFrom(this.cursor);
				if (subscription.events.length === 0) break;
				this.cursor = subscription.cursor;
				let latest: AppSnapshotWire | undefined;
				const effects: Effect[] = [];
				for (const { event } of subscription.events) {
					switch (event.kind) {
						case "snapshot":
							latest = snapshotWire(
								event.snapshot,
								this.coordinator.readiness,
								this.repositoryOf,
								this.homeOf,
							);
							break;
						case "error":
							this.publishError(event.error.wire);
							break;
						case "effect":
							effects.push(event.effect);
							break;
						case "operation_completed":
							// A chain that ends without a provider event of its own —
							// a reconcile superseded by a newer one — still ends. The
							// request that started it is answered here rather than left
							// to time out. A chain that carries on under the same
							// identity is not over, and is left alone.
							if (!this.coordinator.hasPending(event.token.operationId)) {
								this.settle(event.token.operationId, {
									kind: "noop",
									snapshot: this.coordinator.snapshot(),
								});
							}
							break;
						case "noop":
							break;
					}
				}
				if (latest) {
					noteMainActivity("snapshot publish");
					this.sendSnapshot(latest);
					this.projectionChanged();
					this.tellMemory.observe(
						latest.workspaces.flatMap((workspace) => workspace.agents),
						Date.now(),
					);
				}
				for (const effect of effects) {
					// Effects are performed with nobody waiting on them, so the
					// same rule applies: a failure goes to the error surface, never
					// to `unhandledRejection`.
					void this.perform(effect).catch((error: unknown) => {
						// An effect that failed because the world did is news, and goes
						// to the error surface. An effect that failed because DevHub's
						// own assumption broke is not, and no amount of drawing it
						// would help: effects run in loops, so it would be drawn at the
						// loop's cadence. See `invariant.ts`.
						if (isInvariantViolation(error)) {
							crash(error);
							return;
						}
						this.publishError(errorWire(error));
					});
				}
			}
		} finally {
			this.draining = false;
		}
	}

	//#endregion

	//#region effects

	private async perform(effect: Effect): Promise<void> {
		switch (effect.kind) {
			case "noop":
				return;
			case "detach":
				console.log(`[devhub] quit: detach (${effect.reason})`);
				electron.app.quit();
				return;
			case "persist_state":
				await this.persist(effect.token);
				return;
			case "resolve_workspace_path":
				await this.resolvePath(effect.token, effect.location);
				return;
			case "generate_workspace_id":
				this.accept({
					type: "workspace_id_generated",
					token: effect.token,
					workspaceId: parseWorkspaceId(randomUUID()),
				});
				return;
			case "generate_agent_id":
				this.accept({
					type: "agent_id_generated",
					token: effect.token,
					workspaceId: effect.workspaceId,
					agentId: parseAgentId(randomUUID()),
				});
				return;
			case "generate_confirmation_id":
				this.accept({
					type: "confirmation_id_generated",
					token: effect.token,
					confirmationId: parseConfirmationId(randomUUID()),
				});
				return;
			case "resolve_agent_profile":
				await this.resolveProfile(
					effect.token,
					effect.workspaceId,
					effect.profileId,
					effect.extraArgs,
					effect.resume,
				);
				return;
			case "inspect_workspace":
				await this.inspect(effect.token, effect.workspaceId);
				return;
			case "launch_agent":
				noteMainActivity("agent launch");
				await this.launchAgent(
					effect.token,
					effect.workspaceId,
					effect.agentId,
					effect.profile,
					effect.agentPresentation,
				);
				return;
			case "stop_agent":
			case "terminate_agent":
				await this.stopAgent(
					effect.token,
					effect.agentId,
					effect.kind,
					effect.kind === "stop_agent" && effect.moveTerminal === true,
					effect.kind === "stop_agent" && effect.replaced !== true,
				);
				return;
			case "restart_agent":
				await this.restartAgent(effect.token, effect.agentId);
				return;
			case "reconcile_agent":
			case "reconcile_agents":
				await this.reconcile(
					effect.token,
					effect.kind === "reconcile_agent" ? effect.agentId : undefined,
					effect.kind === "reconcile_agents" ? effect.machine : undefined,
				);
				return;
			case "close_workspace":
				await this.closeWorkspaceResources(
					effect.token,
					effect.workspaceId,
					effect.worktree,
				);
				return;
		}
	}

	/**
	 * What to tell the person about a save that did not happen.
	 *
	 * The store's own failures already name the file and the reason; anything
	 * else is a bug in the projection, and saying which file it was going to
	 * and what threw is still more than the reader had before.
	 */
	private persistenceReason(error: unknown): string {
		if (error instanceof StateError) {
			return error.describe(this.stateStore.path);
		}
		return `${this.stateStore.path}: ${failureText(error)}`;
	}

	/**
	 * The model's saves, one running and one waiting at most: a burst of
	 * revisions (a busy Agent round) is one save after the one in progress,
	 * not one save each. See `saveCoalescer.ts`.
	 */
	private readonly persistSaves = new SaveCoalescer(() => this.persistNow());

	private async persistNow(): Promise<void> {
		noteMainActivity("state save");
		// The Agents DevHub started with were seen before anybody could
		// start one on a named session: they are not given a name back.
		this.sweptAgents ??= new Map(
			this.state.workspaces.flatMap((workspace) =>
				workspace.agents.map(
					(agent) => [parseAgentId(agent.agent_id), undefined] as const,
				),
			),
		);
		if (!this.sessionMetaSeeded) {
			this.sessionMetaSeeded = true;
			this.sessionMeta.seed(
				this.state.workspaces.flatMap((workspace) =>
					workspace.agents.map((agent) => agent.agent_id),
				),
			);
		}
		this.state = applySnapshot(this.state, this.coordinator.snapshot());
		this.sweepSessionNames();
		this.sessionMeta.sweep();
		await this.saveState();
	}

	private async persist(token: OperationToken): Promise<void> {
		try {
			await this.persistSaves.request();
		} catch (error) {
			// A save that did not happen is reported as degraded, so the model can
			// roll back a close that depended on it rather than believing it landed
			// — and the reason it did not happen goes with it, because a save that
			// says only "changes could not be saved" tells the reader neither
			// which file nor what went wrong with it.
			//
			// It is *not* also published here. Reporting it twice put two
			// different sentences for one failure on the page — this one, and the
			// coordinator's — and the page then had to pick, which it did by
			// showing whichever arrived last.
			this.accept({
				type: "state_persistence_failed",
				token,
				reason: this.persistenceReason(error),
			});
			return;
		}
		this.accept({ type: "state_persisted", token });
	}

	private async resolvePath(
		token: OperationToken,
		requested: RequestedWorkspaceLocation,
	): Promise<void> {
		const path = requested.path;
		// The machine the folder is on, which is the only machine that can say
		// anything true about it. An ssh place used to skip resolution
		// altogether and become a Workspace with the path as typed; on a host
		// whose `$HOME` is a symlink that root is not the folder's canonical
		// name, and `createSession`'s rule — a root that canonicalises
		// elsewhere is a different directory — refused every session DevHub
		// tried to create over there.
		// By machine and not by place, and inside the `try`. `runtimeFor` wants a
		// `WorkspaceLocation`, and the whole point of this step is that there is
		// not one yet: the path is still whatever somebody typed, `~` and all,
		// and building a location out of it threw `INVALID_PATH` where nothing
		// was catching — an open that ended in silence.
		try {
			const runtime = runtimeForRequested(requested);
			// `~` is the *far* machine's home for a far place. Expanding it here
			// would name a folder on this Mac and then ask a host about it.
			const expanded =
				path === "~"
					? await runtime.home()
					: path.startsWith("~/")
						? posix.join(await runtime.home(), path.slice(2))
						: path;
			const canonical = await runtime.realpath(expanded);
			if ((await runtime.stat(canonical)) !== "directory") {
				throw new Error(`not a directory: ${canonical}`);
			}
			this.accept({
				type: "workspace_path_resolved",
				token,
				// The machine is what `requested` already said; only the path has
				// changed, from what somebody typed into what it resolved to. A
				// container keeps its host folder untouched that way, and takes the
				// canonical path as the one inside.
				location: workspaceLocation(requestedAtPath(requested, canonical)),
				selectedPath: displayPath(canonical),
			});
		} catch (error) {
			// The `try` raises its own "not a directory: ..." — picking a file
			// where a folder was expected — and that sentence is the whole
			// answer. Discarding it left the generic "nothing happened" that
			// `failOperation` exists to stop.
			this.failOperation(token, {
				subject: "app",
				code: "workspace_unavailable",
				detail: `${path}${whereRequested(requested)} could not be opened as a workspace: ${failureText(error)}`,
			});
		}
	}

	/**
	 * Carry out the answer to the three-way worktree question.
	 *
	 * The sheet asked which of three things should happen to the folder, and
	 * this is where two of them are said — the third is Cancel, which is the
	 * sheet dismissing itself and never gets here. The page reports *which
	 * answer*, not what to do about it: `--force` is what makes removing a
	 * worktree with uncommitted work possible at all, and that it is allowed is
	 * exactly what the person was asked, so it is named here, from the answer,
	 * and is not a flag the renderer passes.
	 *
	 * Neither answer removes anything *now*. The folder question is the first
	 * of a close's questions, and a close does nothing destructive until every
	 * question it has is answered — so the answer travels with the close and
	 * the removal happens as its `worktree` step, after the workbench has been
	 * asked about unsaved work and agreed to go.
	 */
	private async answerWorktreeClose(
		workspaceId: string,
		answer: "close" | "delete",
	): Promise<AppOutcomeWire> {
		const settled = await this.dispatchAwaiting({
			type: "request_close_workspace",
			workspaceId: parseWorkspaceId(workspaceId),
			worktree: answer === "delete" ? "remove-anyway" : "keep",
		});
		return this.raiseCloseConfirmation(
			outcomeWire(
				settled,
				this.coordinator.readiness,
				this.repositoryOf,
				this.homeOf,
			),
		);
	}

	/**
	 * Say one of the configured actions to an Agent that is already running.
	 *
	 * The same machinery as the Issue flow's first message and deliberately so:
	 * the wording is the person's, the variables are filled in here, the skill
	 * notation is translated for whichever agent is being spoken to, and the
	 * text is queued for the idle detector rather than typed at a terminal that
	 * may be mid-output. What differs is only what fired it.
	 *
	 * Every way this can fail is a refusal with words, because the alternative
	 * is a button that does nothing and says nothing. An agent that has gone, an
	 * id the config does not mention — a person editing `agent_actions` by hand
	 * can produce that — and a workspace whose branch cannot be read all say so
	 * where the button was pressed.
	 */
	private async runAgentAction(
		agentId: string,
		actionId: string,
	): Promise<AppOutcomeWire> {
		const agent = this.coordinator.model.workspaces
			.flatMap((workspace) => workspace.agents)
			.find((candidate) => candidate.id === agentId);
		if (!agent) throw workspaceFailure("That agent is not running.");
		const action = this.config.agentActions.find(
			(candidate) => candidate.id === actionId && candidate.enabled,
		);
		if (!action) {
			throw workspaceFailure(
				`There is no agent action called \`${actionId}\` in the configuration.`,
			);
		}
		// Sent by hand, it answers whatever its trigger stands for now, so an
		// automatic action does not send it a second time.
		this.automaticActions.answered(agent.id, action.trigger);
		// The values come from the same projection the Smart Buttons were drawn
		// from — so the message names the branch and the pull request the person
		// was looking at when they pressed it.
		this.sayToAgent(
			agent.id,
			agent.profile.kind,
			action,
			smartButtonValues(
				this.lastRepositoryStatus.workspaces.find(
					(entry) => entry.workspaceId === agent.workspaceId,
				),
			),
		);
		// Queueing changed the Agent's `injection`, which is what the buttons read
		// to say a message is waiting — so the page is handed the snapshot that
		// says so, rather than finding out on the next poll.
		return outcomeWire(
			{ kind: "updated", snapshot: this.coordinator.model.snapshot() },
			this.coordinator.readiness,
			this.repositoryOf,
			this.homeOf,
		);
	}

	/**
	 * Send whatever automatic actions are due (`model/automaticActions.ts`).
	 *
	 * Read on the two clocks its conditions move on — the projection (an
	 * Agent's status, a box ticked) and the repository status (a pull
	 * request's comments and CI) — and sent the way a Smart Button sends, so
	 * an automatic action is exactly the button pressed at the moment it
	 * appeared. One that cannot be sent says why, app-wide: nobody pressed
	 * anything for it to be refused under.
	 */
	private runAutomaticActions(): void {
		const actions = this.config.agentActions
			.filter((action) => action.enabled)
			.map((action) => ({ id: action.id, trigger: action.trigger }));
		const firings = this.automaticActions.observe(
			this.coordinator.model.workspaces.flatMap((workspace) =>
				workspace.agents.map((agent) => ({
					agentId: agent.id,
					status: agent.status,
					queued: agent.injection.queued,
					automaticActions: agent.automaticActions,
					repository: this.lastRepositoryStatus.workspaces.find(
						(entry) => entry.workspaceId === agent.workspaceId,
					),
				})),
			),
			actions,
		);
		for (const firing of firings) {
			console.log(
				`[devhub] automatic action ${firing.actionId} for ${firing.agentId} (${firing.trigger})`,
			);
			void this.runAgentAction(firing.agentId, firing.actionId).then(
				() => {
					this.publishSnapshot();
				},
				(error: unknown) => {
					this.publishError(errorWire(error));
				},
			);
		}
	}

	/**
	 * Compose one action for one Agent and put it where it will be sent.
	 *
	 * Every template DevHub says goes through here — the Issue flow's first
	 * message and the Smart Buttons alike — because they are one act
	 * with one difference: what fired it. Rendering, the review decision, and
	 * the sheet are therefore written once. A second caller that queued its own
	 * text directly would be a second answer to "does this get looked at first",
	 * and one of the two answers would eventually be the wrong one.
	 *
	 * `confirm_before_send` is the action's, not the caller's. A short, standing
	 * instruction like "commit what is here" is right every time and can be
	 * turned off; anything a person wants to glance at first stays on, which is
	 * the default because a sheet nobody wanted costs a keystroke and a sentence
	 * nobody read costs a turn of somebody's agent. The one caller that says
	 * otherwise is `devhub --tell`: a command line is the decision, and a sheet
	 * drawn over the person's window for it would be a question nobody there
	 * asked (`review: false`).
	 */
	private sayToAgent(
		agentId: ReturnType<typeof parseAgentId>,
		kind: AgentProfileKind,
		action: ConfiguredAgentAction,
		values: Readonly<Record<string, string>>,
		review: boolean = action.confirm_before_send,
	): void {
		const text = renderAgentAction(action, values, kind);
		const injectionId = agents()?.queueInjection(agentId, text, review);
		if (injectionId === undefined || !review) return;
		// The sheet goes up *now*, over an Agent that is still starting behind
		// it. That simultaneity is the point: the person reads and edits while
		// the program boots, and whichever of the two finishes last is what the
		// send waits on.
		shellWindow().picker.openModal({
			kind: "injection-review",
			agentId,
			injectionId,
			actionName: action.display_name,
			text,
		});
	}

	/**
	 * Tell the Agent that was just started what it is for.
	 *
	 * The wording is a setting — `agent_actions`, see `model/agentActions.ts` —
	 * so this fills in the Issue and translates the skill notation for whichever
	 * agent it is being said to, and leaves the text where the idle detector
	 * will find it. It is queued rather than sent because the Agent's program is
	 * still starting: keys typed into a terminal that has not drawn its prompt
	 * land in nothing.
	 *
	 * A message that cannot be composed is not an error worth stopping for. The
	 * workspace is open and the Agent is running, which is the whole of what the
	 * flow was for; the person types the URL themselves and nothing is lost.
	 *
	 * Queued, not sent: the Agent's program has not drawn its prompt yet, and
	 * keys typed into a terminal that is still starting land in nothing. When it
	 * goes is `agent/injection.ts`'s decision — it waits for a settled idle
	 * screen — and this side only ever says what.
	 */
	private queueIssuePrompt(
		before: ReadonlySet<string>,
		item: GitHubItem,
		actionId: string | undefined,
		how: IssuePromptHow = {},
	): void {
		const started = this.coordinator.model.workspaces
			.flatMap((workspace) => workspace.agents)
			.find((agent) => !before.has(agent.id));
		if (!started) return;
		// The action the person chose in the flow, and nothing else. No action
		// means they have none configured, which is a decision — the agent starts
		// and DevHub says nothing — rather than a gap to fill with a default.
		if (actionId === undefined) return;
		const action = this.config.agentActions.find(
			(candidate) => candidate.id === actionId && candidate.enabled,
		);
		if (action === undefined) return;
		// One pair of names for either kind. A person's actions are their own
		// wording, written before pull requests were accepted at all, and a
		// second pair meaning the same thing would make every template that
		// wanted to work for both say everything twice. `{{ISSUE_URL}}` is
		// the URL of the thing that was assigned, whichever it was.
		const values = {
			ISSUE_URL: gitHubItemUrl(item),
			ISSUE_NO: String(item.number),
		};
		this.sayToAgent(
			started.id,
			started.profile.kind,
			action,
			values,
			issuePromptReview(action, how),
		);
	}

	/**
	 * The profile an Agent is launched with: `resolveAgentProfile` on the
	 * Workspace's machine, which is where its Agent will run.
	 *
	 * The command is looked up before the launch, and the Agent is started from
	 * the absolute path that lookup returns. Passing the bare name to tmux
	 * instead would hand the search to a *different* PATH than the one DevHub
	 * resolved its own runtimes in — which is how a profile whose program is
	 * plainly on the person's PATH failed to start while tmux, found by the
	 * same kind of name, worked. And a name that resolves to nothing is said
	 * out loud rather than becoming a session that dies on `exec` a moment
	 * later, with nothing left to read.
	 *
	 * Every refusal here is this launch's, carried by the completion as a
	 * result like a launch's own: the Workspace is not marked, so a profile
	 * whose program is missing does not take the Workspace's other launches
	 * down with it, and the request reads it as the profile's failure.
	 */
	private async resolveProfile(
		token: OperationToken,
		workspaceId: WorkspaceId,
		profileId: string,
		extraArgs: readonly string[],
		resume: string | undefined,
	): Promise<void> {
		this.accept({
			type: "profile_resolution_completed",
			token,
			workspaceId,
			result: await this.profileResolution(
				workspaceId,
				profileId,
				extraArgs,
				resume,
			),
		});
	}

	private async profileResolution(
		workspaceId: WorkspaceId,
		profileId: string,
		extraArgs: readonly string[],
		resume: string | undefined,
	): Promise<AgentProfileResolution> {
		const workspace = this.coordinator.model.workspace(workspaceId);
		if (!workspace) {
			return {
				kind: "failed",
				code: "workspace_unavailable",
				detail: "The workspace this Agent belongs to is no longer open.",
			};
		}
		return this.profileOn(workspace.location, profileId, extraArgs, resume);
	}

	/**
	 * The profile as a launch on `location`'s machine runs it: the command
	 * resolved there, with the session it resumes, if it resumes one.
	 */
	private async profileOn(
		location: WorkspaceLocation,
		profileId: string,
		extraArgs: readonly string[],
		resume: string | undefined,
	): Promise<
		| Extract<AgentProfileResolution, { kind: "resolved" }>
		| {
				readonly kind: "failed";
				readonly code: "agent_profile_unavailable";
				readonly detail: string;
		  }
	> {
		const configured = this.config.agentProfiles.find(
			(profile) => profile.id === profileId,
		);
		if (!configured) {
			return {
				kind: "failed",
				code: "agent_profile_unavailable",
				detail: `There is no agent profile called “${profileId}”.`,
			};
		}
		if (
			resume !== undefined &&
			configured.kind !== "claude" &&
			configured.kind !== "codex"
		) {
			return {
				kind: "failed",
				code: "agent_profile_unavailable",
				detail: `“${configured.display_name}” is a ${configured.kind} profile, which has no sessions to resume.`,
			};
		}
		// A resumed launch picks its session in place of any the profile's own
		// arguments pick (`withSession`), so its record says exactly one.
		const args = [...configured.args, ...extraArgs];
		const resolved = await resolveAgentProfile(
			runtimeFor(location),
			{
				...configured,
				args:
					resume === undefined
						? args
						: withSession(
								configured.kind,
								args,
								resumeArgs(configured.kind, resume),
							),
			},
			[],
			this.launchEnvironment["PATH"] ?? "",
		);
		if (resolved.kind === "unavailable") {
			return {
				kind: "failed",
				code: "agent_profile_unavailable",
				detail: this.executableMissingMessage(resolved),
			};
		}
		return {
			kind: "resolved",
			profile: toDomainProfile(resolved.profile, this.config.agents),
		};
	}

	/**
	 * The command a launch from `profileId` in `place` would run, for reading
	 * the sessions its CLI keeps there — refused the way that launch is,
	 * because it is the same refusal: the profile cannot be run there.
	 */
	private async sessionsProfile(place: WorkspacePlaceWire, profileId: string) {
		const location = workspaceLocation(place);
		const resolution = await this.profileOn(location, profileId, [], undefined);
		if (resolution.kind === "failed") {
			throw namedFailureAt(resolution.code, resolution.detail);
		}
		return { runtime: runtimeFor(location), profile: resolution.profile };
	}

	private async inspect(
		token: OperationToken,
		workspaceId: WorkspaceId,
	): Promise<void> {
		const inspection = await this.closeInspection(workspaceId);
		this.accept({
			type: "workspace_inspection_completed",
			token,
			workspaceId,
			inspection,
		});
	}

	/**
	 * What a close of this Workspace would ask about: the close sheet's rows.
	 * The coordinator's inspection and `--tell workspace close` both read it.
	 */
	private async closeInspection(
		workspaceId: WorkspaceId,
	): Promise<CloseInspectionInputs> {
		const workspace = this.coordinator.model.workspace(workspaceId);
		return inspectWorkspaceResources(
			workspaceId,
			// Only the Agents that stopping would interrupt: an idle one is not a
			// reason to ask anything, and the close stops it on the way out. The
			// rule is `agentsInspection`'s, and it is the same one `Cmd+Q X` on a
			// single Agent reads.
			agentsInspection(workspace?.agents ?? []),
			// A Neovim's unsaved buffers are its own to ask about (`:qa` in
			// it); DevHub's close has no editor of its own to inspect.
			{ kind: "clean" },
		);
	}

	private async launchAgent(
		token: OperationToken,
		workspaceId: WorkspaceId,
		agentId: ReturnType<typeof parseAgentId>,
		profile: AgentProfile,
		presentation: AgentPresentation,
	): Promise<void> {
		const adapter = agents();
		const workspace = this.coordinator.model.workspace(workspaceId);
		if (!adapter || !workspace) {
			// Nothing can launch an Agent, so nothing pretends one launched —
			// and the person is told which of the two was missing.
			this.failOperation(
				token,
				adapter
					? {
							subject: "agent",
							id: agentId,
							code: "workspace_unavailable",
							detail: "The workspace this Agent belongs to is no longer open.",
						}
					: {
							subject: "agent",
							id: agentId,
							code: "agent_runtime_unavailable",
							detail:
								"The Agent runtime is not running, so no Agent can be started.",
						},
			);
			return;
		}
		const result = await adapter.launch(
			workspaceId,
			agentId,
			profile,
			presentation,
			workspace.root,
		);
		this.accept({
			type: "agent_launch_completed",
			token,
			workspaceId,
			agentId,
			result,
		});
	}

	private async stopAgent(
		token: OperationToken,
		agentId: ReturnType<typeof parseAgentId>,
		kind: "stop_agent" | "terminate_agent",
		moveTerminal: boolean,
		/** A person closing it, to be reopened (`model/recentlyClosed.ts`). */
		closing: boolean,
	): Promise<void> {
		const adapter = agents();
		if (!adapter) {
			this.failOperation(token, {
				subject: "agent",
				id: agentId,
				code: "agent_runtime_unavailable",
				detail: "The Agent runtime is not running, so no Agent can be stopped.",
			});
			return;
		}
		// What reopening it needs, read while its CLI is still there to say
		// which session it is in.
		const closed = closing ? await this.closedAgentEntry(agentId) : undefined;
		if (moveTerminal) {
			try {
				await this.moveAgentTerminalToEditor(agentId);
			} catch (error: unknown) {
				// Not stopped: stopping would end what the person chose to keep.
				this.accept({
					type: "agent_stop_completed",
					token,
					agentId,
					result: {
						kind: "failed",
						code: "tmux_command_failed",
						detail: `DevHub could not move the terminal to the editor, so the Agent was not stopped: ${failureText(error)}`,
					},
				});
				return;
			}
		}
		const result =
			kind === "stop_agent"
				? await adapter.stop(agentId)
				: await adapter.terminate(agentId);
		// Before the completion, whose persist writes it down with the rest.
		if (closed !== undefined && result.kind === "stopped") {
			this.rememberClosedEntry(closed);
		}
		this.accept(
			kind === "stop_agent"
				? { type: "agent_stop_completed", token, agentId, result }
				: { type: "agent_termination_completed", token, agentId, result },
		);
	}

	/**
	 * Start a GUI Agent's CLI again on its session: done once the new CLI is
	 * ready. The conversation's refusal or failure, and a host that could not
	 * start it again, are the person's news, drawn once here and answered to
	 * whoever asked; anything else is DevHub's own bug and goes to the root.
	 */
	private async restartAgent(
		token: OperationToken,
		agentId: ReturnType<typeof parseAgentId>,
	): Promise<void> {
		const wiring = this.agentWiring;
		if (wiring === undefined) {
			throw new InvariantViolation(
				"a restart was dispatched before the Agent adapter was wired",
			);
		}
		if (this.coordinator.model.agent(agentId)?.presentation === "tui") {
			await this.restartTerminalAgent(token, agentId, wiring);
			return;
		}
		try {
			await (await wiring.conversations.of(agentId)).restart();
		} catch (error: unknown) {
			const failure =
				error instanceof HostLinkFailure
					? new ConversationStopped(
							`DevHub could not start the CLI again: ${error.message}`,
						).wire
					: error instanceof NamedFailure
						? error.wire
						: undefined;
			if (failure === undefined) throw error;
			this.publishError(failure);
			this.accept({ type: "operation_failed", token, failure });
			return;
		}
		this.accept({ type: "agent_restart_completed", token, agentId });
	}

	/**
	 * Start a terminal Agent's CLI again in its own pane, on the session it is
	 * in (`AgentWiring.restartTerminal`): done once tmux has respawned the
	 * pane. A session that cannot be told is the conversation's own refusal,
	 * said as it is; a pane tmux would not respawn is the port's, said the way
	 * a launch's is.
	 */
	private async restartTerminalAgent(
		token: OperationToken,
		agentId: ReturnType<typeof parseAgentId>,
		wiring: AgentWiring,
	): Promise<void> {
		try {
			await wiring.restartTerminal(agentId);
		} catch (error: unknown) {
			if (error instanceof NamedFailure) {
				this.publishError(error.wire);
				this.accept({ type: "operation_failed", token, failure: error.wire });
				return;
			}
			const refusal = portRefusal(error);
			const detail =
				refusal.detail ??
				`DevHub could not start the CLI again: ${failureText(error)}`;
			this.failOperation(
				token,
				agentSubject(agentId, { code: refusal.code, detail }),
			);
			return;
		}
		this.accept({ type: "agent_restart_completed", token, agentId });
	}

	private async reconcile(
		token: OperationToken,
		agentId: ReturnType<typeof parseAgentId> | undefined,
		machine: RuntimeId | undefined,
	): Promise<void> {
		const adapter = agents();
		if (!adapter) {
			// Not `agent_runtime_unavailable`, and above all not the *machine's*
			// failure. `agentSubject` with no Agent blames the machine, so a round
			// dispatched before `wireAgents` had run said "DevHub is not getting an
			// answer from local" about a tmux that was answering perfectly — and
			// said it again on every round. DevHub's own adapter not being there
			// is DevHub's bug, and a bug is not a notice. See `invariant.ts`, and
			// `bootstrapShell` for the ordering that makes this unreachable.
			throw new InvariantViolation(
				"a reconcile round was dispatched before the Agent adapter was wired",
			);
		}
		// One Agent's round is about the machine that Agent is on; a whole
		// machine's round says which in the effect. Neither is a search: an
		// Agent whose Workspace has gone has no machine, and it has no session
		// to ask about either, so the round is over before it starts.
		const asked =
			machine ??
			(agentId === undefined ? undefined : this.machineOfAgent(agentId));
		if (asked === undefined) {
			this.failOperation(
				token,
				agentSubject(agentId, {
					code: "agent_runtime_unavailable",
					detail:
						"The Workspace this Agent belongs to is no longer open, so there is no machine to ask about it.",
				}),
			);
			return;
		}
		let reconciliation: AgentReconciliation;
		try {
			reconciliation = await adapter.reconcile(asked, agentId);
		} catch (error) {
			// A provider that would not answer is a failure of the Agent port, and
			// the model has to be told so: an effect nobody completes leaves the
			// operation open until its deadline and reports the deadline instead of
			// the outage. The reason goes to the log; the page is told which port
			// failed, in that port's own words, by the one path that reports
			// operation failures.
			console.error(error instanceof Error ? error.stack : error);
			this.failOperation(
				token,
				agentSubject(agentId, portRefusal(error), asked),
			);
			return;
		}
		// The machine answered. Which round asked does not matter: an answer is
		// an answer, and the condition is about the machine, not about the
		// round. Whether it is enough of an answer to take a notice down is
		// `machineConditions`' decision and nobody else's.
		this.machineConditions.succeeded(asked);
		noteMainActivity(`agent round on ${asked}`);
		if (agentId === undefined) {
			this.accept({ type: "agents_reconciled", token, reconciliation });
			return;
		}
		if (reconciliation.exited.includes(agentId)) {
			this.accept({ type: "agent_exited", token, agentId });
			return;
		}
		const observation = reconciliation.observations.find(
			(candidate) => candidate.agentId === agentId,
		);
		if (!observation) {
			this.failOperation(token, {
				subject: "agent",
				id: agentId,
				code: "tmux_command_failed",
				detail:
					"The Agent runtime answered without saying anything about this Agent.",
			});
			return;
		}
		this.accept({
			type: "agent_status_changed",
			token,
			agentId,
			status: observation.status,
			runtimeHealth: observation.runtimeHealth,
		});
	}

	/**
	 * Run the whole close, in order, and answer with one outcome.
	 *
	 * The rule is `Coordinator.closeWorkspace`'s; this is the environment half
	 * of it. Two things are load-bearing here.
	 *
	 * **The editor comes first**: the Workspace's managed Neovim, whose
	 * unsaved buffers the close's question already counted as a running
	 * program.
	 *
	 * **Every step after it treats "already gone" as success.** A `kill-session`
	 * on a session somebody killed from outside, a whole tmux server that is not
	 * there, a view whose renderer already died, a worktree directory that has
	 * been deleted by hand — all of them are the state the step was trying to
	 * reach. That is what makes repeating the close after a failure correct: it
	 * runs the same steps and finds the finished ones done. Nothing is
	 * remembered between attempts, deliberately.
	 *
	 * A step that genuinely fails stops the close there and names itself. Each
	 * has one deadline (`withCloseDeadline`), so a process that has stopped
	 * answering cannot hang the close for ever.
	 */
	private async closeWorkspaceResources(
		token: OperationToken,
		workspaceId: WorkspaceId,
		worktree: WorktreeDisposition,
	): Promise<void> {
		let step: CloseStep = "editor";
		// What the close could not stop, because the machine it is on did not
		// answer. Collected rather than thrown; see `closeSessionsOnMachine`.
		const leftRunning: string[] = [];
		// Where the editor was, read before anything is closed: closing the
		// Workspace is its editor leaving any container it was in.
		const closing = this.coordinator.model.workspace(workspaceId);
		let reopenable: ClosedEntryRecord | undefined;
		try {
			await withCloseDeadline(step, this.closeManagedNeovim(closing));
			// What reopening it needs, its Agents' sessions included, read
			// while they are still running. A worktree this close deletes is
			// remembered as its branch, read now while git still knows it,
			// and made again by the reopen (`closeRemembers`).
			const remembers = closeRemembers(
				worktree,
				this.lastRepositoryStatus.workspaces.find(
					(entry) => entry.workspaceId === workspaceId,
				),
			);
			reopenable = remembers.remember
				? await this.closedWorkspaceEntry(workspaceId, remembers.worktree)
				: undefined;

			step = "agents";
			const agentAdapter = agents();
			if (agentAdapter) {
				await this.closeSessionsOnMachine(
					step,
					workspaceId,
					() => agentAdapter.closeWorkspaceAgents(workspaceId),
					leftRunning,
				);
			}
			// With no Agent runtime there are no Agents, so this step is already
			// true — the model's own Agent list is emptied by the transition.

			step = "terminal";
			const terminalAdapter = terminals();
			if (terminalAdapter) {
				await this.closeSessionsOnMachine(
					step,
					workspaceId,
					() => terminalAdapter.closeWorkspaceTerminals(workspaceId),
					leftRunning,
				);
			}

			step = "worktree";
			await withCloseDeadline(
				step,
				this.disposeWorktree(workspaceId, worktree),
			);
		} catch (error) {
			// Every way a step can end is a completion. A step that threw and a
			// step that never answered both land here as a close that failed at a
			// named step, because the alternative — a row that greys out,
			// breathes, refuses every operation and never stops, with nothing on
			// screen saying why — is the bug this exists to prevent.
			// What the tool said, and only what the tool said. `NamedFailure` is
			// how git's last stderr line, the errno sentences and a machine's
			// refusals reach here, and passing its words through is the
			// difference between "A cleanup step did not finish" and "fatal: '…'
			// contains modified or untracked files, use --force to delete it".
			// Nothing is composed here; a failure with no words of its own
			// carries none.
			this.failClose(
				token,
				workspaceId,
				step,
				error instanceof CloseTimeout ? error.diagnostic : "cleanup_failed",
				error instanceof NamedFailure ? failureText(error) : undefined,
			);
			return;
		}
		// Once, and after the close rather than during it, because it is a note
		// about a close that finished — not a step that failed. It goes down the
		// same path every other failure the person sees goes down, so there is
		// one alert to read and one to dismiss.
		if (leftRunning.length > 0) {
			this.publishError(
				withDetail(
					errorWireAt("workspace_sessions_left_running"),
					sessionsLeftRunningDetail(leftRunning),
				),
			);
		}
		// Before the completion, whose persist writes it down with the rest.
		if (reopenable !== undefined) this.rememberClosedEntry(reopenable);
		this.accept({
			type: "workspace_close_completed",
			token,
			workspaceId,
			result: { kind: "closed" },
		});
	}

	/**
	 * A close step that stops sessions on the workspace's machine.
	 *
	 * The two of them — Agents and terminals — are the steps whose subject is
	 * on another computer, and they are the two that used to strand a row. A
	 * close would stop at `terminal` with `DevHub cannot reach <host>`, and the
	 * workspace stayed in the list, greyed out, refusing every operation,
	 * for ever: repeating the close asked the same unreachable machine the same
	 * question.
	 *
	 * The rule is the owner's — *as few resources as possible left behind, but
	 * the close always completes*. A machine that does not answer cannot have
	 * anything stopped on it, and waiting does not change that; so the close
	 * goes on, DevHub forgets the workspace, and the sessions are named out
	 * loud instead of being lost silently — see `sessionsLeftRunning` for what
	 * is and is not promised about them afterwards.
	 *
	 * Only "the machine did not answer" is continued past. A tmux that answered
	 * and refused, or a step that ran out of its deadline while the host was
	 * up, is a failure about DevHub's own work and still stops the close —
	 * those are the ones a person can act on by trying again.
	 */
	private async closeSessionsOnMachine(
		step: CloseStep,
		workspaceId: WorkspaceId,
		work: () => Promise<unknown>,
		leftRunning: string[],
	): Promise<void> {
		try {
			await withCloseDeadline(step, work());
		} catch (error: unknown) {
			// A workspace the model no longer has is one nothing can be reported
			// about — there is no machine to name — so that failure stays a
			// failure rather than becoming a note with a hole in it.
			const machine = this.machineOf(workspaceId);
			const left =
				machine === undefined
					? undefined
					: sessionsLeftRunning(step, machine, error);
			if (left === undefined) throw error;
			console.error(
				`[devhub] close: ${left} could not be stopped — ${failureText(error)}`,
			);
			leftRunning.push(left);
		}
	}

	private failClose(
		token: OperationToken,
		workspaceId: WorkspaceId,
		step: CloseStep,
		diagnostic: CloseDiagnosticWire,
		detail?: string,
	): void {
		this.accept({
			type: "workspace_close_completed",
			token,
			workspaceId,
			result: {
				kind: "failed",
				step,
				diagnostic,
				...(detail === undefined ? {} : { detail }),
			},
		});
	}

	/**
	 * Do what the person said about the folder, if they said anything.
	 *
	 * The answer arrived with the close. `remove-anyway` is the only thing that
	 * forces, and it is only ever reached through the question that named what
	 * would be destroyed; `remove` lets git refuse, because DevHub's idea of
	 * "clean" is a poll up to a minute old and git is the authority.
	 *
	 * A directory that is already gone is the state this is trying to reach, so
	 * it is not a failure — but git's administrative record for it is still
	 * there, and leaving that behind is what makes the next `worktree add` on
	 * the same path refuse. So the folder being absent means prune, not skip.
	 *
	 * **The branch is not touched.** A worktree is a *place*; a branch is
	 * *work*. Removing the place must not destroy the work — it may be pushed,
	 * may have a pull request open against it, and is the whole of what links a
	 * workspace to its Issue. Somebody who wants it gone runs `git branch -d`,
	 * where git refuses if it is unmerged.
	 */
	private async disposeWorktree(
		workspaceId: WorkspaceId,
		disposition: WorktreeDisposition,
	): Promise<void> {
		if (disposition === "keep") return;
		const workspace = this.coordinator.model.workspace(workspaceId);
		if (!workspace) return;
		const repository = this.lastRepositoryStatus.workspaces.find(
			(entry) => entry.workspaceId === workspaceId,
		);
		// The folder's own claim, read before anything is removed. It is asked
		// first because it is the claim that survives: `git worktree remove` can
		// delete its administrative record and then fail, after which git's list
		// says nothing and only the `.git` file still knows. It is also what the
		// fallback below is allowed to delete, and a folder that stopped being
		// readable throws from here rather than being mistaken for one that is
		// already gone.
		const git = {
			runtime: runtimeFor(workspace.location),
			root: workspace.root,
		};
		const folder = await readWorktreeFolder(git.runtime, git.root);
		const gitSaysWorktree =
			repository?.mainWorktree !== undefined &&
			repository.worktree === git.root &&
			repository.worktree !== repository.mainWorktree;
		const mainWorktree = gitSaysWorktree
			? repository.mainWorktree
			: folder?.mainWorktree;
		if (mainWorktree === undefined) {
			// The repository itself, a folder DevHub has not read yet, or a
			// subdirectory of a checkout rather than the checkout. Removing a
			// repository is not what this is for, removing the checkout
			// somebody's row happens to sit inside is not either, and guessing is
			// not either.
			throw workspaceFailure(
				"This workspace is not a worktree of a repository DevHub can see.",
			);
		}
		await disposeWorktreeFolder(
			// The repository's own machine. Everything the disposal does — the
			// probe, `git worktree remove`, the prune, the folder removal — goes
			// through the runtime on this command, so a worktree of a repository
			// on a host is removed there and not looked for here.
			await this.gitCommand(git.runtime),
			mainWorktree,
			git.root,
			disposition === "remove-anyway",
		);
	}

	//#endregion

	//#region workbench views

	/**
	 * The open itself, from the wait for VS Code to the view on the window.
	 *
	 * The first thing it does is wait: the shell is up long before the DI
	 * container is, and a workbench asked for in that window is early, not
	 * impossible. Everything after the wait is the same whenever it was asked.
	 */
	/**
	 * The place a workbench key names, or nothing when no Workspace is there.
	 *
	 * Read out of the model rather than remembered beside the map, because the
	 * model is where a Workspace's place lives and a second copy is a second
	 * thing that can be stale.
	 */
	private workspaceForEditorKey(editorKey: string): Workspace | undefined {
		return this.coordinator.model.workspaces.find(
			(workspace) => workspace.key === editorKey,
		);
	}

	/**
	 * The `devhub` command on this machine, installed if need be.
	 *
	 * One answer per machine, remembered, because installing it is files written
	 * over a network and a socket forwarded, and a second ask for the same host
	 * must not redo either. It is not remembered *across* a failure: a host that
	 * was unreachable when first asked is asked again by the second, which is
	 * how it recovers without a restart.
	 *
	 * However it ends, it ends in `launcherStatus`, which is what `devhub
	 * --metrics` prints, so "where can a pane reach DevHub" is one reading.
	 */
	private terminalLauncherFor(runtime: Runtime): Promise<TerminalLauncher> {
		const existing = this.launchers.get(runtime.id);
		if (existing) return existing;
		const installed = this.installTerminalLauncher(runtime);
		this.launchers.set(runtime.id, installed);
		void installed.then(
			(launcher) => {
				this.launcherStatus.set(runtime.id, {
					machine: runtime.id,
					installed: true,
					reason: launcher.unreachable,
				});
			},
			(error: unknown) => {
				this.launcherStatus.set(runtime.id, {
					machine: runtime.id,
					installed: false,
					reason: failureText(error),
				});
				if (this.launchers.get(runtime.id) === installed) {
					this.launchers.delete(runtime.id);
				}
			},
		);
		return installed;
	}

	/**
	 * Ask one machine for its `devhub` command.
	 *
	 * `async` so that everything here — a user-data directory that is not there
	 * yet, a bundle the build did not produce — fails the returned promise
	 * rather than the caller's stack. One failure path is what lets
	 * `terminalLauncherFor` record every outcome in one place.
	 */
	private async installTerminalLauncher(
		runtime: Pick<Runtime, "terminalLauncher">,
	): Promise<TerminalLauncher> {
		const userDataPath = this.userDataPath;
		if (userDataPath === undefined) {
			throw new Error(
				"a `devhub` command was asked for before the runtimes were started",
			);
		}
		return runtime.terminalLauncher({
			controlSocketPath: controlSocketPath(userDataPath),
			skillText: devhubSkillText,
		});
	}

	private editorKeyForSurfaceKey(surfaceKey: string): string | undefined {
		const prefix = "workspace-editor:";
		if (!surfaceKey.startsWith(prefix)) return undefined;
		const id = surfaceKey.slice(prefix.length) as WorkspaceId;
		return this.coordinator.model.workspace(id)?.key;
	}

	/** A closing Workspace's managed Neovim, if it has one. */
	private async closeManagedNeovim(
		workspace: Workspace | undefined,
	): Promise<void> {
		if (workspace === undefined) return;
		this.neovimShown.delete(workspace.key);
		await this.neovimEditors?.close({
			machine: runtimeIdFor(workspace.location),
			workspaceId: workspace.id,
			root: workspace.root,
		});
	}

	/**
	 * Open a folder on the page's behalf, and answer with the outcome.
	 *
	 * `withAgent` is the profile the person asked to start in it — the picker's
	 * Command gesture — and how they asked for it to be shown, and it is carried here rather than made a second call
	 * because it is one act: a folder opened for an agent that then failed to
	 * start would leave them looking at a workspace they did not ask for on its
	 * own. Every way of opening ends up here, so the gesture means the same
	 * thing on a folder that already existed, one a source offered to make, one
	 * just created and one just cloned.
	 *
	 * `opening` is why: `explicit` — somebody opened this Workspace (the
	 * Workspace picker, `Cmd+Q F`, a folder from the command line) — starts or
	 * wakes its editor at once when that is what its editor area shows, and
	 * is a place for Back and Forward. `for-agent` — a flow opening it on the
	 * way to an Agent (a resumed session, an Issue's worktree, `devhub --tell`,
	 * a reopened Agent) — starts nothing: the editor area shows its placeholder
	 * until somebody asks (`docs/window-and-pages.md`). An Agent asked for
	 * here (`withAgent`) makes it `for-agent` too.
	 */
	private async openFolder(
		location: RequestedWorkspaceLocation,
		withAgent?: AgentLaunchWire,
		placement: WorkspacePlacement = "automatic",
		opening: "explicit" | "for-agent" = "explicit",
	): Promise<AppOutcomeWire> {
		// Opening a folder is going there, keyboard and all: the selection it
		// makes is where the keys land, the Sidebar it may have been asked
		// from included. See `arrive`.
		this.keyboardInSidebar = false;
		const anchor =
			placement === "below-selection" ? this.placementAnchor() : undefined;
		const openBefore = new Set(
			this.coordinator.model.workspaces.map((workspace) => workspace.id),
		);
		// An explicit open of the folder alone is a place for Back and Forward
		// the moment it is selected. One opened for an Agent is not: the Agent
		// it then makes is the place (`AppModel.addAgent`).
		const opened = await this.dispatchAwaiting({
			type: "open_folder",
			location,
			...(opening === "explicit" && withAgent === undefined
				? { reason: "explicit" as const }
				: {}),
		});
		if (anchor !== undefined) {
			const workspaceId = this.openedWorkspaceId(location);
			// Only a row this open made. A folder that was open already is
			// selected where it stands: it was put there by somebody.
			if (!openBefore.has(workspaceId)) this.placeBelow(workspaceId, anchor);
		}
		if (withAgent === undefined) {
			return outcomeWire(
				opened,
				this.coordinator.readiness,
				this.repositoryOf,
				this.homeOf,
			);
		}
		const settled = await this.dispatchAwaiting({
			type: "create_agent",
			workspaceId: this.openedWorkspaceId(location),
			profileId: agentProfileId(withAgent.profileId),
			agentPresentation: agentPresentation(withAgent.presentation),
			// The person answered "which profile", not "where to put it". The
			// Agent gets the plain arrangement, the same one `devhub --agent`
			// gets, and the modifier they used to get here has already been spent
			// saying they wanted an agent at all.
			presentation: "full",
		});
		return outcomeWire(
			settled,
			this.coordinator.readiness,
			this.repositoryOf,
			this.homeOf,
		);
	}

	/**
	 * Open a folder for `devhub --tell`: the Workspace is made (or found) and
	 * appears in the Sidebar, and nothing else happens — no selection, so
	 * nothing shown, no keyboard moved and no workbench asked for (it starts
	 * in the background, as any Workspace not on screen does). Answers which
	 * Workspace it is: a new one, or the open one whose folder this is.
	 */
	private async openFolderUnfocused(
		location: RequestedWorkspaceLocation,
		placement: WorkspacePlacement = "automatic",
	): Promise<WorkspaceId> {
		const anchor =
			placement === "below-selection" ? this.placementAnchor() : undefined;
		const before = new Set(
			this.coordinator.model.workspaces.map((workspace) => workspace.id),
		);
		await this.dispatchAwaiting({
			type: "open_folder",
			location,
			focus: "none",
		});
		const sameMachine = (workspace: Workspace): boolean =>
			workspace.location.kind === location.kind &&
			(workspace.location.kind !== "ssh" ||
				(location.kind === "ssh" && workspace.location.host === location.host));
		const made = this.coordinator.model.workspaces.find(
			(workspace) => !before.has(workspace.id) && sameMachine(workspace),
		);
		if (made !== undefined) {
			if (anchor !== undefined) this.placeBelow(made.id, anchor);
			return made.id;
		}
		const real = await runtimeFor(workspaceLocation(location))
			.realpath(location.path)
			.catch(() => location.path);
		const strip = (path: string) =>
			path.length > 1 ? path.replace(/\/+$/u, "") : path;
		const open = this.coordinator.model.workspaces.find(
			(workspace) =>
				sameMachine(workspace) &&
				(strip(workspace.root) === strip(real) ||
					strip(workspace.root) === strip(location.path)),
		);
		if (open === undefined)
			throw new Error(`opening ${location.path} made no workspace`);
		return open.id;
	}

	/**
	 * The person did something in the place on screen, or went there on
	 * purpose: it enters Back and Forward's history. Asked first, so the
	 * thousandth keystroke in one place dispatches nothing.
	 */
	private noteInteraction(): void {
		if (!this.coordinator.model.interactionIsNew()) return;
		this.dispatchOwn({ type: "note_interaction" });
	}

	/**
	 * The Workspace a new row opened from the Sidebar's own flows goes under:
	 * the one the selection is in, its row or one of its Agents.
	 *
	 * Nothing for Scratch. It is not one of the ordered rows — it is pinned
	 * above them — and being in it is being in no Workspace in particular, so
	 * a folder opened from there lands where it always has.
	 */
	private placementAnchor(): WorkspaceId | undefined {
		const model = this.coordinator.model;
		const context = model.selection.context;
		const workspace =
			context.kind === "workspace"
				? model.workspace(context.workspaceId)
				: context.kind === "agent"
					? model.workspaceForAgent(context.agentId)
					: undefined;
		if (
			workspace === undefined ||
			workspace.id === model.scratchWorkspaceId ||
			workspace.id === model.orchestratorWorkspaceId
		) {
			return undefined;
		}
		return workspace.id;
	}

	/**
	 * Put a row just opened directly under `anchor`, as a drop there would
	 * (`placeWorkspaceBelow`), and write the order down the way a drop does.
	 */
	private placeBelow(workspaceId: WorkspaceId, anchor: WorkspaceId): void {
		const order = placeWorkspaceBelow(
			sidebarWorkspaces(this.snapshot()).rows,
			(row) => row.groupKey,
			workspaceId,
			anchor,
		);
		if (order === undefined) return;
		this.dispatchOwn(intentFromWire({ type: "reorder_workspaces", order }));
	}

	/**
	 * Which Workspace an `openFolder` just produced.
	 *
	 * The selection: opening a folder selects it, whether it was open already
	 * or has just been added. Matching the path back would be a second answer
	 * to a question already answered — the root is canonicalised on the way
	 * in, so it is not the string the call was given — and a second answer is
	 * one that can disagree.
	 */
	private openedWorkspaceId(target: RequestedWorkspaceLocation): WorkspaceId {
		const context = this.coordinator.model.selection.context;
		if (context.kind === "workspace") return context.workspaceId;
		// The model and this call disagree about what just took place; going on
		// would attach whatever comes next to whatever else was selected.
		throw new Error(`opening ${target.path} did not select a workspace`);
	}

	/**
	 * Dispatch, and take hold of the answer before the chain is allowed to run.
	 *
	 * The order is the whole point. Some effects complete synchronously inside
	 * the drain — generating a confirmation id is one — so a chain can be over
	 * before `drain()` returns. Registering the waiter afterwards means
	 * registering it for an operation that already ended: nothing will ever
	 * settle it, and the caller waits out its own deadline and is told the
	 * request did not finish. That is how asking to stop an Agent produced a
	 * timeout instead of a confirmation.
	 */
	private dispatchAwaiting(intent: UserIntent): Promise<IntentOutcome> {
		return this.dispatchSettled(intent).catch((error: unknown) => {
			throw namedFailure(error);
		});
	}

	/** `dispatchAwaiting`, with the failure unconverted, for a caller that converts it itself. */
	private async dispatchSettled(intent: UserIntent): Promise<IntentOutcome> {
		let outcome: IntentOutcome;
		try {
			outcome = this.coordinator.dispatchUser({
				intentId: parseIntentId(randomUUID()),
				operationId: this.freshOperationId(),
				intent,
			});
		} catch (error) {
			this.drain();
			// Refused on the spot: drawn once, here, and handed to the caller
			// marked as drawn — the same rule a refused completion follows.
			const refusal = refusalOf(error, false);
			if (refusal.kind === "crash") throw error;
			if (refusal.publish) this.publishError(refusal.publish);
			throw refusal.rejection;
		}
		const answer = this.awaitOutcome(outcome);
		this.drain();
		return answer;
	}

	/** Scratch: today's daily-folder Workspace. See `AppModel.scratchWorkspaceId`. */
	private scratchWorkspace(): Workspace {
		const model = this.coordinator.model;
		const scratch = model.workspace(model.scratchWorkspaceId);
		if (!scratch)
			throw new Error("Scratch is not one of the model's workspaces");
		return scratch;
	}

	//#endregion

	//#region the devhub command line

	/**
	 * A request that came from outside DevHub and failed, said out loud.
	 *
	 * The `devhub` command has a terminal to be refused in, and the App Shell
	 * page has the request it made. Finder has neither: it hands DevHub a path
	 * and stops listening. So the failure has nowhere to go but the one place
	 * DevHub shows failures that belong to the application rather than to a
	 * workspace or an Agent — the same `publishError` every other rootless
	 * failure ends at. Without it, "Open With ▸ DevHub" on a file DevHub cannot
	 * open does nothing at all, and nothing is the one report nobody can act on.
	 */
	noteFailure(error: unknown): void {
		this.publishError(errorWire(error));
	}

	/**
	 * `devhub`, with nothing after it.
	 *
	 * There is nothing to open and nothing to choose, so nothing is chosen: the
	 * context the person left is the context they come back to. Every other
	 * command on this socket finishes by bringing DevHub forward, because a
	 * command that acts somewhere you cannot see has not acted; this one is
	 * that finish with nothing in front of it.
	 */
	activateFromCli(): Promise<string> {
		this.bringToFront();
		return Promise.resolve("DevHub is in front.");
	}

	/**
	 * `devhub <path>`.
	 *
	 * A folder is a Workspace: opening one that DevHub already knows selects
	 * the entry it has rather than making a second, because `open_folder` keys
	 * on the canonical root and that is the one rule for it.
	 *
	 * A file belongs to the open Workspace whose root is its nearest ancestor,
	 * and to Scratch — today's daily folder — when no open Workspace contains
	 * it. It is
	 * deliberately never "the window you last looked at": the same command has
	 * to mean the same thing from the same directory, whatever has the focus.
	 *
	 * Either way the thing that was opened is then *activated* — selected in
	 * the sidebar, with the Editor activity showing and the window in front —
	 * because a command that opens something you cannot see has not opened it.
	 */
	async openFromCli(request: ControlOpenRequest): Promise<string> {
		const { path, position, waitMarkerPath } = request;
		// The `devhub` command inside a dev container: the file is in that
		// container, and there is no editor there to open it in — the Neovim
		// editor runs on a Workspace's own machine (docs/neovim-editor.md).
		if (containerTargetFromHostId(request.machine ?? "") !== undefined) {
			throw new Error(
				`${path} is inside a dev container, and DevHub's editor does not run in one; open it from the Workspace's own machine.`,
			);
		}
		// A path is a path on one computer, and which one is a fact the
		// request carries rather than a default this reaches for: an absent
		// `machine` is every caller that runs on this Mac, and a `devhub` on a
		// host says which host it is. Checked here, once, so that everything
		// below is talking about one machine's disk.
		const machine = runtimeMachine(request.machine ?? "local");
		// Taken before anything is selected: this is the "before" a `--wait`
		// goes back to when its editor is closed.
		const before = this.coordinator.model.selection;
		// Resolved on the machine that owns the path, because that is where its
		// symlinks are. Doing it here would answer about this disk — a refusal
		// about a path that is fine over there, or a different folder that
		// happens to exist here under the same name.
		const target = await canonicalise(runtimeById(machine), path);
		if (target.isDirectory) {
			if (position) {
				throw new Error(
					`${target.path} is a folder, and a line and column belong to a file.`,
				);
			}
			// A folder has no editor to close, and DevHub has one window rather
			// than one per folder, so there is nothing here that `--wait` could
			// wait for. Saying so beats waiting forever on a tab that will
			// never exist.
			if (waitMarkerPath) {
				throw new Error(
					`${target.path} is a folder, and --wait waits for an editor to be closed.`,
				);
			}
			await this.openFolder(
				requestedLocation(
					machine === "local"
						? { kind: "local", path: target.path }
						: {
								kind: "ssh",
								host: machine.slice("ssh:".length),
								path: target.path,
							},
				),
			);
			this.bringToFront();
			return `${target.path} is open in DevHub.`;
		}

		// The rule itself is `routeOpen`, and it is the only thing that decides
		// this. `openRouted` is the carrying out of its answer.
		const destination = routeOpen(
			target.path,
			machine,
			this.routableWorkspaces(),
			request.origin,
		);
		return this.openRouted(
			destination,
			machine,
			target,
			position,
			waitMarkerPath,
			before,
		);
	}

	/**
	 * A file link in a GUI Agent's conversation, clicked: the file, on the
	 * Agent's machine, opened where `routeAgentOpen` says — the Workspace
	 * that contains it, else beside the Agent in its own — at `selection`.
	 *
	 * A file that has gone since the link was drawn is refused rather than
	 * opened as a new, empty editor the way `devhub <new file>` is: the person
	 * followed a link to something that was there, and an empty editor would
	 * say it still is.
	 */
	async openFromConversation(
		agentId: AgentId,
		path: string,
		selection: FileSelection | undefined,
	): Promise<void> {
		// A click on a link is the person starting an action: it retires the
		// failure on screen, and the memory of one they dismissed, so one
		// failed open cannot hold the notice up — or keep the next failure
		// quiet — after the opens that follow it.
		this.personStartedAction();
		const machine = this.agentMachine(agentId);
		const workspace = this.coordinator.model.workspaceForAgent(agentId);
		if (!workspace) throw new Error(`no Agent ${agentId} is open`);
		const runtime = runtimeById(machine);
		const target = await canonicalise(runtime, path);
		if (!target.exists) {
			throw fileNotFound(path, `It is no longer there${runtime.where}.`);
		}
		if (target.isDirectory) {
			throw fileNotFound(
				target.path,
				`${target.path} is a folder, not a file to open.`,
			);
		}
		const destination = routeAgentOpen(
			target.path,
			machine,
			this.routableWorkspaces(),
			{ workspaceId: workspace.id, agentId },
		);
		await this.openRouted(
			destination,
			machine,
			target,
			selection,
			undefined,
			this.coordinator.model.selection,
		);
	}

	/**
	 * Where an Agent's CLI reads its settings: its machine, its profile and
	 * its Workspace's root.
	 */
	private cliAgentPlace(agentId: AgentId): {
		readonly runtime: Runtime;
		readonly profile: AgentProfile;
		readonly root: string;
	} {
		const agent = this.coordinator.model.agent(agentId);
		const workspace = this.coordinator.model.workspaceForAgent(agentId);
		if (agent === undefined || workspace === undefined)
			throw new Error(`no Agent ${agentId} is open`);
		return {
			runtime: runtimeById(this.agentMachine(agentId)),
			profile: agent.profile,
			root: workspace.root,
		};
	}

	/**
	 * Carry an Agent on in the other presentation, resuming `session`. A
	 * continue of an Agent that is not idle is a question first
	 * (`Coordinator.askAbout`), and whatever asked cannot draw it: it goes to
	 * the one sheet a stop's question goes to.
	 */
	private async continueAgentIn(
		agentId: AgentId,
		presentation: AgentPresentation,
		session: string | undefined,
	): Promise<void> {
		this.raiseCloseConfirmation(
			outcomeWire(
				await this.dispatchSettled({
					type: "continue_agent",
					agentId,
					presentation,
					session,
				}),
				this.coordinator.readiness,
				this.repositoryOf,
				this.homeOf,
			),
			agentId,
		);
	}

	/**
	 * The Sidebar row menu's Continue in Terminal / Continue in GUI: the same
	 * act as the Agent pane's corner control used to be, in whichever direction
	 * leaves the Agent's own presentation (the session is found the way
	 * `conversationIpc` finds it).
	 */
	async continueAgentElsewhere(agentId: AgentId): Promise<void> {
		const wiring = this.agentWiring;
		const agent = this.coordinator.model.agent(agentId);
		if (wiring === undefined || agent === undefined)
			throw new Error(`no Agent ${agentId} is open`);
		if (agent.presentation === "gui") {
			await this.continueAgentIn(
				agentId,
				"tui",
				await wiring.conversations.session(agentId),
			);
		} else {
			await this.continueAgentIn(
				agentId,
				"gui",
				await wiring.terminalSession(agentId),
			);
		}
	}

	/** The machine an Agent runs on, which is its Workspace's. */
	private agentMachine(agentId: AgentId): RuntimeId {
		const machine = this.machineOfAgent(agentId);
		if (machine === undefined) throw new Error(`no Agent ${agentId} is open`);
		return machine;
	}

	/**
	 * Carry out where an open was routed: select what it lands in — beside
	 * the Agent that asked, when it was one — and hand the file to that
	 * Workspace's workbench. The sentence it answers with says where, and
	 * why.
	 */
	private async openRouted(
		destination: OpenDestination,
		machine: RuntimeId,
		target: ResolvedPath,
		position: FileSelection | undefined,
		waitMarkerPath: string | undefined,
		before: NavigationSelection,
		reason?: "explicit",
	): Promise<string> {
		if (destination.kind === "scratch") {
			// Selecting Scratch is what puts its editor on screen.
			await this.dispatchAwaiting({ type: "new_window" });
			await this.openInEditor(
				this.scratchWorkspace(),
				target,
				position,
				waitMarkerPath,
			);
			this.rememberWaitReturn(waitMarkerPath, before);
			this.bringToFront();
			return `${target.path}${at(position)} is open in Scratch (${this.scratchWorkspace().root}): ${because(destination.reason)}`;
		}

		const root = destination.workspace.root;
		// The Workspace's own machine, not the request's. They are the same for
		// the containing rule and can differ for the origin one — a pane on a
		// host naming its window is the case — and the window addressed has to
		// be the one the rule actually chose.
		const workspace = this.workspaceAt(
			root,
			runtimeMachine(destination.workspace.machine),
		);
		// An Agent's pane gets the split, and the split is made the way a person
		// makes one: the Agent is selected `beside`, which is what pairs it with
		// the Workspace, and then the editor half is what is in front — because
		// the editor is what this open is handing the person to type in. Two
		// ordinary selections, and no second notion of "arrangement" for the
		// layout to be reconciled with; see `model/appModel.ts`.
		const besideAgent =
			destination.reason === "origin-agent"
				? this.runningAgent(destination.agentId)
				: undefined;
		if (besideAgent) {
			await this.dispatchAwaiting({
				type: "select_context",
				context: { kind: "agent", agentId: besideAgent.id },
				presentation: "beside",
			});
		}
		await this.dispatchAwaiting({
			type: "select_context",
			context: { kind: "workspace", workspaceId: workspace.id },
			presentation: besideAgent ? "beside" : "full",
			...(reason === undefined ? {} : { reason }),
		});
		await this.openInEditor(workspace, target, position, waitMarkerPath);
		this.rememberWaitReturn(waitMarkerPath, before);
		this.bringToFront();
		// Named rather than left implicit: a split the person did not ask for by
		// hand is a rearrangement of their window, and the terminal that caused
		// it is the one place they will see why it happened.
		const beside = besideAgent
			? `, beside the Agent ${besideAgent.displayName}`
			: "";
		return `${target.path}${at(position)} is open in the workspace at ${root}${beside}: ${because(destination.reason)}`;
	}

	/**
	 * Hand a file to the Workspace's editor, its Neovim: `:drop`ped there over
	 * RPC (started first if it is not running).
	 */
	private async openInEditor(
		workspace: Workspace,
		target: ResolvedPath,
		position: FileSelection | undefined,
		waitMarkerPath: string | undefined,
	): Promise<void> {
		const editors = this.neovimEditors;
		if (!editors) throw new Error("DevHub's Neovim editor is not running yet.");
		await editors.open(
			this.neovimTarget(workspace.id),
			neovimOpenOf(target, position, waitMarkerPath),
		);
		// Its `devhub-nvim` window is the one the terminal shows now: the keys
		// go to the Neovim drawn over it, whoever had them.
		this.terminalNeovims?.reclaim(workspaceTerminalPageId(workspace.id));
		shellWindow().focusSurface();
	}

	/**
	 * Record where a `--wait` open came from, and where it landed.
	 *
	 * Only for `--wait`: an open without one is not a modal session, and a
	 * person who ran plain `devhub <file>` asked to be where the file is and to
	 * stay there. The landing selection is read here, after the open, because
	 * it is what the pop is checked against — see `waitReturn.ts`.
	 */
	private rememberWaitReturn(
		waitMarkerPath: string | undefined,
		before: NavigationSelection,
	): void {
		if (waitMarkerPath === undefined) return;
		this.waitReturns.push(
			waitMarkerPath,
			before,
			this.coordinator.model.selection,
		);
	}

	/**
	 * The CLI says a `--wait` is over: go back to where its open came from.
	 *
	 * The rules are in `waitReturn.ts`; what is left here is the one thing the
	 * model has to answer — whether the workspace or Agent being returned to
	 * still exists. When it does not, nothing is restored, because the model
	 * already moved the selection by its own rule when the thing went away.
	 *
	 * Restoring is the same select-and-reveal an open does, so the keyboard
	 * lands where it lands for every other selection change (`reveal` ->
	 * `focusSurface`). DevHub is deliberately *not* brought to the front: the
	 * editor was closed by somebody already looking at it.
	 */
	async waitEndedFromCli(waitMarkerPath: string): Promise<string> {
		const back = this.waitReturns.take(
			waitMarkerPath,
			this.coordinator.model.selection,
		);
		if (back === undefined) {
			return "The wait is over; DevHub stayed where it was.";
		}
		if (!this.contextStillExists(back)) {
			return "The wait is over; what was selected before it is gone.";
		}
		await this.dispatchAwaiting({
			type: "select_context",
			context: back.context,
			presentation: back.presentation,
		});
		return "The wait is over; DevHub is back where it was.";
	}

	private contextStillExists(selection: NavigationSelection): boolean {
		const context = selection.context;
		if (context.kind === "workspace") {
			return (
				this.coordinator.model.workspaces.some(
					(workspace) => workspace.id === context.workspaceId,
				) === true
			);
		}
		if (context.kind === "agent") {
			return this.coordinator.model.agent(context.agentId) !== undefined;
		}
		return true;
	}

	/**
	 * `devhub --version`.
	 *
	 * Two facts, one per line. They come from the running app rather than
	 * from the launcher, because a version read anywhere else is the version
	 * of something else. A source checkout has no commit and says so instead
	 * of printing a blank line.
	 */
	versionFromCli(): Promise<string> {
		const { version, commit } = devhubProduct();
		return Promise.resolve(
			[
				`DevHub ${version ?? electron.app.getVersion()}`,
				commit ?? "no commit: this DevHub was built from a source checkout",
			].join("\n"),
		);
	}

	/**
	 * DevHub's own pages in the shell window, by name, with whether each is
	 * drawn: what `--metrics` and the Task Manager name renderers by.
	 */
	private chromePages(): readonly {
		readonly contents: Electron.WebContents;
		readonly name: string;
		readonly present: boolean;
	}[] {
		const shell = shellWindow();
		return [
			{
				contents: shell.window.webContents,
				name: "shell",
				present: true,
			},
			{
				contents: shell.sidebar.contents(),
				name: "sidebar",
				present: shell.sidebar.isVisible(),
			},
			{
				contents: shell.agents.contents(),
				name: "agents",
				present: shell.agents.isVisible(),
			},
			{
				contents: shell.conversations.contents(),
				name: "conversations",
				present: shell.conversations.isVisible(),
			},
			{
				contents: shell.toasts.contents(),
				name: "toasts",
				present: shell.toasts.isPresent(),
			},
			{
				contents: shell.picker.contents(),
				name: "picker",
				present: shell.picker.isPresent(),
			},
		].filter(
			(
				page,
			): page is {
				contents: Electron.WebContents;
				name: string;
				present: boolean;
			} => page.contents !== undefined,
		);
	}

	/**
	 * `devhub --metrics`.
	 *
	 * The reading is taken here because this is the only object that has both
	 * halves of it: Electron's per-process CPU, which names a workbench
	 * renderer nothing but "renderer", and the model's idea of which workspace
	 * each view is showing. A reading assembled anywhere else would have to
	 * guess at one of the two.
	 *
	 * It reports; it changes nothing and it resets nothing. Two readings a
	 * known time apart are a rate, and that stays true however many people
	 * take one.
	 */
	async metricsFromCli(): Promise<string> {
		// DevHub's pages, by name. `onScreen` is "drawn": for the two layers that come and go
		// it is presence in the window's child list, because a notice layer
		// standing with nothing on it is a rectangle taking clicks for
		// nothing; for the Sidebar and the Agents it is visibility, because
		// both are always in the list and only one of them is always drawn.
		const views = this.chromePages().map((page) => ({
			pid: page.contents.getOSProcessId(),
			id: page.contents.id,
			surfaceKey: `chrome:${page.name}`,
			onScreen: page.present,
		}));
		const cpu = process.cpuUsage();
		// A terminal DevHub cannot reach has no clients to report, which is a
		// different sentence from "none are attached" only to a reader who has
		// one — and a reading taken before the runtime is up is the first of
		// those. Anything else the runtime says goes up: a socket that will not
		// answer is a fact about DevHub, and `--metrics` is where facts about
		// DevHub are read.
		const wiring = this.terminalsWiring;
		const localTmux = wiring ? await wiring.local() : undefined;
		const terminalClients = localTmux?.adapterAvailable
			? await localTmux.listClientsUnlocked(
					new CancellationToken(),
					OperationDeadline.in(METRICS_CLIENT_TIMEOUT_MS),
				)
			: [];
		return JSON.stringify(
			metricsReport({
				takenAt: Date.now(),
				uptimeMs: Math.round(process.uptime() * 1000),
				titleBar: shellWindow().titleBar,
				mainProcessCpu: {
					userMs: Math.round(cpu.user / 1000),
					systemMs: Math.round(cpu.system / 1000),
				},
				processMetrics: electron.app.getAppMetrics(),
				views,
				counters: activityCounters.read(),
				terminalClients,
				runtimes: liveRuntimes().map((runtime) => runtime.reading()),
				terminalLauncher: [...this.launcherStatus.values()],
				pendingSweeps: this.sessionSweeper?.pending ?? [],
				repositoryRounds: this.repositoryStatus.rounds(),
				notices: this.notices.reading(),
				roundsLastMinute: (id) => reconcileRounds.lastMinute(id),
			}),
			null,
			2,
		);
	}

	/**
	 * `devhub --agent <profile> -- <args>`.
	 *
	 * The Workspace comes from the *current directory*, by the same ancestor
	 * walk a file uses. An Agent runs in a Workspace — it has a root, a
	 * terminal and a lifetime that belong to one — so a directory that is in no
	 * open Workspace is refused rather than quietly attached to something else.
	 */
	async addAgentFromCli(
		profileId: string,
		args: readonly string[],
		cwd: string,
	): Promise<string> {
		// The profile is checked here rather than left to the resolver, because
		// a name that is not in the config is a typo on a command line, not an
		// operation that failed — and the person needs to be told which names
		// there are, not that an operation could not be completed.
		const configured = this.config.agentProfiles;
		if (!configured.some((profile) => profile.id === profileId)) {
			const known = configured.map((profile) => profile.id).join(", ");
			throw new Error(
				`there is no agent profile called '${profileId}'. Configured profiles: ${known.length > 0 ? known : "none"}.`,
			);
		}
		const here = await canonicalise(localRuntime(), cwd);
		// `devhub --agent` is the launcher in this Mac's PATH, so the directory
		// it was run in is a directory here — and a Workspace on a host whose
		// root spells the same thing is a different folder entirely.
		const root = workspaceRootFor(here.path, this.workspaceRoots("local"));
		if (root === undefined) {
			throw new Error(
				`${here.path} is not inside any open DevHub workspace, and an agent needs one — open the folder first with 'devhub <folder>'.`,
			);
		}
		const workspace = this.workspaceAt(root, "local");
		await this.dispatchAwaiting({
			type: "create_agent",
			workspaceId: workspace.id,
			profileId: agentProfileId(profileId),
			extraArgs: args,
			// `devhub agent` has no modifier to hold, so it gets the plain
			// arrangement: the Agent, on its own, which is what the person who
			// typed the command asked to see.
			presentation: "full",
		});
		// Creating an Agent selects it, and the request above already said how it
		// should be shown — so there is nothing left for this to choose.
		this.bringToFront();
		const context = this.coordinator.model.selection.context;
		const agent =
			context.kind === "agent"
				? workspace.agents.find((candidate) => candidate.id === context.agentId)
				: undefined;
		return `${agent?.displayName ?? "The agent"} is running in the workspace at ${root}.`;
	}

	// --- the Orchestrator row (`docs/orchestrator.md`) -------------------------

	/** The board, the escalations and the events, once user data is known. */
	private orchestrator: OrchestratorService | undefined;
	private orchestratorSyncing = false;
	/**
	 * While `startOrchestrator` makes its agent: the workspace, and the agents
	 * there were before, so the new one is launched with the orchestrator's
	 * skill before the row has been assigned to it.
	 */
	private orchestratorStarting:
		| { readonly workspaceId: string; readonly before: ReadonlySet<string> }
		| undefined;
	/**
	 * While `startOrchestrator` runs: the folder it opens, so the Workspace
	 * it opens there is the Orchestrator row's from the start, whatever
	 * `[orchestrator] root` says (`orchestratorRootPath`).
	 */
	private orchestratorStartingRoot: string | undefined;
	private orchestratorRootSyncing = false;
	/** `orchestratorRootPath`'s last answer, by what it was asked about. */
	private orchestratorRootCache:
		| { readonly from: string; readonly path: string }
		| undefined;

	/**
	 * The folder whose open Workspace is the Orchestrator row's while no
	 * orchestrator agent is assigned (`AppModel.orchestratorWorkspaceId`): the
	 * one an orchestrator is being started in, else `[orchestrator] root`,
	 * expanded and with its symlinks resolved as a Workspace's root is.
	 */
	private orchestratorRootPath(): string {
		const from = this.orchestratorStartingRoot ?? this.config.orchestrator.root;
		if (this.orchestratorRootCache?.from !== from) {
			const expanded = expandOrchestratorRoot(from);
			let path = expanded;
			try {
				path = realpathSync(expanded);
			} catch {
				// Not there yet: the window's Start makes it, at this path.
			}
			this.orchestratorRootCache = { from, path };
		}
		return this.orchestratorRootCache.path;
	}

	/** The model's orchestrator root follows `orchestratorRootPath`. */
	private syncOrchestratorRoot(): void {
		if (this.orchestratorRootSyncing) return;
		if (this.coordinator.model.orchestratorRoot === this.orchestratorRootPath())
			return;
		// After the projection that showed the difference, as `syncOrchestrator`.
		this.orchestratorRootSyncing = true;
		queueMicrotask(() => {
			this.orchestratorRootSyncing = false;
			const root = this.orchestratorRootPath();
			if (this.coordinator.model.orchestratorRoot === root) return;
			this.coordinator.dispatchUser({
				intentId: parseIntentId(randomUUID()),
				operationId: this.freshOperationId(),
				intent: { type: "orchestrator_root_resolved", root },
			});
			this.drain();
		});
	}

	/** Whether `agentId` is (or is being started as) the orchestrator agent. */
	private isOrchestratorAgent(agentId: string): boolean {
		return isOrchestratorAgent(agentId, {
			assigned: this.orchestrator?.orchestratorAgentId,
			starting: this.orchestratorStarting,
			agentsIn: (workspaceId) =>
				this.coordinator.model.workspaces
					.find((workspace) => workspace.id === workspaceId)
					?.agents.map((agent) => agent.id) ?? [],
		});
	}

	/**
	 * The folder the Files tab shows: the running orchestrator's Workspace,
	 * else `[orchestrator] root` — the folder it would start in.
	 */
	private orchestratorFilesRoot(): string | undefined {
		const agentId = this.orchestrator?.orchestratorAgentId;
		const workspace =
			agentId === undefined
				? undefined
				: this.coordinator.model.workspaceForAgent(parseAgentId(agentId));
		if (workspace !== undefined && workspace.location.kind === "local")
			return workspace.root;
		const root = this.config.orchestrator.root;
		return root === undefined ? undefined : expandOrchestratorRoot(root);
	}

	private requireOrchestratorFilesRoot(): string {
		const root = this.orchestratorFilesRoot();
		if (root === undefined)
			throw new OrchestratorFileError("No orchestrator folder is set.");
		return root;
	}

	/**
	 * What an escalation's relative paths are relative to: its workspace,
	 * else its first agent's, else the orchestrator's folder.
	 */
	private escalationBase(
		workspaceId: string | undefined,
		agents: readonly string[],
	): string | undefined {
		const model = this.coordinator.model;
		const named =
			workspaceId === undefined
				? undefined
				: model.workspaces.find((one) => one.id === workspaceId);
		const first = agents[0];
		const ofAgent =
			first === undefined
				? undefined
				: model.workspaceForAgent(parseAgentId(first));
		const workspace = [named, ofAgent].find(
			(one) => one !== undefined && one.location.kind === "local",
		);
		return workspace?.root ?? this.orchestratorFilesRoot();
	}

	/**
	 * The body with the local images it names copied into the escalation's
	 * own folder and pointed at (`orchestrator/escalationFiles.ts`), from
	 * the open Workspaces or the orchestrator's folder only.
	 */
	private withEscalationFiles(
		markdown: string,
		id: number,
		workspaceId: string | undefined,
		agents: readonly string[],
	): string {
		if (this.userDataPath === undefined) return markdown;
		const roots = this.coordinator.model.workspaces
			.filter((one) => one.location.kind === "local")
			.map((one) => one.root as string);
		const orchestratorRoot = this.orchestratorFilesRoot();
		return importEscalationFiles(markdown, {
			storeRoot: join(this.userDataPath, "devhub", "escalations"),
			id,
			baseDir: this.escalationBase(workspaceId, agents),
			allowedRoots:
				orchestratorRoot === undefined ? roots : [...roots, orchestratorRoot],
		}).markdown;
	}

	/** The watch on the Files tab's folder: one, on the root last listed. */
	private orchestratorFilesWatch:
		| { readonly root: string; readonly stop: () => void }
		| undefined;

	private watchOrchestratorFiles(root: string): void {
		if (this.orchestratorFilesWatch?.root === root) return;
		this.orchestratorFilesWatch?.stop();
		this.orchestratorFilesWatch = {
			root,
			stop: watchRoot(root, (paths) => {
				this.send(CHANNELS.orchestratorFilesChanged, paths);
			}),
		};
	}

	/**
	 * "エディタで開く": the file opened the way \`devhub <file>\` opens it — in
	 * the Workspace that contains it (the root's own row), its workbench woken
	 * as usual and switched to. The person asked for it, so the Workspace is a
	 * place in Back and Forward at once (\`NavigationReason\`).
	 */
	/**
	 * A `devhub:file` link, clicked (`model/devhubLink.ts`): the file, on the
	 * machine of the Workspace the page found holding it, opened in that
	 * Workspace's workbench the way \`devhub <file>\` opens one — an explicit
	 * move, so the Workspace is a place in Back and Forward at once. The
	 * Workspace must hold it: a link cannot open a file anywhere else.
	 */
	private async openLinkedFile(
		workspaceId: unknown,
		path: unknown,
		range: unknown,
	): Promise<void> {
		this.personStartedAction();
		if (typeof path !== "string" || !path.startsWith("/"))
			throw new Error(`${JSON.stringify(path)} is not a file to open`);
		const workspace = this.coordinator.model.workspaces.find(
			(one) => one.id === workspaceId,
		);
		if (workspace === undefined)
			throw new Error("the workspace that holds this file is no longer open");
		const machine = runtimeIdFor(workspace.location);
		const target = await canonicalise(runtimeById(machine), path);
		if (!target.exists)
			throw fileNotFound(path, `It is not there${runtimeById(machine).where}.`);
		if (target.isDirectory)
			throw fileNotFound(
				target.path,
				`${target.path} is a folder, not a file to open.`,
			);
		const routable = this.routableWorkspaces().find(
			(one) => one.workspaceId === workspace.id,
		);
		if (
			routable === undefined ||
			workspaceRootFor(target.path, [routable.root]) === undefined
		)
			throw new Error(`${target.path} is not in ${workspace.root}`);
		await this.openRouted(
			{ kind: "workspace", workspace: routable, reason: "containing" },
			machine,
			target,
			fileSelection(range),
			undefined,
			this.coordinator.model.selection,
			"explicit",
		);
	}

	/**
	 * The open Agent whose CLI is running `session` (its id, or a unique
	 * prefix of 4+ characters), if one is: what a `devhub:session` link shows.
	 */
	private async agentRunningSession(
		session: string,
	): Promise<string | undefined> {
		const agents = this.coordinator.model.workspaces.flatMap(
			(workspace) => workspace.agents,
		);
		const running = await Promise.all(
			agents.map(async (agent) => ({
				id: agent.id,
				session: await this.sessionAtClose(agent.id),
			})),
		);
		const exact = running.find((one) => one.session === session);
		if (exact !== undefined) return exact.id;
		if (session.length < 4) return undefined;
		const prefixed = running.filter((one) => one.session?.startsWith(session));
		return prefixed.length === 1 ? prefixed[0]!.id : undefined;
	}

	private async openOrchestratorFile(path: unknown): Promise<void> {
		this.personStartedAction();
		const root = this.requireOrchestratorFilesRoot();
		const absolute = await insideRoot(root, path);
		const machine = runtimeMachine("local");
		const target = await canonicalise(runtimeById(machine), absolute);
		if (!target.exists || target.isDirectory)
			throw fileNotFound(absolute, `${absolute} is not a file to open.`);
		let destination = routeOpen(
			target.path,
			machine,
			this.routableWorkspaces(),
		);
		// The folder is not open (no orchestrator has run, or its Workspace
		// was never opened): open it, unselected, as the Orchestrator row's
		// Workspace, and open the file there rather than in Scratch.
		if (destination.kind === "scratch") {
			await this.openFolderUnfocused(
				requestedLocation({ kind: "local", path: root }),
			);
			destination = routeOpen(target.path, machine, this.routableWorkspaces());
		}
		await this.openRouted(
			destination,
			machine,
			target,
			undefined,
			undefined,
			this.coordinator.model.selection,
			"explicit",
		);
	}

	private startOrchestratorService(userDataPath: string): void {
		const { store, refused } = EscalationStore.load(
			join(userDataPath, "devhub", "escalations.json"),
		);
		if (refused !== undefined) {
			console.error(`[devhub] ${refused}`);
			this.publishError(errorWire(new Error(refused)));
		}
		// `agent keep`'s keepings, across restarts.
		const kept = new KeptFile(
			join(userDataPath, "devhub", "orchestrator-kept.json"),
			undefined,
			(line) => console.error(line),
		);
		this.orchestrator = new OrchestratorService({
			store,
			kept,
			agents: () => this.liveAgents(),
			settings: () => this.config.orchestrator,
			startProblem: () => this.orchestratorStartProblem(),
			usageWindow: (cli, window) =>
				usageWindowOf(this.usageLimits.wire(), cli, window),
			deliver: (agentId, text) => {
				const queued = agents()?.queueInjection(
					parseAgentId(agentId),
					text,
					false,
				);
				if (queued === undefined)
					console.error(
						"[devhub] an orchestrator event could not be queued: the agents are not running yet",
					);
			},
			// In a foreground turn, or still holding something of ours: a batch
			// waits, and goes out once it can take it. Its own background work
			// (shells, tasks, subagents: `background`) holds nothing — the
			// router is never blocked by the subagents it started — and the
			// person's words never wait for this at all.
			busy: (agentId) => {
				const agent = this.coordinator
					.snapshot()
					.workspaces.flatMap((workspace) => workspace.agents)
					.find((one) => one.id === agentId);
				return (
					agent !== undefined &&
					(agent.status === "working" || agent.injection.queued > 0)
				);
			},
			invariant: () => ({
				items: this.githubItems.items(),
				agents: this.invariantAgents(),
			}),
			publish: (board) => {
				this.send(CHANNELS.orchestratorBoardChanged, board);
				// The escalation being read may have been retitled.
				this.refreshWindowTitle();
			},
			// A paused orchestrator costs no GitHub quota: polling is suspended.
			// A resume polls at once, and delivers without waiting for it.
			paused: (paused) => {
				this.followGitHub(paused);
			},
			github: () => {
				const state = this.githubItems.state();
				const boards = state.projects;
				return {
					state: state.mode,
					...(state.lastAt === undefined ? {} : { lastAt: state.lastAt }),
					...(state.lastOutcome === undefined
						? {}
						: { lastOutcome: state.lastOutcome }),
					...(state.nextAt === undefined || state.mode !== "active"
						? {}
						: { nextAt: state.nextAt }),
					...(state.rateLimit === undefined
						? {}
						: {
								rateLimit: {
									remaining: state.rateLimit.remaining,
									limit: state.rateLimit.limit,
									resetAt: state.rateLimit.resetAt,
								},
							}),
					...(state.assigned === undefined ? {} : { assigned: state.assigned }),
					...(boards.length === 0 ? {} : { boards }),
					...(state.problem === undefined ? {} : { problem: state.problem }),
					...(state.problemAt === undefined
						? {}
						: { problemAt: state.problemAt }),
					...(state.reading === undefined ? {} : { reading: state.reading }),
				};
			},
			setTimer: (ms, run) => {
				const timer = setTimeout(run, ms);
				return { cancel: () => clearTimeout(timer) };
			},
			log: (line) => console.log(line),
			// `escalation.human_direct`: the person's last message, its `since=`
			// and its words.
			personMessage: async (agentId) => {
				const conversation = await this.tellPorts().conversation(agentId);
				const last = conversation
					?.entries()
					.findLast((one) => one.kind === "user" && one.origin === "person");
				return last?.kind === "user"
					? { since: last.id, text: last.text }
					: undefined;
			},
			// An answer delivered in its event is read: `agent wait --any`
			// (the orchestrator's `TellMemory`) stops reporting it.
			acknowledged: (agentId, id, entries) => {
				const reader = callerKey({
					machine: "",
					agentId,
					workspaceId: undefined,
				});
				this.tellMemory.markEscalation(
					reader,
					id,
					Math.max(this.tellMemory.escalationSeen(reader, id) ?? 0, entries),
				);
			},
		});
		if (kept.refused !== undefined) {
			console.error(`[devhub] ${kept.refused}`);
			this.publishError(errorWire(new Error(kept.refused)));
		}
		this.syncOrchestrator();
	}

	private requireOrchestrator(): OrchestratorService {
		if (this.orchestrator === undefined)
			throw new Error("DevHub has not finished starting.");
		return this.orchestrator;
	}

	/** Every agent, as the board reads it. */
	private liveAgents(): readonly LiveAgent[] {
		const snapshot = this.coordinator.snapshot();
		return snapshot.workspaces.flatMap((workspace) =>
			workspace.agents.map((agent) => ({
				id: agent.id,
				name: agent.displayName,
				workspaceId: workspace.id,
				workspaceLabel: this.coordinator.model.workspace(workspace.id)
					? workspace.id === snapshot.scratchWorkspaceId
						? "Scratch"
						: workspace.label
					: workspace.label,
				status: agent.status,
				stopping: agent.controlState.kind !== "running",
				...(agent.maintenance === true ? { maintenance: true } : {}),
			})),
		);
	}

	/**
	 * The model's Orchestrator row follows the store: the agent it names, while
	 * that agent is there. An orchestrator that has gone (stopped, exited) is
	 * released, so the row offers to start one again.
	 */
	private syncOrchestrator(): void {
		const service = this.orchestrator;
		if (service === undefined) return;
		this.syncOrchestratorRoot();
		const model = this.coordinator.model;
		const stored = service.orchestratorAgentId;
		const wanted = stored === undefined ? undefined : parseAgentId(stored);
		if (model.orchestratorAgentId !== wanted && !this.orchestratorSyncing) {
			// After the projection that showed the difference has gone out:
			// this runs inside one, and a dispatch from here would re-enter it.
			this.orchestratorSyncing = true;
			queueMicrotask(() => {
				this.orchestratorSyncing = false;
				const now = service.orchestratorAgentId;
				const agentId = now === undefined ? undefined : parseAgentId(now);
				if (this.coordinator.model.orchestratorAgentId === agentId) return;
				if (now === undefined && stored !== undefined) service.release();
				this.coordinator.dispatchUser({
					intentId: parseIntentId(randomUUID()),
					operationId: this.freshOperationId(),
					intent: {
						type: "orchestrator_assigned",
						...(agentId === undefined ? {} : { agentId }),
					},
				});
				this.drain();
			});
		}
		service.observe();
		this.observeLiveEvents();
	}

	/**
	 * The items the invariant is read off — every open Issue or pull request
	 * assigned to the viewer, and the ones agents are linked to — polled
	 * while an orchestrator runs. Shares the Workspace watcher's token and
	 * client.
	 */
	private readonly githubItems = new GitHubItemSource({
		settings: () => this.config.orchestrator.github,
		// Read by URL when the search does not give them: why such an agent's
		// item is outside the population.
		linked: () =>
			this.invariantAgents().flatMap((agent) =>
				agent.managed && agent.issue !== undefined ? [agent.issue] : [],
			),
		token: async () => {
			const credentials = await readGitHubToken(this.launchEnvironment);
			return credentials.kind === "token"
				? { token: credentials.token }
				: {
						problem:
							credentials.kind === "unrunnable"
								? `DevHub could not run \`gh\` for GitHub credentials: ${credentials.reason}.`
								: "DevHub has no GitHub credentials. Run `gh auth login`.",
					};
		},
		post: postGraphQl,
		// What the invariant reads may have moved.
		polled: () => this.orchestrator?.observe(),
		changed: () => this.orchestrator?.publish(),
		setTimer: (ms, run) => {
			const timer = setTimeout(run, ms);
			return { cancel: () => clearTimeout(timer) };
		},
		log: (line) => console.log(line),
	});

	/**
	 * GitHub polling follows the orchestrator: active while one runs,
	 * suspended while its events are paused, idle (forgotten) without one.
	 */
	private followGitHub(
		paused = this.orchestrator?.events.paused ?? false,
	): void {
		this.githubItems.follow(
			this.orchestrator?.orchestratorAgentId !== undefined,
			paused,
		);
	}

	/**
	 * Every agent as the invariant reads it (`invariant.ts`): managed or not,
	 * its status, the Issue its meta `issue=` links it to, and its
	 * Workspace's pull request as the Sidebar has it.
	 */
	private invariantAgents(): readonly InvariantAgent[] {
		const snapshot = this.coordinator.snapshot();
		return snapshot.workspaces.flatMap((workspace) => {
			const row = this.lastRepositoryStatus.workspaces.find(
				(one) => one.workspaceId === workspace.id,
			);
			const pr = row?.pullRequest;
			const pull: PullFacts | undefined =
				pr === undefined
					? undefined
					: {
							number: pr.number,
							url: pr.url,
							state: pr.state,
							review: pr.review ?? "none",
							unresolved: pr.conversations.unresolved,
							checks: pr.checks?.state ?? "none",
						};
			const ws =
				workspace.id === snapshot.scratchWorkspaceId
					? "scratch"
					: workspaceToken(workspace.label, workspace.id);
			return workspace.agents.map((agent) => ({
				id: agent.id,
				name: agent.displayName,
				ws,
				workspaceId: workspace.id,
				workspaceLabel: workspace.label,
				managed: agent.managed === true,
				// A maintenance turn is read at the status before it (the service).
				status: agent.status,
				stopping: agent.controlState.kind !== "running",
				// `issue=pending` is no URL: no item to read or link, yet.
				...issueLinkOf(agent.meta?.[ISSUE_LINK_KEY]),
				...(pull === undefined ? {} : { pull }),
			}));
		});
	}

	/** GitHub polling follows the orchestrator, read off every projection. */
	private observeLiveEvents(): void {
		this.followGitHub();
	}

	/** Why the window's Start cannot start one now; undefined when it can. */
	private orchestratorStartProblem(): string | undefined {
		const settings = this.config.orchestrator;
		const profiles = this.agentProfiles().profiles;
		if (profiles.length === 0) return "There is no agent profile to start.";
		if (
			settings.profile !== undefined &&
			!profiles.some((profile) => profile.id === settings.profile)
		)
			return `orchestrator.profile names '${settings.profile}', which is not an agent profile.`;
		return undefined;
	}

	/** The Start button: `[orchestrator]` with the window's defaults under it. */
	private async startOrchestratorFromWindow(): Promise<void> {
		const problem = this.orchestratorStartProblem();
		if (problem !== undefined) throw new Error(problem);
		const settings = this.config.orchestrator;
		const profiles = this.agentProfiles().profiles;
		const profile =
			profiles.find((one) => one.id === settings.profile) ?? profiles[0]!;
		await this.startOrchestrator({
			root: settings.root,
			profile: profile.id,
			presentation: settings.presentation ?? profile.presentation,
			prompt: undefined,
			// The window's Start makes the folder (the default ~/orchestrator
			// included); a command line's --root has to exist already.
			createRoot: true,
		});
	}

	/**
	 * Start the orchestrator: `root` opened as a Workspace (in the Sidebar,
	 * nothing selected), an agent of `profile` started in it unfocused, marked
	 * `role=orchestrator`, assigned to the row, and told it has started
	 * (`init`, or `prompt` when one is given). Refused while one is running.
	 */
	private async startOrchestrator(request: {
		readonly root: string;
		readonly profile: string;
		readonly presentation: "gui" | "tui";
		readonly prompt: string | undefined;
		readonly createRoot?: boolean;
	}): Promise<string> {
		const service = this.requireOrchestrator();
		const running = service.orchestratorAgentId;
		if (running !== undefined)
			throw new Error(
				`an orchestrator is already running (${running}). Stop it first: devhub --tell orchestrator stop.`,
			);
		const root = ensureOrchestratorRoot(request.root, {
			create: request.createRoot === true,
		});
		// The Workspace opened there is the Orchestrator row's, never an
		// ordinary row, even before its agent is assigned: the model is told
		// the folder first, the window's Start having just made it.
		this.orchestratorStartingRoot = root;
		this.orchestratorRootCache = undefined;
		this.syncOrchestratorRoot();
		const ports = this.tellPorts();
		try {
			const workspaceId = await this.openFolderUnfocused(
				requestedLocation({ kind: "local", path: root }),
			);
			this.orchestratorStarting = {
				workspaceId,
				before: this.modelAgentIds(),
			};
			const agentId = await ports.createAgent(
				workspaceId,
				request.profile,
				request.presentation,
			);
			await ports.setAgentMeta(agentId, "role", "orchestrator");
			service.assign(agentId, request.prompt);
			this.syncOrchestrator();
			return agentId;
		} finally {
			this.orchestratorStarting = undefined;
			this.orchestratorStartingRoot = undefined;
			this.orchestratorRootCache = undefined;
		}
	}

	/**
	 * `devhub --tell`: see `cli/tell/service.ts`. Every port below is a call the
	 * window itself makes, so an operation asked for on a command line is the
	 * operation a click would have been.
	 */
	tellFromCli(
		command: TellCommand,
		origin: string | undefined,
		machine?: string | undefined,
		as?: string | undefined,
	): Promise<TellAnswer> {
		const service = new TellService(
			this.tellPorts(),
			undefined,
			this.tellMemory,
		);
		return Promise.resolve().then(() =>
			service.run(command, tellCaller(origin, machine, as)),
		);
	}

	/** What `--tell` keeps between calls: who has read what, since when. */
	private readonly tellMemory = new TellMemory();

	private tellPorts(): TellPorts {
		const newAgent = (before: ReadonlySet<string>): string | undefined =>
			this.coordinator.model.workspaces
				.flatMap((workspace) => workspace.agents)
				.find((agent) => !before.has(agent.id))?.id;
		const orchestrator = () => this.requireOrchestrator();
		return {
			workspaces: () => this.tellWorkspaces(),
			// No answer here, on purpose: the person answers in the window
			// (`CHANNELS.answerEscalation`), and only there.
			orchestrator: {
				board: () => orchestrator().wire(),
				standing: (agentId) => orchestrator().standing(agentId),
				status: (target) => orchestrator().status(target),
				keep: (agentId, note) => orchestrator().keep(agentId, note),
				unkeep: (agentId) => orchestrator().unkeep(agentId),
				escalations: () => orchestrator().allWires(),
				acknowledge: (id, entries) => {
					orchestrator().acknowledge(id, entries);
				},
				raise: (request) =>
					orchestrator().toWire(
						orchestrator().raise({
							title: request.title,
							markdown: this.withEscalationFiles(
								request.markdown,
								orchestrator().nextEscalationId(),
								request.workspaceId,
								request.agents,
							),
							options: request.options,
							agents: request.agents,
							links: request.links,
							...(request.workspaceId === undefined
								? {}
								: { workspaceId: request.workspaceId }),
							rank: request.rank,
							...(request.wait === undefined ? {} : { wait: request.wait }),
						}),
					),
				ask: (id, markdown, options, links) => {
					const one = orchestrator()
						.allWires()
						.find((escalation) => escalation.id === id);
					return orchestrator().toWire(
						orchestrator().ask(
							id,
							one === undefined
								? markdown
								: this.withEscalationFiles(
										markdown,
										id,
										one.workspaceId,
										one.agents.map((agent) => agent.agentId),
									),
							options,
							...(links === undefined ? [] : [links]),
						),
					);
				},
				close: (id, note) =>
					orchestrator().toWire(orchestrator().close(id, note)),
				hold: (id, note) =>
					orchestrator().toWire(orchestrator().hold(id, note)),
				wait: (id, trigger, dueAt) =>
					orchestrator().toWire(
						orchestrator().wait(id, {
							trigger,
							...(dueAt === undefined ? {} : { dueAt }),
						}),
					),
				resumeWait: (id, note) =>
					orchestrator().toWire(orchestrator().resume(id, note)),
				link: (id, more) =>
					orchestrator().toWire(orchestrator().link(id, more)),
				rank: (id, rank) =>
					orchestrator().toWire(orchestrator().rank(id, rank)),
				configuredRoot: () => this.config.orchestrator.root,
				start: (request) => this.startOrchestrator(request),
				pause: () => {
					orchestrator().events.pause();
				},
				resume: () => orchestrator().events.resume(),
				events: (last) => orchestrator().eventLog(last),
				emit: (type, text) => orchestrator().emit(type, text),
				timers: () => orchestrator().timers.list(),
				setTimer: (name, interval) => orchestrator().timers.set(name, interval),
				clearTimer: (name) => orchestrator().timers.clear(name),
				// `focus orchestrator`: the one command here that takes the window.
				focus: async () => {
					await this.dispatchAwaiting(
						intentFromWire({
							type: "select_context",
							context: { kind: "orchestrator" },
							reason: "explicit",
						}),
					);
					this.bringToFront();
				},
			},
			// What `writeAgentSkill` wrote for this run, word for word.
			skill: () => {
				if (this.userDataPath === undefined)
					throw new Error("DevHub has not finished starting.");
				return devhubSkillAnswer(this.userDataPath);
			},
			// What `writeOrchestratorSkill` wrote, for `skill --orchestrator`.
			orchestratorSkill: () => {
				if (this.userDataPath === undefined)
					throw new Error("DevHub has not finished starting.");
				return orchestratorSkillAnswer(this.userDataPath);
			},
			// The agent picker's own list (`agentProfiles`), so a row there and a
			// line here cannot disagree about a profile's default mode.
			profiles: () =>
				this.agentProfiles().profiles.map((profile) => ({
					id: profile.id,
					name: profile.displayName,
					kind: profile.kind,
					presentation: profile.presentation,
					presentations: [...profile.presentations],
				})),
			profileProblem: async (profileId, workspaceId) => {
				const location =
					workspaceId === undefined
						? workspaceLocation({ kind: "local", path: homedir() })
						: this.cliWorkspace(workspaceId).location;
				const resolved = await this.profileOn(
					location,
					profileId,
					[],
					undefined,
				);
				return resolved.kind === "failed" ? resolved.detail : undefined;
			},
			// The rows of Assign Issue's first question, in its order.
			issueActions: () =>
				this.config.agentActions
					.filter((action) => action.enabled && action.trigger === "issue")
					.map((action) => ({
						id: action.id,
						label: action.display_name,
						template: action.template,
					})),
			openWorkspace: async (path, machine, worktree) => {
				const place: WorkspacePlaceWire = machine.startsWith("ssh:")
					? { kind: "ssh", host: machine.slice("ssh:".length), path }
					: { kind: "local", path };
				let target = place;
				if (worktree !== undefined) {
					// A branch that names an Issue is that Issue's work, in its
					// folder; one that names none is work with no Issue yet (the
					// investigation an Issue is written from), in a folder named for
					// the branch — the picker's New Branch row, made the same way.
					const number = issueNumberFromBranch(worktree);
					target = {
						...place,
						path: await ensureWorktree(
							await this.gitCommand(runtimeFor(workspaceLocation(place))),
							place.path,
							number === undefined
								? { kind: "branch", create: true }
								: { kind: "issue", number },
							worktree,
						),
					};
				}
				// An Agent asking (`devhub --tell workspace open`), not a person: in
				// the Sidebar, and nothing selected, shown or focused.
				return this.openFolderUnfocused(requestedLocation(target));
			},
			createAgent: async (workspaceId, profileId, presentation) => {
				const before = this.modelAgentIds();
				await this.dispatchAwaiting({
					type: "create_agent",
					workspaceId: this.workspaceIdOf(workspaceId),
					profileId: agentProfileId(profileId),
					presentation: "full",
					focus: "none",
					...(presentation === undefined
						? {}
						: { agentPresentation: agentPresentation(presentation) }),
				});
				const created = newAgent(before);
				if (created === undefined)
					throw new Error("DevHub did not start the agent.");
				return created;
			},
			// The rename sheet's intent, and the model's own way back to its label.
			renameAgent: async (agentId, name) => {
				await this.dispatchAwaiting({
					type: "rename_agent",
					agentId: parseAgentId(agentId),
					displayName: name,
				});
			},
			resetAgentName: async (agentId) => {
				await this.dispatchAwaiting({
					type: "reset_agent_name",
					agentId: parseAgentId(agentId),
				});
			},
			setAgentManaged: async (agentId, managed) => {
				await this.dispatchAwaiting({
					type: "set_agent_managed",
					agentId: parseAgentId(agentId),
					managed,
				});
			},
			setAgentMeta: async (agentId, key, value) => {
				await this.dispatchAwaiting({
					type: "set_agent_meta",
					agentId: parseAgentId(agentId),
					key,
					...(value === undefined ? {} : { value }),
				});
			},
			queueText: (agentId, text) => {
				const queued = agents()?.queueInjection(
					parseAgentId(agentId),
					text,
					false,
				);
				if (queued === undefined)
					throw new Error("DevHub's agents are not running yet.");
			},
			assignIssue: (request) => this.assignIssueFromCli(request),
			conversation: async (agentId) => {
				const agent = this.coordinator.model.agent(parseAgentId(agentId));
				if (
					agent === undefined ||
					agent.presentation !== "gui" ||
					this.agentWiring === undefined
				)
					return undefined;
				const conversation = await this.agentWiring.conversations.of(agent.id);
				// Read once and again after each thing done to it: the transcript
				// is the conversation engine's, and a read is a request there.
				let { transcript } = await conversation.snapshot();
				const reread = async () => {
					({ transcript } = await conversation.snapshot());
				};
				return {
					entries: () => transcript.entries,
					requests: () => transcript.requests,
					turn: () => {
						const { state } = transcript;
						return state.phase === "ready" ? state.turn : state.phase;
					},
					failure: () => {
						const { state } = transcript;
						return state.phase === "broken"
							? `${state.failure.code}: ${state.failure.detail}`
							: undefined;
					},
					usage: () => transcript.usage,
					submit: async (text) => {
						await conversation.submit(text, []);
						await reread();
					},
					interrupt: async () => {
						await conversation.command({ kind: "interrupt" });
						await reread();
					},
					answer: async (request, answer) => {
						await conversation.command({
							kind: "answer",
							request: requestId(request),
							answer,
						});
						await reread();
					},
				};
			},
			commands: () => {
				const snapshot = this.snapshot();
				return COMMANDS.filter(
					(command) =>
						command.id !== "forward_prefix" &&
						command.id !== "open_command_palette",
				).map((command) => ({
					id: command.id,
					label: command.label,
					category: command.category,
					available: resolveChord(command.id, snapshot) !== undefined,
				}));
			},
			runCommand: (id) => {
				if (!isCommandId(id) || this.chordHost === undefined) return false;
				return runCommand(this.chordHost, id);
			},
			// `focus` is the command line going somewhere on purpose: the place
			// enters Back and Forward's history at once (`NavigationReason`).
			focusWorkspace: async (workspaceId) => {
				await this.dispatchAwaiting(
					intentFromWire({
						type: "select_context",
						context: { kind: "workspace", workspaceId },
						reason: "explicit",
					}),
				);
				this.bringToFront();
			},
			focusAgent: async (agentId) => {
				await this.dispatchAwaiting(
					intentFromWire({
						type: "select_context",
						context: { kind: "agent", agentId },
						reason: "explicit",
					}),
				);
				this.bringToFront();
			},
			// `devhub:` links (`model/devhubLink.ts`): what a link names, checked.
			fileKind: (machine, path) =>
				runtimeById(machine === "local" ? "local" : (machine as RuntimeId))
					.stat(path)
					.then((kind) =>
						kind === "absent"
							? "absent"
							: kind === "directory"
								? "directory"
								: "file",
					),
			sessionAgent: (session) => this.agentRunningSession(session),
			usage: () => this.usageLimits.report(),
			notify: (text) => {
				const { Notification } = electron;
				if (!Notification.isSupported())
					throw new Error("this Mac does not show notifications.");
				const notification = new Notification({ title: "DevHub", body: text });
				this.liveNotifications.add(notification);
				const done = (): void => {
					this.liveNotifications.delete(notification);
				};
				notification.on("click", () => {
					done();
					this.bringToFront();
				});
				notification.on("close", done);
				notification.on("failed", done);
				notification.show();
			},
			agentTerminal: async (agentId) => {
				const model = this.coordinator.model;
				const id = parseAgentId(agentId);
				const workspace = model.workspaceForAgent(id);
				if (!workspace) throw new Error(`there is no agent ${agentId}`);
				const terminal = model.agentTerminal(id);
				if (!terminal) {
					return { agentId, workspaceId: workspace.id, session: undefined };
				}
				// The live half — every tmux pane in it, where each is, what it
				// is running, and the handle — is tmux's, on the Workspace's
				// machine. A machine that cannot be asked still has the rest.
				let tmux:
					| {
							tmux: string;
							socket: string;
							panes: ReturnType<typeof tellTerminalPane>[];
					  }
					| undefined;
				const wiring = this.terminalsWiring;
				if (wiring) {
					try {
						const runtime = await wiring.runtimes.for(
							runtimeById(runtimeIdFor(workspace.location)),
						);
						if (runtime.adapterAvailable) {
							const panes = (await runtime.paneTerminals()).filter(
								(pane) =>
									pane.terminalId === terminal.terminalId &&
									pane.workspaceId === workspace.id,
							);
							const socket = panes[0]?.socketPath;
							if (socket !== undefined) {
								tmux = {
									tmux: runtime.tmuxPath(),
									socket,
									panes: panes.map(tellTerminalPane),
								};
							}
						}
					} catch {
						tmux = undefined;
					}
				}
				const visible = model.visibleTerminal()?.agentId === id;
				return {
					agentId,
					workspaceId: workspace.id,
					session: {
						id: terminal.terminalId,
						name: agentTerminalSessionName(terminal.terminalId),
						open: terminal.open,
						visible,
						focused: visible && model.paneFocus === terminal.terminalId,
						tmux,
					},
				};
			},
			openAgentTerminal: async (agentId, request) => {
				const opened = await this.openAgentTerminal(parseAgentId(agentId), {
					focus: request.focus,
					...(request.command === undefined
						? {}
						: { command: request.command }),
				});
				return { created: opened.created };
			},
			closeAgentTerminal: (agentId) =>
				this.closeAgentTerminal(parseAgentId(agentId)),
			editorPanes: async (agentId) => {
				const { runtime, workspaceId } = await this.terminalOf(
					parseAgentId(agentId),
				);
				return (await runtime.workspacePanes())
					.filter((pane) => pane.workspaceId === workspaceId)
					.map((pane) => ({
						...tellTerminalPane(pane),
						session: pane.sessionName,
						argv: pane.argv,
					}));
			},
			bringPane: (agentId, pane, focus) =>
				this.bringPane(parseAgentId(agentId), pane, focus),
			// The row's Stop Agent and the menu's Restart Session, with the
			// sheet's question taken as answered: see `tell/windowActs.ts`.
			stopAgent: (agentId) =>
				stopAsTheRowDoes(this.cliAgent(agentId), (intent) =>
					this.dispatchAwaiting(intent),
				),
			restartAgent: (agentId) =>
				restartAsTheMenuDoes(this.cliAgent(agentId), (intent) =>
					this.dispatchAwaiting(intent),
				),
			closeWorkspace: (workspaceId, answers) =>
				this.closeWorkspaceFromCli(workspaceId, answers),
			pastSessions: async (workspaceId, profileId) => {
				// The agent picker's listing (`listAgentSessions`), for this place.
				const place = workspacePlaceOf(this.cliWorkspace(workspaceId));
				const { runtime, profile } = await this.sessionsProfile(
					place,
					profileId,
				);
				return listPastSessions(
					runtime,
					profile,
					place.path,
					"here",
					await this.listingContext(runtime, place.path, profile.kind),
				);
			},
			resumeSession: async (workspaceId, profileId, session) => {
				const workspace = this.cliWorkspace(workspaceId);
				const before = this.modelAgentIds();
				// The agent picker's two ways on (`AgentProfilePicker`): another
				// worktree's session in that worktree, the rest here — always in
				// DevHub's conversation view, which is what can be read from here.
				if (session.worktree !== undefined) {
					await this.resumeSessionElsewhere(
						{
							place: workspacePlaceOf(workspace),
							profileId,
							session: session.id,
							worktree: session.worktree,
							...(session.cwd === undefined ? {} : { cwd: session.cwd }),
							presentation: "gui",
						},
						"none",
					);
				} else {
					await this.dispatchAwaiting({
						type: "create_agent",
						workspaceId: workspace.id,
						profileId: agentProfileId(profileId),
						presentation: "full",
						agentPresentation: agentPresentation("gui"),
						resume: sessionId(session.id),
						focus: "none",
					});
				}
				const created = newAgent(before);
				if (created === undefined)
					throw new Error("DevHub did not start the agent.");
				return created;
			},
			pastSessionsIn: async (folder, machine, profileId, scope) => {
				// The same listing, for a folder no workspace need have open.
				const place = tellPlace(folder, machine);
				const { runtime, profile } = await this.sessionsProfile(
					place,
					profileId,
				);
				return listPastSessions(
					runtime,
					profile,
					place.path,
					scope,
					await this.listingContext(runtime, place.path, profile.kind),
				);
			},
			resumeSessionIn: async (folder, machine, profileId, session) => {
				const place = tellPlace(folder, machine);
				const before = this.modelAgentIds();
				if (session.worktree !== undefined) {
					// Another worktree of the clone at `folder`: opened, or checked
					// out again, unfocused (`resumeSessionElsewhere`).
					await this.resumeSessionElsewhere(
						{
							place,
							profileId,
							session: session.id,
							worktree: session.worktree,
							...(session.cwd === undefined ? {} : { cwd: session.cwd }),
							presentation: "gui",
						},
						"none",
					);
				} else {
					// An Agent asking, not a person: the folder in the Sidebar,
					// nothing selected, shown or focused (as `workspace open`).
					const workspaceId = await this.openFolderUnfocused(
						requestedLocation(place),
					);
					await this.dispatchAwaiting({
						type: "create_agent",
						workspaceId,
						profileId: agentProfileId(profileId),
						presentation: "full",
						agentPresentation: agentPresentation("gui"),
						resume: sessionId(session.id),
						focus: "none",
					});
				}
				const created = newAgent(before);
				if (created === undefined)
					throw new Error("DevHub did not start the agent.");
				return created;
			},
			pathKind: (path, machine) =>
				runtimeFor(workspaceLocation(tellPlace(path, machine))).stat(path),
			setSessionMeta: (profileId, session, key, value) => {
				const kind = this.config.agentProfiles.find(
					(candidate) => candidate.id === profileId,
				)?.kind;
				if (kind === undefined)
					throw new Error(`there is no agent profile called '${profileId}'.`);
				return this.sessionMeta.set(
					kind,
					session,
					key,
					value,
					kind === "claude" || kind === "codex"
						? sessionNameOf(this.state.session_names, kind, session)
						: undefined,
				);
			},
		};
	}

	/**
	 * `--tell workspace close`: Close Workspace by the window's own intents
	 * (`closeAsTheWindowDoes`), with the folder question decided by the same
	 * predicate `closeWorkspaceOrWorktree` reads. Nothing is drawn: no sheet
	 * is raised for the confirmation, and a question the workbench raises
	 * while it unloads is answered with its own cancel (the close then stops
	 * at its editor step, as a vetoed one does) instead of going on screen.
	 */
	private async closeWorkspaceFromCli(
		workspaceId: string,
		answers: TellCloseAnswers,
	): Promise<TellClosed> {
		const workspace = this.cliWorkspace(workspaceId);
		const id = workspace.id;
		const repository = this.lastRepositoryStatus.workspaces.find(
			(entry) => entry.workspaceId === id,
		);
		const surfaceKey = `workspace-editor:${id}`;
		this.unattendedWorkbenches.add(surfaceKey);
		try {
			return await closeAsTheWindowDoes(
				{
					id,
					label:
						this.snapshot()?.workspaces.find((one) => one.id === id)?.label ??
						workspace.root,
					scratch: id === this.coordinator.model.scratchWorkspaceId,
					orchestrator: id === this.coordinator.model.orchestratorWorkspaceId,
					closing: workspace.close.kind === "running",
					worktree: closingDeletesWorktree(repository, workspace.root)
						? {
								root: workspace.root,
								branch: repository?.branch,
								dirty: repository?.dirty,
							}
						: undefined,
				},
				answers,
				{
					dispatch: (intent) => this.dispatchAwaiting(intent),
					inspect: () => this.closeInspection(id),
					failure: () => {
						const still = this.coordinator.model.workspace(id);
						if (still === undefined) return undefined;
						const close = still.close;
						return close.kind === "failed"
							? `the close stopped at its ${close.step} step (${close.diagnostic}${close.detail === undefined ? "" : `: ${close.detail}`}); the workspace is still open, and what was done before that step stays done.`
							: "the workspace is still open: the close did not finish.";
					},
				},
			);
		} finally {
			this.unattendedWorkbenches.delete(surfaceKey);
		}
	}

	/**
	 * The workbenches a command line is closing, by surface key: a question
	 * one of them raises is nobody's to answer, so it is cancelled rather
	 * than drawn (`DevHubDialogMainService`).
	 */
	private readonly unattendedWorkbenches = new Set<string>();

	/** The model's Agent a CLI named by its id. */
	private cliAgent(id: string): Agent {
		const agent = this.coordinator.model.agent(parseAgentId(id));
		if (!agent) throw new Error(`there is no agent ${id}`);
		return agent;
	}

	/** The model's Workspace a CLI named by its id. */
	private cliWorkspace(id: string): Workspace {
		const workspace = this.coordinator.model.workspace(this.workspaceIdOf(id));
		if (!workspace) throw new Error(`no workspace ${id} is open`);
		return workspace;
	}

	/** The model's own id for a Workspace the CLI named by its string. */
	private workspaceIdOf(id: string): WorkspaceId {
		const workspace = this.coordinator.model.workspaces.find(
			(candidate) => candidate.id === id,
		);
		if (!workspace) throw new Error(`no workspace ${id} is open`);
		return workspace.id;
	}

	/** The open Workspaces as `--tell workspaces` reports them. */
	private tellWorkspaces(): readonly TellWorkspace[] {
		const snapshot = this.snapshot();
		const context = this.coordinator.model.selection.context;
		const selected =
			context.kind === "workspace"
				? context.workspaceId
				: context.kind === "agent"
					? this.coordinator.model.workspaceForAgent(context.agentId)?.id
					: undefined;
		const rounds = this.repositoryStatus.rounds();
		return snapshot.workspaces.map((workspace) => {
			const repository = this.lastRepositoryStatus.workspaces.find(
				(entry) => entry.workspaceId === workspace.id,
			);
			const number =
				repository?.branch === undefined
					? undefined
					: issueNumberFromBranch(repository.branch);
			const issueRepository = repository?.issueRepository;
			return {
				id: workspace.id,
				name: workspace.label,
				root: workspace.root,
				machine:
					workspace.location.kind === "ssh"
						? `ssh:${workspace.location.host}`
						: "local",
				scratch: workspace.id === snapshot.scratchWorkspaceId,
				orchestrator: workspace.id === snapshot.orchestratorWorkspaceId,
				selected: workspace.id === selected,
				branch: repository?.branch,
				worktreeOf:
					repository?.mainWorktree !== undefined &&
					repository.mainWorktree !== workspace.root
						? repository.mainWorktree
						: undefined,
				repositoryUrl: repository?.repositoryUrl,
				issue:
					number === undefined || issueRepository === undefined
						? undefined
						: `https://github.com/${issueRepository.owner}/${issueRepository.repository}/issues/${String(number)}`,
				container: containerLabel(workspace.editor),
				// The row tooltip's facts, from the same projection it draws.
				review: tellReview(
					repository,
					rounds.find((round) => round.workspaceId === workspace.id)
						?.lastRepositoryRound.at,
					this.lastRepositoryStatus.diagnostic,
				),
				agents: workspace.agents.map((agent) => ({
					id: agent.id,
					name: agent.displayName,
					workspaceId: workspace.id,
					profileId: agent.profileId,
					kind: agent.profileKind,
					presentation: agent.presentation === "gui" ? "gui" : "tui",
					status: agent.status,
					unread: agent.unread,
					activity: agent.activity,
					controlState: agent.controlState.kind,
					failure:
						agent.failure === undefined
							? undefined
							: { code: agent.failure.code, detail: agent.failure.detail },
					promptCache: agent.promptCache,
					meta: agent.meta ?? {},
					managed: agent.managed === true,
				})),
			};
		});
	}

	/**
	 * `--tell issue assign`: the Assign Issue sheet's steps, with the person's
	 * choices given as arguments — the clone (or the first one found, the
	 * sheet's top row), the branch (or the one the sheet would offer), then
	 * the folder and the agent.
	 */
	private async assignIssueFromCli(request: IssueAssignRequest): Promise<{
		readonly workspaceId: string;
		readonly agentId: string | undefined;
		readonly origin: "fetched" | "on-disk" | undefined;
	}> {
		// Everything is named (`tell/service.ts` refuses a call that leaves a
		// choice open): no clone is searched for, no branch derived, no profile,
		// mode or action taken from the settings or the first of a list. What
		// the command line gets must not move when the settings do.
		const config = this.config;
		const item = parseGitHubItemUrl(request.url);
		if (!item)
			throw new Error("That is not a GitHub Issue or pull request URL.");
		const clone: WorkspacePlaceWire = { kind: "local", path: request.repo };
		// `origin` is fetched once, first, inside: a fetch that fails stops
		// here with git's reason unless `--offline` said to go on from the copy
		// on disk — the window's "Start from the copy on this machine".
		const { place: folder, origin } = await this.issueFolder({
			issueUrl: request.url,
			place: clone,
			...(request.branch === undefined
				? {}
				: { branch: request.branch, inRoot: request.place === "root" }),
			...(request.offline ? { allowStaleBase: true } : {}),
		});
		if (request.editorOnly) {
			// The folder in the Sidebar, as `workspace open` puts it there.
			return {
				workspaceId: await this.openFolderUnfocused(requestedLocation(folder)),
				agentId: undefined,
				origin,
			};
		}
		const profile = config.agentProfiles.find(
			(candidate) => candidate.id === request.profile,
		);
		if (profile === undefined)
			throw new Error(
				`there is no agent profile called '${String(request.profile)}'.`,
			);
		if (request.presentation === undefined)
			throw new Error("--gui or --tui is required.");
		const action =
			request.action === undefined
				? undefined
				: config.agentActions.find(
						(candidate) =>
							candidate.enabled &&
							candidate.trigger === "issue" &&
							candidate.id === request.action,
					);
		if (request.action !== undefined && action === undefined)
			throw new Error(`there is no Issue action called '${request.action}'.`);
		const before = this.modelAgentIds();
		await this.assignIssue(
			{
				issueUrl: request.url,
				place: folder,
				profileId: profile.id,
				...(action === undefined ? {} : { actionId: action.id }),
				split: false,
				presentation: request.presentation,
				...(request.name === undefined ? {} : { name: request.name }),
			},
			{
				review: false,
				focus: "none",
			},
		);
		const agent = this.coordinator.model.workspaces
			.flatMap((workspace) => workspace.agents)
			.find((candidate) => !before.has(candidate.id));
		return {
			workspaceId:
				agent?.workspaceId ??
				(await this.openFolderUnfocused(requestedLocation(folder))),
			agentId: agent?.id,
			origin,
		};
	}

	/**
	 * The roots of the open Workspaces **on one machine**.
	 *
	 * Machine-scoped for the same reason `terminalProfileFor` is: `/srv/app` on
	 * two computers is two folders, and a matcher handed both roots answers one
	 * of them with the other's Workspace. That is not a near miss — it is a
	 * file from this Mac opened into a window showing somebody's server, or the
	 * reverse, and neither of them says anything is wrong.
	 */
	/** Every open Workspace, as the routing rule (`route.ts`) reads one. */
	private routableWorkspaces(): readonly RoutableWorkspace[] {
		return this.coordinator.model.workspaces.map((workspace) => ({
			workspaceId: workspace.id,
			root: workspace.root,
			machine: runtimeIdFor(workspace.location),
			agents: workspace.agents.map((agent) => agent.id),
		}));
	}

	/**
	 * The Agent `routeOpen` answered with, as the model holds it.
	 *
	 * It cannot miss: the rule answers with an id out of the very list this
	 * class handed it a moment ago, and nothing runs in between. If it ever did
	 * miss, the list asked and the list answered from would have to be two
	 * lists — and going on from there would be splitting somebody's window for
	 * an Agent that is not there.
	 */
	private runningAgent(id: string) {
		const agent = this.coordinator.model.agent(parseAgentId(id));
		if (!agent) {
			throw new Error(`no Agent ${id} is running`);
		}
		return agent;
	}

	/** The one Workspace rooted at a path on a machine — `workspaceRoots`' inverse. */
	private workspaceAt(root: string, machine: RuntimeId): Workspace {
		const workspace = this.coordinator.model.workspaces.find(
			(candidate) =>
				candidate.root === root && runtimeIdFor(candidate.location) === machine,
		);
		if (!workspace) {
			throw new Error(`no workspace is rooted at ${root}`);
		}
		return workspace;
	}

	private workspaceRoots(machine: RuntimeId): readonly string[] {
		return this.coordinator.model.workspaces
			.filter((workspace) => runtimeIdFor(workspace.location) === machine)
			.map((workspace) => workspace.root);
	}

	/**
	 * Put DevHub in front of whatever the person was looking at.
	 *
	 * They typed a command asking to see something; the app answering from
	 * behind a terminal window has not answered.
	 *
	 * The raising itself is `ShellWindow.raise`, which is the one place DevHub
	 * comes forward, so that a command line is distinguishable from the many
	 * things that merely want the keyboard moved. It runs after the reveal the
	 * command asked for, and the window's own `focus` event places the
	 * keyboard once macOS has made the window key.
	 */
	private bringToFront(): void {
		shellWindow().raise();
	}

	//#endregion

	//#region config

	/**
	 * Follow the running settings. What they are now is always
	 * `this.settings.config`; this is what DevHub does when they change, and
	 * what it says when an edit to the file is refused — which changes nothing
	 * it runs on and is said once, as the one notice.
	 */
	private watchConfig(): void {
		const unsubscribe = this.settings.subscribe({
			accepted: (config, from) => {
				this.settingsAccepted(config);
				// The Settings window answers its own write with a snapshot.
				if (from === "file") publishSettingsSnapshot();
			},
			refused: (notice) => {
				this.publishError(notice);
				publishSettingsSnapshot();
			},
		});
		const stopWatching = this.settings.watch(2000);
		this.stopWatchingConfig = () => {
			stopWatching();
			unsubscribe();
		};
	}

	/**
	 * Settings were accepted, and this run is on them from now on.
	 *
	 * The one way in, whether they came from the Settings window or from an
	 * edit to the file: two paths used to say this, each doing part of it, so
	 * an edit to the file left Scratch and the OS appearance where they were
	 * and a Settings save left the Agent actions and the profile's socket.
	 */
	private settingsAccepted(config: Config): void {
		// A new `[scratch] daily` names a different folder for today, and that
		// folder is Scratch from now on; the old one stays as an ordinary row.
		// Not caught here: a failure goes to the main process's root.
		void this.scratch.settingsAccepted(config.scratch.daily);
		// `[[orchestrator.timers]]` and `[orchestrator.github]` move with them.
		this.orchestrator?.timers.sync();
		this.orchestrator?.settingsChanged();
		this.followGitHub();
		this.applyChordLayout();
		// Before the pages are told, because this one is not a message to a page:
		// it changes what the OS appearance is for the whole process, and every
		// workbench and the shell's own chrome follow from that.
		appearanceMode().apply(config.appearance.mode);
		// The theme the settings name now. A change recolours the window, the
		// pages, the panes and every workbench (`bootstrapShell` listens).
		const theme = shellThemeIfInstalled();
		theme?.configure(themeSelectionOf(config), customThemesOf(config));
		for (const problem of theme?.takeProblems() ?? []) {
			this.noteFailure(
				new NamedFailure(
					withDetail(errorWireAt("color_theme_unavailable"), problem),
				),
			);
		}
		this.publishAppearance();
		this.publishNoticeSettings();
		this.publishProfiles();
		this.publishActions();
		// `[agents] auto_compact_*` is read when a conversation changes; an
		// idle one would not notice the setting turned on until too late.
		this.conversationEngine?.settingsChanged();
		this.agentWiring?.conversations.registry.reconsiderCacheKeeping();
	}

	//#endregion

	//#region the page

	/**
	 * The person started an operation — from the window, or with a `devhub`
	 * command they typed; where it came from does not matter.
	 *
	 * Starting one is one of the three things that retire a failure: they have
	 * moved on, and a report about the last thing is in the way of the next.
	 * The page that draws notices cannot see this for itself and does not want
	 * to: main sees every dispatch a page makes and every command typed, so
	 * main says so. `dispatchOwn` deliberately does not, because DevHub raising
	 * its own intent is not the person starting an action.
	 */
	personStartedAction(): void {
		this.sendToDisplay(CHANNELS.actionStarted, undefined);
	}

	private async dispatchFromPage(wire: AppIntentWire): Promise<AppOutcomeWire> {
		let intent: UserIntent;
		try {
			intent = intentFromWire(wire);
		} catch (error) {
			throw namedFailure(error);
		}
		const settled = await this.dispatchAwaiting(intent);

		// Selecting the Editor activity is the moment its view has to exist. It is
		// done here rather than in the model because a view is an effect on the
		// window, and the model does not have windows.
		return outcomeWire(
			settled,
			this.coordinator.readiness,
			this.repositoryOf,
			this.homeOf,
		);
	}

	private async pickFolder(): Promise<string | undefined> {
		const window = shellWindowIfCreated()?.window;
		const options: Electron.OpenDialogOptions = {
			properties: ["openDirectory", "createDirectory"],
		};
		const picked =
			window === undefined || window.isDestroyed()
				? await electron.dialog.showOpenDialog(options)
				: await electron.dialog.showOpenDialog(window, options);
		return picked.canceled ? undefined : picked.filePaths[0];
	}

	/**
	 * Clone with the `git` this DevHub resolved, not whatever a `git` on some
	 * PATH turns out to be.
	 *
	 * The same lookup every runtime goes through, in the same environment the
	 * terminals and Agents get, so a clone can only fail for reasons the person
	 * can see — and "there is no git here" is one of them, said plainly.
	 */
	private async gitCommand(
		runtime: Runtime = localRuntime(),
	): Promise<GitCommand> {
		const git = await runtime.resolveProgram(
			this.config.runtimes.git,
			this.launchEnvironment["PATH"] ?? "",
		);
		if (git.kind === "unavailable") {
			throw new NamedFailure(
				withSummary(
					errorWireAt("workspace_unavailable"),
					this.executableMissingMessage(git),
				),
			);
		}
		return {
			runtime,
			git: git.value,
			// The environment goes with the resolution. A path was looked up
			// *here*, so this Mac's login environment is the one that found it and
			// the one it should run in; a bare name will be looked up on the far
			// end, and a PATH composed from this Mac names no directory over
			// there — exporting it would replace the only PATH that can resolve
			// anything with one that cannot.
			environment: git.kind === "absolute_path" ? this.launchEnvironment : {},
		};
	}

	/**
	 * The folder an Issue is worked in: made or found, and nothing more.
	 *
	 * The worktree, if one was asked for — or the one the branch is already in,
	 * which `ensureWorktree` switches to rather than duplicating — or the clone
	 * as it stands. This comes before the agent question because the question
	 * is about a folder: its earlier sessions, read by path on its machine, are
	 * what a person assigning review comments wants. Opening it is not part of
	 * this: a Workspace opened here would be selected, its editor started and the
	 * keyboard taken from the question still being asked. The folder becomes a
	 * Workspace in `assignIssue`, once an agent is chosen for it, and a person
	 * who declines keeps only the worktree on disk.
	 */
	private async prepareIssueFolder(
		request: IssueFolderRequest,
	): Promise<WorkspacePlaceWire> {
		return (await this.issueFolder(request)).place;
	}

	/**
	 * `prepareIssueFolder`, with what became of the fetch: the command line
	 * says when it went on from the copy on disk.
	 *
	 * `origin` is fetched once, first, before anything is decided about the
	 * branch (`prepareIssueCheckout`) — unless the window's flow already did
	 * and hands the result in, which is then all there is. The clone as it
	 * stands asks nothing of the remote, so it fetches nothing.
	 */
	private async issueFolder(request: IssueFolderRequest): Promise<{
		readonly place: WorkspacePlaceWire;
		readonly origin: "fetched" | "on-disk" | undefined;
	}> {
		const item = parseGitHubItemUrl(request.issueUrl);
		if (!item) {
			throw workspaceFailure("That is not a GitHub Issue or pull request URL.");
		}
		const place = request.place;
		if (!request.branch) return { place, origin: request.origin };
		const checkout = await prepareIssueCheckout(
			await this.gitCommand(runtimeFor(workspaceLocation(place))),
			place.path,
			// Which work this is — an Issue, or a pull request whose branch
			// already exists — follows from the URL rather than from a second
			// field beside it, because two facts saying the same thing can
			// disagree. It also names the folder (`worktreeDirectory`).
			item,
			request.branch,
			{
				inRoot: request.inRoot === true,
				allowStaleBase: request.allowStaleBase,
				origin: request.origin,
			},
		);
		// A worktree of a repository on a host is beside it, on that host: git
		// made it there, and there is nowhere else it could be. So the place the
		// flow was working in decides the machine, and only the path moves.
		return {
			place: { ...place, path: checkout.path },
			origin: checkout.origin,
		};
	}

	/**
	 * Open the Issue's folder, start the agent chosen for it there, and tell it
	 * about the Issue — one act, because it is what choosing the agent means.
	 *
	 * Opening is going there, the same as opening any folder: the Workspace is
	 * selected (made, or the one already open for that folder) and the keyboard
	 * lands as `arrive` says. Which workspace it is comes from the selection
	 * rather than from matching the path back, because opening a folder *is*
	 * selecting it and the root is canonicalised on the way in.
	 *
	 * Nothing is written down about which Issue this workspace is for. The
	 * branch the flow made carries the number (`feature/128-…`), and the branch
	 * is the whole of the link — so a worktree made for the Issue shows it, and
	 * "in this workspace" on a branch that says nothing about an Issue shows
	 * nothing, which is the point: a record would have claimed the Issue while
	 * `master` was checked out.
	 */
	private async assignIssue(
		request: IssueAssignment,
		how: IssuePromptHow = {},
	): Promise<AppOutcomeWire> {
		const item = parseGitHubItemUrl(request.issueUrl);
		if (!item) {
			throw workspaceFailure("That is not a GitHub Issue or pull request URL.");
		}
		const opening = requestedLocation(request.place);
		if (request.editorOnly === true) {
			// "Just open the editor": the folder becomes the selected Workspace
			// with its editor, and no agent is started or told anything.
			return this.openFolder(opening);
		}
		const quiet = how.focus === "none";
		let workspaceId: WorkspaceId;
		if (quiet) {
			workspaceId = await this.openFolderUnfocused(opening);
		} else {
			await this.openFolder(opening, undefined, "automatic", "for-agent");
			workspaceId = this.openedWorkspaceId(opening);
		}
		// Not `openFolder(opening, withAgent)`: this flow has more to do around
		// the creation than that shortcut can express — the Agent goes beside the
		// editor when the person asked for that, it may resume a session, and the
		// Issue's prompt is queued against whichever Agent it produced — but
		// *which workspace opening produced* is the same fact, read the same way.
		const agentsBefore = new Set(
			this.coordinator.model.workspaces.flatMap((workspace) =>
				workspace.agents.map((agent) => agent.id),
			),
		);
		// A past session is resumed and then told about the Issue, through the
		// same queue a new Agent's first message goes through.
		const settled = await this.dispatchAwaiting({
			type: "create_agent",
			workspaceId,
			profileId: agentProfileId(request.profileId),
			presentation: request.split ? "beside" : "full",
			agentPresentation: agentPresentation(request.presentation),
			...(request.resume === undefined
				? {}
				: { resume: sessionId(request.resume) }),
			...(quiet ? { focus: "none" as const } : {}),
		});
		const started = (): Agent | undefined =>
			this.coordinator.model.workspaces
				.find((workspace) => workspace.id === workspaceId)
				?.agents.find((agent) => !agentsBefore.has(agent.id));
		// The name the person gave it, as Rename… gives one: kept with its
		// session, shown wherever a given name is — and given before the
		// orchestrator hears of the agent, so it hears it by that name.
		const name = request.name?.trim();
		const named = started();
		if (name !== undefined && name.length > 0 && named !== undefined)
			await this.dispatchAwaiting({
				type: "rename_agent",
				agentId: named.id,
				displayName: name,
			});
		// The item linkage, the one rule (`orchestrator/invariant.ts`): the
		// agent an Issue or a pull request is assigned to is linked to it by
		// its meta `issue=` (the item's URL, either kind), written here and
		// nowhere else.
		if (named !== undefined)
			await this.dispatchAwaiting({
				type: "set_agent_meta",
				agentId: named.id,
				key: ISSUE_LINK_KEY,
				value: `https://github.com/${item.owner}/${item.repository}/${item.kind === "pull" ? "pull" : "issues"}/${String(item.number)}`,
			});
		this.queueIssuePrompt(agentsBefore, item, request.actionId, how);
		return outcomeWire(
			settled,
			this.coordinator.readiness,
			this.repositoryOf,
			this.homeOf,
		);
	}

	/**
	 * The branch this Issue or pull request already has, and what this clone can
	 * do with it.
	 *
	 * Two questions with one answer. GitHub is asked what the branch *is* — a
	 * pull request's head, an Issue's linked branch — and git is asked whether
	 * this checkout can have it: is there a remote it can be fetched from, is it
	 * here already, and is it already checked out somewhere.
	 *
	 * `origin` is not fetched here: the flow fetched it once, first
	 * (`fetchForAssignment`), and its refs are what this reads — a pull
	 * request's head, an Issue's linked branch, a branch named for the Issue.
	 * Only a fork's remote is fetched, best effort, for a pull request out of
	 * one. What is *not* softened is GitHub refusing to talk at all — no token,
	 * no such pull request — because then the flow is offering choices about
	 * something it never read.
	 */
	private async assignmentBranch(
		url: string,
		place: WorkspacePlaceWire,
		cancel?: CancellationToken,
	): Promise<AssignmentBranchWire> {
		// Every git question below runs where the repository is; only GitHub is
		// asked from here, because the token and the network are here.
		const directory = place.path;
		const item = parseGitHubItemUrl(url);
		if (!item) {
			throw workspaceFailure("That is not a GitHub Issue or pull request URL.");
		}
		const credentials = await readGitHubToken(this.launchEnvironment);
		if (credentials.kind !== "token") {
			throw workspaceFailure(
				credentials.kind === "unauthenticated"
					? "DevHub is not signed in to GitHub. Run `gh auth login` and try again."
					: `DevHub could not ask GitHub about ${item.owner}/${item.repository}#${String(item.number)}: ${credentials.reason}.`,
			);
		}
		const git = await this.gitCommand(runtimeFor(workspaceLocation(place)));
		if (item.kind === "pull") {
			const head = await readPullRequestHead(item, credentials.token);
			// A branch in somebody else's copy is reachable only through a remote
			// that is already there. DevHub does not add one: a flow that assigns
			// work is not the place to change the person's remotes, and the row it
			// would enable is one they can decline for a reason it can state.
			const sameRepository =
				head.owner.toLowerCase() === item.owner.toLowerCase() &&
				head.repository.toLowerCase() === item.repository.toLowerCase();
			const remote = sameRepository
				? "origin"
				: await remoteForRepository(
						git,
						directory,
						head.owner,
						head.repository,
					);
			// `origin` was fetched as the flow began; a fork's copy was not.
			if (remote !== undefined && remote !== "origin")
				await fetchBranchFrom(git, directory, remote, head.branch, cancel);
			const whereabouts = await this.branchWhereabouts(
				git,
				directory,
				head.branch,
				sameRepository ? undefined : `${head.owner}/${head.repository}`,
			);
			return head.state === undefined
				? whereabouts
				: { ...whereabouts, pullRequestState: head.state };
		}
		// GitHub's own record first — the branch its Create a branch button made
		// — and only then the convention, which is a guess about a name and is
		// consulted exactly because most Issues have no record to read.
		const linked = await readIssueLinkedBranch(item, credentials.token);
		// Both answers are looked for in refs the flow's first fetch brought up
		// to date, the linked one included: a branch GitHub's button made a
		// minute ago is on `origin`, and now in this clone's refs too.
		const branch =
			linked ?? (await this.branchNamedFor(git, directory, item, cancel));
		if (branch === undefined) return { reachable: false };
		// An Issue's branch that this clone cannot reach is no branch at all for
		// this question: a link to one that was deleted, or that lives in some
		// other copy, or a name nobody pushed. Unlike a pull request's head it is
		// nobody's work to protect, so the Issue is offered as not started — and
		// the new branch is made from the default branch — rather than offered
		// a branch that `git worktree add` can never check out.
		return issueBranchPlan(
			await this.branchWhereabouts(git, directory, branch, undefined),
		);
	}

	/**
	 * A branch on this machine or on `origin` that names the Issue.
	 *
	 * The fallback for an Issue GitHub has no linked branch for, and the same
	 * rule the Sidebar reads a branch by — so a worktree somebody made by hand,
	 * or on another machine, or in a DevHub session last week, is found by the
	 * name it already has rather than being made a second time under
	 * `feature/128-wip`.
	 */
	private async branchNamedFor(
		git: GitCommand,
		directory: string,
		item: GitHubItem,
		cancel?: CancellationToken,
	): Promise<string | undefined> {
		const branches = await listBranches(git, directory, cancel);
		return branches.find(
			(branch) => issueNumberFromBranch(branch) === item.number,
		);
	}

	/** The same three git questions, whichever kind the branch came from. */
	private async branchWhereabouts(
		git: GitCommand,
		directory: string,
		branch: string,
		fork: string | undefined,
	): Promise<AssignmentBranchWire> {
		const found = await findBranch(git, directory, branch);
		const checkedOutAt = await worktreeForBranch(git, directory, branch);
		return {
			branch,
			fork,
			reachable: found !== undefined,
			checkedOutAt,
		};
	}

	private async clone(url: string, parentDirectory: string): Promise<string> {
		return cloneProject({
			url,
			parentDirectory,
			command: await this.gitCommand(),
		});
	}

	private registerIpc(): void {
		const handle = electron.ipcMain.handle.bind(electron.ipcMain);
		const receive = electron.ipcMain.on.bind(electron.ipcMain);

		// The Neovim editor's page: attach, then calls in order, unanswered.
		handle(NEOVIM_CHANNELS.attach, (event, request: NeovimAttachRequest) => {
			const editors = this.neovimEditors;
			if (!editors) return { ok: false, message: "DevHub is still starting." };
			return editors.attach(event.sender, request);
		});
		receive(NEOVIM_CHANNELS.call, (_event, call: NeovimCall) => {
			this.neovimEditors?.call(call);
		});
		// An Agent terminal's page, saying where its emulator draws: what a
		// Neovim over one of its panes is placed from.
		receive(
			CHANNELS.reportTerminalScreen,
			(event, terminalId: unknown, screen: unknown) => {
				if (typeof terminalId !== "string") return;
				const rect = screen as Partial<Record<string, unknown>> | null;
				const numbers = ["x", "y", "width", "height"].map((field) =>
					rect === null || typeof rect !== "object" ? NaN : rect[field],
				);
				if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n)))
					return;
				const [x, y, width, height] = numbers as number[];
				this.terminalNeovims?.screen(terminalId, {
					x: x ?? 0,
					y: y ?? 0,
					width: width ?? 0,
					height: height ?? 0,
					zoom: event.sender.getZoomFactor(),
				});
			},
		);
		// The same page in tmux control mode: its panes, exactly.
		receive(
			CHANNELS.reportTerminalPanes,
			(event, terminalId: unknown, panes: unknown) => {
				if (typeof terminalId !== "string") return;
				const parsed =
					panes === null
						? undefined
						: parseControlPanes(panes, event.sender.getZoomFactor());
				if (panes !== null && parsed === undefined) return;
				this.terminalNeovims?.controlPanes(terminalId, parsed);
			},
		);
		handle(
			NEOVIM_CHANNELS.request,
			(_event, call: NeovimCall) =>
				this.neovimEditors?.request(call) ?? {
					ok: false,
					message: "not started",
				},
		);
		receive(NEOVIM_CHANNELS.guiMessage, (_event, message: NeovimGuiMessage) => {
			this.neovimEditors?.guiMessage(message);
		});

		handle(CHANNELS.getSnapshot, () => this.snapshot());
		// A page that has just started has none of the pushes yet, and main
		// says a rectangle only when it moves (`publishLayoutState`). The
		// window's own page draws nothing at all until it has one —
		// deliberately, because a guessed rectangle is the page having an
		// opinion about the layout — so each page asks for its own as it
		// starts listening (`onWorkbenchArea`, `onSidebarArea`).
		handle(CHANNELS.getWorkbenchArea, () => shellWindow().workbenchArea());
		handle(CHANNELS.getSidebarArea, () => shellWindow().sidebarArea());
		handle(CHANNELS.getAppearance, () => this.appearance());
		// Read back off the window rather than composed again: this is the
		// name the OS is showing, which is the only thing the bar may letter.
		handle(CHANNELS.getWindowTitle, () => shellWindow().window.getTitle());
		handle(CHANNELS.getAgentProfiles, () => this.agentProfiles());
		handle(CHANNELS.dispatch, (event, intent: AppIntentWire) => {
			this.personStartedAction();
			// An answer to a question — Go to's row, above all — is a move the
			// person made from the keyboard, and it lands where a chord's does:
			// in what it chose, not back in the Sidebar the question was asked
			// from. The sheet going away is what places the keyboard.
			if (event.sender === shellWindow().picker.contents()) {
				this.keyboardInSidebar = false;
			}
			return this.dispatchFromPage(intent);
		});
		handle(
			CHANNELS.replay,
			(_event, cursor: number): ReplayWire =>
				replayWire(
					this.coordinator.replayFrom(cursor),
					this.coordinator.readiness,
					this.repositoryOf,
					this.homeOf,
				),
		);

		handle(CHANNELS.chooseWorkspaceFolder, () => this.pickFolder());
		handle(CHANNELS.startWorkspacePicker, (_event, query: string) => {
			this.cancelPicker?.();
			const config = this.config;
			const operationId = randomUUID();
			this.cancelPicker = startWorkspacePicker(
				config,
				query,
				operationId,
				(pickerEvent: WorkspacePickerEvent) => {
					this.send(CHANNELS.workspacePicker, pickerEvent);
				},
			);
			return operationId;
		});
		handle(CHANNELS.listSelectionBranches, () => this.selectionBranches());
		handle(
			CHANNELS.openBranchWorkspace,
			async (
				_event,
				place: WorkspacePlaceWire,
				branch: string,
				create: boolean,
				withAgent: AgentLaunchWire | undefined,
			) => {
				this.cancelPicker?.();
				this.cancelPicker = undefined;
				try {
					return await this.openBranchWorkspace(
						place,
						branch,
						create === true,
						withAgent,
					);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(CHANNELS.cancelWorkspacePicker, () => {
			this.cancelPicker?.();
			this.cancelPicker = undefined;
		});
		// Picking a candidate is the same act as opening a folder, so it takes the
		// same path through the model: one way to add a Workspace, not two.
		handle(
			CHANNELS.selectWorkspacePicker,
			async (
				_event,
				path: string,
				create: boolean,
				withAgent: AgentLaunchWire | undefined,
			) => {
				this.cancelPicker?.();
				this.cancelPicker = undefined;
				// A date source offers today's folder before anything has made it —
				// see `ensureWorkspaceFolder`, which is the making, and is separate
				// from `createProject` because the two want opposite answers to "it
				// is already there".
				try {
					return this.openFolder(
						requestedLocation({
							kind: "local",
							path: create ? await ensureWorkspaceFolder(path) : path,
						}),
						withAgent,
						"below-selection",
					);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		// Creating and cloning end where picking does — `openFolder` — because
		// they differ only in how the directory came to exist.
		// The two SSH doors. Listing is read fresh at the moment the picker opens,
		// so a host added five minutes ago is there; opening goes through
		// `openFolder`, which is where every way of opening a Workspace meets.
		handle(CHANNELS.listSshHosts, async () => {
			try {
				return await readSshHosts();
			} catch (error: unknown) {
				throw namedFailure(error);
			}
		});
		handle(
			CHANNELS.openSshWorkspace,
			async (
				_event,
				host: string,
				path: string,
				withAgent: AgentLaunchWire | undefined,
			) => {
				this.cancelPicker?.();
				this.cancelPicker = undefined;
				try {
					return await this.openFolder(
						requestedLocation({ kind: "ssh", host, path }),
						withAgent,
						"below-selection",
					);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(CHANNELS.continueAgent, async (_event, agentId: string) => {
			try {
				await this.continueAgentElsewhere(parseAgentId(agentId));
			} catch (error: unknown) {
				throw namedFailure(error);
			}
		});
		handle(CHANNELS.projectDefaultDirectory, () =>
			defaultProjectDirectory(this.config),
		);
		// The folders a clone can go into: see `cloneParentChoices`.
		handle(CHANNELS.cloneParentDirectories, async () => {
			const config = this.config;
			// The same walk the workspace picker runs, so the same way of going
			// wrong: a source that is a command can hang, and the person is
			// looking at "Searching…" while it does. It is a lookup like the
			// others and is bounded like the others.
			const parents = await this.boundedLookup(
				"the folders a clone could go into",
				(cancel) => collectParentDirectories(config, cancel),
			);
			return cloneParentChoices(config, parents);
		});
		// Who `gh` says this person is, asked when a sheet needs it rather than
		// kept: a login that was switched or logged out of should stop being
		// DevHub's answer the moment it stops being true.
		handle(CHANNELS.githubLogin, () => readGitHubLogin(this.launchEnvironment));
		// The branch this Issue or pull request already has, in this clone's
		// terms. A refusal travels as the structured error inside the message, so
		// the step that asked shows GitHub's own sentence and not "the native app
		// shell is unavailable".
		handle(
			CHANNELS.assignmentBranch,
			(_event, url: string, place: WorkspacePlaceWire) =>
				// The longest wait in the flow before this was bounded: a `gh`
				// call, two GraphQL queries and up to two `git fetch`es, each of
				// which may take the network timeout — ten minutes — while a
				// person looks at a spinner. Bounded like every other lookup, and
				// for the same reason: the parts' own timeouts say nothing about
				// the sum, which is the number actually being waited out.
				this.boundedLookup(`the branch for ${url}`, (cancel) =>
					this.assignmentBranch(url, place, cancel),
				),
		);
		// The fetch an assignment begins with: once, before the branch is asked
		// about, and not under the lookup deadline — it is the one network step
		// that has to finish, and it gets git's own timeout. Escape still stops
		// it (`cancelPickerLookup`). A failure is `git_fetch_failed` with git's
		// reason, which the sheet turns into "use the copy on this machine".
		handle(
			CHANNELS.fetchForAssignment,
			async (_event, place: WorkspacePlaceWire) => {
				this.pickerLookup?.cancel();
				const cancel = new CancellationToken();
				this.pickerLookup = cancel;
				try {
					return await fetchOriginFirst(
						await this.gitCommand(runtimeFor(workspaceLocation(place))),
						place.path,
						{},
						cancel,
					);
				} catch (error: unknown) {
					if (cancel.isCancelled)
						throw namedFailure(workspaceFailure("The fetch was cancelled."));
					throw namedFailure(error);
				} finally {
					if (this.pickerLookup === cancel) this.pickerLookup = undefined;
				}
			},
		);
		// A refusal travels the way every other one does — as the structured
		// error inside the message — so the sheet that asked shows the sentence
		// and not "the native app shell is unavailable".
		handle(
			CHANNELS.createProject,
			async (_event, path: string, withAgent: AgentLaunchWire | undefined) => {
				this.cancelPicker?.();
				this.cancelPicker = undefined;
				try {
					return this.openFolder(
						requestedLocation({
							kind: "local",
							path: await createProject(path),
						}),
						withAgent,
						"below-selection",
					);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(
			CHANNELS.cloneProject,
			async (
				_event,
				url: string,
				parentDirectory: string,
				withAgent: AgentLaunchWire | undefined,
			) => {
				this.cancelPicker?.();
				this.cancelPicker = undefined;
				try {
					return this.openFolder(
						requestedLocation({
							kind: "local",
							path: await this.clone(url, parentDirectory),
						}),
						withAgent,
						"below-selection",
					);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);

		// Assigning an Issue is four calls because it is four questions, and a
		// failure has to be answerable by re-asking the one that led to it.
		handle(CHANNELS.findIssueRepositories, async (_event, issueUrl: string) => {
			const config = this.config;
			// Either kind: which clones a repository has is a question about the
			// repository, and an Issue and a pull request name theirs the same way.
			const issue = parseGitHubItemUrl(issueUrl);
			if (!issue) {
				throw workspaceFailure(
					"That is not a GitHub Issue or pull request URL.",
				);
			}
			return this.boundedLookup(
				`${issue.owner}/${issue.repository}`,
				(cancel) =>
					findClones(
						config,
						(place) => this.gitCommand(runtimeFor(workspaceLocation(place))),
						issue,
						// Every open Workspace, with the machine it is on. A remote
						// one used to arrive as a bare path and be read by this Mac's
						// git, which answered about a directory of the same name here
						// or about nothing at all.
						this.coordinator.model.workspaces.map(
							(workspace) => workspace.location,
						),
						cancel,
					),
			);
		});

		// Escape, or the sheet going away. There is one lookup at a time, so
		// there is nothing to identify: this ends the one that is running, and
		// the `git` child dies with it rather than at the deadline.
		// Theme: Preview…'s cursor moved; ignored unless that sheet is open.
		handle(CHANNELS.previewColorTheme, (_event, name: unknown) => {
			if (typeof name === "string") this.themePreview.preview(name);
			return Promise.resolve();
		});
		handle(CHANNELS.cancelPickerLookup, () => {
			this.pickerLookup?.cancel();
			this.pickerLookup = undefined;
			return Promise.resolve();
		});
		// The agent picker's past sessions: the ones that ran in the place, read
		// on its machine with the command a launch there would run.
		handle(
			CHANNELS.listAgentSessions,
			async (_event, place: WorkspacePlaceWire, profileId: string) => {
				try {
					const { runtime, profile } = await this.sessionsProfile(
						place,
						profileId,
					);
					return await listPastSessions(
						runtime,
						profile,
						place.path,
						"here",
						await this.listingContext(runtime, place.path, profile.kind),
					);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(
			CHANNELS.resumeSessionElsewhere,
			async (_event, request: ResumeElsewhereWire) => {
				try {
					return await this.resumeSessionElsewhere(request);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(
			CHANNELS.previewAgentSession,
			async (
				_event,
				place: WorkspacePlaceWire,
				profileId: string,
				session: unknown,
				cwd: unknown,
			) => {
				try {
					if (typeof session !== "string" || typeof cwd !== "string")
						throw new Error("a preview names no session and directory");
					const { runtime, profile } = await this.sessionsProfile(
						place,
						profileId,
					);
					return await previewPastSession(runtime, profile, session, cwd);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(
			CHANNELS.cloneRepository,
			async (_event, url: string, parentDirectory: string) => {
				try {
					return await this.clone(url, parentDirectory);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(CHANNELS.listBranches, async (_event, place: WorkspacePlaceWire) => {
			try {
				return await listBranches(
					await this.gitCommand(runtimeFor(workspaceLocation(place))),
					place.path,
				);
			} catch (error: unknown) {
				throw namedFailure(error);
			}
		});
		handle(
			CHANNELS.prepareIssueFolder,
			async (_event, request: IssueFolderRequest) => {
				try {
					return await this.prepareIssueFolder(request);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(CHANNELS.assignIssue, async (_event, request: IssueAssignment) => {
			try {
				return await this.assignIssue(request);
			} catch (error: unknown) {
				throw namedFailure(error);
			}
		});

		handle(CHANNELS.getRepositoryStatus, () => this.lastRepositoryStatus);
		handle(
			CHANNELS.getOrchestratorBoard,
			() => this.orchestrator?.wire() ?? EMPTY_BOARD,
		);
		// The person's answer to an escalation: the window's, and only the
		// window's. No `--tell` port reaches `OrchestratorService.answer`.
		handle(
			CHANNELS.answerEscalation,
			(_event, id: unknown, markdown: unknown) => {
				try {
					if (typeof id !== "number" || typeof markdown !== "string")
						throw new Error("an answer names an escalation and has words");
					this.requireOrchestrator().answer(id, markdown);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(CHANNELS.startOrchestrator, async () => {
			try {
				await this.startOrchestratorFromWindow();
			} catch (error: unknown) {
				throw namedFailure(error);
			}
		});
		// What the Orchestrator screen shows, for the window's title — by id
		// and path only; the title is composed here (`shellTitle.ts`).
		receive(CHANNELS.reportOrchestratorView, (_event, view: unknown) => {
			const parsed = orchestratorViewWire(view);
			if (parsed === undefined) return;
			this.orchestratorView = parsed;
			this.refreshWindowTitle();
		});
		handle(CHANNELS.setOrchestratorPaused, (_event, paused: unknown) => {
			if (typeof paused !== "boolean")
				throw namedFailure(new Error("paused is true or false"));
			const events = this.requireOrchestrator().events;
			if (paused) events.pause();
			else events.resume();
		});
		// The Files tab: the orchestrator's folder, read-only and confined to
		// it (`orchestrator/orchestratorFiles.ts`).
		handle(CHANNELS.listOrchestratorFolder, async (_event, path: unknown) => {
			const root = this.orchestratorFilesRoot();
			const problem = await rootProblem(root);
			if (root === undefined || problem !== undefined)
				return { path: "", entries: [], problem };
			this.watchOrchestratorFiles(root);
			try {
				return await listFolder(root, typeof path === "string" ? path : "");
			} catch (error: unknown) {
				throw namedFailure(error);
			}
		});
		handle(CHANNELS.readOrchestratorFile, async (_event, path: unknown) => {
			try {
				return await readRootFile(
					this.requireOrchestratorFilesRoot(),
					String(path),
				);
			} catch (error: unknown) {
				throw namedFailure(error);
			}
		});
		// An escalation's embeds: the conversation's own readers, on this Mac
		// (its pictures are copied here when it is raised: `escalationFiles.ts`).
		handle(
			CHANNELS.resolveEscalationPaths,
			(_event, cwd: unknown, paths: unknown) => {
				if (cwd !== undefined && typeof cwd !== "string")
					throw new Error(`${JSON.stringify(cwd)} is not a directory`);
				if (
					!Array.isArray(paths) ||
					!paths.every((path): path is string => typeof path === "string")
				)
					throw new Error(`${JSON.stringify(paths)} is not a list of paths`);
				return resolvePathCandidates(
					runtimeById("local"),
					cwd === undefined ? undefined : expandOrchestratorRoot(cwd),
					paths,
				);
			},
		);
		handle(CHANNELS.readEscalationEmbed, (_event, path: unknown) =>
			readEmbedFile(runtimeById("local"), path),
		);
		handle(CHANNELS.escalationEmbedSignature, (_event, path: unknown) =>
			embedSignature(runtimeById("local"), path),
		);
		handle(CHANNELS.openOrchestratorFile, async (_event, path: unknown) => {
			try {
				await this.openOrchestratorFile(path);
			} catch (error: unknown) {
				throw namedFailure(error);
			}
		});
		handle(CHANNELS.getUsageLimits, () => this.usageLimits.wire());

		// Destructive. `force` says the page already asked and was told to go
		// ahead; without it git is left to refuse, which is what happens for the
		// removals that were never worth asking about.
		// The Smart Buttons. A refusal reaches the page as words, because a
		// button that quietly does nothing is the one outcome nobody can act on.
		handle(
			CHANNELS.runAgentAction,
			async (_event, agentId: string, actionId: string) => {
				try {
					return await this.runAgentAction(agentId, actionId);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(CHANNELS.closeWorkspace, (_event, workspaceId: string) => {
			// The one path — see `closeWorkspaceOrWorktree`. It answers nothing
			// because what happens next may be a question on the modal layer, and
			// the projection is what says how it ended.
			this.closeWorkspaceOrWorktree(workspaceId);
		});
		// The answer to the three-way worktree question main asked. The page
		// says which of the two answers it was told; `--force` is main's, and
		// so is what "delete" means. "Cancel" is the sheet dismissing itself
		// and never arrives here.
		handle(
			CHANNELS.answerWorktreeClose,
			async (_event, workspaceId: string, answer: "close" | "delete") => {
				try {
					return await this.answerWorktreeClose(workspaceId, answer);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		// The two ends of a reviewed message. Both hand the snapshot back, because
		// both change what the Agent's row says about its queue, and both refuse
		// with words when the intent is no longer there — an Agent that ended
		// while its sheet stood is exactly the case a silent success would hide.
		handle(
			CHANNELS.confirmInjection,
			(_event, agentId: string, injectionId: string, text: string) => {
				try {
					const id = parseAgentId(agentId);
					if (!agents()?.confirmInjection(id, injectionId, text)) {
						throw workspaceFailure(
							"That message is no longer queued — the agent it was for has ended.",
						);
					}
					return outcomeWire(
						{ kind: "updated", snapshot: this.coordinator.model.snapshot() },
						this.coordinator.readiness,
						this.repositoryOf,
						this.homeOf,
					);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(
			CHANNELS.cancelInjection,
			(_event, agentId: string, injectionId: string) => {
				try {
					agents()?.cancelInjection(parseAgentId(agentId), injectionId);
					// Cancelling something already gone is not a failure: the sheet is
					// being closed and closing it is what the person asked for.
					return outcomeWire(
						{ kind: "updated", snapshot: this.coordinator.model.snapshot() },
						this.coordinator.readiness,
						this.repositoryOf,
						this.homeOf,
					);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(CHANNELS.agentActions, () => this.agentActionsWire());
		handle(CHANNELS.openSettings, () => {
			openSettingsWindow();
		});
		// A fixed URL, never one the page names: the Microphone pane of
		// Privacy & Security, where a refused dictation is undone.
		handle(CHANNELS.openMicrophoneSettings, () =>
			electron.shell.openExternal(MICROPHONE_SETTINGS_URL),
		);
		handle(CHANNELS.openExternalUrl, (_event, url: string) => {
			// A `devhub:` link is a place inside DevHub, never the system's to
			// open (`model/devhubLink.ts`); the page navigates it itself.
			if (typeof url !== "string" || isDevhubLink(url))
				throw namedFailure(
					new Error(`${String(url)} is not a link to open outside DevHub`),
				);
			return electron.shell.openExternal(url);
		});
		// A `devhub:file` link, clicked: the file opened in the workspace that
		// holds it, as an explicit move (`openLinkedFile`).
		handle(
			CHANNELS.openLinkedFile,
			async (_event, workspaceId: unknown, path: unknown, range: unknown) => {
				try {
					await this.openLinkedFile(workspaceId, path, range);
				} catch (error: unknown) {
					throw namedFailure(error);
				}
			},
		);
		handle(CHANNELS.devhubSessionAgent, async (_event, session: unknown) =>
			typeof session === "string"
				? ((await this.agentRunningSession(session)) ?? null)
				: null,
		);
		// A copy inside a terminal pane. It is main's clipboard rather than
		// the renderer's because the write arrives from a PTY: the browser's
		// clipboard API refuses one while the document is unfocused, and tmux
		// does not wait for the window to be frontmost.
		handle(CHANNELS.writeClipboard, (_event, text: string) => {
			electron.clipboard.writeText(text);
		});
		handle(CHANNELS.writeClipboardImage, (_event, png: unknown) => {
			writeClipboardImage(png);
		});
		handle(CHANNELS.writeClipboardRich, (_event, content: unknown) => {
			const wire = content as Partial<Record<string, unknown>> | null;
			if (
				typeof wire?.["text"] !== "string" ||
				typeof wire["html"] !== "string"
			)
				throw new Error("The text to copy is not text and HTML.");
			electron.clipboard.write({ text: wire["text"], html: wire["html"] });
		});
		// A deck from a GUI Agent's answer, saved where the person says, the
		// dialog a sheet over the window (`slideExport.ts`).
		const slideExport: SlideExportHost = {
			showSaveDialog: (options) =>
				electron.dialog.showSaveDialog(shellWindow().window, options),
			createWindow: (options) => new electron.BrowserWindow(options),
			writeFile: (path, bytes) => writeFile(path, bytes),
		};
		handle(CHANNELS.saveSlidesPdf, (_event, request: unknown) =>
			saveSlidesPdf(slideExport, request),
		);
		handle(CHANNELS.saveSlideImages, (_event, request: unknown) =>
			saveSlideImages(slideExport, request),
		);
		// A drag in progress, which is the one geometric fact the page owns
		// while it lasts: the pointer is in the page, and the model only learns
		// where the person stopped. Everything else about the layout is
		// computed here — see `publishLayoutState`.
		handle(CHANNELS.previewLayout, (_event, preview: LayoutPreviewWire) => {
			if (preview.sidebarWidth !== undefined) {
				this.sidebarWidthPreview = preview.sidebarWidth ?? undefined;
			}
			if (preview.sidebarOverlay !== undefined) {
				this.sidebarOverlay = preview.sidebarOverlay === true;
			}
			if (preview.splitRatio !== undefined) {
				this.splitRatioPreview = preview.splitRatio ?? undefined;
			}
			if (preview.terminalShare !== undefined) {
				const share = preview.terminalShare;
				this.terminalSharePreview =
					share === null || typeof share !== "number" || !Number.isFinite(share)
						? undefined
						: clampTerminalShare(share);
			}
			this.publishLayoutState();
		});
		// Escape in the Sidebar. The page can blur its own row but it cannot
		// focus a native workbench view, so where the keyboard goes stays main's
		// one answer and this is only the ask.
		// The floating Sidebar lost sight of the pointer and asks where it is.
		handle(CHANNELS.sidebarPointer, () => shellWindow().sidebarPointer());
		handle(CHANNELS.focusSurface, () => {
			this.placeKeyboardOnSurface();
		});
		// One way in and one way out for every modal DevHub shows. Main owns the
		// set that is open because the overlay view is a fact about the window,
		// not about whichever page happened to ask.
		handle(CHANNELS.openModal, (_event, request: ModalRequest) =>
			shellWindow().picker.openModal(request),
		);
		// A failure that *began* on a page arrives here, and goes out on the
		// same channel every failure main raises goes out on. One display site,
		// one lifetime rule, whichever page the failure began on. One way, and
		// received-is-never-raised on the page side, is what keeps this from
		// being a loop — see `raiseFailure` in `ipc/contract.ts`.
		receive(CHANNELS.raiseFailure, (event, error: AppErrorWire) => {
			// The sender is passed on so that a failure raised in the Settings
			// window is drawn there. Every page in the shell window is answered
			// the same way whatever it was; see `publishAudience.ts`.
			this.publishError(error, event.sender);
		});
		// The `toasts` view is exactly as big as the notices it is drawing,
		// because a native view takes every click inside its bounds whether or
		// not anything is painted there. This is the page saying how big that
		// is; see `toastsView.ts`.
		receive(
			CHANNELS.toastsSize,
			(_event, size: { readonly width: number; readonly height: number }) => {
				shellWindow().toasts.setSize(size);
			},
		);
		// The `tooltip` view is exactly as big as the box the page drew, for
		// the same reason the notices are: a native view takes every click
		// inside its bounds whether or not anything is painted there. See
		// `tooltipView.ts`.
		receive(
			CHANNELS.tooltipSize,
			(_event, size: { readonly width: number; readonly height: number }) => {
				shellWindow().tooltip.setSize(size);
			},
		);
		// The Sidebar asking for a tooltip over the window, about one of its
		// own rows. It composes the sentence and knows where the pointer is
		// resting; main owns where anything in the window goes. The anchor
		// arrives in window coordinates — see `SidebarAreaWire` for how the
		// page knows its own origin, which is main's number and not a
		// measurement.
		// A row's context menu (or a diagram's, from the Agents page), as a
		// native menu over the window, so no view's bounds can clip it. The
		// page's point plus the place main laid that page is where the click
		// was. The tooltip goes first: it was about
		// the row the pointer rested on, and the menu is what is being read now.
		handle(
			CHANNELS.showContextMenu,
			(event, request: ContextMenuRequestWire) => {
				const window = shellWindow();
				window.tooltip.hide();
				return popupContextMenu(
					window.window,
					request,
					window.contextMenuOrigin(event.sender),
				);
			},
		);
		receive(CHANNELS.showTooltip, (_event, request: TooltipRequestWire) => {
			shellWindow().tooltip.show(request);
		});
		receive(CHANNELS.hideTooltip, () => {
			shellWindow().tooltip.hide();
		});
		// The pointer left the row — which the Sidebar cannot tell from the
		// pointer arriving in the tooltip, two pixels away in another view. It
		// is a request; main holds the box for a grace and the tooltip page's
		// own report of where the pointer is decides. See `tooltipView.ts`.
		receive(CHANNELS.releaseTooltip, () => {
			shellWindow().tooltip.release();
		});
		// The other half of that: the `tooltip` page saying whether the pointer
		// is in the box it drew.
		receive(CHANNELS.tooltipPointer, (_event, inside: boolean) => {
			shellWindow().tooltip.pointerIs(inside);
		});
		// "Try Again" on a notice. The button is on the toasts page and what it
		// restarts is the App Shell page's projection, so main is what joins
		// them — the same shape as every other command a page carries out.
		receive(CHANNELS.retryApp, () => {
			this.send(CHANNELS.menuCommand, "retry_app");
		});
		// The page that draws notices is listening: the first moment there is
		// anywhere to say what went wrong before it existed. See
		// `noteStartupFailure`.
		receive(CHANNELS.noticesListening, () => {
			this.publishNoticeSettings();
			this.conditions.replay();
			const pending = this.startupFailures;
			this.startupFailures = [];
			for (const failure of pending) this.publishError(failure);
		});
		// The other half of the journal: main sees every raise and none of the
		// ways a notice leaves the screen, two of which are gestures in the
		// page. See `diagnostics/notices.ts`.
		handle(CHANNELS.noticeRetired, (_event, retired: NoticeRetiredWire) => {
			this.notices.retiredByPage(retired.identity, retired.reason);
		});
		handle(
			CHANNELS.closeModal,
			(_event, id: string, response: number | undefined) => {
				shellWindow().picker.closeModal(id, response);
			},
		);
	}

	//#endregion
}

/** How a `--goto` position reads back in the sentence the command prints. */
/**
 * Why an open landed where it did, as the end of the sentence the CLI prints.
 *
 * A misrouted open is only visible if the answer says which of the three
 * clauses answered — in the terminal that asked, where somebody is actually
 * looking. Written here, once, so that the same reason cannot come out in two
 * wordings depending on which branch produced it.
 */
function because(reason: OpenReason): string {
	switch (reason) {
		case "origin":
			return "it is the window this terminal belongs to.";
		case "origin-agent":
			return "it is the Agent this terminal belongs to.";
		case "containing":
			return "it is the open workspace that contains it.";
		case "no-containing-workspace":
			return "no open workspace contains it.";
	}
}

function at(position: ControlPosition | undefined): string {
	return position === undefined
		? ""
		: ` at line ${position.line}, column ${position.column},`;
}

/**
 * How the Issue flow's first message goes out, where the caller decides it
 * rather than the action: `review` overrides its `confirm_before_send` (false
 * from `devhub --tell`, which draws no sheet).
 */
interface IssuePromptHow {
	readonly review?: boolean;
	/** `"none"` from `devhub --tell`: nothing is selected, shown or focused. */
	readonly focus?: IntentFocus;
}

let current: AppController | undefined;

/** One of the tools DevHub installs on a host, from `product.json`'s pins. */
function hostToolDelivery(
	tool: HostTool,
	userDataPath: string,
): ReleaseToolDelivery {
	const product = devhubProduct() as unknown as Readonly<
		Record<string, unknown>
	>;
	const text = (key: string) => {
		const value = product[key];
		return typeof value === "string" ? value : "";
	};
	const pins = product[`${tool}DownloadSha256`];
	return new ReleaseToolDelivery({
		tool,
		version: text(`${tool}Version`),
		directory: toolInstallDirectory(devhubProduct().serverDataFolderName, tool),
		urlTemplate: text(`${tool}DownloadUrlTemplate`),
		sha256:
			typeof pins === "object" && pins !== null
				? (pins as Readonly<Record<string, string>>)
				: {},
		cacheDirectory: join(userDataPath, tool),
	});
}

export async function createAppController(
	userDataPath: string,
	/** The settings DevHub runs on, loaded before the window (`bootstrapShell`). */
	settings: RunningSettings,
): Promise<AppController> {
	if (current) {
		throw new Error("the App Shell controller already exists");
	}
	setRuntimeVersion(electron.app.getVersion());
	// Which profile's directories a remote runtime binds its control socket
	// under. Told here, once, because `main/runtime/` must not need Electron at
	// import time: it is imported by the PTY test program too, and a module
	// that reaches for `app` makes every importer of it need an app.
	setRuntimeProfile({
		userDataDirectory: userDataPath,
		home: homedir(),
		// Where the tmux, the bash and the `devhub` DevHub puts on a host come
		// from: `product.json`'s pinned releases, and this app's own build.
		// Facts about the build, not things a person configures — and read
		// here for the same reason the profile is passed in at all.
		tmux: hostToolDelivery("tmux", userDataPath),
		// The bash a host with neither bash nor zsh is given for Claude Code.
		bash: hostToolDelivery("bash", userDataPath),
		// The Neovim DevHub draws there: the release this Mac runs from inside
		// the app (`editor/bundledNeovim.ts`), for that host's platform.
		nvim: hostToolDelivery("nvim", userDataPath),
		// The `devhub` command, from this app's own build of it.
		devhub: bundledToolDelivery(
			"devhub",
			toolInstallDirectory(devhubProduct().serverDataFolderName, "devhub"),
			join(APP_ROOT, "out", "cli"),
		),
	});

	const config = settings.config;

	const stateStore = new JsonStateStore(
		join(userDataPath, "devhub", "state.json"),
	);
	const load = await stateStore.loadState();
	const state = load.state;
	const previousExit =
		state.shutdown.launch_generation === 0
			? ("unknown" as const)
			: state.shutdown.clean
				? ("clean" as const)
				: ("unclean" as const);
	markStarting(state);
	await stateStore.saveState(state);

	const profiles = config.agentProfiles.map((profile) =>
		toDomainProfile(profile, config.agents),
	);
	// Scratch is today's folder, worked out now rather than read from the file:
	// a file from yesterday names yesterday's folder as an ordinary Workspace,
	// and today's becomes Scratch.
	const today = await scratchDay(config.scratch.daily, new Date(), homedir());
	let model: AppModel;
	let projectionFailure: string | undefined;
	try {
		model = hydrateModel(state, profiles, today.workspace);
	} catch (error) {
		// Two different things used to arrive here and both started the app
		// empty in silence, which is every workspace gone and a working-looking
		// app that says nothing. They are told apart by what threw.
		//
		// A `StateError` is the document describing something the domain refuses
		// — the file names the field and the value, the file is kept rather than
		// overwritten, and the person is told on the first render. Anything else
		// is a bug in the projection itself, and a bug is a crash with the cause
		// attached: starting empty would move it somewhere it cannot be found.
		if (!(error instanceof StateError)) throw error;
		projectionFailure = error.describe(stateStore.path);
		model = new AppModel(today.workspace);
	}
	if (today.failure !== undefined) {
		model.markWorkspaceUnavailable(
			model.scratchWorkspaceId,
			"root_inaccessible",
		);
	}

	const created = new AppController(
		settings,
		stateStore,
		model,
		state,
		previousExit,
		load.metadata.origin === "fresh",
	);
	current = created;
	// The one notice about a settings file this run could not use. Nothing
	// else says it: everything runs on the defaults in the meantime.
	if (settings.launchRefusal !== undefined) {
		current.noteStartupFailure(settings.launchRefusal);
	}
	// A file DevHub refused is a session that vanished, and there is exactly one
	// place to say so before there is a page to say it to. Both halves report
	// the same way: the file would not load, or it loaded and would not project.
	const stateFailure = load.metadata.corruptionDetail ?? projectionFailure;
	if (stateFailure !== undefined) {
		current.noteStartupFailure(
			withDetail(errorWireAt("persistence_degraded"), stateFailure),
		);
	}
	if (today.failure !== undefined) {
		current.noteStartupFailure(
			withDetail(errorWireAt("workspace_unavailable"), today.failure),
		);
	}
	// What moving an older file forward changed without the person: one
	// notice, every sentence in it.
	if (load.metadata.migrationNotes.length > 0) {
		current.noteStartupFailure(
			withDetail(
				errorWireAt("state_migrated"),
				load.metadata.migrationNotes.join(" "),
			),
		);
	}
	return current;
}

export function appController(): AppController {
	if (!current) {
		throw new Error("the App Shell controller has not been created yet");
	}
	return current;
}

export function appControllerIfCreated(): AppController | undefined {
	return current;
}

/** Which dev container a Workspace's editor is in, as `--tell workspaces` names it. */
function containerLabel(editor: EditorAttachmentWire): string | undefined {
	if (editor.kind === "host") return undefined;
	return ("label" in editor ? editor.label : undefined) ?? "default";
}

/** One tmux pane of an Agent terminal, as `devhub --tell terminal` says it. */
function tellTerminalPane(pane: MarkedPane) {
	return {
		window: pane.windowId,
		windowIndex: pane.windowIndex,
		windowName: pane.windowName,
		windowActive: pane.windowActive,
		pane: pane.paneId,
		paneIndex: pane.paneIndex,
		active: pane.active,
		left: pane.left,
		top: pane.top,
		width: pane.width,
		height: pane.height,
		cwd: pane.cwd,
		command: pane.command,
		title: pane.title,
		dead: pane.dead,
	};
}

/** Where a Workspace is, in the shape a page names a place: its folder, on its machine. */
/** A `--tell` folder on a `TellWorkspace.machine` (`local`, `ssh:<host>`). */
function tellPlace(path: string, machine: string): WorkspacePlaceWire {
	return machine.startsWith("ssh:")
		? { kind: "ssh", host: machine.slice("ssh:".length), path }
		: { kind: "local", path };
}

function workspacePlaceOf(workspace: Workspace): WorkspacePlaceWire {
	const location = workspace.location;
	return location.kind === "ssh"
		? { kind: "ssh", host: location.host, path: location.path }
		: { kind: "local", path: location.path };
}
