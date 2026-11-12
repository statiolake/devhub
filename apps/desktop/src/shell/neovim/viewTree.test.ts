import { describe, expect, it } from "vitest";
import { activeGuide, guideX } from "./viewTree";

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
