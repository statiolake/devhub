/**
 * The static checks on DevHub's `ssh-remote` resolver.
 *
 * The extension is one registration, and the point of these checks is that it
 * stays one. The extension it replaces grew an SSH client, a config parser, a
 * server installer, a port-forwarding view and a settings page, all of which
 * DevHub already owns; a second copy of any of them is how the two copies start
 * to disagree about which host a person named.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const extension = await readFile(resolve(root, "src/extension.ts"), "utf8");
const resolver = await readFile(resolve(root, "src/resolveRemote.ts"), "utf8");
const control = await readFile(resolve(root, "src/control.ts"), "utf8");

const required = [
  [
    extension,
    "resolver registration",
    'registerRemoteAuthorityResolver("ssh-remote"',
  ],
  [resolver, "authority prefix", "ssh-remote+"],
  [resolver, "machine spelling", "ssh:"],
  [control, "control socket derivation", "controlSocketFromGlobalStorage"],
  [control, "control socket request", "resolve-remote"],
];
for (const [source, label, needle] of required) {
  if (!source.includes(needle)) throw new Error(`${label} is missing`);
}
// Everything the vendored resolver did that DevHub does instead.
const sources = `${extension}${resolver}${control}`;
for (const [label, needle] of [
  ["an SSH client", "ssh2"],
  ["an ssh config reader", ".ssh/config"],
  ["a port forwarding surface", "tunnelFactory"],
  ["a context key", "setContext"],
  ["a settings reader", "getConfiguration"],
]) {
  if (sources.includes(needle)) {
    throw new Error(`the resolver must not carry ${label}: ${needle}`);
  }
}
if (manifest.engines?.vscode !== "^1.109.0") {
  throw new Error("DevHub's extension must target the supported VS Code range");
}
if (manifest.capabilities?.untrustedWorkspaces?.supported !== true) {
  throw new Error("DevHub's extension must support safe untrusted workspaces");
}
// `ui` is load-bearing: the control socket is on DevHub's machine, so a
// resolver that ran on the remote could never reach it.
if (
  manifest.extensionKind?.length !== 1 ||
  manifest.extensionKind[0] !== "ui"
) {
  throw new Error(
    "the resolver must run on the local machine: extensionKind ui",
  );
}
if (!manifest.enabledApiProposals?.includes("resolvers")) {
  throw new Error("the resolvers API proposal must be enabled");
}
if (manifest.api !== "none") {
  throw new Error("the resolver exports no API of its own");
}
const events = manifest.activationEvents ?? [];
if (
  events.length !== 1 ||
  events[0] !== "onResolveRemoteAuthority:ssh-remote" ||
  events.includes("*")
) {
  throw new Error(
    "activation must be onResolveRemoteAuthority:ssh-remote and nothing wider",
  );
}
// The manifest contributes one thing: how a remote path is spelled in the UI.
const contributes = manifest.contributes ?? {};
if (Object.keys(contributes).join(",") !== "resourceLabelFormatters") {
  throw new Error(
    "the resolver contributes resourceLabelFormatters and nothing else",
  );
}
const formatter = contributes.resourceLabelFormatters?.[0];
if (
  formatter?.scheme !== "vscode-remote" ||
  formatter?.authority !== "ssh-remote+*" ||
  formatter?.formatting?.tildify !== true ||
  formatter?.formatting?.workspaceSuffix !== "SSH"
) {
  throw new Error("the remote resource label formatter is missing or changed");
}
if (extension.includes(": any") || resolver.includes(": any")) {
  throw new Error("the resolver must use the pinned VS Code types");
}
/**
 * The identity product.json has to match, checked against product.json.
 *
 * VS Code composes this extension's identity as `<publisher>.<name>` from the
 * manifest and looks *that* key up in `extensionEnabledApiProposals`
 * (`extensionsProposedApi.ts`). Get it wrong and nothing says so where anyone
 * is looking: the grant silently does not apply, `resolvers` is not enabled,
 * the authority is never resolved, and the only trace is one line in the
 * extension host log. The window just sits there.
 *
 * Two ways to get it wrong, and this catches both. A scoped npm name — the
 * repo's own convention for every other workspace package — would make the
 * identity `devhub.@devhub/remote`, which is not even a legal extension id.
 * And a grant that names a different extension is the same failure with a
 * different cause. So the name in the manifest is the extension's, the
 * workspace filter is `devhub-remote`, and the two halves are compared here.
 */
const identity = `${manifest.publisher}.${manifest.name}`;
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(identity)) {
  throw new Error(
    `${identity} is not a legal VS Code extension identifier, so no ` +
      `product.json grant can name it (EXTENSION_IDENTIFIER_PATTERN)`,
  );
}
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
    `scripts/product_metadata.py grants no API proposals to ${identity}, so ` +
      `the resolver would load and be refused 'resolvers' with nothing said ` +
      `anywhere a person is looking`,
  );
}
for (const proposal of manifest.enabledApiProposals ?? []) {
  if (!granted[1].includes(`"${proposal}"`)) {
    throw new Error(
      `${identity} asks for the '${proposal}' API proposal and ` +
        `scripts/product_metadata.py does not grant it`,
    );
  }
}

console.log("DevHub remote resolver static checks passed");
