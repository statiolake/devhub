/**
 * The App Shell wire contract: everything main projects and the page draws.
 *
 * These types were generated from Rust (`crates/devhub-app-core/src/shell.rs`)
 * in the Tauri app and shipped as a schema plus a runtime validator, because
 * the two sides were different languages and a payload could disagree with the
 * type it claimed to be. Both sides are TypeScript now and import this file, so
 * the type *is* the check: there is no second language to drift from, and a
 * generated validator with no generator behind it is a copy that rots.
 *
 * The shapes themselves are unchanged — camelCase, `kind`-tagged unions — so a
 * snapshot from either implementation reads the same.
 */

export const APP_SHELL_SCHEMA_VERSION = 1 as const;
export const MAX_SAFE_JS_INTEGER = 9007199254740991 as const;
export const MIN_SIDEBAR_WIDTH = 200 as const;
export const MAX_SIDEBAR_WIDTH = 400 as const;
export const DEFAULT_SIDEBAR_WIDTH = 248 as const;

export type ActivityName = "editor" | "agent" | "terminal";
export interface ActivityWire {
	readonly activity: ActivityName;
	readonly resolution: ResolutionWire;
}
export type AgentControlStateWire = "running" | "stopping" | "stop-failed";
export type AgentProfileKindWire = "codex" | "claude";
export interface AgentProfileWire {
	readonly displayName: string;
	readonly id: string;
	readonly kind: AgentProfileKindWire;
}
export type AgentProfilesAvailabilityWire =
	| "available"
	| "degraded"
	| "unavailable";
export type AgentProfilesDiagnosticWire =
	| "configuration_invalid"
	| "configuration_conflict"
	| "projection_unavailable";
export interface AgentProfilesWire {
	readonly availability: AgentProfilesAvailabilityWire;
	readonly diagnostic?: AgentProfilesDiagnosticWire | null;
	readonly profiles: readonly AgentProfileWire[];
	readonly sequence: number;
}
export type AgentStatusWire = "working" | "waiting" | "idle" | "error";
export interface AgentWire {
	readonly controlState: AgentControlStateWire;
	readonly displayName: string;
	readonly id: string;
	readonly ordinal: number;
	readonly profileId: string;
	readonly runtimeHealth: RuntimeHealthWire;
	readonly status: AgentStatusWire;
	readonly workspaceId: string;
}
/**
 * No colour scheme here: the shell chrome takes its colours from the active
 * VS Code theme, so "light or dark" is already answered by the theme the
 * person chose. This carried a `colorScheme` that was the constant `"light"`
 * however the app was actually painted — a field the page could read, believe
 * and be wrong about.
 */
export interface AppAppearanceWire {
	readonly sequence: number;
	readonly sidebarDensity: AppSidebarDensityWire;
	readonly terminalFontFamily: string;
	readonly terminalFontSize: number;
	readonly terminalLineHeight: number;
	readonly terminalMargin: number;
	readonly terminalTheme: TerminalThemeWire;
}
export type AppErrorActionWire = "retry" | "open_settings";
export type AppErrorCodeWire =
	| "invalid_intent"
	| "activity_disabled"
	| "unknown_context"
	| "workspace_unavailable"
	| "workspace_closing"
	| "workspace_close_failed"
	| "operation_pending"
	| "persistence_degraded"
	| "native_unavailable"
	| "editor_provider_missing"
	| "editor_port_unavailable"
	| "editor_unavailable"
	/** A workbench died unasked and DevHub is building it again. */
	| "editor_restarting"
	/** It kept dying, so DevHub stopped building it again. */
	| "editor_restart_exhausted"
	/** The Agent Surface has no live channel to its Agent. */
	| "agent_not_connected"
	/** The Agent is gone: it ended, or something ended it. */
	| "agent_exited"
	/** Herdr is not answering, so no Agent can be started or watched. */
	| "agent_runtime_unavailable"
	/** The Agent Surface asked to attach and got no answer in time. */
	| "agent_attach_timed_out"
	/** A request DevHub accepted never reached an answer. */
	| "operation_timed_out";

/**
 * The sentence each failure is shown as.
 *
 * It lives with the code rather than with whoever raises one, because the
 * same failure has to read the same way wherever it is drawn — the page's
 * error area, a Surface that failed, a log line. A raising site that writes
 * its own words is how one condition ends up with two names.
 */
export const APP_ERROR_SUMMARY: Readonly<Record<AppErrorCodeWire, string>> = {
	invalid_intent: "The requested action is not available.",
	activity_disabled: "This activity is unavailable in the current context.",
	unknown_context: "The selected context is no longer available.",
	workspace_unavailable: "The workspace is unavailable.",
	workspace_closing: "The workspace is already closing.",
	workspace_close_failed: "The workspace could not be closed cleanly.",
	operation_pending: "Another operation is still in progress.",
	operation_timed_out: "The requested action did not finish.",
	persistence_degraded: "Changes could not be saved.",
	native_unavailable: "The native app shell is unavailable.",
	editor_provider_missing: "Visual Studio Code was not found.",
	editor_port_unavailable: "The editor's port is already in use.",
	editor_unavailable: "The editor could not start.",
	editor_restarting: "The workbench stopped unexpectedly and is restarting.",
	editor_restart_exhausted:
		"The workbench kept stopping and will not be restarted again.",
	agent_not_connected: "The agent surface is not connected.",
	agent_exited: "The agent has exited.",
	agent_runtime_unavailable: "The agent runtime is unavailable.",
	agent_attach_timed_out: "The agent surface did not connect in time.",
};
export type AppErrorModuleWire =
	| "app"
	| "config"
	| "state"
	| "editor"
	| "bridge"
	| "agent"
	| "terminal"
	| "settings"
	| "diagnostics";
export interface AppErrorWire {
	readonly actions: readonly AppErrorActionWire[];
	readonly code: AppErrorCodeWire;
	readonly detail?: string | null;
	readonly module: AppErrorModuleWire;
	readonly runtimeVersion: string;
	readonly summary: string;
	readonly timestampMs: number;
}
export type AppIntentWire =
	| { readonly context: ContextWire; readonly type: "select_context" }
	| { readonly activity: ActivityName; readonly type: "select_activity" }
	| { readonly type: "resize_sidebar"; readonly width: number }
	| { readonly expanded: boolean; readonly type: "set_sidebar_expanded" }
	| { readonly type: "open_workspace_picker" }
	| {
			readonly profileId: string;
			readonly type: "request_create_agent";
			readonly workspaceId: string;
	  }
	| {
			readonly agentId: string;
			readonly displayName: string;
			readonly type: "rename_agent";
	  }
	| { readonly agentId: string; readonly type: "stop_agent" }
	| { readonly confirmationId: string; readonly type: "confirm_stop_agent" }
	| { readonly agentId: string; readonly type: "retry_stop_agent" }
	| { readonly agentId: string; readonly type: "reconcile_agent" }
	| { readonly type: "retry_workspace"; readonly workspaceId: string }
	| {
			readonly path: string;
			readonly type: "locate_workspace";
			readonly workspaceId: string;
	  }
	| { readonly type: "request_close_workspace"; readonly workspaceId: string }
	| {
			readonly confirmationId: string;
			readonly type: "confirm_close_workspace";
	  }
	| { readonly type: "retry_close_workspace"; readonly workspaceId: string };
export type AppOutcomeWire =
	| { readonly kind: "noop"; readonly snapshot: AppSnapshotWire }
	| { readonly kind: "updated"; readonly snapshot: AppSnapshotWire }
	| {
			readonly confirmationId: string;
			readonly kind: "confirmation_required";
			readonly purpose: ConfirmationPurposeWire;
			readonly snapshot: AppSnapshotWire;
	  }
	| {
			readonly kind: "deferred";
			readonly operationId: string;
			readonly snapshot: AppSnapshotWire;
	  }
	| { readonly kind: "detached"; readonly snapshot: AppSnapshotWire }
	| {
			readonly kind: "persistence_degraded";
			readonly snapshot: AppSnapshotWire;
	  };
export type AppReadiness = "starting" | "ready" | "unavailable";
export type AppSidebarDensityWire = "compact" | "comfortable";
export interface AppSnapshotWire {
	readonly activities: readonly ActivityWire[];
	readonly editorHost: EditorHostWire;
	readonly readiness: AppReadiness;
	readonly revision: number;
	readonly schemaVersion: 1;
	readonly selection: SelectionWire;
	readonly sidebar: SidebarWire;
	readonly workspaces: readonly WorkspaceWire[];
}
export type CloseDiagnosticWire =
	| "root_missing"
	| "root_inaccessible"
	| "close_agents_unknown"
	| "close_terminal_unknown"
	| "close_editor_unknown"
	| "close_editor_vetoed"
	| "cleanup_failed"
	| "runtime_unavailable";
export interface CloseInspectionWire {
	readonly agents: CloseResourceWire;
	readonly terminalPanes: CloseResourceWire;
	readonly terminalProcesses: CloseResourceWire;
	readonly terminalWindows: CloseResourceWire;
	readonly unsavedEditors: CloseResourceWire;
	readonly workspaceId: string;
	readonly workspaceLabel: string;
}
export type CloseResourceWire =
	| { readonly kind: "clean" }
	| { readonly count: number; readonly kind: "busy" }
	| { readonly diagnostic: CloseDiagnosticWire; readonly kind: "unknown" };
export type ConfirmationPurposeWire =
	| {
			readonly inspection: CloseInspectionWire;
			readonly kind: "workspace_close";
	  }
	| { readonly kind: "agent_stop" };
export type ContextWire =
	| { readonly kind: "global" }
	| { readonly kind: "workspace"; readonly workspaceId: string }
	| { readonly agentId: string; readonly kind: "agent" };
export type DisabledReasonWire =
	| "global-agent-not-applicable"
	| "workspace-agent-requires-agent-selection"
	| "workspace-unavailable"
	| "workspace-closing"
	| "workspace-closing-failed";
export type EditorHostWire =
	| { readonly status: "starting" }
	| { readonly status: "ready" }
	| {
			readonly detail?: string | null;
			readonly status: "failed";
			readonly summary: string;
	  };
export type ReplayEventKindWire =
	| "snapshot"
	| "noop"
	| "error"
	| "operation_completed";
export interface ReplayEventWire {
	readonly kind: ReplayEventKindWire;
	readonly sequence: number;
}
export interface ReplayWire {
	readonly cursor: number;
	readonly events: readonly ReplayEventWire[];
	readonly historyGap: boolean;
	readonly snapshot: AppSnapshotWire;
}
export type ResolutionWire =
	| { readonly kind: "enabled"; readonly surfaceKey: string }
	| { readonly kind: "disabled"; readonly reason: DisabledReasonWire };
export type RuntimeHealthWire =
	| "starting"
	| "healthy"
	| "degraded"
	| "unavailable"
	| "failed";
export interface SelectionWire {
	readonly activity: ActivityName;
	readonly context: ContextWire;
}
export interface SidebarWire {
	readonly width: number;
	/**
	 * Whether the sidebar is the full pane rather than the icon rail.
	 *
	 * The sidebar is never absent: collapsed, it is a rail of one glyph per
	 * Workspace. This says which of its two forms is on screen.
	 */
	readonly expanded: boolean;
}
export interface TerminalPaletteWire {
	readonly ansi: readonly string[];
	readonly background: string;
	readonly cursor: string;
	readonly cursorText: string;
	readonly foreground: string;
	readonly selectionBackground: string;
	readonly selectionForeground: string;
}
export interface TerminalThemeWire {
	readonly dark: TerminalPaletteWire;
	readonly light: TerminalPaletteWire;
}
export type WorkspaceStateWire =
	| "available"
	| "unavailable"
	| "closing"
	| "closing-failed";
export interface WorkspaceWire {
	readonly agents: readonly AgentWire[];
	readonly canCreateAgent: boolean;
	readonly id: string;
	readonly label: string;
	readonly root: string;
	readonly selectedPath: string;
	readonly state: WorkspaceStateWire;
	/**
	 * Why the workspace is not available, when it is not.
	 *
	 * The state alone says something went wrong; this says what, which is the
	 * difference between "could not be closed" and "the editor has unsaved
	 * changes".
	 */
	readonly stateDiagnostic?: CloseDiagnosticWire;
}

export type Activity = ActivityName;
export const ACTIVITIES: readonly Activity[] = [
	"editor",
	"agent",
	"terminal",
] as const;
export type SnapshotReadiness = AppReadiness;
export type NavigationContext = ContextWire;
export type SelectionSnapshot = SelectionWire;
export type ActivityResolution = ResolutionWire;
export type ActivitySnapshot = ActivityWire;
export type AgentStatus = AgentStatusWire;
export type RuntimeHealth = RuntimeHealthWire;
export type AgentControlState = AgentControlStateWire;
export type WorkspaceState = WorkspaceStateWire;
export type WorkspaceSnapshot = WorkspaceWire;
export type AgentSnapshot = AgentWire;
export type SidebarSnapshot = SidebarWire;
export type AppSnapshot = AppSnapshotWire;
export type AppIntent = AppIntentWire;
export type AppOutcome = AppOutcomeWire;
export type AppError = AppErrorWire;
export type AppErrorCode = AppErrorCodeWire;
export type AppAppearance = AppAppearanceWire;
export type AppEventCursor = ReplayWire;
export type AgentProfile = AgentProfileWire;
export type AgentProfiles = AgentProfilesWire;
export type AppLoadState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly snapshot: AppSnapshot }
	| { readonly status: "error"; readonly error: AppError };

export function contextKey(context: NavigationContext): string {
	switch (context.kind) {
		case "global":
			return "global";
		case "workspace":
			return `workspace:${context.workspaceId}`;
		case "agent":
			return `agent:${context.agentId}`;
	}
}
export function isContextSelected(
	selected: NavigationContext,
	candidate: NavigationContext,
): boolean {
	return contextKey(selected) === contextKey(candidate);
}
export function activityLabel(activity: Activity): string {
	return activity[0].toUpperCase() + activity.slice(1);
}
export function workspaceById(
	snapshot: AppSnapshot,
	workspaceId: string,
): WorkspaceSnapshot | undefined {
	return snapshot.workspaces.find((workspace) => workspace.id === workspaceId);
}
export function workspaceForContext(
	snapshot: AppSnapshot,
	context: NavigationContext,
): WorkspaceSnapshot | undefined {
	if (context.kind === "workspace") {
		return workspaceById(snapshot, context.workspaceId);
	}
	if (context.kind === "agent") {
		return snapshot.workspaces.find((workspace) =>
			workspace.agents.some((agent) => agent.id === context.agentId),
		);
	}
	return undefined;
}
export function activeActivitySnapshot(
	snapshot: AppSnapshot,
): ActivitySnapshot {
	return (
		snapshot.activities.find(
			({ activity }) => activity === snapshot.selection.activity,
		) ?? snapshot.activities[0]
	);
}

/** Keep pointer updates bounded before they cross the intent seam. */
export function clampSidebarWidth(width: number): number {
	return Math.max(
		MIN_SIDEBAR_WIDTH,
		Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)),
	);
}
