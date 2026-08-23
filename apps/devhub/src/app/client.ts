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
  type AppError,
  type AppAppearance,
  type AppEventCursor,
  type AppIntent,
  type AppOutcome,
  type AppSnapshot,
} from "../generated/app-shell";

export const GET_APP_SNAPSHOT_COMMAND = "get_app_snapshot" as const;
export const GET_APP_APPEARANCE_COMMAND = "get_app_appearance" as const;
export const DISPATCH_APP_INTENT_COMMAND = "dispatch_app_intent" as const;
export const REPLAY_APP_EVENTS_COMMAND = "replay_app_events" as const;
export const APP_SNAPSHOT_CHANGED_EVENT = "app://snapshot-changed" as const;
export const APP_APPEARANCE_CHANGED_EVENT = "app://appearance-changed" as const;

export type AppSnapshotListener = (snapshot: AppSnapshot) => void;
export type AppAppearanceListener = (appearance: AppAppearance) => void;

export interface AppShellClient {
  getSnapshot(): Promise<AppSnapshot>;
  getAppearance?(): Promise<AppAppearance>;
  dispatch(intent: AppIntent): Promise<AppOutcome>;
  subscribe(listener: AppSnapshotListener): Promise<UnlistenFn>;
  subscribeAppearance?(listener: AppAppearanceListener): Promise<UnlistenFn>;
  replay?(cursor: number): Promise<AppEventCursor>;
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
    async replay(cursor) {
      const value = await transport.invoke<unknown>(REPLAY_APP_EVENTS_COMMAND, {
        cursor,
      });
      return parseAppEventCursor(value);
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
