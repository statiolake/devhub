/*
 * One scrollbar for every page DevHub draws.
 *
 * The thin thumb is written once, in `styles/tokens.css`, which every page
 * imports; no other stylesheet draws a scrollbar of its own, so a new panel
 * that scrolls gets the same one without asking. xterm's own is left to
 * xterm.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

const read = (relative: string): string =>
  readFileSync(join(SRC, relative), "utf8");

/** Every page's entry: each is a document of its own. */
const PAGES = [
  "shell/main.tsx",
  "shell/sidebar/main.tsx",
  "shell/agents/main.tsx",
  "shell/picker/main.tsx",
  "shell/toasts/main.tsx",
  "shell/tooltip/main.tsx",
  "settings/SettingsApp.tsx",
] as const;

function stylesheets(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

describe("scrollbars", () => {
  it("are drawn by the one stylesheet every page imports", () => {
    for (const page of PAGES) {
      expect(read(page), page).toMatch(/^import "[^"]*styles\/tokens\.css";$/m);
    }
  });

  it("are a thin thumb with no track, wider under the pointer, xterm's left alone", () => {
    const tokens = read("shell/styles/tokens.css");
    const rule = (selector: string) =>
      new RegExp(
        `\\n:not\\(\\.xterm, \\.xterm \\*\\)${selector.replaceAll(":", "\\:")} \\{([^}]*)\\}`,
      ).exec(tokens)?.[1] ?? "";
    expect(rule("::-webkit-scrollbar")).toMatch(/width:\s*10px/);
    expect(rule("::-webkit-scrollbar-thumb")).toMatch(
      /border:\s*3px solid transparent/,
    );
    expect(rule("::-webkit-scrollbar-thumb:hover")).toMatch(
      /border-width:\s*2px/,
    );
  });

  it("are drawn nowhere else", () => {
    for (const path of stylesheets(SRC)) {
      if (path.endsWith(join("styles", "tokens.css"))) continue;
      expect(readFileSync(path, "utf8"), path).not.toMatch(
        /::-webkit-scrollbar|scrollbar-width|scrollbar-color/,
      );
    }
  });
});
