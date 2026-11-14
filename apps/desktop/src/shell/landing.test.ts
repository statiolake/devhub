import { describe, expect, it } from "vitest";
import {
  LAND_MIN_MS,
  aheadOf,
  easeOutLanding,
  land,
  landMaxMs,
  landingAt,
  moved,
  retarget,
  type Landing,
} from "./landing";

/** The landing's place every `dt` ms from its start to its end. */
function path(l: Landing, dt = 1): number[] {
  const out: number[] = [];
  for (let t = l.start; t <= l.start + l.ms + dt; t += dt)
    out.push(landingAt(l, t).pos);
  return out;
}

describe("a landing", () => {
  it("leaves at the motion's speed and arrives at rest, exactly", () => {
    const l = land(0, 0.3, 60, 100);
    expect(landingAt(l, 100).pos).toBe(0);
    expect(landingAt(l, 100).vel).toBeCloseTo(0.3, 9);
    const end = landingAt(l, 100 + l.ms - 1e-6);
    expect(end.pos).toBeCloseTo(60, 4);
    expect(end.vel).toBeCloseTo(0, 4);
    expect(landingAt(l, 100 + l.ms)).toEqual({ pos: 60, vel: 0, done: true });
  });

  it("only slows down on the way, never back, never past", () => {
    for (const [v, d] of [
      [0.3, 60],
      [2, 15],
      [0.05, 15],
      [1, 7],
      [0.6, 120],
    ] as const) {
      const l = land(0, v, d, 0);
      const ps = path(l);
      for (let i = 1; i < ps.length; i += 1) {
        expect(ps[i]!).toBeGreaterThanOrEqual(ps[i - 1]! - 1e-9);
        expect(ps[i]!).toBeLessThanOrEqual(d + 1e-9);
      }
      // Its speed decreasing from the start, unless it started slower than
      // it can get there in its longest time.
      if (v * l.ms >= 1.5 * d) {
        let last = Infinity;
        for (let t = 0; t < l.ms; t += 1) {
          const { vel } = landingAt(l, t);
          expect(vel).toBeLessThanOrEqual(last + 1e-9);
          last = vel;
        }
      }
    }
  });

  it("takes as long as its speed asks, within its bounds", () => {
    // 40 px at 0.3 px/ms: 2.5 times its mean speed's time, 333 ms.
    expect(land(0, 0.3, 40, 0).ms).toBeCloseTo(1000 / 3, 6);
    // 60 px: as long as 60 px may take.
    expect(land(0, 0.3, 60, 0).ms).toBe(landMaxMs(60));
    // A fast motion stopping a few pixels on: the shortest, as an ease-out.
    const quick = land(0, 5, 6, 0);
    expect(quick.ms).toBe(LAND_MIN_MS);
    expect(quick.slope).toBe(18);
    // From rest: the longest for its distance, from no speed.
    const still = land(0, 0, 15, 0);
    expect(still.ms).toBe(landMaxMs(15));
    expect(landingAt(still, 0).vel).toBe(0);
  });

  it("goes up as down, and a speed away from its target counts as none", () => {
    const up = land(0, -0.3, -60, 0);
    expect(landingAt(up, up.ms / 2).pos).toBeLessThan(0);
    expect(landingAt(up, 0).vel).toBeCloseTo(-0.3, 9);
    const against = land(0, 0.5, -15, 0);
    expect(landingAt(against, 0).vel).toBeCloseTo(0, 9);
  });

  it("is retargeted from where and how fast it is: no jump in either", () => {
    const l = land(0, 0.4, 80, 0);
    const at = landingAt(l, 120);
    const r = retarget(l, 120, 120);
    const now = landingAt(r, 120);
    expect(now.pos).toBeCloseTo(at.pos, 9);
    expect(now.vel).toBeCloseTo(at.vel, 9);
    expect(landingAt(r, 120 + r.ms).pos).toBe(120);
  });

  it("moves with the frame it is measured in", () => {
    const l = moved(land(-30, 0.2, 0, 0), 20);
    expect(l.from).toBe(-10);
    expect(l.to).toBe(20);
  });

  it("from rest at its own pace is the ease-out cubic", () => {
    const l = easeOutLanding(10, 70, 0, 120);
    for (let t = 0; t <= 120; t += 7) {
      const s = t / 120;
      expect(landingAt(l, t).pos).toBeCloseTo(10 + 60 * (1 - (1 - s) ** 3), 9);
    }
  });

  it("of no distance is over at once", () => {
    expect(landingAt(land(40, 1, 40, 0), 0)).toEqual({
      pos: 40,
      vel: 0,
      done: true,
    });
  });
});

describe("the place ahead", () => {
  it("rounds the way the motion goes, never back", () => {
    expect(aheadOf(31, 15, 1)).toBe(45);
    expect(aheadOf(31, 15, -1)).toBe(30);
    expect(aheadOf(-31, 15, 1)).toBe(-30);
    expect(aheadOf(-31, 15, -1)).toBe(-45);
    expect(aheadOf(30, 15, 1)).toBe(30);
    expect(aheadOf(30.00000001, 15, 1)).toBe(30);
    expect(aheadOf(37, 15, 0)).toBe(30);
  });
});
