/*
 * The Workspace row's line: the Issue is its icon alone, right after the name,
 * and a narrow row drops whole marks instead of clipping the folder.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./shell.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("Workspace row layout", () => {
  it("does not pull the Issue title under the trailing marks", () => {
    expect(css).not.toMatch(/\.row-issue-title\.has-pr/);
    expect(css).not.toMatch(/margin-right:\s*-\d+px/);
  });

  it("keeps the Issue mark whole: an icon, never a fading title", () => {
    expect(css).toMatch(/\.row-issue-title\s*\{[^}]*flex:\s*none/);
    expect(css).not.toMatch(/\.row-issue-title\s*\{[^}]*mask-image/);
    expect(css).not.toMatch(/\.row-issue-note/);
  });

  it("lets the name's button, not the folder, give way", () => {
    expect(css).toMatch(
      /\.sidebar-context-button\.has-issue-title\s*\{[^}]*flex:\s*0 1 auto/,
    );
    expect(css).toMatch(/\.row-glyph\s*\{[^}]*flex:\s*0 0 var/);
  });

  it("drops the Issue mark and editor mark whole in a narrow row", () => {
    expect(css).toMatch(
      /\.workspace-row\s*\{[^}]*container-type:\s*inline-size/,
    );
    expect(css).toMatch(
      /@container workspace-row \(max-width: \d+px\)\s*\{[^}]*\.row-issue-title,\s*\.row-mark-editor\s*\{[^}]*display:\s*none/,
    );
  });
});
