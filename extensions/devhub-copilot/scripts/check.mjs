/**
 * The static checks on DevHub's Copilot extension.
 *
 * The extension exists to get Copilot's suggestions drawn by the editor's own
 * inline suggestion UI, and the checks below are the conditions that come down
 * to. They are cheap to break without noticing, because breaking any of them
 * does not fail: the editor quietly falls back to ghost text, or to nothing.
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const read = (path) => readFile(resolve(root, path), "utf8");
const extension = await read("src/extension.ts");
const nextEdits = await read("src/nextEditProvider.ts");
const completions = await read("src/completionProvider.ts");
const sources = `${extension}${nextEdits}${completions}`;

// An inline edit is an item with `isInlineEdit`. Without it the editor treats
// a next edit as ghost text and drops it unless it continues at the cursor.
for (const needle of ["isInlineEdit = true", "showInlineEditMenu = true"]) {
  if (!nextEdits.includes(needle)) {
    throw new Error(`the next edit items must set ${needle}`);
  }
}
const client = await read("src/copilotClient.ts");
for (const [label, needle] of [
  ["the completion request", '"textDocument/inlineCompletion"'],
  ["the next edit request", '"textDocument/copilotInlineEdit"'],
]) {
  if (!client.includes(needle)) throw new Error(`${label} is missing`);
}
// The editor draws them. A decoration or a keybinding of the extension's own
// is a second UI competing with the editor's for the same Tab.
for (const [label, needle] of [
  ["text editor decorations", "createTextEditorDecorationType"],
  ["its own context keys", "setContext"],
  ["edits applied by hand", "applyEdit"],
]) {
  if (sources.includes(needle)) {
    throw new Error(`the editor draws the suggestions; no ${label}: ${needle}`);
  }
}
if (manifest.contributes?.keybindings !== undefined) {
  throw new Error("Tab and Escape belong to the editor's inline suggestions");
}
if (
  manifest.extensionKind?.length !== 1 ||
  manifest.extensionKind[0] !== "ui"
) {
  // The server is staged in the app, not in the remote server DevHub
  // installs; run anywhere else, it would not be there.
  throw new Error("the extension runs beside its server: extensionKind ui");
}
if (manifest.engines?.vscode !== "^1.109.0") {
  throw new Error("DevHub's extension must target the supported VS Code range");
}
if (manifest.capabilities?.untrustedWorkspaces?.supported !== true) {
  throw new Error("DevHub's extension must support untrusted workspaces");
}
if (manifest.api !== "none") {
  throw new Error("the extension exports no API of its own");
}
if (
  (manifest.activationEvents ?? []).join(",") !== "onStartupFinished" ||
  JSON.stringify(manifest.contributes?.configuration ?? {}).includes(
    "github.copilot.",
  )
) {
  throw new Error(
    "activation is onStartupFinished, and the settings are devhub.copilot.*, never the official extension's",
  );
}
if (
  !/^\d+\.\d+\.\d+$/u.test(
    manifest.dependencies?.["@github/copilot-language-server"] ?? "",
  )
) {
  throw new Error("the language server is pinned to an exact version");
}
if (sources.includes(": any")) {
  throw new Error("the extension must use the pinned VS Code types");
}

/**
 * The grant product.json has to carry, checked against product.json.
 *
 * VS Code composes the identity `<publisher>.<name>` and looks it up in
 * `extensionEnabledApiProposals` (`extensionsProposedApi.ts`); a listed
 * extension gets exactly the listed proposals. Without the grant the extension
 * host drops `isInlineEdit` without a word and every next edit is lost.
 */
const identity = `${manifest.publisher}.${manifest.name}`;
const metadata = await readFile(
  new URL("../../../scripts/product_metadata.py", import.meta.url),
  "utf8",
);
const granted = new RegExp(
  `"${identity.replace(/[.]/gu, "\\.")}"\\s*:\\s*\\[([^\\]]*)\\]`,
  "u",
).exec(metadata);
if (granted === null) {
  throw new Error(
    `scripts/product_metadata.py grants no API proposals to ${identity}`,
  );
}
if (!manifest.enabledApiProposals?.includes("inlineCompletionsAdditions")) {
  throw new Error("the inlineCompletionsAdditions proposal must be enabled");
}
for (const proposal of manifest.enabledApiProposals ?? []) {
  if (!granted[1].includes(`"${proposal}"`)) {
    throw new Error(
      `${identity} asks for '${proposal}' and scripts/product_metadata.py does not grant it`,
    );
  }
}

/**
 * The status item's dashboard is `StatusBarItem.hover`, DevHub's own proposal.
 * Its declaration is added to VS Code by a patch, so the submodule has it only
 * once the patches are applied; the extension type-checks against a copy in
 * typings/, which has to be the patch's file byte for byte. The patch is found
 * by what it adds, not by its file name, so renumbering patches/vscode/ does
 * not break this check.
 */
if (!manifest.enabledApiProposals?.includes("devhubStatusBarHover")) {
  throw new Error("the devhubStatusBarHover proposal must be enabled");
}
const proposalPath = "src/vscode-dts/vscode.proposed.devhubStatusBarHover.d.ts";
const patchesDir = resolve(root, "../../patches/vscode");
const addedBy = [];
for (const name of (await readdir(patchesDir)).sort()) {
  if (!name.endsWith(".patch")) {
    continue;
  }
  const patch = await readFile(resolve(patchesDir, name), "utf8");
  const added = new RegExp(
    `^\\+\\+\\+ b/${proposalPath.replaceAll(".", "\\.")}\\n@@[^\\n]*\\n((?:\\+[^\\n]*\\n)*)`,
    "mu",
  ).exec(patch);
  if (added !== null) {
    addedBy.push({ name, text: added[1].replace(/^\+/gmu, "") });
  }
}
if (addedBy.length !== 1) {
  throw new Error(
    `exactly one of patches/vscode/*.patch must add ${proposalPath}, found ${addedBy.length}`,
  );
}
const copy = await read("typings/vscode.proposed.devhubStatusBarHover.d.ts");
if (addedBy[0].text !== copy) {
  throw new Error(
    `typings/vscode.proposed.devhubStatusBarHover.d.ts differs from the one patches/vscode/${addedBy[0].name} adds`,
  );
}

console.log("DevHub Copilot static checks passed");
