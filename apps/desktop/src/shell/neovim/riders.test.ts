import { describe, expect, it } from "vitest";
import { rideAnchor, rideArea, rideStyle } from "./riders";

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
