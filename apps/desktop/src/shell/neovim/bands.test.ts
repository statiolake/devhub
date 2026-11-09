import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The editor's stacking bands (`neovim.css`, docs/rendering-layers.md):
 * DevHub's own over Neovim's grids, each a stacking context of its own, so
 * a float's zindex orders floats and nothing else.
 */
async function css(): Promise<string> {
  return readFile(new URL("./neovim.css", import.meta.url), "utf8");
}

function bands(source: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of source.matchAll(/--nvim-band-([a-z]+):\s*(-?\d+);/g)) {
    out.set(m[1] ?? "", Number(m[2]));
  }
  return out;
}

describe("the editor's bands", () => {
  it("stack DevHub's own over every float, in a declared order", async () => {
    const b = bands(await css());
    const order = (names: string[]) =>
      names.map((n) => {
        const z = b.get(n);
        if (z === undefined) throw new Error(`no band ${n}`);
        return z;
      });
    const inHost = order([
      "editor",
      "popup",
      "cmdwin",
      "cmdline",
      "menu",
      "preedit",
    ]);
    expect([...inHost].sort((x, y) => x - y)).toEqual(inHost);
    expect(new Set(inHost).size).toBe(inHost.length);
    const surface = order(["host", "toasts", "status"]);
    expect([...surface].sort((x, y) => x - y)).toEqual(surface);
    expect(new Set(surface).size).toBe(surface.length);
  });

  it("are the only stacking orders the editor's own CSS states", async () => {
    // A number would put an overlay back in one space with the floats'
    // 100 + zindex; inside an element's own stacking context -1 is local.
    for (const m of (await css()).matchAll(/z-index:\s*([^;]+);/g)) {
      expect(m[1]).toMatch(/^(var\(--nvim-band-[a-z]+\)|-1)$/);
    }
  });
});
