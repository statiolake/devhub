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
