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

/**
 * An Agent's control lifecycle, as the model states it.
 *
 * The tag alone used to cross, and `stop-failed` arrived on the page with its
 * reason removed — DevHub knew why the Agent would not stop and the row could
 * only say that it would not. A boundary that drops a variant's payload is the
 * boundary deciding what the model meant, so the union crosses whole and the
 * row renders `closeDiagnosticLabel(diagnostic)`.
 */
export type AgentControlStateWire =
	| { readonly kind: "running" }
	| { readonly kind: "stopping" }
	| {
			readonly kind: "stop-failed";
			readonly diagnostic: CloseDiagnosticWire;
	  };
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

/**
 * Why an operation on one Agent was refused. Mirrors `AgentFailureCode`.
 *
 * Drawn in that Agent's own pane and on its own row, never as an app-wide
 * alert: a failure is shown at its subject. See `AGENT_FAILURE_CODES`.
 */
export type AgentFailureWire =
	| "agent_runtime_unavailable"
	| "tmux_command_failed"
	| "tmux_command_timed_out"
	| "tmux_session_conflict"
	| "agent_profile_unavailable"
	| "workspace_unavailable";

export interface AgentFailureStateWire {
	readonly code: AgentFailureWire;
	/** A sentence about DevHub's own configuration. Never provider output. */
	readonly detail?: string;
}

export interface AgentWire {
	readonly controlState: AgentControlStateWire;
	/**
	 * The refusal this Agent's pane is still showing, or nothing.
	 *
	 * It is retired by the next reconcile that reads this Agent and by nothing
	 * else — no dismiss, no timer. The pane simply stops drawing it when the
	 * condition it describes stops being true.
	 */
	readonly failure?: AgentFailureStateWire;
	readonly displayName: string;
	readonly id: string;
	readonly ordinal: number;
	readonly profileId: string;
	readonly runtimeHealth: RuntimeHealthWire;
	readonly status: AgentStatusWire;
	/**
	 * Why this Agent is owed a look, or nothing if it has been read.
	 *
	 * The status it went into while nobody was watching, so the Sidebar can
	 * draw the mark in that status's own colour. See `wantsAttention`.
	 */
	readonly unread: AgentStatusWire | undefined;
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
	/** A multiplier on wheel and trackpad scrolling. See `AppearanceConfig`. */
	readonly terminalScrollSensitivity: number;
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
	| "git_fetch_failed"
	/**
	 * The workbench's own `User/settings.json` could not be parsed, so DevHub
	 * did not touch it — and the settings it writes there are not in it.
	 *
	 * Its own code because it is the one failure whose consequence is a
	 * *missing* feature rather than a failed action: everything still works
	 * except the things that settings file was carrying, and the reader needs
	 * to be told which ones and where to go and fix it.
	 */
	| "workbench_settings_unreadable"
	/** tmux ran DevHub's command and refused it. */
	| "tmux_command_failed"
	/** tmux did not answer DevHub's command inside its bound. */
	| "tmux_command_timed_out"
	/** The session DevHub needs is not the session that is there. */
	| "tmux_session_conflict";

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
	workbench_settings_unreadable:
		"The editor's settings file is not valid JSON.",
	// Three sentences rather than one, because they are three different things
	// to do next. "The agent runtime is unavailable" was said for all of them,
	// which sent the reader to look at a tmux that was answering perfectly.
	tmux_command_failed: "The terminal runtime refused the request.",
	tmux_command_timed_out: "The terminal runtime did not answer in time.",
	tmux_session_conflict:
		"The terminal session DevHub needs is not the one that is there.",
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
	/** Show the Sidebar as its icon rail, or give it its width back. */
	| { readonly type: "toggle_sidebar" }
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
	/**
	 * Answer the question a close asked before it did anything.
	 *
	 * The page cannot *start* a close. A close has a question about the folder
	 * that only main can ask (`closeWorkspaceOrWorktree`), and every question a
	 * close has is answered before its first destructive step — so main owns
	 * the way in, and the page's half is answering.
	 */
	| {
			readonly confirmationId: string;
			readonly type: "confirm_close_workspace";
	  };
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
 * Workspace cannot be shown, in which case the workspace's own `state` is
 * what says why.
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
	/**
	 * Stopping this Agent. The subject is *in* the purpose, not beside it: a
	 * question that cannot say what it is about is a question that can be
	 * answered about the wrong thing.
	 */
	| { readonly kind: "agent_stop"; readonly agentId: string };
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
	/**
	 * Whether the Sidebar is shown as its icon rail.
	 *
	 * Not "hidden": a Sidebar with nothing in its place would take away the one
	 * thing that says what is open and which Agent wants you, and would leave
	 * the window's traffic lights sitting on a workbench. Collapsed, it keeps
	 * the same rows in the same order reduced to their glyph column, and the
	 * width it keeps is the one the lights need anyway.
	 *
	 * It is beside `width` because it is the same kind of fact — where the
	 * Sidebar's trailing edge is — and the two are restored together.
	 */
	readonly collapsed: boolean;
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
/**
 * A Workspace's availability, as the model states it.
 *
 * The union crosses whole. It used to be a tag with an optional
 * `stateDiagnostic` beside it, which made `{ available, cleanup_failed }` and
 * a `closing-failed` with no reason both writable — invalid states the model
 * had made unrepresentable, representable again one function call later.
 *
 * It says nothing about a close. That is `WorkspaceCloseWire`, beside it,
 * because a folder that has gone missing and a close that stopped are two
 * facts and either used to overwrite the other.
 */
export type WorkspaceStateWire =
	| { readonly kind: "available" }
	| { readonly kind: "unavailable"; readonly reason: CloseDiagnosticWire };

/** The steps a close is made of, in order. Mirrors `CloseStep`. */
export type CloseStepWire =
	| "editor"
	| "agents"
	| "terminal"
	| "view"
	| "worktree"
	| "state";

/**
 * What a Workspace's close has to say, so the row can say it.
 *
 * There is no progress in it, because there is no resumable midpoint: a close
 * is a fixed sequence of idempotent steps, and one that stopped is repeated
 * from the start next time. What a failure leaves behind is which step stopped
 * and why — the sentence a person reads.
 */
export type WorkspaceCloseWire =
	| { readonly kind: "idle" }
	| { readonly kind: "running" }
	| {
			readonly kind: "failed";
			readonly step: CloseStepWire;
			readonly diagnostic: CloseDiagnosticWire;
			/**
			 * What the tool that refused actually said — git's last line, an
			 * errno. The diagnostic names the kind of failure and this names
			 * *this* failure; without it every `git worktree remove` refusal
			 * read "A cleanup step did not finish" and the one sentence that
			 * said what to do about it never left main.
			 */
			readonly detail?: string;
	  };
/**
 * Where a Workspace's folder is, as the page is told it.
 *
 * The page needs the machine for two things and neither is optional: the row
 * says which host it is, and every surface that would have shown a git status,
 * a worktree or an Agent has to say why it is not showing one. See
 * `supportsLocalAgents`.
 */
export type WorkspaceLocationWire =
	| { readonly kind: "local" }
	| { readonly kind: "ssh"; readonly host: string };

export interface WorkspaceWire {
	readonly agents: readonly AgentWire[];
	readonly canCreateAgent: boolean;
	readonly id: string;
	readonly label: string;
	readonly location: WorkspaceLocationWire;
	/** The folder's path, whichever machine it is on. */
	readonly root: string;
	/**
	 * What makes this Workspace this one: the path for a local folder, and the
	 * host and path together for a remote one. Two hosts' `/src/api` are two
	 * rows, and only this tells them apart.
	 */
	readonly key: string;
	readonly selectedPath: string;
	readonly state: WorkspaceStateWire;
	readonly close: WorkspaceCloseWire;
	/**
	 * The Agent last selected in this workspace, if it is still running.
	 *
	 * What `Cmd+Q Cmd+J` comes back to. See `AppModel.lastAgentIn`.
	 */
	readonly lastAgentId?: string;
	/**
	 * Why DevHub's own tooling has nothing to show for this Workspace, or absent
	 * when it has.
	 *
	 * One sentence, sent rather than composed here, so the row's repository area,
	 * the disabled New Agent button and the terminal pane all say the same thing.
	 * A page that wrote its own would be a second answer to one question, and the
	 * two would drift the first time the answer changed.
	 */
	readonly localAgentsUnavailable?: string;
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
