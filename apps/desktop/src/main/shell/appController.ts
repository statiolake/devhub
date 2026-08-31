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
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { electron } from "../electron.js";
import { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import { CancellationToken as VSCancellationToken } from "code-oss-dev/out/vs/base/common/cancellation.js";
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import { OpenContext } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import { UnloadReason } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import {
	CHANNELS,
	type ContentRect,
	type ModalRequest,
	type WorkspacePickerEvent,
} from "../../ipc/contract.js";
import type {
	AgentProfiles,
	AppAppearance,
	AppErrorWire,
	AppIntentWire,
	AppOutcomeWire,
	AppSnapshotWire,
	ReplayWire,
} from "../../ipc/appShell.js";
import { AppCoordinator, type Effect } from "../../model/coordinator.js";
import { editorReveal } from "./editorReveal.js";
import { canonicalise } from "../cli/canonical.js";
import { openFileInWorkbench } from "../cli/openFiles.js";
import { workspaceRootFor } from "../cli/resolve.js";
import {
	AgentProfile,
	agentProfileId,
	displayPath,
	agentId as parseAgentId,
	surfaceKeyName,
	workspaceId as parseWorkspaceId,
	workspaceRoot,
	type AgentProfileKind,
	type AgentReconciliation,
	type ResourceInspection,
	type WorkspaceId,
} from "../../model/domain.js";
import {
	operationId as parseOperationId,
	type OperationId,
	confirmationId as parseConfirmationId,
	intentId as parseIntentId,
	requestedPath,
	AppError,
	AppErrorCode,
	type IntentOutcome,
	type OperationToken,
	type ProviderEvent,
	type UserIntent,
} from "../../model/intents.js";
import { AppModel } from "../../model/appModel.js";
import {
	ConfigStore,
	defaultConfigPath,
	type Config,
} from "../../model/config.js";
import {
	applySnapshot,
	hydrateModel,
	JsonStateStore,
	markCleanShutdown,
	markStarting,
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
import type { ShellPalette } from "../../ipc/palette.js";
import type { WorkbenchView } from "./workbenchView.js";
import { agents, inspectWorkspaceResources, terminals } from "./adapters.js";
import { editorInspection } from "./editorInspection.js";
import { wireTerminals, type TerminalWiring } from "./terminalWiring.js";
import {
	CancellationToken,
	SCRATCH_TARGET,
	socketName,
	workspaceTarget,
	type TerminalPreflight,
} from "../terminal/ports.js";
import { wireAgents } from "./agentWiring.js";
import { AgentReconciler } from "./agentReconciler.js";
import { MainServicesGate, type MainServices } from "./mainServices.js";
import { resolveRuntimes } from "./runtimes.js";
import {
	launchEnvironment,
	resolveLoginEnvironment,
	type LoginEnvironment,
} from "./loginEnvironment.js";
import type { AgentService } from "../agent/index.js";
import { startWorkspacePicker } from "./workspacePicker.js";
import { installMenu, refreshMenu } from "./menu.js";
import { installKeyboard } from "./keyboard.js";
import {
	openSettingsWindow,
	publishSettingsSnapshot,
	settingsWindowIsFocused,
} from "./settingsWindow.js";

/** The folder key a scratch (folderless) workbench view is filed under. */
const SCRATCH_EDITOR = "";

/** How long the page waits for a deferred operation before it is a failure. */
const OPERATION_TIMEOUT_MS = 60_000;

/** More rounds than any real chain needs, and fewer than a cycle survives. */
const MAX_DRAIN_ROUNDS = 512;

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

	/** Folder path (or the scratch key) -> the `ICodeWindow` id of its view. */
	private readonly viewsByFolder = new Map<string, number>();
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
	private agentService: AgentService | undefined;
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
	private readonly agentReconciler = new AgentReconciler({
		hasAgents: () =>
			this.coordinator.model.workspaces.some(
				(workspace) => workspace.agents.length > 0,
			),
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
		this.coordinator = new AppCoordinator(model);
		// The overlay has to know whether the workbench a question belongs to is
		// the one on screen. Views are the window's; surface keys are the
		// model's; this is the one place the two are joined.
		shellWindow().setSurfaceKeyResolver((view) =>
			this.editorSurfaceKeyForView(view.id),
		);
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
	 * Bring up the terminal and Agent runtimes.
	 *
	 * They are built after the config and the state are loaded, because both
	 * are inputs: which tmux and shell to use, which socket is in effect, and
	 * which Herdr command to launch all come from those two files.
	 */
	async startRuntimes(userDataPath: string): Promise<void> {
		const config = this.config;
		// On a state file that has never existed, the configured socket *is* the
		// effective one: there are no sessions to migrate, so adopting it is the
		// whole of the change. Once a run has owned sessions on a socket, the
		// configured name becomes a request Settings has to apply, because
		// switching silently would abandon them.
		const configuredSocket = config?.runtimes.tmux_socket_name;
		if (
			this.freshState &&
			configuredSocket !== undefined &&
			this.state.tmux.transition.kind === "stable" &&
			this.state.tmux.effective_socket_name !== configuredSocket
		) {
			this.state.tmux.effective_socket_name = configuredSocket;
			await this.stateStore.saveState(this.state);
		}
		// The environment is resolved before anything is looked up in it, and
		// once. A DevHub launched from Finder inherits launchd's four-entry PATH,
		// so without this the lookups below would find neither the user's tmux
		// nor their Herdr, and the terminals and agents launched with it would
		// not find their tools either. One environment, one resolution: what
		// DevHub can find and what a shell inside it can find cannot disagree.
		this.loginEnvironment = await resolveLoginEnvironment({
			enabled: config?.general.import_login_environment ?? true,
		});
		this.launchEnvironment = launchEnvironment(
			process.env,
			this.loginEnvironment,
		);
		const resolved = await resolveRuntimes(
			config?.runtimes ?? {
				shell: "/bin/zsh",
				git: "git",
				tmux: "tmux",
				herdr: "herdr",
				tmux_socket_name: "devhub",
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
		this.agentService = wireAgents({
			journalPath: join(userDataPath, "devhub", "agents.journal"),
			configuredHerdr: config?.runtimes.herdr ?? "herdr",
			home: homedir(),
			environment: this.launchEnvironment,
			model: () => this.coordinator.model,
			onObserved: () => {
				this.agentReconciler.wake();
			},
		});
		// Everything restored from the state file describes the previous run.
		// The adapter is told which Workspace each restored Agent belongs to,
		// so the provider snapshot it takes can be matched back to the rows
		// that are already on screen; the loop below does the rest.
		for (const workspace of this.coordinator.model.workspaces) {
			for (const agent of workspace.agents) {
				this.agentService.runtime.restoreAgent(
					agent.id,
					workspace.id,
					workspace.root,
				);
			}
		}
		this.agentReconciler.start();
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
			selectActivity: (activity) => {
				this.dispatchOwn({ type: "select_activity", activity });
			},
			setSidebarExpanded: (expanded) => {
				this.dispatchOwn({ type: "set_sidebar_expanded", expanded });
			},
			closeWorkspace: (workspaceId) => {
				// A menu command has no caller waiting on its answer, so its
				// failure goes to the error surface like every other one.
				void this.dispatchFromPage({
					type: "request_close_workspace",
					workspaceId,
				}).catch((error: unknown) => {
					this.publishError(errorWire(error));
				});
			},
			openWorkspacePicker: () => {
				this.send(CHANNELS.menuCommand, "open_workspace_picker");
			},
			openSettings: () => {
				openSettingsWindow();
			},
		});
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
			selectContext: (context) => {
				this.dispatchOwn(intentFromWire({ type: "select_context", context }));
			},
			selectActivity: (activity) => {
				this.dispatchOwn({ type: "select_activity", activity });
			},
			setSidebarExpanded: (expanded) => {
				this.dispatchOwn({ type: "set_sidebar_expanded", expanded });
			},
			openWorkspacePicker: () => {
				this.send(CHANNELS.menuCommand, "open_workspace_picker");
			},
			openSettings: () => {
				openSettingsWindow();
			},
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
	 * One round of the reconciler: ask the provider about every Agent and let
	 * the model settle before the next round is scheduled.
	 */
	private async reconcileAllAgents(): Promise<void> {
		await this.dispatchAwaiting({ type: "reconcile_agents" });
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
		this.agentReconciler.stop();
		this.terminalsWiring?.service.dispose();
		await this.agentService?.dispose();
	}

	//#endregion

	//#region projections

	snapshot(): AppSnapshotWire {
		return snapshotWire(
			this.coordinator.snapshot(),
			this.coordinator.readiness,
		);
	}

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
		this.syncEditorViews();
		// What is on screen follows the selection, wherever the selection
		// changed — a menu command, a restored session, or the page.
		this.syncEditorViewInBackground();
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

	private publishProfiles(): void {
		this.send(CHANNELS.agentProfilesChanged, this.agentProfiles());
	}

	private publishError(error: AppErrorWire): void {
		this.send(CHANNELS.nativeError, error);
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
							latest = snapshotWire(event.snapshot, this.coordinator.readiness);
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
				this.resolveProfile(
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
			case "cleanup_workspace":
				await this.cleanup(effect.token, effect.workspaceId, effect.step);
				return;
		}
	}

	private async persist(token: OperationToken): Promise<void> {
		try {
			this.state = applySnapshot(this.state, this.coordinator.snapshot());
			await this.stateStore.saveState(this.state);
		} catch (error) {
			// A save that did not happen is reported as degraded, so the model can
			// roll back a close that depended on it rather than believing it landed
			// — and the reason it did not happen goes to the page, because a
			// silent one turns every later symptom into a mystery.
			this.publishError(errorWire(error));
			this.accept({ type: "state_persistence_failed", token });
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
			const canonical = await realpath(expanded);
			if (!(await stat(canonical)).isDirectory()) {
				throw new Error(`not a directory: ${canonical}`);
			}
			await access(canonical);
			this.accept({
				type: "workspace_path_resolved",
				token,
				root: workspaceRoot(canonical),
				selectedPath: displayPath(canonical),
			});
		} catch {
			this.accept({ type: "operation_failed", token });
		}
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
	 */
	private resolveProfile(
		token: OperationToken,
		workspaceId: WorkspaceId,
		profileId: string,
		extraArgs: readonly string[],
	): void {
		const configured = this.config?.agentProfiles.find(
			(profile) => profile.id === profileId,
		);
		if (!configured) {
			this.accept({ type: "operation_failed", token });
			return;
		}
		this.accept({
			type: "profile_resolved",
			token,
			workspaceId,
			profile: toDomainProfile({
				...configured,
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
			workspace?.agents.length ?? 0,
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
		const state = workspace?.state;
		const facts = {
			editorAgreedToClose:
				state !== undefined &&
				(state.kind === "closing" || state.kind === "closing-failed") &&
				state.progress.editorClosed,
			hasView:
				workspace !== undefined && this.viewsByFolder.has(workspace.root),
			workbenchIsRunning: false,
			documentEdited: false,
		};
		if (!facts.hasView || facts.editorAgreedToClose) {
			return editorInspection(facts);
		}
		const viewId = this.viewsByFolder.get(workspace?.root ?? "");
		const codeWindow = (await this.services())
			.windows()
			.getWindows()
			.find((candidate) => candidate.id === viewId);
		const contents = codeWindow?.win?.webContents;
		return editorInspection({
			...facts,
			// `isReady` is the workbench's own handshake: it is true from the
			// moment the workbench signalled it had come up, and false again
			// while it navigates. Crashed or destroyed contents cannot answer
			// either, whatever the handshake last said.
			workbenchIsRunning:
				codeWindow?.isReady === true &&
				contents !== undefined &&
				!contents.isDestroyed() &&
				!contents.isCrashed(),
			documentEdited: codeWindow?.isDocumentEdited() === true,
		});
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
			// Nothing can launch an Agent, so nothing pretends one launched.
			this.accept({ type: "operation_failed", token });
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
			this.accept({ type: "operation_failed", token });
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
			this.accept({ type: "operation_failed", token });
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
			this.accept({ type: "operation_failed", token });
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
			this.accept({ type: "operation_failed", token });
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

	private async cleanup(
		token: OperationToken,
		workspaceId: WorkspaceId,
		step: "agents" | "terminal" | "editor" | "state_committed",
	): Promise<void> {
		try {
			switch (step) {
				case "agents": {
					const adapter = agents();
					if (adapter) {
						await adapter.closeWorkspaceAgents(workspaceId);
					}
					// With no Agent runtime there are no Agents, so this step is already
					// true — the model's own Agent list is emptied by the transition.
					break;
				}
				case "terminal": {
					const adapter = terminals();
					if (adapter) {
						await adapter.closeWorkspaceTerminals(workspaceId);
					}
					break;
				}
				case "editor": {
					const closed = await this.askEditorToClose(workspaceId);
					if (!closed) {
						// The workbench refused — unsaved work, most likely, and the
						// person has just been asked about it. That is a reason, not
						// an error, and it belongs on the failure surface.
						this.accept({
							type: "workspace_cleanup_completed",
							token,
							workspaceId,
							result: {
								kind: "failed",
								step,
								diagnostic: "close_editor_vetoed",
							},
						});
						return;
					}
					break;
				}
				case "state_committed":
					break;
			}
		} catch {
			this.accept({
				type: "workspace_cleanup_completed",
				token,
				workspaceId,
				result: { kind: "failed", step, diagnostic: "cleanup_failed" },
			});
			return;
		}
		this.accept({
			type: "workspace_cleanup_completed",
			token,
			workspaceId,
			result: { kind: "step_completed", step },
		});
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
		const folder = this.folderForSurfaceKey(surfaceKey);
		if (folder === undefined) return;
		const view = await this.ensureEditorView(folder);
		if (!view) return;
		shellWindow().reveal(view);
		view.focus();
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
		const existingId = this.viewsByFolder.get(folder);
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
	private async openEditorView(
		folder: string,
	): Promise<WorkbenchView | undefined> {
		const services = await this.services();
		// Go through VS Code's own open path, which is what creates a
		// `CodeWindow` — and therefore, through the shim, a view in the shell.
		const windows = await services.windows().open({
			context: OpenContext.API,
			cli: this.cliArgs,
			urisToOpen:
				folder === SCRATCH_EDITOR ? [] : [{ folderUri: URI.file(folder) }],
			forceEmpty: folder === SCRATCH_EDITOR,
			forceNewWindow: true,
			noRecentEntry: true,
		});
		const opened = windows.at(0);
		if (opened) this.viewsByFolder.set(folder, opened.id);
		const view =
			opened === undefined ? undefined : shellWindow().getViewById(opened.id);
		if (view) {
			this.superviseEditorView(folder, view);
			// A workbench that is up again is no longer restarting. Waiting for
			// `did-finish-load` is not enough on its own: a fast workbench can
			// have finished loading before this promise resolved, and a `once` on
			// an event that already happened never fires — which would leave the
			// page saying "restarting" for ever about a workbench that is right
			// there.
			const settled = () => {
				this.editorRestarts.delete(folder);
				this.announceRestarting(folder, false);
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
			if (this.viewsByFolder.get(folder) !== view.id) return;
			this.viewsByFolder.delete(folder);
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
	syncEditorViews(): void {
		// No readiness check here, and none anywhere else either: an open that
		// starts before VS Code's services exist waits inside `ensureEditorView`
		// for exactly as long as it has to. See `mainServices.ts`.
		const snapshot = this.coordinator.snapshot();
		const editor = snapshot.activities.find(
			(entry) => entry.activity === "editor",
		);
		const selected =
			editor?.resolution.kind === "enabled"
				? this.folderForSurfaceKey(surfaceKeyName(editor.resolution.surfaceKey))
				: undefined;

		const wanted = new Set<string>([
			SCRATCH_EDITOR,
			...this.coordinator.model.workspaces.map((workspace) => workspace.root),
		]);
		for (const folder of [...this.viewsByFolder.keys()]) {
			if (wanted.has(folder)) continue;
			const viewId = this.viewsByFolder.get(folder);
			this.viewsByFolder.delete(folder);
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
		const snapshot = this.coordinator.snapshot();
		const editor = snapshot.activities.find(
			(entry) => entry.activity === "editor",
		);
		const surfaceKey =
			editor?.resolution.kind === "enabled"
				? surfaceKeyName(editor.resolution.surfaceKey)
				: undefined;
		const folder =
			surfaceKey === undefined
				? undefined
				: this.folderForSurfaceKey(surfaceKey);
		const reveal = editorReveal({
			revealed: shellWindow().revealedView() !== undefined,
			opening: folder !== undefined && this.editorOpens.has(folder),
		});
		if (reveal === "on-screen") return;
		if (reveal === "coming" && surfaceKey !== undefined) {
			await this.revealEditorFor(surfaceKey);
			if (shellWindow().revealedView()) return;
		}
		throw asIpcError(
			withDetail(
				errorWireAt("editor_unavailable"),
				`the page asked to show ${surfaceKey ?? "the editor surface"}, which has no live workbench view`,
			),
		);
	}

	private folderForSurfaceKey(surfaceKey: string): string | undefined {
		if (surfaceKey === "global-editor") return SCRATCH_EDITOR;
		const prefix = "workspace-editor:";
		if (!surfaceKey.startsWith(prefix)) return undefined;
		const id = surfaceKey.slice(prefix.length) as WorkspaceId;
		return this.coordinator.model.workspace(id)?.root;
	}

	/**
	 * Ask a workspace's workbench whether it may close.
	 *
	 * Closing a window in VS Code is an *unload*, and an unload is what runs
	 * the workbench's "do you want to save?" and what lets it refuse. Killing
	 * the `WebContents` instead — which is what this used to do — skipped all
	 * of that and threw away unsaved work without asking.
	 *
	 * It also does not destroy the view. Nothing here does: a view belongs to
	 * a workspace, and it goes when the workspace does (`syncEditorViews`). A
	 * step that destroyed it early is how a close that failed later left a
	 * workspace in the sidebar with a white pane beside it.
	 */
	private async askEditorToClose(workspaceId: WorkspaceId): Promise<boolean> {
		const root = this.coordinator.model.workspace(workspaceId)?.root;
		if (root === undefined) return true;
		const viewId = this.viewsByFolder.get(root);
		if (viewId === undefined) return true;
		const services = await this.services();
		const codeWindow = services
			.windows()
			.getWindows()
			.find((candidate) => candidate.id === viewId);
		if (!codeWindow) return true;
		const vetoed = await services
			.lifecycle()
			.unload(codeWindow, UnloadReason.CLOSE);
		return !vetoed;
	}

	/**
	 * Which editor surface a workbench view is, in the page's own vocabulary.
	 *
	 * A dialog raised by a workbench has to be drawn over *that* workbench, and
	 * the page knows its surfaces by key, not by view id.
	 */
	editorSurfaceKeyForView(viewId: number): string | undefined {
		for (const [folder, id] of this.viewsByFolder) {
			if (id !== viewId) continue;
			if (folder === SCRATCH_EDITOR) return "global-editor";
			const workspace = this.coordinator.model.workspaces.find(
				(candidate) => candidate.root === folder,
			);
			return workspace ? `workspace-editor:${workspace.id}` : undefined;
		}
		return undefined;
	}

	/** The `openInBrowserWindow` override's half of the folder binding. */
	viewIdForFolder(folder: string): number | undefined {
		return this.viewsByFolder.get(folder);
	}

	bindFolderView(folder: string, viewId: number): void {
		this.viewsByFolder.set(folder, viewId);
	}

	/**
	 * A folder DevHub was asked to open. Its policy is that this is a Workspace:
	 * the model learns about it, and opening the same one twice selects the one
	 * that already exists rather than making a second.
	 */
	noteFolder(folder: string): void {
		this.dispatchOwn({ type: "open_folder", path: requestedPath(folder) });
	}

	/** Open a folder on the page's behalf, and answer with the outcome. */
	private async openFolder(path: string): Promise<AppOutcomeWire> {
		const settled = await this.dispatchAwaiting({
			type: "open_folder",
			path: requestedPath(path),
		});
		await this.syncEditorView();
		return outcomeWire(settled, this.coordinator.readiness);
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

	/** The `ICodeWindow` behind a folder's view; a missing one is a bug. */
	private async workbenchWindow(folder: string): Promise<ICodeWindow> {
		const viewId = this.viewsByFolder.get(folder);
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
	async openFromCli(path: string, _cwd: string): Promise<string> {
		return asSentence(() => this.doOpenFromCli(path));
	}

	private async doOpenFromCli(path: string): Promise<string> {
		const target = await canonicalise(path);
		if (target.isDirectory) {
			await this.openFolder(target.path);
			await this.dispatchAwaiting({
				type: "select_activity",
				activity: "editor",
			});
			await this.syncEditorView();
			this.bringToFront();
			return `${target.path} is open in DevHub.`;
		}

		const root = workspaceRootFor(target.path, this.workspaceRoots());
		if (root === undefined) {
			await this.dispatchAwaiting({ type: "new_window" });
			await this.syncEditorView();
			openFileInWorkbench(await this.workbenchWindow(SCRATCH_EDITOR), target);
			this.bringToFront();
			return `${target.path} is open in the Scratch editor: no open workspace contains it.`;
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
		});
		await this.dispatchAwaiting({
			type: "select_activity",
			activity: "editor",
		});
		await this.syncEditorView();
		openFileInWorkbench(await this.workbenchWindow(root), target);
		this.bringToFront();
		return `${target.path} is open in the workspace at ${root}.`;
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
		});
		// Creating an Agent selects it; the Activity is the half the model does
		// not choose, and showing the Agent is the whole point of the command.
		await this.dispatchAwaiting({ type: "select_activity", activity: "agent" });
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
	 */
	private bringToFront(): void {
		const shell = shellWindow();
		shell.window.show();
		shell.window.focus();
		electron.app.focus({ steal: true });
	}

	/** Hand a request's files to a workbench, exactly as upstream would. */
	sendFilesToWorkbench(window: ICodeWindow, files: unknown): void {
		window.sendWhenReady("vscode:openFiles", VSCancellationToken.None, files);
	}

	//#endregion

	//#region workbench views

	revealFolderView(folder: string): void {
		const viewId = this.viewsByFolder.get(folder);
		const view =
			viewId === undefined ? undefined : shellWindow().getViewById(viewId);
		if (view) {
			shellWindow().reveal(view);
			view.focus();
		}
	}

	//#endregion

	//#region config

	private watchConfig(): void {
		this.stopWatchingConfig = this.configStore.watch(2000, (outcome) => {
			if ("kind" in outcome && outcome.kind === "applied") {
				this.config = outcome.loaded.config;
				this.publishAppearance();
				this.publishProfiles();
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
		return outcomeWire(settled, this.coordinator.readiness);
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
		const snapshot = this.coordinator.snapshot();
		if (snapshot.selection.activity !== "editor") return;
		const active = snapshot.activities.find(
			(activity) => activity.activity === "editor",
		);
		if (active?.resolution.kind !== "enabled") return;
		await this.revealEditorFor(surfaceKeyName(active.resolution.surfaceKey));
	}

	private async pickFolder(): Promise<string | undefined> {
		const picked = await (await this.services()).dialogs().pickFolder({});
		return picked?.[0];
	}

	private registerIpc(): void {
		const handle = electron.ipcMain.handle.bind(electron.ipcMain);

		handle(CHANNELS.getSnapshot, () => this.snapshot());
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
		handle(CHANNELS.selectWorkspacePicker, async (_event, path: string) => {
			this.cancelPicker?.();
			this.cancelPicker = undefined;
			return this.openFolder(path);
		});

		handle(CHANNELS.openSettings, () => {
			openSettingsWindow();
		});
		handle(CHANNELS.openExternalUrl, (_event, url: string) =>
			electron.shell.openExternal(url),
		);
		handle(CHANNELS.setContentRect, (_event, rect: ContentRect) => {
			shellWindow().setContentRect(rect);
		});
		handle(CHANNELS.setSurfaceVisible, async (_event, visible: boolean) => {
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
			if (visible) await this.revealSelectedEditor();
			shellWindow().setNativeSurfaceVisible(visible);
		});
		// One way in and one way out for every modal DevHub shows. Main owns the
		// set that is open because the overlay view is a fact about the window,
		// not about whichever page happened to ask.
		handle(CHANNELS.openModal, (_event, request: ModalRequest) =>
			shellWindow().modals.openModal(request),
		);
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
	args: readonly string[];
	env: Readonly<Record<string, string>>;
}): AgentProfile {
	return AgentProfile.create(
		agentProfileId(profile.id),
		profile.display_name,
		profile.kind,
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

	const configStore = new ConfigStore(defaultConfigPath(homedir()));
	let config: Config | undefined;
	try {
		config = (await configStore.load()).config;
	} catch {
		// A config that will not parse is not a reason not to start: the shell
		// comes up, and the failure is reported to the page and the Settings
		// window rather than taking the app down.
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
	try {
		model = hydrateModel(state, profiles);
	} catch {
		// A state file that validates but cannot be projected is a bug, and the
		// app starting empty is better than not starting — the file is kept, not
		// overwritten, so it is still there to look at.
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
