// @vitest-environment jsdom

/**
 * A view with a menu (`on_context_menu`): a right-click on a row focuses it
 * at once and asks Lua for its menu at the pointer, and is no click; a left
 * press is a click as ever. A view without one keeps its right press a press.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyLayerEvent, NO_LAYERS, type Layers } from "./layers";
import { GuiViews, type LayerHost } from "./LayerViews";

afterEach(cleanup);

// jsdom lays nothing out: the view is 200 px tall, every row 22.
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => 200,
});

function setup(menu: boolean) {
  const calls: [string, readonly unknown[]][] = [];
  const over = document.createElement("div");
  document.body.appendChild(over);
  let layers: Layers = applyLayerEvent(NO_LAYERS, "view", {
    id: 4,
    items: [
      { line: 1, text: "src" },
      { line: 2, text: "a.lua" },
    ],
    hl: {},
    keys: {},
    row_height: 22,
    ...(menu ? { menu: true } : {}),
  });
  layers = applyLayerEvent(layers, "layers", {
    views: [{ id: 4, win: 1000, cursor: 1, current: true }],
  });
  const host = {
    cell: { width: 8, height: 16 },
    boxes: [
      {
        grid: 2,
        row: 0,
        col: 0,
        width: 30,
        height: 10,
        z: 1,
        float: false,
        win: 1000,
      },
    ],
    laidOut: () => undefined,
    caret: undefined,
    mono: "monospace",
    defaults: { foreground: 0, background: 0xffffff },
    lua: (fn: string, args: readonly unknown[]) => {
      calls.push([fn, args]);
    },
    openLink: () => undefined,
    refocus: () => undefined,
    ride: () => undefined,
    over: () => over,
  } as unknown as LayerHost;
  render(<GuiViews layers={layers} host={host} />);
  const row = (line: number) =>
    over.querySelector<HTMLElement>(
      `.nvim-view-item[data-line="${String(line)}"]`,
    )!;
  return { calls, row, over };
}

describe("a view's menu", () => {
  it("is asked for at the pointer by a right-click, which is no click", () => {
    const { calls, row, over } = setup(true);
    expect(
      over.querySelector('.nvim-view[data-view="4"][data-win="1000"]'),
    ).not.toBeNull();
    fireEvent.mouseDown(row(2), { button: 2, detail: 1 });
    const menu = fireEvent.contextMenu(row(2), { clientX: 40, clientY: 30 });
    expect(menu).toBe(false); // the page's own menu is not shown
    expect(calls).toEqual([["_view_menu", [4, 1000, 2, 40, 30]]]);
    // focused at once, before Neovim's cursor gets there
    expect(row(2).classList.contains("nvim-view-focused")).toBe(true);
    fireEvent.mouseDown(row(1), { button: 0, detail: 1 });
    expect(calls.at(-1)).toEqual([
      "_layers_click",
      ["view", 4, 1000, 1, null, 1],
    ]);
  });

  it("is not there without on_context_menu: the right press is a press", () => {
    const { calls, row } = setup(false);
    fireEvent.mouseDown(row(2), { button: 2, detail: 1 });
    expect(fireEvent.contextMenu(row(2))).toBe(true);
    expect(calls).toEqual([["_layers_click", ["view", 4, 1000, 2, null, 1]]]);
  });
});
