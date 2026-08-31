import { describe, expect, it } from "vitest";

import { WheelAccumulator, type WheelGeometry } from "./wheel.js";

/** A 800x400 host drawing an 80x20 grid: 10px columns, 20px rows. */
const GEOMETRY: WheelGeometry = {
  left: 100,
  top: 50,
  width: 800,
  height: 400,
  cols: 80,
  rows: 20,
};

function wheel(event: Partial<WheelEvent>): WheelEvent {
  return {
    deltaMode: 0,
    deltaY: 0,
    clientX: GEOMETRY.left,
    clientY: GEOMETRY.top,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    ...event,
  } as WheelEvent;
}

describe("a wheel gesture over an Agent surface", () => {
  it("counts pixel deltas in whole grid rows", () => {
    const accumulator = new WheelAccumulator();
    expect(accumulator.take(wheel({ deltaY: 60 }), GEOMETRY)).toMatchObject({
      direction: "down",
      lines: 3,
    });
    expect(accumulator.take(wheel({ deltaY: -40 }), GEOMETRY)).toMatchObject({
      direction: "up",
      lines: 2,
    });
  });

  it("carries a trackpad's sub-row deltas instead of rounding them away", () => {
    const accumulator = new WheelAccumulator();
    expect(accumulator.take(wheel({ deltaY: 8 }), GEOMETRY)).toBeUndefined();
    expect(accumulator.take(wheel({ deltaY: 8 }), GEOMETRY)).toBeUndefined();
    expect(accumulator.take(wheel({ deltaY: 8 }), GEOMETRY)).toMatchObject({
      direction: "down",
      lines: 1,
    });
  });

  it("drops the carried remainder when the gesture reverses", () => {
    const accumulator = new WheelAccumulator();
    accumulator.take(wheel({ deltaY: 15 }), GEOMETRY);
    // Without the reset the 15px already banked would cancel this notch.
    expect(accumulator.take(wheel({ deltaY: -20 }), GEOMETRY)).toMatchObject({
      direction: "up",
      lines: 1,
    });
  });

  it("reads line and page deltas in their own units", () => {
    expect(
      new WheelAccumulator().take(wheel({ deltaMode: 1, deltaY: 3 }), GEOMETRY),
    ).toMatchObject({ lines: 3 });
    expect(
      new WheelAccumulator().take(wheel({ deltaMode: 2, deltaY: 1 }), GEOMETRY),
    ).toMatchObject({ lines: GEOMETRY.rows });
  });

  it("names the cell the pointer was over, clamped into the grid", () => {
    const accumulator = new WheelAccumulator();
    expect(
      accumulator.take(
        wheel({ deltaY: 100, clientX: 155, clientY: 175 }),
        GEOMETRY,
      ),
    ).toMatchObject({ column: 5, row: 6 });
    expect(
      accumulator.take(
        wheel({ deltaY: 100, clientX: 100_000, clientY: 100_000 }),
        GEOMETRY,
      ),
    ).toMatchObject({ column: 79, row: 19 });
  });

  it("reports modifiers as the provider's bitset", () => {
    const accumulator = new WheelAccumulator();
    expect(
      accumulator.take(
        wheel({ deltaY: 20, shiftKey: true, altKey: true }),
        GEOMETRY,
      ),
    ).toMatchObject({ modifiers: 0b101 });
  });

  it("has nothing to ask for when the host has no layout", () => {
    const accumulator = new WheelAccumulator();
    expect(
      accumulator.take(wheel({ deltaY: 100 }), {
        ...GEOMETRY,
        height: 0,
        rows: 0,
      }),
    ).toBeUndefined();
  });
});
