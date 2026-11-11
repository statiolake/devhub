// @vitest-environment jsdom

/**
 * A list in a popup (`stack{ band }`, a completion menu's): its band sits
 * the floats' band inset from the popup's line on all four sides, rounded
 * by the rest of the corner, and a pane under it lines up with it
 * (`neovim.css`, the popup). The rows' content stays where it was, so a
 * list's words still start under the word typed.
 */

import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComponentTree, type ComponentTheme } from "./ComponentView";
import { parseNode, type ComponentNode } from "./components";

/** A tree as the page parses it. */
function tree(raw: unknown): ComponentNode {
  const node = parseNode(raw);
  if (!node) throw new Error("not a tree");
  return node;
}

afterEach(cleanup);

function css(): string {
  return readFileSync("src/shell/neovim/neovim.css", "utf8");
}

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const open = source.indexOf("{", at);
  return source.slice(open + 1, source.indexOf("}", open));
}

const theme: ComponentTheme = {
  hl: new Map(),
  fg: 0x000000,
  bg: 0xffffff,
  dark: false,
  mono: "monospace",
  openLink: () => undefined,
  onAction: () => undefined,
};

describe("a list in a popup", () => {
  it("insets its band by the band inset above and below as at the sides", () => {
    const source = css();
    expect(rule(source, ".nvim-popup-body:has(.nvc-banded)")).toMatch(
      /padding-block:\s*var\(--float-band-inset\);/,
    );
    // out from the body's cell to the band inset, a pane alike
    const bleed = rule(
      source,
      ".nvim-popup .nvc-banded,\n.nvim-popup .nvc-pane",
    );
    expect(bleed).toMatch(
      /--nvc-bleed:\s*calc\(var\(--float-cell, 1ch\) - var\(--float-band-inset\)\);/,
    );
    expect(bleed).toMatch(/margin-inline:\s*calc\(-1 \* var\(--nvc-bleed\)\);/);
  });

  it("rounds its band by the rest of the popup's corner", () => {
    expect(rule(css(), ".nvim-popup .nvc-band")).toMatch(
      /border-radius:\s*calc\(var\(--float-radius\) - var\(--float-band-inset\)\);/,
    );
  });

  it("pads its content back in by the bleed, over the rows' own pad", () => {
    const node = tree({
      type: "stack",
      band: "PmenuSel",
      selected: 1,
      pad: [1, 4],
      children: [{ type: "text", text: "useState" }],
    });
    const { container } = render(<ComponentTree node={node} theme={theme} />);
    const list = container.querySelector<HTMLElement>(".nvc-banded");
    expect(list?.getAttribute("style")).toContain(
      "padding: 1px calc(4px + var(--nvc-bleed, 0px))",
    );
  });

  it("puts the band on the selected row's own top and height, unrounded", () => {
    const node = tree({
      type: "stack",
      band: "PmenuSel",
      selected: 2,
      children: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    });
    const rect = (top: number, height: number) =>
      ({ top, height, width: 200, left: 0 }) as DOMRect;
    const proto = HTMLElement.prototype;
    const original = proto.getBoundingClientRect;
    const offsetWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
    proto.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("nvc-banded")) return rect(100, 42.66);
      // the second row: 21.33 down, 21.33 tall
      if (this.textContent === "two") return rect(121.33, 21.33);
      return rect(100, 21.33);
    };
    Object.defineProperty(proto, "offsetWidth", {
      configurable: true,
      get: () => 200,
    });
    try {
      const { container } = render(<ComponentTree node={node} theme={theme} />);
      const band = container.querySelector<HTMLElement>(".nvc-band");
      expect(band?.style.transform).toBe(
        `translateY(${String(121.33 - 100)}px)`,
      );
      expect(band?.style.height).toBe("21.33px");
    } finally {
      proto.getBoundingClientRect = original;
      if (offsetWidth) Object.defineProperty(proto, "offsetWidth", offsetWidth);
    }
  });
});
