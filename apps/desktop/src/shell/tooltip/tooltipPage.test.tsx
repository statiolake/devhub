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
import { readFileSync } from "node:fs";
import { COPIED_MS, TooltipApp } from "./TooltipApp";
import { upToDevicePixel } from "./tooltipSize";
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
/** Every text this page put on the clipboard, in order. */
let copied: string[] = [];
/** What the next `writeClipboard` answers with. */
let copying: Promise<void> = Promise.resolve();
/** What the next `openExternalUrl` answers with. */
let opening: Promise<void> = Promise.resolve();
/** Every failure this page raised, in order. */
let raised: unknown[] = [];

/** Every `ResizeObserver` callback the page made, in order. */
let resized: (() => void)[] = [];
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
  copied = [];
  copying = Promise.resolve();
  push = undefined;
  sizeBoxes(220, 34);
  // No `ResizeObserver` in jsdom. The page's first measurement is taken
  // directly rather than through the observer; the stub keeps the callbacks
  // so a test can say "the box resized" the way the browser would.
  resized = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
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
    writeClipboard: (text: string) => {
      copied.push(text);
      return copying;
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

  /**
   * A measure drawn as a bar, with the words about time worked out here from
   * this page's clock: a reset ahead is "in …", one already past makes the
   * reading history, faded and said to be.
   */
  it("draws a meter line as a labelled bar with its reset, and a reading past its reset faded", () => {
    const now = Date.now();
    const minute = 60_000;
    render(<TooltipApp />);
    send({
      lines: [
        { text: "Claude", style: "name" },
        {
          kind: "meter",
          label: "5-hour",
          usedPercent: 86.4,
          resetsAt: now + 130 * minute + 30_000,
        },
        {
          kind: "meter",
          label: "7-day",
          usedPercent: 99,
          resetsAt: now - minute,
        },
        { kind: "meter", label: "weekly" },
      ],
    });
    const [ahead, past, unknown] = [
      ...document.querySelectorAll<HTMLElement>(".tooltip-meter"),
    ];
    expect(ahead!.querySelector(".tooltip-meter-head")).toHaveTextContent(
      "5-hour86%",
    );
    expect(ahead).toHaveAttribute("data-level", "near");
    expect(ahead).not.toHaveAttribute("data-stale");
    expect(
      (ahead!.querySelector(".tooltip-meter-fill") as HTMLElement).style.width,
    ).toBe("86.4%");
    expect(ahead!.querySelector(".tooltip-meter-reset")).toHaveTextContent(
      /^Resets in 2h 10m · /u,
    );
    expect(past).toHaveAttribute("data-stale", "true");
    expect(past).toHaveAttribute("data-level", "calm");
    expect(past!.querySelector(".tooltip-meter-reset")).toHaveTextContent(
      /nothing reported since$/u,
    );
    expect(unknown).toHaveTextContent("weeklynot reported");
    expect(unknown).toHaveTextContent("Reset time not reported");
    expect(unknown).toHaveAttribute("data-level", "calm");
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

  /**
   * A mark names itself on the element that draws it, which is what lets the
   * stylesheet say what colour an open Issue is. The alternative was a colour
   * composed with the fact and sent over the wire, which would have put the
   * palette in two places and let the row and the box disagree about green.
   */
  it("names each mark on the element that draws it", () => {
    render(<TooltipApp />);
    send({
      lines: [
        { icon: "repository", text: "github.com/example/widget" },
        { icon: "issueOpen", text: "#128 Tidy the rail" },
      ],
    });
    expect(
      [...document.querySelectorAll(".tooltip-line-mark")].map((mark) =>
        mark.getAttribute("data-mark"),
      ),
    ).toEqual(["repository", "issueOpen"]);
  });

  /**
   * And the stylesheet colours them, out of tokens that already exist.
   *
   * The assertion is against the file rather than a computed style because
   * jsdom applies no stylesheet of ours; what is worth pinning is the thing a
   * later edit could quietly lose — that every mark a Workspace's tooltip
   * draws names an ink, and that the ink is one `tokens.css` declares.
   */
  it("gives every workspace mark a colour, from a token that exists", () => {
    const css = readFileSync("src/shell/tooltip/tooltipPage.css", "utf8");
    const tokens = readFileSync("src/shell/styles/tokens.css", "utf8");
    for (const mark of [
      "repository",
      "branch",
      "worktree",
      "folder",
      "remote",
      "issueOpen",
      "issueClosed",
      "pullRequest",
      "pullRequestMerged",
      "pullRequestClosed",
      "conversation",
      "checksFailing",
      "checksPending",
      "checksPassing",
    ]) {
      const rule = new RegExp(
        `\\[data-mark="${mark}"\\][^{}]*\\{[^}]*\\}|\\[data-mark="${mark}"\\],`,
        "u",
      );
      expect(css, `${mark} has no colour rule`).toMatch(rule);
    }
    for (const token of [...css.matchAll(/color: var\((--[a-z-]+)\)/gu)].map(
      (match) => match[1],
    )) {
      expect(tokens, `${token ?? ""} is not a token`).toContain(
        `${token ?? ""}:`,
      );
    }
  });

  /**
   * No shadow, and it is a fact about the *view* rather than about taste.
   *
   * This view is exactly the box's rectangle, and a shadow paints outside the
   * box: it filled the four triangles the corner radius cuts away, so every
   * tooltip wore a translucent square at each corner. Giving the view room for
   * it would have meant a halo of dead pointer around every tooltip, because a
   * native view takes every click inside its bounds. See `tooltipPage.css`.
   */
  it("casts no shadow, so the view's corners are empty", () => {
    const css = readFileSync("src/shell/tooltip/tooltipPage.css", "utf8");
    expect(css).not.toMatch(/^\s*box-shadow:/mu);
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
   * Three of a row's facts name a page on GitHub — the repository, the Issue,
   * the pull request — and the box is where they are followed: the row's
   * marks have no hover of their own and the folder glyph is inert.
   */
  it("draws a fact that names a GitHub page as the link to it", () => {
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
    expect(document.querySelectorAll("a")).toHaveLength(1);
  });

  /**
   * The row's one path line: the folder written with `~`, a copy button that
   * copies its absolute path, and — for a worktree — what it was cut from on
   * the same line, subdued, with a copy button of its own.
   */
  it("draws a worktree's path as one line with a copy button for each path", () => {
    render(<TooltipApp />);
    send({
      lines: [
        { text: "api", style: "name", qualifier: "· SSH: build.example.com" },
        {
          text: "~/src/widget-tooltips",
          style: "muted",
          copy: "/Users/me/src/widget-tooltips",
          qualifier: "(worktree of ~/src/widget)",
          qualifierCopy: "/Users/me/src/widget",
        },
      ],
    });
    const [heading, path] = [...document.querySelectorAll(".tooltip-line")];
    expect(heading?.textContent).toBe("api · SSH: build.example.com");
    expect(heading?.querySelector(".tooltip-line-qualifier")).toHaveTextContent(
      "· SSH: build.example.com",
    );
    expect(path?.textContent).toBe(
      "~/src/widget-tooltips (worktree of ~/src/widget)",
    );
    const buttons = path?.querySelectorAll("button.tooltip-copy") ?? [];
    expect(buttons).toHaveLength(2);
    // Quiet: no hover of its own.
    for (const button of buttons) {
      expect(button).not.toHaveAttribute("title");
      expect(button).not.toHaveAttribute("data-tooltip");
    }
  });

  /**
   * The copy button is a character of the text, not a column beside it: it
   * follows the path's last character in the same run of words, held to it so
   * a wrap can never leave it alone at the start of a line, and a worktree's
   * second path has its own right after it — inside the bracket.
   */
  it("puts each path's copy button inline, right after the path's last character", () => {
    render(<TooltipApp />);
    send({
      lines: [
        {
          text: "~/src/widget-tooltips",
          style: "muted",
          copy: "/Users/me/src/widget-tooltips",
          qualifier: "(worktree of ~/src/widget)",
          qualifierCopy: "/Users/me/src/widget",
          qualifierCopyAfter: "~/src/widget",
        },
      ],
    });
    const line = document.querySelector(".tooltip-line")!;
    const [own, main] = [...line.querySelectorAll("button.tooltip-copy")];
    // Inside the path's own text, after a text node that ends the path.
    const text = line.querySelector(".tooltip-line-text")!;
    expect(text.textContent).toBe("~/src/widget-tooltips");
    expect(text.contains(own!)).toBe(true);
    expect(own!.previousSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(own!.previousSibling?.textContent).toBe("s");
    expect(own!.nextSibling).toBeNull();
    expect(own!.parentElement).toHaveClass("tooltip-copy-join");
    expect(own!.parentElement!.previousSibling?.textContent).toBe(
      "~/src/widget-tooltip",
    );
    // The second path's button is in the qualifier, after "~/src/widget" and
    // before the bracket that closes it, which is held with it.
    const qualifier = line.querySelector(".tooltip-line-qualifier")!;
    expect(qualifier.contains(main!)).toBe(true);
    expect(main!.previousSibling?.textContent).toBe("t");
    expect(main!.nextSibling?.textContent).toBe(")");
    expect(main!.parentElement).toHaveClass("tooltip-copy-join");
    expect(main!.parentElement!.previousSibling?.textContent).toBe(
      "(worktree of ~/src/widge",
    );
    // One run of words after the mark: no flex column of its own.
    expect(own!.closest(".tooltip-line-body")).toBe(
      main!.closest(".tooltip-line-body"),
    );
  });

  it("puts the button after the whole qualifier when it does not say where the path is", () => {
    render(<TooltipApp />);
    send({
      lines: [
        {
          text: "~/a",
          copy: "/Users/me/a",
          qualifier: "(worktree of ~/b)",
          qualifierCopy: "/Users/me/b",
        },
      ],
    });
    const main = document.querySelectorAll("button.tooltip-copy")[1]!;
    expect(main.previousSibling?.textContent).toBe(")");
    expect(main.nextSibling).toBeNull();
  });

  /**
   * What makes it inline is the stylesheet: an inline box sized in `em`,
   * aligned on the text, held to the last character by `nowrap`, and nothing
   * that would make it a flex column. And the qualifier wraps — held on one
   * line, a long path in it ran out of the box, which was a scrollbar.
   */
  it("styles the copy button as an inline character of the text", () => {
    const css = readFileSync("src/shell/tooltip/tooltipPage.css", "utf8");
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf("}", at));
    };
    const copy = rule(".tooltip-copy");
    expect(copy).toMatch(/display: inline(-flex)?;/u);
    expect(copy).toMatch(/width: [\d.]+em;/u);
    expect(copy).toMatch(/height: [\d.]+em;/u);
    expect(copy).toMatch(/vertical-align: /u);
    expect(copy).not.toMatch(/align-self|flex:/u);
    expect(rule(".tooltip-copy-join")).toMatch(/white-space: nowrap;/u);
    expect(rule(".tooltip-line-qualifier")).not.toMatch(/nowrap/u);
    expect(rule(".tooltip-copy .sidebar-glyph")).toMatch(/width: 1em;/u);
  });

  /**
   * The document never scrolls: the view is the box's size, rounded up, so a
   * scrollbar could only ever be for the fraction rounding absorbs. And a box
   * too tall for the window is capped and cut at its edge under a fade,
   * rather than overflowing its view.
   */
  it("never gives the document a scrollbar", () => {
    const css = readFileSync("src/shell/tooltip/tooltipPage.css", "utf8");
    expect(css).toMatch(/:root,\nbody \{[^}]*overflow: hidden;/u);
    const box = css.slice(css.indexOf("\n.tooltip-box {"));
    const rule = box.slice(0, box.indexOf("}"));
    expect(rule).toMatch(/display: block;/u);
    expect(rule).toMatch(/overflow: hidden;/u);
    expect(css).toMatch(/\.tooltip-box\[data-capped\] \{\n\s*mask-image:/u);
  });

  it("marks a box whose content is taller than its room as cut short", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 900,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 200,
    });
    try {
      render(<TooltipApp />);
      send({ ...FACTS, room: { width: 300, height: 200 } });
      expect(document.querySelector(".tooltip-box")).toHaveAttribute(
        "data-capped",
      );
    } finally {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  it("does not mark a box that fits", () => {
    render(<TooltipApp />);
    send(FACTS);
    expect(document.querySelector(".tooltip-box")).not.toHaveAttribute(
      "data-capped",
    );
  });

  it("wraps and caps the box to the room main gives it", () => {
    render(<TooltipApp />);
    send({ ...FACTS, room: { width: 300, height: 200 } });
    const box = document.querySelector<HTMLElement>(".tooltip-box")!;
    expect(box.style.maxHeight).toBe("200px");
    expect(box.style.maxWidth).toBe("min(var(--tooltip-max-width), 300px)");
  });

  /** Rounded up to a whole device pixel, never to the nearest. */
  it("rounds the size up in device pixels", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    sizeBoxes(100.42, 57.1);
    render(<TooltipApp />);
    send(FACTS);
    expect(reported.at(-1)).toEqual({ width: 100.5, height: 57.5 });
  });

  it("rounds the size up to whole pixels at a ratio of one", () => {
    vi.stubGlobal("devicePixelRatio", 1);
    sizeBoxes(100.42, 57.1);
    render(<TooltipApp />);
    send(FACTS);
    expect(reported.at(-1)).toEqual({ width: 101, height: 58 });
    expect(upToDevicePixel(220.0000001, 1)).toBe(220);
    expect(upToDevicePixel(96.6041, 1.5)).toBeCloseTo(96 + 2 / 3);
  });

  /**
   * The size follows the box, whatever changed it: the copy button turning
   * into its check, and the box resizing under the page (fonts landing, a
   * wrap moving). The last report is always the box as it is now.
   */
  it("re-measures after a state change in the box and after it resizes", async () => {
    render(<TooltipApp />);
    send({ lines: [{ text: "~/src/widget", copy: "/Users/me/src/widget" }] });
    expect(reported.at(-1)).toEqual({ width: 220, height: 34 });
    sizeBoxes(232, 34);
    await act(async () => {
      document
        .querySelector("button.tooltip-copy")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    // The check is drawn, and the mutation it is re-measured on lands.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector("button.tooltip-copy")).toHaveAttribute(
      "data-copied",
      "true",
    );
    expect(reported.at(-1)).toEqual({ width: 232, height: 34 });
    sizeBoxes(232, 51);
    act(() => {
      for (const callback of resized) callback();
    });
    expect(reported.at(-1)).toEqual({ width: 232, height: 51 });
  });

  /** A click copies the absolute path, and the mark is a check for a second. */
  it("copies the absolute path and shows a check for a moment", async () => {
    vi.useFakeTimers();
    try {
      render(<TooltipApp />);
      send({
        lines: [
          {
            text: "~/src/widget-tooltips",
            copy: "/Users/me/src/widget-tooltips",
            qualifier: "(worktree of ~/src/widget)",
            qualifierCopy: "/Users/me/src/widget",
          },
        ],
      });
      const [own, main] = [...document.querySelectorAll("button.tooltip-copy")];
      const glyph = (button: Element | undefined) =>
        button?.querySelector("svg")?.getAttribute("data-glyph");
      expect(glyph(own)).toBe("copy");
      await act(async () => {
        own!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(copied).toEqual(["/Users/me/src/widget-tooltips"]);
      expect(own).toHaveAttribute("data-copied", "true");
      expect(glyph(own)).toBe("statusIdle");
      expect(glyph(main)).toBe("copy");
      act(() => {
        vi.advanceTimersByTime(COPIED_MS);
      });
      expect(own).not.toHaveAttribute("data-copied");
      expect(glyph(own)).toBe("copy");
      await act(async () => {
        main!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(copied).toEqual([
        "/Users/me/src/widget-tooltips",
        "/Users/me/src/widget",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A copy that failed is raised, and never confirmed. */
  it("raises a copy that failed and shows no check", async () => {
    copying = Promise.reject(new Error("no clipboard"));
    render(<TooltipApp />);
    send({ lines: [{ text: "~/src/widget", copy: "/Users/me/src/widget" }] });
    const button = document.querySelector("button.tooltip-copy")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(raised).toHaveLength(1);
    expect(button).not.toHaveAttribute("data-copied");
  });

  /** Everything else is words. A fact that is not a place is not a link. */
  it("draws a fact that names no page as plain words", () => {
    render(<TooltipApp />);
    send(FACTS);
    expect(document.querySelector("a")).toBeNull();
  });

  /**
   * Only a GitHub page over https is a link, whatever a line arrives
   * carrying: the three places a row's facts name are all on github.com.
   */
  it.each([
    "http://github.com/example/widget",
    "https://example.com/i/128",
    "https://github.com.example.com/x",
    "https://user@github.com/x",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "not a url",
  ])("draws %s as words and never opens it", (href) => {
    render(<TooltipApp />);
    send({ lines: [{ text: "#128 Fix it", href }] });
    expect(document.querySelector("a")).toBeNull();
    act(() => {
      document
        .querySelector(".tooltip-line-text")!
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
    });
    expect(opened).toEqual([]);
  });

  /**
   * The click goes out through main — not through the navigation backstop,
   * which catches what a page did not mean to do and would swallow a refusal
   * nobody is awaiting. And this document never navigates: replacing it would
   * put a website in a tooltip.
   */
  it("sends a clicked link to the browser instead of navigating to it", () => {
    render(<TooltipApp />);
    send({
      lines: [
        {
          text: "#128 Fix it",
          href: "https://github.com/example/widget/issues/128",
        },
      ],
    });
    const link = document.querySelector("a.tooltip-line-link");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      link!.dispatchEvent(click);
    });
    expect(opened).toEqual(["https://github.com/example/widget/issues/128"]);
    expect(click.defaultPrevented).toBe(true);
  });

  /** A click that quietly did nothing is the failure the catch prevents. */
  it("raises a link that could not be opened rather than dropping it", async () => {
    opening = Promise.reject(new Error("no browser"));
    render(<TooltipApp />);
    send({
      lines: [
        {
          text: "#7 Rework",
          href: "https://github.com/example/widget/pull/7",
        },
      ],
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
