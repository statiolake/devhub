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
  subscribeWorkspacePicker?(
    listener: (event: WorkspacePickerEvent) => void,
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
