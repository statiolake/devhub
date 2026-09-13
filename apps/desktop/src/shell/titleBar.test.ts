/**
 * The two chromes, as the page sees them.
 *
 * `appearance.title_bar` decides how the window is built, and main is the only
 * side that can act on that — but the Sidebar's geometry depends on it just as
 * much: with no title bar the Sidebar keeps a band clear for the traffic
 * lights and its collapsed rail has to be wide enough to hold them, and with
 * one it owes the window nothing. This is the test that the two answers stay
 * two answers, and that neither of them is "the other one with a rule
 * missing".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vitest runs from the package root, and the stylesheets are files, not
// modules a test can import.
const shell = readFileSync("src/shell/styles/shell.css", "utf8");
const tokens = readFileSync("src/shell/styles/tokens.css", "utf8");
const appShell = readFileSync("src/shell/AppShell.tsx", "utf8");

/** What one selector declares a custom property to be, verbatim. */
function declared(selector: string, property: string): string | undefined {
  const block = tokens.slice(tokens.indexOf(`${selector} {`));
  const body = block.slice(0, block.indexOf("\n}"));
  const match = new RegExp(`\\n\\s*${property}:\\s*([^;]+);`).exec(body);
  return match?.[1].replace(/\s+/g, " ").trim();
}

describe("the window's two chromes", () => {
  it("is stamped on the root, and is a system title bar when nothing says otherwise", () => {
    expect(appShell).toContain(
      'data-title-bar={appearance?.titleBar ?? "system"}',
    );
  });

  it("keeps no band and no light inset with a system title bar", () => {
    expect(
      declared('.app-shell[data-title-bar="system"]', "--titlebar-reserve"),
    ).toBe("0px");
    expect(
      declared('.app-shell[data-title-bar="system"]', "--traffic-light-inset"),
    ).toBe("0px");
  });

  it("keeps the traffic lights' band, and starts past them, with none", () => {
    expect(
      declared('.app-shell[data-title-bar="hidden"]', "--titlebar-reserve"),
    ).toBe("var(--titlebar-height)");
    expect(
      declared('.app-shell[data-title-bar="hidden"]', "--traffic-light-inset"),
    ).toBe("88px");
  });

  it("collapses the Sidebar to its glyph column with a system title bar, and to the lights without one", () => {
    // The rail is a token, not a number, so what is asserted is the arithmetic
    // it stands for: the density's glyph with the leading rail on each side.
    const rail = Number(/--sidebar-rail-width: (\d+)px;/.exec(tokens)?.[1]);
    const compact = Number(
      /data-sidebar-density="compact"[^}]*--sidebar-glyph-width: (\d+)px;/s.exec(
        tokens,
      )?.[1],
    );
    const comfortable = Number(
      /data-sidebar-density="comfortable"[^}]*--sidebar-glyph-width: (\d+)px;/s.exec(
        tokens,
      )?.[1],
    );
    expect([rail, compact, comfortable]).toEqual([14, 16, 18]);
    expect(compact + 2 * rail).toBe(44);
    expect(comfortable + 2 * rail).toBe(46);
    expect(
      declared(
        '.app-shell[data-title-bar="system"]',
        "--sidebar-rail-collapsed-width",
      ),
    ).toBe(
      "calc( var(--sidebar-glyph-width) + 2 * var(--sidebar-rail-width) )",
    );
    expect(
      declared(
        '.app-shell[data-title-bar="hidden"]',
        "--sidebar-rail-collapsed-width",
      ),
    ).toBe("76px");
  });

  it("leaves the rail and the header strip reading one token each", () => {
    // Neither the rail nor the strip knows which chrome it is in: the mode is
    // answered once, in tokens.css, and every rule that follows reads a token.
    expect(shell).toContain(`.sidebar[data-collapsed="true"] {
  width: var(--sidebar-rail-collapsed-width);
  flex-basis: var(--sidebar-rail-collapsed-width);
}`);
    expect(shell).toContain(`.sidebar-header {
  display: flex;
  flex: 0 0 var(--titlebar-reserve);
  align-items: center;
  padding: 0 var(--space-2) 0 var(--traffic-light-inset);
  height: var(--titlebar-reserve);
}`);
  });

  it("makes the Sidebar a drag handle only when the window has no bar of its own", () => {
    expect(shell).toContain(`.app-shell[data-title-bar="hidden"] .sidebar {
  -webkit-app-region: drag;
}`);
    expect(shell).not.toMatch(/\n\.sidebar \{\n\s*-webkit-app-region: drag;/);
  });

  it("names neither chrome's geometry at the root, where it could apply to both", () => {
    const root = tokens.slice(tokens.indexOf(":root {"));
    const body = root.slice(0, root.indexOf("\n}"));
    expect(body).not.toContain("--traffic-light-inset:");
    expect(body).not.toContain("--sidebar-rail-collapsed-width:");
    expect(body).not.toContain("--titlebar-reserve:");
  });
});
