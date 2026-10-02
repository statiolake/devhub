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
  anchorBox,
  anchoredOffset,
  defaultSpot,
  isSmartButtonsOffset,
  isSmartButtonsSpot,
  sameSpot,
  snapSpot,
  SMART_BUTTONS_MARGIN,
  SMART_BUTTONS_SNAP,
} from "./smartButtons.js";
import { localWorkspace } from "./testWorkspaces.js";

describe("anchoring and snapping", () => {
  // A 1000×600 pane at the origin; a composer from x 100 to 900 whose top is
  // at 480; a box 200×24.
  const pane = { top: 0, right: 1000, bottom: 600, left: 0 };
  const composer = { top: 480, right: 900, bottom: 580, left: 100 };
  const box = { width: 200, height: 24 };
  const gui = { inset: 16, gap: 0 };

  it("draws an anchored spot from where the anchor is now", () => {
    expect(
      anchoredOffset({ anchored: "top", along: 16 }, pane, composer, box, gui),
    ).toEqual({ right: 116, bottom: 120 });
    // The composer grew 60px taller as a prompt was typed: the box rides up.
    const grown = { ...composer, top: 420 };
    expect(
      anchoredOffset({ anchored: "top", along: 16 }, pane, grown, box, gui),
    ).toEqual({ right: 116, bottom: 180 });
    // Beside the composer's right edge, its bottom `along` above the composer's.
    expect(
      anchoredOffset({ anchored: "side", along: 10 }, pane, composer, box, gui),
    ).toEqual({ right: -100, bottom: 30 });
  });

  it("snaps a box whose bottom comes near the composer's top", () => {
    // Bottom 10px above the top edge, over the composer: anchored, keeping
    // where across it was.
    expect(
      snapSpot({ right: 300, bottom: 130 }, pane, composer, box, gui),
    ).toEqual({ anchored: "top", along: 200 });
    // Overlapping into the composer by the threshold still snaps.
    expect(
      snapSpot(
        { right: 300, bottom: 120 - SMART_BUTTONS_SNAP },
        pane,
        composer,
        box,
        gui,
      ),
    ).toEqual({ anchored: "top", along: 200 });
  });

  it("leaves a box free past the threshold, or beside the composer", () => {
    const far = { right: 300, bottom: 120 + SMART_BUTTONS_SNAP + 1 };
    expect(snapSpot(far, pane, composer, box, gui)).toEqual(far);
    // At the right height but not over the composer at all.
    const beside = { right: 0, bottom: 124 };
    expect(
      snapSpot(beside, pane, { ...composer, right: 700 }, box, gui),
    ).toEqual(beside);
  });

  it("never anchors past the composer's right edge", () => {
    expect(
      snapSpot({ right: 60, bottom: 120 }, pane, composer, box, gui),
    ).toEqual({ anchored: "top", along: 0 });
  });

  it("snaps to the side of a narrow anchor, the nearer edge winning", () => {
    const narrow = { top: 480, right: 600, bottom: 580, left: 100 };
    // Left edge 6px right of the composer's right edge, level with it.
    expect(
      snapSpot({ right: 194, bottom: 40 }, pane, narrow, box, gui),
    ).toEqual({ anchored: "side", along: 20 });
  });

  it("anchors a terminal's box to its corner when there is no status", () => {
    const tui = { inset: 0, gap: 4 };
    const corner = anchorBox(pane, undefined, tui);
    expect(anchoredOffset(defaultSpot(tui), pane, corner, box, tui)).toEqual({
      right: SMART_BUTTONS_MARGIN,
      bottom: SMART_BUTTONS_MARGIN,
    });
    expect(snapSpot({ right: 20, bottom: 20 }, pane, corner, box, tui)).toEqual(
      { anchored: "top", along: 8 },
    );
  });

  it("tells anchored spots apart and refuses ones that are not", () => {
    expect(
      sameSpot({ anchored: "top", along: 4 }, { anchored: "top", along: 4 }),
    ).toBe(true);
    expect(
      sameSpot({ anchored: "top", along: 4 }, { right: 4, bottom: 0 }),
    ).toBe(false);
    expect(sameSpot(undefined, undefined)).toBe(true);
    expect(isSmartButtonsSpot({ anchored: "side", along: 0 })).toBe(true);
    expect(isSmartButtonsSpot({ anchored: "below", along: 0 } as never)).toBe(
      false,
    );
    expect(isSmartButtonsSpot({ anchored: "top", along: 1.5 })).toBe(false);
  });
});

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
    // Anchored is a place of its own.
    expect(app.placeSmartButtons("gui", { anchored: "top", along: 30 })).toBe(
      true,
    );
    expect(app.placeSmartButtons("gui", { anchored: "top", along: 30 })).toBe(
      false,
    );
    expect(app.snapshot().smartButtons).toEqual({
      gui: { anchored: "top", along: 30 },
    });
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
