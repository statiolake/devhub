// The motion invariants on hand-made samples, as motionRecorder.js keeps them.
import { describe, expect, it } from "vitest";
import { checkMotion } from "./motionInvariants.mjs";

const grid = (origin, more = {}) => ({
  grid: 2,
  win: 1000,
  top: 4,
  left: 4,
  width: 800,
  painted: 0,
  origin,
  off: 0,
  canvas: [4, 4, 800, 600],
  port: [4, 4, 800, 600],
  ...more,
});
const sample = (g, anchors = {}) => ({
  t: 0,
  editors: [{ key: "w", ch: 15, grids: [g] }],
  anchors,
  scrollers: {},
});

describe("text in motion", () => {
  it("holds for a scroll that eases one way and stops on Neovim's line", () => {
    const frames = [0, -40, -90, -120, -120].map((o, i) =>
      sample(grid(o, { off: i < 4 ? 3 : 0 })),
    );
    frames[frames.length - 1] = sample(grid(-120));
    expect(checkMotion(frames)).toEqual([]);
  });

  it("finds a scroll that goes back, or past where it ends", () => {
    const back = [0, -60, -40, -120].map((o) => sample(grid(o)));
    expect(checkMotion(back).map((v) => v.rule)).toContain("reversed");
    const past = [0, -60, -130, -120].map((o) => sample(grid(o)));
    expect(checkMotion(past).map((v) => v.rule)).toContain("overshoot");
  });

  it("finds a scroll that stops off Neovim's line, or with its ghost up", () => {
    expect(
      checkMotion([sample(grid(0)), sample(grid(-30, { off: 5 }))]).map(
        (v) => v.rule,
      ),
    ).toContain("unsettled");
    expect(
      checkMotion([
        sample(grid(0)),
        sample(grid(-30, { ghost: [4, 40, 800, 600] })),
      ]).map((v) => v.rule),
    ).toContain("unsettled");
  });

  it("finds an anchor that does not move with its text (a hover a frame behind)", () => {
    const with_ = [0, -30, -60].map((o) =>
      sample(grid(o), { hover: [100, 300 + o, 200, 60] }),
    );
    expect(checkMotion(with_)).toEqual([]);
    const behind = [0, -30, -60].map((o, i) =>
      sample(grid(o), { hover: [100, 300 + (i === 1 ? 0 : o), 200, 60] }),
    );
    expect(checkMotion(behind).map((v) => v.rule)).toEqual(["misaligned"]);
  });

  it("finds a scroll port with a band neither the canvas nor the ghost covers", () => {
    const ok = sample(
      grid(-20, { canvas: [4, -16, 800, 600], ghost: [4, 400, 800, 600] }),
    );
    expect(checkMotion([ok], { monotonic: false, rest: false })).toEqual([]);
    const gap = sample(
      grid(-20, { canvas: [4, -100, 800, 600], ghost: [4, 560, 800, 600] }),
    );
    expect(
      checkMotion([gap], { monotonic: false, rest: false }).map((v) => v.rule),
    ).toEqual(["uncovered"]);
  });

  it("lets a streamed answer grow, but not push what came before it", () => {
    const s = (items) => ({
      editors: [],
      anchors: {},
      scrollers: { t: { scrollTop: 0, box: [0, 0, 1, 1], items } },
    });
    expect(
      checkMotion(
        [
          s([
            [0, 40],
            [50, 20],
          ]),
          s([
            [0, 40],
            [50, 90],
          ]),
        ],
        { kept: ["t"] },
      ),
    ).toEqual([]);
    expect(
      checkMotion(
        [
          s([
            [0, 40],
            [50, 20],
          ]),
          s([
            [8, 40],
            [58, 90],
          ]),
        ],
        { kept: ["t"] },
      ).map((v) => v.rule),
    ).toEqual(["pushed"]);
  });
});
