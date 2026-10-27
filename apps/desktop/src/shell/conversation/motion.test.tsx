// @vitest-environment jsdom

/**
 * How the conversation shows what changes: the activity line at the end of
 * the transcript, entries that rise in only when they are new output, and
 * none of it under Reduce Motion.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../../model/conversation";
import { FRESH_LIMIT } from "./freshEntries";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";
import { assistant, put, transcriptOf, user } from "./transcriptFixtures";

beforeAll(installResizeObserver);
afterEach(cleanup);

const RUNNING: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "running" },
};

const HISTORY = [put(user("u1", "hi")), put(assistant("a1", "hello"))];

describe("the activity line", () => {
  it("is the transcript's last line while a turn runs, not the composer's", () => {
    draw(transcriptOf([...HISTORY, put(user("u2", "more")), RUNNING]));
    const line = screen.getByRole("status");
    expect(line).toHaveClass("conversation-activity");
    const transcript = document.querySelector(".conversation-transcript")!;
    expect(line.parentElement).toBe(transcript);
    expect(transcript.lastElementChild).toBe(line);
    expect(
      document.querySelector(".conversation-composer .conversation-activity"),
    ).toBeNull();
  });

  it("is not drawn while idle", () => {
    draw(transcriptOf(HISTORY));
    expect(document.querySelector(".conversation-activity")).toBeNull();
  });
});

describe("entries rising in", () => {
  it("does not animate the transcript as it is first drawn", () => {
    draw(transcriptOf(HISTORY));
    expect(entry("u1")).not.toHaveAttribute("data-fresh");
    expect(entry("a1")).not.toHaveAttribute("data-fresh");
  });

  it("animates an entry that arrives, once, and keeps it through re-renders", () => {
    const view = draw(transcriptOf(HISTORY));
    const streaming = (text: string) =>
      transcriptOf([
        ...HISTORY,
        put(assistant("a2", text, { streaming: true })),
      ]);
    view.redraw(streaming("wor"));
    expect(entry("a2")).toHaveAttribute("data-fresh");
    expect(entry("a1")).not.toHaveAttribute("data-fresh");
    const element = entry("a2");
    view.redraw(streaming("world"));
    expect(entry("a2")).toBe(element);
    expect(entry("a2")).toHaveAttribute("data-fresh");
  });

  it("does not animate a history that arrives in one go", () => {
    const view = draw(transcriptOf(HISTORY));
    const many = Array.from({ length: FRESH_LIMIT + 1 }, (_, index) =>
      put(user(`m${index}`, `message ${index}`)),
    );
    view.redraw(transcriptOf([...HISTORY, ...many]));
    expect(entry("m0")).not.toHaveAttribute("data-fresh");
  });
});

describe("coming back to a parked pane", () => {
  // jsdom runs no animations; these stand in for what Chromium starts again
  // on an element that leaves `display: none`.
  function stubAnimations() {
    const rise = { finish: vi.fn(), effect: timing(400) };
    const dots = { finish: vi.fn(), effect: timing(Infinity) };
    const getAnimations = vi.fn(() => [rise, dots]);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: getAnimations,
    });
    return { rise, dots, getAnimations };
  }
  function timing(endTime: number) {
    return { getComputedTiming: () => ({ endTime }) };
  }
  afterEach(() => {
    delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
  });

  it("keeps the same entries, and runs what would rise in again to its end", () => {
    const view = draw(transcriptOf(HISTORY));
    view.redraw(transcriptOf([...HISTORY, put(assistant("a2", "new"))]));
    const fresh = entry("a2");
    expect(fresh).toHaveAttribute("data-fresh");
    const { rise, dots } = stubAnimations();
    view.redraw(transcriptOf([...HISTORY, put(assistant("a2", "new"))]), true);
    expect(rise.finish).not.toHaveBeenCalled();
    view.redraw(transcriptOf([...HISTORY, put(assistant("a2", "new"))]));
    // Not drawn again: the same element, shown.
    expect(entry("a2")).toBe(fresh);
    expect(rise.finish).toHaveBeenCalledTimes(1);
    // What repeats is what the pane is doing now, and keeps going.
    expect(dots.finish).not.toHaveBeenCalled();
  });

  it("leaves what arrives while it is shown alone", () => {
    const view = draw(transcriptOf(HISTORY));
    const { getAnimations } = stubAnimations();
    view.redraw(transcriptOf([...HISTORY, put(assistant("a2", "new"))]));
    expect(getAnimations).not.toHaveBeenCalled();
  });
});

describe("under Reduce Motion", () => {
  const reducedIn = (css: string) =>
    [
      ...css.matchAll(
        /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g,
      ),
    ]
      .map(([, body]) => body)
      .join("\n");
  const tokens = readFileSync("src/shell/styles/tokens.css", "utf8");
  const css = readFileSync("src/shell/conversation/conversation.css", "utf8");

  it("takes every distance and scale the arrivals are drawn with to nothing, so they only fade", () => {
    const reduced = reducedIn(tokens);
    for (const token of [
      "--motion-rise: 0px",
      "--motion-scale-in: 1",
      "--motion-scale-popover: 1",
      "--motion-scale-pop: 1",
    ]) {
      expect(reduced, token).toContain(token);
    }
    // Every arrival moves by those tokens and nothing else.
    for (const name of [
      "conversation-rise-in",
      "conversation-popover-in",
      "conversation-pop-in",
    ]) {
      const frames = new RegExp(
        `@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`,
      ).exec(css)?.[1];
      expect(frames, name).toBeDefined();
      for (const [, transform] of frames!.matchAll(/transform:([^;]*);/g)) {
        expect(
          transform!.replace(
            /var\(--motion-[a-z-]+\)|[\s\d./*()-]|calc|translateY|scale/g,
            "",
          ),
          name,
        ).toBe("");
        expect(transform, name).toMatch(/var\(--motion-/);
      }
    }
  });

  it("leaves the conversation's fades to it, and turns off what loops and a disclosure's height", () => {
    // The page-wide cut to an instant spares the conversation, whose own
    // arrivals become fades.
    expect(reducedIn(tokens)).toContain(".conversation-surface *");
    const reduced = reducedIn(css);
    for (const selector of [
      ".conversation-activity-dots span",
      ".conversation-request-eyebrow::before",
      ".conversation-waiting-mark",
      '.conversation-tool-mark[data-status="running"]::before',
      "details::details-content",
      ".conversation-dictation",
    ]) {
      expect(reduced, selector).toContain(selector);
    }
  });
});
