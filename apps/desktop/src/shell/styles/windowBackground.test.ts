/*
 * Which pages may have a window background.
 *
 * `styles/windowBackground.css` is the only place that paints a page's body,
 * and it is reachable from exactly three entries. The layer pages — the
 * questions and the notices — are drawn over a live workbench, so a body with
 * a ground of their own is the picker painted grey over the editor. Their own
 * `background: transparent` cannot outrank a `:root[...] body` rule, so the
 * rule simply must not be in their stylesheet graph: that is what this asserts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const STYLESHEET = "windowBackground.css";

/** Every stylesheet an entry pulls in, followed one level deep. */
const stylesheetsOf = (entry: string): readonly string[] =>
  [...read(entry).matchAll(/^import "([^"]+\.css)";$/gm)].map(([, path]) =>
    path.replace(/^.*\//, ""),
  );

const WINDOW_PAGES = [
  ["the window's own page", "../main.tsx"],
  ["the Sidebar", "../sidebar/main.tsx"],
  ["Settings", "../../settings/SettingsApp.tsx"],
] as const;

const LAYER_PAGES = [
  ["the questions", "../picker/main.tsx"],
  ["the notices", "../toasts/main.tsx"],
] as const;

describe("the window background", () => {
  it("is declared in one file and nowhere else", () => {
    // Not in the tokens every page imports: that is how it reached the
    // layers, and how the picker stopped being transparent.
    expect(read("tokens.css")).not.toMatch(/^\s*body \{[^}]*background: var/ms);
    expect(read(STYLESHEET)).toContain(
      ':root[data-window-material="none"] body {',
    );
    expect(read(STYLESHEET)).toContain(
      "(prefers-reduced-transparency: reduce)",
    );
    // And no shared sheet smuggles it back in behind an entry's back: an
    // entry's import list is the whole of what a page's body obeys.
    for (const shared of ["tokens.css", "shell.css", "macos.css"]) {
      expect(read(shared)).not.toContain(`@import`);
    }
  });

  it.each(WINDOW_PAGES)("is imported by %s", (_name, entry) => {
    expect(stylesheetsOf(entry)).toContain(STYLESHEET);
  });

  it.each(LAYER_PAGES)("is out of reach of %s", (_name, entry) => {
    expect(stylesheetsOf(entry)).not.toContain(STYLESHEET);
  });
});
