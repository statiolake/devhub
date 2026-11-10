// @vitest-environment jsdom

/**
 * A footer on the page: its tree's line and slots drawn, a press on it
 * Neovim's unless a node takes it, and its place while its window moves.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ComponentTree, type ComponentTheme } from "./ComponentView";
import { parseHlTable, parseNode } from "./components";
import { GUI_OWNED } from "./mouse";
import { placeFooter } from "./windowMotion";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function render(node: unknown, slots: ComponentTheme["slots"]): HTMLElement {
  const parsed = parseNode(node);
  if (!parsed) throw new Error("not a node");
  const host = document.createElement("div");
  host.className = "nvim-footer";
  const tree = document.createElement("div");
  tree.className = "nvim-footer-tree";
  host.append(tree);
  document.body.append(host);
  const theme: ComponentTheme = {
    hl: parseHlTable({
      Comment: { fg: 0x808080, italic: true },
      StatusLine: { fg: 0x333333, bg: 0x111111 },
    }),
    fg: 0xffffff,
    bg: 0,
    dark: true,
    mono: "monospace",
    openLink: () => undefined,
    onAction: () => undefined,
    slots,
  };
  act(() => {
    createRoot(tree).render(<ComponentTree node={parsed} theme={theme} />);
  });
  return host;
}

describe("a footer's tree", () => {
  it("fills its slots from the redraw, and draws a line in its group's ink", () => {
    const el = render(
      {
        type: "hstack",
        children: [
          { type: "line", grow: true, hl: "StatusLine" },
          { type: "slot", slot: "mode" },
          {
            type: "slot",
            slot: "position",
            format: "%l:%c",
            hl: "Comment",
            ink: true,
          },
          { type: "slot", slot: "showcmd" },
          {
            type: "hstack",
            bg: "StatusLine",
            round: true,
            pad: [0, 6],
            children: ["a.ts"],
          },
        ],
      },
      {
        position: { curline: 9, curcol: 2, lineCount: 50 },
        mode: "insert",
        showcmd: "2d",
      },
    );
    const line = el.querySelector<HTMLElement>(".nvc-line");
    expect(line?.style.getPropertyValue("--nvc-line")).toBe("rgb(51 51 51)");
    expect(line?.style.flexGrow).toBe("1");
    expect(el.querySelector(".nvc-slot-mode")?.textContent).toBe("INSERT");
    const pos = el.querySelector<HTMLElement>(".nvc-slot-position");
    expect(pos?.textContent).toBe("10:3");
    // ink: Comment's colour, not its slant.
    expect(pos?.style.color).toBe("rgb(128, 128, 128)");
    expect(pos?.style.fontStyle).toBe("");
    expect(el.querySelector(".nvc-slot-showcmd")?.textContent).toBe("2d");
    const chip = el.querySelectorAll<HTMLElement>(".nvc-hstack")[1];
    expect(chip?.style.borderRadius).toBe("4px");
    expect(chip?.style.background).toBe("rgb(17, 17, 17)");
  });

  it("leaves a slot blank without a value (another window's mode)", () => {
    const el = render(
      { type: "hstack", children: [{ type: "slot", slot: "mode" }] },
      { mode: undefined },
    );
    expect(el.querySelector(".nvc-slot-mode")?.textContent).toBe("");
  });
});

describe("a press on a footer", () => {
  it("is Neovim's (grid 1's cell) unless a node with on_click takes it", () => {
    const el = render(
      {
        type: "hstack",
        children: [
          { type: "line", grow: true },
          { type: "text", text: "a.ts", action: 1 },
        ],
      },
      undefined,
    );
    const line = el.querySelector(".nvc-line");
    const clickable = el.querySelector("[data-action]");
    expect(line?.closest(GUI_OWNED)).toBeNull();
    expect(el.closest(GUI_OWNED)).toBeNull();
    expect(clickable?.closest(GUI_OWNED)).not.toBeNull();
  });
});

describe("a footer while its window moves", () => {
  it("is at its clip's foot and as wide as the clip", () => {
    const el = document.createElement("div");
    // The surface is 800 × 600; the clip is 100…500 across, its foot at 300.
    placeFooter(
      el,
      { left: 100, right: 500, bottom: 300 },
      { width: 800, height: 600 },
      17,
    );
    expect(el.style.width).toBe("400px");
    // In the clip's inner element, whose bottom right is the clip's
    // (800 × 600, its origin at 500 − 800, 300 − 600): from x 100, row 283.
    expect(el.style.transform).toBe("translate(400px, 583px)");
    const origin = { x: 500 - 800, y: 300 - 600 };
    expect(origin.x + 400).toBe(100);
    expect(origin.y + 583).toBe(283);
  });
});
