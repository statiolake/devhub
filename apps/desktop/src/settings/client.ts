import type {
  SettingsApi,
  SettingsError,
  SettingsSaveRequestWire,
  SettingsSnapshot,
} from "../ipc/settings";

export interface SettingsClient {
  getSnapshot(): Promise<SettingsSnapshot>;
  save(request: SettingsSaveRequestWire): Promise<SettingsSnapshot>;
  reload(): Promise<SettingsSnapshot>;
  recheck(): Promise<SettingsSnapshot>;
  openLogFolder(): Promise<void>;
  copyDiagnostics(): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
}

declare global {
  interface Window {
    readonly devhubSettings?: SettingsApi;
  }
}

export function settingsApi(): SettingsApi {
  const api = window.devhubSettings;
  if (!api) {
    throw new Error(
      "the Settings page was loaded without its preload: window.devhubSettings is missing",
    );
  }
  return api;
}

export function createSettingsClient(
  api: SettingsApi = settingsApi(),
): SettingsClient {
  return {
    getSnapshot: () => api.getSnapshot(),
    save: (request) => api.save(request),
    reload: () => api.reload(),
    recheck: () => api.recheck(),
    openLogFolder: () => api.openLogFolder(),
    copyDiagnostics: () => api.copyDiagnostics(),
    close: () => api.close(),
    subscribe: (listener) => api.onChanged(listener),
  };
}

const NATIVE_UNAVAILABLE: SettingsError = { code: "native_unavailable" };

function isSettingsError(value: unknown): value is SettingsError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<SettingsError>).code === "string"
  );
}

/**
 * Decode the stable error algebra at the transport boundary.
 *
 * Electron wraps a rejection's payload in an `Error` message, so the structured
 * value can arrive either as itself or embedded in the text. Anything that is
 * neither becomes the one sentence the window can act on.
 */
export function parseSettingsTransportError(value: unknown): SettingsError {
  if (isSettingsError(value)) {
    return value;
  }
  if (value instanceof Error) {
    const start = value.message.indexOf("{");
    if (start >= 0) {
      try {
        const decoded: unknown = JSON.parse(value.message.slice(start));
        if (isSettingsError(decoded)) {
          return decoded;
        }
      } catch {
        // Not a structured payload; fall through to the stable sentence.
      }
    }
  }
  return NATIVE_UNAVAILABLE;
}
