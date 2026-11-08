/**
 * The static checks on DevHub's built-in extension.
 *
 * The extension is the workbench defaults in its manifest and nothing else, and
 * this file asserts that they are still there and that nothing has grown back
 * around them. It used to carry `devhub.installCli` as well, the palette
 * command that put `devhub` on the PATH; that is DevHub's own palette command
 * now (`install_cli` in `apps/desktop/src/model/commands.ts`), because a
 * Workspace whose editor is Neovim has no workbench to run it in. Before that
 * it enumerated a websocket transport and a frame grammar, deleted with the web
 * era. A check for a thing that no longer exists is deleted with it rather than
 * left as a reason nobody can explain.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
if (manifest.engines?.vscode !== "^1.109.0") {
  throw new Error("DevHub's extension must target the supported VS Code range");
}
if (manifest.capabilities?.untrustedWorkspaces?.supported !== true) {
  throw new Error("DevHub's extension must support safe untrusted workspaces");
}
// The defaults are the whole of this extension, and the part a person notices
// immediately when it goes: a workbench view drawing its own title bar, or a
// fresh profile opening behind a chat sign-in dialog.
for (const key of [
  "window.title",
  "window.commandCenter",
  "workbench.layoutControl.enabled",
  "workbench.startupEditor",
  "chat.disableAIFeatures",
]) {
  if (!(key in (manifest.contributes?.configurationDefaults ?? {}))) {
    throw new Error(`contributed workbench default is missing: ${key}`);
  }
}
// Contributed defaults are read from the manifest and need no activation, so
// there is no code to run and nothing to activate it for. A command, an
// activation event or an entry point here would be a second home for
// something DevHub does itself.
if (
  "main" in manifest ||
  "activationEvents" in manifest ||
  "commands" in (manifest.contributes ?? {}) ||
  existsSync(resolve(root, "src"))
) {
  throw new Error(
    "DevHub's extension is its manifest's workbench defaults and nothing else",
  );
}
console.log("DevHub extension static checks passed");
