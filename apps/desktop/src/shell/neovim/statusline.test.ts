import { describe, expect, it } from "vitest";
import type { GridBox } from "./redraw";
import {
  CELLS,
  NO_STATUSLINE,
  applyStatuslineEvent,
  footersOf,
  formatPosition,
  hasLine,
  modeLabel,
  nativeCells,
  type Statusline,
} from "./statusline";
import { parseNode } from "./components";

const win = (
  grid: number,
  row: number,
  col: number,
  width: number,
  height: number,
): GridBox => ({
  grid,
  row,
  col,
  width,
  height,
  z: 1,
  float: false,
  win: 1000 + grid,
});
const grid1 = { width: 81, height: 30 };
const tree = (extra: Record<string, unknown> = {}) => ({
  kind: "tree",
  node: { type: "hstack", children: [{ type: "text", text: "a.ts" }] },
  hl: { StatusLine: { bg: 0x111111 } },
  ...extra,
});

describe("Lua's statusline event", () => {
  it("keeps what it did not send again, replaces what it did, drops the windows gone", () => {
    let s = applyStatuslineEvent(NO_STATUSLINE, {
      laststatus: 2,
      current: 1002,
      wins: { "1002": tree(), "1003": { kind: "cells" } },
      keep: [1002, 1003],
    });
    expect(s.laststatus).toBe(2);
    expect(s.current).toBe(1002);
    expect(s.entries.get(1002)?.kind).toBe("tree");
    expect(s.entries.get(1003)).toEqual(CELLS);
    // Only 1003 changed; 1002 kept as it was; 1004 is new; nothing else.
    s = applyStatuslineEvent(s, {
      laststatus: 2,
      current: 1003,
      wins: { "1003": tree({ edge: true }), "1004": tree() },
      keep: [1002, 1003, 1004],
    });
    expect(s.entries.get(1002)?.kind).toBe("tree");
    const third = s.entries.get(1003);
    expect(third?.kind === "tree" && third.edge).toBe(true);
    expect(s.current).toBe(1003);
    // An empty map of changes (Lua's {} arrives as an array or a map).
    s = applyStatuslineEvent(s, {
      laststatus: 3,
      current: 1004,
      wins: [],
      keep: [1004],
    });
    expect([...s.entries.keys()]).toEqual([1004]);
    expect(s.laststatus).toBe(3);
  });

  it("is Neovim's cells for a payload of the wrong shape", () => {
    const s = applyStatuslineEvent(NO_STATUSLINE, {
      wins: { "1002": { kind: "tree", node: { type: "nope" } } },
      keep: [1002],
    });
    expect(s.entries.get(1002)).toEqual(CELLS);
    expect(applyStatuslineEvent(s, "garbage")).toBe(s);
  });

  it("says whether a tree draws a line through its row", () => {
    const line = parseNode({
      type: "hstack",
      children: [
        { type: "line", grow: true },
        { type: "hstack", bg: "X", round: true, children: ["a"] },
      ],
    });
    expect(line && hasLine(line)).toBe(true);
    const plain = parseNode({ type: "hstack", children: ["a"] });
    expect(plain && hasLine(plain)).toBe(false);
    const s = applyStatuslineEvent(NO_STATUSLINE, {
      wins: {
        "1002": {
          kind: "tree",
          node: { type: "hstack", children: [{ type: "line" }] },
        },
      },
      keep: [1002],
    });
    const entry = s.entries.get(1002);
    expect(entry?.kind === "tree" && entry.line).toBe(true);
  });
});

describe("the status line rows of a layout", () => {
  const sl = (entries: [number, ReturnType<typeof tree>][]): Statusline =>
    applyStatuslineEvent(NO_STATUSLINE, {
      wins: Object.fromEntries(entries.map(([w, e]) => [String(w), e])),
      keep: entries.map(([w]) => w),
    });
  // Two side by side over a third: 81 × 30, cmdheight 1.
  const boxes = [
    { ...win(1, 0, 0, 81, 30), win: undefined },
    win(2, 0, 0, 40, 13),
    win(3, 0, 41, 40, 13),
    win(4, 14, 0, 81, 14),
  ];

  it("with laststatus 2: the row under each window, as wide as it", () => {
    const f = footersOf(boxes, grid1, {
      laststatus: 2,
      cmdheight: 1,
      current: 1003,
      statusline: sl([[1003, tree()]]),
    });
    expect(f.map((x) => [x.key, x.grid, x.row, x.col, x.width])).toEqual([
      ["win:1002", 2, 13, 0, 40],
      ["win:1003", 3, 13, 41, 40],
      ["win:1004", 4, 28, 0, 81],
    ]);
    // What Lua has not spoken of is Neovim's cells.
    expect(f[0]?.entry).toEqual(CELLS);
    expect(f[1]?.entry.kind).toBe("tree");
    expect(f.map((x) => x.current)).toEqual([false, true, false]);
  });

  it("with laststatus 1: rows only once Neovim has them (two windows or more)", () => {
    const one = [boxes[0]!, win(2, 0, 0, 81, 29)];
    expect(
      footersOf(one, grid1, {
        laststatus: 1,
        cmdheight: 1,
        current: 1002,
        statusline: NO_STATUSLINE,
      }),
    ).toEqual([]);
    expect(
      footersOf(boxes, grid1, {
        laststatus: 1,
        cmdheight: 1,
        current: 1002,
        statusline: NO_STATUSLINE,
      }),
    ).toHaveLength(3);
  });

  it("with laststatus 3: one row across the editor above the command line, the current window's", () => {
    const stacked = [boxes[0]!, win(2, 0, 0, 81, 14), win(3, 15, 0, 81, 13)];
    const f = footersOf(stacked, grid1, {
      laststatus: 3,
      cmdheight: 1,
      current: 1003,
      statusline: { ...sl([[1003, tree()]]), current: 1003 },
    });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      key: "global",
      win: 1003,
      grid: undefined,
      row: 28,
      col: 0,
      width: 81,
    });
    expect(f[0]?.entry.kind).toBe("tree");
  });

  it("with laststatus 0: none; floats have none", () => {
    expect(
      footersOf(boxes, grid1, {
        laststatus: 0,
        cmdheight: 1,
        current: 1002,
        statusline: NO_STATUSLINE,
      }),
    ).toEqual([]);
    const float = { ...win(9, 3, 3, 20, 5), float: true };
    expect(
      footersOf([...boxes, float], grid1, {
        laststatus: 2,
        cmdheight: 1,
        current: 1002,
        statusline: NO_STATUSLINE,
      }).map((x) => x.grid),
    ).toEqual([2, 3, 4]);
  });

  it("with cmdheight=0 the last window's row is grid 1's last", () => {
    const full = [boxes[0]!, win(2, 0, 0, 81, 29)];
    const f = footersOf(full, grid1, {
      laststatus: 2,
      cmdheight: 0,
      current: 1002,
      statusline: NO_STATUSLINE,
    });
    expect(f.map((x) => x.row)).toEqual([29]);
  });

  it("leaves a tree footer's cells (and the gap beside it) out of what is read as cells", () => {
    const f = footersOf(boxes, grid1, {
      laststatus: 2,
      cmdheight: 1,
      current: 1003,
      statusline: sl([[1003, tree()]]),
    });
    const cells = nativeCells(f, grid1.width);
    expect(cells.has(13 * 81 + 40)).toBe(true); // the gap column
    expect(cells.has(13 * 81 + 80)).toBe(true);
    expect(cells.has(13 * 81 + 39)).toBe(false); // the cells footer beside it
    expect(cells.has(28 * 81)).toBe(false);
  });
});

describe("slots", () => {
  it("formats the cursor's place", () => {
    const at = { curline: 33, curcol: 9, lineCount: 200 };
    expect(formatPosition(undefined, at)).toBe("Ln 34, Col 10");
    expect(formatPosition("%l/%L %p%% %c", at)).toBe("34/200 17% 10");
  });

  it("names the mode as a footer shows it", () => {
    expect(modeLabel("normal")).toBe("NORMAL");
    expect(modeLabel("insert")).toBe("INSERT");
    expect(modeLabel("visual")).toBe("VISUAL");
    expect(modeLabel("cmdline_normal")).toBe("COMMAND");
    expect(modeLabel("something_new")).toBe("SOMETHING_NEW");
  });
});
