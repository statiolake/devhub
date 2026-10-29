// @vitest-environment jsdom

/**
 * Following the end of the transcript (`followScroll.ts`): it follows new
 * output while it is at the end, through anything that moves the content
 * without the person scrolling, until the person scrolls away; and a send
 * brings it back.
 *
 * jsdom lays nothing out: the scroller's geometry is set by hand, and the
 * ResizeObserver is a fake whose callbacks the test runs.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markScrollIntent } from "./followScroll";
import { draw } from "./surfaceTestKit";
import { assistant, put, transcriptOf, user } from "./transcriptFixtures";

/** Each observer made, with what it watches, so a test can say "resized". */
const observers: {
  readonly callback: () => void;
  readonly watched: { target: Element; box: string | undefined }[];
}[] = [];

class FakeResizeObserver {
  private readonly entry: (typeof observers)[number];
  constructor(callback: () => void) {
    this.entry = { callback, watched: [] };
    observers.push(this.entry);
  }
  observe(target: Element, options?: ResizeObserverOptions) {
    this.entry.watched.push({ target, box: options?.box });
  }
  unobserve() {}
  disconnect() {
    this.entry.watched.length = 0;
  }
}

/** Every observer watching `target` is told it resized. */
function resized(target: Element) {
  for (const each of observers) {
    if (each.watched.some((watched) => watched.target === target)) {
      each.callback();
    }
  }
}

const original = globalThis.ResizeObserver;
beforeEach(() => {
  observers.length = 0;
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  // The person's wheel, keys and presses count for a moment after: the clock
  // is the test's, so that moment passes only when a test says so.
  vi.useFakeTimers({ toFake: ["performance"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.ResizeObserver = original;
});

/** Long enough for the person's last input to be over. */
function later() {
  vi.advanceTimersByTime(1_000);
}

function scroller(): HTMLElement {
  return document.querySelector<HTMLElement>(".conversation-scroll")!;
}

function transcriptBox(): HTMLElement {
  return document.querySelector<HTMLElement>(".conversation-transcript")!;
}

/**
 * The scroller's geometry, as a browser keeps it: the position is clamped to
 * what the content allows. It starts at the end, and the surface is told so.
 */
function geometry(element: HTMLElement) {
  let height = 1_000;
  let view = 200;
  let top = height - view;
  const clamp = () => {
    top = Math.max(0, Math.min(top, height - view));
  };
  Object.defineProperty(element, "clientHeight", { get: () => view });
  Object.defineProperty(element, "scrollHeight", { get: () => height });
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
      clamp();
    },
  });
  fireEvent.scroll(element);
  return {
    /** Content grows, and nothing has followed it yet. */
    grow(by: number) {
      height += by;
    },
    /** Content shrinks: the position is clamped, and a scroll is due. */
    shrink(by: number) {
      height -= by;
      clamp();
    },
    /** The view gets taller (the composer emptied by a send). */
    widenView(by: number) {
      view += by;
      clamp();
    },
    /** A scroll nobody made (anchoring, a clamp), read now. */
    moved(value = top) {
      top = value;
      clamp();
      fireEvent.scroll(element);
    },
    /** The person turning the wheel to `value`. */
    wheelTo(value: number) {
      fireEvent.wheel(element, { deltaY: value < top ? -100 : 100 });
      top = value;
      clamp();
      fireEvent.scroll(element);
    },
    get top() {
      return top;
    },
    bottom: () => height - view,
  };
}

const first = [put(user("u1", "one")), put(assistant("a1", "reply"))];
const second = [...first, put(user("u2", "two"))];
const third = [...second, put(assistant("a2", "reply again"))];

/** The way back down, whichever label it has; null when it is not offered. */
function wayDown(): HTMLElement | null {
  return screen.queryByRole("button", { name: /^(New output|Latest)$/ });
}

describe("following the end", () => {
  it("follows new output while at the bottom, offering no way down", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    expect(wayDown()).toBeNull();
    expect(scroller()).toHaveAttribute("data-following");
    box.grow(300);
    redraw(transcriptOf(second));
    expect(box.top).toBe(box.bottom());
    expect(wayDown()).toBeNull();
  });

  it("stays at the end when a shrink's scroll is read after something else grew", () => {
    // The send: the composer empties and the "sending" bubble gives way to
    // its echo — the position is clamped up — and before that scroll is read
    // the Smart Buttons' reserve has grown under the last line. Read as a
    // direction, that was the person scrolling up.
    draw(transcriptOf(first));
    const box = geometry(scroller());
    box.widenView(40);
    box.shrink(30);
    box.grow(80);
    box.moved();
    expect(box.top).toBe(box.bottom());
    expect(wayDown()).toBeNull();
  });

  it("stays at the end through growth read late and scroll anchoring, in either direction", () => {
    draw(transcriptOf(first));
    const box = geometry(scroller());
    // A cut message draws its Show all before the scroll event is read.
    box.grow(28);
    box.moved();
    expect(box.top).toBe(box.bottom());
    // Anchoring moving the lines down as something above them is laid out.
    box.grow(300);
    box.moved(box.top + 300);
    expect(box.top).toBe(box.bottom());
    // And up, as something above them shrinks.
    box.moved(box.top - 120);
    expect(box.top).toBe(box.bottom());
    expect(wayDown()).toBeNull();
  });

  it("follows the transcript growing without a new entry, padding included", () => {
    draw(transcriptOf(first));
    const box = geometry(scroller());
    expect(
      observers.some((each) =>
        each.watched.some(
          (watched) =>
            watched.target === transcriptBox() && watched.box === "border-box",
        ),
      ),
    ).toBe(true);
    // A diagram drawn, a picture loaded, the reserve under the last line.
    box.grow(250);
    resized(transcriptBox());
    expect(box.top).toBe(box.bottom());
    // The view resized (the composer grew).
    box.widenView(-60);
    resized(scroller());
    expect(box.top).toBe(box.bottom());
  });

  it("leaves the end when the person turns the wheel up, and holds where they put it", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.wheelTo(box.top - 40);
    expect(wayDown()).toHaveAccessibleName("Latest");
    expect(scroller()).not.toHaveAttribute("data-following");
    later();
    // Away from the end, nothing moves it: not output, not a shrink.
    box.grow(300);
    redraw(transcriptOf(second));
    expect(box.top).toBe(box.bottom() - 340);
    expect(wayDown()).toHaveAccessibleName("New output");
    // A scroll down that is theirs is held where they put it.
    box.wheelTo(box.top + 10);
    expect(box.top).toBe(box.bottom() - 330);
  });

  it("does not leave the end for a wheel turned down at it", () => {
    draw(transcriptOf(first));
    const box = geometry(scroller());
    fireEvent.wheel(scroller(), { deltaY: 100 });
    box.grow(50);
    box.moved();
    expect(box.top).toBe(box.bottom());
    expect(wayDown()).toBeNull();
  });

  it("leaves the end for a key that scrolls, but not for one typed in a field", () => {
    draw(transcriptOf(first));
    const box = geometry(scroller());
    const field = screen.getByRole("textbox", { name: "Message to the Agent" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    box.moved(box.top - 100);
    expect(wayDown()).toBeNull();
    later();
    fireEvent.keyDown(document.body, { key: "PageUp" });
    box.moved(box.top - 100);
    expect(wayDown()).toHaveAccessibleName("Latest");
  });

  it("leaves the end for a drag of the scrollbar, not for a press on the words", () => {
    draw(transcriptOf(first));
    const box = geometry(scroller());
    // A press on the words, and content clamps the view meanwhile.
    fireEvent.pointerDown(transcriptBox());
    box.shrink(20);
    box.grow(60);
    box.moved();
    expect(wayDown()).toBeNull();
    fireEvent.pointerUp(window);
    later();
    // The scrollbar is the scroller's own box.
    fireEvent.pointerDown(scroller());
    box.moved(box.top - 200);
    expect(wayDown()).toHaveAccessibleName("Latest");
    fireEvent.pointerUp(window);
  });

  it("leaves the end when code moves the view for the person (find, a reveal)", () => {
    draw(transcriptOf(first));
    const box = geometry(scroller());
    markScrollIntent(scroller());
    box.moved(300);
    expect(wayDown()).toHaveAccessibleName("Latest");
  });

  it("goes back to the end and follows when the person sends a message", () => {
    const { redraw, actions } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.wheelTo(120);
    expect(wayDown()).toHaveAccessibleName("Latest");
    later();
    const field = screen.getByRole("textbox", { name: "Message to the Agent" });
    fireEvent.change(field, { target: { value: "and now?" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(actions.send).toHaveBeenCalled();
    expect(box.top).toBe(box.bottom());
    expect(wayDown()).toBeNull();
    box.grow(300);
    redraw(transcriptOf(second));
    expect(box.top).toBe(box.bottom());
  });

  it("pins the transcript to the end when the way down is pressed", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.wheelTo(120);
    later();
    box.grow(300);
    redraw(transcriptOf(second));
    expect(wayDown()).toHaveAccessibleName("New output");
    fireEvent.click(wayDown()!);
    expect(box.top).toBe(box.bottom());
    expect(wayDown()).toBeNull();
    box.grow(300);
    redraw(transcriptOf(third));
    expect(box.top).toBe(box.bottom());
  });

  it("resumes following when the person scrolls back to the end themselves", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.wheelTo(0);
    later();
    box.grow(300);
    redraw(transcriptOf(second));
    expect(wayDown()).toHaveAccessibleName("New output");
    box.wheelTo(box.bottom());
    expect(wayDown()).toBeNull();
    later();
    box.grow(300);
    redraw(transcriptOf(third));
    expect(box.top).toBe(box.bottom());
    // Scrolled away again with nothing new since: the plain label.
    box.wheelTo(0);
    expect(wayDown()).toHaveAccessibleName("Latest");
  });

  it("ignores a parked surface's scrolls, and does not follow while parked", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.wheelTo(120);
    later();
    redraw(transcriptOf(first), true);
    box.grow(300);
    redraw(transcriptOf(second), true);
    expect(box.top).toBe(120);
    redraw(transcriptOf(second), false);
    expect(box.top).toBe(120);
    expect(wayDown()).toHaveAccessibleName("New output");
  });
});
