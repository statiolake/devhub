import { describe, expect, it } from "vitest";
import { markRects, parseMarks } from "./marks";

describe("scrollbar marks", () => {
  const marks = parseMarks({
    wins: {
      "1000": {
        diag: [
          [50, 2],
          [50.5, "x"],
          [10, 1],
        ],
        git: [[1, 10, 1], [80, 1, 3], "bad"],
        search: [25, 75],
      },
      nope: {},
    },
    colors: {
      DiagnosticError: { fg: 0xff0000 },
      DiagnosticWarn: { fg: 0xffaa00 },
      Search: { bg: 0x0000ff, fg: 0 },
      Added: { fg: 0x00ff00 },
      GitSignsDelete: { fg: 0x880000 },
    },
  });

  it("reads Lua's lines and colours, leaving out what is not", () => {
    expect([...marks.wins.keys()]).toEqual([1000]);
    expect(marks.wins.get(1000)?.git).toEqual([
      [1, 10, 1],
      [80, 1, 3],
    ]);
    expect(marks.wins.get(1000)?.search).toEqual([25, 75]);
  });

  it("puts each at its line's place, in lanes, the worst diagnostic on top", () => {
    const rects = markRects(
      marks.wins.get(1000),
      marks.colors,
      100,
      40,
      8,
      200,
      "grey",
    );
    // git on the left: added lines 1–10 as a band, a removal at 80.
    expect(rects[0]).toEqual({
      x: 0,
      y: 0,
      w: 2,
      h: 20,
      color: "rgb(0,255,0)",
      kind: "git",
      line: 1,
    });
    expect(rects[1]).toMatchObject({ y: 158, h: 2, color: "rgb(136,0,0)" });
    // The search in the middle, in Search's ground.
    expect(rects[2]).toMatchObject({
      x: 2,
      y: 48,
      w: 4,
      color: "rgb(0,0,255)",
    });
    // Diagnostics on the right: the warning, then the error over it.
    const diag = rects.filter((r) => r.x === 5);
    expect(diag.map((r) => r.y)).toEqual([98, 18]);
    // The cursor across.
    expect(rects.at(-1)).toEqual({
      x: 0,
      y: 78,
      w: 8,
      h: 1,
      color: "grey",
      kind: "cursor",
      line: 40,
    });
  });
});
