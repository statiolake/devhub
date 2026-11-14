import { describe, expect, it } from "vitest";
import {
  easeTo,
  frame,
  movedTo,
  moving,
  newMotion,
  shownAt,
  wheelBy,
} from "./documentMotion";
import { EASE_MS, GLIDE_MS } from "./smoothScroll";

const VIEW = 400;
const MAX = 5000;
const LINE = 24;

/** Every frame from `from` to `to` ms, 8 ms apart: where it was shown. */
function frames(m: ReturnType<typeof newMotion>, from: number, to: number) {
  const out: number[] = [];
  for (let t = from; t <= to; t += 8) {
    frame(m, t);
    out.push(m.top);
  }
  return out;
}

describe("a document's scroll in motion", () => {
  it("eases a key's scroll in EASE_MS, one way, and settles exactly", () => {
    const m = newMotion(100);
    easeTo(m, 300, 0, VIEW, MAX, "page");
    expect(m.top).toBe(100);
    const shown = frames(m, 8, EASE_MS + 16);
    for (let i = 1; i < shown.length; i += 1)
      expect(shown[i]!).toBeGreaterThanOrEqual(shown[i - 1]!);
    expect(shown[0]!).toBeGreaterThan(100);
    expect(shown.at(-1)).toBe(300);
    expect(moving(m)).toBe(false);
  });

  it("turns mid-way from where it is shown, without a jump", () => {
    const m = newMotion(0);
    easeTo(m, 300, 0, VIEW, MAX, "page");
    frame(m, 40);
    const at = m.top;
    easeTo(m, 100, 40, VIEW, MAX, "page");
    expect(m.top).toBeCloseTo(at, 6);
    frame(m, 41);
    expect(Math.abs(m.top - at)).toBeLessThan(10);
    frames(m, 48, 40 + EASE_MS + 8);
    expect(m.top).toBe(100);
    // A second key while the first moves goes on from where it was going.
    easeTo(m, m.to + 72, 200, VIEW, MAX, "page");
    easeTo(m, m.to + 72, 210, VIEW, MAX, "page");
    frames(m, 216, 210 + EASE_MS + 8);
    expect(m.top).toBe(244);
  });

  it("slides only the last screen of a far scroll in, and stays in the drawing", () => {
    const m = newMotion(0);
    easeTo(m, 4000, 0, VIEW, MAX, "page");
    expect(m.top).toBe(3600);
    easeTo(m, 99999, 0, VIEW, MAX, "page");
    expect(m.to).toBe(MAX);
    easeTo(m, -50, 0, VIEW, MAX, "page");
    expect(m.to).toBe(0);
  });

  it("places it at once under Reduce Motion", () => {
    const m = newMotion(0);
    easeTo(m, 300, 0, VIEW, MAX, "page", false);
    expect([m.top, moving(m)]).toEqual([300, false]);
    wheelBy(m, 4, 10, LINE, MAX, false);
    expect([m.top, moving(m)]).toEqual([324, false]);
  });

  it("moves a wheel tick a line at least, gliding, and its next pixels pay it back", () => {
    const m = newMotion(0);
    wheelBy(m, 4, 0, LINE, MAX);
    expect(m.to).toBe(LINE);
    expect(m.top).toBe(0);
    expect(shownAt(m, GLIDE_MS / 4)).toBeGreaterThan(0);
    // The swipe goes on: 20 px owed, then its own pixels.
    wheelBy(m, 10, 16, LINE, MAX);
    wheelBy(m, 10, 32, LINE, MAX);
    expect(m.to).toBe(LINE);
    wheelBy(m, 10, 48, LINE, MAX);
    expect(m.to).toBe(LINE + 10);
    frames(m, 56, 48 + GLIDE_MS + 8);
    expect(m.top).toBe(LINE + 10);
    // After a pause, a tick again; the other way, a tick at once.
    const later = 48 + GLIDE_MS + 100;
    wheelBy(m, 2, later, LINE, MAX);
    expect(m.to).toBe(LINE + 10 + LINE);
    wheelBy(m, -2, later + 8, LINE, MAX);
    expect(m.to).toBe(LINE + 10);
  });

  it("follows a swipe pixel for pixel once its tick has glided in", () => {
    const m = newMotion(0);
    let t = 0;
    wheelBy(m, 30, t, LINE, MAX);
    for (t = 16; t <= GLIDE_MS + 16; t += 16) {
      frame(m, t);
      wheelBy(m, 10, t, LINE, MAX);
    }
    frame(m, t);
    expect(moving(m)).toBe(false);
    const at = m.top;
    wheelBy(m, 7, t, LINE, MAX);
    expect([m.top, moving(m)]).toEqual([at + 7, false]);
  });

  it("turns a glide toward a notch that comes mid-way, without a jump", () => {
    const m = newMotion(0);
    wheelBy(m, 120, 0, LINE, MAX);
    frame(m, 30);
    const at = m.top;
    wheelBy(m, 120, 31, LINE, MAX);
    expect(m.to).toBe(240);
    expect(m.top - at).toBeLessThan(5);
    // No step back, none past the end.
    const shown = [at, ...frames(m, 32, 31 + GLIDE_MS + 8)];
    for (let i = 1; i < shown.length; i += 1)
      expect(shown[i]!).toBeGreaterThanOrEqual(shown[i - 1]!);
    expect(shown.at(-1)).toBe(240);
  });

  it("takes a move it did not make (the scroll bar) as where it is", () => {
    const m = newMotion(0);
    easeTo(m, 300, 0, VIEW, MAX, "follow");
    movedTo(m, 1234);
    expect([m.top, m.to, moving(m), m.cause]).toEqual([
      1234,
      1234,
      false,
      "page",
    ]);
  });
});
