/**
 * The one rule every usage meter colours by: quiet below 75%, the warning ink
 * from 75%, the danger ink from 90%.
 */

import { describe, expect, it } from "vitest";
import { usageLevel } from "./usageLevel";

describe("usageLevel", () => {
  it("is calm below 75% and when nothing was reported", () => {
    expect(usageLevel(undefined)).toBe("calm");
    expect(usageLevel(0)).toBe("calm");
    expect(usageLevel(74.9)).toBe("calm");
  });

  it("is near from 75% up to 90%", () => {
    expect(usageLevel(75)).toBe("near");
    expect(usageLevel(89.9)).toBe("near");
  });

  it("is at its end from 90%", () => {
    expect(usageLevel(90)).toBe("at");
    expect(usageLevel(100)).toBe("at");
    expect(usageLevel(120)).toBe("at");
  });
});
