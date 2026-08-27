import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const shellCss = readFileSync(
  resolve(process.cwd(), "src/styles/shell.css"),
  "utf8",
);
const settingsCss = readFileSync(
  resolve(process.cwd(), "src/settings/settings.css"),
  "utf8",
);
const tokensCss = readFileSync(
  resolve(process.cwd(), "src/styles/tokens.css"),
  "utf8",
);

describe("accessibility layout invariants", () => {
  it("keeps the shell surface filling the available window", () => {
    expect(shellCss).toMatch(
      /\.app-shell-content\s*\{[\s\S]*?display:\s*flex;[\s\S]*?min-height:\s*0;[\s\S]*?flex:\s*1;/,
    );
    expect(shellCss).toMatch(/\.workbench\s*\{[\s\S]*?min-height:\s*0;/);
  });

  it("runs the navigation pane the full height of the window", () => {
    expect(shellCss).not.toMatch(/--radius-shell/);
    // The Sidebar is a peer of the content column, not a child of a row
    // below the titlebar, so the window buttons sit on the navigation pane.
    const content = /\.app-shell-content\s*\{([^}]*)\}/.exec(shellCss);
    expect(content?.[1]).toMatch(/display:\s*flex;/);
    expect(content?.[1]).not.toMatch(/flex-direction/);
    expect(shellCss).toMatch(
      /\.workbench\s*\{[\s\S]*?flex-direction:\s*column;/,
    );
  });

  it("divides the titlebar band from the panes it sits between", () => {
    expect(shellCss).toMatch(
      /\.titlebar\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--line-strong\);/,
    );
    expect(shellCss).toMatch(
      /\.sidebar\s*\{[\s\S]*?border-right:\s*1px solid var\(--line-strong\);/,
    );
    // Both strips have to be the same height or the band reads as a step.
    expect(shellCss).toMatch(
      /\.sidebar-titlebar\s*\{[\s\S]*?height:\s*var\(--titlebar-height\);/,
    );
  });

  it("reserves the Sidebar's leading edge for the traffic lights", () => {
    expect(shellCss).toMatch(
      /\.sidebar-titlebar\s*\{[\s\S]*?min-width:\s*var\(--traffic-light-inset\);/,
    );
    const inset = /--traffic-light-inset:\s*(\d+)px/.exec(tokensCss);
    expect(inset).not.toBeNull();
    // Three 14pt buttons on 20pt centres from a 20pt leading inset.
    expect(Number(inset?.[1])).toBeGreaterThanOrEqual(20 + 20 * 2 + 14);
  });

  it("reads as an application rather than a document", () => {
    // An I-beam wandering over labels and a drag that selects the chrome are
    // the two things that give a web shell away on the desktop.
    // Declared on every element, not inherited from the root: a UA rule on a
    // form control beats an inherited value, so the switcher's own labels
    // would stay selectable if this were set on `:root` alone.
    const universal = /\*,\s*\n\*::before,\s*\n\*::after\s*\{([^}]*)\}/.exec(
      tokensCss,
    );
    expect(universal?.[1]).toMatch(/user-select:\s*none;/);
    expect(tokensCss).toMatch(/:root\s*\{[^}]*cursor:\s*default;/);
    // Errors are meant to be pasted somewhere, so they keep selection.
    expect(tokensCss).toMatch(
      /\.failure-detail,[\s\S]*?\{[^}]*user-select:\s*text;/,
    );
  });

  it("uses responsive fixed-size controls without a narrow grid track", () => {
    expect(shellCss).toMatch(
      /\.workspace-picker\s*\{[\s\S]*?position:\s*fixed;/,
    );
    // Native macOS control height, not a touch target: the shell is a desktop
    // app, and the padding keeps the hit area comfortable under text zoom.
    expect(shellCss).toMatch(
      /\.primary-button,\s*\n\.secondary-button\s*\{[\s\S]*?min-height:\s*28px;/,
    );
    expect(settingsCss).toMatch(
      /\.settings-argv-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 40px 40px 40px;/,
    );
    expect(settingsCss).toMatch(
      /\.settings-env-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 0\.8fr\) minmax\(0, 1\.2fr\) 40px;/,
    );
  });

  it("defines every semantic token used by provider shell surfaces", () => {
    expect(tokensCss).toMatch(/--surface:\s*light-dark\(/);
    expect(tokensCss).toMatch(/--radius-panel:\s*10px/);
    expect(tokensCss).toMatch(/--font-mono:/);
  });
});
