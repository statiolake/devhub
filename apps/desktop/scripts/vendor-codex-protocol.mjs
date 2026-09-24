/**
 * Vendors the `codex app-server` protocol types DevHub's Codex adapter reads.
 *
 *   node scripts/vendor-codex-protocol.mjs <openai/codex checkout>
 *
 * The checkout is the openai/codex repository at the tag being pinned. Its
 * `codex-rs/app-server-protocol/schema/typescript` holds the types
 * `codex app-server generate-ts` prints, checked in by upstream; this copies
 * the import closure of the roots below into
 * `src/main/agent/conversation/codex/protocol/`, with upstream's LICENSE and
 * NOTICE beside them.
 *
 * One thing changes on the way: a relative specifier gains `.js`
 * (`"./ThreadItem"` becomes `"./ThreadItem.js"`), because the main process
 * resolves modules the way Node does (`nodenext`) and Node does not guess an
 * extension. Nothing else is touched, so a file stays diffable against
 * upstream.
 *
 * The closure, rather than the whole directory, because DevHub reads a small
 * part of a large protocol. `ServerNotification` and `ServerRequest` are roots
 * whole: the adapter classifies every method they name, so a method a new
 * version adds is a compile error in the adapter rather than a silent gap.
 */

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = [
  "ServerNotification",
  "ServerRequest",
  "InitializeParams",
  "InitializeResponse",
  "v2/GetAccountParams",
  "v2/GetAccountResponse",
  "v2/ThreadStartParams",
  "v2/ThreadStartResponse",
  "v2/ThreadResumeParams",
  "v2/ThreadResumeResponse",
  "v2/TurnStartParams",
  "v2/TurnStartResponse",
  "v2/TurnSteerParams",
  "v2/TurnSteerResponse",
  "v2/TurnInterruptParams",
  "v2/TurnInterruptResponse",
  "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalResponse",
  "v2/PermissionsRequestApprovalResponse",
  "v2/ToolRequestUserInputResponse",
  "v2/McpServerElicitationRequestResponse",
  "v2/ModelListParams",
  "v2/ModelListResponse",
];

const SCHEMA = "codex-rs/app-server-protocol/schema/typescript";
const SPECIFIER = /(from\s+")(\.{1,2}\/[^"]+)(")/g;

const checkout = process.argv[2];
if (checkout === undefined) {
  throw new Error("usage: vendor-codex-protocol.mjs <openai/codex checkout>");
}
const source = join(checkout, SCHEMA);
if (!existsSync(source)) {
  throw new Error(
    `${source} does not exist: is ${checkout} an openai/codex checkout?`,
  );
}
const target = fileURLToPath(
  new URL("../src/main/agent/conversation/codex/protocol/", import.meta.url),
);

/** Module names (no extension, relative to the schema root) the roots reach. */
function closure(roots) {
  const seen = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const text = readFileSync(join(source, `${name}.ts`), "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      pending.push(normalize(join(dirname(name), match[2])));
    }
  }
  return [...seen].sort();
}

async function removeGenerated(directory) {
  if (!existsSync(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rm(path, { recursive: true });
    else if (entry.name.endsWith(".ts")) await rm(path);
  }
}

const modules = closure(ROOTS);
await removeGenerated(target);
for (const name of modules) {
  const text = readFileSync(join(source, `${name}.ts`), "utf8");
  const out = join(target, `${name}.ts`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text.replace(SPECIFIER, "$1$2.js$3"));
}
await copyFile(join(checkout, "LICENSE"), join(target, "LICENSE"));
await copyFile(join(checkout, "NOTICE"), join(target, "NOTICE"));
console.log(`vendored ${modules.length} modules into ${target}`);
