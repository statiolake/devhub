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
  "shell/pane/main.tsx",
  "settings/SettingsApp.tsx",
  "taskManager/TaskManagerApp.tsx",
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

  it("are hidden by one class, for a strip that fades its edges instead", () => {
    const tokens = read("shell/styles/tokens.css");
    expect(tokens).toMatch(
      /\n\.scrollbar-none,\n[^{]*\{\s*scrollbar-width: none;\s*\}/,
    );
    expect(tokens).toMatch(
      /\n\.scrollbar-none::-webkit-scrollbar,\n[^{]*\{\s*display: none;\s*\}/,
    );
    expect(read("shell/neovim/TabStrip.tsx")).toContain('"scrollbar-none"');
  });

  /*
   * Compact mode's rail is one 26px entry in a 40px pane: a kept 10px gutter
   * left its rows 16px, and the bar stood over the trailing half of every
   * mark. The rail draws no bar (the pointer on it grows it into the floating
   * Sidebar, which has one), and keeps no room for it.
   */
  it("are not drawn in compact mode's rail, which has no room for one", () => {
    const tokens = read("shell/styles/tokens.css");
    const rail = '.sidebar[data-collapsed="true"] .sidebar-scroll-region';
    const hidden =
      /\n(\.scrollbar-none,\n[^{]*)\{\s*scrollbar-width: none;/.exec(
        tokens,
      )?.[1];
    expect(hidden).toContain(rail);
    const gone =
      /\n(\.scrollbar-none::-webkit-scrollbar,\n[^{]*)\{\s*display: none;/.exec(
        tokens,
      )?.[1];
    expect(gone).toContain(`${rail}::-webkit-scrollbar`);
  });

  /*
   * A drawn bar takes its 10px; a list that grew past its box narrowed by
   * that much the moment it did, and what was right-aligned in it stepped
   * left. Every list that can grow keeps the room (docs/motion.md).
   */
  it("keep their room in every list that can grow", () => {
    const lists: readonly (readonly [string, string])[] = [
      ["shell/styles/shell.css", ".sidebar-scroll-region"],
      ["shell/styles/macos.css", ".mac-list"],
      ["shell/styles/macos.css", ".chord-help-rows"],
      ["shell/styles/macos.css", ".picker-aside"],
      ["shell/styles/toast.css", ".notice-center-list"],
      ["shell/agents/orchestrator.css", ".orchestrator-lanes"],
      ["shell/agents/orchestrator.css", ".orchestrator-files"],
      ["shell/agents/orchestrator.css", ".orchestrator-thread"],
      ["shell/completion/completionMenu.css", ".completion-menu"],
      ["shell/conversation/conversation.css", ".conversation-scroll"],
      ["shell/conversation/conversation.css", ".conversation-background-list"],
      ["settings/settings.css", ".sf-form"],
      ["settings/settings.css", ".sf-list"],
      ["settings/settings.css", ".sf-detail"],
      ["settings/settings.css", ".settings-theme-list"],
      ["taskManager/taskManager.css", ".tm-table"],
    ];
    for (const [file, selector] of lists) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const body = new RegExp(`\\n${escaped} \\{([^}]*)\\}`).exec(
        read(file),
      )?.[1];
      expect(body, `${file} ${selector}`).toMatch(/scrollbar-gutter:\s*stable/);
    }
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
