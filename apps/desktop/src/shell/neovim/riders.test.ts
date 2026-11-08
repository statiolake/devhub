import { describe, expect, it } from "vitest";
import { pinnedRows, rideAnchor, rideArea, rideStyle } from "./riders";

const AREA = { top: 0, bottom: 400 };

describe("riders", () => {
  it("moves with the rows scrolled since Lua placed it and the display's offset", () => {
    // Placed at 100px; Neovim scrolled 2 rows since, the display 30px
    // short of Neovim's grid (off -30): 2 rows up, 30px back down.
    const ride = rideArea(100, 60, 2, -30, 20, AREA);
    expect(ride.dy).toBe(-10);
    expect(ride.hidden).toBe(false);
    expect(rideStyle(ride)).toEqual({
      transform: "translateY(-10px)",
      clipPath: "",
    });
  });

  it("is cut to the window's text area, and hidden when out of it", () => {
    const top = rideArea(-40, 100, 0, 0, 20, AREA);
    expect([top.cutTop, top.cutBottom, top.hidden]).toEqual([40, 0, false]);
    const bottom = rideArea(380, 100, 0, 0, 20, AREA);
    expect([bottom.cutTop, bottom.cutBottom]).toEqual([0, 80]);
    const gone = rideArea(380, 100, -1, 0, 20, AREA);
    expect(gone.hidden).toBe(true);
    expect(rideStyle(gone).clipPath).toBe("inset(50%)");
  });

  it("shows a popup while its anchor row is in the text area", () => {
    expect(rideAnchor(0, 0, 0, 20, AREA).hidden).toBe(false);
    expect(rideAnchor(0, 0, 5, 20, AREA).hidden).toBe(true);
    expect(rideAnchor(380, 0, -5, 20, AREA).hidden).toBe(true);
  });
});

describe("pinnedRows", () => {
  // A float a row under line 17 (0-based), seen at anchor row 3 (its line
  // on row 2) before Neovim scrolled.
  const anchor = { line: 17, row: 1 };
  const base = { anchor, textRows: 20, topline: 15, botline: 35 } as const;

  it("follows Neovim while the line is in its view", () => {
    const r = pinnedRows({
      ...base,
      anchorRow: 3,
      painted: 0,
      ref: undefined,
      off: 0,
    });
    expect(r).toEqual({ rows: 0, ref: { row: 3, painted: 0 } });
  });

  it("keeps a pinned float on its line while the display shows it", () => {
    // Neovim scrolled 3 rows, to topline 18: line 17 is out, the float
    // pinned at row 1; the display is 2 rows back (its line on row 1).
    const r = pinnedRows({
      ...base,
      topline: 18,
      botline: 38,
      anchorRow: 1,
      painted: 3,
      ref: { row: 3, painted: 0 },
      off: -2,
    });
    expect(r.rows).toBe(-1);
    expect(r.ref).toEqual({ row: 3, painted: 0 });
  });

  it("leaves it pinned once its line is off the display", () => {
    const r = pinnedRows({
      ...base,
      topline: 25,
      botline: 45,
      anchorRow: 1,
      painted: 10,
      ref: { row: 3, painted: 0 },
      off: -2,
    });
    expect(r.rows).toBe(0);
  });

  it("has nothing to go by for a float first seen out of view", () => {
    const r = pinnedRows({
      ...base,
      topline: 20,
      anchorRow: 1,
      painted: 0,
      ref: undefined,
      off: -1,
    });
    expect(r).toEqual({ rows: 0, ref: undefined });
  });
});
