import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * How the Copilot language server is started: the JavaScript distribution
 * scripts/build.mjs stages into `server/`, run by the extension host's own
 * runtime.
 *
 * Not the per-platform executables `@github/copilot-language-server` ships as
 * optional dependencies. Each is ~100 MB, one per architecture, and DevHub
 * already carries a Node it can run the same server with: the Electron the
 * extension host is, in its Node mode. VS Code's own TypeScript server is
 * started the same way.
 */
export interface LanguageServerLaunch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Where the staged server's entry point is, inside the extension. */
export function languageServerEntry(extensionPath: string): string {
  return join(extensionPath, "server", "language-server.js");
}

/**
 * The server's own entry point refuses a Node older than 22.13 and then tries
 * the platform executable, which is not staged; say so here instead.
 */
export const MINIMUM_NODE: readonly [number, number] = [22, 13];

export function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return (
    major > MINIMUM_NODE[0] ||
    (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1])
  );
}

export function resolveLanguageServerLaunch(
  extensionPath: string,
  runtime: {
    execPath: string;
    versions: NodeJS.ProcessVersions;
    env: NodeJS.ProcessEnv;
  } = process,
): LanguageServerLaunch {
  const entry = languageServerEntry(extensionPath);
  if (!existsSync(entry)) {
    throw new Error(
      `The Copilot language server is not staged at ${entry}. Build the extension with 'pnpm --filter devhub-copilot build'.`,
    );
  }
  if (!isSupportedNode(runtime.versions.node)) {
    throw new Error(
      `The Copilot language server needs Node ${MINIMUM_NODE.join(".")} or newer; this extension host runs ${runtime.versions.node}.`,
    );
  }
  return {
    command: runtime.execPath,
    args: [entry, "--stdio"],
    // The extension host is Electron; this is what makes it a plain Node.
    env:
      runtime.versions.electron === undefined
        ? undefined
        : { ...runtime.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function launchLanguageServer(
  launch: LanguageServerLaunch,
  cwd?: string,
): ChildProcessWithoutNullStreams {
  return spawn(launch.command, launch.args, {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: launch.env,
    windowsHide: true,
  });
}
