#!/usr/bin/env node
/**
 * The Bridge v1 contract, and the artifacts generated from it.
 *
 * The bridge extension runs inside a VS Code workbench and talks to DevHub over
 * a frozen wire protocol. Both ends have to agree about it exactly, and the
 * extension is built separately from the app, so the agreement is a file rather
 * than a shared type: `contracts/bridge/bridge-v1.schema.json` is the contract,
 * and everything else here is derived from it.
 *
 * This used to be a Rust binary that emitted the schema from `schemars` and the
 * TypeScript from the schema. Rust is gone, so the schema is now the source
 * itself — it is a frozen v1 contract, which is exactly the kind of thing that
 * should be read and reviewed rather than regenerated — and this script does
 * the two jobs that remain:
 *
 * - emit `extensions/devhub-bridge/src/generated/bridge/index.ts` from it, so
 *   the extension's types and its validator cannot drift from the schema;
 * - check the checked-in fixtures against it, so `valid.ndjson` really is valid
 *   and `invalid.ndjson` really is not. The Rust generated those from typed
 *   values, which proved less: a fixture that no longer matches the schema is
 *   now a failure rather than a quiet rewrite.
 *
 * `--check` verifies without writing, and is what `pnpm run check` runs.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "contracts/bridge/bridge-v1.schema.json");
const TYPESCRIPT_PATH = join(
  ROOT,
  "extensions/devhub-bridge/src/generated/bridge/index.ts",
);
const VALID_PATH = join(ROOT, "contracts/bridge/valid.ndjson");
const INVALID_PATH = join(ROOT, "contracts/bridge/invalid.ndjson");

const BRIDGE_PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 262144;
const MAX_SAFE_INTEGER = 9007199254740991;

type Schema = Record<string, any>;

// ------------------------------------------------------------------ emission

/**
 * The name a schema definition is known by in TypeScript.
 *
 * Only one differs: Rust spells the identity type `Uuid`, and the contract has
 * always exposed it as `UUID`. Renaming it here keeps the extension's imports
 * unchanged now that the Rust side is gone.
 */
function tsName(name: string): string {
  return name === "Uuid" ? "UUID" : name;
}

function tsString(value: string): string {
  return JSON.stringify(value);
}

function refName(schema: Schema): string | undefined {
  const ref: unknown = schema["$ref"];
  return typeof ref === "string" ? ref.replace(/^#\/\$defs\//, "") : undefined;
}

function tsType(schema: Schema): string {
  const ref = refName(schema);
  if (ref !== undefined) return tsName(ref);

  if ("const" in schema) {
    const value: unknown = schema["const"];
    if (typeof value === "string") return tsString(value);
    if (typeof value === "boolean" || typeof value === "number") {
      return String(value);
    }
    return "unknown";
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    const values: unknown = schema[key];
    if (Array.isArray(values)) {
      return values.map((entry) => tsType(entry as Schema)).join(" | ");
    }
  }

  switch (schema["type"] as string | undefined) {
    case "string": {
      const values: unknown = schema["enum"];
      if (Array.isArray(values)) {
        return values
          .filter((entry): entry is string => typeof entry === "string")
          .map(tsString)
          .join(" | ");
      }
      return "string";
    }
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object": {
      const properties = schema["properties"] as
        | Record<string, Schema>
        | undefined;
      if (!properties) return "Record<string, unknown>";
      const required = (schema["required"] as string[] | undefined) ?? [];
      const fields = Object.entries(properties)
        .map(
          ([name, property]) =>
            `  ${name}${required.includes(name) ? "" : "?"}: ${tsType(property)};`,
        )
        .join("\n");
      return `{\n${fields}\n}`;
    }
    default:
      return "unknown";
  }
}

/** The branded string types the protocol uses for its identity values. */
const BRANDS: Readonly<Record<string, string>> = {
  UUID: "__devhubUuid",
  SemVer: "__devhubSemVer",
  AbsolutePath: "__devhubAbsolutePath",
};

function generatedTypeScript(schema: Schema): string {
  const definitions = schema["$defs"] as Record<string, Schema>;
  let output =
    "/** Generated from contracts/bridge/bridge-v1.schema.json; do not edit by hand. */\n" +
    "/* eslint-disable @typescript-eslint/no-explicit-any, no-empty */\n\n";
  output +=
    `export const BRIDGE_PROTOCOL_VERSION = ${BRIDGE_PROTOCOL_VERSION} as const;\n` +
    `export const MAX_MESSAGE_BYTES = ${MAX_MESSAGE_BYTES} as const;\n` +
    `export const MAX_SAFE_INTEGER = ${MAX_SAFE_INTEGER} as const;\n\n`;

  for (const [rawName, definition] of Object.entries(definitions)) {
    const name = tsName(rawName);
    if (name === "MessageKind") continue;
    if (name === "ContentFreeSummary" && "enum" in definition) {
      output += `export type ${name} = ${tsType(definition)};\n`;
    } else if (name in BRANDS) {
      output += `export type ${name} = string & { readonly ${BRANDS[name]}: unique symbol };\n`;
    } else if (definition["type"] === "object") {
      output += `export interface ${name} ${tsType(definition)}\n`;
    } else {
      output += `export type ${name} = ${tsType(definition)};\n`;
    }
  }

  // The message kinds, and the payload each one carries, both come from the
  // envelope's conditional branches — the schema is the only place that says
  // which payload belongs to which kind.
  const conditions = schema["allOf"] as Schema[];
  const kinds = conditions.map(
    (condition) => condition["if"]["properties"]["kind"]["const"] as string,
  );
  output += `export type MessageKind = ${kinds.map(tsString).join(" | ")};\n`;
  output += "export type PayloadForKind<K extends MessageKind> =\n";
  kinds.forEach((kind, index) => {
    const payload = conditions[index]["then"]["properties"]["payload"] as Schema;
    const payloadName = refName(payload);
    if (payloadName === undefined) {
      throw new Error(`payload for ${kind} is not a reference`);
    }
    const separator = index + 1 === kinds.length ? "" : " :";
    output += `  K extends ${tsString(kind)} ? ${tsName(payloadName)}${separator}\n`;
  });
  output +=
    "  : never;\n\nexport interface Envelope<K extends MessageKind = MessageKind> {\n";

  const properties = schema["properties"] as Record<string, Schema>;
  const required = schema["required"] as string[];
  for (const [name, property] of Object.entries(properties)) {
    const optional = required.includes(name) ? "" : "?";
    const type =
      name === "kind"
        ? "K"
        : name === "payload"
          ? "PayloadForKind<K>"
          : tsType(property);
    output += `  ${name}${optional}: ${type};\n`;
  }
  output += "}\n\n";

  output += `const BRIDGE_SCHEMA = ${JSON.stringify(schema)} as const;\n\n`;
  output += VALIDATOR_RUNTIME;
  return output;
}

const VALIDATOR_RUNTIME = `type Schema = Record<string, any>;

function resolve(ref: string): Schema {
  const parts = ref.replace(/^#\\//, "").split("/");
  let value: any = BRIDGE_SCHEMA;
  for (const part of parts) value = value[part];
  return value;
}

function check(schema: Schema, value: unknown): void {
  if (schema.$ref) return check(resolve(schema.$ref), value);
  if ("const" in schema && value !== schema.const) throw new Error("constant mismatch");
  if (Array.isArray(schema.enum) && !schema.enum.some((entry: unknown) => Object.is(entry, value))) throw new Error("enum mismatch");
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) {
      let passed = 0;
      for (const candidate of schema[key]) { try { check(candidate, value); passed++; } catch {} }
      if (key === "anyOf" ? passed < 1 : passed !== 1) throw new Error(\`\${key} mismatch\`);
    }
  }
  if (Array.isArray(schema.allOf)) for (const candidate of schema.allOf) {
    if (candidate.if) { try { check(candidate.if, value); } catch { continue; } check(candidate.then, value); }
    else check(candidate, value);
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("object expected");
    const item = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!(required in item)) throw new Error("missing field");
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) for (const key of Object.keys(item)) if (!(key in properties)) throw new Error("unknown field");
    for (const [key, property] of Object.entries(properties)) if (key in item) check(property as Schema, item[key]);
  } else if (schema.properties && typeof value === "object" && value !== null) {
    for (const [key, property] of Object.entries(schema.properties)) if (key in (value as any)) check(property as Schema, (value as any)[key]);
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error("string expected");
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) throw new Error("pattern mismatch");
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) throw new Error("string too long");
  } else if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("safe integer expected");
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error("number too small");
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error("number too large");
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error("boolean expected");
}

export function validateEnvelope(value: unknown): Envelope {
  check(BRIDGE_SCHEMA, value);
  return value as Envelope;
}

export function parseEnvelope(raw: string): Envelope {
  if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) throw new Error("message exceeds 256 KiB");
  return validateEnvelope(JSON.parse(raw) as unknown);
}

export function encodeEnvelope(value: Envelope): string {
  const encoded = JSON.stringify(validateEnvelope(value));
  if (new TextEncoder().encode(encoded).length > MAX_MESSAGE_BYTES) throw new Error("message exceeds 256 KiB");
  return encoded;
}

export function isEnvelope(value: unknown): value is Envelope {
  try { validateEnvelope(value); return true; } catch { return false; }
}
`;

// ------------------------------------------------------------------ fixtures

/**
 * The same validator the generated module ships, run here against the checked-
 * in fixtures. If this and the emitted one ever disagree, the emitted one is
 * the bug — it is the copy the extension actually uses.
 */
function makeValidator(schema: Schema): (value: unknown) => void {
  const resolve = (ref: string): Schema => {
    const parts = ref.replace(/^#\//, "").split("/");
    let value: any = schema;
    for (const part of parts) value = value[part];
    return value as Schema;
  };
  const check = (node: Schema, value: unknown): void => {
    if (node["$ref"]) return check(resolve(node["$ref"] as string), value);
    if ("const" in node && value !== node["const"]) {
      throw new Error("constant mismatch");
    }
    if (
      Array.isArray(node["enum"]) &&
      !(node["enum"] as unknown[]).some((entry) => Object.is(entry, value))
    ) {
      throw new Error("enum mismatch");
    }
    for (const key of ["anyOf", "oneOf"] as const) {
      if (Array.isArray(node[key])) {
        let passed = 0;
        for (const candidate of node[key] as Schema[]) {
          try {
            check(candidate, value);
            passed += 1;
          } catch {
            // A branch that does not match is the normal case for a union.
          }
        }
        if (key === "anyOf" ? passed < 1 : passed !== 1) {
          throw new Error(`${key} mismatch`);
        }
      }
    }
    if (Array.isArray(node["allOf"])) {
      for (const candidate of node["allOf"] as Schema[]) {
        if (candidate["if"]) {
          try {
            check(candidate["if"] as Schema, value);
          } catch {
            continue;
          }
          check(candidate["then"] as Schema, value);
        } else {
          check(candidate, value);
        }
      }
    }
    if (node["type"] === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("object expected");
      }
      const item = value as Record<string, unknown>;
      for (const required of (node["required"] as string[] | undefined) ?? []) {
        if (!(required in item)) throw new Error("missing field");
      }
      const properties =
        (node["properties"] as Record<string, Schema> | undefined) ?? {};
      if (node["additionalProperties"] === false) {
        for (const key of Object.keys(item)) {
          if (!(key in properties)) throw new Error("unknown field");
        }
      }
      for (const [key, property] of Object.entries(properties)) {
        if (key in item) check(property, item[key]);
      }
    } else if (
      node["properties"] &&
      typeof value === "object" &&
      value !== null
    ) {
      for (const [key, property] of Object.entries(
        node["properties"] as Record<string, Schema>,
      )) {
        if (key in (value as Record<string, unknown>)) {
          check(property, (value as Record<string, unknown>)[key]);
        }
      }
    }
    if (node["type"] === "string") {
      if (typeof value !== "string") throw new Error("string expected");
      const pattern = node["pattern"] as string | undefined;
      if (pattern && !new RegExp(pattern).test(value)) {
        throw new Error("pattern mismatch");
      }
      const maxLength = node["maxLength"] as number | undefined;
      if (maxLength !== undefined && [...value].length > maxLength) {
        throw new Error("string too long");
      }
    } else if (node["type"] === "integer" || node["type"] === "number") {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error("safe integer expected");
      }
      const minimum = node["minimum"] as number | undefined;
      const maximum = node["maximum"] as number | undefined;
      if (minimum !== undefined && value < minimum) {
        throw new Error("number too small");
      }
      if (maximum !== undefined && value > maximum) {
        throw new Error("number too large");
      }
    } else if (node["type"] === "boolean" && typeof value !== "boolean") {
      throw new Error("boolean expected");
    }
  };
  return (value) => {
    check(schema, value);
  };
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function checkFixtures(schema: Schema): string[] {
  const validate = makeValidator(schema);
  const failures: string[] = [];

  lines(VALID_PATH).forEach((line, index) => {
    try {
      validate(JSON.parse(line));
    } catch (error) {
      failures.push(
        `valid.ndjson:${index + 1} is rejected by the schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  lines(INVALID_PATH).forEach((line, index) => {
    let accepted = false;
    try {
      validate(JSON.parse(line));
      accepted = true;
    } catch {
      // Rejected, which is what an invalid fixture is for.
    }
    if (accepted) {
      failures.push(`invalid.ndjson:${index + 1} is accepted by the schema`);
    }
  });

  return failures;
}

// ---------------------------------------------------------------------- main

function main(): void {
  const check = process.argv.slice(2).includes("--check");
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Schema;
  const typescript = generatedTypeScript(schema);

  const failures = checkFixtures(schema);

  if (check) {
    let actual: string | undefined;
    try {
      actual = readFileSync(TYPESCRIPT_PATH, "utf8");
    } catch {
      failures.push(`missing generated bridge artifact: ${TYPESCRIPT_PATH}`);
    }
    if (actual !== undefined && actual !== typescript) {
      failures.push(
        `generated bridge artifact differs from the schema: ${TYPESCRIPT_PATH}`,
      );
    }
  } else if (failures.length === 0) {
    mkdirSync(dirname(TYPESCRIPT_PATH), { recursive: true });
    writeFileSync(TYPESCRIPT_PATH, typescript);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exit(1);
  }
}

main();
