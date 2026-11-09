// @vitest-environment jsdom

/**
 * Following an entry that arrived is shown as a glide, not a jump
 * (`followGlide.ts`, docs/motion.md "Following new entries"): the scroll is
 * at the end at once, and the transcript is drawn where it was seen and let
 * go to its place. jsdom lays nothing out and animates nothing, so the
 * scroller's geometry is set by hand and `animate` is recorded.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLLOW_GLIDE_EASING, FOLLOW_GLIDE_MS } from "./followGlide";
import { draw, installResizeObserver } from "./surfaceTestKit";
import { assistant, put, transcriptOf, user } from "./transcriptFixtures";

interface Recorded {
  readonly frames: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  cancelled: boolean;
  finished: boolean;
}

let glides: Recorded[] = [];
/** What the transcript's computed transform is "now", mid-glide. */
let drawnAt = "none";
let reduced = false;
const originalAnimate = HTMLElement.prototype.animate;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  installResizeObserver();
  glides = [];
  drawnAt = "none";
  reduced = false;
  HTMLElement.prototype.animate = function (
    this: HTMLElement,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    if (!this.classList.contains("conversation-transcript")) {
      return {
        cancel() {},
        finish() {},
        onfinish: null,
      } as unknown as Animation;
    }
    const recorded: Recorded = {
      frames,
      options,
      cancelled: false,
      finished: false,
    };
    glides.push(recorded);
    return {
      cancel() {
        recorded.cancelled = true;
      },
      finish() {
        recorded.finished = true;
      },
      onfinish: null,
    } as unknown as Animation;
  } as HTMLElement["animate"];
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes("reduce"),
    media: query,
  })) as unknown as typeof window.matchMedia;
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if (!(element as Element).classList.contains("conversation-transcript")) {
      return style;
    }
    return new Proxy(style, {
      get: (target, key) =>
        key === "transform" ? drawnAt : (Reflect.get(target, key) as unknown),
    });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  HTMLElement.prototype.animate = originalAnimate;
  window.matchMedia = originalMatchMedia;
});

function scroller(): HTMLElement {
  return document.querySelector<HTMLElement>(".conversation-scroll")!;
}

/** The scroller's geometry, clamped as a browser's is, starting at the end. */
function geometry(element: HTMLElement) {
  let height = 1_000;
  const view = 200;
  let top = height - view;
  Object.defineProperty(element, "clientHeight", { get: () => view });
  Object.defineProperty(element, "scrollHeight", { get: () => height });
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, height - view));
    },
  });
  fireEvent.scroll(element);
  return {
    grow(by: number) {
      height += by;
    },
    wheelTo(value: number) {
      fireEvent.wheel(element, { deltaY: value < top ? -100 : 100 });
      top = value;
      fireEvent.scroll(element);
    },
    get top() {
      return top;
    },
    bottom: () => height - view,
  };
}

const HISTORY = [put(user("u1", "one")), put(assistant("a1", "reply"))];

describe("following an entry that arrives", () => {
  it("draws nothing gliding as the transcript is first drawn", () => {
    draw(transcriptOf(HISTORY));
    expect(glides).toEqual([]);
  });

  it("is at the end at once, drawn where it was seen, and let go to its place", () => {
    const view = draw(transcriptOf(HISTORY));
    const box = geometry(scroller());
    box.grow(64);
    view.redraw(transcriptOf([...HISTORY, put(user("u2", "two"))]));
    // The real scroll position is the end already...
    expect(box.top).toBe(box.bottom());
    // ...and the transcript is shown 64px down, where it was, gliding to none.
    expect(glides).toHaveLength(1);
    expect(glides[0]!.frames).toEqual([
      { transform: "translateY(64px)" },
      { transform: "none" },
    ]);
    expect(glides[0]!.options).toEqual({
      duration: FOLLOW_GLIDE_MS,
      easing: FOLLOW_GLIDE_EASING,
    });
    expect(FOLLOW_GLIDE_MS).toBe(167);
    expect(FOLLOW_GLIDE_EASING).toBe("cubic-bezier(0.55, 0.55, 0, 1)");
  });

  it("starts an interrupting glide from where the running one has it drawn", () => {
    const view = draw(transcriptOf(HISTORY));
    const box = geometry(scroller());
    box.grow(64);
    const two = [...HISTORY, put(user("u2", "two"))];
    view.redraw(transcriptOf(two));
    // A frame or two in, the first glide has the transcript 40px down.
    drawnAt = "matrix(1, 0, 0, 1, 0, 40)";
    box.grow(30);
    view.redraw(transcriptOf([...two, put(assistant("a2", "ok"))]));
    expect(glides).toHaveLength(2);
    expect(glides[0]!.cancelled).toBe(true);
    // Where it was drawn (40) plus how far the scroll moved now (30).
    expect(glides[1]!.frames).toEqual([
      { transform: "translateY(70px)" },
      { transform: "none" },
    ]);
    expect(box.top).toBe(box.bottom());
  });

  it("follows text streaming into an entry by the scroll alone", () => {
    const streaming = (text: string) =>
      transcriptOf([
        ...HISTORY,
        put(assistant("a2", text, { streaming: true })),
      ]);
    const view = draw(transcriptOf(HISTORY));
    const box = geometry(scroller());
    box.grow(40);
    view.redraw(streaming("The"));
    expect(glides).toHaveLength(1);
    box.grow(120);
    view.redraw(streaming("The answer, growing over several lines"));
    // No new glide: the follow is the scroll, and the entry is not new.
    expect(glides).toHaveLength(1);
    expect(box.top).toBe(box.bottom());
  });

  it("does not move a transcript the person has scrolled up in", () => {
    const view = draw(transcriptOf(HISTORY));
    const box = geometry(scroller());
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      box.wheelTo(box.top - 300);
      vi.advanceTimersByTime(1_000);
      const held = box.top;
      box.grow(64);
      view.redraw(transcriptOf([...HISTORY, put(user("u2", "two"))]));
      expect(box.top).toBe(held);
      expect(glides).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("jumps under Reduce Motion", () => {
    reduced = true;
    const view = draw(transcriptOf(HISTORY));
    const box = geometry(scroller());
    box.grow(64);
    view.redraw(transcriptOf([...HISTORY, put(user("u2", "two"))]));
    expect(box.top).toBe(box.bottom());
    expect(glides).toEqual([]);
  });

  it("keeps the transcript in a box that clips what the glide moves past the end", () => {
    draw(transcriptOf(HISTORY));
    const transcript = document.querySelector(".conversation-transcript")!;
    expect(transcript.parentElement).toHaveClass("conversation-follow");
    expect(transcript.parentElement!.parentElement).toBe(scroller());
  });
});
