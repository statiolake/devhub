import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * A view's sticky items (`gui.view`, `layers.css`): held at the top with the
 * rows scrolling under them, so nothing of those rows may show round them
 * or through them.
 */
async function rule(selector: string): Promise<string> {
  const css = await readFile(new URL("./layers.css", import.meta.url), "utf8");
  const at = css.lastIndexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf("}", at));
}

describe("a view's sticky items", () => {
  it("lie on the view's own ground, opaque, over its padding and margins", async () => {
    const ground = await rule(".nvim-view-sticky::before");
    expect(ground).toMatch(/background:\s*var\(--nvim-ground\);/);
    expect(ground).not.toMatch(/color-mix|opacity|backdrop|transparent|rgba/);
    // up over the scroll's padding, out over the item's margins
    expect(ground).toMatch(
      /inset:\s*calc\(-1 \* var\(--nvim-view-scroll-pad, 0px\)\) -6px 0;/,
    );
    const item = await rule(".nvim-view-item");
    expect(item).toMatch(/margin:\s*0 6px;/);
    const scroll = await rule(".nvim-view-scroll");
    expect(scroll).toMatch(/padding:\s*var\(--nvim-view-scroll-pad\) 0;/);
  });

  it("draw the focus and Visual's band over that ground, not under it", async () => {
    const sticky = await rule(".nvim-view-item.nvim-view-sticky");
    expect(sticky).toMatch(/z-index:\s*1;/);
    expect(await rule(".nvim-view-sticky::before")).toMatch(/z-index:\s*-2;/);
    expect(await rule(".nvim-view-sticky::after")).toMatch(/z-index:\s*-1;/);
    expect(await rule(".nvim-view-sticky.nvim-view-focused::after")).toMatch(
      /background:\s*var\(--nvim-cursorline\);/,
    );
    expect(await rule(".nvim-view-sticky.nvim-view-selected::after")).toMatch(
      /background:\s*var\(--nvim-visual\);/,
    );
  });
});
