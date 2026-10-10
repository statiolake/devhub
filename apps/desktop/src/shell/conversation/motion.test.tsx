// @vitest-environment jsdom

/**
 * How the conversation shows what changes: the activity line at the end of
 * the transcript, entries that rise in only when they are new output, and
 * none of it under Reduce Motion.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

describe("under Reduce Motion", () => {
  it("turns off every entry and disclosure animation", () => {
    const css = readFileSync("src/shell/conversation/conversation.css", "utf8");
    const reduced = [
      ...css.matchAll(
        /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g,
      ),
    ]
      .map(([, body]) => body)
      .join("\n");
    for (const selector of [
      ".conversation-entry[data-fresh]",
      ".conversation-activity-label",
      "details::details-content",
      ".conversation-completions",
      ".conversation-pending-item",
      ".conversation-dictation-tentative",
    ]) {
      expect(reduced, selector).toContain(selector);
    }
  });
});
