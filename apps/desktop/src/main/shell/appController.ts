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

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import vscodeProduct from "code-oss-dev/out/vs/platform/product/common/product.js";
/**
 * The product facts that are DevHub's own and not VS Code's.
 *
 * `product.json` is one file and VS Code's type for it names only VS Code's
 * fields, so the fields `apps/desktop/product-overrides.json` adds are read
 * through this rather than by widening a type that is not DevHub's to widen.
 *
 * `serverDownloadUrlTemplate` is in here for a different reason than the tmux
 * three: VS Code *has* the field, its type simply does not name it, because
 * upstream's own builds read it only inside the server bundle. DevHub reads it
 * on the client now — it is the client that fetches the tarball — so it is
 * named here rather than left as a cast at the one call site.
 */
const devhubProduct = vscodeProduct as unknown as {
	readonly tmuxVersion?: string;
	readonly tmuxDownloadUrlTemplate?: string;
	readonly tmuxDownloadSha256?: Readonly<Record<string, string>>;
	readonly serverDownloadUrlTemplate?: string;
	/** Where `docker` and `devcontainer` are, when they are not on `PATH`. */
	readonly dockerPath?: string;
	readonly devcontainerPath?: string;
};
import { activityCounters } from "../diagnostics/counters.js";
import {
	metricsReport,
	type TerminalLauncherStatus,
} from "../diagnostics/metrics.js";
import { NoticeJournal } from "../diagnostics/notices.js";
import { reconcileRounds } from "../diagnostics/rounds.js";
import { electron } from "../electron.js";
import { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import { CancellationToken as VSCancellationToken } from "code-oss-dev/out/vs/base/common/cancellation.js";
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import { OpenContext } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import { UnloadReason } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import {
	CHANNELS,
	type AgentActionWire,
	type AppConditionWire,
	type ChordHelpRowWire,
	type LayoutPreviewWire,
	type AssignmentBranchWire,
	type IssueAssignment,
	type WorkspacePlaceWire,
	type ModalRequest,
	type RepositoryStatusWire,
	type TooltipRequestWire,
	type WorkspacePickerEvent,
} from "../../ipc/contract.js";
import {
	appConditionIdentity,
	appFailureIdentity,
	type AgentProfiles,
	type AppAppearance,
	type AppErrorWire,
	type AppIntentWire,
	type AppOutcomeWire,
	type AppSnapshotWire,
	type CloseDiagnosticWire,
	type NoticeRetiredWire,
	type ReplayWire,
} from "../../ipc/appShell.js";
import { AppCoordinator, type Effect } from "../../model/coordinator.js";
import {
	CLOSE_BUDGET_MS,
	CLOSE_STEP_TIMEOUT_MS,
	CloseTimeout,
	sessionsLeftRunning,
	sessionsLeftRunningDetail,
	withCloseDeadline,
} from "./cleanupDeadline.js";
import { canonicalise } from "../cli/canonical.js";
import {
	installExtensions,
	listExtensions,
	uninstallExtensions,
} from "../cli/extensionCommands.js";
import { openFileInWorkbench } from "../cli/openFiles.js";
import { WaitSelectionReturns } from "../cli/waitReturn.js";
import type {
	ControlOpenRequest,
	ControlPosition,
	TerminalProfileAnswer,
} from "../cli/protocol.js";
import { workspaceRootFor } from "../cli/resolve.js";
import {
	routeOpen,
	type OpenReason,
	type RoutableWorkspace,
} from "../cli/route.js";
import {
	AgentProfile,
	agentsInspection,
	agentProfileId,
	displayPath,
	locationKey,
	agentId as parseAgentId,
	remoteAuthorityOf,
	surfaceKeyName,
	workspaceId as parseWorkspaceId,
	workspaceLocation,
	type AgentProfileKind,
	type AgentReconciliation,
	type CloseStep,
	type UnsavedEditorsInspection,
	type Workspace,
	type WorkspaceId,
	type WorkspaceLocation,
	gitPlaceOf,
	relocatedOnSameMachine,
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
	AppError,
	AppErrorCode,
	type IntentOutcome,
	type OperationToken,
	type ProviderEvent,
	type UserIntent,
	type WorktreeDisposition,
} from "../../model/intents.js";
import { closingDeletesWorktree } from "../../model/worktrees.js";
import { zoomedTerminalFontSize } from "../../model/terminalZoom.js";
import {
	agentSubject,
	portRefusal,
	type RefusedOperation,
} from "./agentFailure.js";
import { AppModel, type NavigationSelection } from "../../model/appModel.js";
import {
	activeProfile,
	DEFAULT_PROFILE,
	profileLocations,
} from "../../model/profile.js";
import { seedProfileSettings } from "../profileSeed.js";
import {
	ConfigStore,
	defaultConfigPaths,
	withProfileRuntimes,
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
	TypedFailure,
	withDetail,
	withSummary,
	unavailableAgentProfiles,
	InvalidIntent,
} from "../../model/wire.js";
import {
	isQuitting,
	shellWindow,
	shellWindowIfCreated,
} from "./shellWindow.js";
import {
	reconcileEditors,
	type KeyboardHalf,
	type SurfaceArrangement,
} from "./windowLayout.js";
import {
	chromeAudience,
	displayAudience,
	projectionAudience,
} from "./publishAudience.js";
import { WindowAttention, platformDock } from "./windowAttention.js";

/**
 * Which app-wide condition the repository watcher's diagnostic is.
 *
 * One source, so one name: every look publishes either a reason the last round
 * was incomplete or nothing at all, so a notice raised under this name is
 * replaced or retracted by the next look and by nothing else.
 */
const REPOSITORY_STATUS_CONDITION = "repository_status";
import {
	crash,
	InvariantViolation,
	isInvariantViolation,
} from "./invariant.js";
import {
	deadEditorKeys,
	editorGaveUpFailure,
	EditorSupervisor,
} from "./editorSupervisor.js";
import { appearanceMode } from "./appearanceMode.js";
import { editorElement, shellTitleFor } from "./shellTitle.js";
import type { ShellPalette } from "../../ipc/palette.js";
import type { WorkbenchView } from "./workbenchView.js";
import { agents, inspectWorkspaceResources, terminals } from "./adapters.js";
import {
	closeEditor,
	editorInspection,
	editorRuntimeState,
} from "./editorInspection.js";
import {
	discardUnsavedEditors,
	readUnsavedEditors,
	type WorkbenchContents,
} from "./workbenchUnsaved.js";
import { wireTerminals, type TerminalWiring } from "./terminalWiring.js";
import { REPOSITORY_LOOKUP_DEADLINE_MS } from "../runtime/cadence.js";
import {
	CancellationToken,
	scratchTarget,
	socketName,
	workspaceTarget,
	type TerminalPreflight,
} from "../terminal/ports.js";
import {
	enclosingRoot,
	readCliEntryBundle,
	readTerminalEntryBundle,
	CLI_ENTRY_BUNDLE,
	terminalLauncherPath,
	TERMINAL_ENTRY_BUNDLE,
} from "../terminal/launcher.js";
import { controlSocketPath } from "../cli/protocol.js";
import { windowTerminalLauncher } from "./loginEnvironment.js";
import { OperationDeadline } from "../terminal/command.js";
import { wireAgents } from "./agentWiring.js";
import { AgentReconcilers, type ReconcileHost } from "./agentReconciler.js";
import {
	ContainerRuntime,
	devContainerConfigIn,
} from "../runtime/container.js";
import { MachineConditions } from "./machineConditions.js";
import { MainServicesGate, type MainServices } from "./mainServices.js";
import {
	disposeRuntime,
	liveRuntimes,
	gitRuntimeFor,
	localRuntime,
	runtimeById,
	runtimeForRequested,
	runtimeFor,
	runtimeIdFor,
	runtimeMachine,
	setRuntimeProfile,
} from "../runtime/registry.js";
import { ReleaseRehDelivery } from "../runtime/remoteServer.js";
import {
	ReleaseTmuxDelivery,
	tmuxInstallDirectory,
} from "../runtime/tmuxDelivery.js";
import type {
	Runtime,
	RuntimeId,
	TerminalLauncher,
} from "../runtime/runtime.js";
import { resolveExecutable } from "./runtimes.js";
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
import type { AgentSessions } from "../agent/sessions.js";
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
	fetchBranchFrom,
	findBranch,
	refreshOrigin,
	remoteForRepository,
	listBranches,
	workspaceFailure,
	worktreeForBranch,
	type GitCommand,
} from "./git.js";
import {
	disposeWorktreeFolder,
	folderUnreadableReason,
	readWorktreeFolder,
} from "./worktreeFolder.js";
import { findClones } from "./issues.js";
import {
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
import type { GitHubItem } from "../../model/github.js";
import { renderAgentAction } from "../../model/agentActions.js";
import type { ConfiguredAgentAction } from "../../model/config.js";
import { DEFAULT_SCRATCH_DAILY } from "../../model/scratchDay.js";
import { MidnightTimer, scratchDay } from "./scratchDay.js";
import { RepositoryStatusWatcher } from "./repositoryStatus.js";
import { installMenu, refreshMenu } from "./menu.js";
import { installKeyboard, setChordLayout } from "./keyboard.js";
import { describeChordKey } from "../../model/chordKeys.js";
import {
	COMMANDS,
	defaultKeybindings,
	keysForCommand,
	resolveBindings,
	type CommandNeeds,
} from "../../model/commands.js";
import {
	openSettingsWindow,
	publishSettingsSnapshot,
	settingsWindowContents,
	settingsWindowIsFocused,
} from "./settingsWindow.js";

/** `apps/desktop/out/main/shell` -> `apps/desktop`. */
const APP_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);

/**
 * What a thrown thing said, for a detail line.
 *
 * Not `errorWire`: that turns anything unrecognised into
 * `native_unavailable`, an app-wide sentence, and the whole point of routing a
 * workbench failure to its Workspace is that it is not one.
 */
/**
 * Whether this view is a workbench somebody could type into.
 *
 * Three states are one fact. A view DevHub destroyed, a view whose contents
 * Electron destroyed, and a view whose renderer was killed — by the OS during
 * sleep, or by hand — are all "there is no workbench here", and only the first
 * two answer `isDestroyed`. The third keeps the `WebContents` object, so a
 * check that asked only that question said yes about a dead process.
 */
function isLiveWorkbench(view: WorkbenchView): boolean {
	return !view.isDestroyed() && !view.webContents.isCrashed();
}

function describeFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * How long an open may take before it counts as having failed.
 *
 * Because an open that never settles is the one failure with no symptom at
 * all: the promise stays in `editorOpens`, every later caller joins it, and
 * the folder has no workbench, no restart and nothing on screen for ever. It
 * is reachable — VS Code's window service, asked to open a folder whose window
 * is a renderer that has just been killed, can route the request into that
 * dead window and never answer. Generous, because a cold workbench really does
 * take seconds; finite, because silence is not an outcome.
 */
const EDITOR_OPEN_TIMEOUT_MS = 30_000;

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
 * The folder URI a workbench is opened on.
 *
 * One function for both kinds, because the difference between them *is* this
 * URI and nothing else: everything on either side of the open — the view, the
 * supervision, the surface key — is the same code. `remoteAuthorityOf` composes
 * the authority, so the string this hands VS Code and the string Open Remote -
 * SSH is asked to resolve come from one place.
 */
function folderUriFor(location: WorkspaceLocation): URI {
	const authority = remoteAuthorityOf(location);
	return authority === undefined
		? URI.file(location.path)
		: URI.from({ scheme: "vscode-remote", authority, path: location.path });
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

/** The window a running workbench is; see `workbenchContentsOf`. */
function workbenchOf(codeWindow: ICodeWindow | undefined): ICodeWindow {
	if (!codeWindow) {
		throw new InvariantViolation("a running workbench has no window");
	}
	return codeWindow;
}

/**
 * The contents a running workbench's requests go to. Only a workbench
 * `editorRuntimeState` called running is asked anything, and a running one
 * has contents by that definition — so there being none is a broken rule.
 */
function workbenchContentsOf(
	codeWindow: ICodeWindow | undefined,
): WorkbenchContents {
	const contents = workbenchOf(codeWindow).win?.webContents;
	if (!contents) {
		throw new InvariantViolation("a running workbench has no contents");
	}
	return contents;
}

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
	 * The workbench view showing each place, by that place's key.
	 *
	 * The key is `locationKey` — a local folder's canonical path, unchanged from
	 * when that was the only kind, and `ssh://host/path` for a folder on another
	 * machine. A path stopped being enough
	 * the moment two machines could both have `/src/api`: they are two
	 * Workspaces, two windows and two rows, and one map entry would have made
	 * them share a workbench.
	 */
	private editorViewId(folder: string): number | undefined {
		return shellWindowIfCreated()?.editorViewId(folder);
	}

	/**
	 * The one budget for "this folder has no workbench and the last try failed".
	 *
	 * Every way that can happen — a renderer the OS killed, an open that
	 * rejected, a view that never arrived — is counted here, against one
	 * ceiling, with one backoff. See `editorSupervisor.ts`.
	 */
	private readonly editorSupervisor = new EditorSupervisor();
	/** One in-flight workbench open per folder, shared by concurrent callers. */
	private readonly editorOpens = new Map<
		string,
		Promise<WorkbenchView | undefined>
	>();

	/**
	 * The one place anything waits for VS Code's main process to be usable.
	 *
	 * Everything that needs a workbench goes through `services()`, and
	 * `services()` goes through here — so a request that arrives during startup
	 * is answered late rather than dropped or thrown. See `mainServices.ts`.
	 */
	private readonly mainServices = new MainServicesGate();
	/** Handed over by `setServices`; released to the gate by `markReady`. */
	private handedOverServices: MainServices | undefined;
	private config: Config | undefined;
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
	/** This profile's user-data directory, from `startRuntimes`. */
	private userDataPath: string | undefined;
	/** The launcher installation, asked for once per machine. */
	private readonly launchers = new Map<RuntimeId, Promise<TerminalLauncher>>();
	/** What became of each of those, for `devhub --metrics`. */
	private readonly launcherStatus = new Map<
		RuntimeId,
		TerminalLauncherStatus
	>();
	private agentSessions: AgentSessions | undefined;
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
	private stopWatchingConfig: (() => void) | undefined;

	constructor(
		readonly configStore: ConfigStore,
		private readonly stateStore: JsonStateStore,
		private readonly cliArgs: NativeParsedArgs,
		model: AppModel,
		state: PersistedAppState,
		config: Config | undefined,
		/**
		 * How the *previous* run ended, captured before this one marked itself
		 * started — after that the flag describes this run, not the last one.
		 */
		private readonly previousExitValue: "clean" | "unclean" | "unknown",
		/** Whether this run started from a state file that did not exist. */
		private readonly freshState: boolean,
	) {
		this.state = state;
		this.config = config;
		if (config) {
			// The same call `adoptConfig` makes, for the config this run started
			// with. Without it DevHub would run in `auto` until the first save.
			appearanceMode().apply(config.appearance.mode);
		}
		this.coordinator = new AppCoordinator(model);
		// The overlay has to know whether the workbench a question belongs to is
		// the one on screen. Views are the window's; surface keys are the
		// model's; this is the one place the two are joined.
		shellWindow().setSurfaceKeyResolver((view) =>
			this.editorSurfaceKeyForView(view.id),
		);
		// The window's name is a function of the model and of what the
		// workbench on screen calls itself. The model half is pushed from
		// `projectionChanged`; this is the other half arriving on its own.
		shellWindow().onTitleChanged(() => {
			this.refreshWindowTitle();
		});
		this.registerIpc();
		this.watchConfig();
	}

	//#region lifecycle

	/**
	 * Take the main-process services from VS Code's DI container.
	 *
	 * They are only *held* here. The container is built several steps before
	 * `CodeApplication.startup()` has finished, and a workbench opened in that
	 * window would be opened into an application still assembling itself. The
	 * moment they may be used is `markReady`, and that is the moment the gate
	 * opens — one gate, opened once, at the one point where using them is
	 * correct.
	 */
	setServices(services: MainServices): void {
		this.handedOverServices = services;
	}

	/**
	 * The main-process services, waiting for them if startup has not got there.
	 *
	 * This is a promise rather than a value because the alternative is asking
	 * every caller to know how far into startup it is. It never rejects and it
	 * never resolves to nothing: "not yet" is a duration, not an outcome.
	 */
	private services(): Promise<MainServices> {
		return this.mainServices.wait();
	}

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
			? config?.runtimes.tmux_socket_name
			: profile.tmuxSocketName;
		if (
			(this.freshState || !profile.isDefault) &&
			configuredSocket !== undefined &&
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
			enabled: config?.general.import_login_environment ?? true,
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
		this.terminalsWiring = wireTerminals({
			config,
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
		this.agentSessions = wireAgents({
			runtimeFor: (machine) => terminalRuntimes.for(runtimeById(machine)),
			model: () => this.coordinator.model,
			machineOf: (workspaceId) => this.machineOf(workspaceId),
		});
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
			accounted: () => {
				const workspaces = new Set<string>();
				const agents = new Set<string>();
				for (const workspace of this.coordinator.model.workspaces) {
					workspaces.add(workspace.id);
					for (const agent of workspace.agents) agents.add(agent.id);
				}
				return { workspaces, agents };
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
		this.repositoryStatus.start();
		this.watchForWake();
		this.midnight.arm();
	}

	/**
	 * Scratch moves to the new day's folder at each local midnight.
	 *
	 * Only the identity moves: yesterday's folder stays open as an ordinary
	 * row with its Agents and its workbench exactly as they were. A wake and a
	 * settings change re-aim the timer (see `MidnightTimer`); the launch itself
	 * was reconciled before the model existed (`createAppController`).
	 */
	private readonly midnight = new MidnightTimer(() => {
		// Not caught here: a failure nothing can recover from goes to the main
		// process's root (`mainFailureRoot.ts`) like any other.
		void this.adoptToday();
	});

	/** Make today's folder and make it Scratch. See `AppModel.adoptScratchDay`. */
	private async adoptToday(): Promise<void> {
		const today = await scratchDay(
			scratchTemplate(this.config),
			new Date(),
			homedir(),
		);
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
			this.checkEditorHealth();
			// A Mac asleep across midnight wakes to a timer aimed at a moment
			// that has passed, or at one in a timezone it has left.
			this.midnight.rearm();
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
			toggleIntegratedTerminal: () => {
				this.toggleIntegratedTerminal();
			},
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
		installKeyboard({
			snapshot: () => this.snapshot(),
			selectContext: (context, presentation, focus) => {
				// Armed before the selection, consumed after the keyboard lands
				// (`ShellWindow.focusTerminalOnArrival`). Both halves are needed
				// and neither can be the other's: the selection is what puts the
				// workbench on screen, and only main knows when the keys got
				// there. A workbench that is not up has no view to arm against
				// and the intent is dropped there, which is the honest end of
				// asking for the shell of an editor that is not running.
				if (focus === "terminal" && context.kind === "workspace") {
					const editorKey = this.coordinator.model.workspace(
						parseWorkspaceId(context.workspaceId),
					)?.key;
					if (editorKey !== undefined) {
						shellWindow().focusTerminalOnArrival(editorKey);
					}
				}
				this.dispatchOwn(
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
			toggleScratch: () => {
				// A selection change like any other, so it needs nothing the
				// ordinary `select_context` path does not already do.
				this.dispatchOwn({ type: "toggle_scratch" });
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
				// The base is the setting's, and a settings file that would not
				// parse has no base to step from. There is nothing to zoom
				// relative to, and inventing one would silently zoom from a
				// size nobody chose.
				if (!config) return false;
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
			closeAgent: (agentId) => {
				this.requestCloseAgent(agentId);
			},
			closeWorkspace: (workspaceId) => {
				this.closeWorkspaceOrWorktree(workspaceId);
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
		});
		this.applyChordLayout();
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
		const spec = this.config?.keybindings ?? defaultKeybindings();
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
		const spec = this.config?.keybindings ?? defaultKeybindings();
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
		this.dispatchOwn({ type: "swap_split_focus" });
		this.placeKeyboardOnSurface();
	}

	/**
	 * Put the keyboard on whatever the selection has on screen.
	 *
	 * One sentence now, where it used to be two. An Agent's pane was drawn by
	 * the App Shell page, so "focus the Agent" could not be a focus call at
	 * all — it was a message asking that page to go and find the pane in its
	 * own DOM, which is the whole of what `shell/focusHome.ts` was. The Agents
	 * are a child of the window like a workbench now, so both halves are the
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
				// that, from `agentIsIdle` — and then there is no confirmation in
				// the outcome and nothing to open.
				this.raiseCloseConfirmation(outcome, agentId);
			},
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
	 * Show or hide the terminal in the workbench on screen.
	 *
	 * `Cmd+Q T` and View ▸ Toggle Integrated Terminal are the same command and
	 * this is it. The command itself is the workbench's — DevHub has no panel to
	 * toggle — so it is *forwarded*, not reimplemented, over `vscode:runAction`,
	 * which is upstream's own way for main to raise a workbench command (it is
	 * how the touch bar and the dock menu do it). Forwarding the keystroke
	 * instead was the alternative and is worse: it would have to arrive as
	 * whatever key the person has bound the toggle to in *their* keybindings,
	 * which DevHub does not know and must not guess.
	 *
	 * No workbench on screen is a no-op, like every other chord with nothing to
	 * act on.
	 */
	toggleIntegratedTerminal(): void {
		shellWindow().revealedView()?.webContents.send("vscode:runAction", {
			id: "workbench.action.terminal.toggleTerminal",
			from: "menu",
		});
	}

	/**
	 * How a workbench's integrated terminal attaches to DevHub's session.
	 *
	 * A terminal in DevHub is a tmux session on DevHub's socket, and it always
	 * was; what changed is who runs the client. It used to be a surface of
	 * DevHub's own with an xterm and a PTY beside the workbench; it is now the
	 * workbench's integrated terminal, which is a better terminal than DevHub
	 * will ever write and is where a person looks for one. So DevHub keeps the
	 * half only it can do — owning the socket, the names and the markers — and
	 * hands out the command line for the half VS Code does.
	 *
	 * What arrives is the directory VS Code started the terminal in, and there
	 * is one rule for turning it into a session: it belongs to the Workspace
	 * that contains it, and to Scratch — today's daily-folder Workspace — when
	 * no Workspace does.
	 */
	async terminalProfileFor(
		machine: string,
		root: string | null,
	): Promise<TerminalProfileAnswer> {
		const wiring = this.terminalsWiring;
		if (!wiring) throw new Error("the terminal runtime is not running");
		// Only the Workspaces on the machine that is asking. A path is a path on
		// one computer: `/srv/app` on two hosts is two folders, and a matcher
		// given both roots would answer one of them with the other's session —
		// which is not a slower answer, it is a shell in the wrong place.
		const workspaces = this.coordinator.model.workspaces.filter(
			(candidate) => runtimeIdFor(candidate.location) === machine,
		);
		const enclosing = enclosingRoot(
			workspaces.map((candidate) => candidate.root),
			root,
		);
		const workspace = workspaces.find(
			(candidate) => candidate.root === enclosing,
		);
		// The session is on the machine that asked, because that is the machine
		// its tmux server is on: a workbench's integrated terminal runs where
		// its pty host runs, and an argv naming this Mac's socket would attach
		// nothing over there. The target carries the machine, so the adapter
		// that answers is that machine's and not whichever one is at hand.
		const asking = runtimeMachine(machine);
		if (!workspace) {
			// Scratch is a folder on this Mac, so there is no Scratch on a host
			// to fall back to: a terminal over there in a directory no Workspace
			// contains has no session, and saying so is the honest end of it.
			if (asking !== "local") {
				throw new Error(
					`${root ?? "this directory"}${runtimeById(asking).where} is not inside any Workspace DevHub has open there, so there is no terminal session for it.`,
				);
			}
			const scratch = this.scratchWorkspace();
			return wiring.service.surfaces.profile(
				workspaceTarget(asking, scratch.id, scratch.root),
			);
		}
		return wiring.service.surfaces.profile(
			workspaceTarget(asking, workspace.id, workspace.root),
		);
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
				throw asIpcError(
					errorWire(
						workspaceFailure(
							`${what} could not be found within ${String(
								REPOSITORY_LOOKUP_DEADLINE_MS / 1000,
							)}s. Something DevHub asked — a workspace source, or git — did not answer.`,
						),
					),
				);
			}
			if (cancel.isCancelled) {
				// Nobody is reading this: the page stopped waiting, which is why
				// the lookup stopped. It is thrown rather than answered with an
				// empty list so that a caller who somehow is still listening
				// cannot mistake "withdrawn" for "there is nothing".
				throw asIpcError(
					errorWire(workspaceFailure("The lookup was cancelled.")),
				);
			}
			throw asIpcError(errorWire(error));
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

	/**
	 * The window came forward, or went away.
	 *
	 * Wired to `ShellWindow` in `bootstrapShell`. It is a fact about the person,
	 * so it goes into the model as an intent like every other one; what the
	 * model does with it — reading whatever is on screen when DevHub comes back
	 * — is the model's rule and is stated there.
	 */
	/**
	 * The folder a workbench was asked for is not on disk.
	 *
	 * Told to the model as an intent, the way a focus change is: the model
	 * decides what an absent folder means for the workspace (`unavailable`,
	 * with `root_missing` as the reason), and the projection change that
	 * follows is what takes the workspace out of `syncEditorViews`'s list.
	 * A folder no workspace owns is nobody's to mark.
	 */
	private noteFolderUnreadable(
		folder: string,
		reason: "root_missing" | "root_inaccessible",
	): void {
		const workspace = this.coordinator.model.workspaces.find(
			(candidate) => candidate.root === folder,
		);
		if (!workspace) return;
		// Through `dispatchOwn`, which is what "DevHub raised this intent
		// itself" means everywhere else: it drains, and a refusal goes to the
		// root. This used to have its own copy of both, with the drain skipped
		// on failure — the second way of saying one thing, and the one that was
		// slightly different.
		this.dispatchOwn({
			type: "workspace_root_unreadable",
			workspaceId: workspace.id,
			reason,
		});
	}

	windowFocusChanged(focused: boolean): void {
		// Whether the window is in front decides how loudly an unread Agent is
		// announced — a badge either way, a Dock bounce only while the person
		// is somewhere else. See `windowAttention.ts`.
		this.attention.windowFocusChanged(focused);
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

	markReady(): void {
		const services = this.handedOverServices;
		if (!services) {
			// Bootstrap order, not a race: nothing waits this out, because the
			// only way here is a startup that skipped `setServices` entirely.
			throw new Error(
				"the App Shell was marked ready before the main services were handed over",
			);
		}
		this.mainServices.register(services);
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
		this.stopWatchingConfig?.();
		this.stopHearingReconnections?.();
		// The flag is written first, and on purpose: it records that the person
		// asked to quit, which is true whether or not the teardown below manages
		// to finish. Writing it afterwards would report a crash every time a
		// runtime was slow to let go.
		markCleanShutdown(this.state);
		await this.saveState();
		this.agentReconcilers.stop();
		this.stopWatchingWake?.();
		this.midnight.stop();
		this.repositoryStatus.stop();
		// Quitting detaches clients and leaves every session — an Agent's as
		// much as a terminal's. That is the point of putting them on the same
		// runtime: coming back finds the same work still running.
		this.terminalsWiring?.service.dispose();
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
		const config = this.requireConfig();
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
		);
	}

	agentProfiles(): AgentProfiles {
		this.profileSequence += 1;
		const config = this.config;
		if (!config) {
			// A config that would not parse is not an empty profile list, and the
			// picker has to be able to tell those apart.
			return unavailableAgentProfiles(
				this.profileSequence,
				"configuration_invalid",
			);
		}
		return agentProfilesWire(
			config.agentProfiles.map(toDomainProfile),
			this.profileSequence,
		);
	}

	/**
	 * The config is the only source for appearance and profiles, so a file that
	 * would not parse is reported rather than answered with silent defaults.
	 */
	private requireConfig(): Config {
		if (!this.config) {
			throw asIpcError(errorWire(new AppError(AppErrorCode.PortUnavailable)));
		}
		return this.config;
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
		this.sendToDisplay(CHANNELS.appCondition, {
			source,
			...(summary === undefined ? {} : { summary }),
		} satisfies AppConditionWire);
	}

	private publishSnapshot(): void {
		this.send(CHANNELS.snapshotChanged, this.snapshot());
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
		// An Agent nobody has read yet is the window asking to be looked at,
		// and it is a fact about the projection like the menu and the title —
		// so it is answered here, where everything that follows the projection
		// is answered, rather than by a page that can only be seen when there
		// is no workbench over it. See `windowAttention.ts`.
		this.attention.observe(this.snapshot());
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
		this.releaseIdleMachines();
		this.syncEditorViews();
		// What is on screen follows the selection, wherever the selection
		// changed — a menu command, a restored session, or the page.
		this.syncEditorViewInBackground();
	}

	/**
	 * Say what this window is, now.
	 *
	 * Every part of the answer is read at the moment it is asked for: the model
	 * for the Workspace and the Agent's word, the window for what the workbench
	 * on screen calls itself. Nothing is cached, so there is no second copy to
	 * go stale, and calling this more often than necessary costs a string.
	 */
	private refreshWindowTitle(): void {
		const shell = shellWindow();
		if (shell.window.isDestroyed()) return;
		const snapshot = this.coordinator.snapshot();
		const title = shellTitleFor({
			selection: snapshot.selection,
			workspaces: snapshot.workspaces,
			editorElement: editorElement(
				shell.revealedTitle(),
				vscodeProduct.nameLong,
			),
		});
		shell.window.setTitle(title);
		// The same string, once, to both places that show it. DevHub's own
		// title bar is drawn by the page, and a page that composed the name a
		// second time would be a window whose bar and whose Mission Control
		// entry could disagree — about the very thing a title is for.
		this.send(CHANNELS.windowTitleChanged, title);
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
		const appearance = this.config?.appearance;
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
		const restarting =
			editorKey !== undefined && this.restartingEditors.has(editorKey);
		// Nothing is drawn in the content area until the model is ready, and a
		// workbench being rebuilt is a state of the area rather than a reason
		// to leave it — in both cases the page has the rectangle and no
		// workbench is over it.
		const surface: SurfaceArrangement =
			snapshot.readiness !== "ready" || restarting
				? { kind: "none" }
				: layout.kind === "agent"
					? { kind: "agent" }
					: editorKey === undefined
						? { kind: "none" }
						: layout.kind === "split"
							? { kind: "split", editorKey, ratio: snapshot.splitRatio }
							: { kind: "editor", editorKey };
		// Both panes of a split are drawn; which of them holds the keyboard is
		// which half is selected. An Agent selected `beside` is the Agent half
		// in front, and the workspace selected `beside` is the editor half.
		const keyboard: KeyboardHalf = this.keyboardInSidebar
			? "sidebar"
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
			titleBar: appearance?.titleBar === "hidden" ? "hidden" : "shown",
			density:
				appearance?.sidebarDensity === "comfortable"
					? "comfortable"
					: "compact",
			sidebar: {
				width: this.sidebarWidthPreview ?? snapshot.sidebar.width,
				collapsed: snapshot.sidebar.collapsed,
			},
			surface:
				surface.kind === "split" && this.splitRatioPreview !== undefined
					? { ...surface, ratio: this.splitRatioPreview }
					: surface,
			keyboard,
		});
		// The page draws its own states in the same rectangle the workbench is
		// laid into, and the split's seam is where that rectangle ends. It is
		// given the number rather than asked for it, so there is no
		// arrangement in which the two can disagree about where the seam is.
		this.send(CHANNELS.workbenchAreaChanged, shell.workbenchArea());
		// And the Sidebar is told its own, for one reason: a row has to be
		// able to say where it is *in the window*, so that its tooltip is
		// placed against the window rather than against the column it is in.
		// Nothing about the Sidebar's own drawing depends on this — the
		// column's width is the model's — which is why it is the rectangle and
		// not just the origin: a row scrolled half out of the column has half
		// an anchor, and a tooltip pointing at the invisible half points at
		// nothing.
		this.send(CHANNELS.sidebarAreaChanged, shell.sidebarArea());
	}

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
	private splitRatioPreview: number | undefined;

	/** Folders whose workbench is being rebuilt, as the page is told. */
	private readonly restartingEditors = new Set<string>();

	private publishAppearance(): void {
		if (!this.config) return;
		this.send(CHANNELS.appearanceChanged, this.appearance());
		// The title bar and the sidebar's density are two of the numbers the
		// layout is made of: changing either moves every child in the window.
		this.publishLayoutState();
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
			this.coordinator.model.workspaces.map((workspace) => {
				// Where this Workspace's *git* runs, which is not always where its
				// terminals do. For a dev container it is this Mac, against the
				// bind-mounted folder — so a stopped container costs a row its
				// terminals and not its branch, and the watcher here is a real
				// `fs.watch` rather than polling `refs` through a `docker exec`.
				const { runtime, root } = gitRuntimeFor(workspace.location);
				return { id: workspace.id, root, runtime };
			}),
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
			const after = this.orderedWorkspaceIds();
			if (before.join("\0") !== after.join("\0")) {
				this.send(CHANNELS.snapshotChanged, this.snapshot());
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
		return (this.config?.agentActions ?? [])
			.filter((action) => action.enabled)
			.map((action) => ({
				trigger: action.trigger,
				id: action.id,
				displayName: action.display_name,
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
		failure: RefusedOperation,
	): void {
		this.reportFailure(failure);
		this.accept({ type: "operation_failed", token });
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
				this.publishError(
					failure.detail === undefined
						? errorWireAt(failure.code)
						: withDetail(errorWireAt(failure.code), failure.detail),
				);
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
			// A completion the coordinator refused is a real failure — an operation
			// that no longer exists, a token that does not match — and it belongs on
			// screen rather than in a log nobody reads.
			//
			// A *stale* completion is the one exception, and it is not an
			// exception to the rule so much as a different fact: the operation it
			// answers was already settled by something newer, on purpose. The
			// reconciler supersedes its own rounds by design, and a person told
			// "an operation went stale" every time DevHub asked the provider a
			// fresher question learns nothing and stops reading the error area.
			if (isUnknownOperation(error)) {
				// A completion for an operation that was never started cannot be
				// answered by anybody: there is no request waiting, no surface it
				// belongs to, and no action to offer. It used to be published as an
				// app-wide notice — through `errorWire`, so under whatever code that
				// mapping happened to pick — from inside a loop, which is how one
				// wiring bug became a sentence that flickered. It is a bug in
				// DevHub's own flow and it stops the process.
				crash(error);
			} else if (!isStaleCompletion(error)) {
				this.publishError(errorWire(error));
			}
			this.reject(id, error);
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
				new TypedFailure(errorWireAt("operation_timed_out")),
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
							this.publishError(errorWire(event.error));
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
					this.send(CHANNELS.snapshotChanged, latest);
					this.projectionChanged();
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
				);
				return;
			case "inspect_workspace":
				await this.inspect(effect.token, effect.workspaceId);
				return;
			case "launch_agent":
				await this.launchAgent(
					effect.token,
					effect.workspaceId,
					effect.agentId,
					effect.profile,
				);
				return;
			case "stop_agent":
			case "terminate_agent":
				await this.stopAgent(effect.token, effect.agentId, effect.kind);
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
		return `${this.stateStore.path}: ${
			error instanceof Error && error.message.length > 0
				? error.message
				: String(error)
		}`;
	}

	private async persist(token: OperationToken): Promise<void> {
		try {
			this.state = applySnapshot(this.state, this.coordinator.snapshot());
			await this.saveState();
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
				detail: `${path}${whereRequested(requested)} could not be opened as a workspace: ${error instanceof Error ? error.message : String(error)}`,
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
		const action = this.config?.agentActions.find(
			(candidate) => candidate.id === actionId && candidate.enabled,
		);
		if (!action) {
			throw workspaceFailure(
				`There is no agent action called \`${actionId}\` in the configuration.`,
			);
		}
		// The branch is the one variable a shortcut knows, and it comes from the
		// same projection the buttons were drawn from — so the message names the
		// branch the person was looking at when they pressed it.
		const branch = this.lastRepositoryStatus.workspaces.find(
			(entry) => entry.workspaceId === agent.workspaceId,
		)?.branch;
		this.sayToAgent(
			agent.id,
			agent.profile.kind,
			action,
			branch === undefined ? {} : { BRANCH: branch },
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
	 * Compose one action for one Agent and put it where it will be sent.
	 *
	 * Every template DevHub says goes through here — the Issue flow's first
	 * message and the three shortcut buttons alike — because they are one act
	 * with one difference: what fired it. Rendering, the review decision, and
	 * the sheet are therefore written once. A second caller that queued its own
	 * text directly would be a second answer to "does this get looked at first",
	 * and one of the two answers would eventually be the wrong one.
	 *
	 * `confirm_before_send` is the action's, not the caller's. A short, standing
	 * instruction like "commit what is here" is right every time and can be
	 * turned off; anything a person wants to glance at first stays on, which is
	 * the default because a sheet nobody wanted costs a keystroke and a sentence
	 * nobody read costs a turn of somebody's agent.
	 */
	private sayToAgent(
		agentId: ReturnType<typeof parseAgentId>,
		kind: AgentProfileKind,
		action: ConfiguredAgentAction,
		values: Readonly<Record<string, string>>,
	): void {
		const text = renderAgentAction(action.template, values, kind);
		const review = action.confirm_before_send;
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
	): void {
		const started = this.coordinator.model.workspaces
			.flatMap((workspace) => workspace.agents)
			.find((agent) => !before.has(agent.id));
		if (!started) return;
		// The action the person chose in the flow, and nothing else. No action
		// means they have none configured, which is a decision — the agent starts
		// and DevHub says nothing — rather than a gap to fill with a default.
		if (actionId === undefined) return;
		const action = this.config?.agentActions.find(
			(candidate) => candidate.id === actionId && candidate.enabled,
		);
		if (action === undefined) return;
		this.sayToAgent(started.id, started.profile.kind, action, {
			// One pair of names for either kind. A person's actions are their own
			// wording, written before pull requests were accepted at all, and a
			// second pair meaning the same thing would make every template that
			// wanted to work for both say everything twice. `{{ISSUE_URL}}` is
			// the URL of the thing that was assigned, whichever it was.
			ISSUE_URL: gitHubItemUrl(item),
			ISSUE_NO: String(item.number),
		});
	}

	/**
	 * The profile an Agent is launched with.
	 *
	 * The combination rule, in one place: **the profile's own arguments first,
	 * then the caller's, appended in the order they were given.** Nothing is
	 * deduplicated and nothing is reordered, because the profile is the base
	 * command and the extra arguments are what a person added to this one run
	 * — and an agent command reads its last flag as the winning one.
	 *
	 * They go into the profile *snapshot* rather than being carried alongside
	 * it, because that snapshot is what the Agent keeps for its whole life: an
	 * Agent's record then says what it was actually started with, and a later
	 * edit to the configured profile still cannot rewrite a running Agent.
	 *
	 * The command is looked up here too, in the launch environment's PATH, and
	 * the Agent is started from the absolute path that lookup returns. Passing
	 * the bare name to tmux instead would hand the search to a *different* PATH
	 * than the one DevHub resolved its own runtimes in — which is how a profile
	 * whose program is plainly on the person's PATH failed to start while tmux,
	 * found by the same kind of name, worked. And a name that resolves to
	 * nothing is said out loud rather than becoming a session that dies on
	 * `exec` a moment later, with nothing left to read.
	 */
	private async resolveProfile(
		token: OperationToken,
		workspaceId: WorkspaceId,
		profileId: string,
		extraArgs: readonly string[],
	): Promise<void> {
		const configured = this.config?.agentProfiles.find(
			(profile) => profile.id === profileId,
		);
		if (!configured) {
			this.failOperation(token, {
				subject: "workspace",
				id: workspaceId,
				code: "runtime_unavailable",
				detail: `There is no agent profile called “${profileId}”.`,
			});
			return;
		}
		const resolved = await resolveExecutable(
			configured.command,
			this.launchEnvironment["PATH"] ?? "",
		);
		if (resolved.kind === "unavailable") {
			this.failOperation(token, {
				subject: "workspace",
				id: workspaceId,
				code: "runtime_unavailable",
				detail: this.executableMissingMessage(resolved),
			});
			return;
		}
		this.accept({
			type: "profile_resolved",
			token,
			workspaceId,
			profile: toDomainProfile({
				...configured,
				command: resolved.value,
				args: [...configured.args, ...extraArgs],
			}),
		});
	}

	private async inspect(
		token: OperationToken,
		workspaceId: WorkspaceId,
	): Promise<void> {
		const workspace = this.coordinator.model.workspace(workspaceId);
		const inspection = await inspectWorkspaceResources(
			workspaceId,
			// Only the Agents that stopping would interrupt: an idle one is not a
			// reason to ask anything, and the close stops it on the way out. The
			// rule is `agentsInspection`'s, and it is the same one `Cmd+Q X` on a
			// single Agent reads.
			agentsInspection((workspace?.agents ?? []).map((agent) => agent.status)),
			await this.inspectEditors(workspaceId),
		);
		this.accept({
			type: "workspace_inspection_completed",
			token,
			workspaceId,
			inspection,
		});
	}

	/**
	 * What the close confirmation says about this Workspace's unsaved editors.
	 * The rule is `editorInspection`'s; this finds the workbench it is about.
	 */
	private async inspectEditors(
		workspaceId: WorkspaceId,
	): Promise<UnsavedEditorsInspection> {
		const workspace = this.coordinator.model.workspace(workspaceId);
		if (workspace === undefined) return { kind: "clean" };
		const codeWindow = await this.editorWindowFor(workspace.key);
		return editorInspection(editorRuntimeState(codeWindow), () =>
			readUnsavedEditors(workbenchContentsOf(codeWindow)),
		);
	}

	/**
	 * The `CodeWindow` bound to a folder, or nothing when there is no workbench
	 * for it any more.
	 *
	 * The binding outlives the view it names: a workbench
	 * that VS Code closed, or whose view DevHub destroyed, leaves its id
	 * behind. So "there is an entry in the map" is not "there is a workbench",
	 * and asking the window service is the only answer worth having. Reading
	 * the map alone is what used to make a workspace with no editor at all
	 * report that its editor was not running.
	 */
	private async editorWindowFor(
		folder: string,
	): Promise<ICodeWindow | undefined> {
		const viewId = this.editorViewId(folder);
		if (viewId === undefined) return undefined;
		return (await this.services())
			.windows()
			.getWindows()
			.find((candidate) => candidate.id === viewId);
	}

	private async launchAgent(
		token: OperationToken,
		workspaceId: WorkspaceId,
		agentId: ReturnType<typeof parseAgentId>,
		profile: AgentProfile,
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
		const result =
			kind === "stop_agent"
				? await adapter.stop(agentId)
				: await adapter.terminate(agentId);
		this.accept(
			kind === "stop_agent"
				? { type: "agent_stop_completed", token, agentId, result }
				: { type: "agent_termination_completed", token, agentId, result },
		);
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
	 * **The editor comes first, and asks nothing.** Unsaved work was asked
	 * about once, in the confirmation, beside everything else a close would
	 * lose (`editorInspection`), and this step carries out that answer: it
	 * discards, then unloads (`closeEditor`). An unload with work still
	 * unsaved raises VS Code's own "do you want to save?" — a second question
	 * in the middle of an answered close, which is how a close once sat at
	 * "closing" until its deadline with the dialog stranded over it. A veto
	 * that survives the discard is still an answer and stops the close before
	 * anything is stopped, killed or deleted.
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
		try {
			let vetoed: CloseDiagnosticWire | undefined;
			try {
				vetoed = await withCloseDeadline(
					step,
					this.askEditorToClose(workspaceId),
				);
			} finally {
				// A question the workbench raised while this step waited — an
				// extension or a task refusing the unload — belongs to this step
				// and ends with it. Left on the picker after the step had given
				// up, it covered the app over a close that was no longer running;
				// withdrawn, it is answered with its own cancel, and the unload
				// VS Code is still holding settles as a veto.
				this.withdrawWorkbenchQuestions(workspaceId);
			}
			if (vetoed !== undefined) {
				// The workbench refused — unsaved work, most likely, and the
				// person has just been asked about it. That is a reason, not an
				// error, and nothing has been closed.
				this.failClose(token, workspaceId, step, vetoed);
				return;
			}

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

			step = "view";
			this.disposeEditorView(workspaceId);

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
			// What the tool said, and only what the tool said. `TypedFailure` is
			// how git's last stderr line and the errno sentences reach here
			// (`workspaceFailure`), and passing that through is the difference
			// between "A cleanup step did not finish" and "fatal: '…' contains
			// modified or untracked files, use --force to delete it". Nothing is
			// composed here; a failure with no words of its own carries none.
			this.failClose(
				token,
				workspaceId,
				step,
				error instanceof CloseTimeout ? error.diagnostic : "cleanup_failed",
				error instanceof TypedFailure ? error.wire.summary : undefined,
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
				`[devhub] close: ${left} could not be stopped — ${
					error instanceof Error ? error.message : String(error)
				}`,
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
	 * Take down this workspace's workbench view.
	 *
	 * After the unload, not instead of it: the unload is what saves work, and
	 * this is what takes the window away once nothing is left in it to lose. A
	 * view that is already gone — destroyed, or never built — is the state this
	 * was trying to reach, so there is nothing to report.
	 *
	 * It happens *before* the worktree is removed, because a workbench with an
	 * open folder under a directory git is about to delete is a workbench
	 * watching a directory that stops existing.
	 */
	private disposeEditorView(workspaceId: WorkspaceId): void {
		const key = this.coordinator.model.workspace(workspaceId)?.key;
		if (key === undefined) return;
		const viewId = this.editorViewId(key);
		shellWindow().unbindEditorKey(key);
		if (viewId === undefined) return;
		shellWindow().getViewById(viewId)?.destroy();
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
		// The worktree is a git fact, so it is read where this Workspace's git
		// runs — for a dev container, the folder on this Mac and not the path
		// inside it, which has no `.git` of its own to find.
		const git = gitRuntimeFor(workspace.location);
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
	 * Show the workbench view the selection resolves to, creating it the first
	 * time and keeping it afterwards.
	 *
	 * The folder is the key. A workspace and its view are two different objects
	 * with two different lifetimes, and the folder is the only thing both agree
	 * about — which is what lets "open folder" from inside a workbench and a
	 * click in the sidebar land on the same view without an ordering rule.
	 */
	private async revealEditorFor(surfaceKey: string): Promise<void> {
		const folder = this.editorKeyForSurfaceKey(surfaceKey);
		if (folder === undefined) return;
		const view = await this.ensureEditorView(folder);
		if (!view) return;
		// Nothing is revealed here, because nothing reveals anything any more:
		// what is on screen is the layout owner's answer to the selection, and
		// the only thing this open changed is that the child it names now
		// exists. So the arrangement is asked again — see
		// `ShellWindow.assertArrangement`.
		shellWindow().assertArrangement();
	}

	/**
	 * The workbench for a folder, made if it is not there yet.
	 *
	 * The one way a workbench comes into existence, called both when a folder
	 * is first known and when it is selected — so selecting is only ever a
	 * reveal, and never the moment a person pays for a whole workbench start.
	 *
	 * Concurrent callers share one attempt: startup asks for every folder at
	 * once, and a selection landing in the middle of that must join the open
	 * already in flight rather than start a second workbench for the same
	 * folder.
	 */
	private ensureEditorView(folder: string): Promise<WorkbenchView | undefined> {
		const existingId = this.editorViewId(folder);
		const existing =
			existingId === undefined
				? undefined
				: shellWindow().getViewById(existingId);
		// Present is not the same as alive. A renderer the OS killed while the
		// Mac slept leaves the view where it was, with contents nothing can be
		// asked of; handing that back said "there is a workbench here" to every
		// caller and nothing ever built the replacement. The table is corrected
		// here rather than anywhere else, because this is the one place that
		// reads it and can act on the answer.
		if (existing && isLiveWorkbench(existing)) return Promise.resolve(existing);
		if (existing) shellWindow().unbindEditorKey(folder);

		const inFlight = this.editorOpens.get(folder);
		if (inFlight) return inFlight;

		// Registered before the first `await` inside, so an open asked for twice
		// in the same tick is still one open. An open that has to wait for VS
		// Code's services is in flight from the moment it is asked for, which is
		// what stops startup from queuing one attempt per projection change.
		const attempt = withDeadline(
			this.openEditorView(folder),
			EDITOR_OPEN_TIMEOUT_MS,
			`the workbench for this folder did not open within ${String(
				EDITOR_OPEN_TIMEOUT_MS / 1_000,
			)} seconds`,
		).finally(() => {
			this.editorOpens.delete(folder);
		});
		this.editorOpens.set(folder, attempt);
		return attempt;
	}

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
	private locationForEditorKey(
		editorKey: string,
	): WorkspaceLocation | undefined {
		return this.coordinator.model.workspaces.find(
			(workspace) => workspace.key === editorKey,
		)?.location;
	}

	/**
	 * The `devhub-terminal` a window on this machine names, installed if need be.
	 *
	 * One answer per machine, remembered, because installing it is files written
	 * over a network and a socket forwarded, and a second window on the same
	 * host must not redo either. It is not remembered *across* a failure: a host
	 * that was unreachable when the first window opened is asked again by the
	 * second, which is how it recovers without a restart.
	 *
	 * However it ends, it ends in `launcherStatus`, which is what `devhub
	 * --metrics` prints. A launcher that could not be installed is otherwise a
	 * line in a log nobody has open and a terminal tab that says it a window at
	 * a time; the whole of "does this DevHub have terminals, and where" belongs
	 * in one reading.
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
					path: launcher.path,
					reason: launcher.unreachable,
				});
			},
			(error: unknown) => {
				this.launcherStatus.set(runtime.id, {
					machine: runtime.id,
					installed: false,
					path: undefined,
					reason: error instanceof Error ? error.message : String(error),
				});
				if (this.launchers.get(runtime.id) === installed) {
					this.launchers.delete(runtime.id);
				}
			},
		);
		return installed;
	}

	/**
	 * Ask one machine for its launcher.
	 *
	 * `async` so that everything here — a user-data directory that is not there
	 * yet, a bundle the build did not produce — fails the returned promise
	 * rather than the caller's stack. One failure path is what lets
	 * `terminalLauncherFor` record every outcome in one place.
	 */
	private async installTerminalLauncher(
		runtime: Runtime,
	): Promise<TerminalLauncher> {
		const userDataPath = this.userDataPath;
		if (userDataPath === undefined) {
			throw new Error(
				"a terminal launcher was asked for before the runtimes were started",
			);
		}
		return runtime.terminalLauncher({
			localLauncherPath: terminalLauncherPath(userDataPath),
			controlSocketPath: controlSocketPath(userDataPath),
			entryText: readTerminalEntryBundle(APP_ROOT),
			entryName: TERMINAL_ENTRY_BUNDLE,
			cliText: readCliEntryBundle(APP_ROOT),
			cliEntryName: CLI_ENTRY_BUNDLE,
			serverDataFolderName:
				vscodeProduct.serverDataFolderName ?? ".vscode-server",
			serverCommit: vscodeProduct.commit,
		});
	}

	/**
	 * What a window is told its DevHub terminal is.
	 *
	 * Per window, because the workbench's integrated terminal runs where its pty
	 * host runs: a window on a host must name the launcher written *there*, and
	 * naming this Mac's would be a path that machine has never heard of. It
	 * travels as a field of the window configuration, which is the channel that
	 * carries per-window facts — see `loginEnvironment.windowTerminalLauncher`
	 * for why it is not an environment variable any more.
	 *
	 * A machine whose launcher could not be installed is not a reason to refuse
	 * the window: the person asked for a folder, and a folder they can edit
	 * without a DevHub terminal is worth more than no folder at all. But it is
	 * never silent, and never guessed. Three things happen instead, and they
	 * are three because they are three different readers: the log gets the
	 * stack, `devhub --metrics` gets the machine and the reason (through
	 * `terminalLauncherFor`), and the person gets the app's own alert — because
	 * a window that opened and quietly has no terminal is exactly the failure
	 * nobody goes looking for.
	 *
	 * What is *not* done is falling back to this Mac's launcher. That was the
	 * bug: a window told nothing inherited whatever was already around, and an
	 * ssh window opened `/bin/sh` in silence. Undefined is the answer for a
	 * machine with none, and the patch refuses to invent one.
	 */
	private async windowTerminalLauncher(
		location: WorkspaceLocation | undefined,
	): Promise<string | undefined> {
		const runtime =
			location === undefined ? localRuntime() : runtimeFor(location);
		try {
			const launcher = await this.terminalLauncherFor(runtime);
			if (launcher.unreachable !== undefined) {
				console.error(
					`[devhub] terminal launcher on ${runtime.id}: ${launcher.unreachable}`,
				);
				this.publishError(
					withDetail(
						errorWireAt("terminal_launcher_unavailable"),
						`${runtime.id}: ${launcher.unreachable}`,
					),
				);
			}
			return windowTerminalLauncher(launcher);
		} catch (error: unknown) {
			console.error(
				`[devhub] terminal launcher on ${runtime.id} could not be installed`,
				error instanceof Error ? error.stack : error,
			);
			this.publishError(
				withDetail(
					errorWireAt("terminal_launcher_unavailable"),
					`${runtime.id}: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
			return windowTerminalLauncher(undefined);
		}
	}

	private async openEditorView(
		editorKey: string,
	): Promise<WorkbenchView | undefined> {
		const location = this.locationForEditorKey(editorKey);
		// Look before asking, for a folder DevHub can look at. VS Code answers an
		// open for a folder that is not there with a modal box — "The path '…'
		// does not exist on this computer." — and it answered it on every launch
		// and on every selection of a workspace whose folder had gone, because
		// nothing here had looked first. The folder's absence is a fact about the
		// workspace, so it goes into the model as one: the workspace becomes
		// unavailable, which the content area draws with Retry, Locate… and
		// Close, and `syncEditorViews` stops asking for a workbench in it.
		//
		// An ssh folder is not looked at, because there is nothing here that
		// could look: the machine that knows is the one the workbench is about to
		// connect to. Its "the folder is not there" arrives from the far end,
		// inside that pane, as Open Remote - SSH's own failure — which is where a
		// connection problem belongs, and where the person can retry it. Guessing
		// from here would put a second, wronger answer on screen.
		if (location?.kind === "local") {
			// Two answers, not one. A folder that is gone and a folder DevHub was
			// not allowed to look at are different facts about the workspace, and
			// offering Locate… for a folder that never moved is an answer to a
			// question nobody asked.
			const reason = await folderUnreadableReason(
				runtimeFor(location),
				location.path,
			);
			if (reason !== undefined) {
				console.log(`[devhub] open: '${editorKey}' — ${reason}, no workbench`);
				this.noteFolderUnreadable(location.path, reason);
				return undefined;
			}
		}
		const services = await this.services();
		// Which `devhub-terminal` this window names, decided here because this
		// is where the window's machine is already known. This is the *only*
		// place that decides it: nothing else names one, so a window that is
		// not told here has none, which is what the patched workbench is
		// written to say out loud.
		const launcher = await this.windowTerminalLauncher(location);
		// Said in the log, every time, because this is the value whose being
		// wrong is invisible from the outside: a window with another machine's
		// launcher opens perfectly and only fails when somebody presses Ctrl+`.
		console.log(
			`[devhub] open: '${editorKey}' terminal launcher — ${
				launcher ?? "none on this machine"
			}`,
		);
		// Go through VS Code's own open path, which is what creates a
		// `CodeWindow` — and therefore, through the shim, a view in the shell.
		// The same call for both kinds of place: an ssh folder differs only in
		// the URI, which carries the authority Open Remote - SSH answers for.
		const windows = await services.windows().open({
			context: OpenContext.API,
			cli: this.cliArgs,
			devhubTerminalLauncher: launcher,
			urisToOpen:
				location === undefined ? [] : [{ folderUri: folderUriFor(location) }],
			forceEmpty: location === undefined,
			forceNewWindow: true,
			noRecentEntry: true,
		});
		const opened = windows.at(0);
		const candidate =
			opened === undefined ? undefined : shellWindow().getViewById(opened.id);
		// An open can come back with a window that is not a workbench any more.
		// VS Code's window service answers an open for a folder it already has a
		// window for by routing the request *into that window* — and after a
		// renderer has been killed, that window is a shell with a dead process
		// in it. Taking it as the answer put a zombie in the table: the folder
		// had no workbench, the supervisor had nothing to count, and nothing on
		// screen said so. A dead view is not an answer, so the open failed.
		const view =
			candidate && isLiveWorkbench(candidate) ? candidate : undefined;
		if (opened && view) shellWindow().bindEditorKey(opened.id, editorKey);
		if (view) {
			this.superviseEditorView(editorKey, view);
			// A workbench that is up again is no longer restarting. Waiting for
			// `did-finish-load` is not enough on its own: a fast workbench can
			// have finished loading before this promise resolved, and a `once` on
			// an event that already happened never fires — which would leave the
			// page saying "restarting" for ever about a workbench that is right
			// there.
			const settled = () => {
				this.editorSupervisor.loaded(editorKey, Date.now());
				this.announceRestarting(editorKey, false);
			};
			if (view.webContents.isLoading()) {
				view.webContents.once("did-finish-load", settled);
			} else {
				settled();
			}
		}
		// A view no longer puts itself on screen when it is created, so the
		// arrival of one is a moment to ask the selection again what belongs
		// there — otherwise the workbench being waited for opens and nothing
		// reveals it.
		this.syncEditorViewInBackground();
		return view;
	}

	/**
	 * Watch a workbench, and stand it back up if it falls over.
	 *
	 * DevHub owns the editor's lifecycle. VS Code is one element inside
	 * DevHub's page, and an element that vanishes because its renderer was
	 * killed — or because VS Code decided to close itself — is not a decision
	 * DevHub made and must not be one the person has to notice. So a death
	 * DevHub did not ask for is answered by building the workbench again, in
	 * the same slot, for the same folder.
	 *
	 * With a delay that grows, because the interesting failure is the one that
	 * repeats: a workbench that cannot start would otherwise be rebuilt as fast
	 * as it dies, and a spinning main process is worse than a missing editor.
	 * After enough tries it stops and says so, with the count, rather than
	 * pretending nothing happened.
	 */
	/**
	 * Say that a folder's workbench is away, or back.
	 *
	 * The page needs this for two reasons that are really one: it must show
	 * *what is true* in the editor area while the workbench is being rebuilt,
	 * and it must stop telling main the native surface is on screen — because
	 * it is not, and main now refuses to be told otherwise.
	 */
	private announceRestarting(folder: string, restarting: boolean): void {
		const surfaceKey = this.coordinator.model.workspaces
			.filter((workspace) => workspace.root === folder)
			.map((workspace) => `workspace-editor:${workspace.id}`)
			.at(0);
		if (restarting) this.restartingEditors.add(folder);
		else this.restartingEditors.delete(folder);
		if (surfaceKey === undefined) return;
		this.send(CHANNELS.editorRestarting, { surfaceKey, restarting });
		// A workbench that is away is not the thing in the content area, and
		// the one that is back is; both move the arrangement.
		this.publishLayoutState();
	}

	private superviseEditorView(folder: string, view: WorkbenchView): void {
		const died = (reason: string) => {
			// Nor is a view that ended because DevHub is quitting. Every
			// workbench ends then, and by that point there is no page left to
			// tell and no shell to restart one into — the App Shell window has
			// already gone, which is how the report of the crash became a crash
			// of its own ("the App Shell window has not been created yet").
			if (isQuitting()) return;
			// A view DevHub destroyed on purpose is not a casualty: its folder is
			// no longer in the table, because that is what destroying it means.
			if (this.editorViewId(folder) !== view.id) return;
			shellWindow().unbindEditorKey(folder);
			this.editorFailed(folder, reason);
		};
		view.webContents.once("destroyed", () => {
			died("The workbench process ended.");
		});
		view.webContents.on("render-process-gone", (_event, details) => {
			died(
				`The workbench renderer stopped: ${details.reason}${
					details.exitCode === undefined
						? ""
						: ` (exit code ${String(details.exitCode)})`
				}.`,
			);
		});
		view.webContents.once("did-finish-load", () => {
			// Loading is news for the page and not for the supervisor: the page
			// has a workbench to draw again, and the supervisor has a workbench
			// that has not yet proved anything. See `EDITOR_HEALTHY_MS`.
			this.editorSupervisor.loaded(folder, Date.now());
			this.announceRestarting(folder, false);
		});
	}

	/**
	 * There is no workbench for this folder and the last attempt did not make
	 * one. The only place that decides what happens next.
	 *
	 * Every caller funnels here — the death watcher, a rejected open, an open
	 * that returned no view — because they are one condition with several
	 * causes, and a budget per cause is no budget. What comes out is either a
	 * bounded restart, at a delay that doubles, or a terminal state on the
	 * thing the failure is *about*.
	 *
	 * Nothing here publishes app-wide for a folder that has a Workspace. The
	 * failure of one workspace's workbench is that workspace's news: it goes on
	 * its row and its surface, where the person can retry it, and every other
	 * row keeps its editor. `native_unavailable` — what a bare
	 * `catch (e) => publishError(errorWire(e))` said here — was a sentence
	 * about the whole application, published once per folder per projection
	 * tick, which after a wake is several times a second.
	 */
	private editorFailed(folder: string, reason: string): void {
		if (isQuitting()) return;
		this.announceRestarting(folder, true);
		console.error(`[devhub] workbench '${folder}' failed: ${reason}`);
		const verdict = this.editorSupervisor.failed(folder, Date.now());
		if (verdict.kind === "gave-up") {
			this.reportEditorGaveUp(folder, reason, verdict.attempt);
			return;
		}
		// One timer per folder. `syncEditorViews` also skips a folder with one
		// pending, so a projection tick landing inside the wait cannot turn the
		// backoff back into a restart per tick — which is the whole point of
		// having a backoff.
		if (this.editorRestartTimers.has(folder)) return;
		const timer = setTimeout(() => {
			this.editorRestartTimers.delete(folder);
			if (this.editorSupervisor.gaveUp(folder)) return;
			void this.ensureEditorView(folder).then(
				(view) => {
					if (!view && this.wantsWorkbench(folder)) {
						this.editorFailed(folder, "No workbench view was created.");
					}
				},
				(error: unknown) => {
					this.editorFailed(folder, describeFailure(error));
				},
			);
		}, verdict.delayMs);
		(timer as unknown as { unref?: () => void }).unref?.();
		this.editorRestartTimers.set(folder, timer);
	}

	/**
	 * One deliberate look at every workbench, after the Mac has woken up.
	 *
	 * Sleep is the one event that can kill a renderer without anything in main
	 * hearing an event it trusts: the view is still in the table, its contents
	 * are gone or crashed, and the only thing that would ever have noticed is
	 * the next caller who tried to use it. Waiting for that is how a wake turns
	 * into a projection loop discovering a dead workbench a tick at a time.
	 *
	 * So it is asked once, on `resume`, and answered once per folder: a dead
	 * view leaves the table and is rebuilt through the same supervisor as any
	 * other failure — one restart, counted, bounded — rather than by a fresh
	 * mechanism with its own budget.
	 */
	checkEditorHealth(): void {
		if (isQuitting()) return;
		const shell = shellWindowIfCreated();
		if (!shell) return;
		const dead = deadEditorKeys(
			shell.editorBindings().map(([key, viewId]) => {
				const view = shell.getViewById(viewId);
				return { key, alive: view !== undefined && isLiveWorkbench(view) };
			}),
		);
		for (const folder of dead) {
			shell.unbindEditorKey(folder);
			this.editorFailed(
				folder,
				"The workbench did not survive the computer going to sleep.",
			);
		}
	}

	/** A restart waiting out its backoff, by folder. */
	private readonly editorRestartTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();

	/**
	 * DevHub has stopped building this folder's workbench. Say so where it is
	 * about, once, and stay said.
	 *
	 * A Workspace becomes `unavailable` with `editor_restart_exhausted`, which
	 * is the state the content area already draws with Retry, Locate… and
	 * Close — so the terminal state is visible, is on the right row, and has
	 * the person's way out attached to it. It also takes the workspace out of
	 * `syncEditorViews`'s list, which is the second half of "never retried by
	 * a projection tick".
	 *
	 * A folder no Workspace owns any more has no row, so its giving up is said
	 * app-wide — once, because the supervisor never reaches this verdict twice.
	 */
	private reportEditorGaveUp(
		folder: string,
		reason: string,
		attempt: number,
	): void {
		const workspace = this.coordinator.model.workspaces.find(
			(candidate) => candidate.key === folder,
		);
		const failure = editorGaveUpFailure({
			workspaceId: workspace?.id,
			attempt,
			reason,
		});
		if (failure.subject === "workspace") {
			this.reportFailure({
				subject: "workspace",
				id: failure.id as WorkspaceId,
				code: failure.code,
				detail: failure.detail,
			});
			return;
		}
		this.publishError(
			withDetail(
				withSummary(
					errorWireAt(failure.code),
					`The workbench stopped ${String(attempt)} times and will not be restarted again.`,
				),
				reason,
			),
		);
	}

	/** Whether this folder is one `syncEditorViews` would keep a workbench for. */
	private wantsWorkbench(folder: string): boolean {
		const workspace = this.coordinator.model.workspaces.find(
			(candidate) => candidate.key === folder,
		);
		return workspace !== undefined && workspace.state.kind !== "unavailable";
	}

	/**
	 * Start every workbench now, rather than when it is first looked at.
	 *
	 * A workbench takes seconds to come up, and doing it on first selection
	 * spends those seconds in front of someone who has just asked to see it.
	 * They are started together instead, while the shell is painting: the one
	 * that is selected first, because that is the one being waited for, and the
	 * rest in parallel behind it.
	 *
	 * Nothing here is awaited by the caller — a workbench that is slow must not
	 * hold up the window — and nothing is swallowed: a workbench that cannot
	 * start says so on the page's one error surface, and the failure is shown
	 * again in place when that surface is selected.
	 */
	/**
	 * Make the set of workbench views match the set of workspaces.
	 *
	 * One rule, in one place: every workspace DevHub knows about has a
	 * workbench — Scratch is one of them — and nothing else does. Creating them at
	 * launch rather than on first selection is why nobody waits for a workbench
	 * at the moment they ask to see it; destroying one only when its workspace
	 * leaves the model is why a close that fails or is refused still has its
	 * workbench standing afterwards.
	 *
	 * A workspace that is closing keeps its view for the same reason. It leaves
	 * the model only once the close has actually finished, and that is the
	 * moment — the last one — at which the view goes.
	 *
	 * Nothing here is awaited by the caller: a workbench that is slow to start
	 * must not hold up the window. Nothing is swallowed either — a workbench
	 * that cannot start says so on the page's one error surface.
	 */
	/**
	 * The workbench the selection wants on screen, as a folder key.
	 *
	 * One reading of the layout, used by everything that has to put a workbench
	 * somewhere. A Workspace and an Agent *beside* it resolve to the same
	 * workbench, which is what makes that arrangement a split rather than a
	 * jump.
	 *
	 * Nothing, for the two layouts with no workbench in them: a Workspace that
	 * cannot be shown, and an Agent filling the content area on its own. In
	 * neither case is a workbench closed or forgotten — the view stays built and
	 * running, and `syncEditorViews` still keeps one per workspace — it is only
	 * that no workbench is the thing on screen, so there is none to reveal.
	 */
	private selectedEditorSurfaceKey(): string | undefined {
		const layout = this.coordinator.snapshot().layout;
		return layout.kind === "unavailable" || layout.kind === "agent"
			? undefined
			: surfaceKeyName(layout.editor);
	}

	syncEditorViews(): void {
		// No readiness check here, and none anywhere else either: an open that
		// starts before VS Code's services exist waits inside `ensureEditorView`
		// for exactly as long as it has to. See `mainServices.ts`.
		const selectedKey = this.selectedEditorSurfaceKey();
		const selected =
			selectedKey === undefined
				? undefined
				: this.editorKeyForSurfaceKey(selectedKey);

		// Not every workspace wants a workbench: one whose folder is gone
		// (`unavailable`) has nothing to open a workbench *in*, and asking is
		// what used to put VS Code's "path does not exist" box on screen. It is
		// asked for again the moment it is relocated or retried back to
		// available, because that is a projection change and this runs on it.
		//
		// The decision itself is `reconcileEditors`, which is pure: what comes
		// in is the projection and the answers the supervisor and the restart
		// timers already hold, and what comes out is what to do. What is left
		// here is the doing.
		const wanted = this.coordinator.model.workspaces
			.filter((workspace) => workspace.state.kind !== "unavailable")
			.map((workspace) => workspace.key);
		const gaveUp = this.editorSupervisor.gaveUpKeys();
		const plan = reconcileEditors({
			wanted,
			existing: shellWindow()
				.editorBindings()
				.map(([folder]) => folder),
			selected,
			gaveUp,
			parked: gaveUp.filter((folder) => this.editorSupervisor.parked(folder)),
			waiting: [...this.editorRestartTimers.keys()],
		});

		for (const folder of plan.dispose) {
			const viewId = this.editorViewId(folder);
			shellWindow().unbindEditorKey(folder);
			if (viewId !== undefined) {
				shellWindow().getViewById(viewId)?.destroy();
			}
		}
		// The one way out of the supervisor's verdict, and it is a person's.
		//
		// Giving up on a Workspace's workbench makes that Workspace
		// `unavailable`, which takes it out of `wanted`; it comes back only
		// when somebody presses Retry or Locate…. So "was out, and is back" is
		// exactly "a person asked again", read off the model rather than hooked
		// onto the retry intent — the model is where availability is decided,
		// and a second copy of that decision is a second thing to disagree with
		// it.
		for (const folder of plan.park) this.editorSupervisor.park(folder);
		for (const folder of plan.forget) this.editorSupervisor.forget(folder);

		for (const folder of plan.create) {
			void this.ensureEditorView(folder).then(
				(view) => {
					// No view and still wanted is a failure that said nothing:
					// the next tick would simply open another window for the same
					// folder. A folder whose workspace went `unavailable` during
					// the open — the root is not readable — is not one of these:
					// it has its own state and is no longer wanted.
					if (!view && this.wantsWorkbench(folder)) {
						this.editorFailed(folder, "No workbench view was created.");
					}
				},
				(error: unknown) => {
					// A child reconciled away before its open finished is not an
					// app failure. Startup asks for every folder at once and the
					// projection moves underneath those opens — a workspace is
					// relocated, a folder turns out to be unreadable, a close
					// lands — and VS Code answers an open it no longer has a
					// window for by cancelling it. Ten of those arrived at
					// launch as ten "the native app shell is unavailable"
					// notices about nothing (measured, stage 0). The folder
					// being out of `wanted` *is* the answer; it is said in the
					// log, where somebody looking for it can find it.
					if (!this.wantsWorkbench(folder)) {
						console.log(
							`[devhub] open: '${folder}' was reconciled away while it was opening — ${describeFailure(error)}`,
						);
						return;
					}
					this.editorFailed(folder, describeFailure(error));
				},
			);
		}
	}

	private editorKeyForSurfaceKey(surfaceKey: string): string | undefined {
		const prefix = "workspace-editor:";
		if (!surfaceKey.startsWith(prefix)) return undefined;
		const id = surfaceKey.slice(prefix.length) as WorkspaceId;
		return this.coordinator.model.workspace(id)?.key;
	}

	/** Take down every question this Workspace's workbench has on the picker. */
	private withdrawWorkbenchQuestions(workspaceId: WorkspaceId): void {
		const surfaceKey = `workspace-editor:${workspaceId}`;
		shellWindow().picker.closeWhere(
			(modal) =>
				modal.request.kind === "workbench-dialog" &&
				modal.request.surfaceKey === surfaceKey,
		);
	}

	/**
	 * Let a workspace's workbench go, carrying out the answer about its
	 * unsaved work. The rule is `closeEditor`'s; this finds the workbench.
	 *
	 * Closing a window in VS Code is an *unload*, and an unload is what lets
	 * the workbench refuse. Killing the `WebContents` instead — which is what
	 * this used to do — skipped all of that, left VS Code's backups behind to
	 * come back on the next open, and ran no extension's shutdown.
	 *
	 * It does not close the view; the close's `view` step does, once this has
	 * answered. Nothing is remembered between attempts: a workbench that does
	 * not answer within the step's deadline is a failure of *this* step, and
	 * the next close asks again.
	 *
	 * Answers with the diagnostic that stopped the close, or nothing when the
	 * workbench agreed — or when there was never anything to ask.
	 */
	private async askEditorToClose(
		workspaceId: WorkspaceId,
	): Promise<CloseDiagnosticWire | undefined> {
		const key = this.coordinator.model.workspace(workspaceId)?.key;
		if (key === undefined) return undefined;
		const services = await this.services();
		const codeWindow = await this.editorWindowFor(key);
		return closeEditor(editorRuntimeState(codeWindow), {
			discardUnsaved: () =>
				discardUnsavedEditors(
					workbenchContentsOf(codeWindow),
					CLOSE_STEP_TIMEOUT_MS,
				),
			unload: () =>
				services
					.lifecycle()
					.unload(workbenchOf(codeWindow), UnloadReason.CLOSE),
		});
	}

	/**
	 * Which editor surface a workbench view is, in the page's own vocabulary.
	 *
	 * A dialog raised by a workbench has to be drawn over *that* workbench, and
	 * the page knows its surfaces by key, not by view id.
	 */
	editorSurfaceKeyForView(viewId: number): string | undefined {
		for (const [key, id] of shellWindow().editorBindings()) {
			if (id !== viewId) continue;
			const workspace = this.coordinator.model.workspaces.find(
				(candidate) => candidate.key === key,
			);
			return workspace ? `workspace-editor:${workspace.id}` : undefined;
		}
		return undefined;
	}

	/** The `openInBrowserWindow` override's half of the folder binding. */
	viewIdForEditorKey(folder: string): number | undefined {
		return this.editorViewId(folder);
	}

	bindEditorKeyView(folder: string, viewId: number): void {
		shellWindow().bindEditorKey(viewId, folder);
	}

	/**
	 * A place DevHub was asked to open. Its policy is that this is a Workspace:
	 * the model learns about it, and opening the same one twice selects the one
	 * that already exists rather than making a second.
	 */
	noteLocation(location: WorkspaceLocation): void {
		// A workbench DevHub is building itself — `syncEditorViews` making one
		// for every Workspace, today's Scratch at midnight among them — is not a
		// request to open anything: the Workspace is already in the model, and
		// "opening" it again would select it, moving the person off whatever
		// they were in. Only a place VS Code asked for on its own is news.
		if (this.editorOpens.has(locationKey(location))) return;
		this.dispatchOwn({
			type: "open_folder",
			location: requestedLocation(
				relocatedOnSameMachine(location, location.path),
			),
		});
	}

	/**
	 * Open a folder on the page's behalf, and answer with the outcome.
	 *
	 * `withAgent` is the profile the person asked to start in it — the picker's
	 * Command gesture — and it is carried here rather than made a second call
	 * because it is one act: a folder opened for an agent that then failed to
	 * start would leave them looking at a workspace they did not ask for on its
	 * own. Every way of opening ends up here, so the gesture means the same
	 * thing on a folder that already existed, one a source offered to make, one
	 * just created and one just cloned.
	 */
	private async openFolder(
		location: RequestedWorkspaceLocation,
		withAgent?: string,
	): Promise<AppOutcomeWire> {
		const before = new Set(
			this.coordinator.model.workspaces.map((workspace) => workspace.id),
		);
		const opened = await this.dispatchAwaiting({
			type: "open_folder",
			location,
		});
		if (withAgent === undefined) {
			await this.syncEditorView();
			return outcomeWire(
				opened,
				this.coordinator.readiness,
				this.repositoryOf,
				this.homeOf,
			);
		}
		const settled = await this.dispatchAwaiting({
			type: "create_agent",
			workspaceId: this.openedWorkspaceId(before, location),
			profileId: agentProfileId(withAgent),
			// The person answered "which profile", not "where to put it". The
			// Agent gets the plain arrangement, the same one `devhub --agent`
			// gets, and the modifier they used to get here has already been spent
			// saying they wanted an agent at all.
			presentation: "full",
		});
		await this.syncEditorView();
		return outcomeWire(
			settled,
			this.coordinator.readiness,
			this.repositoryOf,
			this.homeOf,
		);
	}

	/**
	 * Which Workspace an `openFolder` just produced.
	 *
	 * The model states it in one of two ways and this reads both: a folder that
	 * was not open is *added*, and a folder that was becomes the *selection*.
	 * Matching the path back would be a third answer to a question already
	 * answered — the root is canonicalised on the way in, so it is not the
	 * string the call was given — and a third answer is one that can disagree.
	 *
	 * `before` is the set of Workspace ids from before the opening.
	 */
	private openedWorkspaceId(
		before: ReadonlySet<WorkspaceId>,
		target: RequestedWorkspaceLocation,
	): WorkspaceId {
		const added = this.coordinator.model.workspaces.find(
			(workspace) => !before.has(workspace.id),
		);
		if (added) return added.id;
		const context = this.coordinator.model.selection.context;
		if (context.kind === "workspace") return context.workspaceId;
		// Neither happened, so the model and this call disagree about what just
		// took place; going on would attach whatever comes next to whatever else
		// was selected.
		throw new Error(
			`opening ${target.path} neither added a workspace nor selected one`,
		);
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
		let outcome: IntentOutcome;
		try {
			outcome = this.coordinator.dispatchUser({
				intentId: parseIntentId(randomUUID()),
				operationId: this.freshOperationId(),
				intent,
			});
		} catch (error) {
			this.drain();
			throw asIpcError(errorWire(error));
		}
		const answer = this.awaitOutcome(outcome);
		this.drain();
		return answer.catch((error: unknown) => {
			throw asIpcError(errorWire(error));
		});
	}

	/** Scratch: today's daily-folder Workspace. See `AppModel.scratchWorkspaceId`. */
	private scratchWorkspace(): Workspace {
		const model = this.coordinator.model;
		const scratch = model.workspace(model.scratchWorkspaceId);
		if (!scratch)
			throw new Error("Scratch is not one of the model's workspaces");
		return scratch;
	}

	/**
	 * Scratch's workbench, built if it is not there, revealed, and selected.
	 *
	 * This is where every "new window with no folder" ends up: DevHub has one
	 * window, and a request for an empty one is a request for somewhere to
	 * scribble, which is what Scratch is. Selecting it is the same intent the
	 * menu's New Window raises, so the sidebar and the view agree afterwards
	 * however it was asked.
	 */
	async scratchWorkbench(): Promise<ICodeWindow> {
		await this.dispatchAwaiting({ type: "new_window" });
		const key = this.scratchWorkspace().key;
		await this.ensureEditorView(key);
		await this.syncEditorView();
		return await this.workbenchWindow(key);
	}

	/**
	 * Every workbench VS Code currently has open.
	 *
	 * The lifecycle fence (`services/devhubLifecycleMainService.ts`) needs the
	 * whole set rather than one folder's: a restart that a workbench asks for
	 * is about the application's settings, so it reaches all of them or none.
	 * Like everything else here it waits for VS Code rather than reporting an
	 * empty world during startup.
	 */
	async workbenchWindows(): Promise<readonly ICodeWindow[]> {
		return (await this.services()).windows().getWindows();
	}

	/** The `ICodeWindow` behind a folder's view; a missing one is a bug. */
	private async workbenchWindow(folder: string): Promise<ICodeWindow> {
		const viewId = this.editorViewId(folder);
		const window =
			viewId === undefined
				? undefined
				: (await this.services())
						.windows()
						.getWindows()
						.find((candidate) => candidate.id === viewId);
		if (!window) {
			throw new Error(`the workbench for ${folder} is not running`);
		}
		return window;
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
		return asSentence(() => {
			this.bringToFront();
			return Promise.resolve("DevHub is in front.");
		});
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
		return asSentence(() => this.doOpenFromCli(request));
	}

	private async doOpenFromCli(request: ControlOpenRequest): Promise<string> {
		const { path, position, waitMarkerPath } = request;
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
			await this.syncEditorView();
			this.bringToFront();
			return `${target.path} is open in DevHub.`;
		}

		// The rule itself is `routeOpen`, and it is the only thing that decides
		// this. Everything below is the carrying out of its answer.
		const destination = routeOpen(
			target.path,
			machine,
			this.routableWorkspaces(),
			request.origin,
		);
		if (destination.kind === "scratch") {
			openFileInWorkbench(
				await this.scratchWorkbench(),
				machine,
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
		});
		await this.syncEditorView();
		openFileInWorkbench(
			// The view is filed under the Workspace's key, not its root. For a
			// local folder those are the same string; for one on a host the key
			// carries the machine, and asking for the bare path finds nothing —
			// which reached the person as "the workbench for <path> is not
			// running" about a window that was on screen.
			await this.workbenchWindow(workspace.key),
			machine,
			target,
			position,
			waitMarkerPath,
		);
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
	waitEndedFromCli(waitMarkerPath: string): Promise<string> {
		return asSentence(() => this.doWaitEnded(waitMarkerPath));
	}

	private async doWaitEnded(waitMarkerPath: string): Promise<string> {
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
		await this.syncEditorView();
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
	 * `devhub --install-extension`, `--uninstall-extension`, `--list-extensions`.
	 *
	 * Nothing about extensions is decided here. The three go straight to VS
	 * Code's own extension CLI, driven against the running app's extension
	 * management service — see `extensionCommands.ts` for why that is the
	 * running app and not a process of its own.
	 */
	async installExtensionsFromCli(
		targets: readonly string[],
		force: boolean,
		cwd: string,
	): Promise<string> {
		const extensions = (await this.services()).extensions();
		return installExtensions(extensions, targets, force, cwd, homedir());
	}

	async uninstallExtensionsFromCli(
		ids: readonly string[],
		force: boolean,
	): Promise<string> {
		const extensions = (await this.services()).extensions();
		return uninstallExtensions(extensions, ids, force);
	}

	async listExtensionsFromCli(showVersions: boolean): Promise<string> {
		const extensions = (await this.services()).extensions();
		return listExtensions(extensions, showVersions);
	}

	/**
	 * `devhub --version`.
	 *
	 * Three facts, one per line, the way `code --version` prints three. They
	 * come from the running app rather than from the launcher, because a
	 * version read anywhere else is the version of something else. A source
	 * checkout has no commit and says so instead of printing a blank line.
	 */
	async versionFromCli(): Promise<string> {
		const { vscodeVersion, commit } = (await this.services())
			.extensions()
			.version();
		return [
			`DevHub ${electron.app.getVersion()}`,
			`VS Code ${vscodeVersion}`,
			commit ?? "no commit: this DevHub was built from a source checkout",
		].join("\n");
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
		const shell = shellWindow();
		const onScreen = shell.onScreenViewId();
		const workbenches = shell
			.getViews()
			.filter((view) => !view.isDestroyed())
			.map((view) => ({
				pid: view.webContents.getOSProcessId(),
				id: view.id,
				surfaceKey: this.editorSurfaceKeyForView(view.id),
				onScreen: view.id === onScreen,
			}));
		// DevHub's own pages, named the same way, because a reading that can
		// only name workbenches cannot answer what splitting the pages cost.
		// `onScreen` for these is "drawn": for the two layers that come and go
		// it is presence in the window's child list, because a notice layer
		// standing with nothing on it is a rectangle taking clicks for
		// nothing; for the Sidebar and the Agents it is visibility, because
		// both are always in the list and only one of them is always drawn.
		// Reading it back is how `--metrics` answers "exactly one of the
		// Agents and a workbench is on the content area" without a screenshot.
		const chrome = [
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
				contents: shell.toasts.contents(),
				name: "toasts",
				present: shell.toasts.isPresent(),
			},
			{
				contents: shell.picker.contents(),
				name: "picker",
				present: shell.picker.isPresent(),
			},
		]
			.filter(
				(
					page,
				): page is {
					contents: Electron.WebContents;
					name: string;
					present: boolean;
				} => page.contents !== undefined,
			)
			.map((page) => ({
				pid: page.contents.getOSProcessId(),
				id: page.contents.id,
				surfaceKey: `chrome:${page.name}`,
				onScreen: page.present,
			}));
		const views = [...workbenches, ...chrome];
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
		return asSentence(() => this.doAddAgentFromCli(profileId, args, cwd));
	}

	private async doAddAgentFromCli(
		profileId: string,
		args: readonly string[],
		cwd: string,
	): Promise<string> {
		// The profile is checked here rather than left to the resolver, because
		// a name that is not in the config is a typo on a command line, not an
		// operation that failed — and the person needs to be told which names
		// there are, not that an operation could not be completed.
		const configured = this.config?.agentProfiles ?? [];
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

	/** Hand a request's files to a workbench, exactly as upstream would. */
	sendFilesToWorkbench(window: ICodeWindow, files: unknown): void {
		window.sendWhenReady("vscode:openFiles", VSCancellationToken.None, files);
	}

	//#endregion

	//#region workbench views

	/**
	 * VS Code routed an open into a workbench that already exists.
	 *
	 * Which changes nothing about what is on screen: the selection decides
	 * that, and an open arriving for a folder nobody selected must not take the
	 * screen from the folder they did. The arrangement is asked again because
	 * the child list may have moved, and for no other reason.
	 */
	assertArrangement(): void {
		shellWindow().assertArrangement();
	}

	//#endregion

	//#region config

	private watchConfig(): void {
		this.stopWatchingConfig = this.configStore.watch(2000, (outcome) => {
			if ("kind" in outcome && outcome.kind === "applied") {
				this.config = outcome.loaded.config;
				this.applyChordLayout();
				this.publishAppearance();
				this.publishProfiles();
				this.publishActions();
				publishSettingsSnapshot();
				return;
			}
			if (!("kind" in outcome)) {
				// The file on disk no longer parses. The last good config stays in
				// effect, and the person is told rather than left guessing why an edit
				// did nothing.
				this.publishError(errorWire(new Error(`config: ${outcome.code}`)));
				publishSettingsSnapshot();
			}
		});
	}

	currentConfig(): Config | undefined {
		return this.config;
	}

	adoptConfig(config: Config): void {
		const dailyBefore = scratchTemplate(this.config);
		this.config = config;
		// A new `[scratch] daily` names a different folder for today, and that
		// folder is Scratch from now on; the old one stays as an ordinary row.
		if (scratchTemplate(config) !== dailyBefore) this.midnight.rearm();
		this.applyChordLayout();
		// Before the pages are told, because this one is not a message to a page:
		// it changes what the OS appearance is for the whole process, and every
		// workbench and the shell's own chrome follow from that.
		appearanceMode().apply(config.appearance.mode);
		this.publishAppearance();
		this.publishProfiles();
	}

	//#endregion

	//#region the page

	private async dispatchFromPage(wire: AppIntentWire): Promise<AppOutcomeWire> {
		let intent: UserIntent;
		try {
			intent = intentFromWire(wire);
		} catch (error) {
			throw asIpcError(
				error instanceof InvalidIntent
					? errorWireAt("invalid_intent")
					: errorWire(error),
			);
		}
		const settled = await this.dispatchAwaiting(intent);

		// Selecting the Editor activity is the moment its view has to exist. It is
		// done here rather than in the model because a view is an effect on the
		// window, and the model does not have windows.
		await this.syncEditorView();
		return outcomeWire(
			settled,
			this.coordinator.readiness,
			this.repositoryOf,
			this.homeOf,
		);
	}

	/**
	 * `syncEditorView` where there is nobody to hand a failure back to.
	 *
	 * A projection changes for reasons with no caller — a reconciler round, a
	 * workbench finishing its open — so the promise has no `await` above it. A
	 * bare `void` on one of those routes its failure to the process's
	 * `unhandledRejection`, which is now main's root boundary and publishes it
	 * to the page's one error surface, the same as every failure with a caller.
	 * See `mainFailureRoot.ts`; this used to carry its own copy of that rule.
	 */
	private syncEditorViewInBackground(): void {
		void this.syncEditorView();
	}

	private async syncEditorView(): Promise<void> {
		const surfaceKey = this.selectedEditorSurfaceKey();
		// A Workspace that cannot be shown has no workbench to reveal; the page
		// draws the reason from the Workspace's own state.
		if (surfaceKey === undefined) return;
		await this.revealEditorFor(surfaceKey);
	}

	private async pickFolder(): Promise<string | undefined> {
		const picked = await (await this.services()).dialogs().pickFolder({});
		return picked?.[0];
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
			this.config?.runtimes.git ?? "git",
			this.launchEnvironment["PATH"] ?? "",
		);
		if (git.kind === "unavailable") {
			throw new TypedFailure(
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
	 * Carry out everything the Issue flow asked for, in one act.
	 *
	 * The worktree, if one was asked for; the folder opened; the Issue written
	 * down against the workspace that opening produced; the agent started in it.
	 * They are one act because a half-done one is worse than none: a worktree
	 * nothing opened is litter, and a workspace opened for an Issue it does not
	 * know about is the exact confusion the record exists to prevent.
	 *
	 * Which workspace it is comes from the selection rather than from matching
	 * the path back, because opening a folder *is* selecting it — for a folder
	 * already open as much as for a new one — and re-deriving it from a path
	 * would be a second answer to a question the model has already answered.
	 */
	private async assignIssue(request: IssueAssignment): Promise<AppOutcomeWire> {
		const item = parseGitHubItemUrl(request.issueUrl);
		if (!item) {
			throw workspaceFailure("That is not a GitHub Issue or pull request URL.");
		}
		const place = request.place;
		const location = workspaceLocation(place);
		const target = request.branch
			? await ensureWorktree(
					await this.gitCommand(runtimeFor(location)),
					place.path,
					request.branch,
					{
						allowStaleBase: request.allowStaleBase,
						// A pull request's branch is work that exists already; an
						// Issue's is one being started now. Which it is follows from
						// the URL rather than from a second field beside it, because
						// two facts saying the same thing can disagree.
						branchExistsAlready: item.kind === "pull",
					},
				)
			: place.path;

		// Which workspace the opening produced is a fact the model states, and it
		// states it in one of two ways: a folder that was not open is *added*,
		// and a folder that was becomes the *selection*. Deriving it from the
		// path instead would be a third answer — the root is canonicalised on the
		// way in, so it is not the string this call was given.
		const before = new Set(this.coordinator.model.workspaces.map((w) => w.id));
		// A worktree of a repository on a host is beside it, on that host: git
		// made it there, and there is nowhere else it could be. So the place the
		// flow was working in decides the machine, and only the path moves.
		const opening = requestedLocation({ ...place, path: target });
		await this.openFolder(opening);
		// Not `openFolder(target, profileId)`: this flow has more to do around the
		// creation than that shortcut can express — the Agent goes beside the
		// editor when the person asked for that, and the Issue's prompt is queued
		// against whichever Agent it produced — but *which workspace opening
		// produced* is the same fact, read the same way.
		const workspaceId = this.openedWorkspaceId(before, opening);
		// Nothing is written down about which Issue this workspace is for. The
		// branch the flow just made carries the number (`feature/128-…`), and the
		// branch is the whole of the link — so a worktree made for the Issue shows
		// it, and "in this workspace" on a branch that says nothing about an Issue
		// shows nothing, which is the point: a record would have claimed the Issue
		// while `master` was checked out.
		const agentsBefore = new Set(
			this.coordinator.model.workspaces.flatMap((workspace) =>
				workspace.agents.map((agent) => agent.id),
			),
		);
		const settled = await this.dispatchAwaiting({
			type: "create_agent",
			workspaceId,
			profileId: agentProfileId(request.profileId),
			presentation: request.split ? "beside" : "full",
		});
		this.queueIssuePrompt(agentsBefore, item, request.actionId);
		await this.syncEditorView();
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
	 * Everything is best effort except the asking. A fetch that fails narrows
	 * what can be offered and is not reported here, because this runs while
	 * somebody is being asked a question and a network that is down is not an
	 * answer to it; the fetch that has to succeed happens when the worktree is
	 * made, where its failure is shown and answered. What is *not* softened is
	 * GitHub refusing to talk at all — no token, no such pull request — because
	 * then the flow is offering choices about something it never read.
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
			if (remote)
				await fetchBranchFrom(git, directory, remote, head.branch, cancel);
			return this.branchWhereabouts(
				git,
				directory,
				head.branch,
				sameRepository ? undefined : `${head.owner}/${head.repository}`,
			);
		}
		// GitHub's own record first — the branch its Create a branch button made
		// — and only then the convention, which is a guess about a name and is
		// consulted exactly because most Issues have no record to read.
		const linked = await readIssueLinkedBranch(item, credentials.token);
		const branch =
			linked ?? (await this.branchNamedFor(git, directory, item, cancel));
		if (branch === undefined) return { reachable: false };
		return this.branchWhereabouts(git, directory, branch, undefined);
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
		await refreshOrigin(git, directory, cancel);
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

		handle(CHANNELS.getSnapshot, () => {
			// A page asking for the world is also a page that has just started
			// and has none of the pushes yet. The rectangle the owner leaves
			// for a workbench is one of those, and the window's own page draws
			// nothing at all until it has one — deliberately, because a guessed
			// rectangle is the page having an opinion about the layout. So it
			// is said again here, where "a page has just started" is a fact
			// main can see.
			this.publishLayoutState();
			return this.snapshot();
		});
		handle(CHANNELS.getAppearance, () => this.appearance());
		// Read back off the window rather than composed again: this is the
		// name the OS is showing, which is the only thing the bar may letter.
		handle(CHANNELS.getWindowTitle, () => shellWindow().window.getTitle());
		handle(CHANNELS.getAgentProfiles, () => this.agentProfiles());
		handle(CHANNELS.dispatch, (_event, intent: AppIntentWire) => {
			// The person asked for something, which is one of the three things
			// that retire a failure — they have moved on, and a report about the
			// last thing is in the way of the next. The page that draws notices
			// cannot see this for itself and does not want to: main sees every
			// dispatch a page makes, so main says so. `dispatchOwn` deliberately
			// does not, because DevHub raising its own intent is not the person
			// starting an action.
			this.sendToDisplay(CHANNELS.actionStarted, undefined);
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
			if (!config) {
				throw asIpcError(errorWire(new Error("config is unavailable")));
			}
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
				withAgent: string | undefined,
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
					);
				} catch (error: unknown) {
					throw asIpcError(errorWire(error));
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
				throw asIpcError(errorWire(error));
			}
		});
		handle(
			CHANNELS.openSshWorkspace,
			async (
				_event,
				host: string,
				path: string,
				withAgent: string | undefined,
			) => {
				this.cancelPicker?.();
				this.cancelPicker = undefined;
				try {
					return await this.openFolder(
						requestedLocation({ kind: "ssh", host, path }),
						withAgent,
					);
				} catch (error: unknown) {
					throw asIpcError(errorWire(error));
				}
			},
		);
		// The two dev container doors, the same shape as the two SSH ones: a
		// question that costs nothing and is asked every time, and an open that
		// goes through `openFolder` like everything else.
		handle(CHANNELS.devContainerConfig, async (_event, path: string) => {
			try {
				return await devContainerConfigIn(localRuntime(), path);
			} catch (error: unknown) {
				throw asIpcError(errorWire(error));
			}
		});
		handle(
			CHANNELS.openContainerWorkspace,
			async (
				_event,
				workspaceFolder: string,
				withAgent: string | undefined,
			) => {
				this.cancelPicker?.();
				this.cancelPicker = undefined;
				try {
					const configPath = await devContainerConfigIn(
						localRuntime(),
						workspaceFolder,
					);
					// The container has to exist before there is a Workspace to
					// open, because the path the Workspace is *at* is a path inside
					// it and nothing knows that path until it does. This is the
					// explicit act `ensureUp` exists for — a person chose this.
					const runtime = runtimeFor(
						workspaceLocation({
							kind: "container",
							workspaceFolder,
							...(configPath === undefined ? {} : { configPath }),
							// A placeholder only for reaching the runtime: the
							// machine is keyed on the host folder, so the path plays
							// no part in which runtime this is.
							path: "/",
						}),
					);
					if (!(runtime instanceof ContainerRuntime)) {
						throw new Error(
							`${workspaceFolder} did not resolve to a dev container runtime`,
						);
					}
					await runtime.ensureUp();
					const path = await runtime.workspacePath(workspaceFolder);
					return await this.openFolder(
						requestedLocation({
							kind: "container",
							workspaceFolder,
							...(configPath === undefined ? {} : { configPath }),
							path,
						}),
						withAgent,
					);
				} catch (error: unknown) {
					throw asIpcError(errorWire(error));
				}
			},
		);
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
			const parents =
				config === undefined
					? []
					: await this.boundedLookup(
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
		// A refusal travels the way every other one does — as the structured
		// error inside the message — so the sheet that asked shows the sentence
		// and not "the native app shell is unavailable".
		handle(
			CHANNELS.createProject,
			async (_event, path: string, withAgent: string | undefined) => {
				this.cancelPicker?.();
				this.cancelPicker = undefined;
				try {
					return this.openFolder(
						requestedLocation({
							kind: "local",
							path: await createProject(path),
						}),
						withAgent,
					);
				} catch (error: unknown) {
					throw asIpcError(errorWire(error));
				}
			},
		);
		handle(
			CHANNELS.cloneProject,
			async (
				_event,
				url: string,
				parentDirectory: string,
				withAgent: string | undefined,
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
					);
				} catch (error: unknown) {
					throw asIpcError(errorWire(error));
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
			if (!config || !issue) {
				throw asIpcError(
					errorWire(
						workspaceFailure("That is not a GitHub Issue or pull request URL."),
					),
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
						// Where each one's git actually runs — which for a dev
						// container is the folder on this Mac, not the path inside it.
						this.coordinator.model.workspaces.map((workspace) =>
							gitPlaceOf(workspace.location),
						),
						cancel,
					),
			);
		});

		// Escape, or the sheet going away. There is one lookup at a time, so
		// there is nothing to identify: this ends the one that is running, and
		// the `git` child dies with it rather than at the deadline.
		handle(CHANNELS.cancelPickerLookup, () => {
			this.pickerLookup?.cancel();
			this.pickerLookup = undefined;
			return Promise.resolve();
		});
		handle(
			CHANNELS.cloneRepository,
			async (_event, url: string, parentDirectory: string) => {
				try {
					return await this.clone(url, parentDirectory);
				} catch (error: unknown) {
					throw asIpcError(errorWire(error));
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
				throw asIpcError(errorWire(error));
			}
		});
		handle(CHANNELS.assignIssue, async (_event, request: IssueAssignment) => {
			try {
				return await this.assignIssue(request);
			} catch (error: unknown) {
				throw asIpcError(errorWire(error));
			}
		});

		handle(CHANNELS.getRepositoryStatus, () => this.lastRepositoryStatus);

		// Destructive. `force` says the page already asked and was told to go
		// ahead; without it git is left to refuse, which is what happens for the
		// removals that were never worth asking about.
		// The shortcut buttons. A refusal reaches the page as words, because a
		// button that quietly does nothing is the one outcome nobody can act on.
		handle(
			CHANNELS.runAgentAction,
			async (_event, agentId: string, actionId: string) => {
				try {
					return await this.runAgentAction(agentId, actionId);
				} catch (error: unknown) {
					throw asIpcError(errorWire(error));
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
					throw asIpcError(errorWire(error));
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
					throw asIpcError(errorWire(error));
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
					throw asIpcError(errorWire(error));
				}
			},
		);
		handle(CHANNELS.agentActions, () => this.agentActionsWire());
		handle(CHANNELS.openSettings, () => {
			openSettingsWindow();
		});
		handle(CHANNELS.openExternalUrl, (_event, url: string) =>
			electron.shell.openExternal(url),
		);
		// A copy inside a terminal pane. It is main's clipboard rather than
		// the renderer's because the write arrives from a PTY: the browser's
		// clipboard API refuses one while the document is unfocused, and tmux
		// does not wait for the window to be frontmost.
		handle(CHANNELS.writeClipboard, (_event, text: string) => {
			electron.clipboard.writeText(text);
		});
		// A drag in progress, which is the one geometric fact the page owns
		// while it lasts: the pointer is in the page, and the model only learns
		// where the person stopped. Everything else about the layout is
		// computed here — see `publishLayoutState`.
		handle(CHANNELS.previewLayout, (_event, preview: LayoutPreviewWire) => {
			if (preview.sidebarWidth !== undefined) {
				this.sidebarWidthPreview = preview.sidebarWidth ?? undefined;
			}
			if (preview.splitRatio !== undefined) {
				this.splitRatioPreview = preview.splitRatio ?? undefined;
			}
			this.publishLayoutState();
		});
		// Escape in the Sidebar. The page can blur its own row but it cannot
		// focus a native workbench view, so where the keyboard goes stays main's
		// one answer and this is only the ask.
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

/** An answer to an operation something newer already replaced. */
function isStaleCompletion(error: unknown): boolean {
	return (
		error instanceof AppError && error.code === AppErrorCode.StaleCompletion
	);
}

/**
 * A completion for an operation the coordinator never started.
 *
 * Told apart from a *stale* one, which is ordinary: a stale completion answers
 * an operation something newer already settled, on purpose. An unknown one has
 * no such story — it means main invented a token, or completed one twice, and
 * both are bugs in main.
 */
function isUnknownOperation(error: unknown): boolean {
	return (
		error instanceof AppError && error.code === AppErrorCode.UnknownOperation
	);
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
 * The command line's half of the one error conversion.
 *
 * A failure inside main travels to the page as a JSON payload that the page
 * unwraps and draws on its error surface; a terminal has no such reader, and
 * printing the payload at somebody is not reporting a failure. So the same
 * values are unwrapped here and printed instead of drawn. Nothing new is
 * invented: the summary and the detail the model already produced are exactly
 * what is shown, and anything that is not one of those payloads is passed on
 * with its own message.
 */
async function asSentence(run: () => Promise<string>): Promise<string> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		let parsed: unknown;
		try {
			parsed = JSON.parse(error.message);
		} catch {
			// Not one of main's structured failures. Its own message is the
			// report, and it is already a sentence.
			throw error;
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as AppErrorWire).summary !== "string"
		) {
			throw error;
		}
		const wire = parsed as AppErrorWire;
		throw new Error(
			wire.detail ? `${wire.summary} ${wire.detail}` : wire.summary,
		);
	}
}

function asIpcError(error: AppErrorWire): Error {
	// Electron carries only a message across the IPC boundary, so the structured
	// error travels inside it and the page unwraps it back into the same value.
	return new Error(JSON.stringify(error));
}

function toDomainProfile(profile: {
	id: string;
	display_name: string;
	kind: AgentProfileKind;
	command: string;
	args: readonly string[];
	env: Readonly<Record<string, string>>;
}): AgentProfile {
	return AgentProfile.create(
		agentProfileId(profile.id),
		profile.display_name,
		profile.kind,
		profile.command,
		profile.args,
		new Map(Object.entries(profile.env)),
	);
}

let current: AppController | undefined;

export async function createAppController(
	userDataPath: string,
	cliArgs: NativeParsedArgs,
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
		// Where the tmux DevHub puts on a host comes from. Stated in
		// `product-overrides.json` beside `serverDownloadUrlTemplate`, because
		// the release the app installs from is a fact about the build and not a
		// thing a person configures — and read here for the same reason the
		// profile is passed in at all.
		tmux: new ReleaseTmuxDelivery({
			version: devhubProduct.tmuxVersion ?? "",
			directory: tmuxInstallDirectory(
				vscodeProduct.serverDataFolderName ?? ".vscode-server",
			),
			urlTemplate: devhubProduct.tmuxDownloadUrlTemplate ?? "",
			sha256: devhubProduct.tmuxDownloadSha256 ?? {},
			cacheDirectory: join(userDataPath, "tmux"),
		}),
		// And where the remote extension host comes from. The same three
		// product facts the connection used to hand a vendored extension —
		// the URL template, the application name and the data folder — read
		// once, here, now that DevHub is the thing that installs it.
		reh: new ReleaseRehDelivery({
			commit: vscodeProduct.commit,
			version: vscodeProduct.version,
			dataFolderName: vscodeProduct.serverDataFolderName ?? ".vscode-server",
			applicationName: vscodeProduct.serverApplicationName ?? "code-server",
			urlTemplate: devhubProduct.serverDownloadUrlTemplate ?? "",
			cacheDirectory: join(userDataPath, "reh"),
		}),
		// And which binaries drive a dev container. Named rather than
		// discovered, and separately, because they are separately absent: a Mac
		// can have Docker and no `devcontainer` CLI, and the two refusals name
		// different things to install. A bare name is resolved against `PATH`
		// by the OS, which is the person's own answer to where they put it.
		docker: { path: devhubProduct.dockerPath ?? "docker" },
		devcontainer: { path: devhubProduct.devcontainerPath ?? "devcontainer" },
	});

	// One switch, resolved once: which DevHub this is, and therefore where its
	// settings, its state and its tmux server are. See model/profile.ts.
	const profile = activeProfile();
	const seeded = seedProfileSettings(
		profile,
		profileLocations(DEFAULT_PROFILE, homedir()),
	);
	if (seeded.kind === "copied") {
		console.log(
			`[devhub] profile ${profile.profile}: seeded ${seeded.to} from ${seeded.from}`,
		);
	}
	const configStore = new ConfigStore(defaultConfigPaths(homedir()));
	let config: Config | undefined;
	try {
		const loaded = (await configStore.load()).config;
		const applied = withProfileRuntimes(loaded, profile);
		if (applied.overriddenSocketName !== undefined) {
			console.log(
				`[devhub] profile ${profile.profile}: runtimes.tmux_socket_name = "${applied.overriddenSocketName}" is ignored here; this profile uses "${profile.tmuxSocketName}"`,
			);
		}
		config = applied.config;
		const migration = configStore.lastMigration();
		if (migration.kind === "migrated") {
			console.log(
				`[devhub] settings: folded ${migration.from} into settings.toml and kept the old file as ${migration.to}`,
			);
		}
	} catch (error) {
		// A config that will not parse is not a reason not to start: the shell
		// comes up, and the failure is reported to the page and the Settings
		// window (`configStore.lastDiagnostic()`) rather than taking the app
		// down. Said here too, because a person who cannot open Settings still
		// has the log.
		console.error("[devhub] settings could not be read:", error);
		config = undefined;
	}

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

	const profiles = (config?.agentProfiles ?? []).map(toDomainProfile);
	// Scratch is today's folder, worked out now rather than read from the file:
	// a file from yesterday names yesterday's folder as an ordinary Workspace,
	// and today's becomes Scratch. With no readable settings it is the default
	// template — the settings failure is already on its way to the person.
	const today = await scratchDay(
		scratchTemplate(config),
		new Date(),
		homedir(),
	);
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

	current = new AppController(
		configStore,
		stateStore,
		cliArgs,
		model,
		state,
		config,
		previousExit,
		load.metadata.origin === "fresh",
	);
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
	return current;
}

/** `[scratch] daily`, or its default when there are no readable settings. */
function scratchTemplate(config: Config | undefined): string {
	return config?.scratch.daily ?? DEFAULT_SCRATCH_DAILY;
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
