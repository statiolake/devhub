/**
 * Where an Agent pane's Smart Buttons stand: the default spot, a drag, and
 * the clamp that keeps the box inside a pane that got smaller.
 */

import { describe, expect, it } from "vitest";
import { AppModel } from "./appModel.js";
import {
  clampOffset,
  defaultOffset,
  draggedOffset,
  isSmartButtonsOffset,
  SMART_BUTTONS_MARGIN,
} from "./smartButtons.js";
import { localWorkspace } from "./testWorkspaces.js";

const PANE = { width: 800, height: 600 };
const BOX = { width: 200, height: 24 };

describe("the clamp", () => {
  it("leaves an offset that fits where it is", () => {
    expect(clampOffset({ right: 40, bottom: 100 }, PANE, BOX)).toEqual({
      right: 40,
      bottom: 100,
    });
  });

  it("keeps the whole box inside the pane", () => {
    expect(clampOffset({ right: 700, bottom: 900 }, PANE, BOX)).toEqual({
      right: 600,
      bottom: 576,
    });
    expect(clampOffset({ right: -20, bottom: -5 }, PANE, BOX)).toEqual({
      right: 0,
      bottom: 0,
    });
  });

  it("keeps a box wider than its pane on the pane's right and bottom edges", () => {
    expect(
      clampOffset({ right: 30, bottom: 30 }, { width: 100, height: 10 }, BOX),
    ).toEqual({ right: 0, bottom: 0 });
  });
});

describe("a drag", () => {
  it("moves the box with the pointer, counting from the right and bottom", () => {
    expect(
      draggedOffset({ right: 12, bottom: 12 }, { x: -100, y: -50 }, PANE, BOX),
    ).toEqual({ right: 112, bottom: 62 });
  });

  it("stops at the pane's edges, in whole pixels", () => {
    expect(
      draggedOffset(
        { right: 12, bottom: 12 },
        { x: 40.4, y: -9000 },
        PANE,
        BOX,
      ),
    ).toEqual({ right: 0, bottom: 576 });
    expect(
      draggedOffset(
        { right: 12, bottom: 12 },
        { x: -10.6, y: -0.2 },
        PANE,
        BOX,
      ),
    ).toEqual({ right: 23, bottom: 12 });
  });
});

describe("the default spot", () => {
  const pane = { top: 100, right: 900, bottom: 700, left: 100 };

  it("stands on what it is attached to", () => {
    // A composer whose top is 150px above the pane's bottom and whose right
    // edge is 20px in from the pane's.
    const composer = { top: 550, right: 880, bottom: 690, left: 120 };
    expect(defaultOffset(pane, composer, { inset: 16, gap: 0 })).toEqual({
      right: 36,
      bottom: 150,
    });
  });

  it("is the pane's corner when there is nothing to stand on", () => {
    expect(defaultOffset(pane, undefined, { inset: 0, gap: 4 })).toEqual({
      right: SMART_BUTTONS_MARGIN,
      bottom: SMART_BUTTONS_MARGIN,
    });
  });
});

describe("what the model remembers", () => {
  function model(): AppModel {
    return new AppModel(localWorkspace("/scratch"));
  }

  it("remembers each presentation's place on its own, and forgets one put back", () => {
    const app = model();
    expect(app.placeSmartButtons("tui", { right: 30, bottom: 40 })).toBe(true);
    expect(app.placeSmartButtons("gui", { right: 5, bottom: 6 })).toBe(true);
    expect(app.snapshot().smartButtons).toEqual({
      tui: { right: 30, bottom: 40 },
      gui: { right: 5, bottom: 6 },
    });
    expect(app.placeSmartButtons("tui", undefined)).toBe(true);
    expect(app.snapshot().smartButtons).toEqual({
      gui: { right: 5, bottom: 6 },
    });
    // The same place again is no change.
    expect(app.placeSmartButtons("gui", { right: 5, bottom: 6 })).toBe(false);
  });

  it("refuses an offset that is not a place", () => {
    const app = model();
    expect(() =>
      app.placeSmartButtons("tui", { right: -1, bottom: 0 }),
    ).toThrow();
    expect(isSmartButtonsOffset({ right: 0.5, bottom: 0 })).toBe(false);
    expect(isSmartButtonsOffset({ right: 0, bottom: 1_000_000 })).toBe(false);
  });
});
