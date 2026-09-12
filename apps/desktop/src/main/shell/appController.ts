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
import { join } from "node:path";
import vscodeProduct from "code-oss-dev/out/vs/platform/product/common/product.js";
import { activityCounters } from "../diagnostics/counters.js";
import { metricsReport } from "../diagnostics/metrics.js";
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
	type ChordHelpRowWire,
	type ContentRect,
	type ContentSurfaceWire,
	type AssignmentBranchWire,
	type IssueAssignment,
	type WorkspacePlaceWire,
	type ModalRequest,
	type RepositoryStatusWire,
	type WorkspacePickerEvent,
} from "../../ipc/contract.js";
import type {
	AgentProfiles,
	AppAppearance,
	AppErrorWire,
	AppIntentWire,
	AppOutcomeWire,
	AppSnapshotWire,
	CloseDiagnosticWire,
	ReplayWire,
} from "../../ipc/appShell.js";
import { AppCoordinator, type Effect } from "../../model/coordinator.js";
import { editorReveal } from "./editorReveal.js";
import {
	CLOSE_BUDGET_MS,
	CloseTimeout,
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
import type { ControlPosition } from "../cli/protocol.js";
import { workspaceRootFor } from "../cli/resolve.js";
import {
	AgentProfile,
	agentsInspection,
	agentProfileId,
	displayPath,
	agentId as parseAgentId,
	remoteAuthorityOf,
	surfaceKeyName,
	workspaceId as parseWorkspaceId,
	workspaceLocation,
	workspaceRoot,
	type AgentProfileKind,
	type AgentReconciliation,
	type CloseStep,
	type ResourceInspection,
	type WorkspaceId,
	type WorkspaceLocation,
} from "../../model/domain.js";
import { SCRATCH_EDITOR_KEY } from "./editorPlace.js";
import { readSshHosts } from "./sshHosts.js";
import {
	operationId as parseOperationId,
	type OperationId,
	confirmationId as parseConfirmationId,
	intentId as parseIntentId,
	requestedLocation,
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
import { shellWindow } from "./shellWindow.js";
import { shellTheme } from "./shellTheme.js";
import { appearanceMode } from "./appearanceMode.js";
import { editorElement, shellTitleFor } from "./shellTitle.js";
import type { ShellPalette } from "../../ipc/palette.js";
import type { WorkbenchView } from "./workbenchView.js";
import { agents, inspectWorkspaceResources, terminals } from "./adapters.js";
import { editorInspection, editorRuntimeState } from "./editorInspection.js";
import { wireTerminals, type TerminalWiring } from "./terminalWiring.js";
import {
	CancellationToken,
	SCRATCH_TARGET,
	socketName,
	workspaceTarget,
	type TerminalPreflight,
} from "../terminal/ports.js";
import { enclosingRoot } from "../terminal/launcher.js";
import { OperationDeadline } from "../terminal/command.js";
import { wireAgents } from "./agentWiring.js";
import { AgentReconcilers, type ReconcileHost } from "./agentReconciler.js";
import { MainServicesGate, type MainServices } from "./mainServices.js";
import {
	liveRuntimes,
	localRuntime,
	runtimeFor,
	setRuntimeProfile,
} from "../runtime/registry.js";
import type { Runtime } from "../runtime/runtime.js";
import { resolveExecutable, resolveRuntimes } from "./runtimes.js";
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
import {
	collectParentDirectories,
	startWorkspacePicker,
} from "./workspacePicker.js";
import {
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

/** The folder key a scratch (folderless) workbench view is filed under. */
const SCRATCH_EDITOR = SCRATCH_EDITOR_KEY;

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

/** A crash loop is a bug to report, not a thing to keep feeding. */
const MAX_EDITOR_RESTARTS = 5;
const RESTART_BACKOFF_MS = 250;

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

	/** Folder path (or the scratch key) -> the `ICodeWindow` id of its view. */
	/**
	 * The workbench view showing each place, by that place's key.
	 *
	 * The key is `locationKey` — a local folder's canonical path, unchanged from
	 * when that was the only kind, and `ssh://host/path` for a folder on another
	 * machine — or `SCRATCH_EDITOR_KEY` for Scratch. A path stopped being enough
	 * the moment two machines could both have `/src/api`: they are two
	 * Workspaces, two windows and two rows, and one map entry would have made
	 * them share a workbench.
	 */
	private readonly viewsByEditorKey = new Map<string, number>();

	/** How many unasked-for deaths a folder's workbench gets before DevHub stops. */
	private readonly editorRestarts = new Map<string, number>();
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
	private state: PersistedAppState;
	private appearanceSequence = 0;
	private profileSequence = 0;
	private cancelPicker: (() => void) | undefined;
	/** Page requests still waiting on a deferred chain, by operation identity. */
	private readonly pendingRequests = new Map<OperationId, PendingRequest>();
	private terminalsWiring: TerminalWiring | undefined;
	private agentSessions: AgentSessions | undefined;
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
	private readonly agentReconcilers = new AgentReconcilers({
		reconcile: () => this.reconcileAllAgents(),
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
			await this.stateStore.saveState(this.state);
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
		const resolved = await resolveRuntimes(
			config?.runtimes ?? {
				shell: "/bin/zsh",
				git: "git",
				tmux: "tmux",
				tmux_socket_name: activeProfile().tmuxSocketName,
				tmux_args: [],
			},
			this.launchEnvironment["PATH"] ?? "",
		);
		this.terminalsWiring = wireTerminals({
			config,
			resolved: { tmux: resolved.tmux, shell: resolved.shell },
			environment: this.launchEnvironment,
			effectiveSocketName: this.state.tmux.effective_socket_name,
			userDataPath,
			model: () => this.coordinator.model,
		});
		this.agentSessions = wireAgents({
			runtime: this.terminalsWiring.runtime,
			model: () => this.coordinator.model,
		});
		// Everything restored from the state file describes the previous run,
		// and the sessions on the socket are what is left of it. Nothing has to
		// be told which Agent belongs where: the session carries its own
		// workspace and Agent id in its markers, so restoring a row is finding
		// its session again. What is left over is swept once, here, because a
		// session no row can show is a process nobody can reach.
		const known = new Set<string>();
		for (const workspace of this.coordinator.model.workspaces) {
			for (const agent of workspace.agents) known.add(agent.id);
		}
		if (this.agentSessions.available) {
			const reaped = await this.agentSessions.reapUnknown(known);
			if (reaped > 0) {
				console.info(
					`[devhub] agents: closed ${String(reaped)} Agent session(s) no longer known to this DevHub`,
				);
			}
		}
		this.agentReconcilers.follow(this.agentHosts());
		this.repositoryStatus.start();
	}

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
			selectContext: (context, presentation) => {
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
				shellWindow().modals.openModal({ kind: "tab-picker" });
			},
			openAgentPicker: (workspaceId) => {
				// The same door the sidebar's `+` goes through: it asks main to
				// open this modal, and this *is* main.
				shellWindow().modals.openModal({ kind: "agent-picker", workspaceId });
			},
			openIssuePicker: () => {
				shellWindow().modals.openModal({ kind: "issue-assignment" });
			},
			openAgentActions: (agentId) => {
				shellWindow().modals.openModal({ kind: "agent-actions", agentId });
			},
			renameAgent: (agentId) => {
				shellWindow().modals.openModal({ kind: "agent-rename", agentId });
			},
			markAgentUnread: (agentId) => {
				// The same intent the row menu dispatches, through the same
				// door: a chord is another way to raise a command DevHub has.
				this.dispatchOwn(
					intentFromWire({ type: "mark_agent_unread", agentId }),
				);
			},
			focusSidebar: () => {
				this.send(CHANNELS.menuCommand, "focus_sidebar");
			},
			toggleSidebar: () => {
				// A change to the model like the resize beside it, so the page
				// re-renders narrower and the rectangle it reports for the
				// workbench is the freed width. Nothing here lays anything out.
				this.dispatchOwn({ type: "toggle_sidebar" });
			},
			dismissAlert: () => {
				// The App Shell page and nowhere else. Every failure main raises
				// is published to this one page and drawn in one place
				// (`publishError` → `SurfaceViewport`'s inline alert), so there is
				// one alert to put away however it got there. The Settings
				// window's own refusal is not this: its Dismiss button is
				// ordinary DOM in a window where Tab works, so it was never out
				// of the keyboard's reach.
				this.send(CHANNELS.menuCommand, "dismiss_alert");
			},
			closeAgent: (agentId) => {
				this.requestCloseAgent(agentId);
			},
			closeWorkspace: (workspaceId) => {
				this.closeWorkspaceOrWorktree(workspaceId);
			},
			refreshRepositories: () => {
				this.repositoryStatus.look();
			},
			openChordHelp: () => {
				shellWindow().modals.openModal({
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
	 * The two halves of one rule, and the only place either is spoken: an
	 * Agent's pane is drawn by the App Shell page, so the page is asked to find
	 * it; everything else is a native view the window focuses directly, which is
	 * `ShellWindow.focusSurface`'s single answer.
	 *
	 * Both callers are "the keyboard should go back to the surface now" —
	 * swapping the halves of a split, and Escape out of the Sidebar — and they
	 * ask it here rather than each deciding, because two answers to one question
	 * is how the split ended up focusing the wrong pane once already.
	 */
	private placeKeyboardOnSurface(): void {
		if (this.coordinator.model.selection.context.kind === "agent") {
			this.send(CHANNELS.menuCommand, "focus_agent_pane");
			return;
		}
		shellWindow().focusSurface();
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
		void this.dispatchFromPage({ type: "stop_agent", agentId })
			.then((outcome) => {
				// An idle Agent is stopped without a question — the model decides
				// that, from `agentIsIdle` — and then there is no confirmation in
				// the outcome and nothing to open.
				this.raiseCloseConfirmation(outcome, agentId);
			})
			.catch((error: unknown) => {
				this.publishError(errorWire(error));
			});
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
		shellWindow().modals.openModal({
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
			shellWindow().modals.openModal({
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
		})
			.then((settled) => {
				this.raiseCloseConfirmation(
					outcomeWire(settled, this.coordinator.readiness, this.repositoryOf),
				);
			})
			.catch((error: unknown) => {
				this.publishError(errorWire(error));
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
	 * that contains it, and to Scratch when no Workspace does. The folderless
	 * workbench is not a case of its own — VS Code starts its terminal in the
	 * user's home, nothing is rooted there, and Scratch is what the rule gives,
	 * which is the same `scratch` session it has been since before this existed.
	 */
	async terminalProfileFor(
		machine: string,
		root: string | null,
	): Promise<{ readonly file: string; readonly args: readonly string[] }> {
		const wiring = this.terminalsWiring;
		if (!wiring) throw new Error("the terminal runtime is not running");
		// Only the Workspaces on the machine that is asking. A path is a path on
		// one computer: `/srv/app` on two hosts is two folders, and a matcher
		// given both roots would answer one of them with the other's session —
		// which is not a slower answer, it is a shell in the wrong place.
		const workspaces = this.coordinator.model.workspaces.filter(
			(candidate) => runtimeFor(candidate.location).id === machine,
		);
		const enclosing = enclosingRoot(
			workspaces.map((candidate) => candidate.root),
			root,
		);
		const workspace = workspaces.find(
			(candidate) => candidate.root === enclosing,
		);
		// DevHub's tmux server runs on the machine DevHub runs on, and a session
		// on it is no use to a terminal somewhere else: the argv would attach a
		// far machine's `tmux` to a socket that is not on it, in a directory
		// that means something different there. Until the terminal runtime is
		// per-machine, the honest answer is the sentence rather than an argv
		// that looks right and opens a shell on the wrong computer.
		if (machine !== "local") {
			throw new Error(
				`DevHub's terminal sessions run on the machine DevHub runs on, and this terminal is on ${machine}. A workbench there has no DevHub session to attach to yet.`,
			);
		}
		if (!workspace) {
			return wiring.service.surfaces.profile(SCRATCH_TARGET);
		}
		return wiring.service.surfaces.profile(
			workspaceTarget(workspace.id, workspace.root),
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
		return wiring.runtime.preflight(socketName(name));
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
	async changeTerminalSocket(name: string): Promise<void> {
		const wiring = this.terminalsWiring;
		if (!wiring) throw new Error("the terminal runtime is not running");
		const next = socketName(name);
		const previous = this.state.tmux.effective_socket_name;
		if (next === previous) return;

		wiring.service.surfaces.detachAll();
		const release = await wiring.runtime.beginTransition();
		try {
			const cancel = new CancellationToken();
			const old = socketName(previous);
			const owned = await wiring.runtime.transitionInspectOwnedSessions(
				old,
				cancel,
			);
			for (const record of owned.sessions) {
				await wiring.runtime.transitionCloseOwnedSession(old, record, cancel);
			}
			const targets = [
				SCRATCH_TARGET,
				...this.coordinator.model.workspaces.map((workspace) =>
					workspaceTarget(workspace.id, workspace.root),
				),
			];
			for (const target of targets) {
				await wiring.runtime.transitionEnsureOnSocket(next, target, cancel);
			}
			wiring.runtime.setEffectiveSocket(next);
			this.state.tmux.effective_socket_name = next;
			await this.stateStore.saveState(this.state);
		} finally {
			release();
		}
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
		try {
			this.coordinator.dispatchUser({
				intentId: parseIntentId(randomUUID()),
				operationId: this.freshOperationId(),
				intent: {
					type: "workspace_root_unreadable",
					workspaceId: workspace.id,
					reason,
				},
			});
		} catch (error: unknown) {
			this.publishError(errorWire(error));
			return;
		}
		this.drain();
	}

	windowFocusChanged(focused: boolean): void {
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
	 * One round of the reconciler: ask the provider about every Agent and let
	 * the model settle before the next round is scheduled.
	 */
	private async reconcileAllAgents(): Promise<void> {
		await this.dispatchAwaiting({ type: "reconcile_agents" });
	}

	/**
	 * The machines with at least one Agent on them right now.
	 *
	 * There can be exactly one, and it is this Mac: `canCreateAgent` still has
	 * its `supportsLocalAgents` term, so an ssh Workspace cannot hold an Agent
	 * to reconcile. The list is built from the model rather than asserted,
	 * because that is the fact that will change, and `follow` will then start a
	 * second loop on its own.
	 *
	 * The round it runs is still the whole model's — `reconcile_agents` carries
	 * no machine — so a second live runtime here would mean two loops each
	 * reconciling both machines at the faster of the two cadences. That is a
	 * wrong answer rather than a slow one, so it stops here rather than
	 * arriving as a status that flickers: when a runtime can hold Agents, the
	 * intent gains the machine it is about.
	 */
	private agentHosts(): readonly ReconcileHost[] {
		const hosts = new Map<string, ReconcileHost>();
		for (const workspace of this.coordinator.model.workspaces) {
			if (workspace.agents.length === 0) continue;
			const runtime = runtimeFor(workspace.location);
			hosts.set(runtime.id, runtime);
		}
		if (hosts.size > 1) {
			throw new Error(
				`Agents are running on ${String(hosts.size)} machines, and one reconcile round can only be about one`,
			);
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
		// The flag is written first, and on purpose: it records that the person
		// asked to quit, which is true whether or not the teardown below manages
		// to finish. Writing it afterwards would report a crash every time a
		// runtime was slow to let go.
		markCleanShutdown(this.state);
		await this.stateStore.saveState(this.state);
		this.agentReconcilers.stop();
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

	appearance(): AppAppearance {
		const config = this.requireConfig();
		this.appearanceSequence += 1;
		return appearanceWire(config.appearance, this.appearanceSequence);
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

	/**
	 * Push one projection to every page that draws from it.
	 *
	 * The App Shell page and the modal overlay are two views of the same model
	 * — an alert about a workspace is the same workspace the sidebar lists —
	 * so they are told the same things at the same moment rather than the
	 * overlay fetching its own copy on a second path.
	 */
	private send(channel: string, payload: unknown): void {
		const shell = shellWindow();
		if (shell.window.isDestroyed()) return;
		shell.window.webContents.send(channel, payload);
		shell.modals.contents()?.send(channel, payload);
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
		shell.window.setTitle(
			shellTitleFor({
				selection: snapshot.selection,
				workspaces: snapshot.workspaces,
				editorElement: editorElement(
					shell.revealedTitle(),
					vscodeProduct.nameLong,
				),
			}),
		);
	}

	private publishAppearance(): void {
		if (!this.config) return;
		this.send(CHANNELS.appearanceChanged, this.appearance());
	}

	/**
	 * Tell every page DevHub draws chrome on what the Workbench now looks like.
	 *
	 * The App Shell page and the modal overlay are the same two views of the
	 * same window as everywhere else in this region, so the palette goes out
	 * the same way — a modal must never be a different colour from the window
	 * it is standing on.
	 */
	publishTheme(palette: ShellPalette): void {
		this.send(CHANNELS.themeChanged, palette);
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

	private publishError(error: AppErrorWire): void {
		this.send(CHANNELS.nativeError, error);
	}

	/**
	 * A failure from before there was a page, kept until there is one.
	 *
	 * Startup does things a person needs to be told about — reading the
	 * workbench's settings file is one — and it does them before the App Shell
	 * page exists. Published there and then, the message goes to a window with
	 * nothing loaded in it and is gone. So it waits, and the page's first
	 * request for the snapshot delivers it: that request is what "there is
	 * somebody to tell" means. It is delivered once, because an alert that
	 * comes back every time the page reloads cannot be dismissed.
	 */
	noteStartupFailure(error: AppErrorWire): void {
		this.startupFailure = error;
	}

	private startupFailure: AppErrorWire | undefined;

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
			if (!isStaleCompletion(error)) {
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
				await this.resolvePath(effect.token, effect.path);
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
			await this.stateStore.saveState(this.state);
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
		path: string,
	): Promise<void> {
		try {
			const expanded =
				path === "~"
					? homedir()
					: path.startsWith("~/")
						? join(homedir(), path.slice(2))
						: path;
			// A path somebody has just typed belongs to no Workspace yet, so
			// there is no location to ask about: it is a folder on this machine
			// or it is nothing. The `access` that used to follow the `stat` is
			// gone with it — with no mode it asked only whether the path
			// existed, which the `stat` above had already answered.
			const runtime = localRuntime();
			const canonical = await runtime.realpath(expanded);
			if ((await runtime.stat(canonical)) !== "directory") {
				throw new Error(`not a directory: ${canonical}`);
			}
			this.accept({
				type: "workspace_path_resolved",
				token,
				root: workspaceRoot(canonical),
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
				detail: `${path} could not be opened as a workspace: ${error instanceof Error ? error.message : String(error)}`,
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
			outcomeWire(settled, this.coordinator.readiness, this.repositoryOf),
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
		shellWindow().modals.openModal({
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
	 * Gather what `editorInspection` decides from. The rule itself lives there;
	 * this only reads the three places the facts come from.
	 */
	private async inspectEditors(
		workspaceId: WorkspaceId,
	): Promise<ResourceInspection> {
		const workspace = this.coordinator.model.workspace(workspaceId);
		if (workspace === undefined) {
			return editorInspection({ runtime: "absent", documentEdited: false });
		}
		const codeWindow = await this.editorWindowFor(workspace.key);
		return editorInspection({
			runtime: editorRuntimeState(codeWindow),
			documentEdited: codeWindow?.isDocumentEdited() === true,
		});
	}

	/**
	 * The `CodeWindow` bound to a folder, or nothing when there is no workbench
	 * for it any more.
	 *
	 * The binding in `viewsByEditorKey` outlives the view it names: a workbench
	 * that VS Code closed, or whose view DevHub destroyed, leaves its id
	 * behind. So "there is an entry in the map" is not "there is a workbench",
	 * and asking the window service is the only answer worth having. Reading
	 * the map alone is what used to make a workspace with no editor at all
	 * report that its editor was not running.
	 */
	private async editorWindowFor(
		folder: string,
	): Promise<ICodeWindow | undefined> {
		const viewId = this.viewsByEditorKey.get(folder);
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
	): Promise<void> {
		const adapter = agents();
		if (!adapter) {
			this.failOperation(
				token,
				agentSubject(agentId, {
					code: "agent_runtime_unavailable",
					detail: "The Agent runtime is not running.",
				}),
			);
			return;
		}
		let reconciliation: AgentReconciliation;
		try {
			reconciliation = await adapter.reconcile(agentId);
		} catch (error) {
			// A provider that would not answer is a failure of the Agent port, and
			// the model has to be told so: an effect nobody completes leaves the
			// operation open until its deadline and reports the deadline instead of
			// the outage. The reason goes to the log; the page is told which port
			// failed, in that port's own words, by the one path that reports
			// operation failures.
			console.error(error instanceof Error ? error.stack : error);
			this.failOperation(token, agentSubject(agentId, portRefusal(error)));
			return;
		}
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
	 * **The editor comes first, because it is the last question.** VS Code's
	 * `unload` is what runs the workbench's own "do you want to save?" and what
	 * lets it refuse — a veto is an answer, and an answer of "no" must leave
	 * everything as it was. So it runs before the first destructive step, and a
	 * veto stops the close with nothing stopped, killed or deleted.
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
		try {
			const vetoed = await withCloseDeadline(
				step,
				this.askEditorToClose(workspaceId),
			);
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
				await withCloseDeadline(
					step,
					agentAdapter.closeWorkspaceAgents(workspaceId),
				);
			}
			// With no Agent runtime there are no Agents, so this step is already
			// true — the model's own Agent list is emptied by the transition.

			step = "terminal";
			const terminalAdapter = terminals();
			if (terminalAdapter) {
				await withCloseDeadline(
					step,
					terminalAdapter.closeWorkspaceTerminals(workspaceId),
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
		this.accept({
			type: "workspace_close_completed",
			token,
			workspaceId,
			result: { kind: "closed" },
		});
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
		const viewId = this.viewsByEditorKey.get(key);
		this.viewsByEditorKey.delete(key);
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
		const folder = await readWorktreeFolder(
			runtimeFor(workspace.location),
			workspace.root,
		);
		const gitSaysWorktree =
			repository?.mainWorktree !== undefined &&
			repository.worktree === workspace.root &&
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
			await this.gitCommand(runtimeFor(workspace.location)),
			mainWorktree,
			workspace.root,
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
		// `reveal` is the whole of it: what is on screen and where the keyboard
		// is are one decision, made in one place (`ShellWindow.focusSurface`).
		// Focusing the view from here as well would take the keyboard into a
		// workbench even when the page's own Surface is the thing on screen.
		shellWindow().reveal(view);
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
		const existingId = this.viewsByEditorKey.get(folder);
		const existing =
			existingId === undefined
				? undefined
				: shellWindow().getViewById(existingId);
		if (existing) return Promise.resolve(existing);

		const inFlight = this.editorOpens.get(folder);
		if (inFlight) return inFlight;

		// Registered before the first `await` inside, so an open asked for twice
		// in the same tick is still one open. An open that has to wait for VS
		// Code's services is in flight from the moment it is asked for, which is
		// what stops startup from queuing one attempt per projection change.
		const attempt = this.openEditorView(folder).finally(() => {
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
	 * The place a workbench key names, or nothing for Scratch.
	 *
	 * Read out of the model rather than remembered beside the map, because the
	 * model is where a Workspace's place lives and a second copy is a second
	 * thing that can be stale. A key with no Workspace behind it any more is
	 * Scratch's answer too — there is nothing to open a folder on.
	 */
	private locationForEditorKey(
		editorKey: string,
	): WorkspaceLocation | undefined {
		if (editorKey === SCRATCH_EDITOR) return undefined;
		return this.coordinator.model.workspaces.find(
			(workspace) => workspace.key === editorKey,
		)?.location;
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
		// Go through VS Code's own open path, which is what creates a
		// `CodeWindow` — and therefore, through the shim, a view in the shell.
		// The same call for both kinds of place: an ssh folder differs only in
		// the URI, which carries the authority Open Remote - SSH answers for.
		const windows = await services.windows().open({
			context: OpenContext.API,
			cli: this.cliArgs,
			urisToOpen:
				location === undefined ? [] : [{ folderUri: folderUriFor(location) }],
			forceEmpty: location === undefined,
			forceNewWindow: true,
			noRecentEntry: true,
		});
		const opened = windows.at(0);
		if (opened) this.viewsByEditorKey.set(editorKey, opened.id);
		const view =
			opened === undefined ? undefined : shellWindow().getViewById(opened.id);
		if (view) {
			this.superviseEditorView(editorKey, view);
			// A workbench that is up again is no longer restarting. Waiting for
			// `did-finish-load` is not enough on its own: a fast workbench can
			// have finished loading before this promise resolved, and a `once` on
			// an event that already happened never fires — which would leave the
			// page saying "restarting" for ever about a workbench that is right
			// there.
			const settled = () => {
				this.editorRestarts.delete(editorKey);
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
		const surfaceKey =
			folder === SCRATCH_EDITOR
				? "global-editor"
				: this.coordinator.model.workspaces
						.filter((workspace) => workspace.root === folder)
						.map((workspace) => `workspace-editor:${workspace.id}`)
						.at(0);
		if (surfaceKey === undefined) return;
		this.send(CHANNELS.editorRestarting, { surfaceKey, restarting });
	}

	private superviseEditorView(folder: string, view: WorkbenchView): void {
		const died = (reason: string) => {
			// A view DevHub destroyed on purpose is not a casualty: its folder is
			// no longer in the table, because that is what destroying it means.
			if (this.viewsByEditorKey.get(folder) !== view.id) return;
			this.viewsByEditorKey.delete(folder);
			this.announceRestarting(folder, true);
			const failures = (this.editorRestarts.get(folder) ?? 0) + 1;
			this.editorRestarts.set(folder, failures);

			// The summary is what happened and how far along the recovery is; the
			// detail is why. A summary that named something else — "the native
			// app shell is unavailable", say — would be a false statement on the
			// one surface errors are read from, which is worse than no message.
			if (failures > MAX_EDITOR_RESTARTS) {
				this.publishError(
					withDetail(
						withSummary(
							errorWireAt("editor_restart_exhausted"),
							`The workbench stopped ${String(failures)} times and will not be restarted again.`,
						),
						reason,
					),
				);
				return;
			}
			this.publishError(
				withDetail(
					withSummary(
						errorWireAt("editor_restarting"),
						`The workbench stopped unexpectedly and is restarting (attempt ${String(failures)} of ${String(MAX_EDITOR_RESTARTS)}).`,
					),
					reason,
				),
			);
			const delay = RESTART_BACKOFF_MS * 2 ** (failures - 1);
			const timer = setTimeout(() => {
				void this.ensureEditorView(folder).catch((error: unknown) => {
					this.publishError(errorWire(error));
				});
			}, delay);
			(timer as unknown as { unref?: () => void }).unref?.();
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
			this.editorRestarts.delete(folder);
			this.announceRestarting(folder, false);
		});
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
	 * workbench, plus the scratch one, and nothing else does. Creating them at
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
		const wanted = new Set<string>([
			SCRATCH_EDITOR,
			...this.coordinator.model.workspaces
				.filter((workspace) => workspace.state.kind !== "unavailable")
				.map((workspace) => workspace.key),
		]);
		for (const folder of [...this.viewsByEditorKey.keys()]) {
			if (wanted.has(folder)) continue;
			const viewId = this.viewsByEditorKey.get(folder);
			this.viewsByEditorKey.delete(folder);
			if (viewId !== undefined) {
				shellWindow().getViewById(viewId)?.destroy();
			}
		}

		// The selected workbench first: it is the one being waited for.
		const ordered =
			selected === undefined
				? [...wanted]
				: [selected, ...[...wanted].filter((folder) => folder !== selected)];
		for (const folder of ordered) {
			void this.ensureEditorView(folder).catch((error: unknown) => {
				this.publishError(errorWire(error));
			});
		}
	}

	/**
	 * Put the selected workbench on screen, waiting for it if it is coming.
	 *
	 * Called when the page says the native surface is the one to show. A view
	 * that is already revealed is the whole answer; one whose open is in flight
	 * is waited for and then revealed; a folder with neither is the invariant
	 * violation the page's request is checked against, and it is thrown at the
	 * page rather than absorbed.
	 */
	private async revealSelectedEditor(): Promise<void> {
		const surfaceKey = this.selectedEditorSurfaceKey();
		const folder =
			surfaceKey === undefined
				? undefined
				: this.editorKeyForSurfaceKey(surfaceKey);
		// *This* folder's view, not "some workbench is revealed". Reading the
		// second as the first meant that selecting a workspace whose view was
		// not yet built, while another workbench was on screen, returned
		// "on-screen" with the wrong editor showing — rescued only by whichever
		// of `syncEditorViewInBackground` and this ran first.
		const viewId =
			folder === undefined ? undefined : this.viewsByEditorKey.get(folder);
		const revealed = shellWindow().revealedView();
		const reveal = editorReveal({
			revealed: viewId !== undefined && revealed?.id === viewId,
			opening: folder !== undefined && this.editorOpens.has(folder),
		});
		if (reveal === "on-screen") return;
		if (reveal === "coming" && surfaceKey !== undefined) {
			await this.revealEditorFor(surfaceKey);
			const now = shellWindow().revealedView();
			if (
				now !== undefined &&
				folder !== undefined &&
				this.viewsByEditorKey.get(folder) === now.id
			) {
				return;
			}
		}
		throw asIpcError(
			withDetail(
				errorWireAt("editor_unavailable"),
				`the page asked to show ${surfaceKey ?? "the editor surface"}, which has no live workbench view`,
			),
		);
	}

	private editorKeyForSurfaceKey(surfaceKey: string): string | undefined {
		if (surfaceKey === "global-editor") return SCRATCH_EDITOR;
		const prefix = "workspace-editor:";
		if (!surfaceKey.startsWith(prefix)) return undefined;
		const id = surfaceKey.slice(prefix.length) as WorkspaceId;
		return this.coordinator.model.workspace(id)?.key;
	}

	/**
	 * Ask a workspace's workbench whether it may close.
	 *
	 * Closing a window in VS Code is an *unload*, and an unload is what runs
	 * the workbench's "do you want to save?" and what lets it refuse. Killing
	 * the `WebContents` instead — which is what this used to do — skipped all
	 * of that and threw away unsaved work without asking.
	 *
	 * It does not close the view; the close's `view` step does, once this has
	 * answered. This is the *question*, and it is the last one a close asks.
	 *
	 * Nothing is remembered between attempts. There used to be a mark saying
	 * "this workbench did not answer last time", so that the second close
	 * killed it unasked — and the mark was written before the ask, so a
	 * workbench that was merely still starting got it, and the next close threw
	 * its work away without a prompt. A workbench that does not answer within
	 * the step's deadline is a failure of *this* step; the next close asks it
	 * again, which is the right thing for work that can still be saved.
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
		const runtime = editorRuntimeState(codeWindow);
		// No process holds work anybody could save, so there is nothing to ask
		// and nothing in the way.
		if (!codeWindow || runtime === "absent" || runtime === "gone") {
			return undefined;
		}
		// Still coming up: it cannot answer, and DevHub does not guess about a
		// workbench a person may be watching load. Said now rather than waited
		// out, because the answer would not change.
		if (runtime === "starting") return "close_editor_starting";
		const vetoed = await services
			.lifecycle()
			.unload(codeWindow, UnloadReason.CLOSE);
		return vetoed ? "close_editor_vetoed" : undefined;
	}

	/**
	 * Which editor surface a workbench view is, in the page's own vocabulary.
	 *
	 * A dialog raised by a workbench has to be drawn over *that* workbench, and
	 * the page knows its surfaces by key, not by view id.
	 */
	editorSurfaceKeyForView(viewId: number): string | undefined {
		for (const [key, id] of this.viewsByEditorKey) {
			if (id !== viewId) continue;
			if (key === SCRATCH_EDITOR) return "global-editor";
			const workspace = this.coordinator.model.workspaces.find(
				(candidate) => candidate.key === key,
			);
			return workspace ? `workspace-editor:${workspace.id}` : undefined;
		}
		return undefined;
	}

	/** The `openInBrowserWindow` override's half of the folder binding. */
	viewIdForEditorKey(folder: string): number | undefined {
		return this.viewsByEditorKey.get(folder);
	}

	bindEditorKeyView(folder: string, viewId: number): void {
		this.viewsByEditorKey.set(folder, viewId);
	}

	/**
	 * A place DevHub was asked to open. Its policy is that this is a Workspace:
	 * the model learns about it, and opening the same one twice selects the one
	 * that already exists rather than making a second.
	 */
	noteLocation(location: WorkspaceLocation): void {
		this.dispatchOwn({
			type: "open_folder",
			location:
				location.kind === "local"
					? requestedLocation({ kind: "local", path: location.path })
					: requestedLocation({
							kind: "ssh",
							host: location.host,
							path: location.path,
						}),
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
			return outcomeWire(opened, this.coordinator.readiness, this.repositoryOf);
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
		return outcomeWire(settled, this.coordinator.readiness, this.repositoryOf);
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

	/**
	 * Whether the scratch workbench is being built right now.
	 *
	 * `openInBrowserWindow` asks this to tell its two no-folder callers apart:
	 * DevHub building the scratch workbench (which must go through to upstream,
	 * or it would ask itself for the workbench it is creating) and everything
	 * else asking for an empty window (which is a request for scratch).
	 */
	isOpeningScratch(): boolean {
		return this.editorOpens.has(SCRATCH_EDITOR);
	}

	/**
	 * The scratch workbench, built if it is not there, revealed, and selected.
	 *
	 * This is where every "new window with no folder" ends up: DevHub has one
	 * window, and the empty workbench in it is the Scratch editor. Selecting
	 * Global → Editor is the same intent the menu's New Window raises, so the
	 * sidebar, the activity and the view agree afterwards however it was asked.
	 */
	async scratchWorkbench(): Promise<ICodeWindow> {
		await this.ensureEditorView(SCRATCH_EDITOR);
		await this.dispatchAwaiting({ type: "new_window" });
		await this.syncEditorView();
		return await this.workbenchWindow(SCRATCH_EDITOR);
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
		const viewId = this.viewsByEditorKey.get(folder);
		const window =
			viewId === undefined
				? undefined
				: (await this.services())
						.windows()
						.getWindows()
						.find((candidate) => candidate.id === viewId);
		if (!window) {
			throw new Error(
				`the workbench for ${folder === SCRATCH_EDITOR ? "the Scratch editor" : folder} is not running`,
			);
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
	 * and to the Scratch editor when no open Workspace contains it. It is
	 * deliberately never "the window you last looked at": the same command has
	 * to mean the same thing from the same directory, whatever has the focus.
	 *
	 * Either way the thing that was opened is then *activated* — selected in
	 * the sidebar, with the Editor activity showing and the window in front —
	 * because a command that opens something you cannot see has not opened it.
	 */
	async openFromCli(
		path: string,
		_cwd: string,
		position: ControlPosition | undefined,
		waitMarkerPath: string | undefined,
	): Promise<string> {
		return asSentence(() => this.doOpenFromCli(path, position, waitMarkerPath));
	}

	private async doOpenFromCli(
		path: string,
		position: ControlPosition | undefined,
		waitMarkerPath: string | undefined,
	): Promise<string> {
		// Taken before anything is selected: this is the "before" a `--wait`
		// goes back to when its editor is closed.
		const before = this.coordinator.model.selection;
		const target = await canonicalise(path);
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
				requestedLocation({ kind: "local", path: target.path }),
			);
			await this.syncEditorView();
			this.bringToFront();
			return `${target.path} is open in DevHub.`;
		}

		const root = workspaceRootFor(target.path, this.workspaceRoots());
		if (root === undefined) {
			await this.dispatchAwaiting({ type: "new_window" });
			await this.syncEditorView();
			openFileInWorkbench(
				await this.workbenchWindow(SCRATCH_EDITOR),
				target,
				position,
				waitMarkerPath,
			);
			this.rememberWaitReturn(waitMarkerPath, before);
			this.bringToFront();
			return `${target.path}${at(position)} is open in the Scratch editor: no open workspace contains it.`;
		}

		const workspace = this.coordinator.model.workspaces.find(
			(candidate) => candidate.root === root,
		);
		if (!workspace) {
			throw new Error(`no workspace is rooted at ${root}`);
		}
		await this.dispatchAwaiting({
			type: "select_context",
			context: { kind: "workspace", workspaceId: workspace.id },
			presentation: "full",
		});
		await this.syncEditorView();
		openFileInWorkbench(
			await this.workbenchWindow(root),
			target,
			position,
			waitMarkerPath,
		);
		this.rememberWaitReturn(waitMarkerPath, before);
		this.bringToFront();
		return `${target.path}${at(position)} is open in the workspace at ${root}.`;
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
		const onScreen = shellWindow().onScreenViewId();
		const views = shellWindow()
			.getViews()
			.filter((view) => !view.isDestroyed())
			.map((view) => ({
				pid: view.webContents.getOSProcessId(),
				id: view.id,
				surfaceKey: this.editorSurfaceKeyForView(view.id),
				onScreen: view.id === onScreen,
			}));
		const cpu = process.cpuUsage();
		// A terminal DevHub cannot reach has no clients to report, which is a
		// different sentence from "none are attached" only to a reader who has
		// one — and a reading taken before the runtime is up is the first of
		// those. Anything else the runtime says goes up: a socket that will not
		// answer is a fact about DevHub, and `--metrics` is where facts about
		// DevHub are read.
		const wiring = this.terminalsWiring;
		const terminalClients = wiring?.runtime.adapterAvailable
			? await wiring.runtime.listClientsUnlocked(
					new CancellationToken(),
					OperationDeadline.in(METRICS_CLIENT_TIMEOUT_MS),
				)
			: [];
		return JSON.stringify(
			metricsReport({
				takenAt: Date.now(),
				uptimeMs: Math.round(process.uptime() * 1000),
				mainProcessCpu: {
					userMs: Math.round(cpu.user / 1000),
					systemMs: Math.round(cpu.system / 1000),
				},
				processMetrics: electron.app.getAppMetrics(),
				views,
				counters: activityCounters.read(),
				terminalClients,
				runtimes: liveRuntimes().map((runtime) => runtime.reading()),
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
		const here = await canonicalise(cwd);
		const root = workspaceRootFor(here.path, this.workspaceRoots());
		if (root === undefined) {
			throw new Error(
				`${here.path} is not inside any open DevHub workspace, and an agent needs one — open the folder first with 'devhub <folder>'.`,
			);
		}
		const workspace = this.coordinator.model.workspaces.find(
			(candidate) => candidate.root === root,
		);
		if (!workspace) {
			throw new Error(`no workspace is rooted at ${root}`);
		}
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

	private workspaceRoots(): readonly string[] {
		return this.coordinator.model.workspaces.map((workspace) => workspace.root);
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

	revealEditorKeyView(folder: string): void {
		const viewId = this.viewsByEditorKey.get(folder);
		const view =
			viewId === undefined ? undefined : shellWindow().getViewById(viewId);
		if (view) shellWindow().reveal(view);
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
		this.config = config;
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
		return outcomeWire(settled, this.coordinator.readiness, this.repositoryOf);
	}

	/**
	 * `syncEditorView` where there is nobody to hand a failure back to.
	 *
	 * A projection changes for reasons with no caller — a reconciler round, a
	 * workbench finishing its open — so the promise has no `await` above it. A
	 * bare `void` on one of those routes its failure to the process's
	 * `unhandledRejection`, which is where the crash this replaced went; it
	 * belongs on the page's one error surface, the same as every failure with a
	 * caller.
	 */
	private syncEditorViewInBackground(): void {
		void this.syncEditorView().catch((error: unknown) => {
			this.publishError(errorWire(error));
		});
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
		return outcomeWire(settled, this.coordinator.readiness, this.repositoryOf);
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
			if (remote) await fetchBranchFrom(git, directory, remote, head.branch);
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
		const branch = linked ?? (await this.branchNamedFor(git, directory, item));
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
	): Promise<string | undefined> {
		await refreshOrigin(git, directory);
		const branches = await listBranches(git, directory);
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

		handle(CHANNELS.getSnapshot, () => {
			// A page asking for the world is the first moment there is anywhere
			// to say what went wrong before it existed. See `noteStartupFailure`.
			const pending = this.startupFailure;
			if (pending) {
				this.startupFailure = undefined;
				this.publishError(pending);
			}
			return this.snapshot();
		});
		handle(CHANNELS.getAppearance, () => this.appearance());
		handle(CHANNELS.getTheme, () => shellTheme().palette() ?? null);
		handle(CHANNELS.getAgentProfiles, () => this.agentProfiles());
		handle(CHANNELS.dispatch, (_event, intent: AppIntentWire) =>
			this.dispatchFromPage(intent),
		);
		handle(
			CHANNELS.replay,
			(_event, cursor: number): ReplayWire =>
				replayWire(
					this.coordinator.replayFrom(cursor),
					this.coordinator.readiness,
					this.repositoryOf,
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
		handle(CHANNELS.projectDefaultDirectory, () =>
			defaultProjectDirectory(this.config),
		);
		// The folders a clone can go into: the parents the sources imply, or —
		// when they imply none, which is what a configuration with no sources
		// means — the one folder DevHub would otherwise have guessed. The list is
		// never empty, so the sheet always has something to take with Return
		// rather than a blank field to compose a path in.
		handle(CHANNELS.cloneParentDirectories, async () => {
			const config = this.config;
			const parents =
				config === undefined ? [] : await collectParentDirectories(config);
			return parents.length > 0 ? parents : [defaultProjectDirectory(config)];
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
			async (_event, url: string, place: WorkspacePlaceWire) => {
				try {
					return await this.assignmentBranch(url, place);
				} catch (error: unknown) {
					throw asIpcError(errorWire(error));
				}
			},
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
			try {
				return await findClones(
					config,
					(place) => this.gitCommand(runtimeFor(workspaceLocation(place))),
					issue,
					// Every open Workspace, with the machine it is on. A remote
					// one used to arrive as a bare path and be read by this Mac's
					// git, which answered about a directory of the same name here
					// or about nothing at all.
					this.coordinator.model.workspaces.map((workspace) =>
						workspace.location.kind === "local"
							? { kind: "local" as const, path: workspace.location.path }
							: {
									kind: "ssh" as const,
									host: workspace.location.host,
									path: workspace.location.path,
								},
					),
				);
			} catch (error: unknown) {
				throw asIpcError(errorWire(error));
			}
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
		handle(CHANNELS.setContentRect, (_event, rect: ContentRect) => {
			shellWindow().setContentRect(rect);
		});
		// Escape in the Sidebar. The page can blur its own row but it cannot
		// focus a native workbench view, so where the keyboard goes stays main's
		// one answer and this is only the ask.
		handle(CHANNELS.focusSurface, () => {
			this.placeKeyboardOnSurface();
		});
		handle(
			CHANNELS.setContentSurface,
			async (_event, surface: ContentSurfaceWire) => {
				// Being asked to show a workbench that no longer exists is a broken
				// invariant, not a state to accommodate: the page only says this when
				// the Editor activity resolved to a surface, and every surface it can
				// resolve to has a view. Answering it by quietly showing nothing —
				// or by handing a destroyed view to Electron — turns a bug here into
				// a blank pane over there.
				//
				// A workbench that has not been built *yet* is a different fact, and
				// at launch it is the normal one: the restored selection is asked for
				// before the eager open for that folder has finished. So the reveal
				// joins the open already in flight and answers when the view is on
				// screen.
				if (surface !== "page") await this.revealSelectedEditor();
				shellWindow().setContentSurface(surface);
			},
		);
		// One way in and one way out for every modal DevHub shows. Main owns the
		// set that is open because the overlay view is a fact about the window,
		// not about whichever page happened to ask.
		handle(CHANNELS.openModal, (_event, request: ModalRequest) =>
			shellWindow().modals.openModal(request),
		);
		// A page that has nowhere to draw a failure hands it here, and it goes
		// out on the same channel every failure main raises goes out on. One
		// display site, one lifetime rule, whichever page the failure began on.
		handle(CHANNELS.raiseFailure, (_event, error: AppErrorWire) => {
			this.publishError(error);
		});
		handle(
			CHANNELS.closeModal,
			(_event, id: string, response: number | undefined) => {
				shellWindow().modals.closeModal(id, response);
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

/** How a `--goto` position reads back in the sentence the command prints. */
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
	setRuntimeProfile({ userDataDirectory: userDataPath, home: homedir() });

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
	let model: AppModel;
	let projectionFailure: string | undefined;
	try {
		model = hydrateModel(state, profiles);
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
		model = new AppModel();
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
