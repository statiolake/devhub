#!/usr/bin/env node
/**
 * Import DevHub's built-in colour themes from a checkout of
 * mbadolato/iTerm2-Color-Schemes (the collection Ghostty ships).
 *
 *   node apps/desktop/scripts/import-terminal-themes.mjs <checkout>
 *
 * The checkout only needs `ghostty/`, `licenses.yml` and `LICENSE`
 * (`git clone --filter=blob:none --sparse` and `git sparse-checkout set
 * ghostty` is enough). It is read, never run, and nothing is fetched at
 * runtime: the output is committed.
 *
 * Only themes whose licence `licenses.yml` names as a permissive one are
 * taken. `unknown` and `nonfree` are what the collection itself marks as not
 * redistributable, and copyleft licences (GPL, LGPL, CC-BY-SA) are left out
 * too, so that every theme DevHub ships is under terms at least as
 * permissive as DevHub's own MIT. A theme with no entry is unknown.
 *
 * Writes:
 *   src/model/themes/builtinThemes.generated.ts — the colours, one row each
 *   distribution/licenses/iTerm2-Color-Schemes.txt — every theme, its licence,
 *     its source (shipped in the app's Resources/licenses)
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PERMISSIVE = new Set([
  "MIT",
  "Apache-2.0",
  "MIT OR Apache-2.0",
  "ISC",
  "CC0-1.0",
  "WTFPL",
  "Zlib",
  "Unlicense",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
]);

const checkout = process.argv[2];
if (!checkout) {
  console.error(
    "usage: import-terminal-themes.mjs <iTerm2-Color-Schemes checkout>",
  );
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "model", "themes");

const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

/** A YAML scalar as licenses.yml writes one: plain, '…' or "…". */
function scalar(text) {
  const value = text.trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

/** licenses.yml: `Name:` then indented `license:`, `source:`, `note:`. */
function readLicences(text) {
  const licences = new Map();
  let current;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      const key = line.replace(/:\s*$/u, "");
      current = { license: "unknown", source: "" };
      licences.set(scalar(key), current);
      continue;
    }
    const match = /^\s+(license|source|note):\s?(.*)$/u.exec(line);
    if (match && current) current[match[1]] = scalar(match[2]);
  }
  return licences;
}

const HEX = /^#?([0-9a-fA-F]{6})$/u;

/** A Ghostty theme file: `palette = N=#rrggbb` and `key = #rrggbb`. */
function readGhostty(text, name) {
  const palette = new Array(16);
  const fields = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([a-z-]+)\s*=\s*(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "palette") {
      const entry = /^(\d+)=(.+)$/u.exec(value);
      if (!entry) throw new Error(`${name}: palette line ${line}`);
      const index = Number(entry[1]);
      const color = HEX.exec(entry[2]);
      if (index < 16 && color) palette[index] = color[1].toLowerCase();
    } else {
      const color = HEX.exec(value);
      if (color) fields[key] = color[1].toLowerCase();
    }
  }
  const need = (key) => {
    const value = fields[key];
    if (!value) throw new Error(`${name}: no ${key}`);
    return value;
  };
  if (palette.some((value) => value === undefined) || palette.length !== 16) {
    throw new Error(`${name}: incomplete palette`);
  }
  const background = need("background");
  const foreground = need("foreground");
  return [
    background,
    foreground,
    fields["cursor-color"] ?? foreground,
    fields["cursor-text"] ?? background,
    need("selection-background"),
    fields["selection-foreground"] ?? foreground,
    ...palette,
  ];
}

const licences = readLicences(
  readFileSync(join(checkout, "licenses.yml"), "utf8"),
);
const rows = [];
const notice = [];
const skipped = new Map();
for (const name of readdirSync(join(checkout, "ghostty")).sort((a, b) =>
  a.localeCompare(b, "en", { sensitivity: "base" }),
)) {
  const licence = licences.get(name) ?? { license: "unknown", source: "" };
  if (!PERMISSIVE.has(licence.license)) {
    skipped.set(licence.license, (skipped.get(licence.license) ?? 0) + 1);
    continue;
  }
  const colors = readGhostty(
    readFileSync(join(checkout, "ghostty", name), "utf8"),
    name,
  );
  rows.push(
    // As prettier lays it out, so a re-import is byte for byte.
    `  [\n    ${JSON.stringify(name)},\n    ${JSON.stringify(colors.join(" "))},\n  ],`,
  );
  notice.push(
    `${name}\n  Licence: ${licence.license}\n  Source: ${licence.source || "(not recorded)"}`,
  );
}

writeFileSync(
  join(out, "builtinThemes.generated.ts"),
  `// Generated by scripts/import-terminal-themes.mjs from
// https://github.com/mbadolato/iTerm2-Color-Schemes at ${commit}
// (ghostty/), permissively licensed themes only. Do not edit. Licences:
// distribution/licenses/iTerm2-Color-Schemes.txt.
//
// Each row: the theme's name, then 22 colours as rrggbb — background,
// foreground, cursor, cursor text, selection background, selection
// foreground, then ANSI 0–15.

export const BUILTIN_THEMES_COMMIT = ${JSON.stringify(commit)};

export const BUILTIN_THEME_ROWS: readonly (readonly [string, string])[] = [
${rows.join("\n")}
];
`,
);

const collectionLicense = readFileSync(
  join(checkout, "LICENSE"),
  "utf8",
).trim();
writeFileSync(
  join(
    here,
    "..",
    "..",
    "..",
    "distribution",
    "licenses",
    "iTerm2-Color-Schemes.txt",
  ),
  `iTerm2-Color-Schemes: DevHub's built-in colour themes
=====================================================

DevHub's built-in colour themes (apps/desktop/src/model/themes/
builtinThemes.generated.ts) come from iTerm2-Color-Schemes,
https://github.com/mbadolato/iTerm2-Color-Schemes, commit
${commit}, converted from its ghostty/ directory by
apps/desktop/scripts/import-terminal-themes.mjs. Only the themes the
collection's licenses.yml lists under a permissive licence are included;
every theme it marks unknown or nonfree, and every copyleft one, is left out.
"DevHub Dark" and "DevHub Light" are DevHub's own.

The collection
--------------

${collectionLicense}

Each theme
----------

The copyright of each theme is its author's. Each is used under the licence
named here, from the source named here. The Apache License 2.0 text is in
herdr-Apache-2.0.txt beside this file; the MIT text is the collection's above,
with each theme's author as the copyright holder.

${notice.join("\n\n")}
`,
);

console.log(
  `${rows.length} themes from ${commit}; left out: ${[...skipped]
    .map(([licence, count]) => `${licence} ${count}`)
    .join(", ")}`,
);
