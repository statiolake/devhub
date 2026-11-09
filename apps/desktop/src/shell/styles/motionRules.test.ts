/*
 * Only transform and opacity move (docs/motion.md).
 *
 * An animation or transition of a layout property moves everything laid out
 * after the element, every frame, to wherever the curve has it — not to
 * where the layout will put it — and an animation that ends on a value
 * computed before the layout settled ends somewhere else. A change of place
 * or size is laid out at once and shown moving with FLIP (`glide.ts`).
 *
 * The exceptions are few and named, each with why it cannot move anything
 * the person did not ask to move.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const LAYOUT =
  /\b(?:width|height|min-width|min-height|max-width|max-height|block-size|inline-size|top|left|right|bottom|inset|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|grid-template-[a-z]+|flex(?:-[a-z]+)?|font-size|line-height|all)\b/;

/** Each allowed exception: the file, the rule's text, and why. */
const EXCEPTIONS: readonly { file: RegExp; text: RegExp }[] = [
  // A disclosure opens to its height under the person's click; only what
  // is under it moves, and only because they asked.
  {
    file: /conversation\/conversation\.css$/,
    text: /block-size var\(--motion-slow\)/,
  },
  // A Sidebar row collapsing as it leaves: it ends at zero, where the
  // layout without it ends too.
  { file: /styles\/shell\.css$/, text: /^row-exit$/ },
  // The Smart Buttons' box gliding onto the spot it was dropped near: it is
  // absolutely placed over the pane, so its own place moves nothing else.
  { file: /agents\/smartButtons\.css$/, text: /right var\(--motion-slow\)/ },
];

function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((each) => {
    const path = join(directory, each.name);
    if (each.isDirectory()) return stylesheets(path);
    return each.name.endsWith(".css") ? [path] : [];
  });
}

function allowed(path: string, text: string): boolean {
  return EXCEPTIONS.some(
    (each) => each.file.test(path) && each.text.test(text),
  );
}

/** The body of the block that opens at `start` (just past its `{`). */
function block(css: string, start: number): string {
  let depth = 1;
  let at = start;
  while (depth > 0 && at < css.length) {
    if (css[at] === "{") depth += 1;
    else if (css[at] === "}") depth -= 1;
    at += 1;
  }
  return css.slice(start, at - 1);
}

describe("motion", () => {
  const sheets = stylesheets(ROOT).map((path) => ({
    path: path.slice(ROOT.length),
    css: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
  }));

  it("is never a keyframe of a layout property", () => {
    const offending = sheets.flatMap(({ path, css }) =>
      [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)].flatMap((match) => {
        const name = match[1]!;
        const body = block(css, match.index + match[0].length);
        const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map(
          (each) => each[1]!,
        );
        const moving = properties.filter(
          (property) =>
            LAYOUT.test(property) && property.replace(LAYOUT, "") === "",
        );
        if (moving.length === 0 || allowed(path, name)) return [];
        return [`${path}: @keyframes ${name} (${moving.join(", ")})`];
      }),
    );
    expect(offending).toEqual([]);
  });

  it("is never a transition of a layout property", () => {
    const offending = sheets.flatMap(({ path, css }) =>
      [...css.matchAll(/transition(?:-property)?\s*:([^;}]*)[;}]/g)].flatMap(
        (match) => {
          const value = match[1]!.replace(/\s+/g, " ").trim();
          const moving = value
            .split(",")
            .map((each) => each.trim().split(" ")[0]!)
            .filter((property) => LAYOUT.test(property) && property !== "none")
            .filter((property) => property.replace(LAYOUT, "") === "");
          if (moving.length === 0 || allowed(path, value)) return [];
          return [`${path}: transition ${value}`];
        },
      ),
    );
    expect(offending).toEqual([]);
  });
});
