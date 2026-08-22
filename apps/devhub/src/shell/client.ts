import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { SHELL_SCHEMA_VERSION, type ShellSnapshot } from "./model";

export const GET_SHELL_SNAPSHOT_COMMAND = "get_shell_snapshot" as const;
export const MARK_SHELL_READY_COMMAND = "mark_shell_ready" as const;
export const SHELL_SNAPSHOT_CHANGED_EVENT = "shell://snapshot-changed" as const;

export type ShellSnapshotListener = (snapshot: ShellSnapshot) => void;

/** The narrow native port consumed by the React shell. */
export interface ShellClient {
  getSnapshot(): Promise<ShellSnapshot>;
  markReady(): Promise<ShellSnapshot>;
  subscribe(listener: ShellSnapshotListener): Promise<UnlistenFn>;
}

export interface ShellTransport {
  invoke<T>(command: string): Promise<T>;
  listen<T>(
    event: string,
    listener: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

const tauriTransport: ShellTransport = {
  invoke: <T>(command: string) => invoke<T>(command),
  listen: <T>(event: string, listener: (event: { payload: T }) => void) =>
    listen<T>(event, listener),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Validate and freeze at the seam. The view never sees untrusted JSON and
 * cannot mutate Rust-owned state accidentally.
 */
export function parseShellSnapshot(value: unknown): ShellSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SHELL_SCHEMA_VERSION ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.productName !== "string" ||
    value.productName.length === 0 ||
    typeof value.platform !== "string" ||
    value.platform.length === 0 ||
    typeof value.windowLabel !== "string" ||
    value.windowLabel.length === 0 ||
    (value.readiness !== "starting" && value.readiness !== "ready")
  ) {
    throw new Error("The native shell returned an invalid snapshot.");
  }

  return Object.freeze({
    schemaVersion: SHELL_SCHEMA_VERSION,
    revision: value.revision,
    productName: value.productName,
    platform: value.platform,
    windowLabel: value.windowLabel,
    readiness: value.readiness,
  });
}

export function createTauriShellClient(
  transport: ShellTransport = tauriTransport,
): ShellClient {
  return {
    async getSnapshot() {
      return parseShellSnapshot(
        await transport.invoke<unknown>(GET_SHELL_SNAPSHOT_COMMAND),
      );
    },
    async markReady() {
      return parseShellSnapshot(
        await transport.invoke<unknown>(MARK_SHELL_READY_COMMAND),
      );
    },
    subscribe(listener) {
      return transport.listen<unknown>(
        SHELL_SNAPSHOT_CHANGED_EVENT,
        (event) => {
          listener(parseShellSnapshot(event.payload));
        },
      );
    },
  };
}
