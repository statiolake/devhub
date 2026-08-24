import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  SETTINGS_SCHEMA_VERSION,
  parseSettingsError,
  parseSettingsSnapshot,
  type SettingsCommandRequestWire,
  type SettingsError,
  type SettingsSaveRequestWire,
  type SettingsSnapshot,
  type SettingsSocketChangeRequestWire,
} from "../generated/settings";

export const SETTINGS_CHANGED_EVENT = "settings://changed" as const;
export const SETTINGS_COMMANDS = {
  getSnapshot: "get_settings_snapshot",
  save: "save_settings",
  reload: "reload_settings",
  recheck: "recheck_settings",
  openLogFolder: "open_log_folder",
  copyDiagnostics: "copy_diagnostics",
  applySocketChange: "apply_socket_change",
} as const;

export interface SettingsTransport {
  invoke<T>(command: string, payload?: unknown): Promise<T>;
  listen<T>(
    event: string,
    listener: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

const tauriTransport: SettingsTransport = {
  invoke: <T>(command: string, payload?: unknown) =>
    invoke<T>(command, payload === undefined ? undefined : { payload }),
  listen: <T>(event: string, listener: (event: { payload: T }) => void) =>
    listen<T>(event, listener),
};

export interface SettingsClient {
  getSnapshot(): Promise<SettingsSnapshot>;
  save(request: SettingsSaveRequestWire): Promise<SettingsSnapshot>;
  reload(): Promise<SettingsSnapshot>;
  recheck(): Promise<SettingsSnapshot>;
  openLogFolder(): Promise<void>;
  copyDiagnostics(): Promise<void>;
  applySocketChange(
    request: SettingsSocketChangeRequestWire,
  ): Promise<SettingsSnapshot>;
  subscribe(
    listener: (snapshot: SettingsSnapshot) => void,
  ): Promise<UnlistenFn>;
}

const commandRequest = (): SettingsCommandRequestWire => ({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
});

export function createTauriSettingsClient(
  transport: SettingsTransport = tauriTransport,
): SettingsClient {
  return {
    async getSnapshot() {
      return parseSettingsSnapshot(
        await transport.invoke<unknown>(SETTINGS_COMMANDS.getSnapshot),
      );
    },
    async save(request) {
      return parseSettingsSnapshot(
        await transport.invoke<unknown>(SETTINGS_COMMANDS.save, request),
      );
    },
    async reload() {
      return parseSettingsSnapshot(
        await transport.invoke<unknown>(
          SETTINGS_COMMANDS.reload,
          commandRequest(),
        ),
      );
    },
    async recheck() {
      return parseSettingsSnapshot(
        await transport.invoke<unknown>(
          SETTINGS_COMMANDS.recheck,
          commandRequest(),
        ),
      );
    },
    async openLogFolder() {
      await transport.invoke<unknown>(
        SETTINGS_COMMANDS.openLogFolder,
        commandRequest(),
      );
    },
    async copyDiagnostics() {
      await transport.invoke<unknown>(
        SETTINGS_COMMANDS.copyDiagnostics,
        commandRequest(),
      );
    },
    async applySocketChange(request) {
      return parseSettingsSnapshot(
        await transport.invoke<unknown>(
          SETTINGS_COMMANDS.applySocketChange,
          request,
        ),
      );
    },
    subscribe(listener) {
      return transport.listen<unknown>(SETTINGS_CHANGED_EVENT, (event) =>
        listener(parseSettingsSnapshot(event.payload)),
      );
    },
  };
}

export function parseSettingsTransportError(value: unknown): SettingsError {
  try {
    return parseSettingsError(value);
  } catch {
    return { code: "native_unavailable" };
  }
}
