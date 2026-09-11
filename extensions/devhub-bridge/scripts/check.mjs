/**
 * The static checks on DevHub's built-in extension.
 *
 * The extension is two things — the workbench defaults in the manifest and the
 * `devhub.installCli` palette command — and this file asserts that both are
 * still there, and that the extension is still narrow. It used to enumerate a
 * websocket transport and a frame grammar as well; those were deleted with the
 * web era, and a check for a thing that no longer exists is a check that has to
 * be deleted with it rather than left as a reason nobody can explain.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const extension = await readFile(resolve(root, "src/extension.ts"), "utf8");
const installCli = await readFile(resolve(root, "src/installCli.ts"), "utf8");

const required = [
  [extension, "install-cli command registration", "devhub.installCli"],
  [installCli, "control socket derivation", "controlSocketFromGlobalStorage"],
  [installCli, "control socket request", "install-cli"],
];
for (const [source, label, needle] of required) {
  if (!source.includes(needle)) throw new Error(`${label} is missing`);
}
if (
  extension.includes("getText(") ||
  extension.includes("TextDocument.getText")
) {
  throw new Error("DevHub's extension appears to read editor content");
}
if (manifest.engines?.vscode !== "^1.109.0") {
  throw new Error("DevHub's extension must target the supported VS Code range");
}
if (manifest.capabilities?.untrustedWorkspaces?.supported !== true) {
  throw new Error("DevHub's extension must support safe untrusted workspaces");
}
const commands = manifest.contributes?.commands ?? [];
if (!commands.some((entry) => entry.command === "devhub.installCli")) {
  throw new Error("public command is missing: devhub.installCli");
}
// The defaults are the half of this extension that needs no code at all, and
// the half a person notices immediately when it goes: a workbench view drawing
// its own title bar, or a fresh profile opening behind a chat sign-in dialog.
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
// Activation has to be narrow now that there is nothing to connect to. `"*"`
// was the transport's, which had to be running before anybody asked for it;
// the command is asked for by name.
const events = manifest.activationEvents ?? [];
if (
  events.length !== 1 ||
  events[0] !== "onCommand:devhub.installCli" ||
  events.includes("*")
) {
  throw new Error(
    "activation must be onCommand:devhub.installCli and nothing wider",
  );
}
if (extension.includes(": any") || extension.includes("vscode.d.ts")) {
  throw new Error("activation must use the pinned VS Code types");
}
console.log("DevHub extension static checks passed");
