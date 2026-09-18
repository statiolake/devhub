/**
 * The zoom's arithmetic, which is the whole of what it decides.
 *
 * Everything else about the feature is plumbing: which key, which page, which
 * file. What size the text ends up is decided here and nowhere else, so the
 * range, the steps and the reset are asserted against the one function each.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  isTerminalZoomOffset,
  nextTerminalZoomOffset,
  zoomedTerminalFontSize,
} from "./terminalZoom.js";

const BASE = 13;

/** Zoom from the base, one direction, n times. */
function after(
  base: number,
  direction: "in" | "out" | "reset",
  times: number,
): number {
  let offset = 0;
  for (let i = 0; i < times; i += 1) {
    offset = nextTerminalZoomOffset(base, offset, direction);
  }
  return offset;
}

describe("the Agent panes' zoom", () => {
  it("steps one pixel at a time, in both directions", () => {
    expect(zoomedTerminalFontSize(BASE, after(BASE, "in", 3))).toBe(16);
    expect(zoomedTerminalFontSize(BASE, after(BASE, "out", 2))).toBe(11);
  });

  it("stops at the ends of the range the setting has", () => {
    expect(zoomedTerminalFontSize(BASE, after(BASE, "in", 100))).toBe(
      MAX_TERMINAL_FONT_SIZE,
    );
    expect(zoomedTerminalFontSize(BASE, after(BASE, "out", 100))).toBe(
      MIN_TERMINAL_FONT_SIZE,
    );
  });

  /**
   * The reason the step is worked out from the size and not from the offset.
   *
   * An offset that went on growing past the ceiling would spend the first ten
   * zoom-outs going nowhere, which reads as a key that stopped working.
   */
  it("comes straight back from an end on the first step the other way", () => {
    const ceiling = after(BASE, "in", 100);
    const back = nextTerminalZoomOffset(BASE, ceiling, "out");
    expect(zoomedTerminalFontSize(BASE, back)).toBe(MAX_TERMINAL_FONT_SIZE - 1);
  });

  it("resets to the size the settings name, whatever the base is", () => {
    expect(nextTerminalZoomOffset(BASE, after(BASE, "in", 4), "reset")).toBe(0);
    expect(zoomedTerminalFontSize(20, 0)).toBe(20);
  });

  /**
   * The zoom is relative, so a setting that moves takes the zoomed text with
   * it: two steps up is two steps up from whatever the person now calls
   * normal.
   */
  it("is measured from the setting, not from a size it copied", () => {
    const offset = after(11, "in", 2);
    expect(zoomedTerminalFontSize(11, offset)).toBe(13);
    expect(zoomedTerminalFontSize(18, offset)).toBe(20);
  });

  it("knows an offset that cannot name any size", () => {
    expect(isTerminalZoomOffset(0)).toBe(true);
    expect(isTerminalZoomOffset(-15)).toBe(true);
    expect(isTerminalZoomOffset(16)).toBe(false);
    expect(isTerminalZoomOffset(1.5)).toBe(false);
    expect(isTerminalZoomOffset(Number.NaN)).toBe(false);
  });

  /** Every step this can produce is a size the appearance projection allows. */
  it("never leaves the range the projection is validated against", () => {
    for (
      let base = MIN_TERMINAL_FONT_SIZE;
      base <= MAX_TERMINAL_FONT_SIZE;
      base += 1
    ) {
      for (const direction of ["in", "out"] as const) {
        for (let times = 0; times <= 40; times += 1) {
          const size = zoomedTerminalFontSize(
            base,
            after(base, direction, times),
          );
          expect(size).toBeGreaterThanOrEqual(MIN_TERMINAL_FONT_SIZE);
          expect(size).toBeLessThanOrEqual(MAX_TERMINAL_FONT_SIZE);
        }
      }
    }
  });
});
