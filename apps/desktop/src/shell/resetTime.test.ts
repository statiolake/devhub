/**
 * The words for when a rate-limit window resets: the time while the reset is
 * later the same local day, the date alone from the next day on — however far,
 * a weekly or monthly window alike. Days are local calendar days, so the clock
 * and the time zone are both pinned here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetsIn, resetTime } from "./resetTime";

let zone: string | undefined;
beforeAll(() => {
  zone = process.env["TZ"];
  process.env["TZ"] = "Asia/Tokyo";
});
afterAll(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

/** A local moment in Tokyo (UTC+9, no daylight saving). */
function tokyo(month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, month - 1, day, hour - 9, minute);
}

describe("resetTime", () => {
  const now = tokyo(9, 27, 14, 5);

  it("says the time, on the 24-hour clock, for a reset later today", () => {
    expect(resetTime(tokyo(9, 27, 16, 50), now)).toBe("16:50");
    expect(resetTime(tokyo(9, 27, 23, 59), now)).toBe("23:59");
  });

  it("says the date alone from the next local day on", () => {
    expect(resetTime(tokyo(9, 28, 0, 0), now)).toBe("9/28");
    expect(resetTime(tokyo(9, 30, 9, 18), now)).toBe("9/30");
    expect(resetTime(tokyo(10, 3, 16, 50), now)).toBe("10/3");
    expect(resetTime(tokyo(10, 27, 0, 0), now)).toBe("10/27");
  });

  it("counts days on the local calendar, not in 24-hour spans from now", () => {
    const lateEvening = tokyo(9, 27, 23, 30);
    expect(resetTime(tokyo(9, 28, 0, 30), lateEvening)).toBe("9/28");
    const pastMidnight = tokyo(9, 28, 0, 10);
    expect(resetTime(tokyo(9, 28, 23, 50), pastMidnight)).toBe("23:50");
  });

  it("words a reset already past the same way", () => {
    expect(resetTime(tokyo(9, 27, 9, 0), now)).toBe("09:00");
    expect(resetTime(tokyo(9, 26, 9, 0), now)).toBe("9/26");
  });
});

describe("resetsIn", () => {
  const now = tokyo(9, 27, 14, 0);
  it("says how long in the largest two units", () => {
    expect(resetsIn(now + 30_000, now)).toBe("in under a minute");
    expect(resetsIn(tokyo(9, 27, 14, 12), now)).toBe("in 12m");
    expect(resetsIn(tokyo(9, 27, 16, 10), now)).toBe("in 2h 10m");
    expect(resetsIn(tokyo(9, 30, 18, 0), now)).toBe("in 3d 4h");
  });
});
