import { describe, expect, it } from "vitest";
import { foldTabs } from "./WindowStrip";

describe("the window tabs when they do not fit", () => {
  const full = [100, 80, 90, 110, 120];
  const folded = [20, 20, 20, 20, 20];

  it("folds nothing when the row fits", () => {
    const out = foldTabs(full, folded, 0, 1000, 2);
    expect([...out.folded]).toEqual([]);
    expect(out.fits).toBe(true);
  });

  it("folds the inactive tabs farthest from the active one first", () => {
    // 508 wide: folding 4 (-100) then 3 (-90) gets to 318.
    const out = foldTabs(full, folded, 0, 330, 2);
    expect([...out.folded]).toEqual([4, 3]);
    expect(out.fits).toBe(true);
  });

  it("never folds the active one, and says when even folded is too wide", () => {
    const out = foldTabs(full, folded, 3, 100, 2);
    expect(out.folded.has(3)).toBe(false);
    expect(out.folded.size).toBe(4);
    expect(out.fits).toBe(false);
  });
});
