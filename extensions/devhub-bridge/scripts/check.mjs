import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const extension = await readFile(resolve(root, "src/extension.ts"), "utf8");
const session = await readFile(resolve(root, "src/session.ts"), "utf8");
const transport = await readFile(resolve(root, "src/transport.ts"), "utf8");
const controller = await readFile(resolve(root, "src/controller.ts"), "utf8");
const registry = await readFile(resolve(root, "src/registry.ts"), "utf8");
const navigation = await readFile(resolve(root, "src/navigation.ts"), "utf8");

const required = [
  [extension, "Bridge configuration guard", "DEVHUB_BRIDGE_ENDPOINT"],
  [extension, "owner registry guard", "DEVHUB_BRIDGE_SURFACE_REGISTRY"],
  [extension, "public folder command", "devhub.bridge.openFolder"],
  [extension, "public new-window command", "devhub.bridge.newWindow"],
  [extension, "public URI handler", "registerUriHandler"],
  [extension, "remote workspace URI support", "vscode-remote"],
  [extension, "dirty observer", "onDidChangeTextDocument"],
  [session, "generated validator consumption", "parseEnvelope"],
  [session, "generated encoder consumption", "encodeEnvelope"],
  [session, "bounded request ledger", "requestLedger"],
  [transport, "loopback-only transport", "127.0.0.1"],
  [transport, "bearer authentication", "Authorization: Bearer"],
  [controller, "controller seam", "class BridgeControllerCore"],
  [registry, "owner registry parser", "parseSurfaceRegistry"],
  [navigation, "VS Code URI parser", "parseNavigationUri"],
];
for (const [source, label, needle] of required) {
  if (!source.includes(needle)) throw new Error(`${label} is missing`);
}
if (
  extension.includes("getText(") ||
  extension.includes("TextDocument.getText")
) {
  throw new Error("Bridge source appears to read editor content");
}
if (transport.includes("console.log") || transport.includes("console.error")) {
  throw new Error("transport must not log connection secrets");
}
if (manifest.engines?.vscode !== "^1.109.0") {
  throw new Error("Bridge must target the supported VS Code 1.x API range");
}
if (manifest.capabilities?.untrustedWorkspaces?.supported !== true) {
  throw new Error("Bridge must explicitly support safe untrusted workspaces");
}
const commands = manifest.contributes?.commands ?? [];
for (const command of ["devhub.bridge.openFolder", "devhub.bridge.newWindow"]) {
  if (!commands.some((entry) => entry.command === command)) {
    throw new Error(`public command is missing: ${command}`);
  }
}
if (extension.includes(": any") || extension.includes("vscode.d.ts")) {
  throw new Error("Bridge activation must use the pinned VS Code types");
}
console.log("DevHub Bridge static checks passed");
