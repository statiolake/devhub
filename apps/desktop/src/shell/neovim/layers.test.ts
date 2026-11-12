import { describe, expect, it } from "vitest";
import { NO_LAYERS, applyLayerEvent, frameClaims } from "./layers";

describe("buffer-backed GUI layers on the page", () => {
  it("keeps a view's items by line, plain lines as their text, and its keys", () => {
    const state = applyLayerEvent(NO_LAYERS, "view", {
      id: 3,
      items: [
        { line: 2, node: { type: "badge", text: "M" }, text: "M a.go" },
        { line: 1, text: "Review" },
        { line: 0, text: "bad" },
      ],
      hl: { Normal: { fg: 1, bg: 2 } },
      keys: [["j/k", "move"], ["q"]],
    });
    const view = state.views.get(3);
    expect(view?.items.map((i) => [i.line, i.node?.type, i.text])).toEqual([
      [1, undefined, "Review"],
      [2, "badge", "M a.go"],
    ]);
    expect(view?.keys).toEqual([["j/k", "move"]]);
    expect(view?.hl.get("Normal")).toMatchObject({ fg: 1, bg: 2 });
    expect(applyLayerEvent(state, "view_clear", { id: 3 }).views.size).toBe(0);
  });

  it("keeps a tree view's depths, sticky items, indent and row height", () => {
    const state = applyLayerEvent(NO_LAYERS, "view", {
      id: 4,
      indent: 16,
      row_height: 22,
      items: [
        { line: 1, text: "root", depth: 0, sticky: true },
        { line: 2, text: "src", depth: 1 },
        { line: 3, text: "deep", depth: 900 },
        { line: 4, text: "bad", depth: -1 },
      ],
    });
    const view = state.views.get(4);
    expect(view?.indent).toBe(16);
    expect(view?.rowHeight).toBe(22);
    expect(view?.items.map((i) => [i.line, i.depth, i.sticky])).toEqual([
      [1, 0, true],
      [2, 1, undefined],
      [3, 64, undefined],
      [4, undefined, undefined],
    ]);
    const plain = applyLayerEvent(NO_LAYERS, "view", { id: 5, items: [] });
    expect(plain.views.get(5)?.indent).toBeUndefined();
  });

  it("keeps a view's visual lines from its place", () => {
    const state = applyLayerEvent(NO_LAYERS, "layers", {
      views: [
        { id: 3, win: 1000, cursor: 4, current: true, visual: [2, 4] },
        { id: 4, win: 1001, cursor: 1, current: false, visual: [3, 1] },
      ],
    });
    expect(state.placedViews).toEqual([
      { id: 3, win: 1000, cursor: 4, current: true, visual: [2, 4] },
      { id: 4, win: 1001, cursor: 1, current: false },
    ]);
  });

  it("keeps a card only with a node", () => {
    let state = applyLayerEvent(NO_LAYERS, "inline", {
      id: 1,
      node: { type: "nope" },
    });
    expect(state.inlines.size).toBe(0);
    state = applyLayerEvent(state, "inline", {
      id: 1,
      node: { type: "text", text: "hi" },
    });
    expect(state.inlines.get(1)?.node).toMatchObject({ type: "text" });
  });

  it("takes where everything is from one layers event", () => {
    const state = applyLayerEvent(NO_LAYERS, "layers", {
      views: [{ id: 3, win: 1000, cursor: 4, current: true }, { id: 3 }],
      inlines: [
        {
          id: 1,
          win: 1000,
          row: -2,
          base: 0,
          col: 4,
          width: 70,
          rows: 6,
          active: true,
        },
        { id: 2, win: 1000, row: 5, base: 0, col: 4, width: 70, rows: 0 },
      ],
      measure: [{ id: 9, width: 70, full: 2 }],
    });
    expect(state.placedViews).toEqual([
      { id: 3, win: 1000, cursor: 4, current: true },
    ]);
    expect(state.placedInlines).toEqual([
      {
        id: 1,
        win: 1000,
        row: -2,
        base: 0,
        col: 4,
        width: 70,
        rows: 6,
        active: true,
      },
    ]);
    expect(state.measureInlines).toEqual([{ id: 9, width: 70, full: 2 }]);
  });
  it("keeps a popup, where its anchor is, and the scrolls its keys ask for", () => {
    let state = applyLayerEvent(NO_LAYERS, "popup", {
      id: 4,
      node: { type: "markdown", text: "**hi**" },
      hl: {},
      placement: "sideways",
      max_width: 60,
    });
    expect(state.popups.get(4)).toMatchObject({
      placement: "below",
      maxWidth: 60,
      maxHeight: undefined,
    });
    state = applyLayerEvent(state, "layers", {
      views: {},
      inlines: {},
      measure: {},
      popups: [
        { id: 4, win: 1000, row: 3, base: 0, col: 7, focused: true },
        { id: 5 },
        // on the command line: the byte it lines up with
        { id: 6, cmdline: 4, focused: false },
      ],
    });
    expect(state.placedPopups).toEqual([
      { id: 4, win: 1000, row: 3, base: 0, col: 7, focused: true },
      { id: 6, win: 0, row: 0, col: 0, base: 0, cmdline: 4, focused: false },
    ]);
    state = applyLayerEvent(state, "popup_scroll", {
      id: 4,
      by: "half",
      n: -1,
      seq: 2,
    });
    expect(state.popupScrolls.get(4)).toEqual({ seq: 2, by: "half", n: -1 });
    expect(
      applyLayerEvent(state, "popup_scroll", { id: 4, by: "sideways", seq: 3 }),
    ).toBe(state);
    state = applyLayerEvent(state, "popup_clear", { id: 4 });
    expect(state.popups.size).toBe(0);
    expect(state.popupScrolls.size).toBe(0);
  });

  it("moves a popup's list selection without its tree, and scrolls a pane", () => {
    const row = (text: string) => ({ type: "text", text });
    let state = applyLayerEvent(NO_LAYERS, "popup", {
      id: 6,
      node: {
        type: "stack",
        children: [
          {
            type: "stack",
            band: "PmenuSel",
            selected: 1,
            children: [row("a"), row("b"), row("c")],
          },
          { type: "stack", pane: "doc", max_height: 200, children: [] },
        ],
      },
      hl: {},
      min_width: 36,
    });
    expect(state.popups.get(6)?.minWidth).toBe(36);
    state = applyLayerEvent(state, "popup_select", { id: 6, n: 3 });
    const list = (s: typeof state) => {
      const node = s.popups.get(6)?.node;
      return node?.type === "stack" ? node.children[0] : undefined;
    };
    expect(list(state)).toMatchObject({ band: "PmenuSel", selected: 3 });
    // The same selection, an unknown popup, a negative index: nothing new.
    expect(applyLayerEvent(state, "popup_select", { id: 6, n: 3 })).toBe(state);
    expect(applyLayerEvent(state, "popup_select", { id: 9, n: 1 })).toBe(state);
    expect(applyLayerEvent(state, "popup_select", { id: 6, n: -1 })).toBe(
      state,
    );
    expect(
      list(applyLayerEvent(state, "popup_select", { id: 6, n: 0 })),
    ).toMatchObject({ selected: 0 });
    // A pane's content alone, with the groups it names.
    state = applyLayerEvent(state, "popup_pane", {
      id: 6,
      pane: "doc",
      children: [{ type: "markdown", text: "**doc**" }],
      hl: { Title: { fg: 255 } },
    });
    const content = state.popups.get(6);
    const pane =
      content?.node.type === "stack" ? content.node.children[1] : undefined;
    expect(pane).toMatchObject({
      pane: "doc",
      children: [{ type: "markdown", text: "**doc**" }],
    });
    expect(content?.hl.get("Title")).toMatchObject({ fg: 255 });
    expect(list(state)).toMatchObject({ selected: 3 });
    expect(
      applyLayerEvent(state, "popup_pane", {
        id: 6,
        pane: "nope",
        children: [],
      }),
    ).toBe(state);
    state = applyLayerEvent(state, "popup_scroll", {
      id: 6,
      by: "line",
      n: 4,
      seq: 7,
      pane: "doc",
    });
    expect(state.popupScrolls.get(6)).toEqual({
      seq: 7,
      by: "line",
      n: 4,
      pane: "doc",
    });
  });

  it("keeps a framed view's parts, and where its windows stand", () => {
    let state = applyLayerEvent(NO_LAYERS, "view", {
      id: 6,
      items: [
        { line: 2, text: "b", heading: { type: "text", text: "file" } },
        { line: 1, text: "a", node: { type: "text", text: "A" } },
      ],
      keys: [["<CR>", "open"], ["bad"]],
      frame: {
        title: { type: "badge", text: "Files" },
        placeholder: "Search",
      },
      hl: {},
    });
    const view = state.views.get(6);
    expect(view?.items[1]?.heading).toMatchObject({ type: "text" });
    expect(view?.keys).toEqual([["<CR>", "open"]]);
    expect(view?.frame?.title).toMatchObject({ type: "badge", text: "Files" });
    expect(view?.frame?.placeholder).toBe("Search");
    expect(
      applyLayerEvent(NO_LAYERS, "view", {
        id: 5,
        items: [],
        hl: {},
      }).views.get(5)?.frame,
    ).toBeUndefined();
    const rect = { row: 2, col: 4, width: 50, height: 20, top: 0 };
    const query = {
      ...rect,
      height: 2,
      text: "conf",
      caret: 4,
      current: true,
      insert: true,
    };
    const preview = {
      ...rect,
      row: 5,
      col: 29,
      width: 25,
      height: 15,
      win: 1003,
    };
    state = applyLayerEvent(state, "layers", {
      frames: [
        {
          id: 6,
          win: 1001,
          wins: [1001, 1002, "x", 1003],
          frame: rect,
          list: { ...rect, row: 4, width: 25, height: 17, cursor: 3 },
          query,
          preview,
        },
        { id: 8, win: 1002, frame: rect },
      ],
    });
    expect(state.placedFrames).toEqual([
      {
        id: 6,
        win: 1001,
        wins: [1001, 1002, 1003],
        frame: rect,
        list: {
          ...rect,
          row: 4,
          width: 25,
          height: 17,
          cursor: 3,
          current: false,
        },
        query,
        preview,
      },
    ]);
  });

  it("keeps the last settled seq, and the windows the frames claim", () => {
    const placed = applyLayerEvent(NO_LAYERS, "layers", {
      frames: [
        {
          id: 1,
          win: 1006,
          wins: [1006, 1007, 1008, 1009],
          frame: { row: 1, col: 7, width: 54, height: 25, top: 0 },
          list: { row: 3, col: 7, width: 30, height: 22, top: 0, cursor: 1 },
        },
      ],
    });
    expect(frameClaims(placed.placedFrames)).toEqual(
      new Map([
        [1006, 1006],
        [1007, 1006],
        [1008, 1006],
        [1009, 1006],
      ]),
    );
    const settled = applyLayerEvent(placed, "settled", { seq: 7 });
    expect(settled.settled).toBe(7);
    // An older answer, or none, changes nothing.
    expect(applyLayerEvent(settled, "settled", { seq: 5 })).toBe(settled);
    expect(applyLayerEvent(settled, "settled", {})).toBe(settled);
  });
});
