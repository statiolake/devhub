// @vitest-environment jsdom

/**
 * What a window that goes keeps showing of what the page drew over it
 * (`domPicture`): a copy, scrolled as the original was, inert, without
 * frames, and nobody's — the original can go without taking it.
 */
import { describe, expect, it } from "vitest";
import { domPicture, putPicture } from "./domPicture";

function view(): { clip: HTMLElement; scroller: HTMLElement } {
  const clip = document.createElement("div");
  clip.className = "nvim-clip nvim-clip-covers";
  clip.style.left = "4px";
  clip.style.zIndex = "7";
  const scroller = document.createElement("div");
  scroller.className = "nvim-view-scroll";
  scroller.style.overflow = "auto";
  for (let i = 0; i < 3; i++) {
    const row = document.createElement("div");
    row.className = "nvim-view-item";
    row.textContent = `row ${String(i)}`;
    scroller.append(row);
  }
  const frame = document.createElement("iframe");
  clip.append(scroller, frame);
  document.body.append(clip);
  return { clip, scroller };
}

describe("a picture of what the page drew", () => {
  it("copies the elements, their styles and where they are scrolled", () => {
    const { clip, scroller } = view();
    scroller.scrollTop = 40;
    const copy = domPicture(clip);
    expect(copy).not.toBe(clip);
    expect(copy.style.left).toBe("4px");
    expect(copy.style.zIndex).toBe("7");
    expect(copy.querySelectorAll(".nvim-view-item")).toHaveLength(3);
    expect(copy.querySelector("iframe")).toBeNull();
    expect(copy.inert).toBe(true);
    const parent = document.createElement("div");
    document.body.append(parent);
    putPicture(parent, copy);
    expect(copy.parentElement).toBe(parent);
    expect(
      (copy.querySelector(".nvim-view-scroll") as HTMLElement).scrollTop,
    ).toBe(40);
  });

  it("stays when the original goes (React letting go of its tree)", () => {
    const { clip } = view();
    const copy = domPicture(clip);
    const parent = document.createElement("div");
    document.body.append(parent);
    putPicture(parent, copy);
    clip.remove();
    clip.replaceChildren();
    expect(copy.isConnected).toBe(true);
    expect(copy.querySelectorAll(".nvim-view-item")).toHaveLength(3);
  });
});
