/*
 * No sibling rule between two `*`s.
 *
 * A selector like `.picker > * + *` puts every element of the page under a
 * rule whose sibling invalidation Blink cannot narrow, and an element
 * inserted into or removed from any parent then restyles all of that
 * parent's children. On a page that grows — a GUI Agent's transcript, its
 * thousands of entries — that was 25–45 ms of style and layout per entry
 * added (docs/process-model.md, phase 6c). `:not(:first-child)` says the same
 * and invalidates only the old and the new first child.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((each) => {
    const path = join(directory, each.name);
    if (each.isDirectory()) return stylesheets(path);
    return each.name.endsWith(".css") ? [path] : [];
  });
}

describe("sibling rules", () => {
  it("never join two universal compounds", () => {
    const offending = stylesheets(ROOT).flatMap((path) => {
      // Comments may name the rule they replace.
      const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return [...css.matchAll(/\*\s*[+~]\s*\*/g)].map(
        ([rule]) => `${path.slice(ROOT.length)}: ${rule}`,
      );
    });
    expect(offending).toEqual([]);
  });
});
