#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixture = JSON.parse(
  readFileSync(
    resolve(root, "contracts/terminal/terminal-v1.fixture.json"),
    "utf8",
  ),
);
const schema = JSON.parse(
  readFileSync(
    resolve(root, "contracts/terminal/terminal-v1.schema.json"),
    "utf8",
  ),
);
const generated = readFileSync(
  resolve(root, "apps/devhub/src/terminal/generated.ts"),
  "utf8",
);
const client = readFileSync(
  resolve(root, "apps/devhub/src/terminal/client.ts"),
  "utf8",
);
const surface = readFileSync(
  resolve(root, "apps/devhub/src/terminal/TerminalSurface.tsx"),
  "utf8",
);

const generatedCheck = spawnSync(
  process.execPath,
  [resolve(root, "scripts/generate-terminal-contract.mjs"), "--check"],
  { encoding: "utf8" },
);
if (generatedCheck.status !== 0) {
  console.error(generatedCheck.stdout, generatedCheck.stderr);
  process.exit(generatedCheck.status ?? 1);
}

function fail(message) {
  throw new Error(`terminal contract check: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const expectedLimits = {
  maxInputBytes: 65536,
  maxOutputFrameBytes: 32768,
  maxChannelFrameBytes: 40960,
  maxSurfaceKeyBytes: 256,
  maxAttachmentIdBytes: 64,
  maxErrorSummaryBytes: 256,
  maxInputSequence: 9007199254740991,
  minCols: 1,
  maxCols: 500,
  minRows: 1,
  maxRows: 500,
  maxPixel: 10000,
  maxTargetGeneration: 9007199254740991,
};

assert(fixture.protocolVersion === 1, "fixture protocol version drifted");
assert(fixture.headerBytes === 8, "fixture header size drifted");
for (const [name, value] of Object.entries(expectedLimits)) {
  assert(fixture.limits[name] === value, `fixture limit ${name} drifted`);
}
assert(
  JSON.stringify(Object.keys(fixture.frameKinds)) ===
    JSON.stringify(["started", "output", "exited", "error"]),
  "fixture frame kinds drifted",
);

const requiredRequests = {
  attach: [
    "schemaVersion",
    "surfaceKey",
    "targetGeneration",
    "cols",
    "rows",
    "pixelWidth",
    "pixelHeight",
  ],
  input: [
    "schemaVersion",
    "surfaceKey",
    "attachmentId",
    "targetGeneration",
    "inputSequence",
    "bytes",
  ],
  resize: [
    "schemaVersion",
    "surfaceKey",
    "attachmentId",
    "targetGeneration",
    "cols",
    "rows",
    "pixelWidth",
    "pixelHeight",
  ],
  acknowledge: [
    "schemaVersion",
    "surfaceKey",
    "attachmentId",
    "targetGeneration",
    "sequence",
  ],
  detach: ["schemaVersion", "surfaceKey", "attachmentId", "targetGeneration"],
};

for (const [name, fields] of Object.entries(requiredRequests)) {
  const actual = Object.keys(fixture.requests[name]);
  assert(
    JSON.stringify(actual) === JSON.stringify(fields),
    `fixture ${name} request shape drifted`,
  );
}
assert(
  JSON.stringify(Object.keys(fixture.receipt)) ===
    JSON.stringify([
      "schemaVersion",
      "attachmentId",
      "surfaceKey",
      "targetGeneration",
    ]),
  "fixture receipt shape drifted",
);

assert(
  client.includes('from "./generated-contract"'),
  "client must consume generated request and receipt types",
);
assert(
  !/export interface Terminal(?:Size|Attach|Input|Resize|Ack|Detach)/u.test(
    client,
  ),
  "client must not duplicate generated terminal request types",
);
assert(
  !generated.includes("export type TerminalFrame"),
  "decoder must not duplicate generated frame algebra",
);

assert(schema.$defs?.attachRequest, "schema attach request definition missing");
assert(schema.$defs?.inputRequest, "schema input request definition missing");
assert(schema.$defs?.resizeRequest, "schema resize request definition missing");
assert(schema.$defs?.ackRequest, "schema acknowledge definition missing");
assert(schema.$defs?.detachRequest, "schema detach definition missing");
assert(schema.$defs?.receipt, "schema receipt definition missing");
assert(schema.$defs?.error, "schema error definition missing");
assert(
  schema.required.includes("requests") && schema.required.includes("receipt"),
  "schema top-level request/receipt contract missing",
);

assert(
  !surface.includes("allowProposedApi"),
  "TerminalSurface must not opt into proposed xterm APIs",
);
assert(
  surface.includes("await startedReady"),
  "TerminalSurface must wait for Started on the Channel",
);
assert(
  surface.includes("detachExact(returnedReceipt)"),
  "TerminalSurface must detach the exact returned receipt on failure",
);

console.log("terminal contract: PASS");
