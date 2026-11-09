import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONTROL_Z } from "./stacking";

describe("the control surface's stacking order", () => {
  it("follows tmux: a pane's modes, a popup, a menu, then the status line's prompt", () => {
    const z = CONTROL_Z;
    expect(z.panes).toBeLessThan(z.borders);
    expect(z.borders).toBeLessThan(z.cursor);
    expect(z.copy).toBeLessThan(z.chooser);
    expect(z.chooser).toBeLessThan(z.chooserPreview);
    expect(z.numbers).toBeLessThan(z.popupFrame);
    expect(z.popupFrame).toBeLessThan(z.popup);
    expect(z.popup).toBeLessThan(z.popupCursor);
    expect(z.popupCursor).toBeLessThan(z.menu);
    // A prompt raised from a shell in a popup is over the popup.
    expect(z.menu).toBeLessThan(z.prompt);
    expect(z.prompt).toBeLessThan(z.completion);
  });

  it("is the only stacking order the surface's CSS states", async () => {
    for (const name of [
      "chooser.css",
      "control.css",
      "copyMode.css",
      "menu.css",
      "popup.css",
      "prompt.css",
    ]) {
      const css = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
      for (const m of css.matchAll(/z-index:\s*([^;]+);/g))
        expect(m[1]).toMatch(/^(var\(--control-z-[a-zA-Z]+\)|-1)$/);
    }
  });
});
