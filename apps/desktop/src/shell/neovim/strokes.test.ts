import { describe, expect, it } from "vitest";
import { strokesFor } from "./strokes";

describe("underlines and strikethrough", () => {
  const args = [0, 70, 18, 18, 13, 13, 2] as const;

  it("are as thick as the face asks, on device pixels under the baseline", () => {
    const [line] = strokesFor("underline", ...args);
    expect(line?.width).toBe(1);
    // A device pixel's middle, below the baseline (31), within the row.
    expect(line?.y).toBeGreaterThan(31);
    expect(line?.y).toBeLessThan(36);
    expect(((line?.y ?? 0) * 2) % 1).toBe(0);
  });

  it("draw undercurl as one wave in the row's phase", () => {
    const [a] = strokesFor("undercurl", 0, 35, 18, 18, 13, 13, 2);
    const [b] = strokesFor("undercurl", 35, 70, 18, 18, 13, 13, 2);
    const lastA = a?.points?.at(-1);
    const firstB = b?.points?.[0];
    expect(lastA?.[0]).toBe(firstB?.[0]);
    expect(lastA?.[1]).toBeCloseTo(firstB?.[1] ?? NaN, 6);
    const ys = (a?.points ?? []).map(([, y]) => y);
    expect(Math.max(...ys)).toBeLessThanOrEqual(36);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1);
  });

  it("keeps two lines apart for underdouble and strikes through the letters", () => {
    const [top, bottom] = strokesFor("underdouble", ...args);
    expect((bottom?.y ?? 0) - (top?.y ?? 0)).toBeGreaterThanOrEqual(1);
    const [strike] = strokesFor("strikethrough", ...args);
    expect(strike?.y).toBeLessThan(31);
    expect(strike?.y).toBeGreaterThan(18);
    expect(strokesFor("underdotted", ...args)[0]?.round).toBe(true);
  });
});
