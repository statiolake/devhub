// @vitest-environment jsdom

/**
 * The page a tooltip is drawn on, and the one number it owes main.
 *
 * This view is exactly as big as the box it draws, because a native view takes
 * every click inside its bounds whether or not anything is painted there. So
 * the two assertions worth having are the two halves of that bargain: a
 * sentence to draw is measured and reported, and nothing to draw is reported
 * as a size of zero — which is what takes the view out of the window. A
 * tooltip that went down and did not say so would be an invisible rectangle
 * over the editor for the rest of the session.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipApp } from "./TooltipApp";
import type { TooltipTextWire } from "../../ipc/contract";

const DESCRIPTION = "widget workspace, path /projects/widget\nbranch main";

/** Every size this page reported, in order. */
let reported: { width: number; height: number }[] = [];
/** The listener main's push would reach. */
let push: ((tooltip: TooltipTextWire | undefined) => void) | undefined;

/**
 * A box of a stated size. jsdom lays nothing out, so the element says how big
 * it came out — which is the one number this page exists to produce.
 */
function sizeBoxes(width: number, height: number) {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
      }) as DOMRect,
  });
}

beforeEach(() => {
  reported = [];
  push = undefined;
  sizeBoxes(220, 34);
  // No `ResizeObserver` in jsdom. The page's first measurement is taken
  // directly rather than through the observer, so a stub that never fires is
  // enough to pin what this test is about.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.devhub = {
    raiseFailure: () => undefined,
    onTheme: () => () => undefined,
    onTooltip: (listener: (tooltip: TooltipTextWire | undefined) => void) => {
      push = listener;
      return () => (push = undefined);
    },
    reportTooltipSize: (size: { width: number; height: number }) => {
      reported.push(size);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.devhub;
});

/** Main says a tooltip is up, or says it is not. */
function send(tooltip: TooltipTextWire | undefined) {
  act(() => {
    if (!push) throw new Error("the page never subscribed to the tooltip");
    push(tooltip);
  });
}

describe("the tooltip page", () => {
  it("draws nothing at all until main says there is something to say", () => {
    render(<TooltipApp />);
    expect(document.querySelector(".tooltip-box")).toBeNull();
  });

  it("draws the sentence it was given, with the row's own lines", () => {
    render(<TooltipApp />);
    send({ text: DESCRIPTION });
    const box = screen.getByText(/widget workspace/);
    // `pre-line` is the formatting rule; the text node keeps the newline so
    // that it has something to honour.
    expect(box.textContent).toBe(DESCRIPTION);
    expect(box).toHaveClass("tooltip-box");
  });

  /** The row's accessible name is already this sentence; see `TooltipApp`. */
  it("is not in the accessibility tree, because the row already says this", () => {
    render(<TooltipApp />);
    send({ text: DESCRIPTION });
    expect(screen.getByText(/widget workspace/)).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("measures the box and tells main how big it came out", () => {
    render(<TooltipApp />);
    send({ text: DESCRIPTION });
    expect(reported).toContainEqual({ width: 220, height: 34 });
  });

  /**
   * The half that must not be forgotten: a view that stayed in the window
   * with nothing in it is a hole in the editor, and zero is how it leaves.
   */
  it("reports a size of zero when the tooltip goes, so the view leaves", () => {
    render(<TooltipApp />);
    send({ text: DESCRIPTION });
    reported = [];
    send(undefined);
    expect(reported).toEqual([{ width: 0, height: 0 }]);
    expect(document.querySelector(".tooltip-box")).toBeNull();
  });

  it("re-measures when the sentence changes, because a row is a new size", () => {
    render(<TooltipApp />);
    send({ text: DESCRIPTION });
    reported = [];
    sizeBoxes(410, 68);
    send({ text: "a much longer description of some other row entirely" });
    expect(reported).toContainEqual({ width: 410, height: 68 });
  });

  it("says a size once, not once per render", () => {
    render(<TooltipApp />);
    send({ text: DESCRIPTION });
    const first = reported.length;
    send({ text: DESCRIPTION });
    expect(reported.length).toBe(first);
  });
});
