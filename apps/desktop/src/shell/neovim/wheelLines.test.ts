import { describe, expect, it } from "vitest";
import { TICK_GAP_MS, WheelLines } from "./wheelLines";

const LINE = 17;

/** Events `[delta, ms after the last]`, pixels: the lines each gives. */
function feed(
  events: readonly (readonly [number, number])[],
  mode = 0,
): number[] {
  const w = new WheelLines();
  let now = 1000;
  return events.map(([delta, dt]) => {
    now += dt;
    return w.lines(delta, mode, LINE, 40, now);
  });
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe("a wheel's deltas as lines", () => {
  it("one tick is at least one line, however small", () => {
    expect(feed([[4, 0]])).toEqual([1]);
    expect(feed([[-1, 0]])).toEqual([-1]);
    expect(feed([[0.5, 0]])).toEqual([1]);
  });

  it("every tick of a slowly turned wheel is a line (a Mac's 4 px notches)", () => {
    const gap = TICK_GAP_MS + 30;
    expect(
      feed([
        [4, 0],
        [4, gap],
        [4, gap],
        [4, gap],
      ]),
    ).toEqual([1, 1, 1, 1]);
    expect(
      feed([
        [-4, 0],
        [-4, gap],
      ]),
    ).toEqual([-1, -1]);
  });

  it("a big notch gives its lines, the rest kept for the next", () => {
    // 120 px is 7 lines and 1 px over; two notches make 240 px: 14 lines
    // and 2 px over.
    const out = feed([
      [120, 0],
      [120, 200],
    ]);
    expect(out).toEqual([7, 7]);
    // A third makes 360 px: 21 lines and 3 px over.
    expect(
      sum(
        feed([
          [120, 0],
          [120, 200],
          [120, 200],
        ]),
      ),
    ).toBe(21);
  });

  it("a swipe moves by the lines its pixels make: none lost, none added", () => {
    // 100 events of 1.3 px a frame: 130 px, 7 lines and 11 px over, the
    // first line given at the first event.
    const out = feed(Array.from({ length: 100 }, () => [1.3, 16] as const));
    expect(out[0]).toBe(1);
    expect(sum(out)).toBe(Math.floor(130 / LINE));
    // Each line comes when the pixels reach it, never before but the first.
    let px = 0;
    let lines = 0;
    out.forEach((n, i) => {
      px += 1.3;
      lines += n;
      if (i > 0) expect(lines).toBeLessThanOrEqual(Math.max(1, px / LINE));
      expect(lines).toBeGreaterThanOrEqual(Math.floor(px / LINE + 1e-9));
    });
  });

  it("turning back is a tick the other way at once", () => {
    expect(
      feed([
        [10, 0],
        [-3, 16],
      ]),
    ).toEqual([1, -1]);
  });

  it("a pause forgives what a tick took ahead, not what was moved", () => {
    // 30 px: one line and 13 over; after a pause a 5 px tick makes 18: one.
    expect(
      feed([
        [30, 0],
        [5, 200],
      ]),
    ).toEqual([1, 1]);
    // 20 px over a swipe: one line and 3 over; a 15 px tick after a pause
    // makes 18 px: one line, not two.
    expect(
      feed([
        [10, 0],
        [10, 16],
        [15, 200],
      ]),
    ).toEqual([1, 0, 1]);
  });

  it("lines and pages are counted in lines", () => {
    expect(feed([[3, 0]], 1)).toEqual([3]);
    expect(feed([[1, 0]], 2)).toEqual([40]);
  });
});
