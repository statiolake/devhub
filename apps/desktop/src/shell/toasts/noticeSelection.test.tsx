// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isSelectable } from "../selection";

describe("a notice's words", () => {
  it("can be selected by dragging; the buttons around them cannot", () => {
    document.body.innerHTML =
      '<div class="toast"><p class="toast-summary">a</p><p class="toast-detail">b</p><button class="toast-action">x</button></div>';
    expect(isSelectable(document.querySelector(".toast-summary"))).toBe(true);
    expect(isSelectable(document.querySelector(".toast-detail"))).toBe(true);
    expect(isSelectable(document.querySelector(".toast-action"))).toBe(false);
  });
});
