/**
 * What a CLI's rate-limit row shows: the window that resets soonest, coloured
 * by the strictest current window, with a caption naming that window when it
 * is not the shown one.
 */

import { describe, expect, it } from "vitest";
import { usageRow } from "./usageRow";

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("a usage row", () => {
  it("shows the window that resets soonest, whatever the others' use", () => {
    const five = { window: "5-hour", usedPercent: 12, resetsAt: NOW + HOUR };
    const seven = {
      window: "7-day",
      usedPercent: 40,
      resetsAt: NOW + 50 * HOUR,
    };
    expect(usageRow([seven, five], NOW)).toEqual({
      window: five,
      stale: false,
      level: "calm",
      caption: undefined,
    });
  });

  it("takes the strictest colour of every current window and names the one it comes from", () => {
    const five = { window: "5-hour", usedPercent: 12, resetsAt: NOW + HOUR };
    const near = { window: "7-day", usedPercent: 80, resetsAt: NOW + 9 * HOUR };
    expect(usageRow([five, near], NOW)).toMatchObject({
      window: five,
      level: "near",
      caption: "Approaching 7-day limit",
    });
    const at = { window: "secondary", usedPercent: 95, resetsAt: undefined };
    expect(usageRow([five, near, at], NOW)).toMatchObject({
      window: five,
      level: "at",
      caption: "Secondary limit nearly reached",
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
      window: five,
      level: "at",
      caption: undefined,
    });
  });

  it("puts a window with no known reset after every one whose reset is known", () => {
    const unknown = { window: "weekly", usedPercent: 50 };
    const known = { window: "5-hour", usedPercent: 10, resetsAt: NOW + HOUR };
    expect(usageRow([unknown, known], NOW)?.window).toBe(known);
    expect(usageRow([unknown], NOW)?.window).toBe(unknown);
  });

  it("leaves history out of both the shown window and the colour", () => {
    const past = { window: "5-hour", usedPercent: 99, resetsAt: NOW - HOUR };
    const seven = {
      window: "7-day",
      usedPercent: 30,
      resetsAt: NOW + 50 * HOUR,
    };
    expect(usageRow([past, seven], NOW)).toEqual({
      window: seven,
      stale: false,
      level: "calm",
      caption: undefined,
    });
  });

  it("shows the reading nearest its limit, faded and calm, when every reading is history", () => {
    const five = { window: "5-hour", usedPercent: 96, resetsAt: NOW - HOUR };
    const seven = { window: "7-day", usedPercent: 20, resetsAt: NOW - 1 };
    expect(usageRow([seven, five], NOW)).toEqual({
      window: five,
      stale: true,
      level: "calm",
      caption: undefined,
    });
    expect(usageRow([], NOW)).toBeUndefined();
  });
});
