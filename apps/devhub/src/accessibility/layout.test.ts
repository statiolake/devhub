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

  it("keeps the navigation and content islands on one geometry contract", () => {
    expect(shellCss).toMatch(
      /\.workbench\s*\{[\s\S]*?padding:\s*var\(--space-2\);[\s\S]*?gap:\s*var\(--space-2\);/,
    );
    expect(shellCss).toMatch(
      /\.sidebar\s*\{[\s\S]*?border-radius:\s*var\(--radius-shell\);/,
    );
    expect(shellCss).toMatch(
      /\.surface\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?border-radius:\s*var\(--radius-shell\);/,
    );
    expect(tokensCss).toMatch(/--radius-shell:\s*12px/);
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
