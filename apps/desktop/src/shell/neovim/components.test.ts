import { describe, expect, it } from "vitest";
import {
  actionsOf,
  barRects,
  clampScroll,
  linePoints,
  markPieces,
  parseHlTable,
  parseNode,
  revealScroll,
  rowsFor,
  wheelFocus,
  withSelected,
} from "./components";

describe("a list, a pane, a small badge, an anchored node", () => {
  it("parses a column's selection and band, a pane, a badge's size, anchor", () => {
    const node = parseNode({
      type: "stack",
      children: [
        {
          type: "stack",
          band: "PmenuSel",
          selected: 2,
          children: [
            {
              type: "hstack",
              selected: 1,
              children: [
                { type: "badge", text: "f", size: "sm" },
                { type: "text", text: "useState", anchor: true },
              ],
            },
          ],
        },
        { type: "stack", pane: "doc", max_height: 9999, children: [] },
      ],
    });
    expect(node).toMatchObject({
      children: [
        {
          band: "PmenuSel",
          selected: 2,
          children: [
            {
              type: "hstack",
              children: [
                { type: "badge", size: "sm" },
                { type: "text", anchor: true },
              ],
            },
          ],
        },
        { pane: "doc", maxHeight: 4000 },
      ],
    });
    // A row is not a list: no selection on an hstack.
    const row =
      node?.type === "stack" && node.children[0]?.type === "stack"
        ? node.children[0].children[0]
        : undefined;
    expect(row && "selected" in row).toBe(false);
  });

  it("moves the first banded column's selection, and keeps a tree it leaves", () => {
    const list = {
      type: "stack" as const,
      band: "PmenuSel",
      selected: 1,
      children: [],
    };
    const tree = {
      type: "stack" as const,
      children: [{ type: "text" as const, runs: [] }, list],
    };
    const moved = withSelected(tree, 2);
    expect(moved).not.toBe(tree);
    expect(moved.type === "stack" && moved.children[1]).toEqual({
      ...list,
      selected: 2,
    });
    expect(moved.type === "stack" && moved.children[0]).toBe(tree.children[0]);
    expect(withSelected(tree, 1)).toBe(tree);
    const plain = { type: "stack" as const, children: [] };
    expect(withSelected(plain, 3)).toBe(plain);
  });
});

describe("declarative components from Lua", () => {
  it("takes a tree of known nodes and drops what is not one", () => {
    const node = parseNode({
      type: "stack",
      gap: 4,
      pad: [6, 12],
      card: true,
      accent: "Keyword",
      children: [
        "plain",
        {
          type: "hstack",
          children: [{ type: "badge", text: "agent", hl: "Keyword" }],
        },
        { type: "script", src: "alert(1)" },
        { type: "image", src: "javascript:alert(1)" },
        { type: "image", src: "data:image/png;base64,AA" },
        { type: "checkbox", state: "mixed" },
        { type: "progress", value: 7 },
        {
          type: "text",
          runs: ["a", { text: "b", hl: "Comment", mono: true }, 3],
        },
      ],
    });
    expect(node).toMatchObject({
      type: "stack",
      gap: 4,
      pad: [6, 12],
      card: true,
      accent: "Keyword",
    });
    if (node?.type !== "stack") throw new Error("not a stack");
    expect(node.children.map((c) => c.type)).toEqual([
      "text",
      "hstack",
      "image",
      "checkbox",
      "progress",
      "text",
    ]);
    expect(node.children[3]).toMatchObject({ state: "mixed" });
    expect(node.children[4]).toMatchObject({ value: 1 });
    expect(node.children[5]).toMatchObject({
      runs: [{ text: "a" }, { text: "b", hl: "Comment", mono: true }],
    });
  });

  it("reads an empty Lua table as an empty list, and stops at a depth", () => {
    expect(parseNode({ type: "hstack", children: {} })).toMatchObject({
      children: [],
    });
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) deep = { type: "stack", children: [deep] };
    let node = parseNode(deep);
    let depth = 0;
    while (node?.type === "stack" && node.children[0]) {
      node = node.children[0];
      depth += 1;
    }
    expect(depth).toBeLessThan(26);
  });

  it("collects the actions a tree's clicks run", () => {
    const node = parseNode({
      type: "hstack",
      action: 1,
      children: [
        { type: "button", text: "Reply", action: 2 },
        { type: "text", text: "x" },
      ],
    });
    expect(node && actionsOf(node)).toEqual([1, 2]);
  });

  it("resolves highlight groups to 24-bit colours and flags", () => {
    const hl = parseHlTable({
      Comment: { fg: 0x808080, italic: true },
      Bad: 3,
      Normal: {},
    });
    expect(hl.get("Comment")).toMatchObject({ fg: 0x808080, italic: true });
    expect(hl.get("Normal")).toMatchObject({ fg: undefined });
    expect(hl.has("Bad")).toBe(false);
  });
});

describe("layout decisions", () => {
  it("reserves the rows a card takes, a hair over a row not being one", () => {
    expect(rowsFor(100, 20)).toBe(5);
    expect(rowsFor(100.4, 20)).toBe(5);
    expect(rowsFor(101, 20)).toBe(6);
    expect(rowsFor(0, 20)).toBe(1);
    expect(rowsFor(10_000, 20)).toBe(200);
  });

  it("keeps the focused item in sight, moving as little as it can", () => {
    // In view: stays.
    expect(revealScroll(100, 300, 150, 40)).toBe(100);
    // Above: its top (with the margin) comes to the top.
    expect(revealScroll(100, 300, 60, 40)).toBe(52);
    // Below: its bottom comes to the bottom.
    expect(revealScroll(0, 300, 320, 40)).toBe(68);
    // Taller than the view: its top.
    expect(revealScroll(0, 100, 400, 300)).toBe(392);
    expect(clampScroll(900, 1000, 300)).toBe(700);
    expect(clampScroll(-5, 1000, 300)).toBe(0);
  });

  it("takes the cursor along when the wheel moves its item out of view", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      top: i * 30,
      height: 30,
    }));
    // Still partly in view: stays.
    expect(wheelFocus(items, 2, 70, 200)).toBe(2);
    // Scrolled down past it: the first item wholly in view.
    expect(wheelFocus(items, 2, 100, 200)).toBe(4);
    // Scrolled up past it: the last one wholly in view.
    expect(wheelFocus(items, 15, 100, 200)).toBe(9);
  });

  it("draws a sparkline in its box", () => {
    expect(linePoints([0, 5, 10], 100, 20)).toEqual([
      [0, 19],
      [50, 10],
      [100, 1],
    ]);
    expect(linePoints([3], 10, 10)).toEqual([[5, 5]]);
    const bars = barRects([1, 0, 2], 30, 10);
    expect(bars.map((b) => b.h)).toEqual([5, 0, 10]);
    expect(bars[2]).toMatchObject({ x: 20, y: 0, w: 9 });
  });
});

describe("marks in a markdown's code", () => {
  it("cut a line's tokens where they begin and end", () => {
    const pieces = markPieces(
      [{ text: "fn(a: number, " }, { text: "b: string)" }],
      [{ from: 14, to: 23 }],
    );
    expect(pieces.map((p) => [p.text, p.mark])).toEqual([
      ["fn(a: number, ", -1],
      ["b: string", 0],
      [")", -1],
    ]);
  });

  it("are parsed from the node, the odd ones left out", () => {
    const node = parseNode({
      type: "markdown",
      text: "x",
      marks: [
        { line: 2, from: 3, to: 7, hl: "LspSignatureActiveParameter" },
        { line: 2, from: 7, to: 3, hl: "X" },
        { line: "2", from: 1, to: 2, hl: "X" },
      ],
    });
    expect(node && node.type === "markdown" ? node.marks : undefined).toEqual([
      { line: 2, from: 3, to: 7, hl: "LspSignatureActiveParameter" },
    ]);
  });
});
