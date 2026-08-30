/**
 * The Settings window.
 *
 * A second real `BrowserWindow` showing the same page with `?window=settings`,
 * and the small IPC surface behind it: read the config, save it against the
 * revision it was drafted from, reload, re-resolve the runtimes, and reach the
 * two diagnostics affordances.
 *
 * It is a singleton because there is one config file. Opening Settings twice
 * would be two drafts of one document, and the second save would silently lose
 * the first.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { electron } from "../electron.js";
import {
	SETTINGS_CHANNELS,
	SETTINGS_SCHEMA_VERSION,
	type SettingsConfigWire,
	type SettingsErrorWire,
	type SettingsSaveRequestWire,
	type SettingsSnapshotWire,
} from "../../ipc/settings.js";
import {
	ConfigError,
	type Config,
	type ConfigStore,
	type WorkspaceSource,
} from "../../model/config.js";
import { resolveRuntimes, runtimeHealth } from "./runtimes.js";
import { SHELL_ORIGIN } from "./shellPageProtocol.js";

interface SettingsHost {
	readonly store: ConfigStore;
	readonly logDirectory: string;
	readonly preloadPath: string;
	previousExit(): "clean" | "unclean" | "unknown";
	/** Told when a save changed the config, so the shell re-projects it. */
	adopt(config: Config): void;
}

let host: SettingsHost | undefined;
let window: Electron.BrowserWindow | undefined;
let sequence = 0;
const sessionId = randomUUID();

export function installSettingsWindow(next: SettingsHost): void {
	host = next;
	registerIpc();
}

function requireHost(): SettingsHost {
	if (!host) {
		throw new Error("the Settings window was used before it was installed");
	}
	return host;
}

export function openSettingsWindow(): void {
	const settings = requireHost();
	if (window && !window.isDestroyed()) {
		window.show();
		window.focus();
		return;
	}
	window = new electron.BrowserWindow({
		width: 860,
		height: 640,
		minWidth: 640,
		minHeight: 480,
		title: "DevHub Settings",
		titleBarStyle: "hiddenInset",
		show: false,
		webPreferences: {
			preload: settings.preloadPath,
			sandbox: false,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	void window.loadURL(`${SHELL_ORIGIN}/index.html?window=settings`);
	window.once("ready-to-show", () => {
		window?.show();
	});
	window.on("closed", () => {
		window = undefined;
	});
}

/** Tell an open Settings window that the file changed underneath it. */
export function publishSettingsSnapshot(): void {
	if (!window || window.isDestroyed() || !host) return;
	void buildSnapshot().then(
		(snapshot) => {
			window?.webContents.send(SETTINGS_CHANNELS.changed, snapshot);
		},
		() => {
			// The page keeps what it has and shows its own diagnostic; a push that
			// could not be built is not a reason to tear the window down.
		},
	);
}

function toWireConfig(config: Config): SettingsConfigWire {
	return {
		version: config.version,
		general: {
			importLoginEnvironment: config.general.import_login_environment,
		},
		runtimes: {
			shell: config.runtimes.shell,
			git: config.runtimes.git,
			tmux: config.runtimes.tmux,
			herdr: config.runtimes.herdr,
			tmuxSocketName: config.runtimes.tmux_socket_name,
			tmuxArgs: [...config.runtimes.tmux_args],
		},
		appearance: {
			colorScheme: config.appearance.colorScheme,
			sidebarDensity: config.appearance.sidebarDensity,
			terminalFontFamily: config.appearance.terminalFontFamily,
			terminalFontSize: config.appearance.terminalFontSize,
			terminalLineHeight: config.appearance.terminalLineHeight,
			terminalMargin: config.appearance.terminalMargin,
			terminalTheme: config.appearance.terminalTheme,
		},
		workspaceSources: config.workspaceSources.map((source) =>
			source.type === "filesystem"
				? {
						type: "filesystem" as const,
						id: source.id,
						path: source.path,
						minDepth: source.min_depth,
						maxDepth: source.max_depth ?? null,
						kinds: [...source.kinds],
						includeHidden: source.include_hidden,
						excludeNames: [...source.exclude_names],
					}
				: {
						type: "command" as const,
						id: source.id,
						command: [...source.command],
						timeoutMs: source.timeout_ms,
					},
		),
		agentProfiles: config.agentProfiles.map((profile) => ({
			id: profile.id,
			displayName: profile.display_name,
			kind: profile.kind,
			args: [...profile.args],
			env: { ...profile.env },
		})),
	};
}

function fromWireConfig(wire: SettingsConfigWire): Config {
	return {
		version: wire.version,
		general: { import_login_environment: wire.general.importLoginEnvironment },
		runtimes: {
			shell: wire.runtimes.shell,
			git: wire.runtimes.git,
			tmux: wire.runtimes.tmux,
			herdr: wire.runtimes.herdr,
			tmux_socket_name: wire.runtimes.tmuxSocketName,
			tmux_args: [...wire.runtimes.tmuxArgs],
		},
		appearance: {
			colorScheme: wire.appearance.colorScheme,
			sidebarDensity: wire.appearance.sidebarDensity,
			terminalFontFamily: wire.appearance.terminalFontFamily,
			terminalFontSize: wire.appearance.terminalFontSize,
			terminalLineHeight: wire.appearance.terminalLineHeight,
			terminalMargin: wire.appearance.terminalMargin,
			terminalTheme: wire.appearance.terminalTheme,
		},
		workspaceSources: wire.workspaceSources.map(
			(source): WorkspaceSource =>
				source.type === "filesystem"
					? {
							type: "filesystem",
							id: source.id,
							path: source.path,
							min_depth: source.minDepth,
							max_depth: source.maxDepth ?? undefined,
							kinds: [...source.kinds],
							include_hidden: source.includeHidden,
							exclude_names: [...source.excludeNames],
						}
					: {
							type: "command",
							id: source.id,
							command: [...source.command],
							timeout_ms: source.timeoutMs,
						},
		),
		agentProfiles: wire.agentProfiles.map((profile) => ({
			id: profile.id,
			display_name: profile.displayName,
			kind: profile.kind,
			args: [...profile.args],
			env: { ...profile.env },
		})),
	};
}

async function buildSnapshot(): Promise<SettingsSnapshotWire> {
	const settings = requireHost();
	const loaded = settings.store.current() ?? (await settings.store.load());
	const resolved = await resolveRuntimes(loaded.config.runtimes);
	sequence += 1;
	const diagnostic = settings.store.lastDiagnostic();
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		sequence,
		revision: loaded.revision,
		config: toWireConfig(loaded.config),
		runtime: {
			configured: toWireConfig(loaded.config).runtimes,
			resolved,
			// Nothing in DevHub rewrites a configured runtime, so what is configured
			// is what is used. The column stays because the three are different
			// facts and collapsing them is how a future override becomes invisible.
			effective: toWireConfig(loaded.config).runtimes,
			health: runtimeHealth(resolved),
			restartRequired: false,
		},
		diagnostics: {
			sessionId,
			logDirectory: settings.logDirectory,
			logLevel: "info",
			previousExit: settings.previousExit(),
			health: runtimeHealth(resolved).inspectionAvailable
				? "healthy"
				: "unavailable",
			recentCodes: diagnostic ? [diagnostic.code] : [],
		},
		diagnostic: diagnostic
			? {
					code: diagnostic.code,
					path: diagnostic.path,
					line: diagnostic.location?.line,
					column: diagnostic.location?.column,
				}
			: undefined,
	};
}

function asIpcError(error: SettingsErrorWire): Error {
	// Electron carries only a message across the IPC boundary, so the structured
	// error travels inside it and the page unwraps it back into the same value.
	return new Error(JSON.stringify(error));
}

function settingsError(error: unknown): Error {
	if (error instanceof ConfigError) {
		if (error.code === "conflict") {
			return asIpcError({
				code: "external_edit_conflict",
				currentRevision: error.actualRevision,
			});
		}
		if (error.code === "io") {
			return asIpcError({ code: "invalid_file" });
		}
		return asIpcError({
			code: "invalid_config",
			diagnostic: {
				code: error.diagnostic.code,
				path: error.diagnostic.path,
				line: error.diagnostic.location?.line,
				column: error.diagnostic.location?.column,
			},
		});
	}
	return asIpcError({ code: "native_unavailable" });
}

function registerIpc(): void {
	const handle = electron.ipcMain.handle.bind(electron.ipcMain);

	handle(SETTINGS_CHANNELS.getSnapshot, async () => {
		try {
			return await buildSnapshot();
		} catch (error) {
			throw settingsError(error);
		}
	});

	handle(
		SETTINGS_CHANNELS.save,
		async (_event, request: SettingsSaveRequestWire) => {
			const settings = requireHost();
			try {
				const loaded = await settings.store.save(
					request.revision,
					fromWireConfig(request.config),
				);
				settings.adopt(loaded.config);
				return await buildSnapshot();
			} catch (error) {
				throw settingsError(error);
			}
		},
	);

	handle(SETTINGS_CHANNELS.reload, async () => {
		const settings = requireHost();
		try {
			const outcome = await settings.store.reload();
			if (outcome.kind === "applied") {
				settings.adopt(outcome.loaded.config);
			}
			return await buildSnapshot();
		} catch (error) {
			throw settingsError(error);
		}
	});

	handle(SETTINGS_CHANNELS.recheck, async () => {
		try {
			return await buildSnapshot();
		} catch (error) {
			throw settingsError(error);
		}
	});

	handle(SETTINGS_CHANNELS.openLogFolder, async () => {
		const settings = requireHost();
		const failure = await electron.shell.openPath(settings.logDirectory);
		if (failure.length > 0) {
			throw asIpcError({ code: "permission_denied" });
		}
	});

	handle(SETTINGS_CHANNELS.copyDiagnostics, async () => {
		const settings = requireHost();
		const snapshot = await buildSnapshot();
		// Deliberately not the config: agent profiles carry environment values,
		// and a diagnostics summary is something people paste into issues.
		electron.clipboard.writeText(
			JSON.stringify(
				{
					sessionId: snapshot.diagnostics.sessionId,
					previousExit: snapshot.diagnostics.previousExit,
					runtimeHealth: snapshot.runtime.health,
					configDiagnostic: snapshot.diagnostic?.code,
					logDirectory: settings.logDirectory,
				},
				undefined,
				2,
			),
		);
	});

	handle(SETTINGS_CHANNELS.close, () => {
		window?.close();
	});
}

/** Where the log folder button opens, given the app's user-data directory. */
export function logDirectoryFor(userDataPath: string): string {
	return join(userDataPath, "logs");
}
