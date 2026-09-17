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
import type { TooltipContentWire } from "../../ipc/contract";

/** A row's facts, as `rowDescription.ts` composes them. */
const FACTS: TooltipContentWire = {
  lines: [
    { text: "widget", style: "name" },
    { text: "/projects/widget", style: "muted" },
    { icon: "branch", text: "main", style: "muted" },
  ],
};

/** Every link this page asked main to open, in order. */
let opened: string[] = [];
/** Every report of where the pointer is, in order. */
let pointer: boolean[] = [];
/** What the next `openExternalUrl` answers with. */
let opening: Promise<void> = Promise.resolve();
/** Every failure this page raised, in order. */
let raised: unknown[] = [];

/** Every size this page reported, in order. */
let reported: { width: number; height: number }[] = [];
/** The listener main's push would reach. */
let push: ((tooltip: TooltipContentWire | undefined) => void) | undefined;

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
  opened = [];
  pointer = [];
  raised = [];
  opening = Promise.resolve();
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
    raiseFailure: (error: unknown) => {
      raised.push(error);
    },
    onTheme: () => () => undefined,
    onTooltip: (
      listener: (tooltip: TooltipContentWire | undefined) => void,
    ) => {
      push = listener;
      return () => (push = undefined);
    },
    reportTooltipSize: (size: { width: number; height: number }) => {
      reported.push(size);
    },
    reportTooltipPointer: (inside: boolean) => {
      pointer.push(inside);
    },
    openExternalUrl: (url: string) => {
      opened.push(url);
      return opening;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.devhub;
});

/** Main says a tooltip is up, or says it is not. */
function send(tooltip: TooltipContentWire | undefined) {
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

  it("draws one line per fact, in the order it was given them", () => {
    render(<TooltipApp />);
    send(FACTS);
    const box = document.querySelector(".tooltip-box");
    expect(box).not.toBeNull();
    expect(
      [...box!.querySelectorAll(".tooltip-line-text")].map(
        (line) => line.textContent,
      ),
    ).toEqual(["widget", "/projects/widget", "main"]);
  });

  /**
   * The whole point of the shape: a fact is recognised by the mark in front of
   * it rather than by a label word before it. The mark is a *name* on the
   * wire, resolved here through the Sidebar's own `icons.tsx`, so both pages
   * draw one set of drawings.
   */
  it("draws each fact behind the mark the row would have drawn", () => {
    render(<TooltipApp />);
    send(FACTS);
    const marks = [...document.querySelectorAll(".tooltip-line")].map(
      (line) => line.querySelector("svg")?.getAttribute("data-glyph") ?? null,
    );
    expect(marks).toEqual([null, null, "branch"]);
  });

  /** A mark this page has no drawing for is no mark, and never a failure. */
  it("draws the fact without a mark when the mark is not one it has", () => {
    render(<TooltipApp />);
    send({ lines: [{ icon: "not-a-glyph", text: "still a fact" }] });
    expect(screen.getByText("still a fact")).toBeInTheDocument();
    expect(document.querySelector(".tooltip-line svg")).toBeNull();
  });

  /** The status colour rides on the line, because the row's mark is coloured. */
  it("carries an Agent's status colour onto the line that says it", () => {
    render(<TooltipApp />);
    send({
      lines: [
        { text: "Codex 1", style: "name" },
        { icon: "statusWaiting", text: "Waiting", tone: "waiting" },
      ],
    });
    expect(
      document.querySelectorAll(".tooltip-line")[1]?.getAttribute("data-tone"),
    ).toBe("waiting");
  });

  /** The row's accessible name is already this sentence; see `TooltipApp`. */
  it("is not in the accessibility tree, because the row already says this", () => {
    render(<TooltipApp />);
    send(FACTS);
    expect(document.querySelector(".tooltip-box")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("measures the box and tells main how big it came out", () => {
    render(<TooltipApp />);
    send(FACTS);
    expect(reported).toContainEqual({ width: 220, height: 34 });
  });

  /**
   * The half that must not be forgotten: a view that stayed in the window
   * with nothing in it is a hole in the editor, and zero is how it leaves.
   */
  it("reports a size of zero when the tooltip goes, so the view leaves", () => {
    render(<TooltipApp />);
    send(FACTS);
    reported = [];
    send(undefined);
    expect(reported).toEqual([{ width: 0, height: 0 }]);
    expect(document.querySelector(".tooltip-box")).toBeNull();
  });

  it("re-measures when the sentence changes, because a row is a new size", () => {
    render(<TooltipApp />);
    send(FACTS);
    reported = [];
    sizeBoxes(410, 68);
    send({ lines: [{ text: "a much longer row entirely", style: "name" }] });
    expect(reported).toContainEqual({ width: 410, height: 68 });
  });

  /**
   * Three of a row's facts name a page on GitHub, and the row itself links all
   * three. The box draws the same facts, so it draws the same links: a person
   * reading *#128* in the tooltip is looking at the thing they would have
   * clicked on the row.
   */
  it("draws a fact that names a page as the link to it", () => {
    render(<TooltipApp />);
    send({
      lines: [
        { text: "widget", style: "name" },
        {
          icon: "repository",
          text: "github.com/example/widget",
          style: "muted",
          href: "https://github.com/example/widget",
        },
      ],
    });
    const link = document.querySelector("a.tooltip-line-link");
    expect(link).toHaveAttribute("href", "https://github.com/example/widget");
    expect(link).toHaveTextContent("github.com/example/widget");
  });

  /** Everything else is words. A fact that is not a place is not a link. */
  it("draws a fact that names no page as plain words", () => {
    render(<TooltipApp />);
    send(FACTS);
    expect(document.querySelector("a")).toBeNull();
  });

  /**
   * The click goes out through main, the way every link DevHub draws does —
   * not through the navigation backstop, which catches what a page did not
   * mean to do and would swallow a refusal nobody is awaiting. And this
   * document never navigates: replacing it would put a website in a tooltip.
   */
  it("sends a clicked link to the browser instead of navigating to it", () => {
    render(<TooltipApp />);
    send({
      lines: [{ text: "#128 Fix it", href: "https://example.com/i/128" }],
    });
    const link = document.querySelector("a.tooltip-line-link");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      link!.dispatchEvent(click);
    });
    expect(opened).toEqual(["https://example.com/i/128"]);
    expect(click.defaultPrevented).toBe(true);
  });

  /**
   * A click that quietly did nothing is the failure the catch exists to
   * prevent. What began here is raised and never drawn here — this page has
   * one box in it and no room for a failure.
   */
  it("raises a link that could not be opened rather than dropping it", async () => {
    opening = Promise.reject(new Error("no browser"));
    render(<TooltipApp />);
    send({
      lines: [{ text: "#128 Fix it", href: "https://example.com/i/128" }],
    });
    await act(async () => {
      document
        .querySelector("a.tooltip-line-link")!
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    expect(raised).toHaveLength(1);
  });

  /**
   * Half of an answer main assembles. The row is another view, so the pointer
   * crossing into the box is a leave there and an enter here, and neither page
   * can see the other's pointer. This page says only what it knows.
   */
  it("says when the pointer is in the box, and when it has left", () => {
    render(<TooltipApp />);
    send(FACTS);
    const box = document.querySelector(".tooltip-box")!;
    act(() => {
      box.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(pointer).toEqual([true]);
    act(() => {
      box.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    });
    expect(pointer).toEqual([true, false]);
  });

  it("says a size once, not once per render", () => {
    render(<TooltipApp />);
    send(FACTS);
    const first = reported.length;
    send(FACTS);
    expect(reported.length).toBe(first);
  });
});
