import { describe, expect, it } from "vitest";
import {
  NO_DECORATIONS,
  applyGuiEvent,
  dismissToast,
  toastGroups,
} from "./decorations";

describe("devhub_gui's events on the page", () => {
  it("keeps notifications, newest last, at most eight, with a level's timeout", () => {
    let state = NO_DECORATIONS;
    for (let i = 0; i < 9; i += 1) {
      state = applyGuiEvent(state, "notify", {
        title: "t",
        msg: `m${String(i)}`,
        level: i === 8 ? "error" : "bogus",
      });
    }
    expect(state.toasts.map((t) => t.msg)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
    ]);
    expect(state.toasts.at(-1)).toMatchObject({
      level: "error",
      timeout: 8000,
    });
    expect(state.toasts[0]?.level).toBe("info");
    state = dismissToast(state, state.toasts[0]!.key);
    expect(state.toasts).toHaveLength(7);
    expect(applyGuiEvent(state, "notify", { msg: "" })).toBe(state);
  });

  it("updates work in progress in place by its key, and groups by source", () => {
    let state = applyGuiEvent(NO_DECORATIONS, "notify", {
      msg: "Indexing",
      group: "lua_ls",
      key: "lsp:1:a",
      progress: true,
      percent: 10,
    });
    state = applyGuiEvent(state, "notify", { msg: "saved", group: "write" });
    state = applyGuiEvent(state, "notify", {
      msg: "Indexing",
      group: "lua_ls",
      key: "lsp:1:a",
      percent: 150,
      done: true,
    });
    expect(state.toasts).toHaveLength(2);
    expect(state.toasts[0]).toMatchObject({
      group: "lua_ls",
      rev: 2,
      timeout: 2000,
      progress: { percent: 100, done: true },
    });
    expect(toastGroups(state.toasts).map((g) => g.group)).toEqual([
      "lua_ls",
      "write",
    ]);
    const running = applyGuiEvent(NO_DECORATIONS, "notify", {
      msg: "x",
      progress: true,
    });
    expect(running.toasts[0]).toMatchObject({
      timeout: 0,
      progress: { percent: undefined, done: false },
    });
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
    });
    expect(state.placedImages).toEqual([
      { id: 3, win: 1000, row: 2, col: 4, width: 40, rows: 3, full: 8 },
    ]);
    state = applyGuiEvent(state, "image_clear", { id: 3 });
    expect(state.images.size).toBe(0);
  });
});
