// The stability invariants on hand-made frames, as recorder.js keeps them.
// Each case is the shape of a fault the suite found or was built to find.
import { describe, expect, it } from "vitest";
import { check } from "./invariants.mjs";
import { cellBands, decodePng, regionDigest } from "./pixels.mjs";
import { deflateSync } from "node:zlib";

const frame = (els, extra = {}) => ({
  t: 0,
  motion: false,
  anim: [],
  els,
  ...extra,
});
const box = (x, y, w, h, more = {}) => ({ r: [x, y, w, h], op: 1, ...more });

describe("one change, at most two forms", () => {
  it("holds for an element that appears in its settled form", () => {
    const frames = [
      frame({}),
      frame({ "frame#0": box(10, 10, 100, 50) }),
      frame({ "frame#0": box(10, 10, 100, 50) }),
    ];
    expect(check(frames)).toEqual([]);
  });

  it("holds for an element that changes once, or leaves", () => {
    const frames = [
      frame({ "row#0": box(0, 0, 10, 10) }),
      frame({ "row#0": box(0, 20, 10, 10) }),
      frame({}),
    ];
    expect(check([frames[0], frames[1]])).toEqual([]);
    expect(check([frames[0], frames[2]])).toEqual([]);
  });

  it("finds a first frame that differs from the settled one (square corners, then round)", () => {
    const frames = [
      frame({}),
      frame({ "frame#0": box(10, 10, 100, 50) }),
      frame({ "frame#0": box(10, 10, 100, 50, { radius: "4px" }) }),
    ];
    const [v] = check(frames);
    expect(v.rule).toBe("intermediate");
    expect(v.key).toBe("frame#0");
  });

  it("finds a row drawn for a frame and taken away (a half row at the list's foot)", () => {
    const frames = [
      frame({}),
      frame({ "frame-row#30": box(0, 713, 400, 20) }),
      frame({}),
    ];
    expect(check(frames).map((v) => v.rule)).toEqual(["flicker"]);
  });

  it("leaves out what a declared motion draws on its way", () => {
    const frames = [
      frame({ "pane#0": box(0, 0, 100, 100) }),
      frame({ "pane#0": box(0, 0, 60, 100, { m: 1 }) }),
      frame({ "pane#0": box(0, 0, 50, 100) }, { motion: true }),
      frame({ "pane#0": box(0, 0, 50, 100) }),
    ];
    expect(check(frames)).toEqual([]);
  });

  it("compares only what is not ignored", () => {
    const frames = [
      frame({ "grid#1": box(0, 0, 9, 9, { hash: "a" }) }),
      frame({ "grid#1": box(0, 0, 9, 9, { hash: "b" }) }),
      frame({ "grid#1": box(0, 0, 9, 9, { hash: "c" }) }),
    ];
    expect(check(frames)).toHaveLength(1);
    expect(check(frames, { ignore: { grid: ["hash"] } })).toEqual([]);
  });
});

describe("the per-frame rules", () => {
  it("finds a role on screen twice (doubled)", () => {
    const frames = [
      frame({ "frame#0": box(0, 0, 9, 9), "frame#1": box(0, 0, 9, 9) }),
    ];
    expect(check(frames, { single: ["frame"] }).map((v) => v.rule)).toEqual([
      "doubled",
    ]);
  });

  it("finds content outside its frame (uncovered)", () => {
    const frames = [
      frame({ "list#0": box(0, 0, 10, 120), "edge#0": box(0, 0, 10, 100) }),
    ];
    expect(
      check(frames, { contain: [["list#0", "edge#0"]] }).map((v) => v.rule),
    ).toEqual(["uncovered"]);
  });

  it("lets a streamed block grow, but not move (pushed)", () => {
    const grow = [
      frame({ "block#0": box(0, 100, 500, 20) }),
      frame({ "block#0": box(0, 100, 500, 40) }),
      frame({ "block#0": box(0, 100, 500, 60) }),
    ];
    expect(
      check(grow, { ignore: { block: ["r"] }, anchored: ["block"] }),
    ).toEqual([]);
    const pushed = [...grow, frame({ "block#0": box(0, 108, 500, 60) })];
    expect(
      check(pushed, { ignore: { block: ["r"] }, anchored: ["block"] }).map(
        (v) => v.rule,
      ),
    ).toEqual(["pushed"]);
  });
});

describe("the picture", () => {
  // A 2×1 RGB PNG, filter 0 on its one row.
  function png(pixels) {
    const chunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(pixels.length, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.from([0, ...pixels.flat()]);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  it("is decoded and digested by region", () => {
    const image = decodePng(
      png([
        [255, 0, 0],
        [0, 0, 255],
      ]),
    );
    expect([image.width, image.height]).toEqual([2, 1]);
    expect([...image.data.subarray(0, 8)]).toEqual([
      255, 0, 0, 255, 0, 0, 255, 255,
    ]);
    const other = decodePng(
      png([
        [255, 0, 0],
        [0, 255, 0],
      ]),
    );
    expect(regionDigest(image, [0, 0, 1, 1])).toBe(
      regionDigest(other, [0, 0, 1, 1]),
    );
    expect(regionDigest(image, [1, 0, 1, 1])).not.toBe(
      regionDigest(other, [1, 0, 1, 1]),
    );
  });
});

describe("a view's region never shows its buffer's cells (cellBands)", () => {
  // 32x8 pictures in one colour each, the cells' own pixels in a column band.
  const image = (fill, band) => {
    const width = 32;
    const height = 8;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const c = band && x >= band[0] && x < band[1] ? band[2] : fill;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        data[o + 3] = 255;
      }
    return { width, height, data };
  };
  const view = image([30, 30, 60]);
  const behind = image([10, 10, 10]);
  // The buffer's text: bright in the second band only.
  const cells = image([10, 10, 10], [16, 32, [220, 220, 220]]);
  const refs = { view, cells, behind };
  const rect = [0, 0, 32, 8];

  it("passes the view, what is behind, and a mix of the two", () => {
    expect(cellBands(view, refs, rect, 10)).toEqual([]);
    expect(cellBands(behind, refs, rect, 10)).toEqual([]);
    expect(
      cellBands(image([30, 30, 60], [16, 32, [10, 10, 10]]), refs, rect, 10),
    ).toEqual([]);
  });

  it("finds the band where the cells show", () => {
    expect(cellBands(cells, refs, rect, 10)).toEqual([
      { x: 16, own: 128, shown: 128 },
    ]);
  });
});
