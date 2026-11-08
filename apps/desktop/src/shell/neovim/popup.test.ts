import { describe, expect, it } from "vitest";
import {
  POPUP_GAP,
  POPUP_MARGIN,
  placePopup,
  popupMaxWidth,
  popupScrollTop,
} from "./popup";

const area = { width: 800, height: 600 };
const cellHeight = 20;

describe("a popup's place", () => {
  it("goes under its anchor, as tall as its content", () => {
    expect(
      placePopup({
        anchor: { x: 100, y: 200 },
        cellHeight,
        size: { width: 300, height: 60 },
        area,
        placement: "below",
      }),
    ).toEqual({
      left: 100,
      top: 200 + cellHeight + POPUP_GAP,
      height: 60,
      side: "below",
      scrolls: false,
    });
  });

  it("flips above when there is no room below and more above", () => {
    const layout = placePopup({
      anchor: { x: 100, y: 540 },
      cellHeight,
      size: { width: 300, height: 120 },
      area,
      placement: "below",
    });
    expect(layout.side).toBe("above");
    expect(layout.top).toBe(540 - POPUP_GAP - 120);
    expect(layout.height).toBe(120);
  });

  it("stays on its side when neither fits but it has more room, and scrolls", () => {
    const layout = placePopup({
      anchor: { x: 0, y: 100 },
      cellHeight,
      size: { width: 300, height: 2000 },
      area,
      placement: "below",
    });
    expect(layout.side).toBe("below");
    expect(layout.height).toBe(
      600 - (100 + cellHeight) - POPUP_GAP - POPUP_MARGIN,
    );
    expect(layout.scrolls).toBe(true);
  });

  it("prefers above when asked, and keeps to its max height", () => {
    const layout = placePopup({
      anchor: { x: 0, y: 300 },
      cellHeight,
      size: { width: 300, height: 400 },
      area,
      placement: "above",
      maxHeight: 100,
    });
    expect(layout).toMatchObject({
      side: "above",
      height: 100,
      top: 300 - POPUP_GAP - 100,
      scrolls: true,
    });
  });

  it("is kept on the editor horizontally", () => {
    const layout = placePopup({
      anchor: { x: 700, y: 0 },
      cellHeight,
      size: { width: 300, height: 40 },
      area,
      placement: "auto",
    });
    expect(layout.left).toBe(800 - POPUP_MARGIN - 300);
    expect(layout.side).toBe("below");
  });

  it("is at most 80 cells wide, or its owner's max_width, on the editor", () => {
    expect(popupMaxWidth(undefined, 8, 2000)).toBe(640);
    expect(popupMaxWidth(40, 8, 2000)).toBe(320);
    expect(popupMaxWidth(undefined, 8, 300)).toBe(300 - 2 * POPUP_MARGIN);
  });

  it("scrolls as its keys ask, within its content", () => {
    const view = { height: 100, content: 400, line: 19 };
    expect(popupScrollTop(0, { by: "line", n: 2 }, view)).toBe(38);
    expect(popupScrollTop(0, { by: "line", n: -1 }, view)).toBe(0);
    expect(popupScrollTop(10, { by: "half", n: 1 }, view)).toBe(60);
    expect(popupScrollTop(250, { by: "page", n: 1 }, view)).toBe(300);
    expect(popupScrollTop(250, { by: "top", n: 1 }, view)).toBe(0);
    expect(popupScrollTop(0, { by: "bottom", n: 1 }, view)).toBe(300);
  });
});
