/**
 * The two chromes, as the page sees them.
 *
 * The window is the same window in both — `titleBarStyle: "hiddenInset"`, a
 * transparent native bar with the traffic lights inset — so `appearance
 * .title_bar` is acted on *here* and nowhere else. With `shown` DevHub draws
 * its own bar across the top of the window and the Sidebar owes the window
 * nothing; with `hidden` there is no bar and the Sidebar keeps the lights'
 * band clear itself, with a rail wide enough to hold them.
 *
 * The band the lights sit in belongs to the *window's own page* in both, and
 * that is the one thing the two chromes are not free to differ about: a drag
 * region is collected from the window's own web contents, and whether one
 * declared inside a `WebContentsView` composes into the same handle is not
 * something this codebase can check. So with `shown` the band is the bar and
 * with `hidden` it is `.window-drag-strip`, and the Sidebar's *view* starts
 * under it either way (`main/shell/windowLayout.ts`, `sidebarRect`).
 *
 * This is the test that the two answers stay two answers, and that neither of
 * them is "the other one with a rule missing".
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
  it("is stamped on the root, and is a bar DevHub draws when nothing says otherwise", () => {
    expect(appShell).toContain(
      'data-title-bar={appearance?.titleBar ?? "shown"}',
    );
  });

  it("puts the bar above both the Sidebar and the content area", () => {
    // Order in the flow *is* the geometry: `.app-shell` is a column, so a bar
    // written before `.app-shell-content` is a bar the Sidebar and the
    // workbench hole both start below. Nothing measures or offsets anything.
    expect(appShell.indexOf("<TitleBar")).toBeGreaterThan(0);
    expect(appShell.indexOf("<TitleBar")).toBeLessThan(
      appShell.indexOf('<div className="app-shell-content">'),
    );
  });

  it("draws the bar, and no band on the Sidebar, with one", () => {
    expect(
      declared('.app-shell[data-title-bar="shown"]', "--titlebar-bar"),
    ).toBe("var(--titlebar-height)");
    expect(
      declared('.app-shell[data-title-bar="shown"]', "--traffic-light-inset"),
    ).toBe("0px");
  });

  it("draws no bar, and a drag strip of its own instead, with none", () => {
    expect(
      declared('.app-shell[data-title-bar="hidden"]', "--titlebar-bar"),
    ).toBe("0px");
    expect(
      declared('.app-shell[data-title-bar="hidden"]', "--traffic-light-inset"),
    ).toBe("88px");
  });

  it("gives the bar the height the lights are placed for, and the room they take", () => {
    // Both are measurements of the same window — `hiddenInset` puts the lights
    // in the same place whichever chrome is up — so both are at the root, once.
    expect(/--titlebar-height: (\d+)px;/.exec(tokens)?.[1]).toBe("38");
    expect(/--traffic-light-span: (\d+)px;/.exec(tokens)?.[1]).toBe("76");
    expect(shell).toContain("height: var(--titlebar-bar);");
    expect(shell).toContain(
      "padding: 0 var(--space-3) 0 var(--traffic-light-span);",
    );
  });

  it("centres the name on the window, between two insets of the same size", () => {
    // Equal ends is the whole of what centring on the *window* means here: the
    // middle of what is between them is the middle of the window, whether or
    // not the trailing end has anything in it.
    expect(
      declared(
        '.app-shell[data-title-bar="shown"]',
        "--titlebar-controls-inset",
      ),
    ).toBe(
      "calc( var(--traffic-light-span) + var(--space-2) + var(--titlebar-control-size) + var(--space-3) )",
    );
    expect(shell).toMatch(
      /\.title-bar-name \{[^}]*right: var\(--titlebar-controls-inset\);[^}]*left: var\(--titlebar-controls-inset\);/s,
    );
  });

  it("makes the bar the handle, and its one control not part of it", () => {
    expect(shell).toMatch(/\.title-bar \{[^}]*-webkit-app-region: drag;/s);
    expect(shell).toMatch(
      /\.title-bar-button \{[^}]*-webkit-app-region: no-drag;/s,
    );
    // The name is not a control, but it must not swallow the drag either.
    expect(shell).toMatch(/\.title-bar-name \{[^}]*pointer-events: none;/s);
  });

  it("takes the bar out of the page entirely in the other chrome", () => {
    // Not a bar of zero height: a control nobody can see and everybody can tab
    // to is worse than no control.
    expect(shell).toContain(`.app-shell[data-title-bar="hidden"] .title-bar {
  display: none;
}`);
  });

  it("gives the bar the Sidebar's surface, by the Sidebar's own rule", () => {
    // Written the same way, so the two cannot come apart: transparent over the
    // window's material, painted `--chrome` when there is no material to show.
    // A colour of its own would be a seam in whichever case it did not match.
    expect(shell).toMatch(/\.title-bar \{[^}]*background: transparent;/s);
    expect(shell).toContain(`:root[data-window-material="none"] .title-bar {
  background: var(--chrome);
}`);
    expect(shell).toContain(`@media (prefers-reduced-transparency: reduce) {
  .title-bar {
    background: var(--chrome);
  }
}`);
  });

  it("draws its one hairline where chrome meets content, and nowhere else", () => {
    // On the content area's top edge, not the bar's bottom one: the bar and
    // the Sidebar are one surface, and a line between them would cut it.
    expect(shell)
      .toContain(`.app-shell[data-title-bar="shown"] .app-shell-content .surface {
  border-top: 1px solid var(--line-strong);
}`);
    expect(shell).not.toMatch(/\.title-bar \{[^}]*border-bottom:/s);
    expect(shell).not.toMatch(/\.title-bar \{[^}]*border-radius:/s);
  });

  it("collapses the Sidebar to its glyph column with a bar, and to the lights without one", () => {
    // The margin is a token, not a number, so what is asserted is the
    // arithmetic it stands for: the density's glyph with a step on each side.
    const step = Number(/--space-3: (\d+)px;/.exec(tokens)?.[1]);
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
    expect([step, compact, comfortable]).toEqual([12, 16, 18]);
    expect(compact + 2 * step).toBe(40);
    expect(comfortable + 2 * step).toBe(42);
    expect(
      declared(
        '.app-shell[data-title-bar="shown"]',
        "--sidebar-rail-collapsed-width",
      ),
    ).toBe("calc( var(--sidebar-glyph-width) + 2 * var(--space-3) )");
    // The rail with no bar is the lights' span, said once at the root and read
    // here rather than written out a second time.
    expect(
      declared(
        '.app-shell[data-title-bar="hidden"]',
        "--sidebar-rail-collapsed-width",
      ),
    ).toBe("var(--traffic-light-span)");
  });

  it("leaves the rail reading one token, whichever chrome it is in", () => {
    // The rail does not know which chrome it is in: the mode is answered once,
    // in tokens.css, and every rule that follows reads a token.
    expect(shell).toContain(`.sidebar[data-collapsed="true"] {
  width: var(--sidebar-rail-collapsed-width);
  flex-basis: var(--sidebar-rail-collapsed-width);
}`);
  });

  /**
   * The handle is the window's page's in both chromes, and the Sidebar's in
   * neither.
   *
   * It used to be `-webkit-app-region: drag` on the Sidebar pane with an
   * opt-out for everything in it that does something — a rule the next control
   * added to the Sidebar would have had to remember, and one that also carried
   * "a scrollbar inside a drag rectangle moves the window". Both are gone: the
   * Sidebar is a `WebContentsView`, a drag region is collected from the
   * window's own contents, and this document is those contents.
   */
  it("keeps the drag region on the window's own page, in both chromes", () => {
    expect(shell).toContain(
      `.app-shell[data-title-bar="hidden"] .window-drag-strip {`,
    );
    expect(shell).toMatch(
      /\.app-shell\[data-title-bar="hidden"\] \.window-drag-strip \{[^}]*-webkit-app-region: drag;/s,
    );
    expect(appShell).toContain('<div className="window-drag-strip"');
    // Nothing in the Sidebar declares one, in either chrome.
    expect(shell).not.toMatch(
      /\.sidebar[^{]*\{[^}]*-webkit-app-region: drag;/s,
    );
  });

  it("names neither chrome's geometry at the root, where it could apply to both", () => {
    const root = tokens.slice(tokens.indexOf(":root {"));
    const body = root.slice(0, root.indexOf("\n}"));
    expect(body).not.toContain("--traffic-light-inset:");
    expect(body).not.toContain("--sidebar-rail-collapsed-width:");
    expect(body).not.toContain("--titlebar-bar:");
  });
});
