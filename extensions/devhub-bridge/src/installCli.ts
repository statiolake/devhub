/**
 * "DevHub: Install 'devhub' command in PATH".
 *
 * The command a person runs from the workbench's command palette, the way
 * VS Code's own "Shell Command: Install 'code' command in PATH" works. It does
 * not write anything itself: it asks DevHub, over DevHub's control socket, and
 * shows the sentence that comes back. DevHub is the only side that knows which
 * binary and which socket the launcher has to name, and having the extension
 * guess them would be a second answer to a question that already has one.
 *
 * Finding the socket needs no environment variable — an extension host is
 * spawned with an environment VS Code composes, and DevHub's own variables are
 * not in it. What an extension is always told is its global-storage directory,
 * which lives under the running app's user-data directory; the socket lives in
 * that same user-data directory, so one is derivable from the other. That also
 * means a scratch DevHub and a real one are never confused: an extension in a
 * scratch workbench can only reach the scratch socket.
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

export interface ControlAnswer {
  ok: boolean;
  message: string;
}

export function requestInstall(socketPath: string): Promise<ControlAnswer> {
  return new Promise<ControlAnswer>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ kind: "install-cli" })}\n`);
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
      resolve(JSON.parse(line) as ControlAnswer);
    });
  });
}
