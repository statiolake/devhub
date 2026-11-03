/**
 * The words for when a rate-limit window resets: the time while the reset is
 * within twelve hours of now — across midnight too — and the date alone beyond
 * that, a weekly or monthly window alike. The clock and the time zone are both
 * pinned here.
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

  it("says the time, on the 24-hour clock, for a reset within 12 hours", () => {
    expect(resetTime(tokyo(9, 27, 16, 50), now)).toBe("16:50");
    expect(resetTime(tokyo(9, 27, 23, 59), now)).toBe("23:59");
  });

  it("says the time for a reset past midnight still within 12 hours", () => {
    const lateEvening = tokyo(9, 27, 21, 10);
    expect(resetTime(tokyo(9, 28, 0, 0), lateEvening)).toBe("00:00");
    // 11h 59m ahead, on the next calendar day.
    expect(resetTime(tokyo(9, 28, 9, 9), lateEvening)).toBe("09:09");
  });

  it("says the date alone once the reset is more than 12 hours away", () => {
    const lateEvening = tokyo(9, 27, 21, 10);
    // 12h 01m ahead.
    expect(resetTime(tokyo(9, 28, 9, 11), lateEvening)).toBe("9/28");
    // Later the same day, but 12h 01m ahead.
    const earlyMorning = tokyo(9, 27, 0, 30);
    expect(resetTime(tokyo(9, 27, 12, 31), earlyMorning)).toBe("9/27");
    expect(resetTime(tokyo(9, 30, 9, 18), now)).toBe("9/30");
    expect(resetTime(tokyo(10, 3, 16, 50), now)).toBe("10/3");
    expect(resetTime(tokyo(10, 27, 0, 0), now)).toBe("10/27");
  });

  it("words a reset already past by the same distance", () => {
    expect(resetTime(tokyo(9, 27, 2, 6), now)).toBe("02:06");
    expect(resetTime(tokyo(9, 27, 2, 4), now)).toBe("9/27");
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
