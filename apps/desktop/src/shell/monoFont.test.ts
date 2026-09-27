// @vitest-environment jsdom

/**
 * DevHub's one monospace face is the terminal's.
 *
 * There is no second setting: `[appearance] terminal_font_family` is what
 * xterm draws with, and it is what every fixed-width line in DevHub's own
 * pages is set in — a GUI Agent's code blocks, diffs and command output
 * included. Every stylesheet reads `--font-mono`; the page sets it from the
 * appearance and keeps it current. What this pins is both halves: the variable
 * is fed from the setting, live, and no stylesheet names a monospace family of
 * its own that the setting would never reach.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppAppearance } from "../ipc/appShell";
import { defaultAppearance } from "../model/config";
import { applyMonoFont, installMonoFont } from "./appearance";
import { terminalFontStack } from "./terminal/theme";

// Vitest runs from the package root, and the stylesheets are files, not
// modules a test can import.
const read = (path: string): string => readFileSync(path, "utf8");

function sources(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path, extensions);
    return extensions.some((extension) => name.endsWith(extension))
      ? [path]
      : [];
  });
}

const mono = () =>
  document.documentElement.style.getPropertyValue("--font-mono");

function appearance(sequence: number, family: string): AppAppearance {
  return { sequence, terminalFontFamily: family } as AppAppearance;
}

/** A page's bridge with the appearance on it, pushed by hand. */
function stubBridge(initial: AppAppearance) {
  const listeners = new Set<(next: AppAppearance) => void>();
  window.devhub = {
    getAppearance: () => Promise.resolve(initial),
    onAppearance: (listener: (next: AppAppearance) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    push: (next: AppAppearance) => {
      for (const listener of listeners) listener(next);
    },
    listening: () => listeners.size,
  };
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete window.devhub;
});

describe("the monospace family", () => {
  it("is the terminal's stack, the configured family first", () => {
    applyMonoFont(document.documentElement, "Example Mono");
    expect(mono()).toBe(terminalFontStack("Example Mono"));
    expect(mono().startsWith('"Example Mono"')).toBe(true);
  });

  it("is read from the appearance and follows every change to it", async () => {
    const bridge = stubBridge(appearance(1, "Example Mono"));
    const dispose = installMonoFont(document);

    await expect.poll(mono).toBe(terminalFontStack("Example Mono"));

    bridge.push(appearance(2, "Other Mono"));
    expect(mono()).toBe(terminalFontStack("Other Mono"));

    // An answer older than one already applied does not undo it.
    bridge.push(appearance(1, "Example Mono"));
    expect(mono()).toBe(terminalFontStack("Other Mono"));

    dispose();
    expect(bridge.listening()).toBe(0);
  });

  it("is installed on every page that draws monospace text from the appearance", () => {
    for (const page of [
      "src/shell/main.tsx",
      "src/shell/sidebar/main.tsx",
      "src/shell/agents/main.tsx",
      "src/shell/picker/main.tsx",
    ]) {
      expect(read(page), page).toMatch(/^installMonoFont\(document\);$/m);
    }
    // Settings is its own window with its own config: it applies the family
    // DevHub is on from its snapshot (see `settings/fontField.test.tsx`).
    expect(read("src/settings/SettingsApp.tsx")).toContain(
      "applyMonoFont(document.documentElement, monoFamily)",
    );
  });

  it("is declared at the default setting's stack before a page is told", () => {
    const tokens = read("src/shell/styles/tokens.css");
    const declared = /\n\s*--font-mono:\s*([^;]+);/.exec(tokens)?.[1];
    expect(declared).toBe(
      terminalFontStack(defaultAppearance().terminalFontFamily),
    );
  });

  it("is the only monospace family any DevHub stylesheet names", () => {
    for (const path of sources("src", [".css"])) {
      // Declarations, not the prose around them.
      const css = read(path).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, value] of css.matchAll(/font-family:\s*([^;]+);/g)) {
        const family = value.replace(/\s+/g, " ").trim();
        expect(
          family === "var(--font-mono)" ||
            family === "inherit" ||
            !/mono|Menlo|Consolas|Courier/i.test(family),
          `${path}: font-family: ${family}`,
        ).toBe(true);
      }
      const outsideTheToken = css.replace(/\n\s*--font-mono:[^;]+;/, "");
      expect(outsideTheToken, path).not.toMatch(/monospace/);
    }
  });

  it("is never spelled inline by a component", () => {
    for (const path of sources("src/shell", [".tsx"]).concat(
      sources("src/settings", [".tsx"]),
    )) {
      if (path.endsWith(".test.tsx")) continue;
      expect(read(path), path).not.toMatch(/fontFamily\s*:/);
    }
  });
});
