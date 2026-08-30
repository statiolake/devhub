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
	surfaceKeyName,
	workspaceId as parseWorkspaceId,
	workspaceRoot,
	type AgentProfileKind,
	type WorkspaceId,
} from "../../model/domain.js";
import {
	operationId as parseOperationId,
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
	unavailableAgentProfiles,
	InvalidIntent,
} from "../../model/wire.js";
import { shellWindow } from "./shellWindow.js";
import { agents, inspectWorkspaceResources, terminals } from "./adapters.js";
import { startWorkspacePicker } from "./workspacePicker.js";
import {
	openSettingsWindow,
	publishSettingsSnapshot,
} from "./settingsWindow.js";

/**
 * The two main-process services the shell drives. They are resolved on demand:
 * VS Code's DI container builds them lazily, and the shell exists before it.
 */
export interface MainServices {
	windows(): IWindowsMainService;
	dialogs(): IDialogMainService;
}

/** The folder key a scratch (folderless) workbench view is filed under. */
const SCRATCH_EDITOR = "";

export class AppController {
	private readonly coordinator: AppCoordinator;
	private cursor = 0;
	private draining = false;

	/** Folder path (or the scratch key) -> the `ICodeWindow` id of its view. */
	private readonly viewsByFolder = new Map<string, number>();

	private resolveServices: MainServices | undefined;
	private config: Config | undefined;
	private state: PersistedAppState;
	private appearanceSequence = 0;
	private profileSequence = 0;
	private cancelPicker: (() => void) | undefined;
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

	markReady(): void {
		this.coordinator.markReady();
		this.coordinator.setEditorHostState({ kind: "ready" });
		this.publishSnapshot();
	}

	/** Record a clean shutdown, so the next launch knows this one ended well. */
	async shutdown(): Promise<void> {
		this.stopWatchingConfig?.();
		markCleanShutdown(this.state);
		await this.stateStore.saveState(this.state);
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
		try {
			this.coordinator.acceptProviderEvent({
				eventId: parseOperationId(randomUUID()) as never,
				event,
			});
		} catch (error) {
			// A completion the coordinator refused is a real failure — a stale
			// token, an operation that no longer exists — and it belongs on screen
			// rather than in a log nobody reads.
			this.publishError(errorWire(error));
		}
		this.drain();
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
			for (;;) {
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
		} catch {
			// A save that did not happen is reported as degraded, so the model can
			// roll back a close that depended on it rather than believing it landed.
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
		const inspection = await inspectWorkspaceResources(
			workspaceId,
			workspace?.agents.length ?? 0,
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
				case "editor":
					this.destroyEditorView(workspaceId);
					break;
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
		const existingId = this.viewsByFolder.get(folder);
		const existing =
			existingId === undefined
				? undefined
				: shellWindow().getViewById(existingId);
		if (existing) {
			shellWindow().reveal(existing);
			existing.focus();
			return;
		}
		// No view yet: go through VS Code's own open path, which is what creates a
		// `CodeWindow` — and therefore, through the shim, a view in the shell.
		const window = await this.services()
			.windows()
			.open({
				context: OpenContext.API,
				cli: this.cliArgs,
				urisToOpen:
					folder === SCRATCH_EDITOR ? [] : [{ folderUri: URI.file(folder) }],
				forceEmpty: folder === SCRATCH_EDITOR,
				forceNewWindow: true,
				noRecentEntry: true,
			});
		const opened = window.at(0);
		if (opened) {
			this.viewsByFolder.set(folder, opened.id);
		}
	}

	private folderForSurfaceKey(surfaceKey: string): string | undefined {
		if (surfaceKey === "global-editor") return SCRATCH_EDITOR;
		const prefix = "workspace-editor:";
		if (!surfaceKey.startsWith(prefix)) return undefined;
		const id = surfaceKey.slice(prefix.length) as WorkspaceId;
		return this.coordinator.model.workspace(id)?.root;
	}

	private destroyEditorView(workspaceId: WorkspaceId): void {
		const root = this.coordinator.model.workspace(workspaceId)?.root;
		if (root === undefined) return;
		const viewId = this.viewsByFolder.get(root);
		this.viewsByFolder.delete(root);
		if (viewId !== undefined) {
			shellWindow().getViewById(viewId)?.destroy();
		}
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
		await this.syncEditorView();
		return outcomeWire(outcome, this.coordinator.readiness);
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

		// Selecting the Editor activity is the moment its view has to exist. It is
		// done here rather than in the model because a view is an effect on the
		// window, and the model does not have windows.
		await this.syncEditorView();
		return outcomeWire(outcome, this.coordinator.readiness);
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
