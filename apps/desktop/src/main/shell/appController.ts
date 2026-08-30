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
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import type { IWindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import { OpenContext } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import type { IDialogMainService } from "code-oss-dev/out/vs/platform/dialogs/electron-main/dialogMainService.js";
import type { ILifecycleMainService } from "code-oss-dev/out/vs/platform/lifecycle/electron-main/lifecycleMainService.js";
import { UnloadReason } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import {
	CHANNELS,
	type ContentRect,
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
import {
	AgentProfile,
	agentProfileId,
	displayPath,
	agentId as parseAgentId,
	type AgentId,
	surfaceKeyName,
	workspaceId as parseWorkspaceId,
	workspaceRoot,
	type AgentProfileKind,
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
	withDetail,
	withSummary,
	unavailableAgentProfiles,
	InvalidIntent,
} from "../../model/wire.js";
import { shellWindow } from "./shellWindow.js";
import type { WorkbenchView } from "./workbenchView.js";
import { agents, inspectWorkspaceResources, terminals } from "./adapters.js";
import { wireTerminals, type TerminalWiring } from "./terminalWiring.js";
import {
	CancellationToken,
	SCRATCH_TARGET,
	socketName,
	workspaceTarget,
	type TerminalPreflight,
} from "../terminal/ports.js";
import { wireAgents } from "./agentWiring.js";
import { resolveRuntimes } from "./runtimes.js";
import type { AgentService } from "../agent/index.js";
import { startWorkspacePicker } from "./workspacePicker.js";
import { installMenu, refreshMenu } from "./menu.js";
import {
	openSettingsWindow,
	publishSettingsSnapshot,
	settingsWindowIsFocused,
} from "./settingsWindow.js";

/**
 * The two main-process services the shell drives. They are resolved on demand:
 * VS Code's DI container builds them lazily, and the shell exists before it.
 */
export interface MainServices {
	windows(): IWindowsMainService;
	dialogs(): IDialogMainService;
	/** Closing a workbench is an unload, and an unload can be vetoed. */
	lifecycle(): ILifecycleMainService;
}

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

	private resolveServices: MainServices | undefined;
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
	 * Agents the adapter has said something about, waiting for one reconcile.
	 *
	 * An observation arrives *because* a reconcile is running, so dispatching a
	 * reconcile from one is a loop that never ends — and it runs on the main
	 * thread, so the app simply stops. What an observation means is "the model's
	 * idea of this Agent may be stale"; the answer is one reconcile after the
	 * current one finishes, not another one inside it.
	 */
	private readonly staleAgents = new Set<AgentId>();
	private reconcileScheduled = false;
	private reconciling = false;
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
		this.registerIpc();
		this.watchConfig();
	}

	//#region lifecycle

	/**
	 * The main-process services are built by VS Code's DI container, which is
	 * only assembled once the application starts up; the shell exists before that
	 * so the first workbench has somewhere to go.
	 */
	setServices(services: MainServices): void {
		this.resolveServices = services;
	}

	private services(): MainServices {
		if (!this.resolveServices) {
			throw new Error(
				"the App Shell was used before the main services were registered",
			);
		}
		return this.resolveServices;
	}

	/** Whether the previous run ended cleanly, for the Settings diagnostics. */
	previousExit(): "clean" | "unclean" | "unknown" {
		return this.previousExitValue;
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
		const resolved = await resolveRuntimes(
			config?.runtimes ?? {
				shell: "/bin/zsh",
				git: "git",
				tmux: "tmux",
				herdr: "herdr",
				tmux_socket_name: "devhub",
				tmux_args: [],
			},
		);
		this.terminalsWiring = wireTerminals({
			config,
			resolved: { tmux: resolved.tmux, shell: resolved.shell },
			effectiveSocketName: this.state.tmux.effective_socket_name,
			userDataPath,
			model: () => this.coordinator.model,
		});
		// Everything restored from the state file describes the previous run: an
		// Agent's status and its runtime health are what they were when DevHub
		// last wrote them down. Nothing will contradict them on its own — an
		// idle agent produces no events — so a restored Agent that is never
		// reconciled sits there claiming to be starting a runtime that started
		// long ago. Ask about each of them once, as soon as there is something
		// to ask.
		for (const workspace of this.coordinator.model.workspaces) {
			for (const agent of workspace.agents) {
				this.noteStaleAgent(agent.id);
			}
		}
		this.agentService = wireAgents({
			journalPath: join(userDataPath, "devhub", "agents.journal"),
			configuredHerdr: config?.runtimes.herdr ?? "herdr",
			home: homedir(),
			model: () => this.coordinator.model,
			onObserved: (agentId) => {
				this.noteStaleAgent(agentId);
			},
		});
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
			setSidebarVisible: (visible) => {
				this.dispatchOwn({ type: "set_sidebar_visible", visible });
			},
			closeWorkspace: (workspaceId) => {
				void this.dispatchFromPage({
					type: "request_close_workspace",
					workspaceId,
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
	 * Remember that an Agent may be stale, and reconcile once, later.
	 *
	 * Coalescing is the point: a burst of observations about several Agents is
	 * still one round of catching up, and none of it may happen while a
	 * reconcile is already in flight.
	 */
	private noteStaleAgent(agentId: AgentId): void {
		this.staleAgents.add(agentId);
		if (this.reconcileScheduled || this.reconciling) return;
		this.reconcileScheduled = true;
		const timer = setTimeout(() => {
			this.reconcileScheduled = false;
			this.reconcileStaleAgents();
		}, 250);
		// Catching up on Agents must never be the reason the process stays alive.
		(timer as unknown as { unref?: () => void }).unref?.();
	}

	private reconcileStaleAgents(): void {
		const pending = [...this.staleAgents].filter((agentId) =>
			this.coordinator.model.agent(agentId),
		);
		this.staleAgents.clear();
		if (pending.length === 0) return;
		this.reconciling = true;
		try {
			for (const agentId of pending) {
				this.dispatchOwn({ type: "reconcile_agent", agentId });
			}
		} finally {
			this.reconciling = false;
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
		this.stopWatchingConfig?.();
		// The flag is written first, and on purpose: it records that the person
		// asked to quit, which is true whether or not the teardown below manages
		// to finish. Writing it afterwards would report a crash every time a
		// runtime was slow to let go.
		markCleanShutdown(this.state);
		await this.stateStore.saveState(this.state);
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

	private send(channel: string, payload: unknown): void {
		const shell = shellWindow();
		if (!shell.window.isDestroyed()) {
			shell.window.webContents.send(channel, payload);
		}
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
		void this.syncEditorView();
	}

	private publishAppearance(): void {
		if (!this.config) return;
		this.send(CHANNELS.appearanceChanged, this.appearance());
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
			// A completion the coordinator refused is a real failure — a stale
			// token, an operation that no longer exists — and it belongs on screen
			// rather than in a log nobody reads.
			this.publishError(errorWire(error));
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
				new Error("the operation did not complete"),
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
						case "noop":
						case "operation_completed":
							break;
					}
				}
				if (latest) {
					this.send(CHANNELS.snapshotChanged, latest);
					this.projectionChanged();
				}
				for (const effect of effects) {
					void this.perform(effect);
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
				this.resolveProfile(effect.token, effect.workspaceId, effect.profileId);
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

	private resolveProfile(
		token: OperationToken,
		workspaceId: WorkspaceId,
		profileId: string,
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
			profile: toDomainProfile(configured),
		});
	}

	private async inspect(
		token: OperationToken,
		workspaceId: WorkspaceId,
	): Promise<void> {
		const workspace = this.coordinator.model.workspace(workspaceId);
		// What the shell itself knows about this Workspace's editors: a view it
		// never opened, or already closed, holds nothing. A live view might hold
		// unsaved work and nothing here can ask it, so that is `unknown` — and
		// the close confirmation says exactly that rather than guessing "clean".
		// Once the workbench has agreed to close, its editors *are* clean —
		// agreeing is what being clean means, and it is a better answer than
		// looking at whether a view object still exists.
		const state = workspace?.state;
		const agreed =
			state !== undefined &&
			(state.kind === "closing" || state.kind === "closing-failed") &&
			state.progress.editorClosed;
		const hasView =
			workspace !== undefined && this.viewsByFolder.has(workspace.root);
		const inspection = await inspectWorkspaceResources(
			workspaceId,
			workspace?.agents.length ?? 0,
			hasView && !agreed
				? { kind: "unknown", diagnostic: "close_editor_unknown" }
				: { kind: "clean" },
		);
		this.accept({
			type: "workspace_inspection_completed",
			token,
			workspaceId,
			inspection,
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
		const reconciliation = await adapter.reconcile(agentId);
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
	private async ensureEditorView(
		folder: string,
	): Promise<WorkbenchView | undefined> {
		const existingId = this.viewsByFolder.get(folder);
		const existing =
			existingId === undefined
				? undefined
				: shellWindow().getViewById(existingId);
		if (existing) return existing;

		const inFlight = this.editorOpens.get(folder);
		if (inFlight) return inFlight;

		// No view yet: go through VS Code's own open path, which is what creates a
		// `CodeWindow` — and therefore, through the shim, a view in the shell.
		const attempt = this.services()
			.windows()
			.open({
				context: OpenContext.API,
				cli: this.cliArgs,
				urisToOpen:
					folder === SCRATCH_EDITOR ? [] : [{ folderUri: URI.file(folder) }],
				forceEmpty: folder === SCRATCH_EDITOR,
				forceNewWindow: true,
				noRecentEntry: true,
			})
			.then((windows) => {
				const opened = windows.at(0);
				if (opened) this.viewsByFolder.set(folder, opened.id);
				const view =
					opened === undefined
						? undefined
						: shellWindow().getViewById(opened.id);
				if (view) this.superviseEditorView(folder, view);
				// A view no longer puts itself on screen when it is created, so
				// the arrival of one is a moment to ask the selection again what
				// belongs there — otherwise the workbench being waited for opens
				// and nothing reveals it.
				void this.syncEditorView();
				return view;
			})
			.finally(() => {
				this.editorOpens.delete(folder);
			});
		this.editorOpens.set(folder, attempt);
		return attempt;
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
	private superviseEditorView(folder: string, view: WorkbenchView): void {
		const died = (reason: string) => {
			// A view DevHub destroyed on purpose is not a casualty: its folder is
			// no longer in the table, because that is what destroying it means.
			if (this.viewsByFolder.get(folder) !== view.id) return;
			this.viewsByFolder.delete(folder);
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
		// Before VS Code's services exist there is no path that opens a
		// workbench. `markReady` publishes a projection as soon as there is, and
		// that is the call that starts them.
		if (!this.resolveServices) return;
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
		const codeWindow = this.services()
			.windows()
			.getWindows()
			.find((candidate) => candidate.id === viewId);
		if (!codeWindow) return true;
		const vetoed = await this.services()
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
		let outcome: IntentOutcome;
		try {
			outcome = this.coordinator.dispatchUser({
				intentId: parseIntentId(randomUUID()),
				operationId: this.freshOperationId(),
				intent: { type: "open_folder", path: requestedPath(path) },
			});
		} catch (error) {
			this.drain();
			throw asIpcError(errorWire(error));
		}
		this.drain();
		const settled = await this.settled(outcome);
		await this.syncEditorView();
		return outcomeWire(settled, this.coordinator.readiness);
	}

	/** The page's answer: whatever the chain this intent started produced. */
	private async settled(outcome: IntentOutcome): Promise<IntentOutcome> {
		try {
			return await this.awaitOutcome(outcome);
		} catch (error) {
			throw asIpcError(errorWire(error));
		}
	}

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
		this.drain();
		const settled = await this.settled(outcome);

		// Selecting the Editor activity is the moment its view has to exist. It is
		// done here rather than in the model because a view is an effect on the
		// window, and the model does not have windows.
		await this.syncEditorView();
		return outcomeWire(settled, this.coordinator.readiness);
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
		const picked = await this.services().dialogs().pickFolder({});
		return picked?.[0];
	}

	private registerIpc(): void {
		const handle = electron.ipcMain.handle.bind(electron.ipcMain);

		handle(CHANNELS.getSnapshot, () => this.snapshot());
		handle(CHANNELS.getAppearance, () => this.appearance());
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
		handle(CHANNELS.setSurfaceVisible, (_event, visible: boolean) => {
			shellWindow().setNativeSurfaceVisible(visible);
		});
		handle(CHANNELS.setModalOpen, (_event, open: boolean) => {
			shellWindow().setModalOpen(open);
		});
	}

	//#endregion
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
