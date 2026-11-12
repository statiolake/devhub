import { describe, expect, it } from "vitest";
import { activeGuide, bandPart, guideX } from "./viewTree";

describe("a tree view's guides", () => {
  // src            (0)
  //   a.ts         (1)
  //   deep         (1)
  //     b.ts       (2)
  //   c.ts         (1)
  // README.md      (0)
  const items = [0, 1, 1, 2, 1, 0].map((depth) => ({ depth }));

  it("runs the focused row's level down its siblings and their children", () => {
    expect(activeGuide(items, 2)).toEqual({ level: 0, from: 1, to: 4 });
    expect(activeGuide(items, 3)).toEqual({ level: 1, from: 3, to: 3 });
    expect(activeGuide(items, 4)).toEqual({ level: 0, from: 1, to: 4 });
  });

  it("has none at the top level or with nothing focused", () => {
    expect(activeGuide(items, 0)).toBeUndefined();
    expect(activeGuide(items, -1)).toBeUndefined();
    expect(activeGuide([{}], 0)).toBeUndefined();
  });

  it("puts a level's guide in the middle of its indent", () => {
    expect(guideX(0, 16)).toBe(8);
    expect(guideX(2, 12)).toBe(30);
  });
});

describe("Visual mode's band over a view's rows", () => {
  const lines = [1, 2, 3, 4, 5];

  it("is one band: rounded at its ends, square where rows meet", () => {
    expect(lines.map((_, i) => bandPart(lines, i, [2, 4]))).toEqual([
      undefined,
      "first",
      "middle",
      "last",
      undefined,
    ]);
    expect(bandPart(lines, 2, [3, 3])).toBe("only");
  });

  it("is nothing outside Visual mode", () => {
    expect(bandPart(lines, 0, undefined)).toBeUndefined();
    expect(bandPart(lines, 9, [1, 5])).toBeUndefined();
  });
});
