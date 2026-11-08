import { describe, expect, it } from "vitest";
import {
  EASE_MS,
  WHEEL_IDLE_MS,
  replied,
  coverage,
  isActive,
  newScrollView,
  shifted,
  step,
  wheeled,
} from "./smoothScroll";

const CH = 20;
const ROWS = 40;
const TEXT = ROWS * CH;

describe("pixel scrolling", () => {
  it("asks Neovim for a line ahead before the display can move", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    const request = step(view, 1, CH, ROWS, 2);
    expect(request?.rows).toBe(2);
    // Nothing below the grid yet: the display waits for Neovim.
    expect(view.off).toBe(0);
    shifted(view, 2, CH, TEXT, 20);
    // The old view is the ghost; the display is where the wheel put it.
    expect(view.ghost).toBe(-40);
    step(view, 21, CH, ROWS, 2);
    expect(view.off).toBe(-35);
    expect(coverage(view)).toEqual({ lo: -40, hi: 0 });
  });

  it("follows the wheel pixel for pixel within what is drawn", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    step(view, 0, CH, ROWS, 2);
    shifted(view, 2, CH, TEXT, 10);
    wheeled(view, 3, 16);
    step(view, 16, CH, ROWS, 2);
    expect(view.off).toBe(-32);
    wheeled(view, 3.3, 32);
    step(view, 32, CH, ROWS, 2);
    // Snapped to device pixels (dpr 2).
    expect(view.off).toBe(-28.5);
  });

  it("keeps how far the display went each way, from Neovim's view", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    step(view, 0, CH, ROWS, 2);
    shifted(view, 2, CH, TEXT, 10);
    wheeled(view, 30, 16);
    step(view, 16, CH, ROWS, 2);
    // 35px down from where Neovim was: 5px short of its new topline.
    expect(view.reach).toEqual({ lo: -40, hi: -5 });
    wheeled(view, -20, 32);
    step(view, 32, CH, ROWS, 2);
    expect(view.reach).toEqual({ lo: -40, hi: -5 });
    // A new gesture starts from where the display is.
    wheeled(view, 1, 32 + WHEEL_IDLE_MS + 1);
    expect(view.reach).toEqual({ lo: view.off, hi: view.off });
  });

  it("brings Neovim back to the nearest line at rest, then eases onto it", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    step(view, 0, CH, ROWS, 2);
    shifted(view, 2, CH, TEXT, 10);
    wheeled(view, 3, 16);
    step(view, 16, CH, ROWS, 2);
    expect(view.off).toBe(-32);
    const rest = 16 + WHEEL_IDLE_MS + 1;
    const back = step(view, rest, CH, ROWS, 2);
    expect(back).toEqual({ rows: -2, exact: true });
    shifted(view, -2, CH, TEXT, rest + 10);
    expect(view.off).toBe(8);
    step(view, rest + 11, CH, ROWS, 2);
    step(view, rest + 11 + EASE_MS, CH, ROWS, 2);
    expect(view.off).toBe(0);
    expect(isActive(view)).toBe(false);
  });

  it("eases a key's scroll from the old view without asking anything", () => {
    const view = newScrollView();
    shifted(view, 10, CH, TEXT, 1000);
    expect(view.off).toBe(-200);
    const request = step(view, 1000, CH, ROWS, 2);
    expect(request).toBeUndefined();
    // Already under way on the first frame.
    expect(view.off).toBeGreaterThan(-200);
    step(view, 1000 + EASE_MS, CH, ROWS, 2);
    expect(view.off).toBe(0);
    expect(view.ghost).toBeUndefined();
  });

  it("jumps when Neovim scrolls a whole window or more", () => {
    const view = newScrollView();
    shifted(view, ROWS, CH, TEXT, 0);
    expect(view.off).toBe(0);
    expect(view.ghost).toBeUndefined();
  });

  it("stops at the end of the buffer and turns back at once", () => {
    const view = newScrollView();
    wheeled(view, 30, 0);
    step(view, 0, CH, ROWS, 2);
    replied(view, 0, 0);
    expect(view.stuck).toBe(1);
    expect(view.want).toBe(0);
    wheeled(view, 10, 16);
    expect(step(view, 16, CH, ROWS, 2)).toBeUndefined();
    expect(view.off).toBe(0);
    wheeled(view, -10, 32);
    // As far ahead as the wheel goes in two round trips and a frame
    // (10px a frame, 30ms each way): 58px, and the 10px it asks for.
    expect(step(view, 32, CH, ROWS, 2)?.rows).toBe(-4);
  });

  it("waits for Neovim's answer however long it takes, then for its scroll", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    expect(step(view, 0, CH, ROWS, 2)).toBeDefined();
    // A busy Neovim: no second request while the first is unanswered.
    wheeled(view, 5, 90);
    expect(step(view, 400, CH, ROWS, 2)).toBeUndefined();
    // Its own wheel was sent (not Normal mode) and nothing scrolled.
    replied(view, 2, 400);
    wheeled(view, 5, 410);
    expect(step(view, 410, CH, ROWS, 2)).toBeUndefined();
    wheeled(view, 5, 470);
    expect(step(view, 470, CH, ROWS, 2)).toBeDefined();
  });

  it("asks for as much as a flick needs, less than a window at a time", () => {
    const view = newScrollView();
    wheeled(view, 2000, 0);
    expect(step(view, 0, CH, ROWS, 2)?.rows).toBe(ROWS - 2);
  });
});
