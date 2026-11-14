// @vitest-environment jsdom

/**
 * A view's header and its items' headings, unframed (`gui.view{ header,
 * sticky_headings }`): the header is a row above the items that is not one;
 * a heading is drawn above its item and outside it — the focus and Visual's
 * band are the item's alone — and a press on it is a press on its item.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyLayerEvent, NO_LAYERS, type Layers } from "./layers";
import { GuiViews, type LayerHost } from "./LayerViews";

afterEach(cleanup);

Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => 200,
});

const file = (name: string) => ({ type: "text", text: name });

function setup(cursor: number) {
  const calls: [string, readonly unknown[]][] = [];
  const over = document.createElement("div");
  document.body.appendChild(over);
  let layers: Layers = applyLayerEvent(NO_LAYERS, "view", {
    id: 7,
    items: [
      { line: 1, text: "a:1", node: file("hit 1"), heading: file("a.lua") },
      {
        line: 2,
        text: "a:2",
        node: {
          type: "text",
          runs: [{ text: "hit " }, { text: "2", hl: "Search", mark: true }],
        },
      },
      { line: 3, text: "b:1", node: file("hit 3"), heading: file("b.lua") },
    ],
    hl: { Search: { fg: 0x000000, bg: 0xffcc00 } },
    keys: {},
    header: {
      type: "hstack",
      children: [{ type: "text", text: "rg needle", action: 1 }],
    },
    sticky_headings: true,
  });
  layers = applyLayerEvent(layers, "layers", {
    views: [{ id: 7, win: 1000, cursor, current: true }],
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
  return { calls, over };
}

describe("a view's header and headings", () => {
  it("parses them", () => {
    const state = applyLayerEvent(NO_LAYERS, "view", {
      id: 1,
      items: [],
      hl: {},
      header: { type: "text", text: "Title" },
      sticky_headings: true,
    });
    expect(state.views.get(1)?.header).toMatchObject({
      type: "text",
      runs: [{ text: "Title" }],
    });
    expect(state.views.get(1)?.stickyHeadings).toBe(true);
    const plain = applyLayerEvent(NO_LAYERS, "view", {
      id: 2,
      items: [],
      hl: {},
    }).views.get(2);
    expect(plain?.header).toBeUndefined();
    expect(plain?.stickyHeadings).toBeUndefined();
  });

  it("draws the header above the items, its clicks its own Lua", () => {
    const { over, calls } = setup(1);
    const header = over.querySelector<HTMLElement>(".nvim-view-header");
    expect(header?.textContent).toBe("rg needle");
    // above the body, not one of the rows
    expect(
      header?.nextElementSibling?.classList.contains("nvim-view-body"),
    ).toBe(true);
    fireEvent.mouseDown(header!.querySelector("[data-action]")!, { detail: 1 });
    expect(calls.at(-1)).toEqual([
      "_layers_click",
      ["view", 7, 1000, null, 1, 1],
    ]);
  });

  it("draws a heading above its item, outside its focus", () => {
    const { over } = setup(1);
    const entry = over.querySelector<HTMLElement>(
      '.nvim-view-entry[data-line="1"]',
    );
    expect(entry).not.toBeNull();
    const heading = entry!.querySelector(":scope > .nvim-view-heading");
    const item = entry!.querySelector(":scope > .nvim-view-item");
    expect(heading?.textContent).toBe("a.lua");
    expect(item?.classList.contains("nvim-view-focused")).toBe(true);
    expect(item?.textContent).toBe("hit 1");
    // the item without a heading is a row on its own, as ever
    expect(
      over.querySelector('.nvim-view-scroll > .nvim-view-item[data-line="2"]'),
    ).not.toBeNull();
  });

  it("presses the item when its heading is pressed", () => {
    const { over, calls } = setup(1);
    const heading = over.querySelector<HTMLElement>(
      '.nvim-view-entry[data-line="3"] > .nvim-view-heading',
    )!;
    fireEvent.mouseDown(heading, { button: 0, detail: 1 });
    expect(calls.at(-1)).toEqual([
      "_layers_click",
      ["view", 7, 1000, 3, null, 1],
    ]);
    // focused at once, before Neovim's cursor gets there
    expect(
      over
        .querySelector('.nvim-view-entry[data-line="3"] > .nvim-view-item')
        ?.classList.contains("nvim-view-focused"),
    ).toBe(true);
  });

  it("holds no heading while the top is a group's own", () => {
    const { over } = setup(1);
    expect(over.querySelector(".nvim-view-pinned")).toBeNull();
  });

  it("draws a mark run on its group's ground", () => {
    const { over } = setup(1);
    const mark = [
      ...over.querySelectorAll<HTMLElement>('[data-line="2"] span'),
    ].find((el) => el.textContent === "2");
    expect(mark?.style.background).toBe("rgb(255, 204, 0)");
  });
});
