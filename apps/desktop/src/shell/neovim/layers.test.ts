import { describe, expect, it } from "vitest";
import { NO_LAYERS, applyLayerEvent } from "./layers";

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

  it("keeps a card only with a node, and a decoration only with a style", () => {
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
    state = applyLayerEvent(state, "deco", { id: 2, style: "glow" });
    expect(state.decos.size).toBe(0);
    state = applyLayerEvent(state, "deco", {
      id: 2,
      style: "dim",
      tag: "NEW",
      group: "DiagnosticWarn",
    });
    expect(state.decos.get(2)).toMatchObject({
      style: "dim",
      tag: "NEW",
      group: "DiagnosticWarn",
    });
  });

  it("takes where everything is from one layers event", () => {
    const state = applyLayerEvent(NO_LAYERS, "layers", {
      views: [{ id: 3, win: 1000, cursor: 4, current: true }, { id: 3 }],
      inlines: [
        {
          id: 1,
          win: 1000,
          row: 5,
          col: 4,
          width: 70,
          rows: 3,
          full: 6,
          clip: 3,
          active: true,
        },
        { id: 2, win: 1000, row: 5, col: 4, width: 70, rows: 0, full: 6 },
      ],
      measure: [{ id: 9, width: 70, full: 2 }],
      decos: {},
    });
    expect(state.placedViews).toEqual([
      { id: 3, win: 1000, cursor: 4, current: true },
    ]);
    expect(state.placedInlines).toEqual([
      {
        id: 1,
        win: 1000,
        row: 5,
        col: 4,
        width: 70,
        rows: 3,
        full: 6,
        clip: 3,
        active: true,
      },
    ]);
    expect(state.measureInlines).toEqual([{ id: 9, width: 70, full: 2 }]);
    expect(state.placedDecos).toEqual([]);
  });
});
