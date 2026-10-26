/**
 * VS Code's registered colour defaults, as DevHub resolves a theme with them.
 *
 * A colour theme sets the colours it cares about and leaves every other one to
 * the colour registry: `registerColor(id, { dark, light, hcDark, hcLight })`
 * in VS Code's own sources, where a default is a literal, a reference to
 * another colour, or a transform of one (`transparent`, `darken`, `oneOf`, …).
 * DevHub reads themes itself (`src/main/shell/colorThemeCatalog.ts`), so it
 * needs those defaults too, and they are VS Code's — they move with a bump.
 *
 * So they are not copied by hand. This script bundles the pinned submodule's
 * registry modules with esbuild (straight from `vscode/src`, no VS Code build
 * needed), runs them, and writes every colour DevHub resolves
 * (`src/model/colorIds.ts`, which it runs too) — and every colour those
 * defaults refer to, transitively — to
 * `src/model/colorDefaults.generated.ts`, which is checked in: the app and its
 * tests read it without a VS Code checkout, and a bump shows up as a diff.
 *
 *   node scripts/generate-color-defaults.mjs            # rewrite the table
 *   node scripts/generate-color-defaults.mjs --check    # fail if it is stale
 *   node scripts/generate-color-defaults.mjs --vscode <dir>   # another checkout
 *
 * `colorDefaults.test.ts` runs the `--check` comparison whenever the submodule
 * is checked out, so a bump that moves a default fails the tests until the
 * table is regenerated.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { format } from "prettier";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(APP_ROOT, "..", "..");
const OUTPUT = join(APP_ROOT, "src", "model", "colorDefaults.generated.ts");

/** The registry modules that register the colours above and what they use. */
const MODULES = [
  "vs/platform/theme/common/colorRegistry.ts",
  "vs/workbench/common/theme.ts",
  "vs/workbench/contrib/terminal/common/terminalColorRegistry.ts",
];

/** `ColorTransformType`, by its numeric value (a `const enum` upstream). */
const OPS = [
  "darken",
  "lighten",
  "transparent",
  "opaque",
  "oneOf",
  "lessProminent",
  "ifDefinedThenElse",
  "mix",
];

const THEME_TYPES = ["light", "dark", "hcDark", "hcLight"];

function serializeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "rgba" in value) {
    const { r, g, b, a } = value.rgba;
    return { rgba: [r, g, b, a] };
  }
  if (typeof value === "object" && typeof value.op === "number") {
    const op = OPS[value.op];
    if (op === undefined) {
      throw new Error(`unknown colour transform ${String(value.op)}`);
    }
    const out = { op };
    for (const [key, field] of Object.entries(value)) {
      if (key === "op") continue;
      if (key === "values") out.values = field.map(serializeValue);
      else if (typeof field === "number" || key === "if") out[key] = field;
      else out[key] = serializeValue(field);
    }
    return out;
  }
  throw new Error(`cannot serialise colour value ${JSON.stringify(value)}`);
}

function references(value, into) {
  if (value === null) return;
  if (typeof value === "string") {
    if (!value.startsWith("#")) into.add(value);
    return;
  }
  if ("rgba" in value) return;
  for (const [key, field] of Object.entries(value)) {
    if (key === "op") continue;
    if (key === "if") into.add(field);
    else if (key === "values") field.forEach((one) => references(one, into));
    else if (typeof field === "object") references(field, into);
  }
}

/** Run the registry modules of `vscodeRoot` and read their defaults. */
async function readRegistry(vscodeRoot) {
  const source = join(vscodeRoot, "src");
  const scratch = mkdtempSync(join(tmpdir(), "devhub-color-defaults-"));
  try {
    const entry = join(scratch, "entry.ts");
    writeFileSync(
      entry,
      [
        ...MODULES.map(
          (module, index) =>
            `import * as m${String(index)} from ${JSON.stringify(join(source, module))};`,
        ),
        // The ANSI colours are registered by a call, which the terminal
        // contribution makes at startup upstream.
        "m2.registerColors();",
        "export const colors = m0.getColorRegistry().getColors();",
        `export { colorIdList } from ${JSON.stringify(join(APP_ROOT, "src", "model", "colorIds.ts"))};`,
        "void [" +
          MODULES.map((_, index) => `m${String(index)}`).join(", ") +
          "];",
      ].join("\n"),
    );
    const bundle = join(scratch, "registry.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "error",
    });
    const { colors, colorIdList } = await import(pathToFileURL(bundle).href);
    return { colors, roots: colorIdList() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The table, as the text of the generated module. */
export async function generate(vscodeRoot) {
  // The roots are the colours DevHub reads (`src/model/colorIds.ts`).
  const { colors, roots } = await readRegistry(vscodeRoot);
  const byId = new Map(colors.map((color) => [color.id, color]));
  const table = {};
  const pending = [...roots];
  while (pending.length > 0) {
    const id = pending.shift();
    if (id in table) continue;
    const color = byId.get(id);
    if (!color) {
      throw new Error(`VS Code registers no colour '${id}'`);
    }
    const defaults = color.defaults;
    const perType =
      defaults !== null &&
      typeof defaults === "object" &&
      "light" in defaults &&
      "dark" in defaults
        ? Object.fromEntries(
            THEME_TYPES.map((type) => [type, serializeValue(defaults[type])]),
          )
        : Object.fromEntries(
            THEME_TYPES.map((type) => [type, serializeValue(defaults)]),
          );
    table[id] = perType;
    const referenced = new Set();
    for (const type of THEME_TYPES) references(perType[type], referenced);
    pending.push(...[...referenced].filter((one) => !(one in table)));
  }
  const sorted = Object.fromEntries(
    Object.keys(table)
      .sort()
      .map((id) => [id, table[id]]),
  );
  const text = [
    "// Generated by scripts/generate-color-defaults.mjs from VS Code's colour",
    "// registry (the vscode submodule). Do not edit by hand.",
    "",
    'import type { ColorDefaultsTable } from "./colorTheme.js";',
    "",
    `export const COLOR_DEFAULTS: ColorDefaultsTable = ${JSON.stringify(sorted)};`,
    "",
  ].join("\n");
  return format(text, { parser: "typescript", filepath: OUTPUT });
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const at = args.indexOf("--vscode");
  const vscodeRoot = at >= 0 ? args[at + 1] : join(REPO_ROOT, "vscode");
  const text = await generate(vscodeRoot);
  if (check) {
    const current = readFileSync(OUTPUT, "utf8");
    if (current !== text) {
      console.error(
        "src/model/colorDefaults.generated.ts is stale: run node scripts/generate-color-defaults.mjs",
      );
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUTPUT, text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
