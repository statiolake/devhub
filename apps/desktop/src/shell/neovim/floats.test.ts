import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  type CellClips,
  cellClip,
  claimedShape,
  floatClusters,
  frameCuts,
  framePieces,
  hugClip,
  insideLines,
  scrollbarLine,
  touching,
  withRightLine,
} from "./floats";
import { frameGeometry } from "./frame";
import { overClip } from "./painter";
import { claimFloats, type GridBox } from "./redraw";

const float = (
  grid: number,
  row: number,
  col: number,
  width: number,
  height: number,
  extra: Partial<GridBox> = {},
): GridBox => ({
  grid,
  row,
  col,
  width,
  height,
  z: 150,
  float: true,
  win: 1000 + grid,
  ...extra,
});

describe("floats that make one panel", () => {
  it("touch along an edge or a cell apart, not at a corner", () => {
    const a = { row: 0, col: 0, width: 10, height: 5 };
    expect(touching(a, { row: 0, col: 10, width: 5, height: 5 })).toBe(true);
    expect(touching(a, { row: 0, col: 11, width: 5, height: 5 })).toBe(true);
    expect(touching(a, { row: 0, col: 12, width: 5, height: 5 })).toBe(false);
    expect(touching(a, { row: 5, col: 2, width: 3, height: 2 })).toBe(true);
    expect(touching(a, { row: 5, col: 10, width: 3, height: 2 })).toBe(false);
    expect(touching(a, { row: 2, col: 2, width: 3, height: 2 })).toBe(true);
  });

  it("are one cluster: a picker's input and list, and its preview beside them", () => {
    const boxes = [
      float(1, 0, 0, 80, 24, { float: false, z: 0 }),
      // input over list, preview to the right, a cell apart
      float(4, 2, 5, 30, 3),
      float(5, 5, 5, 30, 15),
      float(6, 2, 36, 40, 18),
      // a float elsewhere, and one far above in zindex
      float(7, 22, 60, 10, 2),
      float(8, 6, 6, 5, 2, { z: 250 }),
    ];
    const clusters = floatClusters(boxes);
    expect(clusters.map((c) => c.key).sort()).toEqual(["4,5,6", "7", "8"]);
    const panel = clusters.find((c) => c.key === "4,5,6");
    // One seam: between the column and the preview, over the span they share.
    expect(panel?.seams).toEqual([
      { row: 2, col: 35, width: 1, height: 3, between: [4, 6] },
      { row: 5, col: 35, width: 1, height: 15, between: [5, 6] },
    ]);
    const corners = (grid: number) =>
      panel?.members.find((m) => m.grid === grid)?.corners;
    // The input: its top-left only (the list is under it, the preview beside it).
    expect(corners(4)).toEqual({ tl: true, tr: false, br: false, bl: false });
    // The list: its bottom-left only.
    expect(corners(5)).toEqual({ tl: false, tr: false, br: false, bl: true });
    // The preview: its right side; its left meets the column at both ends.
    expect(corners(6)).toEqual({ tl: false, tr: true, br: true, bl: false });
    expect(panel?.z).toBe(150);
    // Alone: every corner round.
    expect(clusters.find((c) => c.key === "7")?.members[0]?.corners).toEqual({
      tl: true,
      tr: true,
      br: true,
      bl: true,
    });
  });

  it("know when every member has a border of its own", () => {
    const lined = { lined: true };
    expect(
      floatClusters([
        float(4, 0, 0, 5, 5, lined),
        float(5, 0, 5, 5, 5, lined),
      ])[0]?.lined,
    ).toBe(true);
    expect(
      floatClusters([float(4, 0, 0, 5, 5, lined), float(5, 0, 5, 5, 5)])[0]
        ?.lined,
    ).toBe(false);
  });
});

describe("a menu's scrollbar in its frame", () => {
  const cell = { width: 8, height: 16 };

  it("puts the line along the scrollbar's outer edge", () => {
    const menu = { row: 5, col: 10, width: 20, height: 8 };
    // Beside a menu without a border; on a bordered menu's last column.
    expect(
      scrollbarLine(menu, [{ row: 5, col: 30, width: 1, height: 8 }]),
    ).toBe(31);
    expect(
      scrollbarLine(menu, [{ row: 6, col: 29, width: 1, height: 2 }]),
    ).toBe(30);
    // Not beside it.
    expect(
      scrollbarLine(menu, [{ row: 5, col: 32, width: 1, height: 8 }]),
    ).toBeUndefined();
    expect(
      scrollbarLine(menu, [{ row: 2, col: 30, width: 1, height: 8 }]),
    ).toBeUndefined();
  });

  it("widens the frame to it, the line inside its outer edge", () => {
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    const place = { row: 5, col: 10, width: 20, height: 8 };
    const g = frameGeometry(none, place, cell, 2, 4);
    // No border: the line along the menu's own edge, inside it.
    expect(g.x + g.w).toBe(30 * 8);
    const wide = withRightLine(g, 31 * 8, 2);
    expect(wide.middles.right).toBe(31 * 8 - wide.widths.right / 2);
    expect(wide.x).toBe(g.x);
    // Nothing past the scrollbar's cells.
    expect(wide.x + wide.w).toBe(31 * 8);
    // Never pulled in.
    expect(withRightLine(g, 29 * 8, 2)).toBe(g);
  });
});

describe("a float without a border, its frame on its cells", () => {
  const cell = { width: 8, height: 16 };
  const none = { top: 0, right: 0, bottom: 0, left: 0 };

  for (const dpr of [1, 1.5, 2, 3]) {
    it(`cuts its canvas inside the line, the corners round, at DPR ${String(dpr)}`, () => {
      const place = { row: 2, col: 0, width: 20, height: 6 };
      const g = frameGeometry(none, place, cell, dpr, 4);
      const [piece] = framePieces(
        [{ grid: 4, rect: place, geometry: g, ruled: false }],
        dpr,
      );
      if (!piece) throw new Error("no piece");
      // The piece is the cells, at the editor's left edge too: nothing to
      // clear there.
      expect([piece.x, piece.y, piece.x + piece.w, piece.y + piece.h]).toEqual([
        0, 32, 160, 128,
      ]);
      const line = g.widths.left;
      const inside = insideLines(piece, g.widths);
      const want = {
        x: line,
        y: 32 + line,
        w: 160 - 2 * line,
        h: 96 - 2 * line,
        r: 4 - line,
      };
      expect(inside.x).toBeCloseTo(want.x, 9);
      expect(inside.y).toBeCloseTo(want.y, 9);
      expect(inside.w).toBeCloseTo(want.w, 9);
      expect(inside.h).toBeCloseTo(want.h, 9);
      for (const r of Object.values(inside.radii))
        expect(r).toBeCloseTo(want.r, 9);
      // In the canvas's own coordinates.
      expect(hugClip(inside, { x: 0, y: 32 })).toMatch(
        /^path\("M[\d.]+ [\d.]+L.*A.*Z"\)$/,
      );
    });
  }

  it("leaves no line, and no inset, where it meets another without one", () => {
    // blink's menu and its documentation under it, both borderless.
    const menu = { row: 5, col: 10, width: 20, height: 6 };
    const doc = { row: 11, col: 10, width: 20, height: 4 };
    const geo = (r: typeof menu) => frameGeometry(none, r, cell, 2, 4);
    const pieces = framePieces(
      [
        { grid: 4, rect: menu, geometry: geo(menu), ruled: false },
        { grid: 5, rect: doc, geometry: geo(doc), ruled: false },
      ],
      2,
    );
    const [m, d] = pieces;
    if (!m || !d) throw new Error("no pieces");
    // They meet on the cells' shared edge, square there, no line.
    expect(m.y + m.h).toBe(11 * 16);
    expect(d.y).toBe(11 * 16);
    expect(m.draw.bottom).toBe(false);
    expect(d.draw.top).toBe(false);
    expect([m.radii.bl, m.radii.br, d.radii.tl, d.radii.tr]).toEqual([
      0, 0, 0, 0,
    ]);
    // The menu's selection band reaches the doc: no inset at the bottom.
    const inside = insideLines(m, geo(menu).widths);
    expect(inside.y + inside.h).toBe(11 * 16);
    expect(inside.x).toBe(m.x + geo(menu).widths.left);
  });
});

describe("a framed view's windows, cut at its frame (`claimedShape`)", () => {
  // snacks-ui.devhub's picker as DevHub drew it: the frame float (the
  // layout's root box, no border) and the preview over it at its right
  // edge, both claimed by the page. The page's line runs just outside the
  // frame float's cells, round at the corners; the bare canvases were
  // square, their corner cells over the line where it bends in, so each
  // corner lost its arc once the claim landed (the painter's own rounded
  // frame, drawn until then, was right).
  const cell = { width: 8, height: 15 };
  const root = float(2, 1, 7, 54, 25, { win: 1001, z: 50 });
  const preview = float(3, 3, 37, 24, 21, { win: 1003, z: 51 });
  const other = float(4, 30, 0, 10, 3, { win: 1004 });
  const boxes = claimFloats(
    [root, preview, other],
    new Map([
      [1001, 1001],
      [1003, 1001],
    ]),
  );
  const [rootBox, previewBox, otherBox] = boxes as [GridBox, GridBox, GridBox];

  it("is the frame float's cells, round at every corner", () => {
    const want = {
      x: 7 * 8,
      y: 1 * 15,
      w: 54 * 8,
      h: 25 * 15,
      radii: { tl: 4, tr: 4, br: 4, bl: 4 },
    };
    expect(claimedShape(rootBox, boxes, cell, 4)).toEqual(want);
    // A window of the frame inside it is cut at the frame's corners too,
    // not its own: the preview at the right edge reaches them.
    expect(claimedShape(previewBox, boxes, cell, 4)).toEqual(want);
  });

  it("cuts the frame float's canvas round, in its own coordinates", () => {
    const shape = claimedShape(rootBox, boxes, cell, 4);
    expect(shape).toBeDefined();
    if (!shape) return;
    // The canvas at the frame float's cells: the path starts 4px in, and
    // every corner is an arc of radius 4.
    const clip = hugClip(shape, { x: 7 * 8, y: 15 });
    expect(clip.startsWith('path("M4 0L428 0A4 4 0 0 1 432 4')).toBe(true);
    expect(clip.match(/A4 4 0 0 1/g)).toHaveLength(4);
  });

  it("leaves a float no page claimed, or one whose frame is gone, alone", () => {
    expect(claimedShape(otherBox, boxes, cell, 4)).toBeUndefined();
    expect(claimedShape(previewBox, [previewBox], cell, 4)).toBeUndefined();
  });

  it("is as round as the panel and the line the page draws", () => {
    const css = readFileSync(
      new URL("./framed.css", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const radiusOf = (selector: string) =>
      new RegExp(
        `${selector.replace(/[.-]/g, "\\$&")}\\s*\\{[^}]*border-radius:\\s*([^;]+);`,
      ).exec(css)?.[1];
    // The edge's line bends in at the corners: a square panel's ground
    // would cover it there.
    expect(radiusOf(".nvim-view-frame")).toBe("var(--float-radius, 4px)");
    expect(radiusOf(".nvim-view-frame-edge")).toBe(
      radiusOf(".nvim-view-frame"),
    );
  });
});

describe("the cursor in a corner cell, cut as its window's cells (`cellClip`)", () => {
  // The cursor was laid in a square clip of the text area over the canvas,
  // which the frame cut: in a corner cell of a borderless float, a framed
  // view's window or a picker's box, the block covered the frame's line
  // and its arc. Its clip is now the canvas's, from the same source.
  const cell = { width: 8, height: 16 };
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  const clipsOf = (
    boxes: readonly GridBox[],
    extra: Partial<CellClips> = {},
  ): CellClips => ({
    boxes,
    cuts: frameCuts(boxes),
    shapes: new Map(),
    hugs: new Map(),
    cell,
    radius: 4,
    ...extra,
  });
  // Where the painter puts the canvas and the cursor's clip: the text area.
  const at = (box: GridBox) => ({
    x: box.col * cell.width,
    y: box.row * cell.height,
  });
  const cursorClip = (box: GridBox, clips: CellClips) =>
    overClip("cursor", box, clips, at(box));
  const windowClip = (box: GridBox, clips: CellClips) =>
    cellClip(box, clips, at(box));

  it("is a borderless float's, inside its line, round at every corner", () => {
    const box = float(4, 2, 10, 20, 6);
    const g = frameGeometry(none, box, cell, 2, 4);
    const [piece] = framePieces(
      [{ grid: 4, rect: box, geometry: g, ruled: false }],
      2,
    );
    if (!piece) throw new Error("no piece");
    const clips = clipsOf([box], {
      shapes: new Map([[4, piece]]),
      hugs: new Map([[4, insideLines(piece, g.widths)]]),
    });
    const clip = cursorClip(box, clips);
    expect(clip).toBe(windowClip(box, clips));
    expect(clip.match(/A/g)).toHaveLength(4);
    // Its corner cell's own corner is outside: the path starts past the arc.
    expect(clip.startsWith('path("M0 0')).toBe(false);
  });

  it("is a framed view's window's, cut at the page's rounded frame", () => {
    const root = float(2, 1, 7, 54, 25, { win: 1001, z: 50 });
    const preview = float(3, 3, 37, 24, 21, { win: 1003, z: 51 });
    const boxes = claimFloats(
      [root, preview],
      new Map([
        [1001, 1001],
        [1003, 1001],
      ]),
    );
    const clips = clipsOf(boxes);
    for (const box of boxes) {
      const clip = cursorClip(box, clips);
      expect(clip).toBe(windowClip(box, clips));
      expect(clip.match(/A4 4 0 0 1/g)).toHaveLength(4);
    }
  });

  it("is a picker's box's, cut by the framed floats over it", () => {
    const frame = {
      margins: { top: 1, right: 1, bottom: 1, left: 1 },
      sides: {},
      corners: {},
      labels: [],
    };
    const root = float(2, 1, 7, 54, 25, { z: 50 });
    const list = float(3, 1, 7, 30, 25, { z: 51, frame });
    const preview = float(5, 1, 37, 24, 25, { z: 51, frame });
    const boxes = [root, list, preview];
    const shape = {
      x: 60,
      y: 20,
      w: 224,
      h: 384,
      radii: { tl: 3, tr: 3, br: 3, bl: 3 },
    };
    const clips = clipsOf(boxes, { shapes: new Map([[3, shape]]) });
    expect(clips.cuts.has(2)).toBe(true);
    const clip = cursorClip(root, clips);
    expect(clip).toBe(windowClip(root, clips));
    expect(clip).toMatch(/A3 3 0 0 1/);
  });

  it("is a bordered float's (rounded, titled, fused): its text area, whole", () => {
    // The line runs through the border's cells, half a cell out: nothing
    // of the text area is past it, so nothing cuts the text or the cursor.
    const frame = {
      margins: { top: 1, right: 1, bottom: 1, left: 1 },
      sides: {},
      corners: {},
      labels: [],
    };
    const a = float(4, 8, 20, 26, 6, { frame });
    const b = float(5, 8, 45, 26, 6, { frame });
    const clips = clipsOf([a, b]);
    for (const box of [a, b]) {
      expect(cursorClip(box, clips)).toBe(windowClip(box, clips));
      expect(cursorClip(box, clips)).toBe("");
    }
  });

  it("is never a neighbour's frame's in a split", () => {
    const left: GridBox = {
      grid: 2,
      row: 0,
      col: 0,
      width: 40,
      height: 30,
      z: 1,
      float: false,
      win: 1000,
    };
    const right: GridBox = {
      grid: 3,
      row: 0,
      col: 41,
      width: 40,
      height: 30,
      z: 1,
      float: false,
      win: 1001,
    };
    const over = float(4, 0, 30, 20, 6);
    const clips = clipsOf([left, right, over], {
      hugs: new Map([
        [
          4,
          {
            x: 240,
            y: 0,
            w: 160,
            h: 96,
            radii: { tl: 4, tr: 4, br: 4, bl: 4 },
          },
        ],
      ]),
    });
    for (const box of [left, right]) {
      expect(cursorClip(box, clips)).toBe("");
      expect(windowClip(box, clips)).toBe("");
    }
  });

  it("leaves what rides the text and what covers it to their own clips", () => {
    const box = float(4, 2, 10, 20, 6);
    const clips = clipsOf([box], {
      hugs: new Map([
        [
          4,
          {
            x: 80,
            y: 32,
            w: 160,
            h: 96,
            radii: { tl: 4, tr: 4, br: 4, bl: 4 },
          },
        ],
      ]),
    });
    expect(cursorClip(box, clips)).not.toBe("");
    expect(overClip("riders", box, clips, at(box))).toBe("");
    expect(overClip("covers", box, clips, at(box))).toBe("");
    expect(overClip("cursor", box, undefined, at(box))).toBe("");
  });
});
