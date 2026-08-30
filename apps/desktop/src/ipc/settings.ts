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

export type SettingsAgentProfileKindWire = "codex" | "claude";

export interface SettingsAgentProfileWire {
	readonly id: string;
	readonly displayName: string;
	readonly kind: SettingsAgentProfileKindWire;
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

export interface SettingsAppearanceWire {
	readonly colorScheme: string;
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
	readonly herdr: string;
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
	  };

export interface SettingsConfigWire {
	readonly version: number;
	readonly general: SettingsGeneralWire;
	readonly runtimes: SettingsRuntimeConfigWire;
	readonly appearance: SettingsAppearanceWire;
	readonly workspaceSources: readonly SettingsWorkspaceSourceWire[];
	readonly agentProfiles: readonly SettingsAgentProfileWire[];
}

export type SettingsResolvedRuntimeWire =
	| { readonly kind: "absolute_path"; readonly value: string }
	| { readonly kind: "command_name"; readonly value: string }
	| { readonly kind: "unavailable" };

export interface SettingsResolvedRuntimeConfigWire {
	readonly shell: SettingsResolvedRuntimeWire;
	readonly git: SettingsResolvedRuntimeWire;
	readonly tmux: SettingsResolvedRuntimeWire;
	readonly herdr: SettingsResolvedRuntimeWire;
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
	readonly herdr: SettingsRuntimeHealthValueWire;
	readonly inspectionAvailable: boolean;
}

export interface SettingsRuntimeWire {
	readonly configured: SettingsRuntimeConfigWire;
	readonly resolved: SettingsResolvedRuntimeConfigWire;
	readonly effective: SettingsRuntimeConfigWire;
	readonly health: SettingsRuntimeHealthWire;
	readonly restartRequired: boolean;
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
	| "invalid_font_family"
	| "invalid_workspace_path"
	| "invalid_workspace_depth"
	| "invalid_workspace_kind"
	| "invalid_exclusion"
	| "invalid_command"
	| "invalid_timeout"
	| "invalid_profile"
	| "invalid_profile_kind"
	| "invalid_environment_key"
	| "conflict"
	| "serialization";

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
	reload: "devhub-settings:reload",
	recheck: "devhub-settings:recheck",
	openLogFolder: "devhub-settings:open-log-folder",
	copyDiagnostics: "devhub-settings:copy-diagnostics",
	socketPreflight: "devhub-settings:socket-preflight",
	socketApply: "devhub-settings:socket-apply",
	close: "devhub-settings:close",
	changed: "devhub-settings:changed",
} as const;
