import { describe, expect, it } from "vitest";
import { PaintHold } from "./paintHold";

describe("a Neovim's paints held for its pane's motion", () => {
  it("paints at once when nothing holds it", () => {
    const hold = new PaintHold();
    expect(hold.defer(false)).toBe(false);
    expect(hold.release()).toBeUndefined();
  });

  it("takes each flush in and tells of it, drawing nothing until let go", () => {
    const hold = new PaintHold();
    let heard = 0;
    hold.hold(() => (heard += 1));
    hold.flushed();
    expect(heard).toBe(1);
    expect(hold.defer(false)).toBe(true);
    expect(hold.defer(true)).toBe(true);
    expect(hold.defer(false)).toBe(true);
    // One paint waited, a full one since one asked for it.
    expect(hold.release()).toEqual({ force: true });
    expect(hold.holding).toBe(false);
    hold.flushed();
    expect(heard).toBe(1);
    expect(hold.defer(false)).toBe(false);
  });

  it("has nothing to draw when no paint was asked while held", () => {
    const hold = new PaintHold();
    hold.hold(() => undefined);
    expect(hold.release()).toBeUndefined();
  });
});
