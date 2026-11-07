import { describe, expect, it } from "vitest";
import {
  applyRedraw,
  charOffsetOfByte,
  gridRowText,
  initialUiState,
  layoutGrids,
  placeUnplacedWindows,
} from "./redraw";

const rows = (id: number, state = initialUiState()) => {
  const grid = state.grids.get(id)!;
  return Array.from({ length: grid.height }, (_, r) => gridRowText(grid, r));
};

describe("the redraw reducer", () => {
  it("makes a grid, writes a line with repeats and carried highlights", () => {
    const state = initialUiState();
    const changes = applyRedraw(state, [
      ["grid_resize", [1, 6, 2]],
      ["grid_line", [1, 0, 0, [["a", 3], ["b"], [" ", 0, 2], ["c", 4]], false]],
      ["flush", []],
    ]);
    expect(rows(1, state)).toEqual(["ab  c ", "      "]);
    expect([...state.grids.get(1)!.hls.slice(0, 6)]).toEqual([
      3, 3, 0, 0, 4, 0,
    ]);
    expect(changes.flushed).toBe(true);
    expect(changes.grids.has(1)).toBe(true);
  });

  it("keeps the cells it had when a grid grows, and clears on grid_clear", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["grid_resize", [1, 3, 1]],
      ["grid_line", [1, 0, 0, [["x", 0, 3]], false]],
      ["grid_resize", [1, 4, 2]],
    ]);
    expect(rows(1, state)).toEqual(["xxx ", "    "]);
    applyRedraw(state, [["grid_clear", [1]]]);
    expect(rows(1, state)).toEqual(["    ", "    "]);
  });

  it("scrolls a region up and down, leaving the uncovered rows to be rewritten", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["grid_resize", [1, 2, 4]],
      [
        "grid_line",
        [1, 0, 0, [["a", 0, 2]], false],
        [1, 1, 0, [["b", 0, 2]], false],
        [1, 2, 0, [["c", 0, 2]], false],
        [1, 3, 0, [["d", 0, 2]], false],
      ],
      ["grid_scroll", [1, 0, 4, 0, 2, 1, 0]],
    ]);
    expect(rows(1, state)).toEqual(["bb", "cc", "dd", "dd"]);
    applyRedraw(state, [["grid_scroll", [1, 0, 4, 0, 2, -2, 0]]]);
    expect(rows(1, state)).toEqual(["bb", "cc", "bb", "cc"]);
  });

  it("defines highlights from the rgb map and takes default colours, or DevHub's for -1", () => {
    const state = initialUiState({ foreground: 1, background: 2, special: 3 });
    applyRedraw(state, [
      ["default_colors_set", [0xffffff, -1, 0xff0000, 0, 0]],
      [
        "hl_attr_define",
        [
          5,
          { foreground: 0x112233, bold: true, undercurl: true, special: 0xff },
          {},
          [],
        ],
      ],
    ]);
    expect(state.defaults).toEqual({
      foreground: 0xffffff,
      background: 2,
      special: 0xff0000,
    });
    expect(state.hl.get(5)).toEqual({
      foreground: 0x112233,
      bold: true,
      undercurl: true,
      special: 0xff,
    });
  });

  it("places windows on grid 1 and floats against their anchor, stacked by zindex", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["grid_resize", [1, 80, 24], [2, 40, 22], [4, 10, 3]],
      ["win_pos", [2, 1000, 1, 40, 40, 22]],
      ["win_float_pos", [4, 1001, "SE", 2, 5, 20, true, 50]],
    ]);
    const boxes = layoutGrids(state);
    expect(boxes.map((b) => [b.grid, b.row, b.col, b.z])).toEqual([
      [1, 0, 0, 0],
      [2, 1, 40, 1],
      [4, 3, 50, 150],
    ]);
    applyRedraw(state, [["win_hide", [2]]]);
    // Hidden, and so is the float anchored to it.
    expect(layoutGrids(state).map((b) => b.grid)).toEqual([1]);
    applyRedraw(state, [
      ["win_close", [4]],
      ["grid_destroy", [2]],
    ]);
    expect(state.windows.size).toBe(0);
  });

  it("follows the popupmenu, the command line and the tab line", () => {
    const state = initialUiState();
    applyRedraw(state, [
      [
        "popupmenu_show",
        [
          [
            ["alpha", "f", "", ""],
            ["beta", "v", "[x]", ""],
          ],
          -1,
          3,
          4,
          2,
        ],
      ],
      ["popupmenu_select", [1]],
      [
        "cmdline_show",
        [
          [
            [0, "e "],
            [7, "日本"],
          ],
          8,
          ":",
          "",
          0,
          1,
        ],
      ],
      ["cmdline_special_char", ["^V", true, 1]],
      [
        "tabline_update",
        [
          2,
          [
            { tab: 1, name: "a.ts" },
            { tab: 2, name: "b.ts" },
          ],
          1,
          [],
        ],
      ],
    ]);
    expect(state.popupmenu).toMatchObject({
      selected: 1,
      row: 3,
      col: 4,
      grid: 2,
    });
    expect(state.popupmenu?.items[1]).toEqual({
      word: "beta",
      kind: "v",
      menu: "[x]",
      info: "",
    });
    expect(state.cmdline[0]).toMatchObject({
      firstc: ":",
      pos: 8,
      special: { char: "^V", shift: true },
    });
    expect(state.tabline).toEqual({
      current: 2,
      tabs: [
        { tab: 1, name: "a.ts" },
        { tab: 2, name: "b.ts" },
      ],
    });
    applyRedraw(state, [
      ["popupmenu_hide", []],
      ["cmdline_hide", []],
    ]);
    expect(state.popupmenu).toBeUndefined();
    expect(state.cmdline).toEqual([]);
  });

  it("places a window grid Neovim did not place, from Lua's layout, and no other", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["grid_resize", [1, 80, 24], [2, 40, 22], [3, 39, 22]],
      ["win_pos", [2, 1000, 0, 0, 40, 22]],
      ["win_viewport", [3, 1001, 0, 10, 0, 0, 10, 0]],
    ]);
    expect(layoutGrids(state).map((b) => b.grid)).toEqual([1, 2]);
    const layout = [
      { win: 1000, row: 5, col: 5, width: 1, height: 1 },
      { win: 1001, row: 0, col: 41, width: 39, height: 22 },
    ];
    expect(placeUnplacedWindows(state, layout)).toBe(true);
    const boxes = layoutGrids(state);
    expect(boxes.map((b) => [b.grid, b.row, b.col])).toEqual([
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 41],
    ]);
    expect(placeUnplacedWindows(state, layout)).toBe(false);
  });

  it("reads the cursor shape of the current mode", () => {
    const state = initialUiState();
    applyRedraw(state, [
      [
        "mode_info_set",
        [
          true,
          [
            { name: "normal", cursor_shape: "block" },
            { name: "insert", cursor_shape: "vertical", cell_percentage: 25 },
          ],
        ],
      ],
      ["mode_change", ["insert", 1]],
      ["option_set", ["guifont", "Fira Code:h14"], ["linespace", 3]],
    ]);
    expect(state.modes[state.mode.index]).toMatchObject({
      cursorShape: "vertical",
      cellPercentage: 25,
    });
    expect(state.options.get("guifont")).toBe("Fira Code:h14");
  });

  it("turns a command line's byte position into a character offset", () => {
    expect(charOffsetOfByte("e 日本", 2)).toBe(2);
    expect(charOffsetOfByte("e 日本", 5)).toBe(3);
    expect(charOffsetOfByte("e 日本", 8)).toBe(4);
  });
});
