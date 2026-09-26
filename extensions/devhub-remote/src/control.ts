/**
 * DevHub's control socket, as this extension reaches it.
 *
 * Finding the socket needs no environment variable — an extension host is
 * spawned with an environment VS Code composes, and DevHub's own variables are
 * not in it. What an extension is always told is its global-storage directory,
 * which lives under the running app's user-data directory; the socket lives in
 * that same user-data directory, so one is derivable from the other. That also
 * means a scratch DevHub and a real one are never confused.
 *
 * This extension is `ui`-kind, so it runs on the same machine as DevHub and
 * the derivation holds: the socket it finds belongs to the DevHub whose window
 * is asking for the remote.
 *
 * The derivation and the framing are shared by copy with
 * `extensions/devhub-bridge/src/installCli.ts`; both mirror
 * `apps/desktop/src/main/cli/protocol.ts`, which is the source of truth.
 */

import { connect } from "node:net";
import { join } from "node:path";

/** Mirrors `controlSocketPath` / `userDataPathFromGlobalStorage` in
 * `apps/desktop/src/main/cli/protocol.ts`, which is the source of truth. */
export function controlSocketFromGlobalStorage(
  globalStoragePath: string,
): string | null {
  const marker = "/User/";
  const index = globalStoragePath.lastIndexOf(marker);
  if (index <= 0) return null;
  return join(globalStoragePath.slice(0, index), "devhub", "control.sock");
}

/** The endpoint of a remote extension host DevHub has published. */
export interface RemoteEndpoint {
  port: number;
  connectionToken: string;
  extensionHostEnv?: Record<string, string | null>;
}

/**
 * DevHub's answer to `resolve-remote`.
 *
 * It arrives on the same `ControlResponse` the other control requests answer
 * with, so `ok` and `message` are always there; `remote` is there only when
 * `ok`, and `retry` only when not — `true` meaning the failure is transient and
 * worth another attempt.
 */
export interface ResolveRemoteAnswer {
  ok: boolean;
  message: string;
  remote?: RemoteEndpoint;
  retry?: boolean;
}

/**
 * One line of JSON out, one line of JSON back, then the connection closes —
 * the same framing `requestInstall` uses. Nothing is caught: a socket that is
 * not there, or an answer that is not a line of JSON, rejects, and the caller
 * decides what VS Code is told about it.
 */
export function requestResolveRemote(
  socketPath: string,
  machine: string,
  attempt: number,
): Promise<ResolveRemoteAnswer> {
  return new Promise<ResolveRemoteAnswer>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ kind: "resolve-remote", machine, attempt })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const line = buffer.split("\n")[0] ?? "";
      if (line.length === 0) {
        reject(new Error("DevHub closed the connection without answering."));
        return;
      }
      resolve(JSON.parse(line) as ResolveRemoteAnswer);
    });
  });
}

/** A window's folder URI, as DevHub reads it (`WindowFolderWire`). */
export interface WindowFolder {
  scheme: string;
  authority: string;
  path: string;
  fsPath: string;
}

/** One of the window's Workspace's dev container definitions. */
export interface DevContainerConfig {
  path: string;
  label?: string;
}

/** DevHub's answer to `dev-container-configs`. */
export interface DevContainerConfigsAnswer {
  ok: boolean;
  message: string;
  devContainers?: { configs: DevContainerConfig[]; current?: string };
}

/** Where the window's editor is to go: its own machine, or a definition. */
export type ReattachTarget = { kind: "host" } | { configPath: string };

/**
 * One request, one line of JSON back — the framing every request on the
 * socket uses. Nothing is caught: see `requestResolveRemote`.
 */
function request<T>(socketPath: string, payload: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const line = buffer.split("\n")[0] ?? "";
      if (line.length === 0) {
        reject(new Error("DevHub closed the connection without answering."));
        return;
      }
      resolve(JSON.parse(line) as T);
    });
  });
}

/** Which definitions the window's Workspace has, and which one it is in. */
export function requestDevContainerConfigs(
  socketPath: string,
  window: WindowFolder,
): Promise<DevContainerConfigsAnswer> {
  return request(socketPath, { kind: "dev-container-configs", window });
}

/**
 * Move the window's editor. DevHub closes this very window on the way, so
 * the answer may never arrive; a refusal does, as a sentence.
 */
export function requestReattachEditor(
  socketPath: string,
  window: WindowFolder,
  to: ReattachTarget,
): Promise<{ ok: boolean; message: string }> {
  return request(socketPath, { kind: "reattach-editor", window, to });
}
