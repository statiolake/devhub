// @vitest-environment jsdom

/**
 * A list in a popup (`stack{ band }`, a completion menu's): everything in
 * the popup sits the floats' band inset from the popup's line on all four
 * sides, the band rounded by the rest of the corner (`neovim.css`, the
 * popup). DevHub adds no cell inline: each part's own pad sets how far its
 * content is past that, across as down, so the text is as far from the
 * line at the sides as above and below. The anchor, not a padding, puts a
 * list's words under the word typed.
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
  it("insets everything by the band inset, on all four sides alike", () => {
    const body = rule(css(), ".nvim-popup-body:has(.nvc-banded)");
    expect(body).toMatch(/^\s*padding:\s*var\(--float-band-inset\);\s*$/);
    // no cell of DevHub's own across, reached out of and padded back in
    expect(css()).not.toContain("--nvc-bleed");
  });

  it("rounds its band by the rest of the popup's corner", () => {
    expect(rule(css(), ".nvim-popup .nvc-band")).toMatch(
      /border-radius:\s*calc\(var\(--float-radius\) - var\(--float-band-inset\)\);/,
    );
  });

  it("pads its content by its own pad alone, across as down", () => {
    const node = tree({
      type: "stack",
      band: "PmenuSel",
      selected: 1,
      pad: [1, 2],
      children: [{ type: "text", text: "useState" }],
    });
    const { container } = render(<ComponentTree node={node} theme={theme} />);
    const list = container.querySelector<HTMLElement>(".nvc-banded");
    expect(list?.style.padding).toBe("1px 2px");
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
