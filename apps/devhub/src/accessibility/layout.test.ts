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

  it("selects a source-list row the way macOS does, not a table row", () => {
    // A saturated accent fill with inverted text is a table row. Navigation
    // gets a neutral fill, keeps its own label colour, and sets the label
    // semibold; the accent shows on the glyph alone.
    const selected =
      /\.sidebar-row\.is-selected,\s*\n\.sidebar-row\.is-selected:hover\s*\{([^}]*)\}/.exec(
        shellCss,
      );
    expect(selected?.[1]).toMatch(/background:\s*var\(--selection\);/);
    expect(selected?.[1]).toMatch(/color:\s*var\(--primary\);/);
    expect(selected?.[1]).toMatch(/font-weight:\s*590;/);
    expect(selected?.[1]).not.toMatch(/accent-ink/);
    expect(tokensCss).not.toMatch(/--selection-strong/);
    // The fill is neutral and translucent: neutral so it does not compete with
    // the glyph for the accent, translucent so the window material the Sidebar
    // exists to show still comes through it.
    expect(tokensCss).toMatch(
      /--selection:\s*light-dark\(rgba\(0, 0, 0, [\d.]+\), rgba\(255, 255, 255, [\d.]+\)\);/,
    );
    // The accent names the glyph column on every row, not only the selected
    // one, so selection must not be what turns the icons on.
    expect(shellCss).toMatch(
      /\.row-glyph svg\s*\{[^}]*stroke:\s*var\(--accent\);/,
    );
    expect(shellCss).not.toMatch(/\.is-selected[^{]*\.row-glyph svg/);
  });

  it("hangs the Sidebar's headings and glyphs off one leading rail", () => {
    // A section heading that starts left of the icons under it, or an icon
    // whose ink starts further in than its neighbour's, reads as three
    // different left edges rather than one list.
    expect(shellCss).toMatch(
      /\.sidebar-section-heading\s*\{[^}]*padding:\s*0 2px 0\s*calc\(\s*var\(--sidebar-disclosure-width\)/,
    );
    // The user agent's own `h2` metrics — 1.5em bold, 0.83em margins — would
    // both oversize the label and swallow the gap before the first row.
    expect(shellCss).toMatch(
      /\.sidebar-section-heading h2\s*\{[^}]*margin:\s*0;/,
    );
    // Heading band and row are the same height, so the step from the heading
    // to the first row is the step from one row to the next.
    expect(shellCss).toMatch(
      /\.sidebar-section-heading\s*\{[^}]*height:\s*var\(--row-height\);/,
    );
    // A row is a `div` when it discloses children and a `button` when it does
    // not, and the user agent pads only the button. Unstated, that inset takes
    // a whole row off the rail — which is what the Scratch row did.
    for (const rule of [
      /\.sidebar-row\s*\{[^}]*padding:\s*0;/,
      /\.disclosure-button,\n\.disclosure-spacer\s*\{[^}]*padding:\s*0;/,
      /\.row-action-button\s*\{[^}]*padding:\s*0;/,
      /\.section-action-button\s*\{[^}]*padding:\s*0;/,
    ]) {
      expect(shellCss).toMatch(rule);
    }
  });

  it("dims the selection on window key state, not on DOM focus", () => {
    // `:focus-within` is the wrong fact: the Editor is a sibling native
    // WebView, so working in it empties the shell's focus while the window
    // stays active, and the selection would grey out for no reason.
    expect(shellCss).not.toMatch(/focus-within/);
    expect(shellCss).toMatch(
      /:root\[data-window-active="false"\]\s*\.sidebar-row\.is-selected\s*\{[^}]*background:\s*var\(--selection-inactive\);/,
    );
    // Absent means active, so a shell the native side has not reported on yet
    // is not permanently dimmed.
    expect(shellCss).not.toMatch(/data-window-active="true"/);
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
