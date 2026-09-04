/**
 * The Settings window's contract with the main process.
 *
 * A port of the Tauri app's generated settings contract. The config shape is
 * the same one `config.toml` holds, in the camelCase the page reads; a save
 * carries the revision it was drafted from, so an edit made in a text editor
 * while Settings was open is a refusal rather than a silent overwrite.
 *
 * Changing the tmux socket is the one setting that is not just a value in a
 * file: DevHub's terminal sessions live on that socket, so moving to another
 * one moves them. It therefore has a contract of its own — look at the socket
 * being asked for (`socketPreflight`), then migrate onto it (`socketApply`) —
 * rather than riding along on an ordinary save.
 */

export const SETTINGS_SCHEMA_VERSION = 1 as const;

import type { AgentActionTriggerWire } from "./contract.js";

export type SettingsAgentProfileKindWire =
	| "codex"
	| "claude"
	| "cursor"
	| "custom";

export interface SettingsAgentProfileWire {
	readonly id: string;
	readonly displayName: string;
	readonly kind: SettingsAgentProfileKindWire;
	/** The program to run. `kind` only says whose screen it is. */
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Record<string, string>;
}

export interface SettingsTerminalPaletteWire {
	readonly background: string;
	readonly foreground: string;
	readonly cursor: string;
	readonly cursorText: string;
	readonly selectionBackground: string;
	readonly selectionForeground: string;
	readonly ansi: readonly string[];
}

export interface SettingsTerminalThemeWire {
	readonly light: SettingsTerminalPaletteWire;
	readonly dark: SettingsTerminalPaletteWire;
}

/**
 * There is still no colour scheme here, and `mode` is not one.
 *
 * DevHub's chrome takes its colours from the active VS Code theme, so "what
 * colour is this window" is already answered — by the theme the person chose in
 * the workbench. A DevHub-level palette would be a second answer to the same
 * question, and the two would disagree the first time somebody changed one of
 * them. That is why `appearance.color_scheme` is retired: the loader still
 * accepts the key so an older file keeps loading, but it is read nowhere and
 * dropped from the document on the next save.
 *
 * `mode` answers a different question — *which appearance is this process in*,
 * which is the OS's question and used to be answered by whichever workbench
 * wrote `nativeTheme.themeSource` last (see `main/shell/appFence.ts`). Choosing
 * light or dark here does not paint anything directly: it changes what the OS
 * appearance is reported to be, each workbench with
 * `window.autoDetectColorScheme` picks its theme from that, and DevHub's chrome
 * follows that theme exactly as before. One answer still, and this sits
 * upstream of it rather than beside it.
 */
export interface SettingsAppearanceWire {
	/** `auto`, `light` or `dark` — see `model/config.ts`. */
	readonly mode: string;
	readonly sidebarDensity: string;
	readonly terminalFontFamily: string;
	readonly terminalFontSize: number;
	readonly terminalLineHeight: number;
	/**
	 * Carried verbatim rather than edited everywhere: a save rebuilds the whole
	 * appearance table, so a field the page does not round-trip is a field every
	 * save silently resets.
	 */
	readonly terminalMargin: number;
	readonly terminalTheme: SettingsTerminalThemeWire;
}

export interface SettingsGeneralWire {
	readonly importLoginEnvironment: boolean;
}

export interface SettingsRuntimeConfigWire {
	readonly shell: string;
	readonly git: string;
	readonly tmux: string;
	readonly tmuxSocketName: string;
	readonly tmuxArgs: readonly string[];
}

export type SettingsWorkspaceKindWire =
	| "directory"
	| "git_repository"
	| "git_worktree";

export type SettingsWorkspaceSourceWire =
	| {
			readonly type: "filesystem";
			readonly id: string;
			readonly path: string;
			readonly minDepth: number;
			readonly maxDepth: number | null;
			readonly kinds: readonly SettingsWorkspaceKindWire[];
			readonly includeHidden: boolean;
			readonly excludeNames: readonly string[];
	  }
	| {
			readonly type: "command";
			readonly id: string;
			readonly command: readonly string[];
			readonly timeoutMs: number;
	  }
	| {
			readonly type: "date";
			readonly id: string;
			/** A path with date tokens in it — see `model/dateTemplate.ts`. */
			readonly path: string;
			readonly createIfMissing: boolean;
	  };

/** One action, and the wording it is sent with. */
export interface SettingsAgentActionWire {
	/** What fires it. The tree groups by this, and it is spelled in the file. */
	readonly trigger: AgentActionTriggerWire;
	readonly id: string;
	readonly displayName: string;
	readonly template: string;
	/** Whether the wording is shown for review before it is sent. */
	readonly confirmBeforeSend: boolean;
	/** False is how one DevHub ships is taken away. */
	readonly enabled: boolean;
}

/**
 * The keyboard, as the Settings window reads and writes it.
 *
 * `chords` is the override table exactly as `settings.toml` holds it: a key
 * string to a command id, with the empty string meaning "this key does
 * nothing". Overrides and not the whole table, so the window never has to
 * restate a chord DevHub ships — and a DevHub that adds a command does not find
 * it deleted by a file this window saved before it existed.
 */
export interface SettingsKeybindingsWire {
	readonly prefix: string;
	readonly chords: Readonly<Record<string, string>>;
}

export interface SettingsConfigWire {
	readonly version: number;
	readonly general: SettingsGeneralWire;
	readonly runtimes: SettingsRuntimeConfigWire;
	readonly appearance: SettingsAppearanceWire;
	readonly keybindings: SettingsKeybindingsWire;
	readonly workspaceSources: readonly SettingsWorkspaceSourceWire[];
	readonly agentProfiles: readonly SettingsAgentProfileWire[];
	readonly agentActions: readonly SettingsAgentActionWire[];
}

/**
 * How a configured runtime was looked for. It travels with the failure because
 * "unavailable" on its own is the least useful thing DevHub can say about a
 * missing executable: it names neither the tool nor the search that failed, so
 * a person cannot tell a typo from a PATH that never reached their Homebrew.
 */
export type SettingsRuntimeLookupWire =
	/** A command name, searched for in these absolute PATH directories, in order. */
	| { readonly kind: "path"; readonly directories: readonly string[] }
	/** An absolute or `~` path, which names its own single location. */
	| { readonly kind: "explicit"; readonly path: string };

export interface SettingsUnavailableRuntimeWire {
	readonly kind: "unavailable";
	/** The configured value, verbatim: a command name or a path. */
	readonly configured: string;
	readonly lookup: SettingsRuntimeLookupWire;
}

export type SettingsResolvedRuntimeWire =
	| { readonly kind: "absolute_path"; readonly value: string }
	| { readonly kind: "command_name"; readonly value: string }
	| SettingsUnavailableRuntimeWire;

/** How many search directories one message may name before it summarises. */
export const MAX_SEARCHED_DIRECTORIES = 12;

/**
 * The sentence a missing runtime is always shown as, wherever it is shown.
 *
 * Every caller — the Settings window's Runtimes section, the terminal failure
 * surface, the agent failure surface — renders this exact string, so a person
 * who reads one and then another is not left wondering whether they are two
 * different problems.
 */
export function runtimeUnavailableMessage(
	resolved: SettingsUnavailableRuntimeWire,
): string {
	const name = `'${resolved.configured}'`;
	if (resolved.lookup.kind === "explicit") {
		return `DevHub could not find ${name} at ${resolved.lookup.path}.`;
	}
	const directories = resolved.lookup.directories;
	if (directories.length === 0) {
		return `DevHub could not find ${name} on PATH (PATH is empty).`;
	}
	const shown = directories.slice(0, MAX_SEARCHED_DIRECTORIES);
	const more = directories.length - shown.length;
	const where =
		shown.join(", ") + (more > 0 ? `, and ${String(more)} more` : "");
	return `DevHub could not find ${name} on PATH (looked in: ${where}).`;
}

/**
 * The same failure, with the reason the PATH was short when there is one.
 *
 * A lookup searches the environment DevHub ended up with, and that environment
 * is the user's login one *unless the import failed* — a shell profile slower
 * than the timeout leaves DevHub running on the four directories launchd hands
 * a Finder launch. The lookup then fails for a reason that has nothing to do
 * with the tool being missing, and saying only "could not find 'claude' on
 * PATH" sends the person looking for a tool that is installed.
 *
 * So the two are one sentence. `loginFailure` is required rather than optional
 * because a caller that has the fact and forgets to pass it produces exactly
 * the message this exists to prevent; passing `undefined` is a caller saying
 * the import is not why, which is a claim worth making on purpose.
 */
export function executableMissingMessage(
	resolved: SettingsUnavailableRuntimeWire,
	loginFailure: string | undefined,
): string {
	const lookup = runtimeUnavailableMessage(resolved);
	return loginFailure === undefined ? lookup : `${lookup} ${loginFailure}`;
}

export interface SettingsResolvedRuntimeConfigWire {
	readonly shell: SettingsResolvedRuntimeWire;
	readonly git: SettingsResolvedRuntimeWire;
	readonly tmux: SettingsResolvedRuntimeWire;
}

export type SettingsRuntimeHealthValueWire =
	| "starting"
	| "healthy"
	| "degraded"
	| "unavailable"
	| "failed";

export interface SettingsRuntimeHealthWire {
	readonly shell: SettingsRuntimeHealthValueWire;
	readonly git: SettingsRuntimeHealthValueWire;
	readonly tmux: SettingsRuntimeHealthValueWire;
	readonly inspectionAvailable: boolean;
}

export interface SettingsRuntimeWire {
	readonly configured: SettingsRuntimeConfigWire;
	readonly resolved: SettingsResolvedRuntimeConfigWire;
	readonly effective: SettingsRuntimeConfigWire;
	readonly health: SettingsRuntimeHealthWire;
	readonly restartRequired: boolean;
	/**
	 * What became of the login-shell environment import, in a sentence.
	 *
	 * It lives beside the resolutions rather than beside the checkbox that
	 * controls it because it is the same fact: this is the environment every
	 * lookup above was made in. An import that failed and a PATH that is missing
	 * the user's Homebrew are one story, and reading them apart is how a person
	 * concludes DevHub simply cannot find tmux.
	 */
	readonly loginEnvironment: string;
}

export type SettingsPreviousExitWire = "clean" | "unclean" | "unknown";
export type SettingsLogLevelWire = "info" | "debug";

export interface SettingsDiagnosticsWire {
	readonly sessionId: string;
	readonly logDirectory: string;
	readonly logLevel: SettingsLogLevelWire;
	readonly previousExit: SettingsPreviousExitWire;
	readonly health: SettingsRuntimeHealthValueWire;
	readonly recentCodes: readonly string[];
}

export type SettingsDiagnosticCodeWire =
	| "io"
	| "state_unavailable"
	| "invalid_utf8"
	| "parse"
	| "missing_required_field"
	| "unknown_key"
	| "invalid_type"
	| "unsupported_version"
	| "invalid_string"
	| "invalid_id"
	| "duplicate_identity"
	| "invalid_runtime"
	| "invalid_socket_name"
	| "forbidden_tmux_argument"
	| "invalid_appearance"
	| "invalid_keybinding"
	| "unknown_command"
	| "invalid_font_family"
	| "invalid_workspace_path"
	| "invalid_workspace_depth"
	| "invalid_workspace_kind"
	| "invalid_date_template"
	| "invalid_exclusion"
	| "invalid_command"
	| "invalid_timeout"
	| "invalid_profile"
	| "invalid_profile_kind"
	| "unknown_action"
	| "invalid_environment_key"
	| "conflict"
	| "serialization";

/** The one file DevHub's settings live in, named for the messages about it. */
export const SETTINGS_FILE_NAME = "settings.toml";

export interface SettingsDiagnosticWire {
	readonly code: SettingsDiagnosticCodeWire;
	readonly path?: string;
	readonly line?: number;
	readonly column?: number;
}

export interface SettingsSnapshotWire {
	readonly schemaVersion: number;
	readonly sequence: number;
	readonly revision: string;
	readonly config: SettingsConfigWire;
	readonly runtime: SettingsRuntimeWire;
	readonly diagnostics: SettingsDiagnosticsWire;
	/** The last external read that did not parse, if the file is broken now. */
	readonly diagnostic?: SettingsDiagnosticWire;
}

export interface SettingsSaveRequestWire {
	readonly schemaVersion: number;
	readonly revision: string;
	readonly config: SettingsConfigWire;
}

export type SettingsErrorCodeWire =
	| "invalid_config"
	| "external_edit_conflict"
	| "invalid_file"
	| "runtime_unavailable"
	| "native_unavailable"
	| "permission_denied"
	| "native_busy"
	| "native_timed_out";

export interface SettingsErrorWire {
	readonly code: SettingsErrorCodeWire;
	readonly currentRevision?: string;
	readonly diagnostic?: SettingsDiagnosticWire;
}

export type SettingsSnapshot = SettingsSnapshotWire;
export type SettingsConfig = SettingsConfigWire;
export type SettingsError = SettingsErrorWire;

/** Which part of the configuration a reset acts on. */
export type SettingsScopeKeyWire =
	| "general"
	| "runtimes"
	| "appearance"
	| "keybindings"
	| "workspaceSources"
	| "agentProfiles"
	| "agentActions";

export interface SettingsResetRequestWire {
	readonly schemaVersion: number;
	/** The revision it was drafted from, exactly as a save carries one. */
	readonly revision: string;
	readonly keys: readonly SettingsScopeKeyWire[];
}

/** The surface the preload puts on `window.devhubSettings`. */
/**
 * What the socket DevHub is being asked to move to looks like right now.
 *
 * `target_absent` — no server there; `target_devhub_empty` — a DevHub server
 * with no sessions; `marked_sessions` — DevHub sessions from another run;
 * `wrong_marker` — somebody else's tmux server. The counts are what the person
 * is deciding about, so they travel with the state rather than being fetched
 * again by whoever draws the question.
 */
export interface SettingsSocketPreflightWire {
	readonly requestedSocketName: string;
	readonly state:
		| "not_checked"
		| "target_absent"
		| "target_devhub_empty"
		| "wrong_marker"
		| "marked_sessions";
	readonly ownedSessionCount: number;
	readonly unknownSessionCount: number;
}

export interface SettingsApi {
	getSnapshot(): Promise<SettingsSnapshot>;
	save(request: SettingsSaveRequestWire): Promise<SettingsSnapshot>;
	/**
	 * Put some part of the configuration back to DevHub's defaults.
	 *
	 * The keys name properties of the configuration, and every screen says which
	 * of them it owns. The defaults for those keys are written into
	 * `settings.toml`; everything else the file says is kept.
	 */
	resetScope(request: SettingsResetRequestWire): Promise<SettingsSnapshot>;
	reload(): Promise<SettingsSnapshot>;
	recheck(): Promise<SettingsSnapshot>;
	openLogFolder(): Promise<void>;
	copyDiagnostics(): Promise<void>;
	socketPreflight(socketName: string): Promise<SettingsSocketPreflightWire>;
	socketApply(socketName: string): Promise<SettingsSnapshot>;
	close(): Promise<void>;
	onChanged(listener: (snapshot: SettingsSnapshot) => void): () => void;
}

export const SETTINGS_CHANNELS = {
	getSnapshot: "devhub-settings:get-snapshot",
	save: "devhub-settings:save",
	resetScope: "devhub-settings:reset-scope",
	reload: "devhub-settings:reload",
	recheck: "devhub-settings:recheck",
	openLogFolder: "devhub-settings:open-log-folder",
	copyDiagnostics: "devhub-settings:copy-diagnostics",
	socketPreflight: "devhub-settings:socket-preflight",
	socketApply: "devhub-settings:socket-apply",
	close: "devhub-settings:close",
	changed: "devhub-settings:changed",
} as const;
