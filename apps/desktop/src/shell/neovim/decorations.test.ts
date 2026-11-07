import { describe, expect, it } from "vitest";
import {
  NO_DECORATIONS,
  applyGuiEvent,
  dismissToast,
  richScrollFraction,
} from "./decorations";

describe("devhub_gui's events on the page", () => {
  it("keeps toasts, newest last, at most four, with a level's timeout", () => {
    let state = NO_DECORATIONS;
    for (let i = 0; i < 5; i += 1) {
      state = applyGuiEvent(state, "notify", {
        title: "t",
        msg: `m${String(i)}`,
        level: i === 4 ? "error" : "bogus",
      });
    }
    expect(state.toasts.map((t) => t.msg)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(state.toasts.at(-1)).toMatchObject({
      level: "error",
      timeout: 8000,
    });
    expect(state.toasts[0]?.level).toBe("info");
    state = dismissToast(state, state.toasts[0]!.key);
    expect(state.toasts).toHaveLength(3);
    expect(applyGuiEvent(state, "notify", { msg: "" })).toBe(state);
  });

  it("takes images only as data or https, and places them by window", () => {
    let state = applyGuiEvent(NO_DECORATIONS, "image", {
      id: 3,
      src: "file:///etc/passwd",
    });
    expect(state.images.size).toBe(0);
    state = applyGuiEvent(state, "image", {
      id: 3,
      src: "data:image/png;base64,AAAA",
    });
    state = applyGuiEvent(state, "place", {
      images: [
        { id: 3, win: 1000, row: 2, col: 4, width: 40, rows: 3, full: 8 },
        { id: 3, win: 1001, row: 2 },
      ],
      rich: {},
    });
    expect(state.placedImages).toEqual([
      { id: 3, win: 1000, row: 2, col: 4, width: 40, rows: 3, full: 8 },
    ]);
    expect(state.placedRich).toEqual([]);
    state = applyGuiEvent(state, "image_clear", { id: 3 });
    expect(state.images.size).toBe(0);
  });

  it("scrolls a rich float as Neovim scrolls its window", () => {
    const place = {
      id: 1,
      win: 1002,
      topline: 1,
      lines: 30,
      height: 10,
      border: true,
    };
    expect(richScrollFraction(place)).toBe(0);
    expect(richScrollFraction({ ...place, topline: 21 })).toBe(1);
    expect(richScrollFraction({ ...place, topline: 11 })).toBe(0.5);
    expect(richScrollFraction({ ...place, lines: 5 })).toBe(0);
  });
});
