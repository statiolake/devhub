import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  APP_SHELL_SCHEMA_VERSION,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  parseAppError,
  parseAppAppearance,
  parseAppEventCursor,
  parseAppIntent,
  parseAppOutcome,
  parseAppSnapshot,
  parseAgentProfiles,
  parseWorkspacePickerEvent as parseGeneratedWorkspacePickerEvent,
  type AppError,
  type AppAppearance,
  type AppEventCursor,
  type AppIntent,
  type AppOutcome,
  type AppSnapshot,
  type AgentProfiles,
  type WorkspacePickerEventWire,
} from "../generated/app-shell";

export const GET_APP_SNAPSHOT_COMMAND = "get_app_snapshot" as const;
export const GET_APP_APPEARANCE_COMMAND = "get_app_appearance" as const;
export const GET_AGENT_PROFILES_COMMAND = "get_agent_profiles" as const;
export const DISPATCH_APP_INTENT_COMMAND = "dispatch_app_intent" as const;
export const REPLAY_APP_EVENTS_COMMAND = "replay_app_events" as const;
export const APP_SNAPSHOT_CHANGED_EVENT = "app://snapshot-changed" as const;
export const APP_APPEARANCE_CHANGED_EVENT = "app://appearance-changed" as const;
export const APP_AGENT_PROFILES_CHANGED_EVENT =
  "app://agent-profiles-changed" as const;
export const START_WORKSPACE_PICKER_COMMAND = "start_workspace_picker" as const;
export const CANCEL_WORKSPACE_PICKER_COMMAND =
  "cancel_workspace_picker" as const;
export const SELECT_WORKSPACE_PICKER_COMMAND =
  "select_workspace_picker" as const;
export const CHOOSE_WORKSPACE_FOLDER_COMMAND =
  "choose_workspace_folder" as const;
export const APP_WORKSPACE_PICKER_EVENT = "app://workspace-picker" as const;
export const APP_NATIVE_ERROR_EVENT = "app://native-error" as const;
export const OPEN_SETTINGS_WINDOW_COMMAND = "open_settings_window" as const;
export const RECORD_PERFORMANCE_MARKER_COMMAND =
  "record_performance_marker" as const;
export const SET_EDITOR_LAYOUT_COMMAND = "set_editor_layout" as const;
export const ENSURE_EDITOR_REMOTE_COMMAND = "ensure_editor_remote" as const;

/**
 * How the Workbench reaches the Editor's server.
 *
 * The Workbench runs inside the App Shell's own document, so this is the whole
 * seam: an authority to open a socket to, the token that authenticates it, and
 * the VS Code release identity the two sides have to agree on.
 */
export interface EditorRemote {
  readonly authority: string;
  readonly connectionToken: string;
  readonly commit: string;
}

/** Logical App Shell coordinates occupied by the active native Editor child. */
export interface EditorLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type AppPerformanceMarker =
  | "app_shell_interactive"
  | "activity_interactive"
  | "scratch_interactive"
  | "picker_first_result"
  | "dock_reopen_received"
  | "dock_reopen_succeeded"
  | "dock_reopen_failed"
  | "terminal_attach_invoke_rejected"
  | "terminal_resize_invoke_entered"
  | "terminal_resize_invoke_rejected"
  | "terminal_input_invoke_entered"
  | "terminal_input_invoke_rejected"
  | "terminal_output_rendered"
  | "terminal_output_after_input_rendered"
  | "terminal_channel_callback_received"
  | "terminal_started_frame_validated"
  | "terminal_frame_decode_or_identity_failed"
  | "terminal_handshake_timeout_before_receipt"
  | "terminal_handshake_timeout_after_receipt"
  | "terminal_receipt_before_started";

export type TerminalChannelDiagnostic = Extract<
  AppPerformanceMarker,
  | "terminal_channel_callback_received"
  | "terminal_started_frame_validated"
  | "terminal_frame_decode_or_identity_failed"
  | "terminal_handshake_timeout_before_receipt"
  | "terminal_handshake_timeout_after_receipt"
  | "terminal_receipt_before_started"
>;

export interface WorkspacePickerCandidate {
  readonly operationId: string;
  readonly sequence: number;
  readonly label: string;
  readonly searchText: string;
  readonly path: string;
  readonly score: number;
}

export type WorkspacePickerEvent = WorkspacePickerEventWire;

export function parseWorkspacePickerEvent(
  value: unknown,
): WorkspacePickerEvent {
  return parseGeneratedWorkspacePickerEvent(value);
}

export type AppSnapshotListener = (snapshot: AppSnapshot) => void;
export type AppAppearanceListener = (appearance: AppAppearance) => void;
export type AgentProfilesListener = (profiles: AgentProfiles) => void;

export interface AppShellClient {
  getSnapshot(): Promise<AppSnapshot>;
  getAppearance?(): Promise<AppAppearance>;
  getAgentProfiles?(): Promise<AgentProfiles>;
  dispatch(intent: AppIntent): Promise<AppOutcome>;
  subscribe(listener: AppSnapshotListener): Promise<UnlistenFn>;
  subscribeAppearance?(listener: AppAppearanceListener): Promise<UnlistenFn>;
  subscribeAgentProfiles?(listener: AgentProfilesListener): Promise<UnlistenFn>;
  replay?(cursor: number): Promise<AppEventCursor>;
  startWorkspacePicker?(query?: string): Promise<string>;
  cancelWorkspacePicker?(): Promise<void>;
  selectWorkspacePicker?(path: string): Promise<AppOutcome>;
  chooseWorkspaceFolder?(): Promise<string | undefined>;
  openSettings?(): Promise<void>;
  setEditorLayout?(layout: EditorLayout): Promise<void>;
  ensureEditorRemote?(): Promise<EditorRemote>;
  recordPerformanceMarker?(marker: AppPerformanceMarker): Promise<void>;
  subscribeWorkspacePicker?(
    listener: (event: WorkspacePickerEvent) => void,
  ): Promise<UnlistenFn>;
  /** Native failures that happen between pulls, such as a startup mount. */
  subscribeNativeError?(
    listener: (error: AppError) => void,
  ): Promise<UnlistenFn>;
}

export interface AppShellTransport {
  invoke<T>(command: string, payload?: unknown): Promise<T>;
  listen<T>(
    event: string,
    listener: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

const tauriTransport: AppShellTransport = {
  invoke: <T>(command: string, payload?: unknown) =>
    invoke<T>(command, payload === undefined ? undefined : { payload }),
  listen: <T>(event: string, listener: (event: { payload: T }) => void) =>
    listen<T>(event, listener),
};

export function createTauriAppShellClient(
  transport: AppShellTransport = tauriTransport,
): AppShellClient {
  return {
    async getSnapshot() {
      return parseAppSnapshot(
        await transport.invoke<unknown>(GET_APP_SNAPSHOT_COMMAND),
      );
    },
    async getAppearance() {
      return parseAppAppearance(
        await transport.invoke<unknown>(GET_APP_APPEARANCE_COMMAND),
      );
    },
    async getAgentProfiles() {
      return parseAgentProfiles(
        await transport.invoke<unknown>(GET_AGENT_PROFILES_COMMAND),
      );
    },
    async dispatch(intent) {
      const wireIntent = parseAppIntent(intent);
      return parseAppOutcome(
        await transport.invoke<unknown>(
          DISPATCH_APP_INTENT_COMMAND,
          wireIntent,
        ),
      );
    },
    subscribe(listener) {
      return transport.listen<unknown>(APP_SNAPSHOT_CHANGED_EVENT, (event) =>
        listener(parseAppSnapshot(event.payload)),
      );
    },
    subscribeNativeError(listener) {
      return transport.listen<unknown>(APP_NATIVE_ERROR_EVENT, (event) =>
        listener(parseAppError(event.payload)),
      );
    },
    subscribeAppearance(listener) {
      return transport.listen<unknown>(APP_APPEARANCE_CHANGED_EVENT, (event) =>
        listener(parseAppAppearance(event.payload)),
      );
    },
    subscribeAgentProfiles(listener) {
      return transport.listen<unknown>(
        APP_AGENT_PROFILES_CHANGED_EVENT,
        (event) => listener(parseAgentProfiles(event.payload)),
      );
    },
    async replay(cursor) {
      const value = await transport.invoke<unknown>(REPLAY_APP_EVENTS_COMMAND, {
        cursor,
      });
      return parseAppEventCursor(value);
    },
    startWorkspacePicker(query = "") {
      return transport.invoke<string>(START_WORKSPACE_PICKER_COMMAND, {
        query,
      });
    },
    cancelWorkspacePicker() {
      return transport.invoke<void>(CANCEL_WORKSPACE_PICKER_COMMAND);
    },
    async selectWorkspacePicker(path) {
      return parseAppOutcome(
        await transport.invoke<unknown>(SELECT_WORKSPACE_PICKER_COMMAND, {
          path,
        }),
      );
    },
    async chooseWorkspaceFolder() {
      return transport.invoke<string | undefined>(
        CHOOSE_WORKSPACE_FOLDER_COMMAND,
      );
    },
    openSettings() {
      return transport.invoke<void>(OPEN_SETTINGS_WINDOW_COMMAND);
    },
    setEditorLayout(layout) {
      return transport.invoke<void>(SET_EDITOR_LAYOUT_COMMAND, layout);
    },
    ensureEditorRemote() {
      return transport.invoke<EditorRemote>(ENSURE_EDITOR_REMOTE_COMMAND);
    },
    recordPerformanceMarker(marker) {
      return transport.invoke<void>(RECORD_PERFORMANCE_MARKER_COMMAND, {
        marker,
      });
    },
    subscribeWorkspacePicker(listener) {
      return transport.listen<WorkspacePickerEvent>(
        APP_WORKSPACE_PICKER_EVENT,
        (event) => listener(parseWorkspacePickerEvent(event.payload)),
      );
    },
  };
}

/** Decode the stable native error algebra at the transport boundary. */
export function parseTransportError(value: unknown): AppError {
  try {
    return parseAppError(value);
  } catch {
    return {
      code: "native_unavailable",
      summary: "The native app shell is unavailable.",
      module: "app",
      timestampMs: 0,
      runtimeVersion: "unknown",
      actions: ["retry", "open_settings"],
    };
  }
}

/** Keep pointer updates bounded before they cross the native intent seam. */
export function clampSidebarWidth(width: number): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)),
  );
}

export { APP_SHELL_SCHEMA_VERSION };
