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
export const MIN_SPLIT_RATIO = 0.25 as const;
export const MAX_SPLIT_RATIO = 0.85 as const;
export const DEFAULT_SPLIT_RATIO = 0.55 as const;

export type AgentControlStateWire = "running" | "stopping" | "stop-failed";
export type AgentProfileKindWire = "codex" | "claude" | "cursor" | "custom";
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
export type AgentStatusWire =
	| "working"
	| "waiting"
	| "idle"
	| "error"
	/** No detector for this Agent's kind; nobody has read its screen. */
	| "unknown";
export type AgentInjectionWaitWire =
	| "nothing_queued"
	/** Composed, but nobody has agreed to the wording yet. */
	| "awaiting_review"
	| "settling"
	| "agent_busy"
	| "agent_asking"
	| "agent_unreadable";

/** How the last thing DevHub meant to say to an Agent ended. */
export type AgentInjectionResultWire =
	| { readonly kind: "sent" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "failed"; readonly reason: string };

export interface AgentInjectionWire {
	readonly queued: number;
	readonly waitingFor: AgentInjectionWaitWire;
	readonly lastResult: AgentInjectionResultWire | undefined;
}

export interface AgentWire {
	readonly controlState: AgentControlStateWire;
	readonly displayName: string;
	readonly id: string;
	readonly ordinal: number;
	readonly profileId: string;
	readonly runtimeHealth: RuntimeHealthWire;
	readonly status: AgentStatusWire;
	/** The Agent asked for attention and nobody has opened it since. */
	readonly unread: boolean;
	/**
	 * What the Agent says it is doing, in its own words.
	 *
	 * The pane title its program set, read on the reconcile cadence beside its
	 * status. Absent until it has said something — see `main/agent/activity.ts`
	 * for what counts as saying something.
	 */
	readonly activity: string | undefined;
	/**
	 * Text DevHub is holding for this Agent, and why it has not gone yet.
	 *
	 * `queued` is how many instructions are waiting; `waitingFor` is the reason
	 * the first of them has not been typed into the pane — nobody has confirmed
	 * the wording yet, or the Agent is busy, or stopped on a question, or
	 * showing a screen nothing can read. `lastResult` is how the previous one
	 * ended. See `main/agent/injection.ts`.
	 */
	readonly injection: AgentInjectionWire;
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
	/** The Agent runtime is not answering, so no Agent can be started. */
	| "agent_runtime_unavailable"
	/** The Agent Surface asked to attach and got no answer in time. */
	| "agent_attach_timed_out"
	/** A request DevHub accepted never reached an answer. */
	| "operation_timed_out"
	/**
	 * A branch was going to start from the remote's default branch, and the
	 * fetch that makes that current did not work.
	 *
	 * Its own code because it is the one failure here with a second answer: the
	 * copy of `origin` already on disk is usable, and whether to start from
	 * something that may be days old is the person's decision, not DevHub's.
	 */
	| "git_fetch_failed";

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
	unknown_context: "The selected context is no longer available.",
	workspace_unavailable: "The workspace is unavailable.",
	workspace_closing: "The workspace is already closing.",
	workspace_close_failed: "The workspace could not be closed cleanly.",
	operation_pending: "Another operation is still in progress.",
	operation_timed_out: "The requested action did not finish.",
	// It names the file it is about, because "changes" named nothing the
	// reader could go and look at — not which changes, not where they were
	// going, not what stopped them. The detail carries the path and the
	// operating system's own words; this says what kind of thing broke.
	persistence_degraded: "DevHub could not save its state file.",
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
	git_fetch_failed: "The latest changes could not be fetched from the remote.",
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
	| {
			readonly context: ContextWire;
			/**
			 * Show it beside the workbench rather than on its own.
			 *
			 * The same modifier as on `request_create_agent`, and absent means the
			 * same thing: the plain gesture, which fills the content area. Only an
			 * Agent has two answers; on any other context the model records `full`
			 * whatever this says.
			 */
			readonly split?: boolean;
			readonly type: "select_context";
	  }
	| { readonly type: "resize_sidebar"; readonly width: number }
	| { readonly ratio: number; readonly type: "resize_split" }
	| { readonly type: "open_workspace_picker" }
	| {
			readonly profileId: string;
			/**
			 * The person asked for the Agent *beside* its workbench — Command-Return
			 * in the picker, Command-click on a row — rather than on its own.
			 *
			 * Absent means the plain choice, which is the Agent alone. It is carried
			 * on the intent rather than set afterwards because it is part of what
			 * was asked for: "open this" and "open this beside the editor" are one
			 * decision, made once, at the moment the row is taken.
			 */
			readonly split?: boolean;
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
	| { readonly agentId: string; readonly type: "mark_agent_unread" }
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
	readonly editorHost: EditorHostWire;
	/** What the content area holds for the selected context. */
	readonly layout: LayoutWire;
	readonly readiness: AppReadiness;
	readonly revision: number;
	readonly schemaVersion: 1;
	readonly selection: SelectionWire;
	readonly sidebar: SidebarWire;
	/** Where the divider sits when the layout is a split, as a fraction. */
	readonly splitRatio: number;
	readonly workspaces: readonly WorkspaceWire[];
}

/**
 * The content area, for this selection.
 *
 * A workbench alone for a Workspace or for Scratch; that workbench with an
 * Agent's pane beside it when an Agent is selected; nothing at all when the
 * Workspace cannot be shown, in which case the workspace's own `state` and
 * `stateDiagnostic` are what say why.
 */
export type LayoutWire =
	| { readonly kind: "workbench"; readonly editorKey: string }
	/** An Agent on its own, over the whole content area. */
	| { readonly kind: "agent"; readonly agentKey: string }
	| {
			readonly kind: "split";
			readonly editorKey: string;
			readonly agentKey: string;
	  }
	| { readonly kind: "unavailable" };

/** See `SurfacePresentation` in the domain: how much of the area it takes. */
export type SurfacePresentationWire = "full" | "beside";
export type CloseDiagnosticWire =
	| "root_missing"
	| "root_inaccessible"
	| "close_agents_unknown"
	| "close_terminal_unknown"
	| "close_editor_unknown"
	| "close_editor_starting"
	| "close_editor_unresponsive"
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
export type RuntimeHealthWire =
	| "starting"
	| "healthy"
	| "degraded"
	| "unavailable"
	| "failed";
export interface SelectionWire {
	readonly context: ContextWire;
	readonly presentation: SurfacePresentationWire;
}
export interface SidebarWire {
	readonly width: number;
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
	 * The Agent last selected in this workspace, if it is still running.
	 *
	 * What `Cmd+Q Cmd+J` comes back to. See `AppModel.lastAgentIn`.
	 */
	readonly lastAgentId?: string;
	/**
	 * Why the workspace is not available, when it is not.
	 *
	 * The state alone says something went wrong; this says what, which is the
	 * difference between "could not be closed" and "the editor has unsaved
	 * changes".
	 */
	readonly stateDiagnostic?: CloseDiagnosticWire;
}

export type SnapshotReadiness = AppReadiness;
export type NavigationContext = ContextWire;
export type SelectionSnapshot = SelectionWire;
export type SurfaceLayout = LayoutWire;
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
/** Keep pointer updates bounded before they cross the intent seam. */
export function clampSidebarWidth(width: number): number {
	return Math.max(
		MIN_SIDEBAR_WIDTH,
		Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)),
	);
}

/**
 * The same, for the split.
 *
 * Rounded to whole percent: a divider dragged by hand produces a new float on
 * every pointer move, and a ratio that is stored, sent and compared is better
 * off with a hundred values than with a thousand indistinguishable ones.
 */
export function clampSplitRatio(ratio: number): number {
	return Math.max(
		MIN_SPLIT_RATIO,
		Math.min(MAX_SPLIT_RATIO, Math.round(ratio * 100) / 100),
	);
}
