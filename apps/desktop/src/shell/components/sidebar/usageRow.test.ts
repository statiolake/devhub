/**
 * What a CLI's rate-limit row shows: its shortest window, as reset once its
 * last reading's reset has passed, coloured by the strictest window, with a
 * caption naming that window when it is not the shown one.
 */

import { describe, expect, it } from "vitest";
import { usageRow } from "./usageRow";

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("a usage row", () => {
  it("shows the shortest window, even when a longer one resets sooner", () => {
    const five = {
      window: "5-hour",
      usedPercent: 12,
      resetsAt: NOW + 4 * HOUR,
    };
    const seven = { window: "7-day", usedPercent: 40, resetsAt: NOW + HOUR };
    expect(usageRow([seven, five], NOW)).toEqual({
      window: "5-hour",
      usedPercent: 12,
      resetsAt: NOW + 4 * HOUR,
      stale: false,
      level: "calm",
      caption: undefined,
    });
  });

  it("shows the shortest window as reset when its last reading's reset has passed, not the longer one", () => {
    const five = { window: "5-hour", usedPercent: 99, resetsAt: NOW - HOUR };
    const seven = {
      window: "7-day",
      usedPercent: 30,
      resetsAt: NOW + 50 * HOUR,
    };
    expect(usageRow([five, seven], NOW)).toEqual({
      window: "5-hour",
      usedPercent: 0,
      resetsAt: undefined,
      stale: true,
      level: "calm",
      caption: undefined,
    });
    // Every reading history: still the shortest, reset, and calm.
    expect(
      usageRow([{ ...seven, usedPercent: 95, resetsAt: NOW - 1 }, five], NOW),
    ).toEqual({
      window: "5-hour",
      usedPercent: 0,
      resetsAt: undefined,
      stale: true,
      level: "calm",
      caption: undefined,
    });
    expect(usageRow([], NOW)).toBeUndefined();
  });

  it("takes the strictest colour of every window and names the one it comes from, the shown one reset or not", () => {
    const five = { window: "5-hour", usedPercent: 12, resetsAt: NOW + HOUR };
    const near = { window: "7-day", usedPercent: 80, resetsAt: NOW + 9 * HOUR };
    expect(usageRow([near, five], NOW)).toMatchObject({
      window: "5-hour",
      level: "near",
      caption: "Approaching 7-day limit",
    });
    const reset = { ...five, usedPercent: 91, resetsAt: NOW - HOUR };
    const at = { ...near, usedPercent: 95 };
    expect(usageRow([reset, at], NOW)).toMatchObject({
      window: "5-hour",
      usedPercent: 0,
      stale: true,
      level: "at",
      caption: "7-day limit nearly reached",
    });
  });

  it("says no caption when the shown window is itself the strictest", () => {
    const five = { window: "5-hour", usedPercent: 91, resetsAt: NOW + HOUR };
    const seven = {
      window: "7-day",
      usedPercent: 93,
      resetsAt: NOW + 50 * HOUR,
    };
    expect(usageRow([five, seven], NOW)).toMatchObject({
      window: "5-hour",
      level: "at",
      caption: undefined,
    });
  });

  it("orders Codex's windows by the length they are named by, and one of no known length last", () => {
    // Codex names a window by its windowDurationMins, or by its slot when the
    // length is not said.
    const day = { window: "1-day", usedPercent: 5, resetsAt: NOW + HOUR };
    const minutes = {
      window: "90-minute",
      usedPercent: 60,
      resetsAt: NOW + 2 * HOUR,
    };
    const secondary = { window: "secondary", usedPercent: 10 };
    expect(usageRow([secondary, day, minutes], NOW)?.window).toBe("90-minute");
    expect(usageRow([secondary, day], NOW)?.window).toBe("1-day");
    const primary = { window: "primary", usedPercent: 50 };
    expect(usageRow([primary, secondary], NOW)?.window).toBe("primary");
  });
});
