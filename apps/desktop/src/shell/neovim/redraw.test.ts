import { describe, expect, it } from "vitest";
import {
  applyRedraw,
  charOffsetOfByte,
  floatBorder,
  gridRowText,
  initialUiState,
  layoutGrids,
  placeUnplacedWindows,
  RESTARTED_EVENT,
} from "./redraw";

const rows = (id: number, state = initialUiState()) => {
  const grid = state.grids.get(id)!;
  return Array.from({ length: grid.height }, (_, r) => gridRowText(grid, r));
};

describe("the redraw reducer", () => {
  it("records a grid_scroll's region for the slide, and gives up on a second", () => {
    const state = initialUiState();
    applyRedraw(state, [["grid_resize", [2, 10, 10]]]);
    const one = applyRedraw(state, [["grid_scroll", [2, 3, 10, 0, 10, 1, 0]]]);
    expect(one.moved.get(2)).toEqual({
      top: 3,
      bot: 10,
      left: 0,
      right: 10,
      rows: 1,
    });
    const two = applyRedraw(state, [
      ["grid_scroll", [2, 3, 10, 0, 10, 1, 0]],
      ["grid_scroll", [2, 0, 10, 0, 10, -2, 0]],
    ]);
    expect(two.moved.get(2)).toBeNull();
  });

  it("forgets the old server's screen when a :restart's server attaches, keeping its colours", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["default_colors_set", [0x111111, 0x222222, 0x333333]],
      ["hl_attr_define", [5, { bold: true }, {}, []]],
      ["grid_resize", [2, 4, 1]],
      ["win_pos", [2, 1000, 0, 0, 4, 1]],
      ["grid_line", [2, 0, 0, [["old", 5]]]],
    ]);
    const changes = applyRedraw(state, [
      [RESTARTED_EVENT, []],
      ["grid_resize", [3, 4, 1]],
      ["grid_line", [3, 0, 0, [["new"]]]],
      ["flush", []],
    ]);
    expect([...state.grids.keys()]).toEqual([3]);
    expect(state.windows.size).toBe(0);
    expect(state.hl.size).toBe(0);
    expect(state.defaults.background).toBe(0x222222);
    expect(changes.grids.has(2)).toBe(true);
    expect(changes.layout && changes.colors && changes.flushed).toBe(true);
    expect(rows(3, state)[0]?.trimEnd()).toBe("new");
  });

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

  it("adds up how far each window scrolled, for the painter to glide", () => {
    const state = initialUiState();
    const changes = applyRedraw(state, [
      ["grid_resize", [1, 80, 24], [2, 80, 22]],
      ["win_pos", [2, 1000, 0, 0, 80, 22]],
      ["win_viewport", [2, 1000, 3, 25, 4, 0, 200, 3]],
      ["win_viewport", [2, 1000, 4, 26, 5, 0, 200, 1]],
    ]);
    expect(changes.scrolled.get(2)).toBe(4);
  });

  it("keeps a float that would run past the screen's edge on it", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["grid_resize", [1, 80, 24], [2, 80, 22], [4, 30, 6]],
      ["win_pos", [2, 1000, 0, 0, 80, 22]],
      // A hover at the right edge, a menu under the last line.
      ["win_float_pos", [4, 1001, "NW", 2, 21, 70, true, 50]],
    ]);
    const float = layoutGrids(state).find((b) => b.grid === 4);
    expect([float?.row, float?.col]).toEqual([18, 50]);
  });

  it("leaves out a float's blank border and keeps a border of lines", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["grid_resize", [1, 80, 24], [4, 6, 3], [5, 6, 3]],
      ["win_float_pos", [4, 1001, "NW", 1, 2, 2, true, 50]],
      ["win_float_pos", [5, 1002, "NW", 1, 10, 2, true, 50]],
      // 'solid': blank cells around "hi".
      ["grid_line", [4, 1, 1, [["h"], ["i"]], false]],
      ["win_viewport_margins", [4, 1001, 1, 1, 1, 1]],
      // 'rounded'.
      ["grid_line", [5, 0, 0, [["╭"], ["─", 0, 4], ["╮"]], false]],
      ["grid_line", [5, 1, 0, [["│"], [" ", 0, 4], ["│"]], false]],
      ["grid_line", [5, 2, 0, [["╰"], ["─", 0, 4], ["╯"]], false]],
      ["win_viewport_margins", [5, 1002, 1, 1, 1, 1]],
    ]);
    const boxes = layoutGrids(state);
    const solid = boxes.find((b) => b.grid === 4);
    expect(solid?.crop).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    expect(solid?.lined).toBeUndefined();
    // Where Neovim put it: the text area stays in its place.
    expect([solid?.row, solid?.col, solid?.width]).toEqual([2, 2, 6]);
    const rounded = boxes.find((b) => b.grid === 5);
    expect(rounded?.crop).toBeUndefined();
    expect(rounded?.lined).toBe(true);
    // Drawn as DevHub's frame, cut at its lines (`frame.ts`).
    expect(rounded?.frame?.corners.tl).toBe("╭");
    // No border: neither.
    expect(floatBorder(state.grids.get(4)!, undefined)).toEqual({});
    expect(
      floatBorder(state.grids.get(4)!, {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      }),
    ).toEqual({});
    // A title in a blank border: its row is kept, the rest left out.
    applyRedraw(state, [["grid_line", [4, 0, 1, [["T"]], false]]]);
    expect(layoutGrids(state).find((b) => b.grid === 4)?.crop).toEqual({
      top: 0,
      right: 1,
      bottom: 1,
      left: 1,
    });
    // A winbar is text in the top margin of a float without a border: kept.
    expect(
      floatBorder(state.grids.get(4)!, {
        top: 1,
        right: 0,
        bottom: 0,
        left: 0,
      }),
    ).toEqual({ lined: true });
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

  it("keeps a prompt's question, with what was said with it, until it is answered", () => {
    const state = initialUiState();
    // The swap file's question, as 0.12 says it: an error, the question,
    // then the prompt's command line.
    applyRedraw(state, [
      [
        "msg_show",
        [
          "emsg",
          [[25, "E325: ATTENTION", 6]],
          false,
          true,
          false,
          1,
          "typed_cmd",
        ],
      ],
      [
        "msg_show",
        [
          "confirm",
          [[16, "Found a swap file\nmodified: YES", 10]],
          false,
          false,
          false,
          2,
          "typed_cmd",
        ],
      ],
      [
        "cmdline_show",
        [[[0, "", 0]], 0, "", "[O]pen Read-Only, (E)dit anyway: ", 0, 1, 10],
      ],
    ]);
    expect(
      state.prompt?.map((line) => line.map((c) => c.text).join("")),
    ).toEqual(["E325: ATTENTION", "Found a swap file", "modified: YES"]);
    // Not a notification as well.
    expect(state.messages).toEqual([]);
    applyRedraw(state, [["cmdline_hide", [1, false]]]);
    expect(state.prompt).toBeUndefined();
  });

  it("echoes a search and its count, and names the command a list came from", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["cmdline_show", [[[0, "ls", 0]], 2, ":", "", 0, 1, 0]],
      ["cmdline_hide", [1, false]],
      [
        "msg_show",
        [
          "list_cmd",
          [[0, '  1 %a  "a.txt"', 0]],
          false,
          false,
          false,
          3,
          "typed_cmd",
        ],
      ],
    ]);
    expect(state.lastCommand).toBe(":ls");
    expect(state.messages).toHaveLength(1);
    applyRedraw(state, [
      [
        "msg_show",
        ["search_cmd", [[0, "/foo       ", 0]], false, false, false, 4, ""],
      ],
      [
        "msg_show",
        ["search_count", [[0, "/foo   [2/5]", 0]], true, false, false, 5, ""],
      ],
    ]);
    expect(state.searchEcho).toEqual({ text: "/foo", count: "[2/5]" });
    // An abandoned command line names nothing; a new one clears the echo.
    applyRedraw(state, [
      ["cmdline_show", [[[0, "x", 0]], 1, ":", "", 0, 1, 0]],
      ["cmdline_hide", [1, true]],
    ]);
    expect(state.lastCommand).toBe(":ls");
    expect(state.searchEcho).toBeUndefined();
  });

  it("keeps the mode, showcmd and the ruler, and the :messages history", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["msg_showmode", [[[15, "-- INSERT --", 11]]]],
      ["msg_showcmd", [[[0, "2d", 0]]]],
      ["msg_history_show", [[["echomsg", [[0, "hi", 0]], false]], false]],
    ]);
    expect(state.showmode.map((c) => c.text)).toEqual(["-- INSERT --"]);
    expect(state.showcmd.map((c) => c.text)).toEqual(["2d"]);
    expect(state.messages).toEqual([
      {
        type: "history",
        entries: [
          { kind: "echomsg", content: [{ attr: 0, text: "hi", hl: 0 }] },
        ],
      },
    ]);
    applyRedraw(state, [["msg_showmode", [[]]]]);
    expect(state.showmode).toEqual([]);
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
      ["cmdline_hide", [1, false]],
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
